/**
 * 이자부부채 전수 대조 — 엔진 결과(재무상태표 본문 기준)를 XBRL 주석의 차입금·리스 총계와 맞춰 본다.
 * 네트워크 없음: scripts/ibd-corpus.ts 가 채운 원자료(_shared/raw)만 쓴다. 엔진을 고칠 때마다 다시 돌린다.
 *
 *   npx tsx scripts/ibd-crosscheck.ts 20260630                # 요약 출력 + 결과 파일
 *   npx tsx scripts/ibd-crosscheck.ts 20260630 --tag v2.2     # 결과 파일 이름에 꼬리표
 *
 * 비교 기준(주석):
 *   차입성 = Borrowings → (유동+비유동 포괄/세부 합산) → LoansReceived+BondsIssued
 *   리스   = LeaseLiabilities → CurrentLeaseLiabilities+NoncurrentLeaseLiabilities
 * 엔진 차입성 = 차입금+사채(+기타 차입성 부채 포함/제외 둘 다 비교), 엔진 리스 = 리스부채.
 * 일치 = 차이 1% 이내 또는 1억 원 이내.
 *
 * 출력: scripts/_scratch/ibd-corpus/crosscheck-{기준일}[-{꼬리표}].json
 */
import fs from "fs";
import path from "path";
import { computeIbdFromRaw } from "../src/services/valuation/asof-financials";
import { createFsRawStore } from "../src/services/valuation/raw-store-fs";
import { toCompactIbd } from "../src/services/opendart/ibd-engine";
import { summarizeXbrlDebt } from "../src/services/opendart/xbrl-debt-facts";
import type { CorpusEntry } from "./ibd-corpus";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "scripts/_scratch/ibd-corpus");

type Status = "match" | "over" | "under" | "noNote" | "zeroBoth";

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.01, 1e8);
function cmp(engine: number, note: number | null): Status {
  if (note == null) return engine === 0 ? "zeroBoth" : "noNote";
  if (close(engine, note)) return engine === 0 && note === 0 ? "zeroBoth" : "match";
  return engine > note ? "over" : "under";
}

export interface CrossRow {
  code: string;
  name: string;
  rceptNo: string;
  report: string;
  fs: string;
  excluded: string | null;
  total: number;
  engine: { debt: number; debtExOther: number; lease: number; otherDebt: number };
  note: { debt: number | null; debtSource: string | null; lease: number | null; facts: Record<string, number> } | null;
  debtStatus: Status;
  leaseStatus: Status;
  xbrlSupplemented: boolean;
  industryCode: string;
  completeness: "full" | "partial";
  dedupeRemoved: number;
  financialSegment: boolean;
  totalLiabilities: number | null;
  unclassifiedBs: boolean;
  debtLike: [string, number, string][];
  checks: string[];
  lines: [string, number, string][];
  /** 엔진 차입성 − 주석 차입성(원) */
  debtDiff: number | null;
}

function main() {
  const asOf = process.argv.slice(2).find((a) => /^\d{8}$/.test(a)) ?? "20260630";
  const ti = process.argv.indexOf("--tag");
  const tag = ti >= 0 ? `-${process.argv[ti + 1]}` : "";
  const entries: CorpusEntry[] = JSON.parse(fs.readFileSync(path.join(DIR, `${asOf}.index.json`), "utf8"));
  const store = createFsRawStore();
  const rows: CrossRow[] = [];
  let noRaw = 0;
  for (const en of entries) {
    const raw = store.get(en.rceptNo);
    if (!raw) {
      noRaw += 1;
      continue;
    }
    const r = computeIbdFromRaw(raw, en.industryCode);
    const c = toCompactIbd(r);
    const lines = c ? [...c.current, ...c.nonCurrent, ...(c.unclassified ?? [])] : [];
    const sumCat = (k: string) => lines.filter((l) => l[2] === k).reduce((s, l) => s + l[1], 0);
    const core = sumCat("borrowings") + sumCat("bonds") + sumCat("convertible") + sumCat("borrowingsAndBonds");
    const eng = {
      debt: core + sumCat("otherDebt"),
      debtExOther: core,
      lease: sumCat("lease"),
      otherDebt: sumCat("otherDebt"),
    };
    let note: CrossRow["note"] = null;
    if (raw.xbrl) {
      const f = raw.xbrl.facts;
      const s = summarizeXbrlDebt(f);
      let debt: number | null = null;
      let src: string | null = null;
      if (f.Borrowings != null) [debt, src] = [f.Borrowings, "Borrowings"];
      else if (s.current != null && s.nonCurrent != null) [debt, src] = [s.current + s.nonCurrent, "유동+비유동"];
      else if (s.total != null) [debt, src] = [s.total, "LoansReceived+BondsIssued"];
      else if (s.current != null || s.nonCurrent != null) [debt, src] = [(s.current ?? 0) + (s.nonCurrent ?? 0), "유동 또는 비유동만"];
      const lease =
        f.LeaseLiabilities ??
        (f.CurrentLeaseLiabilities != null || f.NoncurrentLeaseLiabilities != null
          ? (f.CurrentLeaseLiabilities ?? 0) + (f.NoncurrentLeaseLiabilities ?? 0)
          : null);
      note = { debt, debtSource: src, lease, facts: f };
    }
    let debtStatus: Status = r.excluded ? "zeroBoth" : cmp(eng.debt, note?.debt ?? null);
    // 주석 차입성에 유동화채무 등이 빠져 있을 수 있어 제외한 쪽도 본다
    if (!r.excluded && (debtStatus === "over" || debtStatus === "under") && note?.debt != null && close(eng.debtExOther, note.debt))
      debtStatus = "match";
    const leaseStatus: Status = r.excluded ? "zeroBoth" : cmp(eng.lease, note?.lease ?? null);
    rows.push({
      code: en.code,
      name: en.name,
      rceptNo: en.rceptNo,
      report: en.reportName,
      fs: raw.fsDiv,
      excluded: r.excluded,
      total: r.total,
      engine: eng,
      note,
      debtStatus,
      leaseStatus,
      xbrlSupplemented: r.meta.xbrlSupplemented,
      industryCode: en.industryCode,
      completeness: r.completeness,
      dedupeRemoved: r.meta.dedupeRemoved.length,
      financialSegment: !!r.meta.financialSegment,
      totalLiabilities: r.meta.totalLiabilities,
      unclassifiedBs: r.unclassified.length > 0 || r.checks.some((c) => c.includes("유동/비유동 구분이 없는")),
      debtLike: r.debtLike.map((d) => [d.account, d.amount, d.type] as [string, number, string]),
      checks: r.checks,
      lines,
      debtDiff: note?.debt != null ? eng.debt - note.debt : null,
    });
  }

  const count = (k: "debtStatus" | "leaseStatus") =>
    rows.filter((r) => !r.excluded).reduce<Record<string, number>>((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  const withNote = rows.filter((r) => !r.excluded && r.note?.debt != null);
  const summary = {
    asOf,
    corpus: entries.length,
    noRaw,
    evaluated: rows.length,
    excluded: rows.filter((r) => r.excluded).length,
    xbrlMissing: rows.filter((r) => !r.excluded && !r.note).length,
    debt: count("debtStatus"),
    lease: count("leaseStatus"),
    debtMatchRateWhereNote: withNote.length
      ? Number((withNote.filter((r) => r.debtStatus === "match").length / withNote.length).toFixed(4))
      : null,
    engineChecks: rows.filter((r) => !r.excluded && r.checks.length).length,
    partial: rows.filter((r) => !r.excluded && r.completeness === "partial").length,
  };
  fs.writeFileSync(path.join(DIR, `crosscheck-${asOf}${tag}.json`), JSON.stringify({ summary, rows }));
  console.log(JSON.stringify(summary, null, 2));
  const eok = (n: number) => `${(n / 1e8).toFixed(0)}억`;
  const worst = rows
    .filter((r) => r.debtStatus === "over" || r.debtStatus === "under")
    .sort((a, b) => Math.abs(b.debtDiff ?? 0) - Math.abs(a.debtDiff ?? 0))
    .slice(0, 15);
  console.log("\n차입성 불일치 상위 15:");
  for (const r of worst)
    console.log(`  ${r.code} ${r.name} ${r.debtStatus} 엔진 ${eok(r.engine.debt)} vs 주석 ${eok(r.note!.debt!)} (${r.note!.debtSource})`);
}

main();
