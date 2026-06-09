import type { BetaLabel, PeriodType } from "./types";

/** 수정이벤트(분할·배당) 판정 임계치 — Python 스크립트와 동일 */
export const EVENT_THRESHOLD = 0.0005;

/** 단계별 반올림 자릿수 — Python .round(10)/.round(8) 재현 */
export const FACTOR_DECIMALS = 10;
export const RETURN_DECIMALS = 8;

/**
 * 리샘플 후 유지할 행 수(keepRows). 수익률 관측치 N = keepRows - 1 (첫 행 pct_change NaN).
 * Weekly-2Y = 105 는 스크립트 그대로(→ N≈104). Monthly-5Y = 61 (→ N≈60).
 */
export interface PeriodSpec {
  label: BetaLabel;
  periodType: PeriodType;
  keepRows: number;
  /** StockBetaResult.betas 의 키 매핑 (Weekly-2Y→"2Y", Monthly-5Y→"5Y") */
  betaKey: string;
}

export const PERIOD_SPECS: Record<BetaLabel, PeriodSpec> = {
  "Weekly-2Y": { label: "Weekly-2Y", periodType: "Weekly", keepRows: 105, betaKey: "2Y" },
  "Monthly-5Y": { label: "Monthly-5Y", periodType: "Monthly", keepRows: 61, betaKey: "5Y" },
};

export const DEFAULT_PERIODS: BetaLabel[] = ["Weekly-2Y", "Monthly-5Y"];

/**
 * 분기말 캐시/밸류에이션용 베타 조합. 요구사항에 따라 Weekly-2Y, Monthly-5Y 두 가지만 산출한다.
 * keepRows = 관측치 N + 1. (N: 주간 104, 월간 60 — KICPA dataPoints와 일치)
 */
export type BetaKey = "1Y" | "2Y" | "3Y" | "5Y";
export interface GridSpec {
  periodType: PeriodType;
  betaKey: BetaKey;
  keepRows: number;
}
export const GRID_SPECS: GridSpec[] = [
  { periodType: "Weekly", betaKey: "2Y", keepRows: 105 },
  { periodType: "Monthly", betaKey: "5Y", keepRows: 61 },
];

/** 가장 긴 기간(5년) + 여유 버퍼만큼 과거 데이터를 한 번에 받는다 */
export const LOOKBACK_DAYS = 5 * 365 + 250;

/** 한 번의 호출에서 처리할 최대 종목 수 (서버리스 타임아웃 방지) */
export const MAX_COMPUTE_STOCKS = 5;
