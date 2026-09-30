/**
 * 이자부부채 정답표(독립 검증 결과) 대조 — 원자료로 엔진을 돌려 정답과 맞춘다. 네트워크 없음.
 *
 *   npx tsx scripts/ibd-gold.ts 20260630                     # 정답표 전체 대조 요약
 *   npx tsx scripts/ibd-gold.ts 20260630 --set holdout       # 표본 한쪽만(tuning|holdout)
 *   npx tsx scripts/ibd-gold.ts 20260630 --export-fixtures   # 확정 정답을 회귀 테스트 fixture 로 내보내기
 *
 * 정답표: scripts/_scratch/ibd-corpus/gold-{기준일}.json — { 종목코드: GoldLabel }
 * 일치 기준: 차이 ≤ max(0.5%, 1억 원). total·리스 제외(debt)·리스·유동/비유동을 따로 본다.
 * fixture: tests/fixtures/ibd-gold/{종목코드}-{접수번호}.json — { name, industryCode, fsDiv, items(BS), xbrl, expected }
 */
import fs from "fs";
import path from "path";
import { computeIbdFromRaw } from "../src/services/valuation/asof-financials";
import { createFsRawStore } from "../src/services/valuation/raw-store-fs";
import { toCompactIbd } from "../src/services/opendart/ibd-engine";
import type { CorpusEntry } from "./ibd-corpus";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "scripts/_scratch/ibd-corpus");
const FIX = path.join(ROOT, "tests/fixtures/ibd-gold");

export interface GoldLabel {
  /** 금융업 등 정책상 산정 제외면 true */
  excluded?: boolean;
  total: number;
  current: number;
  nonCurrent: number;
  unclassified?: number;
  lease: number;
  byCategory?: Record<string, number>;
  debtLike?: [string, number, string][];
  confidence: "high" | "medium" | "low";
  /** 판정 근거·쟁점 요약 */
  basis?: string;
  /** 판정자가 확정(adjudicated)했는지 */
  adjudicated?: boolean;
}

const tolOf = (g: number) => Math.max(Math.abs(g) * 0.005, 1e8);
const near = (e: number, g: number) => Math.abs(e - g) <= tolOf(g);

function main() {
  const args = process.argv.slice(2);
  const asOf = args.find((a) => /^\d{8}$/.test(a)) ?? "20260630";
  const si = args.indexOf("--set");
  const set = si >= 0 ? args[si + 1] : null;
  const gold: Record<string, GoldLabel> = JSON.parse(fs.readFileSync(path.join(DIR, `gold-${asOf}.json`), "utf8"));
  const index: CorpusEntry[] = JSON.parse(fs.readFileSync(path.join(DIR, `${asOf}.index.json`), "utf8"));
  const byCode = new Map(index.map((e) => [e.code, e]));
  const sample = fs.existsSync(path.join(DIR, `sample-${asOf}.json`))
    ? (JSON.parse(fs.readFileSync(path.join(DIR, `sample-${asOf}.json`), "utf8")) as { tuning: { code: string; strata: string[] }[]; holdout: { code: string }[] })
    : { tuning: [], holdout: [] };
  const holdout = new Set(sample.holdout.map((x) => x.code));
  const strataOf = new Map(sample.tuning.map((t) => [t.code, t.strata]));
  const store = createFsRawStore();

  const out: Record<string, unknown>[] = [];
  let n = 0;
  const hit = { total: 0, debt: 0, lease: 0, sections: 0, excluded: 0 };
  for (const [code, g] of Object.entries(gold)) {
    if (set === "holdout" && !holdout.has(code)) continue;
    if (set === "tuning" && holdout.has(code)) continue;
    const en = byCode.get(code);
    const raw = en ? store.get(en.rceptNo) : null;
    if (!en || !raw) continue;
    const r = computeIbdFromRaw(raw, en.industryCode);
    const c = toCompactIbd(r);
    const lines = c ? [...c.current, ...c.nonCurrent, ...(c.unclassified ?? [])] : [];
    const lease = lines.filter((l) => l[2] === "lease").reduce((a, l) => a + l[1], 0);
    const cur = c ? c.current.reduce((a, l) => a + l[1], 0) : 0;
    const non = c ? c.nonCurrent.reduce((a, l) => a + l[1], 0) : 0;
    n += 1;
    const exOk = !!r.excluded === !!g.excluded;
    if (exOk) hit.excluded += 1;
    const ok = {
      total: exOk && (g.excluded || near(r.total, g.total)),
      debt: exOk && (g.excluded || near(r.total - lease, g.total - g.lease)),
      lease: exOk && (g.excluded || near(lease, g.lease)),
      sections: exOk && (g.excluded || (near(cur, g.current) && near(non, g.nonCurrent))),
    };
    for (const k of Object.keys(ok) as (keyof typeof ok)[]) if (ok[k]) hit[k] += 1;
    out.push({
      code,
      name: en.name,
      set: holdout.has(code) ? "holdout" : "tuning",
      strata: strataOf.get(code) ?? [],
      ok,
      engine: { excluded: r.excluded, total: r.total, lease, current: cur, nonCurrent: non, completeness: r.completeness, lines },
      gold: g,
      diff: r.total - g.total,
    });
    if (args.includes("--export-fixtures") && g.adjudicated !== false && g.confidence !== "low") {
      fs.mkdirSync(FIX, { recursive: true });
      fs.writeFileSync(
        path.join(FIX, `${code}-${en.rceptNo}.json`),
        JSON.stringify({
          name: en.name,
          industryCode: en.industryCode,
          report: en.reportName,
          fsDiv: raw.fsDiv,
          items: raw.items.filter((i) => i.sj_div === "BS"),
          xbrl: raw.xbrl ?? null,
          expected: { excluded: !!g.excluded, total: g.total, currentTotal: g.current, nonCurrentTotal: g.nonCurrent, lease: g.lease },
          basis: g.basis ?? "",
        }),
      );
    }
  }
  const pct = (k: keyof typeof hit) => `${hit[k]}/${n} (${n ? ((hit[k] / n) * 100).toFixed(1) : "-"}%)`;
  const summary = { asOf, set: set ?? "all", n, total: pct("total"), debtExLease: pct("debt"), lease: pct("lease"), sections: pct("sections"), excluded: pct("excluded") };
  fs.writeFileSync(path.join(DIR, `gold-compare-${asOf}${set ? "-" + set : ""}.json`), JSON.stringify({ summary, rows: out }, null, 1));
  console.log(JSON.stringify(summary, null, 2));
  const eok = (x: number) => `${(x / 1e8).toFixed(1)}억`;
  const bad = out.filter((o) => !(o.ok as { total: boolean }).total);
  console.log(`\n합계 불일치 ${bad.length}건:`);
  for (const o of bad as { code: string; name: string; engine: { total: number }; gold: GoldLabel; set: string }[])
    console.log(`  [${o.set}] ${o.code} ${o.name}: 엔진 ${eok(o.engine.total)} vs 정답 ${eok(o.gold.total)} — ${o.gold.basis?.slice(0, 120) ?? ""}`);
}

main();
