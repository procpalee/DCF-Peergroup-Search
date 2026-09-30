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
]);

/**
 * xbrl 문자열에서 scope(연결/별도)의 당기말 "차원 없는" 사실만 모은다.
 * DART context id: C(당기)FY{연도}e(시점){기간코드}_…Axis_ifrs-full_{scope}
 *   사업보고서 CFY2025eFY, 분기·반기 CFY2025eTQA 등 — 기간코드가 보고서마다 다르므로
 *   "당기(C)·시점(e)·범위 축으로 끝남" 조건으로 찾는다(다른 축이 붙은 context 는 제외).
 * year 는 참고용(여러 개가 걸리면 그 연도를 우선).
 */
export function parseXbrlDebtFacts(xml: string, year: string | null, scope: XbrlScope): XbrlFacts {
  const suffix = `_ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_${scope}`;
  const ctxRe = new RegExp(`context id="(CFY(\\d{4})e[A-Za-z0-9]*${suffix})"`, "g");
  const candidates = [...xml.matchAll(ctxRe)].map((m) => ({ id: m[1], y: m[2] }));
  const chosen = candidates.find((c) => c.y === year) ?? candidates[0];
  if (!chosen) return {};
  const facts: XbrlFacts = {};
  const re = /<ifrs-full:([A-Za-z]+) [^>]*contextRef="([^"]+)"[^>]*>(-?\d+)</g;
  for (const m of xml.matchAll(re)) {
    const [, el, ctx, v] = m;
    if (ctx !== chosen.id || !WANTED.has(el)) continue;
    // 같은 요소가 같은 문맥에 여러 번 태깅되면(주석 표마다 부분합 — LG디스플레이 2025 LoansReceived 8.31조·12.14조)
    // 큰 값(총액)을 쓴다
    facts[el] = Math.max(facts[el] ?? -Infinity, Number(v));
  }
  return facts;
}

export async function fetchXbrlXml(rceptNo: string, reprtCode: string, apiKey?: string): Promise<string | null> {
  const key = apiKey || process.env.OPENDART_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.get(`${DART_API_BASE}/fnlttXbrl.xml`, {
      params: { crtfc_key: key, rcept_no: rceptNo, reprt_code: reprtCode },
      responseType: "arraybuffer",
      timeout: 60000,
    });
    if (res.data.length < 1000) return null;
    const zip = new AdmZip(Buffer.from(res.data));
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".xbrl"));
    return entry ? entry.getData().toString("utf8") : null;
  } catch {
    return null;
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
}

const sumDefined = (...xs: (number | undefined)[]) => {
  const d = xs.filter((x): x is number => typeof x === "number");
  return d.length ? d.reduce((a, b) => a + b, 0) : null;
};

export function summarizeXbrlDebt(f: XbrlFacts): XbrlDebtSummary {
  const current =
    f.CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings ??
    sumDefined(
      f.CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived ??
        sumDefined(f.ShorttermBorrowings, f.CurrentPortionOfLongtermBorrowings) ??
        undefined,
      f.CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued,
    );
  const nonCurrent =
    f.NoncurrentPortionOfNoncurrentBorrowings ??
    sumDefined(f.NoncurrentPortionOfNoncurrentLoansReceived, f.NoncurrentPortionOfNoncurrentBondsIssued);
  let reconciles: boolean | null = null;
  if (f.Borrowings && current != null && nonCurrent != null) {
    reconciles = Math.abs(current + nonCurrent - f.Borrowings) / f.Borrowings < 0.01;
  }
  return {
    current,
    nonCurrent,
    leaseCurrent: f.CurrentLeaseLiabilities ?? null,
    leaseNonCurrent: f.NoncurrentLeaseLiabilities ?? null,
    total: f.Borrowings ?? sumDefined(f.LoansReceived, f.BondsIssued),
    totalPartial: f.Borrowings == null && (f.LoansReceived != null || f.BondsIssued != null),
    leaseTotal: f.LeaseLiabilities ?? null,
    reconciles,
  };
}
