/**
 * 기준일 시점 재무 조회 — 수집 스크립트(collect-valuation-cache)와 실시간 도구
 * (valuation_get_data 비캐시 경로)가 같은 규칙을 쓰도록 한 곳에 둔다.
 *
 *  1. 기준일 당시 최신 정기보고서 선택(report-asof)
 *  2. 재무상태표 → 이자부부채 엔진 v2, 필요 시 XBRL 주석 보충
 *  3. 현금·자본·실적(fundamentals)
 *  4. 주식수 — 해당 보고서 → (3분기면) 같은 해 반기 → 직전 사업보고서
 *
 * 원자료 보관(RawStore, 선택): 보고서 단위로 재무 행·XBRL 주석 사실·주식수를 남겨 두면
 * 엔진을 고친 뒤 다시 계산할 때 DART 를 다시 부르지 않는다(수집 스크립트·검증 코퍼스).
 */
import { fetchFinancials, fetchStockQuantity, extractSharesInfo } from "../opendart/client";
import { computeIbdV2, applyXbrlSupplement, setXbrlStatus, toCompactIbd, IBD_ENGINE_VERSION, type IbdV2Result, type XbrlStatus } from "../opendart/ibd-engine";
import { fetchXbrlXmlStatus, parseXbrlInstantFacts, summarizeXbrlDebt, type XbrlFacts, type XbrlScope } from "../opendart/xbrl-debt-facts";
import type { DartFinancialItem } from "../opendart/types";
import { fetchPeriodicReports, selectAsOfReport, monthsBeforeDate, type AsOfReport } from "../opendart/report-asof";
import { extractFundamentals, type Fundamentals } from "../opendart/fundamentals";

export interface FinResult {
  report: AsOfReport & { fsDiv: "CFS" | "OFS" | null; bsnsYear: string | null; rceptNoReturned: string | null };
  ibd: ReturnType<typeof toCompactIbd>;
  ibdExcluded: string | null;
  xbrlSupplemented: boolean;
  fundamentals: Fundamentals | null;
  sharesDart: number | null;
  /** 주식수를 다른 보고서에서 가져왔으면 그 보고서 */
  sharesSource?: string;
  /** 계산한 이자부부채 엔진 판(IBD_ENGINE_VERSION) */
  engine?: string;
  /** 주석 XBRL 상태(not_needed 이면 생략) — xml_error 면 수집기가 다시 계산 */
  xbrlStatus?: XbrlStatus;
  /** xml_error 누적 횟수 — 상한을 넘으면 재시도 중단 */
  xbrlRetries?: number;
  /** '금융부채'로 묶여 주석 보충이 필요했던 구역과 적용 결과 — 수집기 이력 경고용 */
  aggregatedSections?: ("current" | "nonCurrent")[];
  xbrlApplied?: { debt: boolean; lease: boolean };
  error?: string;
}

export interface CompanyRef {
  corpCode: string;
  industryCode?: string | null;
  accMonth?: string | null;
}

/** 호출 한도 초과 같은 치명 오류 감지 — 수집 스크립트가 중단 판단에 쓴다 */
export type FatalCheck = (e: unknown) => void;

/** 보고서 한 건의 원자료 — 재계산·검증용 */
export interface RawReport {
  /** 1 = v2.2 이전(xbrl=null 에 통신 오류가 섞였을 수 있음), 2 = null 은 DART 013·014 로 확인된 '없음' */
  v: 1 | 2;
  /** DART 가 돌려준 접수번호(정정본이면 선택 보고서와 다를 수 있음) */
  rceptNoReturned: string;
  bsnsYear: string;
  fsDiv: "CFS" | "OFS";
  /** 재무상태표·손익(BS·IS·CIS) 행 — 필요한 필드만 */
  items: DartFinancialItem[];
  /** 주석 XBRL 의 당기말 차원 없는 사실(차입·사채·리스·부채 계열). null = 받았지만 없음, 없으면 아직 안 받음 */
  xbrl?: { scope: XbrlScope; facts: XbrlFacts } | null;
  /** 주식수 조회 결과(체인 적용 후). 없으면 아직 안 받음 */
  shares?: { outstanding: number | null; source?: string };
}

export interface RawStore {
  get(rceptNo: string): RawReport | null;
  put(rceptNo: string, raw: RawReport): void;
}

const KEEP_SJ = new Set(["BS", "IS", "CIS"]);
function trimItems(items: DartFinancialItem[]): DartFinancialItem[] {
  return items
    .filter((i) => KEEP_SJ.has(i.sj_div))
    .map((i) => ({
      rcept_no: i.rcept_no,
      bsns_year: i.bsns_year,
      reprt_code: i.reprt_code,
      account_id: i.account_id,
      account_nm: i.account_nm,
      fs_div: i.fs_div,
      fs_nm: i.fs_nm,
      sj_div: i.sj_div,
      sj_nm: i.sj_nm,
      thstrm_nm: i.thstrm_nm,
      thstrm_dt: i.thstrm_dt,
      thstrm_amount: i.thstrm_amount,
      ...(i.thstrm_add_amount != null ? { thstrm_add_amount: i.thstrm_add_amount } : {}),
      frmtrm_nm: i.frmtrm_nm,
      frmtrm_amount: i.frmtrm_amount,
      ord: i.ord,
    }));
}

/** 주석 XBRL 을 (다시) 받아야 하는지 — 아직 안 받았거나, v1 이 저장한 null(통신 오류가 섞였을 수 있음) */
export const needsXbrlFetch = (raw: RawReport) => raw.xbrl === undefined || (raw.v === 1 && raw.xbrl === null);

/** 주석 XBRL 사실을 원자료에 채운다(필요할 때만 DART 호출). 검증 코퍼스는 모든 회사에 대해 부른다 */
export async function ensureXbrlFacts(
  raw: RawReport,
  reprtCode: string,
  apiKey?: string,
  onError: FatalCheck = () => {},
): Promise<RawReport["xbrl"]> {
  if (!needsXbrlFetch(raw)) return raw.xbrl;
  const got = await fetchXbrlXmlStatus(raw.rceptNoReturned, reprtCode, apiKey);
  // 통신 오류·한도 초과는 남기지 않는다(그대로 두고 다음 실행에서 다시 받음)
  if (got.status === "error") {
    onError(new Error(got.message ?? "XBRL 조회 오류"));
    return raw.xbrl;
  }
  const scope: XbrlScope = raw.fsDiv === "OFS" ? "SeparateMember" : "ConsolidatedMember";
  raw.xbrl = got.xml ? { scope, facts: parseXbrlInstantFacts(got.xml, raw.bsnsYear, scope) } : null;
  raw.v = 2;
  return raw.xbrl;
}

export function emptyFin(rep: AsOfReport, error?: string): FinResult {
  return {
    report: { ...rep, fsDiv: null, bsnsYear: null, rceptNoReturned: null },
    ibd: null,
    ibdExcluded: null,
    xbrlSupplemented: false,
    fundamentals: null,
    sharesDart: null,
    engine: IBD_ENGINE_VERSION,
    ...(error ? { error } : {}),
  };
}

/**
 * 원자료로 이자부부채 산정(순수 — 네트워크 없음). 수집·실시간 도구·검증 스크립트가 같은 경로를 쓴다.
 * 본문이 '금융부채'로 묶였고 원자료에 주석 XBRL 사실이 있으면 보충한다.
 */
export function computeIbdFromRaw(
  raw: RawReport,
  industryCode?: string | null,
  opts: { xbrlFetchFailed?: boolean } = {},
): IbdV2Result {
  const r = computeIbdV2(raw.items, { industryCode });
  const agg = r.meta.aggregatedFinancialLiabilities;
  if (!r.excluded && (agg.current || agg.nonCurrent)) {
    if (opts.xbrlFetchFailed) setXbrlStatus(r, "xml_error");
    else if (raw.xbrl && Object.keys(raw.xbrl.facts).length === 0) setXbrlStatus(r, "context_not_found");
    else if (raw.xbrl) applyXbrlSupplement(r, summarizeXbrlDebt(raw.xbrl.facts));
    else if (raw.xbrl === null && raw.v === 2) setXbrlStatus(r, "xml_absent");
    else setXbrlStatus(r, "not_fetched"); // 오프라인 재계산에서 아직 못 받았거나 옛 null
  }
  return r;
}

export async function fetchFinForReport(
  c: CompanyRef,
  rep: AsOfReport,
  apiKey?: string,
  onError: FatalCheck = () => {},
  store?: RawStore,
  /** 이전 계산 결과의 주식수 — 원자료에 주식수가 없을 때 DART 를 다시 부르지 않고 쓴다(값이 있을 때만) */
  knownShares?: { sharesDart: number | null; sharesSource?: string },
): Promise<FinResult> {
  const base = emptyFin(rep);
  let raw = store?.get(rep.rceptNo) ?? null;
  let dirty = false;
  if (!raw) {
    // 사업연도 후보를 시도해 응답 접수번호가 선택 보고서와 같은 것을 채택(정정본이면 다를 수 있음)
    let items: DartFinancialItem[] = [];
    let year = "";
    for (const y of rep.yearCandidates) {
      const got = await fetchFinancials(c.corpCode, y, rep.reprtCode, "CFS", apiKey);
      if (got.length === 0) continue;
      if (items.length === 0 || got[0].rcept_no === rep.rceptNo) {
        items = got;
        year = y;
      }
      if (got[0].rcept_no === rep.rceptNo) break;
    }
    if (items.length === 0) return { ...base, error: "재무제표 없음" };
    raw = {
      v: 2,
      rceptNoReturned: items[0].rcept_no,
      bsnsYear: year,
      // fetchFinancials 는 연결이 없으면 별도로 폴백하며, 실제 조회 구분을 fs_div 에 붙여 준다
      fsDiv: items[0].fs_div === "OFS" ? "OFS" : "CFS",
      items: trimItems(items),
    };
    dirty = true;
  }
  const items = raw.items;
  base.report.bsnsYear = raw.bsnsYear;
  base.report.rceptNoReturned = raw.rceptNoReturned;
  base.report.fsDiv = raw.fsDiv;

  // 본문이 '금융부채'로 묶였으면 주석 XBRL 이 필요 — 원자료에 없을 때만 받는다
  const probe = computeIbdV2(items, { industryCode: c.industryCode });
  const agg = probe.meta.aggregatedFinancialLiabilities;
  let xbrlFetchFailed = false;
  if (!probe.excluded && (agg.current || agg.nonCurrent) && needsXbrlFetch(raw)) {
    await ensureXbrlFacts(raw, rep.reprtCode, apiKey, (e) => {
      xbrlFetchFailed = true;
      onError(e);
    });
    if (!xbrlFetchFailed) dirty = true;
  }
  const r = computeIbdFromRaw(raw, c.industryCode, { xbrlFetchFailed });
  base.ibd = toCompactIbd(r);
  base.ibdExcluded = r.excluded;
  base.xbrlSupplemented = r.meta.xbrlSupplemented;
  if (r.meta.xbrlStatus && r.meta.xbrlStatus !== "not_needed") base.xbrlStatus = r.meta.xbrlStatus;
  const aggS = (["current", "nonCurrent"] as const).filter((s) => r.meta.aggregatedFinancialLiabilities[s]);
  if (aggS.length) {
    base.aggregatedSections = [...aggS];
    base.xbrlApplied = r.meta.xbrlApplied;
  }

  const monthsInto = { "11013": 3, "11012": 6, "11014": 9, "11011": 12 }[rep.reprtCode];
  base.fundamentals = extractFundamentals(items, monthsInto);

  // 주식수 — 분기보고서는 주식총수를 '-'로 두는 회사가 많다(삼성전자 2025.3Q 등).
  if (!raw.shares && knownShares?.sharesDart) {
    raw.shares = { outstanding: knownShares.sharesDart, ...(knownShares.sharesSource ? { source: knownShares.sharesSource } : {}) };
    dirty = true;
  }
  if (!raw.shares) {
    const y = Number(base.report.bsnsYear);
    const chain: [string, string, string | undefined][] = [[String(y), rep.reprtCode, undefined]];
    if (rep.reprtCode === "11014") chain.push([String(y), "11012", `${y} 반기보고서`]);
    if (rep.reprtCode !== "11011") chain.push([String(y - 1), "11011", `${y - 1} 사업보고서`]);
    let got: RawReport["shares"] = { outstanding: null };
    let failed = false;
    for (const [yr, rc, label] of chain) {
      try {
        const qty = await fetchStockQuantity(c.corpCode, yr, rc, apiKey);
        const n = extractSharesInfo(qty, yr, rc)?.outstanding ?? null;
        if (n && n > 0) {
          got = { outstanding: n, ...(label ? { source: label } : {}) };
          break;
        }
      } catch (e) {
        onError(e);
        failed = true;
      }
    }
    // 호출 오류로 못 받은 경우는 남기지 않는다(다음 실행에서 다시 시도)
    if (!failed || got.outstanding) {
      raw.shares = got;
      dirty = true;
    }
    if (got.outstanding) {
      base.sharesDart = got.outstanding;
      if (got.source) base.sharesSource = got.source;
    }
  } else if (raw.shares.outstanding) {
    base.sharesDart = raw.shares.outstanding;
    if (raw.shares.source) base.sharesSource = raw.shares.source;
  }
  if (store && dirty) store.put(rep.rceptNo, raw);
  return base;
}

/** 실시간 도구용 — 공시 목록 조회부터 한 번에(기준일 전 24개월 목록) */
export async function resolveAsOfFinancials(
  c: CompanyRef,
  asOf: string,
  apiKey?: string,
): Promise<FinResult | null> {
  const docs = await fetchPeriodicReports(c.corpCode, monthsBeforeDate(asOf, 24), asOf, apiKey);
  const rep = selectAsOfReport(docs, asOf, c.accMonth ?? undefined);
  if (!rep) return null;
  return fetchFinForReport(c, rep, apiKey);
}
