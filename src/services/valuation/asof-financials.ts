/**
 * 기준일 시점 재무 조회 — 수집 스크립트(collect-valuation-cache)와 실시간 도구
 * (valuation_get_data 비캐시 경로)가 같은 규칙을 쓰도록 한 곳에 둔다.
 *
 *  1. 기준일 당시 최신 정기보고서 선택(report-asof)
 *  2. 재무상태표 → 이자부부채 엔진 v2, 필요 시 XBRL 주석 보충
 *  3. 현금·자본·실적(fundamentals)
 *  4. 주식수 — 해당 보고서 → (3분기면) 같은 해 반기 → 직전 사업보고서
 */
import { fetchFinancials, fetchStockQuantity, extractSharesInfo } from "../opendart/client";
import { computeIbdV2, applyXbrlSupplement, toCompactIbd } from "../opendart/ibd-engine";
import { fetchXbrlXml, parseXbrlDebtFacts, summarizeXbrlDebt } from "../opendart/xbrl-debt-facts";
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
  error?: string;
}

export interface CompanyRef {
  corpCode: string;
  industryCode?: string | null;
  accMonth?: string | null;
}

/** 호출 한도 초과 같은 치명 오류 감지 — 수집 스크립트가 중단 판단에 쓴다 */
export type FatalCheck = (e: unknown) => void;

export function emptyFin(rep: AsOfReport, error?: string): FinResult {
  return {
    report: { ...rep, fsDiv: null, bsnsYear: null, rceptNoReturned: null },
    ibd: null,
    ibdExcluded: null,
    xbrlSupplemented: false,
    fundamentals: null,
    sharesDart: null,
    ...(error ? { error } : {}),
  };
}

export async function fetchFinForReport(
  c: CompanyRef,
  rep: AsOfReport,
  apiKey?: string,
  onError: FatalCheck = () => {},
): Promise<FinResult> {
  const base = emptyFin(rep);
  // 사업연도 후보를 시도해 응답 접수번호가 선택 보고서와 같은 것을 채택(정정본이면 다를 수 있음)
  let items: Awaited<ReturnType<typeof fetchFinancials>> = [];
  for (const y of rep.yearCandidates) {
    const got = await fetchFinancials(c.corpCode, y, rep.reprtCode, "CFS", apiKey);
    if (got.length === 0) continue;
    if (items.length === 0 || got[0].rcept_no === rep.rceptNo) {
      items = got;
      base.report.bsnsYear = y;
    }
    if (got[0].rcept_no === rep.rceptNo) break;
  }
  if (items.length === 0) return { ...base, error: "재무제표 없음" };
  base.report.rceptNoReturned = items[0].rcept_no;
  // fetchFinancials 는 연결이 없으면 별도로 폴백하며, 실제 조회 구분을 fs_div 에 붙여 준다
  base.report.fsDiv = items[0].fs_div === "OFS" ? "OFS" : "CFS";

  const r = computeIbdV2(items, { industryCode: c.industryCode });
  const agg = r.meta.aggregatedFinancialLiabilities;
  if (!r.excluded && (agg.current || agg.nonCurrent)) {
    const xml = await fetchXbrlXml(items[0].rcept_no, rep.reprtCode, apiKey);
    if (xml) {
      const scope = base.report.fsDiv === "OFS" ? "SeparateMember" : "ConsolidatedMember";
      applyXbrlSupplement(r, summarizeXbrlDebt(parseXbrlDebtFacts(xml, base.report.bsnsYear, scope)));
    }
  }
  base.ibd = toCompactIbd(r);
  base.ibdExcluded = r.excluded;
  base.xbrlSupplemented = r.meta.xbrlSupplemented;

  const monthsInto = { "11013": 3, "11012": 6, "11014": 9, "11011": 12 }[rep.reprtCode];
  base.fundamentals = extractFundamentals(items, monthsInto);

  // 주식수 — 분기보고서는 주식총수를 '-'로 두는 회사가 많다(삼성전자 2025.3Q 등).
  const y = Number(base.report.bsnsYear);
  const chain: [string, string, string | undefined][] = [[String(y), rep.reprtCode, undefined]];
  if (rep.reprtCode === "11014") chain.push([String(y), "11012", `${y} 반기보고서`]);
  if (rep.reprtCode !== "11011") chain.push([String(y - 1), "11011", `${y - 1} 사업보고서`]);
  for (const [yr, rc, label] of chain) {
    try {
      const qty = await fetchStockQuantity(c.corpCode, yr, rc, apiKey);
      const n = extractSharesInfo(qty, yr, rc)?.outstanding ?? null;
      if (n && n > 0) {
        base.sharesDart = n;
        if (label) base.sharesSource = label;
        break;
      }
    } catch (e) {
      onError(e);
    }
  }
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
