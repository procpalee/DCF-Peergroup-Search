import type { AlignedRow, OlsResult, PricePoint } from "./types";
import { EVENT_THRESHOLD, FACTOR_DECIMALS, RETURN_DECIMALS } from "./constants";

/**
 * 베타 계산의 순수 함수 모음. 네트워크 의존 없음 → npx tsx 로 단위 검증 가능.
 * Python(pandas/scipy) 파이프라인을 가능한 한 충실히 이식한다.
 */

// ── 날짜 유틸 (YYYYMMDD 문자열 ↔ UTC Date) ──────────────────────────────
export function parseYmd(s: string): Date {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

// ── 기본 연산 ───────────────────────────────────────────────────────────
/** pandas pct_change: r[i] = series[i]/series[i-1] - 1, r[0] = NaN */
export function pctChange(series: number[]): number[] {
  const out: number[] = new Array(series.length);
  out[0] = NaN;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    out[i] = prev === 0 || !isFinite(prev) ? NaN : series[i] / prev - 1;
  }
  return out;
}

/** 고정 자릿수 반올림 (Python round 근사) */
export function round(value: number, decimals: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ── Stage 4: 시장 거래일 인덱스 기준 정렬 + forward-fill ──────────────────
/**
 * 시장(지수) 거래일을 인덱스로 삼아 raw/adj 를 정렬하고 전방 채움한다.
 * Python: DataFrame(index=df_mkt.index) → join(raw) → assign(adj) → ffill()
 * 선행 결측(첫 유효값 이전)은 ffill 로도 못 채우므로 NaN 으로 남는다.
 */
export function alignAndFill(
  market: PricePoint[],
  raw: PricePoint[],
  adj: PricePoint[]
): Array<{ date: string; market: number; raw: number; adj: number }> {
  const rawMap = new Map(raw.map((p) => [p.date, p.close]));
  const adjMap = new Map(adj.map((p) => [p.date, p.close]));

  const sortedMarket = [...market].sort((a, b) => (a.date < b.date ? -1 : 1));

  const rows: Array<{ date: string; market: number; raw: number; adj: number }> = [];
  let lastRaw = NaN;
  let lastAdj = NaN;
  for (const m of sortedMarket) {
    if (rawMap.has(m.date)) lastRaw = rawMap.get(m.date)!;
    if (adjMap.has(m.date)) lastAdj = adjMap.get(m.date)!;
    rows.push({ date: m.date, market: m.close, raw: lastRaw, adj: lastAdj });
  }
  return rows;
}

// ── Stage 5: 수정계수 역산 (계단식) ───────────────────────────────────────
/**
 * ratio = adj/raw 를 마지막 날부터 역방향으로 훑어, 직전(미래) 계수 대비
 * 상대변화가 임계치를 넘을 때만 갱신 → 분할·배당 이벤트만 계단식으로 분리.
 */
export function reconstructAdjFactors(
  rows: Array<{ raw: number; adj: number }>,
  threshold = EVENT_THRESHOLD
): number[] {
  const n = rows.length;
  const ratios = rows.map((r) =>
    r.raw === 0 || !isFinite(r.raw) ? NaN : r.adj / r.raw
  );
  const refined = new Array<number>(n);
  if (n === 0) return refined;
  refined[n - 1] = ratios[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    const next = refined[i + 1];
    const denom = next !== 0 && isFinite(next) ? next : 1;
    const change = Math.abs(ratios[i] - next) / denom;
    refined[i] = change > threshold ? ratios[i] : next;
  }
  return refined.map((v) => round(v, FACTOR_DECIMALS));
}

/** Stage 6: 정밀 수정주가 = raw * factor */
export function computePreciseAdj(
  rows: Array<{ raw: number }>,
  factors: number[]
): number[] {
  return rows.map((r, i) => round(r.raw * factors[i], FACTOR_DECIMALS));
}

/** 정렬·계수·정밀가를 합쳐 AlignedRow[] 구성 */
export function buildAlignedRows(
  market: PricePoint[],
  raw: PricePoint[],
  adj: PricePoint[]
): AlignedRow[] {
  const base = alignAndFill(market, raw, adj);
  const factors = reconstructAdjFactors(base);
  const precise = computePreciseAdj(base, factors);
  return base.map((b, i) => ({
    ...b,
    adjFactor: factors[i],
    preciseAdj: precise[i],
  }));
}

// ── Stage 7: KOSCOM 영업일 리샘플링 ──────────────────────────────────────
/**
 * Weekly: 각 달력상 금요일(W-FRI)에 대해 그 주(월~금)의 마지막 실제 거래일을 취한다.
 * 목·금 모두 휴장인 주는 건너뛴다(Python: thu/fri 둘 다 없으면 skip).
 */
export function resampleWeekly(rows: AlignedRow[], keepRows: number): AlignedRow[] {
  if (rows.length === 0) return [];
  const indexSet = new Set(rows.map((r) => r.date));
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const dates = rows.map((r) => r.date);

  const first = parseYmd(dates[0]);
  const last = parseYmd(dates[dates.length - 1]);

  // 첫 금요일 찾기 (getUTCDay: 5 = 금)
  let fri = new Date(first);
  while (fri.getUTCDay() !== 5) fri = addDays(fri, 1);

  const picked: AlignedRow[] = [];
  for (; fri.getTime() <= last.getTime(); fri = addDays(fri, 7)) {
    const thu = addDays(fri, -1);
    const friStr = formatYmd(fri);
    const thuStr = formatYmd(thu);
    if (!indexSet.has(thuStr) && !indexSet.has(friStr)) continue;

    const weekStart = formatYmd(addDays(fri, -4)); // 월요일
    // [weekStart, friStr] 범위의 마지막 거래일
    let lastInWeek: string | null = null;
    for (const d of dates) {
      if (d >= weekStart && d <= friStr) lastInWeek = d;
      if (d > friStr) break;
    }
    if (lastInWeek) picked.push(byDate.get(lastInWeek)!);
  }
  return picked.slice(-keepRows);
}

/** Monthly: 각 달력월의 마지막 실제 거래일을 취한다. */
export function resampleMonthly(rows: AlignedRow[], keepRows: number): AlignedRow[] {
  if (rows.length === 0) return [];
  const lastOfMonth = new Map<string, AlignedRow>(); // "YYYYMM" → 마지막 행
  for (const r of rows) {
    lastOfMonth.set(r.date.slice(0, 6), r); // 정렬되어 있으므로 마지막 할당이 월말
  }
  const ordered = [...lastOfMonth.keys()].sort().map((k) => lastOfMonth.get(k)!);
  return ordered.slice(-keepRows);
}

// ── Stage 8: 조건부 수익률 ───────────────────────────────────────────────
export interface ReturnSeries {
  stockReturn: number[];
  marketReturn: number[];
}

/**
 * 수정이벤트가 있는 구간은 정밀수정가, 아니면 원주가의 pct_change 를 사용.
 * 첫 행(NaN)은 제거한다(Python dropna(subset=['Stock_Return'])).
 */
export function computeReturns(
  resampled: AlignedRow[],
  threshold = EVENT_THRESHOLD
): ReturnSeries {
  const factor = resampled.map((r) => r.adjFactor);
  const raw = resampled.map((r) => r.raw);
  const precise = resampled.map((r) => r.preciseAdj);
  const market = resampled.map((r) => r.market);

  const factorPct = pctChange(factor);
  const rawPct = pctChange(raw);
  const precisePct = pctChange(precise);
  const marketPct = pctChange(market);

  const stockReturn: number[] = [];
  const marketReturn: number[] = [];
  for (let i = 0; i < resampled.length; i++) {
    const isEvent = Math.abs(factorPct[i]) > threshold; // i=0 → NaN>thr → false
    const sr = round(isEvent ? precisePct[i] : rawPct[i], RETURN_DECIMALS);
    if (!isFinite(sr)) continue; // 첫 행 등 NaN 제거
    const mr = round(marketPct[i], RETURN_DECIMALS);
    stockReturn.push(sr);
    marketReturn.push(mr);
  }
  return { stockReturn, marketReturn };
}

// ── Stage 9: OLS 회귀 (라이브러리 없이 직접) ─────────────────────────────
/** slope = cov(x,y)/var(x), r²=corr², n=관측치. x=시장수익률, y=종목수익률. */
export function ols(x: number[], y: number[]): OlsResult {
  const n = Math.min(x.length, y.length);
  if (n < 2) return { slope: NaN, rSquared: NaN, n };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const slope = sxx === 0 ? NaN : sxy / sxx;
  const denom = Math.sqrt(sxx * syy);
  const r = denom === 0 ? NaN : sxy / denom;
  return { slope, rSquared: r * r, n };
}

/** 조정베타 = 실질베타 × 2/3 + 1/3 */
export function adjustBeta(rawBeta: number): number {
  return (rawBeta * 2) / 3 + 1 / 3;
}
