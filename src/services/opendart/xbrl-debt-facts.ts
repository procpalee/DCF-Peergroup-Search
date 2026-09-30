/**
 * XBRL 인스턴스에서 차입금·사채·리스부채 "차원 없는" 사실(fact)을 읽어
 * 이자부부채 엔진 v2 의 보충 자료로 쓴다.
 *
 * 쓰임: 재무상태표 본문이 차입금·사채를 "유동금융부채·비유동금융부채"로 묶어 표시해
 * 본문만으로는 이자부부채를 가를 수 없는 회사(한국전력·셀트리온 등). 이런 회사도
 * 주석에는 표준 요소로 금액을 태깅한다.
 *
 * 규칙 — 포괄 요소를 우선하고, 없을 때만 세부 요소를 합산한다(포함관계 이중계상 방지).
 *   유동:   CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings
 *           ↳ 없으면 CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived(또는
 *             ShorttermBorrowings + CurrentPortionOfLongtermBorrowings)
 *             + CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued
 *   비유동: NoncurrentPortionOfNoncurrentBorrowings
 *           ↳ 없으면 NoncurrentPortionOfNoncurrentLoansReceived + NoncurrentPortionOfNoncurrentBondsIssued
 *   리스:   CurrentLeaseLiabilities / NoncurrentLeaseLiabilities
 *   검증:   Borrowings(차입금 총계)와 유동+비유동 대조
 * 실측(한국전력 2025): 유동 45.89조 + 비유동 83.88조 = Borrowings 129.77조, 리스 3.15조.
 */
import axios from "axios";
import AdmZip from "adm-zip";
import { DART_API_BASE } from "./constants";

export type XbrlScope = "ConsolidatedMember" | "SeparateMember";

/** 차원 없는(범위 축만 있는) 당기말 사실 — 요소명(접두 제거) → 금액 */
export type XbrlFacts = Record<string, number>;

const WANTED = new Set([
  "Borrowings",
  "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings",
  "NoncurrentPortionOfNoncurrentBorrowings",
  "CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived",
  "ShorttermBorrowings",
  "CurrentPortionOfLongtermBorrowings",
  "CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued",
  "NoncurrentPortionOfNoncurrentLoansReceived",
  "NoncurrentPortionOfNoncurrentBondsIssued",
  "CurrentLeaseLiabilities",
  "NoncurrentLeaseLiabilities",
  "LeaseLiabilities",
  // 유동/비유동 구분 태그가 없는 회사의 대체 총액(LG디스플레이 2025 등)
  "LoansReceived",
  "BondsIssued",
  // 표준 요소가 없을 때만 쓰는 대체 요소(셀트리온 장기차입금, HD한국조선해양 기타차입금 등)
  "LongtermBorrowings",
  "OtherCurrentBorrowingsAndCurrentPortionOfOtherNoncurrentBorrowings",
  "NoncurrentPortionOfOtherNoncurrentBorrowings",
  "OtherBorrowings",
  "LiabilitiesArisingFromFinancingActivities",
]);

/** DART '공시금액' 열 — 이 축 하나만 더 붙은 문맥은 의미상 차원 없는 값과 같다 */
export const REPORTED_AMOUNT_SUFFIX =
  "_ifrs-full_CarryingAmountAccumulatedDepreciationAmortisationAndImpairmentAndGrossCarryingAmountAxis_dart_ReportedAmountMember";

/**
 * xbrl 문자열에서 scope(연결/별도)의 당기말 "차원 없는" 사실만 모은다.
 * DART context id: C(당기)FY{연도}e(시점){기간코드}_…Axis_ifrs-full_{scope}
 *   사업보고서 CFY2025eFY, 분기·반기 CFY2025eTQA 등 — 기간코드가 보고서마다 다르므로
 *   "당기(C)·시점(e)·범위 축으로 끝남" 조건으로 찾는다(다른 축이 붙은 context 는 제외).
 * year 는 참고용(여러 개가 걸리면 그 연도를 우선).
 */
export function parseXbrlDebtFacts(xml: string, year: string | null, scope: XbrlScope): XbrlFacts {
  return parseXbrlInstantFacts(xml, year, scope, (el, prefix) => prefix === "ifrs-full" && WANTED.has(el));
}

/** 원자료 보관·검증용으로 남길 요소 — 차입·사채·리스·부채 계열 */
export const DEBTISH_ELEMENT = /Borrow|Loan|Bond|Lease|Debenture|CommercialPaper|Overdraft|Liabilit|Debt|Securitiz|Preference/i;

/**
 * scope(연결/별도)의 당기말 "차원 없는" 사실을 모은다(요소 필터 선택).
 * 키: ifrs-full 요소는 접두 없이(예: Borrowings), 그 밖(dart·entity 확장)은 "접두:요소".
 * 같은 요소가 같은 문맥에 여러 번 태깅되면(주석 표마다 부분합 — LG디스플레이 2025 LoansReceived 8.31조·12.14조)
 * 큰 값(총액)을 쓴다.
 */
export function parseXbrlInstantFacts(
  xml: string,
  year: string | null,
  scope: XbrlScope,
  keep: (element: string, prefix: string) => boolean = (el) => DEBTISH_ELEMENT.test(el),
): XbrlFacts {
  return parseXbrlInstantFactSets(xml, year, scope, keep).facts;
}

/**
 * 차원 없는 문맥(facts)과 '공시금액' 문맥(factsRpt)을 따로 모은다.
 * 셀트리온·코스맥스·기아처럼 차입금·리스를 공시금액 문맥에만 태깅한 회사가 있다(2026-10-01 블라인드 검증).
 * 두 값을 max 로 섞지 않는다 — 요약(summarizeXbrlDebt)에서 차원 없는 값을 우선하고 없을 때만 공시금액을 쓴다.
 */
export function parseXbrlInstantFactSets(
  xml: string,
  year: string | null,
  scope: XbrlScope,
  keep: (element: string, prefix: string) => boolean = (el) => DEBTISH_ELEMENT.test(el),
): { facts: XbrlFacts; factsRpt: XbrlFacts } {
  const suffix = `_ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_${scope}`;
  const ctxRe = new RegExp(`context id="(CFY(\\d{4})e[A-Za-z0-9]*${suffix})"`, "g");
  const candidates = [...xml.matchAll(ctxRe)].map((m) => ({ id: m[1], y: m[2] }));
  const chosen = candidates.find((c) => c.y === year) ?? candidates[0];
  if (!chosen) return { facts: {}, factsRpt: {} };
  const rptId = chosen.id + REPORTED_AMOUNT_SUFFIX;
  const facts: XbrlFacts = {};
  const factsRpt: XbrlFacts = {};
  const re = /<([A-Za-z][\w-]*):([A-Za-z]\w*) [^>]*contextRef="([^"]+)"[^>]*>(-?\d+)</g;
  for (const m of xml.matchAll(re)) {
    const [, prefix, el, ctx, v] = m;
    const target = ctx === chosen.id ? facts : ctx === rptId ? factsRpt : null;
    if (!target || !keep(el, prefix)) continue;
    const key = prefix === "ifrs-full" ? el : `${prefix}:${el}`;
    target[key] = Math.max(target[key] ?? -Infinity, Number(v));
  }
  return { facts, factsRpt };
}

/**
 * 1000바이트 미만 응답 판정 — 자료 없음(013)·파일 없음(014)만 absent, 나머지(상태 코드 없음 포함)는 오류.
 * 메시지 앞에 'status: NNN' 을 붙여 수집기의 한도 초과(020) 감지가 동작하게 한다.
 */
export function classifyXbrlShortResponse(msg: string): { status: "absent" | "error"; message: string } {
  const st = msg.match(/<status>(\d{3})<\/status>/)?.[1] ?? msg.match(/"status"\s*:\s*"(\d{3})"/)?.[1];
  if (st === "013" || st === "014") return { status: "absent", message: msg.slice(0, 200) };
  return { status: "error", message: `status: ${st ?? "?"} ${msg.slice(0, 200)}` };
}

export async function fetchXbrlXml(rceptNo: string, reprtCode: string, apiKey?: string): Promise<string | null> {
  return (await fetchXbrlXmlStatus(rceptNo, reprtCode, apiKey)).xml;
}

/**
 * XBRL 인스턴스 조회 — 없음(absent: DART 가 파일을 주지 않음)과 오류(error: 한도 초과·시간 초과·통신)를 구분한다.
 * 오류는 원자료에 남기지 않고 다음 수집에서 다시 시도해야 한다.
 */
export async function fetchXbrlXmlStatus(
  rceptNo: string,
  reprtCode: string,
  apiKey?: string,
): Promise<{ status: "ok" | "absent" | "error"; xml: string | null; message?: string }> {
  const key = apiKey || process.env.OPENDART_API_KEY;
  if (!key) return { status: "error", xml: null, message: "API 키 없음" };
  try {
    const res = await axios.get(`${DART_API_BASE}/fnlttXbrl.xml`, {
      params: { crtfc_key: key, rcept_no: rceptNo, reprt_code: reprtCode },
      responseType: "arraybuffer",
      timeout: 60000,
    });
    const buf = Buffer.from(res.data);
    if (buf.length < 1000) {
      const c = classifyXbrlShortResponse(buf.toString("utf8"));
      return { status: c.status, xml: null, message: c.message };
    }
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".xbrl"));
    return entry ? { status: "ok", xml: entry.getData().toString("utf8") } : { status: "absent", xml: null };
  } catch (e) {
    return { status: "error", xml: null, message: (e as Error).message };
  }
}

export interface XbrlDebtSummary {
  current: number | null;
  nonCurrent: number | null;
  leaseCurrent: number | null;
  leaseNonCurrent: number | null;
  /** 차입금 총계 — Borrowings, 없으면 LoansReceived + BondsIssued (유동/비유동 구분 태그가 없을 때 대체용) */
  total: number | null;
  /** total 을 LoansReceived·BondsIssued 로 만들었으면 true — 포괄 범위가 회사마다 달라 원문 확인 권장 */
  totalPartial: boolean;
  /** 리스부채 총계(유동/비유동 구분 없을 때) */
  leaseTotal: number | null;
  /** 유동+비유동 과 Borrowings 총계 대조 결과(없으면 null) */
  reconciles: boolean | null;
  /** 구성 요소 — 주석 보충 행을 차입금/사채로 나누고, 총계 폴백에서 본문과 대조할 때 쓴다 */
  currentLoans: number | null;
  currentBonds: number | null;
  nonCurrentLoans: number | null;
  nonCurrentBonds: number | null;
  borrowings: number | null;
  loansReceived: number | null;
  bondsIssued: number | null;
  /** 재무활동에서 생기는 부채 조정표의 기말 합계(차입·사채·리스 등) — 완전성 점검용 */
  laffa: number | null;
  /** 유동/비유동 값에 대체 요소(장기차입금·기타차입금·dart 사채)를 썼으면 true */
  usedFallback: boolean;
}

const sumDefined = (...xs: (number | null | undefined)[]) => {
  const d = xs.filter((x): x is number => typeof x === "number");
  return d.length ? d.reduce((a, b) => a + b, 0) : null;
};

/**
 * '공시금액' 문맥(rpt)을 우선하고, 없는 요소만 차원 없는 사실(f0)로 채운 뒤 요약한다.
 * 규칙 — 포괄 요소를 우선하고, 없을 때만 세부 요소를 합산한다(포함관계 이중계상 방지).
 * 표준 요소가 없을 때만 대체 요소를 쓴다(장기차입금·기타차입금·dart 유동성사채/사채).
 */
export function summarizeXbrlDebt(f0: XbrlFacts, rpt: XbrlFacts = {}): XbrlDebtSummary {
  // '공시금액' 문맥이 재무제표에 표시된 값 — 있으면 그것을 쓰고, 없는 요소만 차원 없는 값으로(삼성SDI 리스 등, 2026-10-01 대조)
  const f: XbrlFacts = { ...f0, ...rpt };
  const abs = (v: number | undefined) => (v == null ? undefined : Math.abs(v));
  let usedFallback = false;
  const fb = (v: number | null | undefined, alt: number | null | undefined): number | undefined => {
    if (v != null) return v;
    if (alt != null) usedFallback = true;
    return alt ?? undefined;
  };
  const curLoansStd =
    f.CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived ??
    sumDefined(f.ShorttermBorrowings, f.CurrentPortionOfLongtermBorrowings);
  const curLoans = fb(curLoansStd, f.OtherCurrentBorrowingsAndCurrentPortionOfOtherNoncurrentBorrowings);
  const curBonds = fb(f.CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued, abs(f["dart:CurrentPortionOfBonds"]));
  const ncLoans = fb(fb(f.NoncurrentPortionOfNoncurrentLoansReceived, f.NoncurrentPortionOfOtherNoncurrentBorrowings), f.LongtermBorrowings);
  const ncBonds = fb(f.NoncurrentPortionOfNoncurrentBondsIssued, abs(f["dart:NonCurrentBonds"] ?? f["dart:Bonds"]));
  const current = f.CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings ?? sumDefined(curLoans, curBonds);
  const nonCurrent = f.NoncurrentPortionOfNoncurrentBorrowings ?? sumDefined(ncLoans, ncBonds);
  let reconciles: boolean | null = null;
  if (f.Borrowings && current != null && nonCurrent != null) {
    reconciles = Math.abs(current + nonCurrent - f.Borrowings) / f.Borrowings < 0.01;
  }
  return {
    current,
    nonCurrent,
    leaseCurrent: f.CurrentLeaseLiabilities ?? null,
    leaseNonCurrent: f.NoncurrentLeaseLiabilities ?? null,
    total: f.Borrowings ?? f.OtherBorrowings ?? sumDefined(f.LoansReceived, f.BondsIssued),
    totalPartial: f.Borrowings == null && (f.OtherBorrowings != null || f.LoansReceived != null || f.BondsIssued != null),
    leaseTotal: f.LeaseLiabilities ?? null,
    reconciles,
    currentLoans: curLoans ?? null,
    currentBonds: curBonds ?? null,
    nonCurrentLoans: ncLoans ?? null,
    nonCurrentBonds: ncBonds ?? null,
    borrowings: f.Borrowings ?? null,
    loansReceived: f.LoansReceived ?? null,
    bondsIssued: f.BondsIssued ?? null,
    laffa: f.LiabilitiesArisingFromFinancingActivities ?? null,
    usedFallback,
  };
}
