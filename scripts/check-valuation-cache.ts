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
import { IBD_ENGINE_VERSION } from "../src/services/opendart/ibd-engine";

const DIR = path.resolve(__dirname, "../data/valuation-cache");

/** 전체 종목 대비 허용 비율 */
const LIMITS = {
  noReport: 0.05, // 기준일 당시 정기보고서를 못 고른 종목
  priceNull: 0.03, // 기준일 종가 없음(거래정지 등)
  sharesNull: 0.03,
  ibdChecks: 0.2, // 이자부부채 산정 경고가 붙은 종목
  sharesJump: 0.02, // 직전 분기 대비 주식수 3배 이상 변동
  unitOutlier: 0.001, // 보류되지 않은 단위 이상 의심(자본 100배 변동·IBD 500조 초과) — 현재 엔진 판 기준일만
};

type Entry = {
  marketCap: { shares: number | null };
  ibd: { total?: number; checks?: string[] } | null;
  financials?: { equityTotal?: number | null; cash?: number | null; error?: string } | null;
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
    // 현재 엔진 판 기준일만 — 옛 판 기준일이 게이트를 막지 않게
    if (String(meta.engine).startsWith(IBD_ENGINE_VERSION)) {
      let outlier = 0;
      for (const [code, e] of Object.entries(cur)) {
        if (e.financials?.error?.startsWith("데이터 품질 보류")) continue;
        // 수집기 보류 규칙과 같은 기준 — 자본이 100배 변하고 IBD(무차입이면 현금)도 같은 배율일 때만 단위 오류로 본다
        const eq = e.financials?.equityTotal;
        const peq = before[code]?.financials?.equityTotal;
        const same = (a?: number | null, b?: number | null, r = 1) => !!a && !!b && a > 0 && b > 0 && a / b >= r * 0.5 && a / b <= r * 2;
        let jump = false;
        if (eq && peq && eq > 0 && peq > 0 && (eq / peq >= 100 || eq / peq <= 0.01)) {
          const r = eq / peq;
          const it = e.ibd?.total ?? 0;
          const pt = before[code]?.ibd?.total ?? 0;
          jump = it > 0 && pt > 0 ? same(it, pt, r) : same(e.financials?.cash, before[code]?.financials?.cash, r);
        }
        if ((e.ibd?.total ?? 0) > 5e14 || jump) outlier += 1;
      }
      rows.push([`단위 이상 의심(보류 안 됨, 대비 ${prev})`, outlier / n, LIMITS.unitOutlier]);
    }
  }
  if (String(meta.engine).includes("혼합")) {
    failed = true;
    console.log(`  ✗ 엔진 판 혼합: ${JSON.stringify(meta.engineMix)} — 옛 판 결과가 섞여 있음(재계산 필요)`);
  }
  console.log(`\n■ ${d} — ${n}종목 (${meta.engine}, ${meta.generatedAt})`);
  for (const [label, ratio, limit] of rows) {
    const bad = ratio > limit;
    if (bad) failed = true;
    console.log(`  ${bad ? "✗" : "✓"} ${label}: ${(ratio * 100).toFixed(1)}% (한도 ${(limit * 100).toFixed(0)}%)`);
  }
  console.log(
    `  · 금융업 제외 ${s.ibdExcluded}, 주석 보충 ${s.xbrlSupplemented}, 주식수 단위 보정 ${s.sharesFixed}` +
      (s.ibdPartial != null ? `, 이자부부채 일부 누락 가능(partial) ${s.ibdPartial}, 품질 보류 ${s.qualityHeld ?? 0}` : ""),
  );
}
if (!dates.length) console.log("검사할 기준일 없음(엔진 v2 캐시 없음)");
process.exit(failed ? 1 : 0);
