import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchMarketBatch, type MarketResult } from "../beta-calc";
import { resolveCorpCode, getCompanyInfo } from "../common/stock-code-resolver";
import { datagokrKey, FSC_SOURCE, MARKET_KEY_MISSING } from "../market/fsc";
import { handleApiError } from "../utils/error-handler";
import { getCachedValuation } from "../cache/valuation-cache";
import { getIndustryName } from "../opendart/ksic-codes";
import { sanitizeShares, type CompactIbd } from "../opendart/ibd-engine";
import { formatIbd, type IbdOutput } from "../valuation/ibd-output";
import { resolveAsOfFinancials, type FinResult } from "../valuation/asof-financials";

// ─── 스키마 ───

const ValuationDataInputSchema = z.object({
  stock_codes: z.union([
    z.string().min(1).max(10),
    z.array(z.string().min(1).max(10)).min(1).max(10),
  ]).optional().describe("종목코드 6자리. 단일 문자열 또는 최대 10개 배열 (예: '005930' 또는 ['005930','005380'])"),
  stock_code: z.string().min(1).max(10).optional()
    .describe("단일 종목코드 6자리 (stock_codes 대신 사용 가능)"),
  valuation_date: z.string().regex(/^\d{8}$/, "평가기준일은 YYYYMMDD 형식이어야 합니다")
    .describe("⚠️[필수] 평가기준일 YYYYMMDD. 모를 경우 임의의 오늘 날짜를 넣지 말고 반드시 사용자에게 확인하세요. 베타 조회일 및 사업연도 결정에 사용"),
  year: z.string().regex(/^\d{4}$/).optional()
    .describe("(사용하지 않음 — 하위호환용) 재무 보고서는 평가기준일 당시 공시된 최신 정기보고서로 자동 선택됩니다."),
  ibd_detail: z.boolean().optional()
    .describe("true 면 이자부부채를 계정 행 단위(ibd.lines: [계정명, 금액, 범주])까지 반환. 기본 false — 총액·구역별/범주별 소계만"),
  api_key: z.string().optional()
    .describe("OpenDART API 키 (미입력 시 서버 환경변수 사용)"),
});

type ValuationDataInput = z.infer<typeof ValuationDataInputSchema>;

// ─── Compact JSON 출력 타입 ───

interface CompactBeta {
  weekly: Record<string, [number | null, number | null, number | null]> | null;
  monthly: Record<string, [number | null, number | null, number | null]> | null;
}

export interface CompactResult {
  code: string;
  name: string | null;
  industry: { code: string; name: string | null } | null;
  /** 재무에 쓴 보고서의 사업연도 */
  year: string | null;
  valuationDate: string;
  beta: CompactBeta;
  ibd: IbdOutput | null;
  /** 금융업 등 이자부부채를 산정하지 않은 사유 */
  ibdExcluded?: string;
  nci: number | null;
  pretaxIncome: number | null;
  marketCap: { price: number | null; shares: number | null; total: number | null; sharesNote?: string };
  /** 종가·베타 출처와 종가 거래일. 이용자 키가 없거나 조회가 실패하면 error */
  market?: { source: string; priceDate: string | null; note?: string; error?: string };
  /** 사용 보고서와 현금·자본·실적(손익은 incomeMonths 개월 누적) */
  financials?: ({ report: { rceptNo: string; name: string; filedDate: string; period: string; fs: string | null } } & Record<string, unknown>) | null;
  derived?: { netDebt: number; enterpriseValue: number | null; note: string };
}

/** 캐시·라이브 계산 결과(출력 전) — 이자부부채는 행 단위 전체(CompactIbd, 옛 캐시는 2-튜플) */
export type StoredResult = Omit<CompactResult, "ibd" | "derived"> & { ibd: CompactIbd | null };

// ─── 도구 등록 ───

export function registerValuationDataTool(server: McpServer): void {
  server.registerTool(
    "valuation_get_data",
    {
      title: "DCF 밸류에이션 데이터 조회",
      description: `DCF 밸류에이션에 필요한 핵심 데이터를 조회합니다. 최대 10개 종목을 한 번에 배치 조회합니다.

[시점 규칙]
- 재무(이자부부채·비지배지분·현금·자본·실적·주식수): 평가기준일 당시 이미 공시된 최신 정기보고서
  (예: 2025-03-31 → 2024 사업보고서, 2025-06-30 → 2025 1분기보고서). 사용 보고서는 financials.report 에 표시.
- 주가: 평가기준일(이전 최근 거래일) 종가. 베타: 기준일까지의 수정주가 + KOSPI 지수 회귀.
- 주가·베타는 금융위원회 주식시세·지수시세(공공데이터포털)를 이용자 본인 키로 요청 때 조회한다(2020-01-02 이후, T+1).
  키가 없으면 재무만 돌려주고 market.error 에 키 설정 방법을 싣는다 — 그 문장을 사용자에게 그대로 전달하세요.
- 재무는 분기말이면 사전 수집 캐시로 즉시 응답, 그 외 날짜는 같은 규칙으로 실시간 계산.

[⚠️ 필수 입력 — 둘 다 없으면 호출이 거부됩니다]
1. 종목코드 (stock_codes 또는 stock_code). 회사명만 있으면 먼저 search_stock 으로 종목코드를 조회하세요.
2. 평가기준일 (valuation_date, YYYYMMDD). 모르면 추측하지 말고 사용자에게 확인하세요.

[반환 데이터 — compact JSON]
- beta: Weekly-2Y, Monthly-5Y — [실질베타, 조정베타, 포인트수]
- ibd: 이자부부채 — 기본은 요약: total(총액), current/nonCurrent([범주명, 금액]),
  byCategory(범주별 합계: borrowings 차입금, bonds 사채, convertible 전환사채 등 CB·BW·EB, borrowingsAndBonds 차입금·사채 구분 불가,
  lease 리스부채, otherDebt 유동화채무·판매후리스 등 — 예: 리스 제외 = total − byCategory.lease). ibd_detail=true 면 lines 에 계정 행 [계정명, 금액, 범주].
  재무상태표 본문 기준, 차입금이 '금융부채'로 묶인 회사는 주석 금액으로 보충. 차감계정(사채할인발행차금 등)은 본계정 범주에 음수로 합산.
  completeness='partial'(사유 completenessReason)이면 차입 일부가 빠졌을 수 있음 — 원문 확인.
  debtLike [계정명, 금액, 유형(계정명 기준 추정: rcps·cps·convDerivative·hybrid·unknown)]는 합계에서 제외 — 내가격 전환이면 희석, 아니면 부채 가산을 검토.
  checks 는 원문 확인이 필요한 경고, notes 는 참고. 금융업(은행·보험·증권·여신전문·금융지주)은 ibd=null 이고 ibdExcluded 에 사유.
- nci: 비지배지분, pretaxIncome: 세전이익
- marketCap: { price, shares(유통주식수), total, sharesNote(주식수 보정·대체 설명) }, market: { source, priceDate(종가 거래일), note, error }
- financials: 사용 보고서 + cash·shortTermDeposits·equityParent·revenue·operatingIncome·netIncomeParent·incomeTax (손익은 incomeMonths 개월 누적)
- derived: netDebt(이자부부채−현금−단기금융상품), enterpriseValue(시가총액+순차입금+비지배지분)

[Peer 워크플로우 Step 4]
Peer Group이 확정된 후 최대 10개 stock_codes 배열로 "한 번만" 호출하세요. 이 도구 하나가 베타·이자부부채·비지배지분·세전이익·시가총액·현금·실적을 모두 반환하므로 같은 용도로 dart_get_financials / compute_beta 를 따로 호출하지 마세요. 상세는 docs/PEER_GROUP_WORKFLOW.md 참조.`,
      inputSchema: ValuationDataInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ValuationDataInput, extra: { requestInfo?: { headers?: Record<string, string | string[] | undefined> } }) => {
      // [필수 입력 검증] 종목 식별자 + 평가기준일
      const missing: string[] = [];
      const rawCodes = params.stock_codes ?? params.stock_code;
      if (!rawCodes) missing.push("종목코드(stock_codes 또는 stock_code) — 회사명만 있으면 search_stock 으로 종목코드를 먼저 조회하세요");
      if (!params.valuation_date) missing.push("평가기준일(valuation_date, YYYYMMDD) — 사용자에게 확인 후 입력하세요");
      if (!rawCodes || !params.valuation_date) {
        return {
          content: [{ type: "text" as const, text: `Error: DCF 기초자료 조회에 필요한 값이 누락되었습니다.\n- ${missing.join("\n- ")}` }],
          isError: true,
        };
      }
      const valuationDate = params.valuation_date;
      const codes = Array.isArray(rawCodes) ? rawCodes : [rawCodes];
      const apiKey = params.api_key;

      try {
        // 1. 시세(종가·상장주식수·베타): 이용자 키로 요청 때 조회 — 서버는 시세를 저장하지 않는다
        const key = datagokrKey(extra?.requestInfo?.headers);
        const market = key ? await fetchMarketBatch(codes, valuationDate, key) : null;

        // 2. 재무: 분기말 캐시 우선, 미스 종목만 라이브(DART)
        const resultMap = new Map<string, StoredResult>();
        const uncachedCodes: string[] = [];
        for (const code of codes) {
          const hit = await getCachedValuation(code, valuationDate);
          if (hit) resultMap.set(code, hit);
          else uncachedCodes.push(code);
        }
        const liveResults = await Promise.all(
          uncachedCodes.map((code) => processCompany(code, valuationDate, apiKey, market?.get(code)?.listedShares ?? null)),
        );
        for (const r of liveResults) resultMap.set(r.code, r);

        // 3. 재무 + 시세 결합 (요청 순서 유지). 캐시에 옛 시세 필드가 남아 있어도 항상 이번 조회값으로 덮는다
        const results = codes.map((code) =>
          finalize(withMarket(resultMap.get(code)!, market?.get(code) ?? null, !!key), params.ibd_detail ?? false),
        );

        // 4. 응답: 단일이면 객체, 다중이면 배열
        const output = results.length === 1 ? results[0] : results;
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    },
  );
}

// ─── 종목별 처리 (비캐시 기준일) ───

/**
 * 캐시에 없는 기준일 — 수집 스크립트와 같은 규칙으로 계산한다.
 *  재무: 기준일 당시 공시된 최신 정기보고서(asof-financials) — 이자부부채 엔진 v2
 *  주식수: DART 유통주식수를 기준일 상장주식수(이용자 키로 조회한 시세, 없으면 대조 생략)와 대조해 단위 오류 보정
 *  주가·베타는 withMarket 에서 붙인다.
 */
async function processCompany(
  code: string,
  valuationDate: string,
  apiKey: string | undefined,
  listedShares: number | null,
): Promise<StoredResult> {
  const corpCode = await resolveCorpCode(code);
  const info = await getCompanyInfo(code, apiKey).catch(() => null);
  const industryCode = info?.induty_code || null;

  let fin: FinResult | null = null;
  try {
    fin = await resolveAsOfFinancials(
      { corpCode, industryCode, accMonth: info?.acc_mt || "12" },
      valuationDate,
      apiKey,
    );
  } catch {
    fin = null;
  }

  // 상장주식수가 없으면(키 없음) 단위 대조 없이 DART 값을 그대로 쓴다. DART 주식수가 없을 때의 대체는 withMarket 에서
  const sh = fin?.sharesDart ? sanitizeShares(fin.sharesDart, listedShares) : { shares: null, note: "DART 주식수 없음" };
  const sharesNote = [fin?.sharesSource ? `주식수는 ${fin.sharesSource} 기준(해당 보고서 미기재)` : null, sh.note]
    .filter(Boolean)
    .join("; ");

  const fu = fin?.fundamentals ?? null;
  return {
    code,
    name: info?.corp_name ?? null,
    industry: industryCode ? { code: industryCode, name: getIndustryName(industryCode) } : null,
    year: fin?.report.bsnsYear ?? null,
    valuationDate,
    beta: { weekly: null, monthly: null },
    ibd: fin?.ibd ?? null,
    ...(fin?.ibdExcluded ? { ibdExcluded: fin.ibdExcluded } : {}),
    nci: fu?.nci ?? null,
    pretaxIncome: fu?.pretaxIncome ?? null,
    marketCap: { price: null, shares: sh.shares, total: null, ...(sharesNote ? { sharesNote } : {}) },
    financials: fin
      ? {
          report: {
            rceptNo: fin.report.rceptNoReturned ?? fin.report.rceptNo,
            name: fin.report.reportName,
            filedDate: fin.report.rceptDate,
            period: fin.report.period,
            fs: fin.report.fsDiv,
          },
          ...(fu ?? {}),
          ...(fin.error ? { error: fin.error } : {}),
        }
      : null,
  };
}

// ─── 유틸리티 ───

/** 베타 출력을 Weekly-2Y, Monthly-5Y 두 가지로만 축소하고, 이자부부채 요약/상세를 만들고, 순차입금·EV 보조값을 붙인다 */
function finalize(s: StoredResult, ibdDetail: boolean): CompactResult {
  const r: CompactResult = { ...s, ibd: formatIbd(s.ibd, ibdDetail) };
  const w = r.beta.weekly?.["2Y"];
  const m = r.beta.monthly?.["5Y"];
  const cash = (r.financials?.cash ?? null) as number | null;
  const std = (r.financials?.shortTermDeposits ?? 0) as number;
  const netDebt = r.ibd && cash != null ? r.ibd.total - cash - (std || 0) : null;
  return {
    ...r,
    beta: {
      weekly: w ? { "2Y": w } : null,
      monthly: m ? { "5Y": m } : null,
    },
    ...(netDebt != null
      ? {
          derived: {
            netDebt,
            enterpriseValue: r.marketCap.total != null ? r.marketCap.total + netDebt + (r.nci ?? 0) : null,
            note: "순차입금 = 이자부부채 − 현금및현금성자산 − 단기금융상품, EV = 보통주 시가총액 + 순차입금 + 비지배지분",
          },
        }
      : {}),
  };
}

/**
 * 재무 결과에 이번 요청의 시세를 붙인다. 캐시 파일의 beta·price 는 쓰지 않는다
 * (옛 캐시에 네이버 기반 값이 남아 있어도 내보내지 않기 위함).
 */
function withMarket(s: StoredResult, m: MarketResult | null, hasKey: boolean): StoredResult {
  const base: StoredResult = {
    ...s,
    beta: { weekly: null, monthly: null },
    marketCap: { ...s.marketCap, price: null, total: null },
    market: { source: FSC_SOURCE, priceDate: null, error: hasKey ? "시세 조회 결과 없음" : MARKET_KEY_MISSING },
  };
  if (!m) return base;
  let shares = s.marketCap.shares;
  let sharesNote = s.marketCap.sharesNote;
  if (!shares && m.listedShares) {
    shares = m.listedShares;
    sharesNote = [sharesNote, `기준일(${m.priceDate}) 상장주식수로 대체 - 자기주식 미차감`].filter(Boolean).join("; ");
  }
  return {
    ...base,
    beta: m.beta,
    marketCap: {
      price: m.price,
      shares,
      total: m.price && shares ? m.price * shares : null,
      ...(sharesNote ? { sharesNote } : {}),
    },
    market: {
      source: FSC_SOURCE,
      priceDate: m.priceDate,
      ...(m.note ? { note: m.note } : {}),
      ...(m.error ? { error: m.error } : {}),
    },
  };
}
