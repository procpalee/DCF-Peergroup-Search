/**
 * 이자부부채 엔진 v2 회귀 테스트.
 *
 *   npx tsx scripts/test-ibd-engine.ts            # 기대값 대조 (실패 시 종료코드 1)
 *   npx tsx scripts/test-ibd-engine.ts --dump     # 표본별 산정 내역 출력(기대값 작성·검토용)
 *
 * 원자료: tests/fixtures/ibd/*.json (scripts/fetch-ibd-fixtures.ts)
 * 기대값: tests/ibd-expected.json — { "{파일명}": { total?, excluded?, currentTotal?, nonCurrentTotal?,
 *          debtLike?, mustInclude?: string[], mustExclude?: string[] } }. 금액은 원 단위, ±0.5% 허용.
 */
import fs from "fs";
import path from "path";
import { applyXbrlSupplement, computeIbdV2 } from "../src/services/opendart/ibd-engine";
import { summarizeXbrlDebt, type XbrlFacts } from "../src/services/opendart/xbrl-debt-facts";
import type { DartFinancialItem } from "../src/services/opendart/types";

const ROOT = path.resolve(__dirname, "..");
const FIX = path.join(ROOT, "tests/fixtures/ibd");
const EXPECTED = path.join(ROOT, "tests/ibd-expected.json");
const industry: Record<string, { industryCode?: string; name?: string }> = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/company-industry.json"), "utf8"),
);

interface Expect {
  total?: number;
  excluded?: boolean;
  currentTotal?: number;
  nonCurrentTotal?: number;
  debtLike?: number;
  mustInclude?: string[];
  mustExclude?: string[];
  note?: string;
}

const dump = process.argv.includes("--dump");
const expected: Record<string, Expect> = fs.existsSync(EXPECTED)
  ? JSON.parse(fs.readFileSync(EXPECTED, "utf8"))
  : {};
const eok = (n: number) => `${(n / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억`;
const near = (a: number, b: number) => (b === 0 ? a === 0 : Math.abs(a - b) / Math.abs(b) <= 0.005);

let fail = 0;
let pass = 0;
for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith(".json") && !x.endsWith(".xbrl.json")).sort()) {
  const code = f.slice(0, 6);
  const items: DartFinancialItem[] = JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
  const ind = industry[code];
  const r = computeIbdV2(items, { industryCode: ind?.industryCode });
  // 주석 보충 — 수집 파이프라인과 같은 조건(포괄 금융부채 감지)에서만
  const xf = path.join(FIX, f.replace(/\.json$/, ".xbrl.json"));
  const agg = r.meta.aggregatedFinancialLiabilities;
  if ((agg.current || agg.nonCurrent) && fs.existsSync(xf)) {
    const facts = JSON.parse(fs.readFileSync(xf, "utf8")) as Record<string, XbrlFacts> | null;
    const scoped = facts && (Object.keys(facts.ConsolidatedMember ?? {}).length ? facts.ConsolidatedMember : facts.SeparateMember);
    if (scoped) applyXbrlSupplement(r, summarizeXbrlDebt(scoped));
  }
  const sum = (a: { amount: number }[]) => a.reduce((s, x) => s + x.amount, 0);

  if (dump) {
    console.log(`\n■ ${f} ${ind?.name ?? ""} [${ind?.industryCode ?? "-"}] fs=${r.meta.fsDiv} ${r.meta.periodLabel ?? ""}`);
    if (r.excluded) console.log(`  제외: ${r.excluded}`);
    for (const s of ["current", "nonCurrent", "unclassified"] as const)
      for (const l of r[s]) console.log(`  ${s.padEnd(12)} ${l.category.padEnd(10)} ${eok(l.amount).padStart(10)}  ${l.account}  (${l.accountId})`);
    for (const d of r.debtLike) console.log(`  debtLike     ${eok(d.amount).padStart(10)}  ${d.account} [${d.section}]`);
    console.log(`  합계 ${eok(r.total)} (유동 ${eok(sum(r.current))} / 비유동 ${eok(sum(r.nonCurrent))})`);
    for (const c of r.checks) console.log(`  ⚠ ${c}`);
    continue;
  }

  const e = expected[f];
  if (!e) continue;
  const errs: string[] = [];
  if (e.excluded !== undefined && !!r.excluded !== e.excluded) errs.push(`excluded ${!!r.excluded} ≠ ${e.excluded}`);
  if (e.total !== undefined && !near(r.total, e.total)) errs.push(`total ${eok(r.total)} ≠ ${eok(e.total)}`);
  if (e.currentTotal !== undefined && !near(sum(r.current), e.currentTotal))
    errs.push(`유동 ${eok(sum(r.current))} ≠ ${eok(e.currentTotal)}`);
  if (e.nonCurrentTotal !== undefined && !near(sum(r.nonCurrent), e.nonCurrentTotal))
    errs.push(`비유동 ${eok(sum(r.nonCurrent))} ≠ ${eok(e.nonCurrentTotal)}`);
  if (e.debtLike !== undefined && !near(sum(r.debtLike), e.debtLike)) errs.push(`부채성 ${eok(sum(r.debtLike))} ≠ ${eok(e.debtLike)}`);
  const names = [...r.current, ...r.nonCurrent, ...r.unclassified].map((l) => l.account);
  for (const m of e.mustInclude ?? []) if (!names.some((n) => n.includes(m))) errs.push(`'${m}' 누락`);
  for (const m of e.mustExclude ?? []) if (names.some((n) => n.includes(m))) errs.push(`'${m}' 포함됨`);
  if (errs.length) {
    fail += 1;
    console.log(`✗ ${f} ${ind?.name ?? ""}: ${errs.join("; ")}`);
  } else pass += 1;
}
if (!dump) {
  console.log(`\n이자부부채 엔진 회귀 테스트: ${pass} 통과, ${fail} 실패`);
  if (fail) process.exit(1);
}
