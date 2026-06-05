import type { BetaLabel, AlignedRow, ComputedBeta, PricePoint } from "./types";
import {
  DEFAULT_PERIODS,
  GRID_SPECS,
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
import type { BetaValues, StockBetaResult } from "../kicpa/types";

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

/** 정렬된 행에서 한 (주기 × 기간) 셀의 BetaValues 산출 */
function computeCell(
  rows: AlignedRow[],
  periodType: "Weekly" | "Monthly",
  keepRows: number
): BetaValues {
  const resampled =
    periodType === "Weekly"
      ? resampleWeekly(rows, keepRows)
      : resampleMonthly(rows, keepRows);
  const { stockReturn, marketReturn } = computeReturns(resampled);
  const { slope, rSquared, n } = ols(marketReturn, stockReturn);
  if (!isFinite(slope)) return { raw: null, adjusted: null, dataPoints: null };
  const rawBeta = round6(slope);
  return { raw: rawBeta, adjusted: round6(adjustBeta(rawBeta)), dataPoints: n };
}

export interface BetaGridMaps {
  weeklyMap: Map<string, StockBetaResult>;
  monthlyMap: Map<string, StockBetaResult>;
}

/**
 * valuation_get_data 폴백: Weekly/Monthly × 1/2/3/5Y 전체 그리드를 직접 계산해
 * KICPA fetchBetaData 와 동일한 (weeklyMap, monthlyMap) 형태로 반환한다.
 * 분기말 캐시가 없는(=비분기말 등) 기준일에 KICPA 대신 사용한다.
 */
export async function computeBetaGridBatch(
  stockCodes: string[],
  date: string,
  kospiSymbol?: string
): Promise<BetaGridMaps> {
  const endDate = normalizeDate(date);
  const startDate = formatYmd(
    new Date(parseYmd(endDate).getTime() - LOOKBACK_DAYS * 86400000)
  );

  const weeklyMap = new Map<string, StockBetaResult>();
  const monthlyMap = new Map<string, StockBetaResult>();

  const marketSeries = await fetchKospiDaily(startDate, endDate, kospiSymbol).catch(
    () => [] as PricePoint[]
  );
  if (marketSeries.length === 0) return { weeklyMap, monthlyMap };

  await Promise.all(
    stockCodes.map(async (code) => {
      try {
        const adj = await fetchAdjDaily(normalizeCode(code), startDate, endDate);
        if (adj.length === 0) return;
        const rows = buildAlignedRows(marketSeries, adj, adj);
        const lastClose = adj[adj.length - 1]?.close ?? null;

        const weeklyBetas: Record<string, BetaValues> = {};
        const monthlyBetas: Record<string, BetaValues> = {};
        for (const spec of GRID_SPECS) {
          const bv = computeCell(rows, spec.periodType, spec.keepRows);
          if (spec.periodType === "Weekly") weeklyBetas[spec.betaKey] = bv;
          else monthlyBetas[spec.betaKey] = bv;
        }

        const base = {
          stockCode: code,
          stockNameKr: "",
          stockNameEn: "",
          market: "",
          closePrice: lastClose !== null ? String(lastClose) : "",
          date: endDate,
        };
        weeklyMap.set(code, { ...base, betas: weeklyBetas });
        monthlyMap.set(code, { ...base, betas: monthlyBetas });
      } catch {
        // 종목 단위 실패는 무시 → 해당 종목 beta 는 null 로 남는다.
      }
    })
  );

  return { weeklyMap, monthlyMap };
}

/** 종목코드 정규화: 숫자만, 6자리 zero-pad */
function normalizeCode(code: string): string {
  const digits = code.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits.padStart(6, "0") : code;
}
