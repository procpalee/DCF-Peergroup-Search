import type { BetaLabel, ComputedBeta, PricePoint } from "./types";
import {
  DEFAULT_PERIODS,
  LOOKBACK_DAYS,
  MAX_COMPUTE_STOCKS,
  PERIOD_SPECS,
} from "./constants";
import {
  buildAlignedRows,
  resampleWeekly,
  resampleMonthly,
  computeReturns,
  ols,
  adjustBeta,
  parseYmd,
  formatYmd,
} from "./math";
import { fetchAdjDaily, fetchKospiDaily, fetchRawDaily } from "./data-source";
import { fetchMarketData } from "../naver/client";

export interface ComputeBetaParams {
  stockCodes: string[];
  /** 평가기준일 YYYYMMDD */
  date: string;
  periods?: BetaLabel[];
  /** 정밀 모드: 원주가(sise_day)를 별도 수집해 사용 (기본 false → 수정주가로 근사) */
  useRawPrices?: boolean;
  /** KOSPI 지수 심볼 (Vercel 실측으로 확정) */
  kospiSymbol?: string;
}

export interface ComputeBetaStockResult {
  stockCode: string;
  stockName: string | null;
  baseDate: string;
  results: Partial<Record<BetaLabel, ComputedBeta>>;
  error?: string;
}

function normalizeDate(date: string): string {
  return date.replace(/[^0-9]/g, "").slice(0, 8);
}

/** 한 종목의 (Weekly-2Y, Monthly-5Y) 베타를 직접 계산 */
async function computeOneStock(
  stockCode: string,
  startDate: string,
  endDate: string,
  periods: BetaLabel[],
  marketSeries: PricePoint[],
  useRawPrices: boolean
): Promise<ComputeBetaStockResult> {
  const [adj, nameInfo] = await Promise.all([
    fetchAdjDaily(stockCode, startDate, endDate),
    fetchMarketData(stockCode).catch(() => null),
  ]);

  const raw = useRawPrices
    ? await fetchRawDaily(stockCode, startDate).catch(() => adj)
    : adj;

  const result: ComputeBetaStockResult = {
    stockCode,
    stockName: nameInfo?.stockName ?? null,
    baseDate: endDate,
    results: {},
  };

  if (marketSeries.length === 0 || adj.length === 0) {
    result.error = "가격/지수 데이터를 가져오지 못했습니다.";
    return result;
  }

  const rows = buildAlignedRows(marketSeries, raw, adj);

  for (const label of periods) {
    const spec = PERIOD_SPECS[label];
    const resampled =
      spec.periodType === "Weekly"
        ? resampleWeekly(rows, spec.keepRows)
        : resampleMonthly(rows, spec.keepRows);
    const { stockReturn, marketReturn } = computeReturns(resampled);
    const { slope, rSquared, n } = ols(marketReturn, stockReturn);
    if (isFinite(slope)) {
      result.results[label] = {
        raw: slope,
        adjusted: adjustBeta(slope),
        rSquared,
        dataPoints: n,
      };
    }
  }
  return result;
}

/**
 * 네이버 주가 + KOSPI 지수로 베타를 직접 계산한다(KICPA 비의존).
 * 지수 시리즈는 한 번만 받아 모든 종목에 재사용한다.
 */
export async function computeBetaData(
  params: ComputeBetaParams
): Promise<ComputeBetaStockResult[]> {
  const periods = params.periods ?? DEFAULT_PERIODS;
  const endDate = normalizeDate(params.date);
  const startDate = formatYmd(
    new Date(parseYmd(endDate).getTime() - LOOKBACK_DAYS * 86400000)
  );
  const codes = params.stockCodes.slice(0, MAX_COMPUTE_STOCKS);

  // 지수 1회 수집 후 공유
  const marketSeries = await fetchKospiDaily(
    startDate,
    endDate,
    params.kospiSymbol
  ).catch(() => [] as PricePoint[]);

  const results = await Promise.all(
    codes.map((code) =>
      computeOneStock(
        normalizeCode(code),
        startDate,
        endDate,
        periods,
        marketSeries,
        params.useRawPrices ?? false
      ).catch((e) => ({
        stockCode: code,
        stockName: null,
        baseDate: endDate,
        results: {},
        error: e instanceof Error ? e.message : String(e),
      }))
    )
  );
  return results;
}

/** 종목코드 정규화: 숫자만, 6자리 zero-pad */
function normalizeCode(code: string): string {
  const digits = code.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits.padStart(6, "0") : code;
}
