import type { BetaLabel, AlignedRow, ComputedBeta, PricePoint } from "./types";
import { DEFAULT_PERIODS, GRID_SPECS, LOOKBACK_DAYS, MAX_COMPUTE_STOCKS, PERIOD_SPECS } from "./constants";
import { buildAlignedRows, resampleWeekly, resampleMonthly, computeReturns, ols, adjustBeta, parseYmd, formatYmd } from "./math";
import { adjustedCloses, fetchKospiDays, fetchStockDays, FSC_FIRST_DATE, type StockDay } from "../market/fsc";
import type { BetaValues } from "../kicpa/types";

/**
 * 베타·기준일 종가 계산. 시세는 공공데이터포털 금융위원회 API 를 **요청한 이용자의 키**로 그때그때 받는다
 * (제3자 제공·재배포 금지 데이터라 서버가 수집·저장하지 않는다 — src/services/market/fsc.ts).
 * 수정수익률을 KOSPI 지수 수익률에 회귀(OLS)하고, 리샘플·회귀 규칙은 KICPA 재현 로직(math.ts) 그대로다.
 */

export interface ComputeBetaParams {
  stockCodes: string[];
  /** 평가기준일 YYYYMMDD */
  date: string;
  /** 공공데이터포털 일반 인증키(Decoding) — 이용자 키 */
  key: string;
  periods?: BetaLabel[];
}

export interface ComputeBetaStockResult {
  stockCode: string;
  stockName: string | null;
  baseDate: string;
  results: Partial<Record<BetaLabel, ComputedBeta>>;
  note?: string;
  error?: string;
}

/** valuation_get_data 용 종목별 시장 데이터 */
export interface MarketResult {
  name: string | null;
  /** 종가를 쓴 거래일(기준일 이하 마지막 거래일) */
  priceDate: string | null;
  /** 원주가 종가 */
  price: number | null;
  /** 그 거래일의 상장주식수 */
  listedShares: number | null;
  beta: {
    weekly: Record<string, [number | null, number | null, number | null]> | null;
    monthly: Record<string, [number | null, number | null, number | null]> | null;
  };
  note?: string;
  error?: string;
}

function normalizeDate(date: string): string {
  return date.replace(/[^0-9]/g, "").slice(0, 8);
}

function lookbackStart(endDate: string): string {
  return formatYmd(new Date(parseYmd(endDate).getTime() - LOOKBACK_DAYS * 86400000));
}

/** KICPA 표기 정밀도에 맞춘 소수점 6자리 반올림 */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function computeCell(rows: AlignedRow[], periodType: "Weekly" | "Monthly", keepRows: number): BetaValues {
  const resampled = periodType === "Weekly" ? resampleWeekly(rows, keepRows) : resampleMonthly(rows, keepRows);
  const { stockReturn, marketReturn } = computeReturns(resampled);
  const { slope, n } = ols(marketReturn, stockReturn);
  if (!isFinite(slope)) return { raw: null, adjusted: null, dataPoints: null };
  // 조정베타는 '반올림된 실질베타'에서 산출 → KICPA 표기와 같은 방식
  const rawBeta = round6(slope);
  return { raw: rawBeta, adjusted: round6(adjustBeta(rawBeta)), dataPoints: n };
}

/** 2020-01-02 이전 시세가 없어 관측치가 모자라면 그 사실을 적는다 */
function shortHistoryNote(start: string, observed: Array<[string, number | null, number]>): string | undefined {
  const short = observed.filter(([, n, want]) => n !== null && n < want);
  if (!short.length || start >= FSC_FIRST_DATE) return undefined;
  return `공공데이터 시세가 ${FSC_FIRST_DATE}부터 제공돼 관측치가 부족: ${short.map(([l, n, w]) => `${l} ${n}/${w}`).join(", ")}`;
}

async function loadKospi(start: string, end: string, key: string): Promise<PricePoint[]> {
  const kospi = await fetchKospiDays(start, end, key);
  if (!kospi.length) throw new Error(`API_ERROR: ${end} 이전 KOSPI 지수 시세가 없습니다.`);
  return kospi;
}

function alignedRows(kospi: PricePoint[], days: StockDay[]): AlignedRow[] {
  const adj = adjustedCloses(days);
  // 수정주가를 raw/adj 같은 입력으로 쓴다 → 수정수익률 회귀
  return buildAlignedRows(kospi, adj, adj);
}

/** compute_beta: (Weekly-2Y, Monthly-5Y) 베타 + R² */
export async function computeBetaData(params: ComputeBetaParams): Promise<ComputeBetaStockResult[]> {
  const periods = params.periods ?? DEFAULT_PERIODS;
  const endDate = normalizeDate(params.date);
  const startDate = lookbackStart(endDate);
  const codes = params.stockCodes.slice(0, MAX_COMPUTE_STOCKS).map(normalizeCode);
  const kospi = await loadKospi(startDate, endDate, params.key);

  return Promise.all(
    codes.map(async (code): Promise<ComputeBetaStockResult> => {
      const result: ComputeBetaStockResult = { stockCode: code, stockName: null, baseDate: endDate, results: {} };
      try {
        const days = await fetchStockDays(code, startDate, endDate, params.key);
        if (!days.length) {
          result.error = "기준일 이전 시세가 없습니다(상장 전이거나 종목코드 확인 필요).";
          return result;
        }
        result.stockName = days[days.length - 1].name;
        const rows = alignedRows(kospi, days);
        const observed: Array<[string, number | null, number]> = [];
        for (const label of periods) {
          const spec = PERIOD_SPECS[label];
          const resampled = spec.periodType === "Weekly" ? resampleWeekly(rows, spec.keepRows) : resampleMonthly(rows, spec.keepRows);
          const { stockReturn, marketReturn } = computeReturns(resampled);
          const { slope, rSquared, n } = ols(marketReturn, stockReturn);
          if (isFinite(slope)) {
            const rawBeta = round6(slope);
            result.results[label] = { raw: rawBeta, adjusted: round6(adjustBeta(rawBeta)), rSquared: round6(rSquared), dataPoints: n };
          }
          observed.push([label, isFinite(slope) ? n : null, spec.keepRows - 1]);
        }
        const note = shortHistoryNote(startDate, observed);
        if (note) result.note = note;
      } catch (e) {
        result.error = e instanceof Error ? e.message.replace(/^API_ERROR:\s*/, "") : String(e);
      }
      return result;
    }),
  );
}

/**
 * valuation_get_data: 종목별 기준일 종가·상장주식수·베타(Weekly-2Y, Monthly-5Y).
 * 지수 조회가 실패하면 모든 종목에 같은 오류를 단다(종가는 그대로 낸다).
 */
export async function fetchMarketBatch(stockCodes: string[], date: string, key: string): Promise<Map<string, MarketResult>> {
  const endDate = normalizeDate(date);
  const startDate = lookbackStart(endDate);
  const out = new Map<string, MarketResult>();

  let kospi: PricePoint[] | null = null;
  let kospiError: string | null = null;
  try {
    kospi = await loadKospi(startDate, endDate, key);
  } catch (e) {
    kospiError = e instanceof Error ? e.message.replace(/^API_ERROR:\s*/, "") : String(e);
  }

  await Promise.all(
    stockCodes.map(async (code) => {
      const r: MarketResult = { name: null, priceDate: null, price: null, listedShares: null, beta: { weekly: null, monthly: null } };
      try {
        const days = await fetchStockDays(normalizeCode(code), startDate, endDate, key);
        const last = days[days.length - 1];
        if (!last) {
          r.error = "기준일 이전 시세가 없습니다(상장 전이거나 종목코드 확인 필요).";
        } else {
          r.name = last.name;
          r.priceDate = last.date;
          r.price = last.close;
          r.listedShares = last.listedShares || null;
          if (kospi) {
            const rows = alignedRows(kospi, days);
            const observed: Array<[string, number | null, number]> = [];
            for (const spec of GRID_SPECS) {
              const bv = computeCell(rows, spec.periodType, spec.keepRows);
              const side = spec.periodType === "Weekly" ? "weekly" : "monthly";
              r.beta[side] = { ...(r.beta[side] ?? {}), [spec.betaKey]: [bv.raw, bv.adjusted, bv.dataPoints] };
              observed.push([`${spec.periodType}-${spec.betaKey}`, bv.dataPoints, spec.keepRows - 1]);
            }
            const note = shortHistoryNote(startDate, observed);
            if (note) r.note = note;
          } else {
            r.error = `베타 계산 불가 - ${kospiError}`;
          }
        }
      } catch (e) {
        r.error = e instanceof Error ? e.message.replace(/^API_ERROR:\s*/, "") : String(e);
      }
      out.set(code, r);
    }),
  );
  return out;
}

/** 종목코드 정규화: 숫자만, 6자리 zero-pad */
function normalizeCode(code: string): string {
  const digits = code.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits.padStart(6, "0") : code;
}
