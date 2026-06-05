/**
 * 베타 계산 순수 수학 검증 (네트워크 불필요).
 *   npx tsx scripts/verify-beta-calc.ts
 *
 * 합성 데이터로 pctChange / ols / reconstructAdjFactors / resample 정확성을 확인한다.
 */
import {
  pctChange,
  ols,
  reconstructAdjFactors,
  buildAlignedRows,
  resampleWeekly,
  resampleMonthly,
  computeReturns,
  adjustBeta,
  formatYmd,
  parseYmd,
} from "../src/services/beta-calc/math";
import type { PricePoint } from "../src/services/beta-calc/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const mark = cond ? "✅" : "❌";
  if (!cond) failures++;
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}
function approx(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// 1) pctChange 의미 (pandas)
{
  const r = pctChange([100, 110, 99]);
  check("pctChange[0] is NaN", Number.isNaN(r[0]));
  check("pctChange[1]=0.1", approx(r[1], 0.1));
  check("pctChange[2]=-0.1", approx(r[2], -0.1));
}

// 2) OLS: y = 2x + 3 → slope 2, r²=1, 방향(x=시장,y=종목)
{
  const x = [0.01, -0.02, 0.03, -0.01, 0.04];
  const y = x.map((v) => 2 * v + 3);
  const res = ols(x, y);
  check("ols slope=2", approx(res.slope, 2, 1e-9), `slope=${res.slope}`);
  check("ols r²=1", approx(res.rSquared, 1, 1e-9), `r2=${res.rSquared}`);
  check("ols n=5", res.n === 5);
  check("adjustBeta(2)=5/3", approx(adjustBeta(2), 5 / 3));
}

// 3) 수정계수 역산: 마지막 구간 factor=1, 과거에 분할(이벤트) 한 번
//    raw 가 어느 시점에 절반이 되고 adj 는 연속이면 과거 factor≈2, 현재 factor=1
{
  // 최근(인덱스 큰 쪽): raw=adj → ratio 1
  // 과거: adj 는 raw 의 2배 (분할 보정)
  const rows = [
    { raw: 50, adj: 100 }, // 과거: ratio 2
    { raw: 51, adj: 102 }, // ratio 2
    { raw: 100, adj: 100 }, // 이벤트 경계 이후: ratio 1
    { raw: 101, adj: 101 }, // ratio 1
  ];
  const f = reconstructAdjFactors(rows);
  check("factor[last]=1", approx(f[3], 1));
  check("factor[2]=1", approx(f[2], 1));
  check("factor[0]=2 (과거 분할계수 유지)", approx(f[0], 2), `f=${JSON.stringify(f)}`);
}

// 4) 주간 리샘플: 평일 시계열에서 주별 마지막 거래일(보통 금요일) 선택
{
  // 2025-01 평일들 생성 (월~금)
  const market: PricePoint[] = [];
  let d = parseYmd("20250101");
  const end = parseYmd("20250131");
  let price = 1000;
  for (; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 주말 제외
    market.push({ date: formatYmd(d), close: price });
    price += 1;
  }
  const raw = market.map((m) => ({ ...m }));
  const adj = market.map((m) => ({ ...m }));
  const rows = buildAlignedRows(market, raw, adj);
  const weekly = resampleWeekly(rows, 105);
  // 각 선택일은 금요일(또는 그 주 마지막 거래일)이어야 함
  const allFriOrLast = weekly.every((r) => {
    const dow = parseYmd(r.date).getUTCDay();
    return dow === 5; // 1월에 금요일 휴장 없음 → 전부 금요일
  });
  check("weekly picks Fridays", allFriOrLast, `dates=${weekly.map((r) => r.date).join(",")}`);
  check("weekly count = number of Fridays in Jan 2025 (5)", weekly.length === 5, `n=${weekly.length}`);
}

// 5) 월간 리샘플: 월별 마지막 거래일
{
  const market: PricePoint[] = [
    { date: "20250130", close: 10 },
    { date: "20250131", close: 11 }, // 1월 말
    { date: "20250227", close: 12 },
    { date: "20250228", close: 13 }, // 2월 말
    { date: "20250328", close: 14 }, // 3월 말
  ];
  const rows = buildAlignedRows(market, market.map((m) => ({ ...m })), market.map((m) => ({ ...m })));
  const monthly = resampleMonthly(rows, 61);
  check("monthly month-ends", monthly.map((r) => r.date).join(",") === "20250131,20250228,20250328", monthly.map((r) => r.date).join(","));
}

// 6) computeReturns: 이벤트 없는 단순 상승 → raw 수익률 사용, 첫 행 제거
{
  const market: PricePoint[] = [
    { date: "20250103", close: 100 },
    { date: "20250110", close: 110 },
    { date: "20250117", close: 121 },
  ];
  const rows = buildAlignedRows(market, market.map((m) => ({ ...m })), market.map((m) => ({ ...m })));
  const weekly = resampleWeekly(rows, 105);
  const { stockReturn, marketReturn } = computeReturns(weekly);
  check("returns length = obs (2)", stockReturn.length === 2, `len=${stockReturn.length}`);
  check("stockReturn≈[0.1,0.1]", approx(stockReturn[0], 0.1) && approx(stockReturn[1], 0.1), JSON.stringify(stockReturn));
  check("market==stock here", approx(marketReturn[0], stockReturn[0]));
}

console.log("\n" + (failures === 0 ? "🎉 ALL PASS" : `❌ ${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
