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
import { fetchAdjDaily, fetchKospiDaily } from "./data-source";
import { fetchMarketData } from "../naver/client";

export interface ComputeBetaParams {
  stockCodes: string[];
  /** 평가기준일 YYYYMMDD */
  date: string;
  periods?: BetaLabel[];
  /** KOSPI 지수 심볼 (기본 "KOSPI") */
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
  marketSeries: PricePoint[]
): Promise<ComputeBetaStockResult> {
  const [adj, nameInfo] = await Promise.all([
    fetchAdjDaily(stockCode, startDate, endDate),
    fetchMarketData(stockCode).catch(() => null),
  ]);

  // siseJson 수정주가를 raw/adj 동일 입력으로 사용 → 수정수익률 회귀(검증상 KICPA와 일치).
  const raw = adj;

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
      // KICPA 보고 정밀도(소수점 6자리)에 맞춰 반올림.
      // 조정베타는 '반올림된 실질베타'에서 산출 → KICPA 표기와 정확히 일치.
      const rawBeta = round6(slope);
      result.results[label] = {
        raw: rawBeta,
        adjusted: round6(adjustBeta(rawBeta)),
        rSquared: round6(rSquared),
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
        marketSeries
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

/** KICPA 표기 정밀도에 맞춘 소수점 6자리 반올림 */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 종목코드 정규화: 숫자만, 6자리 zero-pad */
function normalizeCode(code: string): string {
  const digits = code.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits.padStart(6, "0") : code;
}
