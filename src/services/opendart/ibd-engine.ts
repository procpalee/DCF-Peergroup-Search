/**
 * 이자부부채(IBD) 엔진 v2 — 재무상태표 본문(fnlttSinglAcntAll, sj_div=BS) 기준.
 *
 * v1(xbrl-parser.ts)은 XBRL 주석(재무활동 부채 변동표)의 멤버 이름을 키워드로 추측해
 * 대형주 누락(SK하이닉스 리스만 인식)·유동/비유동 오분류("noncurrent" 안의 "current",
 * "비유동" 안의 "유동")가 있었다(2026-09-30 전수 점검). v2 원칙:
 *
 *  1. 구역은 이름이 아니라 "유동부채"·"비유동부채" 머리 행으로 정한다.
 *     DART 는 각 머리 행 뒤에 그 구역의 본문 계정을 나열한다(부채총계 행은 합계라 건너뜀).
 *  2. 계정은 표준계정 ID 를 우선하고, ID 가 없거나 포괄적(Other*)이면 계정명 규칙으로 판정한다.
 *  3. 차감계정(할인발행차금·전환권조정 등)은 음수로, 상환할증금은 양수로 합산한다.
 *  4. 부채성 항목(상환전환우선주부채·신종자본증권 등)은 합계에서 분리해 따로 돌려준다.
 *  5. 금융업(유동성 배열 재무상태표·은행/보험/증권)은 이자부부채 개념이 맞지 않아 산정하지 않는다.
 *  6. 구역 행 합계와 구역 소계를 대조해 소계 행 중복 등 이상을 checks 로 남긴다.
 *
 * 순수 함수만 둔다 — 네트워크 호출은 호출부(수집 스크립트·도구)의 몫.
 */
import type { DartFinancialItem } from "./types";
import type { XbrlDebtSummary } from "./xbrl-debt-facts";

/** 엔진 판 — 수집 캐시가 이 값과 다르면 해당 보고서를 다시 계산할 수 있다 */
export const IBD_ENGINE_VERSION = "ibd-v2.1";

/** 경고(checks) 중 참고(notes)로 볼 메시지 — v2.0 캐시 이관용 */
const NOTE_PATTERNS = [/^금융 관련 업종/, /^주석 보충 적용 — 본문 '금융부채'/];

export function migrateIbdMessages<T extends { checks?: string[]; notes?: string[] }>(ibd: T | null): T | null {
  if (!ibd?.checks?.length) return ibd;
  const moved = ibd.checks.filter((c) => NOTE_PATTERNS.some((p) => p.test(c)));
  if (!moved.length) return ibd;
  const checks = ibd.checks.filter((c) => !moved.includes(c));
  const { checks: _c, ...rest } = ibd;
  return { ...rest, ...(checks.length ? { checks } : {}), notes: [...(ibd.notes ?? []), ...moved] } as T;
}

export type IbdCategory = "borrowings" | "bonds" | "lease" | "otherDebt" | "contra";
export type IbdSection = "current" | "nonCurrent" | "unclassified";

/** 출력 범주 — 차감계정은 딸린 본계정의 범주로 합산한다 */
export type IbdOutCategory = Exclude<IbdCategory, "contra">;

export interface IbdLine {
  account: string;
  amount: number;
  category: IbdCategory;
  accountId: string;
  /** 차감계정(contra)이 차감하는 본계정 범주 — 바로 앞 이자부부채 행 기준 */
  netOf?: IbdOutCategory;
}

export interface IbdV2Result {
  /** 산정 제외 사유(금융업 등). 값이 있으면 합계 필드는 0 */
  excluded: string | null;
  current: IbdLine[];
  nonCurrent: IbdLine[];
  /** 유동/비유동 구분이 없는 재무상태표에서 찾은 항목 */
  unclassified: IbdLine[];
  total: number;
  /** 합계에 넣지 않은 부채성 항목 — 포함 여부는 사용자가 판단 */
  debtLike: { account: string; amount: number; section: IbdSection }[];
  /** 산정 경고 — 원문 확인이 필요한 경우 */
  checks: string[];
  /** 참고 — 정상 처리지만 알아 둘 사항(주석 보충 적용, 금융 관련 업종 등) */
  notes: string[];
  meta: {
    fsDiv: string | null;
    rceptNo: string | null;
    periodLabel: string | null;
    sectionTotals: { current: number | null; nonCurrent: number | null };
    /** 차입금·사채 없이 "금융부채"로 묶여 표시된 금액 — 주석(XBRL) 보충 대상 */
    aggregatedFinancialLiabilities: { current: number | null; nonCurrent: number | null };
    /** 주석 보충을 적용했으면 true */
    xbrlSupplemented: boolean;
  };
}

// ─── 규칙 ───

const HDR_CURRENT_ID = "ifrs-full_CurrentLiabilities";
const HDR_NONCURRENT_ID = "ifrs-full_NoncurrentLiabilities";
const TOTAL_LIAB_ID = "ifrs-full_Liabilities";
/** 이 머리 행을 만나면 부채 구역을 벗어난다 */
const LEAVE_IDS = new Set([
  "ifrs-full_Equity",
  "ifrs-full_EquityAttributableToOwnersOfParent",
  "ifrs-full_EquityAndLiabilities",
  "ifrs-full_Assets",
  "ifrs-full_CurrentAssets",
  "ifrs-full_NoncurrentAssets",
]);

/** 계정명 정규화 — 앞 번호("Ⅰ.", "(1)", "1.")·공백 제거 */
export function normName(nm: string): string {
  return nm
    .replace(/^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|\(?\d+\)?|[가-하])\s*[.)]\s*/u, "")
    .replace(/\s+/g, "");
}

const NAME_HDR_CURRENT = /^유동부채$/;
const NAME_HDR_NONCURRENT = /^비유동부채$/;
const NAME_LEAVE = /^(자본|자본총계|자산총계|유동자산|비유동자산|자본과부채총계|부채와자본총계)$/;
const NAME_TOTAL_LIAB = /^부채총계$/;

// 표준계정 ID — 강한 신호
const ID_LEASE = /LeaseLiabilit/i;
const ID_BOND =
  /BondsIssued|ConvertibleBond|BondWithWarrant|BondsWithWarrant|ExchangeableBond|Debenture|CommercialPaper|ShortTermBonds|PortionOfBonds|dart_(?:NonCurrent)?Bonds/i;
const ID_BORROW = /Borrowings|LoansReceived|BankOverdraft/i;
/** ID 에 이 말이 있으면 부채성 차입이 아님(자산·파생·이자·보증 등) */
const ID_NOT_DEBT = /Receivable|Asset|Derivative|InterestPayable|Guarantee|Provision|Deposit/i;

// 계정명 — ID 가 없거나 포괄적일 때
const NAME_CONTRA = /할인발행차금|전환권조정|신주인수권조정|교환권조정|현재가치할인차금/;
const NAME_PREMIUM = /상환할증금/;
const NAME_DEBT_LIKE = /상환전환우선주|전환상환우선주|상환우선주|우선주부채|신종자본증권|조건부자본증권|영구채/;
const NAME_LEASE = /리스부채|판매후리스/;
const NAME_BOND = /사채|회사채|기업어음|단기사채|전자단기사채/;
const NAME_BORROW = /차입금|차입부채|당좌차월|유동성장기부채|유동화채무|유동화차입/;
/** 포괄 금융부채 행 이름(차입금·사채를 품을 수 있음) */
const NAME_AGG_FIN = /^(?:유동|비유동|단기|장기|기타)?(?:유동|비유동)?금융부채$/;
const NAME_NOT_DEBT = /보증금|예수|미지급|매입채무|충당|이연|확정급여|파생|계약부채|선수|당기법인세|미지급이자|사채이자|이자비용|대여금|채권$/;

/** 은행·보험·증권 등 이자부부채를 산정하지 않는 업종(표준산업분류 앞자리). 64992(지주회사)는 제외 */
const FINANCIAL_INDUSTRY = /^(641|65|6612|6611|6613|642)/;
/** 금융업 재무상태표에만 나오는 계정 */
const FINANCIAL_ROW_ID = /DepositsFromCustomers|InsuranceContracts|ReinsuranceContracts|FinancialLiabilitiesAtFairValueThroughProfitOrLoss/i;

function parseAmount(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/[,\s]/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const hasStdId = (id: string) => !!id && id !== "-표준계정코드 미사용-";

/** 한 행의 판정 — 이자부부채 범주, 부채성 항목, 또는 해당 없음 */
function classifyRow(id: string, name: string): IbdCategory | "debtLike" | null {
  const std = hasStdId(id);
  if (NAME_DEBT_LIKE.test(name) || /RedeemablePreference|PreferenceShares/i.test(id)) return "debtLike";
  if (NAME_CONTRA.test(name)) return "contra";
  if (NAME_PREMIUM.test(name)) return "bonds";
  if (std && !ID_NOT_DEBT.test(id)) {
    if (ID_LEASE.test(id)) return "lease";
    if (ID_BOND.test(id)) return "bonds";
    if (ID_BORROW.test(id)) {
      // "기타차입금"류 포괄 ID 라도 이름이 유동화·판매후리스면 기타차입성으로
      if (/유동화|판매후리스/.test(name)) return "otherDebt";
      return /사채/.test(name) && !/차입/.test(name) ? "bonds" : "borrowings";
    }
  }
  // ID 로 결정되지 않으면 이름 규칙 — 단, 명백한 비차입 계정은 제외
  if (NAME_NOT_DEBT.test(name)) return null;
  if (NAME_LEASE.test(name)) return /판매후리스/.test(name) ? "otherDebt" : "lease";
  if (/유동화채무|유동화차입/.test(name)) return "otherDebt";
  if (NAME_BORROW.test(name)) return "borrowings";
  if (NAME_BOND.test(name)) return "bonds";
  return null;
}

export interface IbdEngineOptions {
  /** 표준산업분류 코드(company-industry.json industryCode) — 금융업 판정 보조 */
  industryCode?: string | null;
}

export function computeIbdV2(items: DartFinancialItem[], opts: IbdEngineOptions = {}): IbdV2Result {
  const bs = items
    .filter((i) => i.sj_div === "BS")
    .sort((a, b) => Number(a.ord) - Number(b.ord));

  const res: IbdV2Result = {
    excluded: null,
    current: [],
    nonCurrent: [],
    unclassified: [],
    total: 0,
    debtLike: [],
    checks: [],
    notes: [],
    meta: {
      fsDiv: bs[0]?.fs_div ?? null,
      rceptNo: bs[0]?.rcept_no ?? null,
      periodLabel: bs[0]?.thstrm_nm ?? null,
      sectionTotals: { current: null, nonCurrent: null },
      aggregatedFinancialLiabilities: { current: null, nonCurrent: null },
      xbrlSupplemented: false,
    },
  };

  if (bs.length === 0) {
    res.checks.push("재무상태표 행 없음");
    return res;
  }

  const hasSections = bs.some(
    (r) =>
      r.account_id === HDR_CURRENT_ID ||
      r.account_id === HDR_NONCURRENT_ID ||
      NAME_HDR_CURRENT.test(normName(r.account_nm)) ||
      NAME_HDR_NONCURRENT.test(normName(r.account_nm)),
  );
  const hasFinancialRows = bs.some((r) => FINANCIAL_ROW_ID.test(r.account_id));
  const finIndustry = !!opts.industryCode && FINANCIAL_INDUSTRY.test(opts.industryCode);
  if (finIndustry || (!hasSections && hasFinancialRows)) {
    res.excluded = finIndustry
      ? "금융업(은행·보험·증권 업종) — 차입이 영업부채라 이자부부채를 산정하지 않음"
      : "금융업 형태 재무상태표(유동/비유동 구분 없음, 예수·보험·당기손익금융부채 계정) — 산정 제외";
    return res;
  }
  if (!hasSections) res.checks.push("유동/비유동 구분이 없는 재무상태표 — 항목을 미구분으로 집계");
  if (opts.industryCode && /^6[4-6]/.test(opts.industryCode) && !opts.industryCode.startsWith("64992"))
    res.notes.push(`금융 관련 업종(${opts.industryCode}) — 이자부부채 해석에 주의`);

  let section: IbdSection | null = hasSections ? null : "unclassified";
  const sectionSum = { current: 0, nonCurrent: 0 };

  for (const r of bs) {
    const id = r.account_id ?? "";
    const name = normName(r.account_nm ?? "");
    const amt = parseAmount(r.thstrm_amount);

    // 머리 행·합계 행으로 구역 전환
    if (id === HDR_CURRENT_ID || NAME_HDR_CURRENT.test(name)) {
      section = "current";
      res.meta.sectionTotals.current = amt;
      continue;
    }
    if (id === HDR_NONCURRENT_ID || NAME_HDR_NONCURRENT.test(name)) {
      section = "nonCurrent";
      res.meta.sectionTotals.nonCurrent = amt;
      continue;
    }
    if (id === TOTAL_LIAB_ID || NAME_TOTAL_LIAB.test(name)) continue;
    if (LEAVE_IDS.has(id) || NAME_LEAVE.test(name)) {
      section = hasSections ? null : "unclassified";
      continue;
    }
    if (!section || amt == null) continue;
    // 미구분 재무상태표에서는 자산 계정을 배제
    if (section === "unclassified" && /Asset|Receivable/i.test(id)) continue;

    if (section !== "unclassified") sectionSum[section] += amt;
    if (amt === 0) continue;

    // 차입금·사채를 품었을 수 있는 포괄 "금융부채" 행 — 주석 보충 판단용으로 기록만
    if (section !== "unclassified" && NAME_AGG_FIN.test(name) && /FinancialLiabilities|미사용/.test(id || "미사용")) {
      const agg = res.meta.aggregatedFinancialLiabilities;
      agg[section] = (agg[section] ?? 0) + amt;
    }

    const cat = classifyRow(id, name);
    if (!cat) continue;
    if (cat === "debtLike") {
      res.debtLike.push({ account: r.account_nm.trim(), amount: amt, section });
      continue;
    }
    // 차감계정은 표시 부호와 무관하게 음수로
    const signed = cat === "contra" ? -Math.abs(amt) : amt;
    const line: IbdLine = { account: r.account_nm.trim(), amount: signed, category: cat, accountId: id };
    if (cat === "contra") {
      const prev = [...res[section]].reverse().find((l) => l.category !== "contra");
      line.netOf = prev ? (prev.category as IbdOutCategory) : guessCategoryByName(name);
    }
    res[section].push(line);
    res.total += signed;
  }

  dedupeParentLines(res);

  // 차입금·사채가 없는 구역에 포괄 금융부채만 있으면 주석 보충이 필요하다고 표시
  for (const s of ["current", "nonCurrent"] as const) {
    const agg = res.meta.aggregatedFinancialLiabilities[s];
    const hasDebt = res[s].some((l) => l.category === "borrowings" || l.category === "bonds");
    if (!agg || hasDebt) res.meta.aggregatedFinancialLiabilities[s] = null;
  }
  const agg = res.meta.aggregatedFinancialLiabilities;
  if (agg.current || agg.nonCurrent)
    res.checks.push("차입금·사채가 '금융부채'로 묶여 표시됨 — 주석(XBRL) 보충 필요");

  // 구역 행 합계 대조 — 소계 행이 섞이면 합계가 소계보다 커진다
  for (const s of ["current", "nonCurrent"] as const) {
    const tot = res.meta.sectionTotals[s];
    if (tot && tot > 0) {
      const diff = sectionSum[s] - tot;
      if (Math.abs(diff) / tot > 0.01) {
        res.checks.push(
          `${s === "current" ? "유동" : "비유동"}부채 행 합계가 소계와 ${diff > 0 ? "초과" : "미달"}` +
            ` (${((diff / tot) * 100).toFixed(1)}%) — 소계 행 중복 또는 세부 행 누락 가능`,
        );
      }
    }
  }
  if (res.total < 0) res.checks.push("이자부부채 합계가 음수 — 차감계정 판정 확인 필요");
  return res;
}

/**
 * 같은 구역에서 포괄 행(예: "차입금")과 그 구성 행(예: "단기차입금"+"유동성장기부채")이
 * 함께 잡혔으면 포괄 행을 뺀다 — 구성 행 합계가 포괄 행과 ±0.5% 이내일 때만.
 */
function dedupeParentLines(res: IbdV2Result): void {
  for (const s of ["current", "nonCurrent", "unclassified"] as const) {
    const lines = res[s];
    if (lines.length < 3) continue;
    for (const cand of [...lines]) {
      const others = lines.filter((l) => l !== cand && l.category !== "contra");
      const sum = others.reduce((a, b) => a + b.amount, 0);
      if (cand.amount > 0 && others.length >= 2 && Math.abs(sum - cand.amount) / cand.amount < 0.005) {
        res[s] = lines.filter((l) => l !== cand);
        res.total -= cand.amount;
        res.checks.push(`${cand.account} — 구성 계정 합계와 같아 포괄 행으로 보고 제외`);
        break;
      }
    }
  }
}

/**
 * 주석(XBRL) 보충 — 본문에 차입금·사채 없이 "금융부채"로 묶인 구역에 한해
 * 주석의 차입금·사채 합계와 리스부채를 더한다. 본문에 이미 있는 범주는 건드리지 않는다.
 */
export function applyXbrlSupplement(res: IbdV2Result, x: XbrlDebtSummary): void {
  const agg = res.meta.aggregatedFinancialLiabilities;
  let applied = false;
  const add = (s: "current" | "nonCurrent", account: string, amount: number | null, category: IbdCategory) => {
    if (!amount || amount <= 0) return;
    res[s].push({ account, amount, category, accountId: "xbrl-note" });
    res.total += amount;
    applied = true;
  };
  if (agg.current) {
    add("current", "차입금·사채(주석)", x.current, "borrowings");
    if (!res.current.some((l) => l.category === "lease")) add("current", "리스부채(주석)", x.leaseCurrent, "lease");
  }
  if (agg.nonCurrent) {
    add("nonCurrent", "차입금·사채(주석)", x.nonCurrent, "borrowings");
    if (!res.nonCurrent.some((l) => l.category === "lease")) add("nonCurrent", "리스부채(주석)", x.leaseNonCurrent, "lease");
  }
  // 주석에 유동/비유동 구분 없이 차입금 총계만 있으면(셀트리온 2025.3Q 등) 묶인 구역에 넣고,
  // 양쪽 다 묶였으면 미구분으로 둔다
  if (x.current == null && x.nonCurrent == null && x.total && x.total > 0) {
    const where = agg.current && !agg.nonCurrent ? "current" : agg.nonCurrent && !agg.current ? "nonCurrent" : "unclassified";
    res[where].push({ account: "차입금·사채(주석, 유동/비유동 미구분)", amount: x.total, category: "borrowings", accountId: "xbrl-note" });
    res.total += x.total;
    applied = true;
  }
  // 유동/비유동 구분 없이 리스 총계만 있으면 미구분으로(본문에 리스 행이 없을 때만)
  if (x.leaseCurrent == null && x.leaseNonCurrent == null && x.leaseTotal && x.leaseTotal > 0 &&
      ![...res.current, ...res.nonCurrent, ...res.unclassified].some((l) => l.category === "lease")) {
    res.unclassified.push({ account: "리스부채(주석, 유동/비유동 미구분)", amount: x.leaseTotal, category: "lease", accountId: "xbrl-note" });
    res.total += x.leaseTotal;
  }
  res.checks = res.checks.filter((c) => !c.includes("주석(XBRL) 보충 필요"));
  if (!applied) {
    // 무차입 회사의 '기타금융부채'(미지급·보증금 등)가 대부분이라, 묶인 금액이 부채의 30% 이상일 때만 경고
    const liab = (res.meta.sectionTotals.current ?? 0) + (res.meta.sectionTotals.nonCurrent ?? 0);
    const aggSum = (agg.current ?? 0) + (agg.nonCurrent ?? 0);
    const msg = "주석에서도 차입금·사채 금액을 찾지 못함 — 포괄 금융부채에 차입이 없거나 비표준 태그";
    if (liab > 0 && aggSum / liab >= 0.3) res.checks.push(`${msg} (금융부채가 부채의 ${Math.round((aggSum / liab) * 100)}%)`);
    else res.notes.push(msg);
    return;
  }
  res.meta.xbrlSupplemented = true;
  if (x.reconciles === false) res.checks.push("주석 보충 적용 — 주석 차입금 총계와 유동+비유동 불일치, 원문 확인 필요");
  else if (x.current == null && x.nonCurrent == null && x.totalPartial)
    res.checks.push("주석 보충 적용 — 차입금(LoansReceived)·사채(BondsIssued) 합계로 산정, 유동/비유동 미구분 — 원문 확인 권장");
  else res.notes.push("주석 보충 적용 — 본문 '금융부채' 안의 차입금·사채·리스를 주석 금액으로 산정");
  for (const s of ["current", "nonCurrent"] as const) {
    const a = agg[s];
    const debt = res[s].filter((l) => l.accountId === "xbrl-note").reduce((p, l) => p + l.amount, 0);
    if (a && debt > a * 1.05)
      res.checks.push(`${s === "current" ? "유동" : "비유동"} 주석 보충액이 본문 금융부채를 초과 — 리스부채가 별도 행에 있을 수 있음`);
  }
}

/** [계정명, 금액, 범주] — 캐시·도구 상세 출력의 행 단위 */
export type IbdTuple = [string, number, IbdOutCategory];

/** 캐시에 저장하는 이자부부채(행 단위 전체). 도구는 여기서 요약·상세를 만든다(ibd-output.ts) */
export interface CompactIbd {
  total: number;
  current: IbdTuple[];
  nonCurrent: IbdTuple[];
  /** 유동/비유동 구분이 없는 재무상태표의 항목 */
  unclassified?: IbdTuple[];
  /** 합계에서 뺀 부채성 항목(상환전환우선주부채·신종자본증권 등) */
  debtLike?: [string, number][];
  checks?: string[];
  notes?: string[];
}

/** 계정명만으로 범주 추정 — 차감계정의 본계정이 없을 때, 범주 없는 옛 캐시(2-튜플) 변환에 쓴다 */
export function guessCategoryByName(account: string): IbdOutCategory {
  const n = normName(account);
  if (/판매후리스|유동화/.test(n)) return "otherDebt";
  if (NAME_LEASE.test(n)) return "lease";
  if (/사채|전환권|신주인수권|교환권|기업어음|상환할증금/.test(n) && !/차입/.test(n)) return "bonds";
  return "borrowings";
}

/** v2 결과 → 캐시 형식. 차감계정은 본계정 범주로 표시(계정명으로 차감계정임을 알 수 있다) */
export function toCompactIbd(r: IbdV2Result): CompactIbd | null {
  if (r.excluded) return null;
  const tup = (l: IbdLine[]) =>
    l.map((x) => [x.account, x.amount, x.category === "contra" ? (x.netOf ?? guessCategoryByName(x.account)) : x.category] as IbdTuple);
  return {
    total: r.total,
    current: tup(r.current),
    nonCurrent: tup(r.nonCurrent),
    ...(r.unclassified.length ? { unclassified: tup(r.unclassified) } : {}),
    ...(r.debtLike.length ? { debtLike: r.debtLike.map((d) => [d.account, d.amount] as [string, number]) } : {}),
    ...(r.checks.length ? { checks: r.checks } : {}),
    ...(r.notes.length ? { notes: r.notes } : {}),
  };
}

/**
 * 옛 캐시(v2.0·v2.1 — [계정명, 금액] 2-튜플, 미구분 항목이 nonCurrent 에 섞임)를 현재 형식으로.
 * 범주는 계정명으로 추정한다. 이미 3-튜플이면 그대로 둔다.
 */
export function normalizeCompactIbd(ibd: unknown): CompactIbd | null {
  if (!ibd || typeof ibd !== "object") return null;
  const o = ibd as Record<string, unknown>;
  const fix = (a: unknown): IbdTuple[] =>
    Array.isArray(a)
      ? a.map((t) => {
          const [acc, amt, cat] = t as [string, number, IbdOutCategory | undefined];
          return [acc, amt, cat ?? guessCategoryByName(acc)] as IbdTuple;
        })
      : [];
  return {
    ...(o as unknown as CompactIbd),
    total: Number(o.total ?? 0),
    current: fix(o.current),
    nonCurrent: fix(o.nonCurrent),
    ...(o.unclassified ? { unclassified: fix(o.unclassified) } : {}),
  };
}

/**
 * DART 주식수 단위 오류 보정 — 참조 상장주식수(네이버 현재 시총/종가)와 비교한다.
 * 참조는 "현재" 값이라 그 사이 주식병합·유상증자가 있으면 수 배 차이가 날 수 있다.
 * 그래서 200배 이상 벌어질 때만 ÷1,000·÷1,000,000 중 참조에 가장 가까워지는 쪽을 택하고
 * (보정 후 0.05~20배 이내일 때만), 그 밖의 차이는 경고만 남긴다.
 */
export function sanitizeShares(
  outstanding: number | null,
  refListed: number | null,
): { shares: number | null; note: string | null } {
  if (!outstanding || outstanding <= 0) return { shares: null, note: "DART 유통주식수 없음" };
  if (refListed && refListed > 0) {
    const ratio = outstanding / refListed;
    if (ratio > 200) {
      const best = [1e3, 1e6]
        .map((f) => ({ f, r: ratio / f }))
        .filter((x) => x.r > 0.05 && x.r < 20)
        .sort((a, b) => Math.abs(Math.log(a.r)) - Math.abs(Math.log(b.r)))[0];
      if (best) {
        const extra = Math.abs(Math.log(best.r)) > Math.log(1.5) ? `, 보정 후에도 참조 대비 ${best.r.toFixed(2)}배 — 주식병합·증자 가능` : "";
        return {
          shares: Math.round(outstanding / best.f),
          note: `DART 주식수 단위 오류 보정(÷${best.f.toLocaleString()}${extra})`,
        };
      }
    }
    if (ratio > 5 || ratio < 0.2) return { shares: outstanding, note: `참조 상장주식수 대비 ${ratio.toFixed(2)}배 — 확인 필요` };
    return { shares: outstanding, note: null };
  }
  if (outstanding > 1e10) return { shares: outstanding, note: "주식수 100억 주 초과 — 단위 오류 의심" };
  return { shares: outstanding, note: null };
}
