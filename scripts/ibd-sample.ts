/**
 * 이자부부채 독립 검증 표본 추출 — 조정용(tuning)과 최종 검증용(holdout)을 겹치지 않게 뽑는다.
 * 결정론: 종목코드 해시로 무작위 순서를 정한다(같은 입력이면 같은 표본).
 *
 *   npx tsx scripts/ibd-sample.ts 20260630
 *
 * 입력: scripts/_scratch/ibd-corpus/crosscheck-{기준일}.json (scripts/ibd-crosscheck.ts), data/valuation-cache/{기준일}.json(시가총액)
 * 출력: scripts/_scratch/ibd-corpus/sample-{기준일}.json — { tuning: [{code, strata[]}], holdout: [{code}] }
 *       scripts/_scratch/ibd-corpus/sample-{기준일}.codes.txt — 주석 원문을 받을 종목(조정용+보류)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { CrossRow } from "./ibd-crosscheck";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "scripts/_scratch/ibd-corpus");
const SALT = "ibd-v2.2-audit-2026-09-30";

const h = (code: string, salt = SALT) => crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");

function main() {
  const asOf = process.argv.slice(2).find((a) => /^\d{8}$/.test(a)) ?? "20260630";
  const { rows } = JSON.parse(fs.readFileSync(path.join(DIR, `crosscheck-${asOf}.json`), "utf8")) as { rows: CrossRow[] };
  const cache: Record<string, { marketCap?: { total?: number | null } }> = JSON.parse(
    fs.readFileSync(path.join(ROOT, `data/valuation-cache/${asOf}.json`), "utf8"),
  );
  const pool = rows.filter((r) => !r.excluded);
  const shuffled = [...pool].sort((a, b) => h(a.code).localeCompare(h(b.code)));

  // 보류 표본을 먼저 떼어 둔다 — 조정 과정에서 절대 보지 않는다
  const holdout = shuffled.slice(0, 60);
  const held = new Set(holdout.map((r) => r.code));
  const rest = shuffled.filter((r) => !held.has(r.code));

  const tags = new Map<string, Set<string>>();
  const tag = (r: CrossRow, t: string) => {
    if (held.has(r.code)) return;
    if (!tags.has(r.code)) tags.set(r.code, new Set());
    tags.get(r.code)!.add(t);
  };
  const take = (list: CrossRow[], n: number, t: string) => list.filter((r) => !held.has(r.code)).slice(0, n).forEach((r) => tag(r, t));

  take(rest, 120, "random");
  take([...pool].sort((a, b) => (cache[b.code]?.marketCap?.total ?? 0) - (cache[a.code]?.marketCap?.total ?? 0)), 40, "largeCap");
  // 경고 유형별 최대 4건
  const byType = new Map<string, CrossRow[]>();
  for (const r of rest)
    for (const c of r.checks) {
      const k = c.replace(/[\d.,%()억조\-−]+/g, "").slice(0, 30);
      if (!byType.has(k)) byType.set(k, []);
      byType.get(k)!.push(r);
    }
  for (const [k, list] of byType) take(list, 4, `check:${k}`);
  take(rest.filter((r) => r.completeness === "partial"), 15, "partial");
  take(rest.filter((r) => r.debtStatus === "under").sort((a, b) => Math.abs(b.debtDiff ?? 0) - Math.abs(a.debtDiff ?? 0)), 20, "noteUnder");
  take(rest.filter((r) => r.debtStatus === "over").sort((a, b) => Math.abs(b.debtDiff ?? 0) - Math.abs(a.debtDiff ?? 0)), 10, "noteOver");
  const hasCat = (r: CrossRow, c: string) => r.lines.some((l) => l[2] === c);
  take(rest.filter((r) => r.xbrlSupplemented), 10, "supplemented");
  take(rest.filter((r) => r.debtLike.length), 8, "debtLike");
  take(rest.filter((r) => hasCat(r, "convertible")), 8, "convertible");
  take(rest.filter((r) => hasCat(r, "borrowingsAndBonds")), 8, "borrowingsAndBonds");
  take(rest.filter((r) => hasCat(r, "otherDebt")), 8, "otherDebt");
  take(rest.filter((r) => r.dedupeRemoved > 0), 10, "dedupe");
  take(rest.filter((r) => r.industryCode?.startsWith("64992")), 8, "holding");
  take(rest.filter((r) => r.total === 0 && (r.totalLiabilities ?? 0) > 1e11), 10, "zeroIbdLargeLiab");
  take(rest.filter((r) => r.unclassifiedBs), 5, "unclassifiedBs");
  take(rest.filter((r) => r.financialSegment), 5, "financialSegment");
  take(rest.filter((r) => r.lines.length && r.lines.every((l) => l[2] === "lease")), 6, "leaseOnly");

  const tuning = [...tags].map(([code, t]) => ({ code, strata: [...t] }));
  fs.writeFileSync(path.join(DIR, `sample-${asOf}.json`), JSON.stringify({ salt: SALT, tuning, holdout: holdout.map((r) => ({ code: r.code })) }, null, 1));
  fs.writeFileSync(path.join(DIR, `sample-${asOf}.codes.txt`), [...tuning.map((t) => t.code), ...holdout.map((r) => r.code)].join("\n") + "\n");
  const count: Record<string, number> = {};
  for (const t of tuning) for (const s of t.strata) count[s.split(":")[0]] = (count[s.split(":")[0]] ?? 0) + 1;
  console.log(`조정용 ${tuning.length}종목, 보류 ${holdout.length}종목`);
  console.log(count);
}

main();
