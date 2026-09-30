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
import { applyXbrlSupplement, computeIbdV2, toCompactIbd, guessCategoryByName, normalizeCompactIbd, needsXbrlNotes } from "../src/services/opendart/ibd-engine";
import { computeIbdFromRaw, type RawReport } from "../src/services/valuation/asof-financials";
import { summarizeXbrlDebt, parseXbrlInstantFactSets, REPORTED_AMOUNT_SUFFIX, type XbrlFacts } from "../src/services/opendart/xbrl-debt-facts";
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

// ─── 합성 사례(행 단위 규칙) — 2026-09-30 오프라인 점검 R2·R4·R5·R6·R8·R9 ───
type SynRow = [string, string, string]; // [계정명, 계정ID, 금액]
const mk = (cur: SynRow[], non: SynRow[], totals: [number, number]): DartFinancialItem[] => {
  let ord = 0;
  const row = (nm: string, id: string, amt: string) =>
    ({
      rcept_no: "SYN", bsns_year: "2025", reprt_code: "11011", account_id: id, account_nm: nm, fs_div: "CFS", fs_nm: "",
      sj_div: "BS", sj_nm: "", thstrm_nm: "", thstrm_dt: "", thstrm_amount: amt, frmtrm_nm: "", frmtrm_amount: "", ord: String(++ord),
    }) as DartFinancialItem;
  return [
    row("유동부채", "ifrs-full_CurrentLiabilities", String(totals[0])),
    ...cur.map((r) => row(...r)),
    row("비유동부채", "ifrs-full_NoncurrentLiabilities", String(totals[1])),
    ...non.map((r) => row(...r)),
    row("부채총계", "ifrs-full_Liabilities", String(totals[0] + totals[1])),
  ];
};
const NS = "-표준계정코드 미사용-";
const lineList = (r: ReturnType<typeof computeIbdV2>) => JSON.stringify([...r.current, ...r.nonCurrent, ...r.unclassified].map((l) => [l.account, l.amount]));
const synthetic: { name: string; run: () => string | null }[] = [
  {
    name: "R6 전환사채파생상품부채 → 부채성(convDerivative), 사채상환손실충당부채·관계회사채무 → 제외",
    run: () => {
      const r = computeIbdV2(mk([["단기차입금", "ifrs-full_ShorttermBorrowings", "100"], ["전환사채파생상품부채", NS, "30"], ["사채상환손실충당부채", NS, "20"], ["관계회사채무", NS, "40"]], [], [190, 0]));
      if (r.total !== 100) return `total ${r.total} ≠ 100 ${lineList(r)}`;
      if (r.debtLike[0]?.type !== "convDerivative") return `debtLike ${JSON.stringify(r.debtLike)}`;
      return null;
    },
  },
  {
    name: "R8 정상 음수 행('장기차입금 유동성대체 −30')은 부호 보정하지 않음",
    run: () => {
      const r = computeIbdV2(mk([], [["장기차입금", "ifrs-full_LongtermBorrowings", "100"], ["장기차입금 유동성대체", NS, "-30"]], [0, 70]));
      return r.total === 70 ? null : `total ${r.total} ≠ 70`;
    },
  },
  {
    name: "R8 소계가 뒷받침하는 음수 차입 행은 부호 보정",
    run: () => {
      const r = computeIbdV2(mk([["단기차입금", "ifrs-full_ShorttermBorrowings", "-50"], ["매입채무", "ifrs-full_TradeAndOtherCurrentPayables", "100"]], [], [150, 0]));
      return r.total === 50 ? null : `total ${r.total} ≠ 50`;
    },
  },
  {
    name: "R4 주석 총계 폴백 — 유동 CB 100억 + 비유동 금융부채 300억 + 주석 LoansReceived 200억 → 300억",
    run: () => {
      const r = computeIbdV2(mk([["전환사채", "dart_ConvertibleBonds", "10000000000"]], [["금융부채", NS, "30000000000"]], [1e10, 3e10]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ LoansReceived: 2e10 }));
      return r.total === 3e10 ? null : `total ${r.total} ≠ 3e10 ${lineList(r)}`;
    },
  },
  {
    name: "R4 주석 총계가 본문 차입금과 같으면 보충 생략",
    run: () => {
      const r = computeIbdV2(mk([["단기차입금", "ifrs-full_ShorttermBorrowings", "200"]], [["금융부채", NS, "300"]], [200, 300]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ Borrowings: 200 }));
      return r.total === 200 ? null : `total ${r.total} ≠ 200 ${lineList(r)}`;
    },
  },
  {
    name: "R5 주석 차입금이 구역 부채 소계를 넘으면 보충 보류 + partial",
    run: () => {
      const r = computeIbdV2(mk([], [["금융부채", NS, "300"]], [0, 300]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ NoncurrentPortionOfNoncurrentLoansReceived: 5000 }));
      return r.total === 0 && r.completeness === "partial" ? null : `total ${r.total}, completeness ${r.completeness}`;
    },
  },
  {
    name: "R9 사채 본계정 없는 전환권조정은 제외 + partial",
    run: () => {
      const r = computeIbdV2(mk([["전환권조정", NS, "-10"], ["단기차입금", "ifrs-full_ShorttermBorrowings", "100"]], [], [90, 0]));
      return r.total === 100 && r.completeness === "partial" ? null : `total ${r.total}, completeness ${r.completeness}`;
    },
  },
  {
    name: "R2 포괄 행 — 소계 초과 없으면(우연 일치) 제거하지 않음",
    run: () => {
      const r = computeIbdV2(mk([["신주인수권부사채", "dart_BondsWithWarrant", "92"], ["전환사채", "dart_ConvertibleBonds", "92"]], [], [184, 0]));
      return r.total === 184 ? null : `total ${r.total} ≠ 184`;
    },
  },
  {
    name: "R2 포괄 행 — 초과분 + 정확 일치 + 포괄형 이름이면 제거",
    run: () => {
      const r = computeIbdV2(mk([["차입금및사채", NS, "150"], ["단기차입금", "ifrs-full_ShorttermBorrowings", "100"], ["사채", "ifrs-full_BondsIssued", "50"]], [], [150, 0]));
      return r.total === 150 && r.meta.dedupeRemoved.length === 1 ? null : `total ${r.total}, removed ${JSON.stringify(r.meta.dedupeRemoved)}`;
    },
  },
];
// ─── 독립 검증 정답 표본(tests/fixtures/ibd-gold — scripts/ibd-gold.ts --export-fixtures) ───
const GOLD = path.join(ROOT, "tests/fixtures/ibd-gold");
const nearGold = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 1e8);
if (!dump && fs.existsSync(GOLD))
  for (const f of fs.readdirSync(GOLD).filter((x) => x.endsWith(".json")).sort()) {
    const g = JSON.parse(fs.readFileSync(path.join(GOLD, f), "utf8")) as {
      name: string;
      industryCode: string;
      items: DartFinancialItem[];
      xbrl: { facts: XbrlFacts; factsRpt?: XbrlFacts } | null;
      expected: { excluded: boolean; total: number; currentTotal: number; nonCurrentTotal: number; lease: number };
    };
    const r = computeIbdV2(g.items, { industryCode: g.industryCode });
    if (needsXbrlNotes(r) && g.xbrl) applyXbrlSupplement(r, summarizeXbrlDebt(g.xbrl.facts, g.xbrl.factsRpt));
    const sum = (a: { amount: number }[]) => a.reduce((s, x) => s + x.amount, 0);
    const lease = [...r.current, ...r.nonCurrent, ...r.unclassified].filter((l) => l.category === "lease").reduce((s, l) => s + l.amount, 0);
    const errs: string[] = [];
    if (!!r.excluded !== g.expected.excluded) errs.push(`excluded ${!!r.excluded} ≠ ${g.expected.excluded}`);
    else if (!g.expected.excluded) {
      if (!nearGold(r.total, g.expected.total)) errs.push(`total ${eok(r.total)} ≠ ${eok(g.expected.total)}`);
      if (!nearGold(lease, g.expected.lease)) errs.push(`리스 ${eok(lease)} ≠ ${eok(g.expected.lease)}`);
      if (!nearGold(sum(r.current), g.expected.currentTotal)) errs.push(`유동 ${eok(sum(r.current))} ≠ ${eok(g.expected.currentTotal)}`);
    }
    if (errs.length) {
      fail += 1;
      console.log(`✗ 정답 ${f} ${g.name}: ${errs.join("; ")}`);
    } else pass += 1;
  }

// ─── 합성 사례 2 — 2026-09-30 구현 독립 검증(W07~W30, S01~S21) 재현 입력 ───
/** 머리 행 금액을 문자열로(빈 소계 등), 부채총계 지정, 미구분 BS(머리 행 없음) 지원 */
const mk2 = (cur: SynRow[] | null, non: SynRow[], totals: [string, string] | null, tl: string, extra: SynRow[] = []): DartFinancialItem[] => {
  let ord = 0;
  const row = (nm: string, id: string, amt: string) =>
    ({
      rcept_no: "SYN", bsns_year: "2025", reprt_code: "11011", account_id: id, account_nm: nm, fs_div: "CFS", fs_nm: "",
      sj_div: "BS", sj_nm: "", thstrm_nm: "", thstrm_dt: "", thstrm_amount: amt, frmtrm_nm: "", frmtrm_amount: "", ord: String(++ord),
    }) as DartFinancialItem;
  const out: DartFinancialItem[] = [];
  if (cur && totals) out.push(row("유동부채", "ifrs-full_CurrentLiabilities", totals[0]), ...cur.map((r) => row(...r)));
  if (totals) out.push(row("비유동부채", "ifrs-full_NoncurrentLiabilities", totals[1]));
  out.push(...non.map((r) => row(...r)), row("부채총계", "ifrs-full_Liabilities", tl), ...extra.map((r) => row(...r)));
  return out;
};
const cats = (r: ReturnType<typeof computeIbdV2>) => {
  const c = toCompactIbd(r);
  const m: Record<string, number> = {};
  for (const t of c ? [...c.current, ...c.nonCurrent, ...(c.unclassified ?? [])] : []) m[t[2]] = (m[t[2]] ?? 0) + t[1];
  return m;
};
const has = (arr: string[], s: string) => arr.some((c) => c.includes(s));
const expect = (cond: boolean, msg: string) => (cond ? null : msg);
const run = (cur: SynRow[], non: SynRow[], t: [number, number]) => computeIbdV2(mk(cur, non, t));
const B = (n: number) => String(n);
const SB = "ifrs-full_ShorttermBorrowings";
const LB = "ifrs-full_LongtermBorrowings";
const rawOf = (items: DartFinancialItem[], xbrl: RawReport["xbrl"], v: 1 | 2 = 2): RawReport => ({ v, rceptNoReturned: "SYN", bsnsYear: "2025", fsDiv: "CFS", items, ...(xbrl !== undefined ? { xbrl } : {}) });
synthetic.push(
  {
    name: "W07 마지막 행 동액(BW=CB) — 공허 참 블록으로 제거하지 않음",
    run: () => {
      const r = run([["기타채무", NS, "20000000000"], ["미지급금", NS, "12000000000"], ["미지급비용", NS, "8000000000"], ["전환사채", "dart_ConvertibleBonds", "9220000000"], ["매입채무", NS, "5000000000"], ["신주인수권부사채", "dart_BondsWithWarrant", "9220000000"]], [], [43440000000, 0]);
      return expect(r.total === 18440000000 && r.meta.dedupeRemoved.length === 0, `total ${r.total}, removed ${r.meta.dedupeRemoved.length}`);
    },
  },
  {
    name: "S01 비차입 부모가 있는 구역의 BW=CB 인접 — 제거 0건",
    run: () => {
      const r = run([["기타채무", NS, "20000000000"], ["미지급금", NS, "12000000000"], ["미지급비용", NS, "8000000000"], ["신주인수권부사채", "dart_BondsWithWarrant", "9220000000"], ["전환사채", "dart_ConvertibleBonds", "9220000000"]], [], [38440000000, 0]);
      return expect(r.total === 18440000000 && r.meta.dedupeRemoved.length === 0, `total ${r.total}, removed ${JSON.stringify(r.meta.dedupeRemoved)}`);
    },
  },
  {
    name: "W08 포괄 행 두 개 — 둘 다 제거(반복 중 1% 재게이트 없음)",
    run: () => {
      const r = run([["차입금및사채", NS, B(1e11)], ["단기차입금", SB, B(6e10)], ["사채", "ifrs-full_BondsIssued", B(4e10)], ["유동성장기부채", NS, B(5e9)], ["유동성장기차입금", "ifrs-full_CurrentPortionOfLongtermBorrowings", B(3e9)], ["유동성사채", "ifrs-full_CurrentPortionOfBondsIssued", B(2e9)], ["매입채무", NS, B(9e11)]], [], [1.005e12, 0]);
      return expect(r.total === 1.05e11 && r.meta.dedupeRemoved.length === 2, `total ${r.total}, removed ${JSON.stringify(r.meta.dedupeRemoved.map((d) => d.account))}`);
    },
  },
  {
    name: "W10 경방형 — 구역 할인차금 합계가 본계정 50% 초과면 전부 제외",
    run: () => {
      const r = run([], [["장기차입금", LB, "15000000000"], ["장기임대보증금", NS, "50000000000"], ["현재가치할인차금", NS, "-14004000000"], ["현재가치할인차금", NS, "-5988000000"]], [0, 45008000000]);
      return expect(r.total === 15000000000 && r.checks.filter((c) => c.includes("본계정 확인 불가")).length === 2, `total ${r.total}, checks ${r.checks.join(" | ")}`);
    },
  },
  {
    name: "W10 49.3%형 — 합계가 50% 이내면 둘 다 채택",
    run: () => {
      const r = run([], [["장기차입금", LB, "50000000000"], ["현재가치할인차금", NS, "-17281000000"], ["현재가치할인차금", NS, "-7362000000"]], [0, 25357000000]);
      return expect(r.total === 25357000000, `total ${r.total}`);
    },
  },
  {
    name: "W11 부호 보정은 행 순서와 무관(장기차입금만 뒤집힘)",
    run: () => {
      const a = run([], [["사채", "ifrs-full_BondsIssued", "-3200000000"], ["장기차입금", LB, "-3000000000"], ["장기매입채무", NS, "500000000000"]], [0, 499800000000]);
      const b = run([], [["장기차입금", LB, "-3000000000"], ["사채", "ifrs-full_BondsIssued", "-3200000000"], ["장기매입채무", NS, "500000000000"]], [0, 499800000000]);
      return expect(a.total === -200000000 && b.total === -200000000 && a.completeness === "partial", `a ${a.total} b ${b.total} ${a.completeness}`);
    },
  },
  {
    name: "W12 상환할증금만 있는 사채 차감계정 — 본계정 없음으로 제외",
    run: () => {
      const r = run([["사채상환할증금", NS, "5000000000"], ["단기차입금", SB, "10000000000"], ["전환권조정", NS, "-3000000000"]], [], [12000000000, 0]);
      return expect(r.total === 15000000000 && r.completeness === "partial" && has(r.checks, "사채 본계정 없음"), `total ${r.total} ${r.completeness}`);
    },
  },
  {
    name: "W13 주석 분할은 포괄 요소 합계 유지(비례 배분)",
    run: () => {
      const r = computeIbdV2(mk([], [["금융부채", NS, "100000000000"]], [0, 100000000000]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ NoncurrentPortionOfNoncurrentBorrowings: 1e11, NoncurrentPortionOfNoncurrentLoansReceived: 9e10, NoncurrentPortionOfNoncurrentBondsIssued: 9.5e9 }));
      return expect(r.total === 1e11 && cats(r).borrowings === 90452261307, `total ${r.total} ${JSON.stringify(cats(r))}`);
    },
  },
  {
    name: "W14 '관계회사채무'는 사채 아님(ID·이름 경로), '사채 무보증'은 사채",
    run: () => {
      const a = run([["관계회사채무", SB, "10000000000"]], [], [1e10, 0]);
      const b = run([["관계회사채무및단기차입금", SB, "10000000000"]], [], [1e10, 0]);
      const c = run([["관계회사채무", SB, "10000000000"], ["사채할인발행차금", NS, "-500000000"]], [], [9.5e9, 0]);
      const d = run([["관계회사채무(유동)", NS, "4000000000"], ["단기차입금", SB, "10000000000"]], [], [1.4e10, 0]);
      const e = run([["사채 무보증", NS, "10000000000"]], [], [1e10, 0]);
      return (
        expect(cats(a).borrowings === 1e10, `a ${JSON.stringify(cats(a))}`) ??
        expect(cats(b).borrowings === 1e10, `b ${JSON.stringify(cats(b))}`) ??
        expect(c.total === 1e10 && c.completeness === "partial", `c ${c.total} ${c.completeness}`) ??
        expect(d.total === 1e10, `d ${d.total}`) ??
        expect(cats(e).bonds === 1e10, `e ${JSON.stringify(cats(e))}`)
      );
    },
  },
  {
    name: "W17 스스로 부모인 형제를 자식으로 오인하지 않음(차입금 제거, 사채 유지)",
    run: () => {
      const r = run([["사채", "ifrs-full_BondsIssued", "20000000000"], ["차입금", NS, "20000000000"], ["유동성장기부채", "ifrs-full_CurrentPortionOfLongtermBorrowings", "10000000000"], ["단기차입금", SB, "10000000000"]], [], [40000000000, 0]);
      return expect(r.meta.dedupeRemoved[0]?.account === "차입금" && r.total === 4e10 && cats(r).bonds === 2e10, `removed ${JSON.stringify(r.meta.dedupeRemoved)} ${JSON.stringify(cats(r))}`);
    },
  },
  {
    name: "W18 보충 보류면 '찾지 못함' 없음, 사유 1건",
    run: () => {
      const r = computeIbdV2(mk([], [["금융부채", NS, "300"]], [0, 300]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ NoncurrentPortionOfNoncurrentLoansReceived: 5000 }));
      return expect(!has(r.checks, "찾지 못함") && r.completenessReasons.length === 1 && r.meta.xbrlStatus === "held", `${r.checks.join(" | ")} / ${r.completenessReasons} / ${r.meta.xbrlStatus}`);
    },
  },
  {
    name: "W19 보충 뒤 합계가 양수면 '합계 음수' 사유 제거",
    run: () => {
      const r = computeIbdV2(mk([["단기차입금", SB, "-5000000000"], ["매입채무", NS, "10000000000"]], [["금융부채", NS, "30000000000"]], [5000000000, 30000000000]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ NoncurrentPortionOfNoncurrentBorrowings: 2e10 }));
      return expect(r.total === 1.5e10 && r.completeness === "full", `total ${r.total} ${r.completeness} ${r.completenessReasons}`);
    },
  },
  {
    name: "W20 주석 XBRL 상태 분류(문맥 없음·없음·미확보·오류·보류·리스만·요소 없음)",
    run: () => {
      const items = mk([], [["금융부채", NS, "300"]], [0, 300]);
      const st = (raw: RawReport, failed = false) => computeIbdFromRaw(raw, null, { xbrlFetchFailed: failed });
      const sc = { scope: "ConsolidatedMember" as const };
      const got = [
        st(rawOf(items, { ...sc, facts: {} })).meta.xbrlStatus,
        st(rawOf(items, null)).meta.xbrlStatus,
        st(rawOf(items, null, 1)).meta.xbrlStatus,
        st(rawOf(items, undefined), true).meta.xbrlStatus,
        st(rawOf(items, { ...sc, facts: { NoncurrentPortionOfNoncurrentLoansReceived: 5000 } })).meta.xbrlStatus,
        st(rawOf(items, { ...sc, facts: { NoncurrentLeaseLiabilities: 50 } })).meta.xbrlStatus,
        st(rawOf(items, { ...sc, facts: { Liabilities: 300 } })).meta.xbrlStatus,
      ];
      const want = ["context_not_found", "xml_absent", "not_fetched", "xml_error", "held", "lease_only", "no_debt_elements"];
      return expect(JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
    },
  },
  {
    name: "W21 리스 할인차금은 리스에 귀속(이름 우선)",
    run: () => {
      const r = run([], [["장기차입금", LB, "100000000000"], ["리스부채", "ifrs-full_NoncurrentLeaseLiabilities", "10000000000"], ["리스부채현재가치할인차금", NS, "-1000000000"]], [0, 109000000000]);
      return expect(cats(r).lease === 9e9 && cats(r).borrowings === 1e11, JSON.stringify(cats(r)));
    },
  },
  {
    name: "W22 전환사채할인발행차금은 전환사채에 귀속",
    run: () => {
      const r = run([], [["사채", "ifrs-full_BondsIssued", "10000000000"], ["전환사채", "dart_ConvertibleBonds", "5000000000"], ["전환사채할인발행차금", NS, "-500000000"]], [0, 14500000000]);
      return expect(cats(r).bonds === 1e10 && cats(r).convertible === 4.5e9, JSON.stringify(cats(r)));
    },
  },
  {
    name: "W23 사채 차감 초과분 버림은 행 순서와 무관",
    run: () => {
      const rows: SynRow[] = [["사채", "ifrs-full_BondsIssued", "5000000000"], ["전환사채", "dart_ConvertibleBonds", "3000000000"], ["사채할인발행차금", NS, "-5000000000"], ["전환권조정", NS, "-5000000000"]];
      const a = cats(run(rows, [], [-2e9, 0]));
      const b = cats(run([...rows].reverse(), [], [-2e9, 0]));
      const same = Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
      return expect(same && a.bonds === 2e9 && a.convertible === -2e9, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    },
  },
  {
    name: "W24 리스 포함 전환사채 행은 전환사채 범주(ID·이름·추정 모두)",
    run: () => {
      const a = run([], [["리스부채를 포함한 전환사채", NS, "1000000000"]], [0, 1e9]);
      const b = run([], [["리스부채를 포함한 전환사채", "ifrs-full_NoncurrentLeaseLiabilities", "1000000000"]], [0, 1e9]);
      return expect(cats(a).convertible === 1e9 && cats(b).convertible === 1e9 && guessCategoryByName("리스부채를 포함한 전환사채") === "convertible", `${JSON.stringify(cats(a))} ${JSON.stringify(cats(b))}`);
    },
  },
  {
    name: "W25 총계 폴백을 LoansReceived·BondsIssued 로 분할",
    run: () => {
      const r = computeIbdV2(mk([["매입채무", NS, "10000000000"]], [["금융부채", NS, "200000000000"]], [1e10, 2e11]));
      applyXbrlSupplement(r, summarizeXbrlDebt({ LoansReceived: 1.2e11, BondsIssued: 3e10 }));
      const r2 = computeIbdV2(mk([["매입채무", NS, "10000000000"]], [["금융부채", NS, "200000000000"]], [1e10, 2e11]));
      applyXbrlSupplement(r2, summarizeXbrlDebt({ LoansReceived: 1.2e11 }));
      return expect(cats(r).borrowings === 1.2e11 && cats(r).bonds === 3e10 && cats(r2).borrowings === 1.2e11 && r.unclassified.length === 2, `${JSON.stringify(cats(r))} ${JSON.stringify(cats(r2))}`);
    },
  },
  {
    name: "W26 3-튜플 캐시의 2-튜플 debtLike 에도 유형 추정",
    run: () => {
      const n = normalizeCompactIbd({ total: 1, current: [["단기차입금", 1, "borrowings"]], nonCurrent: [], debtLike: [["상환전환우선주부채", 5]] });
      return expect(n?.debtLike?.[0][2] === "rcps", JSON.stringify(n?.debtLike));
    },
  },
  {
    name: "W27 매각예정 자산에 자본 구역 OCI 를 넣지 않음",
    run: () => {
      const r = computeIbdV2(mk2([], [["장기차입금", LB, "1000000000"]], ["0", "1000000000"], "1000000000", [
        ["매각예정비유동자산", "ifrs-full_NoncurrentAssetsOrDisposalGroupsClassifiedAsHeldForSale", "10000000000"],
        ["매각예정부채", "ifrs-full_LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale", "6000000000"],
        ["매각예정비유동자산 관련 기타포괄손익누계액", NS, "2000000000"],
      ]));
      return expect(JSON.stringify(r.meta.heldForSale) === JSON.stringify({ assets: 1e10, liabilities: 6e9, net: 4e9 }), JSON.stringify(r.meta.heldForSale));
    },
  },
  {
    name: "W28 동일 금액 IBD 행 쌍은 참고로 남김",
    run: () => {
      const r = run([["신주인수권부사채", "dart_BondsWithWarrant", "92"], ["전환사채", "dart_ConvertibleBonds", "92"]], [], [184, 0]);
      return expect(has(r.notes, "동일 금액 IBD 행 쌍"), r.notes.join(" | "));
    },
  },
  {
    name: "W29 거부 경고에 금액·구역 — 같은 이름 행도 따로",
    run: () => {
      const r = run([["파생상품부채", SB, "1000000000"]], [["파생상품부채", LB, "2000000000"]], [1e9, 2e9]);
      const v = r.checks.filter((c) => c.startsWith("표준 ID는 차입성이나"));
      return expect(v.length === 2 && has(v, "10억(유동)") && has(v, "20억(비유동)"), v.join(" | "));
    },
  },
  {
    name: "W30 '사채및전환사채'·'전환사채 등'은 일반사채 포함 가능 참고",
    run: () => {
      const a = run([["사채및전환사채", NS, "100"]], [], [100, 0]);
      const b = run([["전환사채 등", "dart_ConvertibleBonds", "100"]], [], [100, 0]);
      const c = run([["전환사채및신주인수권부사채", NS, "100"]], [], [100, 0]);
      return expect(has(a.notes, "일반사채 포함 가능") && has(b.notes, "일반사채 포함 가능") && !has(c.notes, "일반사채 포함 가능"), `${a.notes} / ${b.notes} / ${c.notes}`);
    },
  },
  {
    name: "S02 증거 없는 금액 일치가 남은 구역은 경고를 강등하지 않음",
    run: () => {
      const r = run([], [["원화장기차입금", NS, "60"], ["외화장기차입금", NS, "40"], ["장기차입금", LB, "100"], ["장기미지급금", NS, "100"], ["장기예수보증금", NS, "100"]], [0, 300]);
      return expect(has(r.checks, "비유동부채 행 합계가 소계와 초과"), r.checks.join(" | "));
    },
  },
  {
    name: "S03 미구분 BS — 초과분 없으면 1:1 제거 안 함, SPAC 차입부채 = 전환사채 는 제거",
    run: () => {
      const a = computeIbdV2(mk2(null, [["차입금", NS, "5000000000"], ["전환사채", "dart_ConvertibleBonds", "5000000000"], ["미지급금", NS, "1000000000"]], null, "11000000000"));
      const b = computeIbdV2(mk2(null, [["차입부채", NS, "2980000000"], ["전환사채", "dart_ConvertibleBonds", "2980000000"], ["미지급금", NS, "100000000"]], null, "3080000000"));
      const c = computeIbdV2(mk2(null, [["차입금", NS, "5000000000"], ["단기차입금", SB, "5000000000"]], null, "5000000000"));
      return expect(a.total === 1e10 && b.total === 2.98e9 && c.total === 5e9, `a ${a.total} b ${b.total} c ${c.total}`);
    },
  },
  {
    name: "S04 유동 소계가 비었으면 부채총계 − 비유동으로 복원해 포괄 행 제거",
    run: () => {
      const r = computeIbdV2(mk2([["차입금및사채", NS, "150"], ["단기차입금", SB, "100"], ["유동성사채", "ifrs-full_CurrentPortionOfBondsIssued", "50"], ["매입채무", NS, "200"]], [], ["", "100"], "450"));
      return expect(r.total === 150, `total ${r.total}`);
    },
  },
  {
    name: "S05 원래 부호가 소계와 맞으면 뒤집지 않음(유동차입금·사채발행비)",
    run: () => {
      const a = run([["유동차입금", SB, "-279204660"], ["매입채무", NS, "100279204660"]], [], [1e11, 0]);
      const b = run([], [["사채", "ifrs-full_BondsIssued", "10000000000"], ["사채발행비", NS, "-30000000"], ["장기매입채무", NS, "5000000000"]], [0, 14970000000]);
      return expect(a.total === -279204660 && has(a.checks, "음수") && b.total === 9970000000, `a ${a.total} b ${b.total}`);
    },
  },
  {
    name: "S06 비차입 할인차금도 소계 대조에서는 −|금액| — 거짓 초과 경고 없음",
    run: () => {
      const r = run([], [["장기차입금", LB, "10000000000"], ["장기임대보증금", NS, "5000000000"], ["현재가치할인차금, 장기임대보증금", NS, "500000000"]], [0, 14500000000]);
      return expect(!has(r.checks, "초과") && r.total === 1e10, `${r.total} ${r.checks.join(" | ")}`);
    },
  },
  {
    name: "S07 비차입 계층 부모(임대보증금) 안의 할인차금은 제외",
    run: () => {
      const r = run([], [["장기차입금", LB, "150000000000"], ["임대보증금", NS, "100000000000"], ["임대보증금(총액)", NS, "120000000000"], ["현재가치할인차금", NS, "-20000000000"]], [0, 250000000000]);
      return expect(r.total === 1.5e11, `total ${r.total}`);
    },
  },
  {
    name: "S09 '(사채 포함)' 차입금 행 옆 사채할인발행차금은 그 행에 귀속",
    run: () => {
      const r = run([], [["장기차입금(사채 포함), 총액", "dart_LongTermBorrowingsGross", "20000000000"], ["사채할인발행차금", NS, "-167200000"]], [0, 19832800000]);
      return expect(r.total === 19832800000 && r.completeness === "full", `${r.total} ${r.completeness}`);
    },
  },
  {
    name: "S11 '전환사채(파생상품부채 포함)'은 전환사채 + 경고, 파생 행은 부채성",
    run: () => {
      const r = run([["전환사채(파생상품부채 포함)", "dart_ConvertibleBonds", "18000000000"], ["전환사채파생상품부채", NS, "100"], ["전환사채(파생상품부채)", NS, "100"]], [], [1.8e10, 0]);
      return expect(cats(r).convertible === 1.8e10 && r.debtLike.length === 2 && has(r.checks, "파생상품부채 포함 전환사채"), `${JSON.stringify(cats(r))} ${r.debtLike.length}`);
    },
  },
  {
    name: "S12 AMBIG — 묶인 차입 행/차입금 아님/리스 ID 는 경고 없음",
    run: () => {
      const a = run([], [["기타장기채무 및 장기차입부채", LB, "100"]], [0, 100]);
      const b = run([["단기차입금및기타금융부채", NS, "100"]], [], [100, 0]);
      const c = run([["기타채무", SB, "100"]], [], [100, 0]);
      const d = run([["기타채무", "ifrs-full_CurrentLeaseLiabilities", "100"]], [], [100, 0]);
      return expect(
        has(a.checks, "묶인 차입 행") && !has(a.checks, "차입금 아님") && has(b.checks, "묶인 차입 행") && b.total === 100 && has(c.checks, "차입금 아님") && !d.checks.length,
        `${a.checks} / ${b.checks} / ${c.checks} / ${d.checks}`,
      );
    },
  },
  {
    name: "S13·S14 포괄 금융부채 이름 변형 감지, 제외 구절·헤지 표지 처리",
    run: () => {
      const agg = (nm: string) => computeIbdV2(mk([], [[nm, NS, "1000"]], [0, 1000])).checks.some((c) => c.includes("'금융부채'로 묶여"));
      const hedge = run([["통화스왑부채(차입금 헤지)", NS, "100"]], [], [100, 0]);
      const hedged = run([["위험회피대상 차입금", SB, "100"]], [], [100, 0]);
      const ex = run([], [["기타금융부채(차입금 제외)", NS, "1000"]], [0, 1000]);
      return expect(
        agg("장기기타금융부채") && agg("기타금융부채(비유동)") && agg("상각후원가측정금융부채") && !agg("매입채무및기타금융부채") &&
          hedge.total === 0 && hedged.total === 100 && ex.total === 0 && has(ex.checks, "'금융부채'로 묶여"),
        `agg/hedge ${hedge.total} ${hedged.total} ${ex.total}`,
      );
    },
  },
  {
    name: "S15·S21 범주 추정 순서(유동화사채·자산유동화차입금·혼합·사채및전환사채)",
    run: () => {
      const g = ["유동화사채", "자산유동화차입금", "장기차입금 및 전환사채", "사채및전환사채"].map(guessCategoryByName);
      const r = run([["유동화사채", SB, "100"]], [], [100, 0]);
      return expect(JSON.stringify(g) === JSON.stringify(["bonds", "otherDebt", "borrowingsAndBonds", "convertible"]) && cats(r).bonds === 100, `${g} ${JSON.stringify(cats(r))}`);
    },
  },
  {
    name: "S16 옵션 부채·파생 유형",
    run: () => {
      const r = run([["유동성상환전환우선주파생상품부채", NS, "100"], ["전환권부채", NS, "100"], ["신주인수권부채", "dart_BondsWithWarrant", "100"]], [], [300, 0]);
      const t = r.debtLike.map((d) => d.type);
      return expect(JSON.stringify(t) === JSON.stringify(["convDerivative", "convDerivative"]) && cats(r).convertible === 100, `${t} ${JSON.stringify(cats(r))}`);
    },
  },
  {
    name: "XBRL 파서 — '공시금액' 문맥 우선, 없는 요소는 차원 없는 값, 다른 축은 제외",
    run: () => {
      const scope = "_ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_ConsolidatedMember";
      const c0 = `CFY2026eTQA${scope}`;
      const rpt = c0 + REPORTED_AMOUNT_SUFFIX;
      const other = c0 + "_ifrs-full_BorrowingsByNameAxis_entity1_XMember";
      const xml = [
        `<xbrli:context id="${c0}"></xbrli:context><xbrli:context id="${rpt}"></xbrli:context><xbrli:context id="${other}"></xbrli:context>`,
        `<ifrs-full:Borrowings contextRef="${c0}" unitRef="KRW" decimals="-6">1000</ifrs-full:Borrowings>`,
        `<ifrs-full:Borrowings contextRef="${rpt}" unitRef="KRW" decimals="-6">999</ifrs-full:Borrowings>`,
        `<ifrs-full:ShorttermBorrowings contextRef="${rpt}" unitRef="KRW" decimals="-6">600</ifrs-full:ShorttermBorrowings>`,
        `<ifrs-full:ShorttermBorrowings contextRef="${other}" unitRef="KRW" decimals="-6">50</ifrs-full:ShorttermBorrowings>`,
      ].join("\n");
      const sets = parseXbrlInstantFactSets(xml, "2026", "ConsolidatedMember");
      const sum = summarizeXbrlDebt(sets.facts, sets.factsRpt);
      return expect(sets.facts.Borrowings === 1000 && sets.factsRpt.ShorttermBorrowings === 600 && sum.total === 999 && sum.currentLoans === 600, JSON.stringify(sets));
    },
  },
  {
    name: "S17 리스보증금은 리스 ID 여도 제외, 리스미지급금은 리스",
    run: () => {
      const a = run([], [["리스보증금", "ifrs-full_NoncurrentLeaseLiabilities", "100"]], [0, 100]);
      const b = run([["리스미지급금", "ifrs-full_CurrentLeaseLiabilities", "100"]], [], [100, 0]);
      return expect(a.total === 0 && cats(b).lease === 100, `${a.total} ${JSON.stringify(cats(b))}`);
    },
  },
);

if (!dump)
  for (const t of synthetic) {
    const err = t.run();
    if (err) {
      fail += 1;
      console.log(`✗ 합성: ${t.name}: ${err}`);
    } else pass += 1;
  }

if (!dump) {
  console.log(`\n이자부부채 엔진 회귀 테스트: ${pass} 통과, ${fail} 실패`);
  if (fail) process.exit(1);
}
