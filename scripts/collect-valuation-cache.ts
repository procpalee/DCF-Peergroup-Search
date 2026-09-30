/**
 * 평가기준일별 밸류에이션 캐시 수집 (v2, 2026-09-30).
 *
 * 사용법:
 *   npx tsx scripts/collect-valuation-cache.ts 20251231 20260331   # 지정 기준일
 *   npx tsx scripts/collect-valuation-cache.ts --latest             # 아직 없는 최근 분기말 1개
 *   npx tsx scripts/collect-valuation-cache.ts 20251231 --financials-only   # 재무만 재산정(주가·베타 진행파일 재사용)
 *   npx tsx scripts/collect-valuation-cache.ts 20260331 --codes 005930,000660 --out /tmp/kvd   # 시범(일부 종목, 별도 폴더)
 *   npx tsx scripts/collect-valuation-cache.ts 20260630 --financials-only --recompute-all   # 엔진 판이 바뀐 보고서를 전부 재계산
 *
 * 재무 시점: 기준일 "당시" 공시된 최신 정기보고서(사업·반기·분기) — report-asof.ts.
 * 이자부부채: 재무상태표 본문 기준 엔진 v2(ibd-engine.ts) + 필요 시 XBRL 주석 보충.
 * 주식수: DART 유통주식수를 네이버 현재 상장주식수와 대조해 단위 오류 보정.
 *
 * 단계(모두 이어받기 가능 — 중단 후 재실행하면 이어서 진행):
 *   1. 공시 목록 (회사당 1회, _shared/report-lists.json)
 *   2. 재무 (보고서 접수번호 단위로 결과 저장 → 여러 기준일이 같은 보고서를 쓰면 재사용, _shared/fin-v2.json)
 *      원자료(재무 행·XBRL 주석 사실·주식수)는 _shared/raw/ 에 보고서별로 보관 — 엔진 판이 바뀌면 DART 호출 없이 재계산.
 *   3. 참조 상장주식수 (네이버, 실행당 1회)
 *   4. 종가·베타 (기준일별, _progress/price-*.json · beta-*.json)
 *   5. 조립 → data/valuation-cache/{기준일}.json + {기준일}.meta.json
 */
import fs from "fs";
import path from "path";
import { fetchHistoricalPrices, fetchMarketData } from "../src/services/naver/client";
import { computeBetaGridBatch } from "../src/services/beta-calc";
import { getIndustryName } from "../src/services/opendart/ksic-codes";
import {
  sanitizeShares, migrateIbdMessages, normalizeCompactIbd, IBD_ENGINE_VERSION, XBRL_ERROR_MSG, EXCEEDS_TL_MSG,
  type CompactIbd, type IbdTuple,
} from "../src/services/opendart/ibd-engine";
import { fetchPeriodicReports, selectAsOfReport, monthsBeforeDate, type AsOfReport } from "../src/services/opendart/report-asof";
import { fetchFinForReport, emptyFin, type FinResult } from "../src/services/valuation/asof-financials";
import { createFsRawStore } from "../src/services/valuation/raw-store-fs";
import type { DartListDoc } from "../src/services/opendart/document-parser";

// ─── 설정 ───
const ENGINE_VERSION = IBD_ENGINE_VERSION;
const DART_BATCH_SIZE = 3;
const DART_DELAY_MS = 1000; // 분당 ~180회
const NAVER_CONCURRENCY = 10;
const BETA_BATCH_SIZE = 20;
const SAVE_INTERVAL = 50;

const BASE_DIR = path.resolve(__dirname, "../data/valuation-cache");
const SHARED_DIR = path.join(BASE_DIR, "_shared");
const PROGRESS_DIR = path.join(BASE_DIR, "_progress");
const LISTS_PATH = path.join(SHARED_DIR, "report-lists.json");
const FIN_PATH = path.join(SHARED_DIR, "fin-v2.json");
const INDUSTRY_PATH = path.resolve(__dirname, "../data/company-industry.json");
const PEER_LISTS_PATH = path.resolve(__dirname, "../data/peer-snapshot/_shared/report-lists.json");

for (const envFile of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}
const apiKey = process.env.OPENDART_API_KEY ?? "";

// ─── 타입 ───

interface Stock {
  code: string;
  name: string;
  corpCode: string;
  industryCode: string;
  accMonth: string;
  listedDate: string | null;
}

interface ListsEntry {
  /** 이 날짜까지의 공시가 목록에 반영됨(YYYYMMDD) */
  fetchedThrough: string;
  docs: DartListDoc[];
}

// ─── 유틸 ───

const ensureDir = (d: string) => fs.mkdirSync(d, { recursive: true });
const loadJson = <T>(p: string): T | null => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const saveJson = (p: string, d: unknown) => fs.writeFileSync(p, JSON.stringify(d));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => {
  const d = new Date(Date.now() + 9 * 3600e3); // KST
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};

/** DART 일일 한도 초과(020) 등 계속할 수 없는 오류 */
class FatalApiError extends Error {}
function checkFatal(e: unknown) {
  const msg = (e as Error)?.message ?? "";
  if (/status: 020|사용한도|요청 제한/.test(msg)) throw new FatalApiError(msg);
}

/** 최근 분기말(오늘 이전) 목록 — 새 순 */
function recentQuarterEnds(n: number): string[] {
  const t = today();
  const out: string[] = [];
  let y = Number(t.slice(0, 4));
  let q = Math.floor((Number(t.slice(4, 6)) - 1) / 3); // 현재 분기(0~3) — 그 직전 분기말부터
  while (out.length < n) {
    q -= 1;
    if (q < 0) {
      q = 3;
      y -= 1;
    }
    const md = ["0331", "0630", "0930", "1231"][q];
    out.push(`${y}${md}`);
  }
  return out.filter((d) => d < t);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dates = args.filter((a) => /^\d{8}$/.test(a));
  if (args.includes("--latest")) {
    const missing = recentQuarterEnds(4).find((d) => {
      const m = loadJson<{ engine?: string; stats?: { xbrlError?: number } }>(path.join(BASE_DIR, `${d}.meta.json`));
      return !fs.existsSync(path.join(BASE_DIR, `${d}.json`)) || m?.engine !== ENGINE_VERSION || (m.stats?.xbrlError ?? 0) > 0;
    });
    if (missing) dates.push(missing);
  }
  const ci = args.indexOf("--codes");
  const codes = ci >= 0 ? new Set(args[ci + 1].split(",")) : null;
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  return {
    dates: [...new Set(dates)].sort(),
    financialsOnly: args.includes("--financials-only"),
    codes,
    outDir,
    recomputeAll: args.includes("--recompute-all"),
  };
}

function getStocks(asOf: string): Stock[] {
  const industry: Record<string, { name: string; corpCode: string; industryCode: string; accMonth?: string; listedDate?: string }> =
    JSON.parse(fs.readFileSync(INDUSTRY_PATH, "utf8"));
  return Object.entries(industry)
    .map(([code, e]) => ({
      code,
      name: e.name,
      corpCode: e.corpCode,
      industryCode: e.industryCode,
      accMonth: e.accMonth ?? "12",
      listedDate: e.listedDate ? e.listedDate.replace(/-/g, "") : null,
    }))
    // 기준일 이후 상장 종목 제외(상장일을 모르면 포함)
    .filter((s) => !s.listedDate || s.listedDate <= asOf);
}

/** 네이버 "1,579조 9,568억" → 원 */
function parseKrw(s: string | null | undefined): number | null {
  if (!s) return null;
  let total = 0;
  const jo = s.match(/([\d,]+)\s*조/);
  const eok = s.match(/([\d,]+)\s*억/);
  if (jo) total += Number(jo[1].replace(/,/g, "")) * 1e12;
  if (eok) total += Number(eok[1].replace(/,/g, "")) * 1e8;
  return total > 0 ? total : null;
}

// ─── 1. 공시 목록 ───

async function ensureReportLists(stocks: Stock[], through: string): Promise<Record<string, ListsEntry>> {
  const lists: Record<string, ListsEntry> = loadJson(LISTS_PATH) ?? {};
  // Peer 스냅샷이 모아 둔 목록(2025 말까지)으로 초기화 — 2025 기준일은 추가 조회 불필요
  if (Object.keys(lists).length === 0 && fs.existsSync(PEER_LISTS_PATH)) {
    const peer: Record<string, DartListDoc[]> = JSON.parse(fs.readFileSync(PEER_LISTS_PATH, "utf8"));
    for (const [corp, docs] of Object.entries(peer)) lists[corp] = { fetchedThrough: "20251231", docs };
    console.log(`[목록] Peer 스냅샷 목록 ${Object.keys(lists).length}개사로 초기화`);
  }
  const need = stocks.filter((s) => !lists[s.corpCode] || lists[s.corpCode].fetchedThrough < through);
  console.log(`[목록] ${through} 기준 갱신 필요 ${need.length}개사`);
  const end = today();
  for (let i = 0; i < need.length; i += DART_BATCH_SIZE) {
    const batch = need.slice(i, i + DART_BATCH_SIZE);
    await Promise.all(
      batch.map(async (s) => {
        try {
          const bgn = monthsBeforeDate(through, 24);
          const docs = await fetchPeriodicReports(s.corpCode, bgn, end, apiKey);
          const prev = lists[s.corpCode]?.docs ?? [];
          const merged = new Map([...prev, ...docs].map((d) => [d.rcept_no, d]));
          lists[s.corpCode] = { fetchedThrough: end, docs: [...merged.values()] };
        } catch (e) {
          checkFatal(e);
          console.error(`[목록 ${s.code}] ${(e as Error).message}`);
        }
      }),
    );
    if ((i / DART_BATCH_SIZE) % SAVE_INTERVAL === 0 || i + DART_BATCH_SIZE >= need.length) {
      saveJson(LISTS_PATH, lists);
      console.log(`[목록] ${Math.min(i + DART_BATCH_SIZE, need.length)}/${need.length}`);
    }
    await sleep(DART_DELAY_MS);
  }
  saveJson(LISTS_PATH, lists);
  return lists;
}

// ─── 2. 재무 ───

const rawStore = createFsRawStore();
const RECOMPUTE_ALL = process.argv.includes("--recompute-all");

/** 주석 XBRL 통신 오류로 끝난 결과 — 최대 3회까지 다시 계산(영구 오류가 같은 기준일을 매일 고르지 않게) */
const XBRL_RETRY_MAX = 3;
const isXbrlRetry = (f: FinResult) =>
  (f.xbrlStatus === "xml_error" || !!f.ibd?.checks?.some((c) => c.startsWith(XBRL_ERROR_MSG.slice(0, 12)))) &&
  (f.xbrlRetries ?? 0) < XBRL_RETRY_MAX;

/**
 * 결과를 다시 계산할지.
 *  - --recompute-all 이면 항상
 *  - XBRL 통신 오류로 끝난 결과는 재시도(상한 3회)
 *  - 엔진 판이 다르면 항상(원자료가 있으면 DART 호출 없음, 없으면 다시 받음 — 한도는 이어받기)
 */
function needsRecompute(f: FinResult, _rceptNo: string): boolean {
  if (RECOMPUTE_ALL) return true;
  if (isXbrlRetry(f)) return true;
  // 일시 오류(시간 초과·파일 충돌 등)로 끝난 결과는 다시 — '재무제표 없음'은 확정 결과
  if (f.error && !f.ibd && !/재무제표 없음|데이터 품질 보류/.test(f.error)) return true;
  return f.engine !== ENGINE_VERSION;
}

async function collectFinancials(stocks: Stock[], asOf: string, lists: Record<string, ListsEntry>) {
  const fin: Record<string, FinResult> = loadJson(FIN_PATH) ?? {};
  const pick: Record<string, string | null> = {}; // code → rcept_no
  const todo: { s: Stock; rep: AsOfReport }[] = [];
  for (const s of stocks) {
    const rep = selectAsOfReport(lists[s.corpCode]?.docs ?? [], asOf, s.accMonth);
    pick[s.code] = rep?.rceptNo ?? null;
    if (rep && (!fin[rep.rceptNo] || needsRecompute(fin[rep.rceptNo], rep.rceptNo))) todo.push({ s, rep });
  }
  console.log(`[재무 ${asOf}] 보고서 선택 ${Object.values(pick).filter(Boolean).length}/${stocks.length}, 신규 수집 ${todo.length}`);
  let done = 0;
  for (let i = 0; i < todo.length; i += DART_BATCH_SIZE) {
    const batch = todo.slice(i, i + DART_BATCH_SIZE);
    // XBRL 재시도는 원자료가 있어도 DART 를 부른다 — 호출 간격 유지
    const offline = batch.every(({ rep }) => rawStore.has(rep.rceptNo) && !(fin[rep.rceptNo] && isXbrlRetry(fin[rep.rceptNo])));
    await Promise.all(
      batch.map(async ({ s, rep }) => {
        try {
          // 재계산이면 이전 결과의 주식수를 넘겨 주식수 조회를 아낀다
          const prev = fin[rep.rceptNo];
          const res = await fetchFinForReport(s, rep, apiKey, checkFatal, rawStore, prev);
          if (res.xbrlStatus === "xml_error") res.xbrlRetries = (prev?.xbrlStatus === "xml_error" ? prev.xbrlRetries ?? 1 : 0) + 1;
          fin[rep.rceptNo] = res;
        } catch (e) {
          checkFatal(e);
          fin[rep.rceptNo] = emptyFin(rep, (e as Error).message);
        }
        done += 1;
      }),
    );
    if ((i / DART_BATCH_SIZE) % SAVE_INTERVAL === 0 || i + DART_BATCH_SIZE >= todo.length) {
      saveJson(FIN_PATH, fin);
      console.log(`[재무 ${asOf}] ${done}/${todo.length}`);
    }
    // 원자료로만 재계산한 묶음은 DART 를 부르지 않았으니 쉬지 않는다
    if (!offline) await sleep(DART_DELAY_MS);
  }
  saveJson(FIN_PATH, fin);
  return { fin, pick };
}

// ─── 3. 참조 상장주식수 (네이버 현재 시총 ÷ 종가) ───

async function collectListedRef(stocks: Stock[]): Promise<Record<string, number | null>> {
  const p = path.join(PROGRESS_DIR, `listed-ref-${today()}.json`);
  const ref: Record<string, number | null> = loadJson(p) ?? {};
  const todo = stocks.filter((s) => !(s.code in ref));
  for (let i = 0; i < todo.length; i += NAVER_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + NAVER_CONCURRENCY).map(async (s) => {
        try {
          const m = await fetchMarketData(s.code);
          const cap = parseKrw(m.marketCap);
          ref[s.code] = cap && m.price ? Math.round(cap / m.price) : null;
        } catch {
          ref[s.code] = null;
        }
      }),
    );
    if (i % (NAVER_CONCURRENCY * 30) === 0) saveJson(p, ref);
  }
  saveJson(p, ref);
  console.log(`[참조주식수] ${Object.values(ref).filter(Boolean).length}/${stocks.length}`);
  return ref;
}

// ─── 4. 종가·베타 (기준일별) ───

async function collectPrices(stocks: Stock[], asOf: string): Promise<Record<string, number | null>> {
  const p = path.join(PROGRESS_DIR, `price-${asOf}.json`);
  const got: Record<string, number | null> = loadJson(p) ?? {};
  const todo = stocks.filter((s) => !(s.code in got));
  console.log(`[종가 ${asOf}] 미수집 ${todo.length}`);
  const d = new Date(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}`);
  d.setDate(d.getDate() - 14);
  const start = d.toISOString().slice(0, 10).replace(/-/g, "");
  for (let i = 0; i < todo.length; i += NAVER_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + NAVER_CONCURRENCY).map(async (s) => {
        try {
          const prices = (await fetchHistoricalPrices(s.code, start, asOf)).filter((x) => x.date <= asOf);
          got[s.code] = prices.length ? prices[prices.length - 1].close : null;
        } catch {
          got[s.code] = null;
        }
      }),
    );
    if (i % (NAVER_CONCURRENCY * 30) === 0) saveJson(p, got);
  }
  saveJson(p, got);
  return got;
}

type BetaGrid = Record<string, [number | null, number | null, number | null]> | null;
async function collectBetas(stocks: Stock[], asOf: string): Promise<Record<string, { weekly: BetaGrid; monthly: BetaGrid }>> {
  const p = path.join(PROGRESS_DIR, `beta-${asOf}.json`);
  const got: Record<string, { weekly: BetaGrid; monthly: BetaGrid }> = loadJson(p) ?? {};
  const codes = stocks.filter((s) => !(s.code in got)).map((s) => s.code);
  console.log(`[베타 ${asOf}] 미수집 ${codes.length}`);
  for (let i = 0; i < codes.length; i += BETA_BATCH_SIZE) {
    const batch = codes.slice(i, i + BETA_BATCH_SIZE);
    try {
      const { weeklyMap, monthlyMap } = await computeBetaGridBatch(batch, asOf);
      const compact = (r: { betas: Record<string, { raw: number | null; adjusted: number | null; dataPoints: number | null }> } | undefined): BetaGrid =>
        r ? Object.fromEntries(Object.entries(r.betas).map(([k, v]) => [k, [v.raw, v.adjusted, v.dataPoints]])) : null;
      for (const c of batch) got[c] = { weekly: compact(weeklyMap.get(c)), monthly: compact(monthlyMap.get(c)) };
    } catch {
      for (const c of batch) got[c] = { weekly: null, monthly: null };
    }
    if ((i / BETA_BATCH_SIZE) % SAVE_INTERVAL === 0) saveJson(p, got);
  }
  saveJson(p, got);
  return got;
}

// ─── 5. 조립 ───

const eokC = (n: number) => `${(n / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억`;
const DEBT_OUT = new Set(["borrowings", "bonds", "convertible", "borrowingsAndBonds", "otherDebt"]);
/**
 * 직전 정기보고서(기간이 다른 것) 대비 차입·리스 소실 경고 — 엔진은 보고서 한 건의 순수 함수라 기간 비교는 여기서.
 *  - 이번에 주석 차입을 못 넣었고 묶인 구역에 본문 차입도 없는데, 직전에는 그 구역에 차입이 있었으면 check + partial
 *  - 직전에 리스가 있었는데 이번에 리스 행이 전혀 없으면 check(기타금융부채에 묶였을 가능성)
 * 기준 금액 = max(50억, 지배기업 소유주지분의 5%). 필드가 없는 옛 결과는 판단하지 않는다.
 */
function historyChecks(f: FinResult, docs: DartListDoc[], fin: Record<string, FinResult>): { checks: string[]; partial: boolean } {
  const out = { checks: [] as string[], partial: false };
  if (!f.ibd) return out;
  const pd = docs
    .filter((d) => d.rcept_dt < f.report.rceptDate && fin[d.rcept_no]?.ibd && fin[d.rcept_no].report.period !== f.report.period)
    .sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt))[0];
  if (!pd) return out;
  const pi = normalizeCompactIbd(fin[pd.rcept_no].ibd)!;
  const ci = normalizeCompactIbd(f.ibd)!;
  const eq = Math.max(f.fundamentals?.equityParent ?? f.fundamentals?.equityTotal ?? 0, 0);
  const thr = Math.max(5e9, 0.05 * eq);
  const debt = (t: IbdTuple[]) => t.filter((x) => DEBT_OUT.has(x[2])).reduce((a, x) => a + x[1], 0);
  const prevBad = (pi.checks ?? []).some((c) => /보충액이 본문 금융부채를 초과|부채총계를 초과/.test(c));
  if (f.aggregatedSections && f.xbrlApplied && !f.xbrlApplied.debt && !prevBad)
    for (const s of f.aggregatedSections) {
      const prevDebt = debt(pi[s]);
      const curBody = debt(ci[s].filter((x) => !x[0].includes("(주석")));
      // 직전 값이 자본보다 크면(과대 보충 등 이상치 가능) 판단하지 않는다
      if (curBody === 0 && prevDebt >= thr && prevDebt <= eq) {
        out.checks.push(`직전 보고서(${pd.rcept_no}) ${s === "current" ? "유동" : "비유동"} 차입 ${eokC(prevDebt)} — 이번 보충 실패`);
        out.partial = true;
      }
    }
  const lease = (c: CompactIbd) => [...c.current, ...c.nonCurrent, ...(c.unclassified ?? [])].filter((x) => x[2] === "lease").reduce((a, x) => a + x[1], 0);
  if (lease(pi) >= thr && lease(ci) === 0) out.checks.push(`리스 행 소멸(직전 ${eokC(lease(pi))}) — 기타금융부채 묶임 여부 확인`);
  return out;
}

/**
 * 데이터 품질 보류(단위 이상) — 같은 회사 직전 보고서 대비 자본이 100배 이상 튀고 이자부부채도 같은 배율로 튀면
 * DART 원자료 단위 오류로 보고 재무 레코드 전체를 보류한다(현금만 남으면 순차입금이 망가진다). 절대값 500조 초과도 보류.
 */
const eqOf = (x?: FinResult) => x?.fundamentals?.equityTotal ?? null;
/** 비재귀 이상치 판정 — 500조 초과, 또는 그 앞 보고서 대비 자본 100배 */
function looksOutlier(x: FinResult, before?: FinResult): boolean {
  if ((x.ibd?.total ?? 0) > 5e14) return true;
  const a = eqOf(x);
  const b = eqOf(before);
  if (!a || !b || a <= 0 || b <= 0) return false;
  return a / b >= 100 || a / b <= 0.01;
}

function qualityHold(f: FinResult, docs: DartListDoc[], fin: Record<string, FinResult>): string | null {
  // IBD 는 부채의 부분집합 — 넘으면 단위·태깅 오류 또는 이중 계상 → 레코드 전체 보류
  if (f.ibd?.completenessReason?.includes("부채총계 초과") || f.ibd?.checks?.some((c) => c.startsWith(EXCEEDS_TL_MSG)))
    return "이자부부채가 부채총계를 초과 — 원자료 또는 엔진 판정 확인";
  const total = f.ibd?.total ?? 0;
  if (total > 5e14) return `이자부부채 ${Math.round(total / 1e12)}조 — 단위 오류 의심`;
  const eq = f.fundamentals?.equityTotal;
  if (!eq || eq <= 0) return null;
  const prevs = docs
    .filter((d) => d.rcept_dt < f.report.rceptDate && eqOf(fin[d.rcept_no]) != null)
    .sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));
  // 직전 보고서가 그 자체로 이상치면 한 단계 앞과 비교(정상 → 이상치 → 정상에서 세 번째를 보류하지 않게)
  const prev = prevs[0] && looksOutlier(fin[prevs[0].rcept_no], prevs[1] && fin[prevs[1].rcept_no]) ? prevs[1] : prevs[0];
  if (!prev) return null;
  const p = fin[prev.rcept_no];
  const pe = eqOf(p)!;
  if (pe <= 0) return null; // 직전이 자본잠식이면 배율 비교 불가
  const r = eq / pe;
  if (r < 100 && r > 0.01) return null;
  const pt = p.ibd?.total ?? 0;
  if (pt > 0 && total > 0) {
    const ri = total / pt;
    if (ri < r * 0.5 || ri > r * 2) return null;
  } else {
    // IBD 배율을 볼 수 없으면(무차입) 현금 배율로 확인 — 자본만 튀면 보류하지 않음
    const c = f.fundamentals?.cash ?? 0;
    const pc = p.fundamentals?.cash ?? 0;
    if (!(c > 0 && pc > 0 && c / pc >= r * 0.5 && c / pc <= r * 2)) return null;
  }
  return `자본이 직전 보고서(${prev.rcept_no}) 대비 ${r >= 100 ? Math.round(r) + "배" : (1 / r).toFixed(0) + "분의 1"} — 단위 오류 의심`;
}

function assemble(
  stocks: Stock[],
  asOf: string,
  fin: Record<string, FinResult>,
  pick: Record<string, string | null>,
  listed: Record<string, number | null>,
  prices: Record<string, number | null>,
  betas: Record<string, { weekly: BetaGrid; monthly: BetaGrid }>,
  lists: Record<string, ListsEntry>,
) {
  const out: Record<string, unknown> = {};
  const stats = {
    total: 0, noReport: 0, ibdNull: 0, ibdExcluded: 0, xbrlSupplemented: 0, ibdChecks: 0, ibdPartial: 0, qualityHeld: 0,
    xbrlError: 0, sharesFixed: 0, sharesNull: 0, priceNull: 0,
  };
  const engineMix: Record<string, number> = {};
  for (const s of stocks) {
    const f0 = pick[s.code] ? fin[pick[s.code]!] : null;
    if (f0) {
      const ev = f0.engine ?? "ibd-v2.0";
      engineMix[ev] = (engineMix[ev] ?? 0) + 1;
      if (isXbrlRetry(f0)) stats.xbrlError += 1;
    }
    const held = f0 ? qualityHold(f0, lists[s.corpCode]?.docs ?? [], fin) : null;
    const f: FinResult | null = f0 && held ? { ...f0, ibd: null, fundamentals: null, error: `데이터 품질 보류: ${held}` } : f0;
    if (held) stats.qualityHeld += 1;
    const price = prices[s.code] ?? null;
    // DART 주식수가 없으면(주식총수 API 013 — 셀트리온·SK 등) 네이버 현재 상장주식수로 대체
    const sh0 = f?.sharesDart
      ? sanitizeShares(f.sharesDart, listed[s.code] ?? null)
      : listed[s.code]
        ? { shares: listed[s.code]!, note: "DART 주식수 없음 — 네이버 현재 상장주식수(기준일과 다를 수 있음)" }
        : { shares: null, note: "주식수 없음" };
    const sh = f?.sharesSource
      ? { ...sh0, note: [`주식수는 ${f.sharesSource} 기준(해당 보고서 미기재)`, sh0.note].filter(Boolean).join("; ") }
      : sh0;
    stats.total += 1;
    if (!f) stats.noReport += 1;
    if (f && !f.ibd && !f.ibdExcluded && !held) stats.ibdNull += 1;
    if (f?.ibdExcluded) stats.ibdExcluded += 1;
    if (f?.xbrlSupplemented) stats.xbrlSupplemented += 1;
    // 직전 보고서 대비 경고는 출력에만 붙인다(한 실행에서 여러 기준일이 같은 레코드를 공유)
    const ibd0 = normalizeCompactIbd(migrateIbdMessages(f?.ibd ?? null));
    const hist = f && ibd0 && !held ? historyChecks(f, lists[s.corpCode]?.docs ?? [], fin) : { checks: [], partial: false };
    const ibd: CompactIbd | null = ibd0 && hist.checks.length
      ? {
          ...ibd0,
          checks: [...(ibd0.checks ?? []), ...hist.checks],
          ...(hist.partial
            ? { completeness: "partial" as const, completenessReason: [ibd0.completenessReason, "직전 보고서 대비 차입 소실"].filter(Boolean).join("; ") }
            : {}),
        }
      : ibd0;
    if (ibd?.checks?.length) stats.ibdChecks += 1;
    if (ibd?.completeness === "partial") stats.ibdPartial += 1;
    if (sh.note?.includes("보정")) stats.sharesFixed += 1;
    if (!sh.shares) stats.sharesNull += 1;
    if (!price) stats.priceNull += 1;
    const fu = f?.fundamentals ?? null;
    out[s.code] = {
      code: s.code,
      name: s.name,
      industry: { code: s.industryCode, name: getIndustryName(s.industryCode) },
      year: f?.report.bsnsYear ?? null,
      valuationDate: asOf,
      beta: betas[s.code] ?? { weekly: null, monthly: null },
      // 옛 판 결과(2-튜플)도 현재 형식([계정명, 금액, 범주])으로 맞춰 쓴다
      ibd,
      ...(f?.ibdExcluded ? { ibdExcluded: f.ibdExcluded } : {}),
      nci: fu?.nci ?? null,
      pretaxIncome: fu?.pretaxIncome ?? null,
      marketCap: {
        price,
        shares: sh.shares,
        total: price && sh.shares ? price * sh.shares : null,
        ...(sh.note ? { sharesNote: sh.note } : {}),
      },
      financials: f
        ? {
            report: {
              rceptNo: f.report.rceptNoReturned ?? f.report.rceptNo,
              name: f.report.reportName,
              filedDate: f.report.rceptDate,
              period: f.report.period,
              fs: f.report.fsDiv,
            },
            ...(fu ?? {}),
            ...(f.error ? { error: f.error } : {}),
          }
        : null,
    };
  }
  return { out, stats, engineMix };
}

// ─── 메인 ───

async function main() {
  if (!apiKey) {
    console.error("OPENDART_API_KEY 환경변수를 설정해주세요.");
    process.exit(1);
  }
  const { dates, financialsOnly, codes, outDir } = parseArgs();
  const pickStocks = (asOf: string) => getStocks(asOf).filter((s) => !codes || codes.has(s.code));
  if (!dates.length) {
    console.log("수집할 기준일 없음 (인자로 YYYYMMDD 또는 --latest)");
    return;
  }
  ensureDir(SHARED_DIR);
  ensureDir(PROGRESS_DIR);
  const maxDate = dates[dates.length - 1];
  const allStocks = pickStocks(maxDate);
  try {
    const lists = await ensureReportLists(allStocks, maxDate);
    const listed = await collectListedRef(allStocks);
    for (const asOf of dates) {
      console.log(`\n══ ${asOf} ══`);
      const stocks = pickStocks(asOf);
      const { fin, pick } = await collectFinancials(stocks, asOf, lists);
      const prices = await collectPrices(stocks, asOf);
      const betas = financialsOnly && fs.existsSync(path.join(PROGRESS_DIR, `beta-${asOf}.json`))
        ? (loadJson(path.join(PROGRESS_DIR, `beta-${asOf}.json`)) as Record<string, { weekly: BetaGrid; monthly: BetaGrid }>)
        : await collectBetas(stocks, asOf);
      const { out, stats, engineMix } = assemble(stocks, asOf, fin, pick, listed, prices, betas, lists);
      const dest = outDir ?? BASE_DIR;
      ensureDir(dest);
      saveJson(path.join(dest, `${asOf}.json`), out);
      const meta = {
        valuationDate: asOf,
        // 선택 보고서가 모두 현재 판일 때만 현재 판 — 아니면 --latest 가 이 기준일을 다시 고른다
        engine: Object.keys(engineMix).every((k) => k === ENGINE_VERSION) ? ENGINE_VERSION : `${ENGINE_VERSION}(혼합)`,
        engineMix,
        generatedAt: new Date().toISOString(),
        financialsPolicy: "기준일 당시 공시된 최신 정기보고서",
        stats,
      };
      fs.writeFileSync(path.join(dest, `${asOf}.meta.json`), JSON.stringify(meta, null, 2) + "\n");
      console.log(`[저장] ${asOf}.json — ${JSON.stringify(stats)}`);
    }
  } catch (e) {
    if (e instanceof FatalApiError) {
      console.error(`\nDART 호출 한도 등으로 중단: ${e.message}\n진행 파일이 저장되어 있으니 내일 같은 명령으로 이어서 실행하세요.`);
      process.exit(2);
    }
    throw e;
  }
}

main();
