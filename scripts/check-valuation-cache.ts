/**
 * 밸류에이션 캐시 품질 검사 — 자동 수집(GitHub Actions)이 커밋 전에 실행한다.
 *
 *   npx tsx scripts/check-valuation-cache.ts            # 엔진 v2 로 만든 모든 기준일
 *   npx tsx scripts/check-valuation-cache.ts 20260630   # 지정 기준일
 *
 * 기준을 넘으면 종료코드 1 — 워크플로가 커밋하지 않는다.
 */
import fs from "fs";
import path from "path";

const DIR = path.resolve(__dirname, "../data/valuation-cache");

/** 전체 종목 대비 허용 비율 */
const LIMITS = {
  noReport: 0.05, // 기준일 당시 정기보고서를 못 고른 종목
  priceNull: 0.03, // 기준일 종가 없음(거래정지 등)
  sharesNull: 0.03,
  ibdChecks: 0.2, // 이자부부채 산정 경고가 붙은 종목
  sharesJump: 0.02, // 직전 분기 대비 주식수 3배 이상 변동
};

type Entry = {
  marketCap: { shares: number | null };
  ibd: { checks?: string[] } | null;
};

function load(date: string): Record<string, Entry> | null {
  const p = path.join(DIR, `${date}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

const all = fs
  .readdirSync(DIR)
  .filter((f) => /^\d{8}\.json$/.test(f))
  .map((f) => f.slice(0, 8))
  .sort();
const v2 = all.filter((d) => {
  const m = path.join(DIR, `${d}.meta.json`);
  return fs.existsSync(m) && JSON.parse(fs.readFileSync(m, "utf8")).engine?.startsWith("ibd-v2");
});
const targets = process.argv.slice(2).filter((a) => /^\d{8}$/.test(a));
const dates = targets.length ? targets : v2;

let failed = false;
for (const d of dates) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${d}.meta.json`), "utf8"));
  const s = meta.stats as Record<string, number>;
  const n = s.total || 1;
  const rows: [string, number, number][] = [
    ["보고서 미선택", s.noReport / n, LIMITS.noReport],
    ["종가 없음", s.priceNull / n, LIMITS.priceNull],
    ["주식수 없음", s.sharesNull / n, LIMITS.sharesNull],
    ["이자부부채 경고", s.ibdChecks / n, LIMITS.ibdChecks],
  ];
  // 직전 기준일 대비 주식수 급변(단위 오류·병합 누락 탐지)
  const prev = all.filter((x) => x < d).pop();
  if (prev) {
    const cur = load(d)!;
    const before = load(prev)!;
    let jump = 0;
    for (const [code, e] of Object.entries(cur)) {
      const a = before[code]?.marketCap?.shares;
      const b = e.marketCap?.shares;
      if (a && b && (b / a > 3 || a / b > 3)) jump += 1;
    }
    rows.push([`주식수 3배 이상 변동(대비 ${prev})`, jump / n, LIMITS.sharesJump]);
  }
  console.log(`\n■ ${d} — ${n}종목 (${meta.engine}, ${meta.generatedAt})`);
  for (const [label, ratio, limit] of rows) {
    const bad = ratio > limit;
    if (bad) failed = true;
    console.log(`  ${bad ? "✗" : "✓"} ${label}: ${(ratio * 100).toFixed(1)}% (한도 ${(limit * 100).toFixed(0)}%)`);
  }
  console.log(`  · 금융업 제외 ${s.ibdExcluded}, 주석 보충 ${s.xbrlSupplemented}, 주식수 단위 보정 ${s.sharesFixed}`);
}
if (!dates.length) console.log("검사할 기준일 없음(엔진 v2 캐시 없음)");
process.exit(failed ? 1 : 0);
