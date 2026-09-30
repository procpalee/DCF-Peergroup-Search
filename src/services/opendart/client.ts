import axios from "axios";
import {
  DART_API_BASE,
  DART_ENDPOINTS,
  IBD_CURRENT_ACCOUNT_IDS,
  IBD_NON_CURRENT_ACCOUNT_IDS,
  NCI_ACCOUNT_IDS,
  PRETAX_ACCOUNT_IDS,
  IBD_CURRENT_PATTERNS,
  IBD_NON_CURRENT_PATTERNS,
  IBD_COMMON_PATTERNS,
  LEASE_LIABILITY_KEYWORD,
  NON_CONTROLLING_INTEREST_PATTERNS,
  PRETAX_INCOME_PATTERNS,
  VALUATION_ACCOUNT_IDS,
  VALUATION_ACCOUNT_PATTERNS,
  REPORT_CODE_LABEL,
} from "./constants";
import type {
  DartCompanyInfo,
  DartFinancialResponse,
  DartFinancialItem,
  DartStockQuantityResponse,
  SharesInfo,
  DebtSummary,
  DebtCategory,
  ValuationFinancials,
} from "./types";

function resolveApiKey(apiKey?: string): string {
  const key = apiKey || process.env.OPENDART_API_KEY;
  if (!key) {
    throw new Error("OpenDART API 키가 필요합니다. api_key 파라미터를 전달하거나 OPENDART_API_KEY 환경변수를 설정해주세요.");
  }
  return key;
}

// ─── 기업정보 ───

export async function fetchCompanyInfo(corpCode: string, apiKey?: string): Promise<DartCompanyInfo> {
  const response = await axios.get<DartCompanyInfo>(`${DART_API_BASE}${DART_ENDPOINTS.COMPANY}`, {
    params: { crtfc_key: resolveApiKey(apiKey), corp_code: corpCode },
    timeout: 15000,
  });

  if (response.data.status !== "000") {
    throw new Error(`DART_ERROR: ${response.data.message} (status: ${response.data.status})`);
  }

  return response.data;
}

// ─── 재무제표 ───

export async function fetchFinancials(
  corpCode: string,
  year: string,
  reportCode: string = "11011",
  fsDiv: string = "CFS",
  apiKey?: string,
): Promise<DartFinancialItem[]> {
  const fetchDiv = async (div: string) => {
    const response = await axios.get<DartFinancialResponse>(`${DART_API_BASE}${DART_ENDPOINTS.FINANCIAL_FULL}`, {
      params: {
        crtfc_key: resolveApiKey(apiKey),
        corp_code: corpCode,
        bsns_year: year,
        reprt_code: reportCode,
        fs_div: div,
      },
      timeout: 30000,
    });

    if (response.data.status === "013") return [];
    if (response.data.status !== "000") {
      throw new Error(`DART_ERROR: ${response.data.message} (status: ${response.data.status})`);
    }

    // 응답 행에는 연결/별도 구분이 없다 — 실제 조회한 구분을 붙여 호출부가 판별하게 한다
    return (response.data.list ?? []).map((i) => ({ ...i, fs_div: div }));
  };

  const list = await fetchDiv(fsDiv);
  if (list.length === 0 && fsDiv === "CFS") {
    console.log(`[DART] ${corpCode} CFS 데이터 없음. OFS(별도재무제표)로 폴백 시도합니다.`);
    return await fetchDiv("OFS");
  }
  return list;
}

// ─── 주식수 ───

export async function fetchStockQuantity(
  corpCode: string,
  year: string,
  reportCode: string = "11011",
  apiKey?: string,
): Promise<DartStockQuantityResponse> {
  const response = await axios.get<DartStockQuantityResponse>(`${DART_API_BASE}${DART_ENDPOINTS.STOCK_QUANTITY}`, {
    params: {
      crtfc_key: resolveApiKey(apiKey),
      corp_code: corpCode,
      bsns_year: year,
      reprt_code: reportCode,
    },
    timeout: 15000,
  });

  if (response.data.status !== "000" && response.data.status !== "013") {
    throw new Error(`DART_ERROR: ${response.data.message} (status: ${response.data.status})`);
  }

  return response.data;
}

// ─── 데이터 추출 ───

export function extractSharesInfo(response: DartStockQuantityResponse, year: string, reportCode: string): SharesInfo | null {
  if (!response.list || response.list.length === 0) return null;

  const commonStock = response.list.find(
    (item) => item.se === "보통주" || item.se.includes("보통주")
  );

  if (!commonStock) return null;

  const parseNum = (s: string) => {
    const cleaned = s.replace(/[,\s-]/g, "");
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? 0 : num;
  };

  return {
    totalIssued: parseNum(commonStock.istc_totqy),
    treasuryStock: parseNum(commonStock.tesstk_co),
    outstanding: parseNum(commonStock.distb_stock_co),
    stockType: commonStock.se,
    source: `OpenDART stockTotqySttus (${year} ${REPORT_CODE_LABEL[reportCode] ?? reportCode})`,
  };
}

/**
 * 이자부부채를 유동/비유동으로 분류하여 추출
 * 1차: XBRL account_id로 매칭 (정확)
 * 2차: account_id가 "-표준계정코드 미사용-"이면 계정명 폴백
 */
export function extractDebtSummary(items: DartFinancialItem[]): DebtSummary {
  const current: DebtCategory = { total: 0, items: [] };
  const nonCurrent: DebtCategory = { total: 0, items: [] };
  let nonControllingInterest: number | null = null;
  let pretaxIncome: number | null = null;
  let hasBsItems = false;

  for (const item of items) {
    const amount = parseInt((item.thstrm_amount ?? "").replace(/[,\s]/g, ""), 10);
    if (isNaN(amount)) continue;

    const id = item.account_id ?? "";
    const name = item.account_nm;
    const sjDiv = item.sj_div;
    const hasStandardId = id !== "" && id !== "-표준계정코드 미사용-";

    // ── 이자부부채: BS(재무상태표) 항목만 ──
    if (sjDiv === "BS") {
      hasBsItems = true;
      
      let isCurrent = false;
      let isNonCurrent = false;

      // 1차: account_id 매칭 및 부분일치 확장
      if (hasStandardId) {
        if (IBD_CURRENT_ACCOUNT_IDS.has(id)) isCurrent = true;
        else if (IBD_NON_CURRENT_ACCOUNT_IDS.has(id)) isNonCurrent = true;
        else if (
          id.includes("Borrowings") ||
          (id.includes("Bonds") && !id.includes("Retirement")) ||
          id.includes("LeaseLiabilities")
        ) {
          if (id.includes("Current") || id.includes("Shortterm")) isCurrent = true;
          else isNonCurrent = true;
        }
        else if (NCI_ACCOUNT_IDS.has(id) || id.includes("NoncontrollingInterests")) {
          nonControllingInterest = amount;
          continue;
        }
      } else {
        // 2차: 계정명 폴백 (표준코드 미사용 기업)
        if (name.includes(LEASE_LIABILITY_KEYWORD) || IBD_COMMON_PATTERNS.some(p => name.includes(p))) {
          if (name.includes("유동") || name.includes("단기")) isCurrent = true;
          else isNonCurrent = true;
        } else if (IBD_CURRENT_PATTERNS.some((p) => name.includes(p))) {
          isCurrent = true;
        } else if (IBD_NON_CURRENT_PATTERNS.some((p) => name.includes(p))) {
          isNonCurrent = true;
        } else if (NON_CONTROLLING_INTEREST_PATTERNS.some((p) => name.includes(p))) {
          nonControllingInterest = amount;
          continue;
        }
      }

      if (isCurrent) {
        current.total += amount;
        current.items.push({ account: name, amount });
      } else if (isNonCurrent) {
        nonCurrent.total += amount;
        nonCurrent.items.push({ account: name, amount });
      }
    }

    // ── 세전이익: IS/CIS(손익계산서) 항목만 ──
    if (sjDiv === "IS" || sjDiv === "CIS") {
      if (hasStandardId && PRETAX_ACCOUNT_IDS.has(id)) {
        pretaxIncome = amount;
      } else if (!hasStandardId && PRETAX_INCOME_PATTERNS.some((p) => name.includes(p))) {
        pretaxIncome = amount;
      }
    }
  }

  // 무차입 경영 식별 (재무상태표 본문이 하나라도 파싱되었는데 다른 채무가 없으면 합산 0으로 보증)
  const isDebtFree = hasBsItems && current.total === 0 && nonCurrent.total === 0;

  return {
    interestBearingDebt: current.total + nonCurrent.total,
    current,
    nonCurrent,
    nonControllingInterest,
    pretaxIncome,
    _isDebtFree: isDebtFree, // 내부 속성 추가
  } as DebtSummary & { _isDebtFree?: boolean };
}

/**
 * NCI(비지배지분)와 세전이익만 추출 (XBRL IBD 추출과 함께 사용)
 */
export function extractNciAndPretax(items: DartFinancialItem[]): { nonControllingInterest: number | null; pretaxIncome: number | null } {
  let nonControllingInterest: number | null = null;
  let pretaxIncome: number | null = null;

  for (const item of items) {
    const amount = parseInt((item.thstrm_amount ?? "").replace(/[,\s]/g, ""), 10);
    if (isNaN(amount)) continue;

    const id = item.account_id ?? "";
    const name = item.account_nm;
    const sjDiv = item.sj_div;
    const hasStandardId = id !== "" && id !== "-표준계정코드 미사용-";

    // NCI: BS 항목
    if (sjDiv === "BS") {
      if (hasStandardId && NCI_ACCOUNT_IDS.has(id)) {
        nonControllingInterest = amount;
      } else if (!hasStandardId && NON_CONTROLLING_INTEREST_PATTERNS.some((p) => name.includes(p))) {
        nonControllingInterest = amount;
      }
    }

    // 세전이익: IS/CIS 항목
    if (sjDiv === "IS" || sjDiv === "CIS") {
      if (hasStandardId && PRETAX_ACCOUNT_IDS.has(id)) {
        pretaxIncome = amount;
      } else if (!hasStandardId && PRETAX_INCOME_PATTERNS.some((p) => name.includes(p))) {
        pretaxIncome = amount;
      }
    }
  }

  return { nonControllingInterest, pretaxIncome };
}

/**
 * 밸류에이션 모드: 전체 재무제표에서 필요한 계정만 필터링
 * 50-70KB → 2-3KB로 감소
 */
export function filterForValuation(items: DartFinancialItem[]): DartFinancialItem[] {
  const allowedSjDiv = new Set(["BS", "IS", "CIS"]);
  return items.filter((item) => {
    if (!allowedSjDiv.has(item.sj_div)) return false;
    const id = item.account_id ?? "";
    if (id && id !== "-표준계정코드 미사용-" && VALUATION_ACCOUNT_IDS.has(id)) return true;
    return VALUATION_ACCOUNT_PATTERNS.some((pattern) => item.account_nm.includes(pattern));
  });
}

/**
 * 밸류에이션 필수 데이터만 추출 (IBD + 비지배지분 + 세전이익 + 주식수)
 */
export function extractValuationFinancials(items: DartFinancialItem[]): ValuationFinancials {
  const debt = extractDebtSummary(items);

  // 필터된 계정 목록 (참고용)
  const filteredItems = filterForValuation(items).map((f) => ({
    category: f.sj_nm,
    sjDiv: f.sj_div,
    account: f.account_nm,
    currentAmount: f.thstrm_amount,
    previousAmount: f.frmtrm_amount,
  }));

  return { debt, filteredItems };
}
