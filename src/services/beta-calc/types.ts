/**
 * 네이버 주가 + KOSPI 지수 기반 베타 직접 계산 모듈의 타입 정의.
 * KICPA/KOSCOM에 의존하지 않는 독립 경로다.
 */

export interface PricePoint {
  date: string; // "YYYYMMDD"
  close: number;
}

/** 시장 거래일 인덱스 기준으로 정렬·ffill된 한 행 */
export interface AlignedRow {
  date: string; // 시장 거래일 (YYYYMMDD)
  market: number;
  raw: number; // 원주가 (ffill)
  adj: number; // 수정주가 (ffill)
  adjFactor: number; // 역산한 수정계수
  preciseAdj: number; // raw * adjFactor
}

export interface OlsResult {
  slope: number;
  rSquared: number;
  n: number;
}

/** 한 (주기 × 기간) 조합의 계산 결과 */
export interface ComputedBeta {
  raw: number; // 실질베타 (회귀 기울기)
  adjusted: number; // 조정베타 = raw*2/3 + 1/3
  rSquared: number;
  dataPoints: number; // 수익률 관측치 수 N
}

export type PeriodType = "Weekly" | "Monthly";

/** 지원 조합 라벨 */
export type BetaLabel = "Weekly-2Y" | "Monthly-5Y";
