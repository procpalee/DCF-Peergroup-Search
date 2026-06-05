import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeBetaGridBatch } from "../beta-calc";
import { resolveCorpCode, getCompanyInfo } from "../common/stock-code-resolver";
import { fetchFinancials, fetchStockQuantity, extractSharesInfo, extractNciAndPretax, extractDebtSummary } from "../opendart/client";
import { REPORT_CODE } from "../opendart/constants";
import { extractDebtFromXbrl } from "../opendart/xbrl-parser";
import { fetchMarketData } from "../naver/client";
import { handleApiError } from "../utils/error-handler";
import { getCachedValuation } from "../cache/valuation-cache";
import { getIndustryName } from "../opendart/ksic-codes";
import type { DebtSummary } from "../opendart/types";
import type { StockBetaResult } from "../kicpa/types";

// ─── 스키마 ───

const ValuationDataInputSchema = z.object({
  stock_codes: z.union([
    z.string().min(1).max(10),
    z.array(z.string().min(1).max(10)).min(1).max(10),
  ]).optional().describe("종목코드 6자리. 단일 문자열 또는 최대 10개 배열 (예: '005930' 또는 ['005930','005380'])"),
  stock_code: z.string().min(1).max(10).optional()
    .describe("단일 종목코드 6자리 (stock_codes 대신 사용 가능)"),
  valuation_date: z.string().regex(/^\d{8}$/).optional()
    .describe("평가기준일 YYYYMMDD (기본: 가장 최근 캐시된 날짜인 '20251231'). 베타 조회일 및 사업연도 결정에 사용"),
  year: z.string().regex(/^\d{4}$/).optional()
    .describe("재무제표 사업연도 YYYY. ⚠️주의: 반드시 평가기준일(valuation_date)과 동일한 연도를 입력해야 합니다! (예: 평가기준일이 20251231이면 무조건 2025 입력). 입력하지 않으면 평가기준일의 연도를 자동으로 산정합니다."),
  api_key: z.string().optional()
    .describe("OpenDART API 키 (미입력 시 서버 환경변수 사용)"),
});

type ValuationDataInput = z.infer<typeof ValuationDataInputSchema>;

// ─── Compact JSON 출력 타입 ───

interface CompactBeta {
  weekly: Record<string, [number | null, number | null, number | null]> | null;
  monthly: Record<string, [number | null, number | null, number | null]> | null;
}

interface CompactIBD {
  current: [string, number][];
  nonCurrent: [string, number][];
  total: number;
}

export interface CompactResult {
  code: string;
  name: string | null;
  industry: { code: string; name: string | null } | null;
  year: string;
  valuationDate: string;
  beta: CompactBeta;
  ibd: CompactIBD | null;
  nci: number | null;
  pretaxIncome: number | null;
  marketCap: { price: number | null; shares: number | null; total: number | null };
}

// ─── 도구 등록 ───

export function registerValuationDataTool(server: McpServer): void {
  server.registerTool(
    "valuation_get_data",
    {
      title: "DCF 밸류에이션 데이터 조회",
      description: `DCF 밸류에이션에 필요한 핵심 데이터를 조회합니다.
베타 + OpenDART(XBRL/재무/주식수) + 네이버금융(종가)을 병렬 호출합니다.
최대 10개 종목을 한번에 배치 조회할 수 있습니다.

[베타 출처] 평가기준일이 캐시된 분기말(예: 2025-03/06/09/12 말)이면 KICPA 공식 캐시값을 사용하고,
그 외 임의 영업일이면 네이버 주가+KOSPI 회귀로 직접 계산(compute_beta 로직)합니다.

[사전 확인 — 이 도구를 호출하기 전에 사용자에게 아래 정보를 확인하세요]
1. 종목코드 또는 회사명
2. 평가기준일 (YYYYMMDD)

[⚠️ AI를 위한 엄격한 파라미터 규칙]
- year 파라미터는 특별한 지시가 없는 한 무조건 valuation_date 의 연도와 일치시켜야 합니다. (관습적으로 작년 재무제표를 조회하려 하지 마세요!)
- valuation_date 를 모를 경우 임의로 라이브 날짜를 입력하지 말고 생략하세요. (서버가 가장 최신 캐시로 알아서 연결합니다)

[반환 데이터 — compact JSON]
- beta: Weekly/Monthly × 1Y/2Y/3Y/5Y — 값은 [실질베타, 조정베타, 포인트수] 배열
- ibd: 유동/비유동 세부계정 — 값은 [계정명, 금액] 튜플
- nci: 비지배지분, pretaxIncome: 세전이익
- marketCap: { price, shares(유통주식수), total }

[파라미터]
- stock_codes: 종목코드 6자리 (단일 문자열 또는 최대 10개 배열)
- valuation_date: 평가기준일 YYYYMMDD (기본: 가장 최근 캐시 일자)
- year: 재무제표 사업연도 (기본: 평가기준일 연도)

[Peer 워크플로우 Step 4]
Peer Group이 확정된 후 최대 10개 stock_codes 배열로 "한 번만" 호출하세요. valuation_date 를 분기말(YYYY0331/0630/0930/1231)로 지정하면 2,617 종목에 대해 100% 캐시 히트로 즉시 응답합니다. 이 도구 하나가 베타(Weekly/Monthly × 1Y/2Y/3Y/5Y) + 이자부부채(유동/비유동) + 비지배지분 + 세전이익 + 시가총액(price/shares/total) 을 모두 반환하므로, 같은 용도로 kicpa_get_beta / dart_get_financials / naver_get_market_data 를 따로 호출하지 마세요. 상세는 docs/PEER_GROUP_WORKFLOW.md 참조.`,
      inputSchema: ValuationDataInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ValuationDataInput) => {
      const rawCodes = params.stock_codes ?? params.stock_code;
      if (!rawCodes) {
        return { content: [{ type: "text" as const, text: "Error: stock_codes 또는 stock_code를 입력해야 합니다." }], isError: true };
      }
      const valuationDate = params.valuation_date ?? "20251231";
      const year = params.year ?? valuationDate.slice(0, 4);
      const codes = Array.isArray(rawCodes) ? rawCodes : [rawCodes];
      const apiKey = params.api_key;

      try {
        // 0. 캐시 우선 조회
        const cached: CompactResult[] = [];
        const uncachedCodes: string[] = [];

        for (const code of codes) {
          const hit = getCachedValuation(code, valuationDate);
          if (hit) {
            cached.push(hit as CompactResult);
          } else {
            uncachedCodes.push(code);
          }
        }

        // 캐시 미스가 있을 때만 라이브 API 호출
        let liveResults: CompactResult[] = [];
        if (uncachedCodes.length > 0) {
          // 1. 베타: 캐시(분기말)가 없는 기준일이므로 KICPA 대신 네이버 기반 직접 계산
          //    (Weekly/Monthly × 1/2/3/5Y 전체 그리드)
          const { weeklyMap, monthlyMap } = await computeBetaGridBatch(uncachedCodes, valuationDate);

          // 2. 미스 종목만 재무/주식수/시장/XBRL — 병렬
          liveResults = await Promise.all(uncachedCodes.map((code) => processCompany(code, year, apiKey, weeklyMap, monthlyMap)));
        }

        // 3. 캐시 + 라이브 결과 병합 (요청 순서 유지)
        const resultMap = new Map<string, CompactResult>();
        for (const r of cached) resultMap.set(r.code, r);
        for (const r of liveResults) resultMap.set(r.code, r);
        const results = codes.map((code) => resultMap.get(code)!);

        // 4. 응답: 단일이면 객체, 다중이면 배열
        const output = results.length === 1 ? results[0] : results;
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    },
  );
}

// ─── 종목별 처리 ───

async function processCompany(
  code: string,
  year: string,
  apiKey: string | undefined,
  weeklyMap: Map<string, StockBetaResult>,
  monthlyMap: Map<string, StockBetaResult>,
): Promise<CompactResult> {
  const valuationDate = formatDate(new Date());

  // 병렬: corpCode resolve → 재무/주식수/시장/기업정보
  const corpCode = await resolveCorpCode(code);

  const [financialResult, stockQtyResult, marketResult, companyResult] = await Promise.allSettled([
    fetchFinancials(corpCode, year, REPORT_CODE.annual, "CFS", apiKey),
    fetchStockQuantity(corpCode, year, REPORT_CODE.annual, apiKey),
    fetchMarketData(code),
    getCompanyInfo(code, apiKey),
  ]);

  // 기업명 + 업종
  const name = companyResult.status === "fulfilled" ? companyResult.value.corp_name : null;
  const industryCode = companyResult.status === "fulfilled" ? companyResult.value.induty_code : null;
  const industry = industryCode
    ? { code: industryCode, name: getIndustryName(industryCode) }
    : null;

  // 베타 → compact [raw, adjusted, dataPoints]
  const beta: CompactBeta = {
    weekly: compactBetas(weeklyMap.get(code)),
    monthly: compactBetas(monthlyMap.get(code)),
  };

  // 주식수
  const shares = stockQtyResult.status === "fulfilled"
    ? extractSharesInfo(stockQtyResult.value, year, REPORT_CODE.annual)
    : null;

  // 종가 + 시가총액
  const price = marketResult.status === "fulfilled" ? (marketResult.value.price ?? null) : null;
  const mcapTotal = shares && price ? shares.outstanding * price : null;

  // IBD (XBRL 우선 → Tier1/2 폴백) + NCI/세전이익
  let ibd: CompactIBD | null = null;
  let nci: number | null = null;
  let pretaxIncome: number | null = null;

  if (financialResult.status === "fulfilled") {
    const items = financialResult.value;
    const nciPretax = extractNciAndPretax(items);
    nci = nciPretax.nonControllingInterest;
    pretaxIncome = nciPretax.pretaxIncome;

    const rceptNo = items[0]?.rcept_no;
    let debt: DebtSummary | null = null;

    if (rceptNo) {
      const xbrlDebt = await extractDebtFromXbrl(rceptNo, year, apiKey);
      if (xbrlDebt) {
        debt = { ...xbrlDebt, nonControllingInterest: nci, pretaxIncome };
      }
    }

    if (!debt) {
      const fallback = extractDebtSummary(items);
      if (fallback.interestBearingDebt > 0) debt = fallback;
    }

    if (debt) {
      ibd = {
        current: debt.current.items.map((i) => [i.account, i.amount]),
        nonCurrent: debt.nonCurrent.items.map((i) => [i.account, i.amount]),
        total: debt.interestBearingDebt,
      };
    }
  }

  return {
    code,
    name,
    industry,
    year,
    valuationDate,
    beta,
    ibd,
    nci,
    pretaxIncome,
    marketCap: { price, shares: shares?.outstanding ?? null, total: mcapTotal },
  };
}

// ─── 유틸리티 ───

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** BetaValues → compact [raw, adjusted, dataPoints] 배열로 변환 */
function compactBetas(result: StockBetaResult | undefined): Record<string, [number | null, number | null, number | null]> | null {
  if (!result) return null;
  const out: Record<string, [number | null, number | null, number | null]> = {};
  for (const [period, vals] of Object.entries(result.betas)) {
    out[period] = [vals.raw, vals.adjusted, vals.dataPoints];
  }
  return out;
}
