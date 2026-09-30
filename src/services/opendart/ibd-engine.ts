/**
 * 이자부부채(IBD) 엔진 v2.2 — 재무상태표 본문(fnlttSinglAcntAll, sj_div=BS) 기준. 정책: docs/IBD_POLICY.md
 *
 * v1(xbrl-parser.ts)은 XBRL 주석(재무활동 부채 변동표)의 멤버 이름을 키워드로 추측해
 * 대형주 누락(SK하이닉스 리스만 인식)·유동/비유동 오분류가 있었다(2026-09-30 전수 점검). v2 원칙:
 *
 *  1. 구역은 이름이 아니라 "유동부채"·"비유동부채" 머리 행으로 정한다.
 *  2. 계정은 거부 규칙(파생·충당·계약부채·보증금 등) → 표준계정 ID → 계정명 규칙 순으로 판정한다.
 *  3. 차감계정(할인발행차금·전환권조정·현재가치할인차금)은 본계정이 확인될 때만 음수로 합산한다.
 *  4. 부채성 항목(상환전환우선주부채·신종자본증권 등)은 합계에서 분리해 유형과 함께 돌려준다.
 *  5. 금융업(은행·보험·증권·여신전문)은 이자부부채 개념이 맞지 않아 산정하지 않는다.
 *  6. 포괄 행(구성 행의 합계 행)은 구역 소계 초과 + 정확한 부분합 + 구조 증거가 모두 있을 때만 뺀다.
 *  7. 본문이 '금융부채'로 묶이면 주석 XBRL 로 보충하되, 본문에 없는 금액만, 구역 부채 소계 안에서만 더한다.
 *  8. 빠졌을 가능성이 있으면 completeness='partial' 과 사유를 남긴다(조용한 0·조용한 과소 금지).
 *
 * v2.2(2026-09-30 오프라인 점검) · v2.2.1(같은 날 구현 독립 검증 반영 — W07~W31, S01~S21)
 * · v2.3(2026-10-01 주석 원문 블라인드 검증 249종목 반영 — XBRL '공시금액' 문맥, 본문에 없는 리스의 주석 보충,
 *   주석 차입금 총계 잔액 보충, 구역별 누락·재무활동부채 조정표 대조, 사용권자산 대비 리스 누락 경고).
 *
 * 주의 — DART 의 ord 는 화면 표시 순서가 아니다. 형제 행은 account_id 정렬이고, 계층형 표시의
 * 자식 행만 부모 바로 뒤에 연속으로 온다. 그래서 "바로 앞 행" 같은 인접성은 계층 판정에만 쓴다.
 *
 * 순수 함수만 둔다 — 네트워크 호출은 호출부(수집 스크립트·도구)의 몫.
 */
import type { DartFinancialItem } from "./types";
import type { XbrlDebtSummary } from "./xbrl-debt-facts";

/** 엔진 판 — 수집 캐시가 이 값과 다르면 해당 보고서를 다시 계산한다 */
export const IBD_ENGINE_VERSION = "ibd-v2.3";

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

/** 출력 범주 */
export type IbdOutCategory = "borrowings" | "bonds" | "convertible" | "borrowingsAndBonds" | "lease" | "otherDebt";
export type IbdCategory = IbdOutCategory | "contra";
export type IbdSection = "current" | "nonCurrent" | "unclassified";
/** 부채성 항목 유형 — 계정명 기준 추정 */
export type DebtLikeType = "rcps" | "cps" | "convDerivative" | "hybrid" | "unknown";
/** 주석 XBRL 상태 — 묶인 금융부채가 있을 때만 의미가 있다 */
export type XbrlStatus =
  | "not_needed"
  | "xml_error"
  | "xml_absent"
  | "not_fetched"
  | "context_not_found"
  | "no_debt_elements"
  | "held"
  | "same_as_body"
  | "lease_only"
  | "applied";

export const XBRL_ERROR_MSG = "주석 XBRL 조회 실패(통신 오류) — 다음 수집에서 재시도";
export const EXCEEDS_TL_MSG = "이자부부채가 부채총계를 초과";

const BOND_FAMILY: IbdOutCategory[] = ["bonds", "convertible", "borrowingsAndBonds"];

export interface IbdLine {
  account: string;
  amount: number;
  category: IbdCategory;
  accountId: string;
  /** 차감계정(contra)이 차감하는 본계정 범주 */
  netOf?: IbdOutCategory;
  /** 원행 표시 순서(ord) — 주석 보충 행은 없음 */
  ord?: number;
}

export interface IbdV2Result {
  /** 산정 제외 사유(금융업 등). 값이 있으면 합계 필드는 0 */
  excluded: string | null;
  current: IbdLine[];
  nonCurrent: IbdLine[];
  /** 유동/비유동 구분이 없는 재무상태표에서 찾은 항목, 또는 주석 총계 보충 */
  unclassified: IbdLine[];
  total: number;
  /** 합계에 넣지 않은 부채성 항목 — 포함 여부는 사용자가 판단 */
  debtLike: { account: string; amount: number; section: IbdSection; type: DebtLikeType }[];
  /** 산정 경고 — 원문 확인이 필요한 경우 */
  checks: string[];
  /** 참고 — 정상 처리지만 알아 둘 사항 */
  notes: string[];
  /** 차입이 빠졌을 가능성이 있으면 partial */
  completeness: "full" | "partial";
  completenessReasons: string[];
  meta: {
    fsDiv: string | null;
    rceptNo: string | null;
    periodLabel: string | null;
    /** 머리 행의 구역 소계(원값) */
    sectionTotals: { current: number | null; nonCurrent: number | null };
    /** 부채총계 행 금액 */
    totalLiabilities: number | null;
    /** 자산총계 행 금액 */
    totalAssets: number | null;
    /** 차입금·사채 없이 "금융부채"로 묶여 표시된 금액 — 주석(XBRL) 보충 대상 */
    aggregatedFinancialLiabilities: { current: number | null; nonCurrent: number | null };
    /** 주석 보충을 적용했으면 true (차입 또는 리스) */
    xbrlSupplemented: boolean;
    xbrlApplied: { debt: boolean; lease: boolean };
    xbrlStatus: XbrlStatus | null;
    /** 포괄 행으로 보고 뺀 행 */
    dedupeRemoved: { section: IbdSection; account: string; amount: number; children: string[] }[];
    /** 금융 자회사 연결 신호(예수부채·보험계약부채·금융업채권 등) */
    financialSegment?: boolean;
    /** 매각예정 처분자산집단 */
    heldForSale?: { assets: number; liabilities: number; net: number };
    /** 본문에 리스부채 행이 전혀 없음(리스 포함 차입 행도 없음) — 주석 리스 보충 후보 */
    leaseAbsent: boolean;
    /** 사용권자산(자산) 합계 — 리스부채를 못 찾았을 때 누락 가능성 판단 */
    rouAssets: number;
    /** 리스를 담을 수 있는 비차입 행(기타부채·기타금융부채·매입채무및기타채무 등)의 구역별 합계 */
    leaseContainers: { current: number; nonCurrent: number; names: string[] };
  };
}

// ─── 규칙 ───

const HDR_CURRENT_ID = "ifrs-full_CurrentLiabilities";
const HDR_NONCURRENT_ID = "ifrs-full_NoncurrentLiabilities";
const TOTAL_LIAB_ID = "ifrs-full_Liabilities";
const TOTAL_ASSETS_ID = "ifrs-full_Assets";
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
const NAME_TOTAL_ASSETS = /^자산총계$/;

// 표준계정 ID — 강한 신호
const ID_LEASE = /LeaseLiabilit/i;
const ID_BOND =
  /BondsIssued|ConvertibleBond|BondWithWarrant|BondsWithWarrant|ExchangeableBond|Debenture|CommercialPaper|ShortTermBonds|PortionOfBonds|dart_(?:NonCurrent)?Bonds/i;
const ID_BORROW = /Borrowings|LoansReceived|BankOverdraft/i;
const ID_CONVERTIBLE = /ConvertibleBond|BondsWithWarrant|BondWithWarrant|ExchangeableBond/i;
/** ID 에 이 말이 있으면 부채성 차입이 아님(자산·파생·이자·보증·계약부채·선수 등) */
const ID_NOT_DEBT = /Receivable|Asset|Derivative|InterestPayable|Guarantee|Provision|Deposit|ContractLiabilit|Advance/i;

// 계정명 — 판정 순서는 classifyRow 참조
/** '사채' — '관계회사채무'의 '사채무'는 제외(단 '사채무보증'·'사채무담보'는 사채) */
const BOND_WORD = /사채(?!무(?!보증|담보))/;
const NAME_DEBT_LIKE = /상환전환우선주|전환상환우선주|상환우선주|전환우선주|우선주부채|신종자본증권|조건부자본증권|영구채/;
/** 파생 표지 없는 옵션 부채명(전환권부채·신주인수권부채 등) */
const OPTION_LIAB = /(?:전환권|신주인수권|교환권)(?:대가)?부채(?:\(.*\))?$/;
/** '전환사채(파생상품부채 포함)' — 원금 행에 파생이 괄호로 포함된 복합 행 */
const CONV_WITH_DERIV = /^(?:유동성?|비유동)?(?:전환사채|신주인수권부사채|교환사채)\(.*파생.*포함\)/;
/** 절대 거부 — ID 와 무관(차입 ID 가 붙어 와도 계정명이 이러면 제외) */
const ABS_VETO = /파생|충당|초과청구|공사채무|계약부채|확정급여|미지급이자|사채이자|이자비용|이연수익|경과이자|차입금이자$/;
const CONV_MARK = /전환권|신주인수권|교환권|전환사채|신주인수권부사채|교환사채/;
const NAME_CONTRA = /할인발행차금|전환권조정|신주인수권조정|교환권조정|현재가치할인차금/;
/** 비차입 계정의 차감계정(보증금 현재가치할인차금 등) */
const CONTRA_VETO = /보증금|임대|예수|미지급|선수|충당|복구|이연/;
const NAME_PREMIUM = /상환할증금/;
/** 조건부 거부 A — 보증금·예수·선수(리스 표지로도 면제 안 함: 리스보증금·선수리스료) */
const COND_VETO_A = /보증금|예수|선수/;
/** 조건부 거부 B — 매입채무·미지급(리스미지급금은 면제) */
const COND_VETO_B = /매입채무|미지급/;
const COND_VETO_EXEMPT = /차입|사채|리스|유산스/;
/** 차입 ID 가 없을 때만 거부 — '위험회피대상 차입금' 같은 정상 차입은 ID 로 들어온다 */
const HEDGE_VETO = /스왑|헤지|위험회피|금융보증|보증부채/;
/** 채무·금융부채 일반과 묶였을 수 있는 행 */
const AMBIG = /기타(?:유동|비유동|장기|단기)?(?:채무|금융부채)|지급채무|장기기타채무/;
const NAME_LEASE = /리스부채|판매후리스|리스(?:유동|비유동)부채|리스채무/;
const NAME_BOND = /사채(?!무(?!보증|담보))|기업어음/;
const NAME_BORROW = /차입금|차입부채|당좌차월|유동성장기부채|유동화채무|유동화차입|차입채무|유동성장기채무|유동장기부채/;
const NAME_CONVERTIBLE = /전환사채|신주인수권부사채|교환사채/;
/** 포괄 금융부채 행 이름(차입금·사채를 품을 수 있음) — 화이트리스트('매입채무및기타금융부채'는 제외) */
const NAME_AGG_FIN = /^(?:기타의?|상각후원가(?:측정)?)?(?:유동성?|비유동성?|단기|장기)?(?:기타)?금융부채(?:\((?:유동|비유동)\)|,?(?:유동|비유동))?$/;
const NAME_NOT_DEBT =
  /보증금|예수|미지급|매입채무|충당|이연|확정급여|파생|계약부채|선수|당기법인세|미지급이자|사채이자|이자비용|대여금|채권$|초과청구|공사채무/;
const BOND_CONTRA = /전환권조정|신주인수권조정|교환권조정|할인발행차금/;

/**
 * 은행·보험·증권·여신전문(카드 64911·할부 64912·리스 64913)은 이자부부채를 산정하지 않는다.
 * 5자리로만 판정한다 — 4자리 6491(신기술금융)·3자리 649(지주회사 등)는 포함.
 */
const FINANCIAL_INDUSTRY = /^(641|642|6491[1-3]|65|661[12])/;
/** 금융업 재무상태표에만 나오는 계정 */
const FINANCIAL_ROW_ID = /DepositsFromCustomers|InsuranceContracts|ReinsuranceContracts|FinancialLiabilitiesAtFairValueThroughProfitOrLoss/i;
/** 금융 자회사 연결 신호(구역형 재무상태표) */
const FIN_SEGMENT_ID = /DepositsFromCustomers|InsuranceContracts|ReinsuranceContracts/i;
const FIN_SEGMENT_NAME = /예수부채|고객예수금|투자자예수금|보험계약부채|금융업채권|할부금융채권|카드자산|금융업차입금/;

function parseAmount(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/[,\s]/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const hasStdId = (id: string) => !!id && id !== "-표준계정코드 미사용-";
const isMixed = (n: string) => /차입/.test(n) && BOND_WORD.test(n) && !/\(사채포함\)|사채제외/.test(n);
const isOtherDebtName = (n: string) => /판매후리스/.test(n) || (/유동화/.test(n) && !BOND_WORD.test(n));
/** 이름에서 제외 구절 제거 — '기타금융부채(차입금 제외)' → '기타금융부채' */
const coreName = (n: string) =>
  n.replace(/\([^)]*(?:제외|이외)\)/g, "").replace(/(?:차입금|사채|리스부채)(?:을|를)?(?:제외한|이외의|외의)/g, "");

function debtLikeType(name: string): DebtLikeType {
  if (/파생/.test(name)) return "convDerivative";
  if (/상환전환|전환상환|상환우선주/.test(name)) return "rcps";
  if (/전환우선주/.test(name)) return "cps";
  if (/신종자본증권|영구채|조건부자본증권/.test(name)) return "hybrid";
  return "unknown";
}

function bondCat(id: string, name: string): IbdOutCategory {
  return NAME_CONVERTIBLE.test(name) || ID_CONVERTIBLE.test(id) ? "convertible" : "bonds";
}

function borrowCat(id: string, name: string): IbdOutCategory {
  if (isOtherDebtName(name)) return "otherDebt";
  if (isMixed(name)) return "borrowingsAndBonds";
  if (BOND_WORD.test(name) && !/차입/.test(name)) return bondCat(id, name);
  return "borrowings";
}

const LEASE_IN_BORROW_NOTE = "리스부채를 포함한 차입금 행 — 리스분이 차입금 범주에 포함";
const LEASE_IN_BOND_NOTE = "리스부채를 포함한 사채 행 — 리스분이 사채 범주에 포함";
/** 리스와 차입·사채가 한 행 — ID_LEASE·NAME_LEASE·guess 공용 */
function leaseInclusiveCat(id: string, n: string): IbdOutCategory {
  return isOtherDebtName(n) ? "otherDebt" : isMixed(n) ? "borrowingsAndBonds" : /차입/.test(n) ? "borrowings" : bondCat(id, n);
}
const leaseNote = (c: IbdOutCategory) =>
  c === "borrowings" || c === "borrowingsAndBonds" ? LEASE_IN_BORROW_NOTE : c === "otherDebt" ? undefined : LEASE_IN_BOND_NOTE;
const leaseInclusive = (n: string) => /판매후리스|유동화|차입/.test(n) || BOND_WORD.test(n);

/** AMBIG 행 경고 — (b) 차입 표지와 함께면 묶인 차입 행, (a) 차입 ID 인데 이름에 차입 표지가 없으면 차입금 아님 */
function ambigCheck(id: string, name: string, tag: string): string | undefined {
  if (!AMBIG.test(name)) return undefined;
  if (/차입|리스|유동성장기|유동화/.test(name) || BOND_WORD.test(name)) return `비차입 부채와 묶인 차입 행 — 전액 포함, 원문 확인: ${tag}`;
  if (hasStdId(id) && ID_BORROW.test(id)) return `계정명이 차입금 아님 — 원문 확인: ${tag}`;
  return undefined;
}

interface Cls {
  cat: IbdCategory | "debtLike" | null;
  type?: DebtLikeType;
  /** 이름만 '상환할증금'인 행 — 같은 구역에 전환사채만 있으면 convertible 로 바꾼다 */
  premium?: boolean;
  check?: string;
  note?: string;
}

/**
 * 한 행의 판정. 순서가 중요하다:
 * 부채성·옵션부채 → 전환사채 복합행 → 절대 거부 → 비차입 차감계정 거부 → 차감계정·할증금
 * → 조건부 거부 → 헤지·보증 거부 → 표준 ID → 계정명(제외 구절 제거 후)
 */
function classifyRow(id: string, name: string, raw: string, tag = raw): Cls {
  const std = hasStdId(id);
  const debtId = std && !ID_NOT_DEBT.test(id) && (ID_BORROW.test(id) || ID_BOND.test(id) || ID_LEASE.test(id));
  const vetoCheck = debtId ? `표준 ID는 차입성이나 계정명은 비차입 — 제외: ${tag}` : undefined;
  // 1. 부채성 항목
  if (NAME_DEBT_LIKE.test(name) || /RedeemablePreference|PreferenceShares/i.test(id)) return { cat: "debtLike", type: debtLikeType(name) };
  if (OPTION_LIAB.test(name)) {
    if (std && (ID_BOND.test(id) || ID_CONVERTIBLE.test(id)))
      return { cat: "convertible", check: `옵션 부채 계정명이나 사채 ID — 원금/파생 원문 확인: ${tag}` };
    return { cat: "debtLike", type: "convDerivative", ...(/신주인수권부채/.test(name) ? { check: `신주인수권부사채 오기 가능 — 원문 확인: ${tag}` } : {}) };
  }
  // 2. 전환사채 복합 행 → 절대 거부(전환권 파생은 부채성으로)
  if (CONV_WITH_DERIV.test(name)) return { cat: "convertible", check: `파생상품부채 포함 전환사채 행 — 부채요소·파생 구분은 주석 확인: ${tag}` };
  if (ABS_VETO.test(name)) {
    if (/파생/.test(name) && CONV_MARK.test(name)) return { cat: "debtLike", type: "convDerivative" };
    return { cat: null, check: vetoCheck };
  }
  // 3. 비차입 계정의 차감계정
  if (NAME_CONTRA.test(name) && CONTRA_VETO.test(name)) return { cat: null };
  // 4. 차감계정·상환할증금
  if (NAME_CONTRA.test(name)) return { cat: "contra" };
  if (NAME_PREMIUM.test(name)) {
    const conv = /전환|신주인수권|교환/.test(name);
    return { cat: conv ? "convertible" : "bonds", premium: !conv };
  }
  // 5. 조건부 거부
  if ((COND_VETO_A.test(name) && !/차입|사채|유산스/.test(name)) || (COND_VETO_B.test(name) && !COND_VETO_EXEMPT.test(name)))
    return { cat: null, check: vetoCheck };
  if (HEDGE_VETO.test(name) && !debtId) return { cat: null };
  // 6·7. 표준 ID
  if (std && !ID_NOT_DEBT.test(id)) {
    let cat: IbdOutCategory | null = null;
    let note: string | undefined;
    if (ID_LEASE.test(id)) {
      if (leaseInclusive(name)) {
        cat = leaseInclusiveCat(id, name);
        note = leaseNote(cat);
      } else cat = "lease";
    } else if (ID_BOND.test(id)) {
      cat = isMixed(name) ? "borrowingsAndBonds" : bondCat(id, name);
    } else if (ID_BORROW.test(id)) {
      cat = borrowCat(id, name);
    }
    if (cat) return { cat, note, check: ambigCheck(id, name, tag) };
  }
  // 8. 계정명 거부
  if (NAME_NOT_DEBT.test(name)) return { cat: null };
  // 9. 계정명 — 리스(차입 포함 행은 차입금) → 유동화 → 차입 (제외 구절은 걷어 내고 본다)
  const cn = coreName(name);
  if (NAME_LEASE.test(cn)) {
    if (leaseInclusive(cn)) {
      const c = leaseInclusiveCat(id, cn);
      return { cat: c, note: leaseNote(c), check: ambigCheck(id, cn, tag) };
    }
    return { cat: "lease" };
  }
  if (/유동화채무|유동화차입/.test(cn)) return { cat: "otherDebt" };
  if (NAME_BORROW.test(cn)) return { cat: borrowCat(id, cn), check: ambigCheck(id, cn, tag) };
  // 10. '…채무' 로 끝나는 비차입(관계회사채무 등)
  if (/채무$/.test(cn) && !/차입|사채$|사채[,(]/.test(cn)) return { cat: null };
  // 11. 사채
  if (NAME_BOND.test(cn)) return { cat: isMixed(cn) ? "borrowingsAndBonds" : bondCat(id, cn), check: ambigCheck(id, cn, tag) };
  return { cat: null };
}

export interface IbdEngineOptions {
  /** 표준산업분류 코드(company-industry.json industryCode) — 금융업 판정 보조 */
  industryCode?: string | null;
}

/** 부채 구역 안의 원행(판정 전후 상태 포함) */
interface Row {
  ord: number;
  raw: string;
  name: string;
  id: string;
  amt: number;
  section: IbdSection;
  line: IbdLine | null;
  /** 차감계정 이름 — 채택 여부와 무관하게 소계 대조에서 −|금액| */
  contraName: boolean;
  /** 부호 보정한 행 */
  flipped?: boolean;
  /** 포괄 행으로 제거됨 */
  removedParent?: boolean;
  /** 차감계정 채택 근거 — R2 이후 재검증용 */
  contraBasis?: "bond" | "host" | "i" | "ii" | "iii";
  /** 미구분 재무상태표에서 부채총계 행 뒤(자본 구역) */
  afterTL?: boolean;
}

const SECTION_LABEL: Record<IbdSection, string> = { current: "유동", nonCurrent: "비유동", unclassified: "미구분" };
const eok = (n: number) => `${(n / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억`;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // 로캘 무관

function markPartial(res: IbdV2Result, reason: string) {
  res.completeness = "partial";
  if (!res.completenessReasons.includes(reason)) res.completenessReasons.push(reason);
}

function pushUnique(arr: string[], msg: string) {
  if (!arr.includes(msg)) arr.push(msg);
}

function recomputeTotal(res: IbdV2Result) {
  res.total = [...res.current, ...res.nonCurrent, ...res.unclassified].reduce((s, l) => s + l.amount, 0);
}

/** 구역 원행의 합 — 차감계정 이름 행은 채택 여부와 무관하게 −|금액|, 부호 보정 행은 +|금액| */
function rowValue(r: Row): number {
  if (r.contraName) return -Math.abs(r.amt);
  if (r.flipped) return Math.abs(r.amt);
  return r.amt;
}

/** 금액 표시 단위 — 모든 금액이 나누어떨어지는 최대 10^k(k≤6) */
function displayUnit(rows: Row[]): number {
  let unit = 1e6;
  while (unit > 1 && !rows.every((r) => r.amt % unit === 0)) unit /= 10;
  return unit;
}

/** P 바로 뒤(ord)의 금액 있는 행들 — 계층형 표시의 자식 후보 */
function followingRows(rows: Row[], p: Row): Row[] {
  const i = rows.indexOf(p);
  return rows.slice(i + 1).filter((r) => r.amt !== 0);
}

/** 부분집합 열거(크기 1..maxK) */
function* subsets<T>(arr: T[], maxK: number, start = 0, acc: T[] = []): Generator<T[]> {
  for (let i = start; i < arr.length; i++) {
    const next = [...acc, arr[i]];
    yield next;
    if (next.length < maxK) yield* subsets(arr, maxK, i + 1, next);
  }
}

/**
 * P 가 계층형 부모이고 바로 뒤 연속 행들의 앞부분 합이 P 와 같으면 그 자식 행들.
 * minKids=1 은 금액이 정확히 같은 단일 자식까지 허용(경고 강등용 — 금액 판정에는 쓰지 않음).
 */
function hierarchicalChildren(rows: Row[], p: Row, tol: number, minKids = 2): Row[] | null {
  const seq = followingRows(rows, p);
  let sum = 0;
  for (let k = 0; k < Math.min(seq.length, 8); k++) {
    sum += rowValue(seq[k]);
    if (k + 1 >= minKids && Math.abs(sum - p.amt) <= (k === 0 ? 0 : tol)) return seq.slice(0, k + 1);
  }
  return null;
}

/** 구역 소계 — 머리 행 금액이 비었으면 부채총계 − 다른 구역 소계로 복원 */
function resolvedTotals(res: IbdV2Result): { current: number | null; nonCurrent: number | null; restored: IbdSection[] } {
  const { current: c, nonCurrent: n } = res.meta.sectionTotals;
  const tl = res.meta.totalLiabilities;
  const restored: IbdSection[] = [];
  const rc = c ?? (n != null && tl && tl - n > 0 ? tl - n : null);
  const rn = n ?? (c != null && tl && tl - c > 0 ? tl - c : null);
  if (c == null && rc != null) restored.push("current");
  if (n == null && rn != null) restored.push("nonCurrent");
  return { current: rc, nonCurrent: rn, restored };
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
    completeness: "full",
    completenessReasons: [],
    meta: {
      fsDiv: bs[0]?.fs_div ?? null,
      rceptNo: bs[0]?.rcept_no ?? null,
      periodLabel: bs[0]?.thstrm_nm ?? null,
      sectionTotals: { current: null, nonCurrent: null },
      totalLiabilities: null,
      totalAssets: null,
      aggregatedFinancialLiabilities: { current: null, nonCurrent: null },
      xbrlSupplemented: false,
      xbrlApplied: { debt: false, lease: false },
      xbrlStatus: null,
      dedupeRemoved: [],
      leaseAbsent: false,
      rouAssets: 0,
      leaseContainers: { current: 0, nonCurrent: 0, names: [] },
    },
  };

  if (bs.length === 0) {
    res.checks.push("재무상태표 행 없음");
    markPartial(res, "재무상태표 행 없음");
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
  const ic = opts.industryCode ?? null;
  const finIndustry = !!ic && FINANCIAL_INDUSTRY.test(ic);
  if (finIndustry || (!hasSections && hasFinancialRows)) {
    res.excluded = finIndustry
      ? "금융업(은행·보험·증권·여신전문(카드·캐피탈) 업종) — 차입이 영업부채라 이자부부채를 산정하지 않음"
      : "금융업 형태 재무상태표(유동/비유동 구분 없음, 예수·보험·당기손익금융부채 계정) — 산정 제외";
    return res;
  }
  if (!hasSections) res.checks.push("유동/비유동 구분이 없는 재무상태표 — 항목을 미구분으로 집계");
  const finRelated = !!ic && /^6[4-6]/.test(ic) && !ic.startsWith("64992");
  if (finRelated) res.notes.push(`금융 관련 업종(${ic}) — 이자부부채 해석에 주의`);

  // ── 1. 행 루프 ──
  let section: IbdSection | null = hasSections ? null : "unclassified";
  let passedTL = false;
  const rows: Record<IbdSection, Row[]> = { current: [], nonCurrent: [], unclassified: [] };
  const premiumLines: { line: IbdLine; section: IbdSection }[] = [];
  const fvtpl: string[] = [];

  for (const r of bs) {
    const id = r.account_id ?? "";
    const raw = (r.account_nm ?? "").trim();
    const name = normName(raw);
    const amt = parseAmount(r.thstrm_amount);

    if (id === TOTAL_ASSETS_ID || NAME_TOTAL_ASSETS.test(name)) res.meta.totalAssets = amt;
    if ((/RightofuseAssets$/i.test(id) || /^사용권자산$/.test(name)) && amt && amt > 0) res.meta.rouAssets += amt;
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
    if (id === TOTAL_LIAB_ID || NAME_TOTAL_LIAB.test(name)) {
      res.meta.totalLiabilities = amt;
      passedTL = true;
      continue;
    }
    if (LEAVE_IDS.has(id) || NAME_LEAVE.test(name)) {
      section = hasSections ? null : "unclassified";
      continue;
    }
    if (!section || amt == null) continue;
    // 미구분 재무상태표에서는 자산 계정을 배제
    if (section === "unclassified" && /Asset|Receivable/i.test(id)) continue;

    const row: Row = {
      ord: Number(r.ord),
      raw,
      name,
      id,
      amt,
      section,
      line: null,
      contraName: NAME_CONTRA.test(name),
      ...(section === "unclassified" && passedTL ? { afterTL: true } : {}),
    };
    rows[section].push(row);
    if (amt === 0) continue;

    // 차입금·사채를 품었을 수 있는 포괄 "금융부채" 행 — 주석 보충 판단용으로 기록만
    if (section !== "unclassified" && NAME_AGG_FIN.test(coreName(name)) && /FinancialLiabilities|미사용/.test(id || "미사용")) {
      const agg = res.meta.aggregatedFinancialLiabilities;
      agg[section] = (agg[section] ?? 0) + amt;
    }

    const tag = `${raw} ${eok(amt)}(${SECTION_LABEL[section]})`;
    const c = classifyRow(id, name, raw, tag);
    if (c.check) pushUnique(res.checks, c.check);
    if (c.note) pushUnique(res.notes, c.note);
    if (!c.cat) {
      if (/FinancialLiabilitiesAtFairValueThroughProfitOrLoss/i.test(id) || /당기손익.*공정가치.*금융부채|당기손익인식.*금융부채/.test(name))
        fvtpl.push(`${raw} ${eok(amt)}`);
      continue;
    }
    if (c.cat === "debtLike") {
      res.debtLike.push({ account: raw, amount: amt, section, type: c.type ?? "unknown" });
      continue;
    }
    if (c.cat === "convertible" && (BOND_WORD.test(name.replace(/전환사채|신주인수권부사채|교환사채/g, "")) || /등$/.test(name)))
      pushUnique(res.notes, `일반사채 포함 가능 행 — 전환사채 범주로 집계: ${raw}`);
    const line: IbdLine = { account: raw, amount: c.cat === "contra" ? -Math.abs(amt) : amt, category: c.cat, accountId: id, ord: row.ord };
    row.line = line;
    res[section].push(line);
    if (c.premium) premiumLines.push({ line, section });
  }

  // 이름만 '사채상환할증금'인 행 — 같은 구역에 전환사채 계열만 있으면 전환사채 범주
  for (const { line, section: s } of premiumLines) {
    const cats = res[s].filter((l) => l !== line).map((l) => l.category);
    if (cats.includes("convertible") && !cats.includes("bonds")) line.category = "convertible";
  }

  const T = resolvedTotals(res);
  for (const s of T.restored) res.notes.push(`구역 소계 복원: ${SECTION_LABEL[s]}부채 = 부채총계 − 다른 구역 소계`);

  fixNegativeRows(res, rows, T);
  attributeContras(res, rows);
  const unproven = dedupeParents(res, rows, T);
  revalidateContras(res, rows);
  sameAmountNotes(res, rows);

  // 차입금·사채가 없는 구역에 포괄 금융부채만 있으면 주석 보충이 필요하다고 표시
  for (const s of ["current", "nonCurrent"] as const) {
    const agg = res.meta.aggregatedFinancialLiabilities[s];
    const hasDebt = res[s].some((l) => l.category === "borrowings" || BOND_FAMILY.includes(l.category as IbdOutCategory));
    if (!agg || hasDebt) res.meta.aggregatedFinancialLiabilities[s] = null;
  }
  const agg = res.meta.aggregatedFinancialLiabilities;
  if (agg.current || agg.nonCurrent) res.checks.push("차입금·사채가 '금융부채'로 묶여 표시됨 — 주석(XBRL) 보충 필요");
  else res.meta.xbrlStatus = "not_needed";

  sectionChecks(res, rows, T, unproven);
  referenceNotes(res, bs, hasSections, fvtpl, finRelated);
  leaseInfo(res, rows);
  recomputeTotal(res);
  postChecks(res);
  return res;
}

// ─── 2. 차감계정이 아닌 음수 행 — 소계가 뒷받침하고, 뒤집어야 더 맞을 때만 부호 보정(순서 무관) ───

function fixNegativeRows(res: IbdV2Result, rows: Record<IbdSection, Row[]>, T: { current: number | null; nonCurrent: number | null }) {
  for (const s of ["current", "nonCurrent", "unclassified"] as const) {
    const neg = rows[s].filter((r) => r.line && r.line.category !== "contra" && r.amt < 0 && !/대체|차감/.test(r.name));
    if (!neg.length) continue;
    const Ts = s === "unclassified" ? null : T[s];
    const flip = (r: Row) => {
      r.flipped = true;
      r.line!.amount = Math.abs(r.amt);
      res.notes.push(`부호 보정: ${r.raw} ${eok(r.amt)} → ${eok(Math.abs(r.amt))} (구역 소계와 일치)`);
    };
    if (Ts) {
      const tol = Math.abs(Ts) * 0.01;
      const unit = displayUnit(rows[s].filter((r) => r.amt !== 0));
      const tolH = Math.max(unit * 3, 1000);
      // 계층형 부모 중복분은 소계 대조에서 뺀다
      const dup = rows[s].filter((p) => p.amt !== 0 && !p.contraName && hierarchicalChildren(rows[s], p, tolH, 2)).reduce((a, p) => a + p.amt, 0);
      const base = rows[s].reduce((a, r) => a + rowValue(r), 0) - dup;
      const d0 = Math.abs(base - Ts);
      if (d0 > tol && neg.length <= 12) {
        const key = (S: Row[]) => S.map((r) => r.raw).sort().join("|");
        const cands = [...subsets(neg, neg.length)]
          .map((S) => ({ S, d: Math.abs(base + S.reduce((a, r) => a + 2 * Math.abs(r.amt), 0) - Ts) }))
          .filter((c) => c.d <= tol && c.d < d0)
          .sort((a, b) => a.d - b.d || cmpStr(key(a.S), key(b.S)));
        if (cands.length) {
          cands[0].S.forEach(flip);
          if (cands.length > 1 && cands[1].d - cands[0].d <= Math.max(1000, tol * 0.01))
            res.checks.push(`부호 보정 후보가 여럿 — 소계에 가장 가까운 쪽 선택(${key(cands[0].S)}), 원자료 확인`);
        }
      }
    }
    for (const r of neg.filter((x) => !x.flipped)) res.checks.push(`차입성 계정 음수 — 원자료 부호 확인: ${r.raw} ${eok(r.amt)}`);
  }
}

// ─── 3. 차감계정 귀속 — 순서와 무관하게 같은 구역의 본계정 확인 ───

function removeLine(res: IbdV2Result, row: Row) {
  if (!row.line) return;
  res[row.section] = res[row.section].filter((l) => l !== row.line);
  row.line = null;
}

type HostSum = (cats: IbdOutCategory[]) => number;

/** 일반 현재가치할인차금의 이름 우선 귀속 — 그 범주 본계정이 있고 |PV| ≤ 그 50% 일 때만 */
function pvNameCat(r: Row, hostSum: HostSum): IbdOutCategory | null {
  const c: IbdOutCategory | null = isOtherDebtName(r.name) ? "otherDebt" : /리스/.test(r.name) && /차입/.test(r.name) ? "borrowings" : /리스/.test(r.name) ? "lease" : null;
  return c && hostSum([c]) > 0 && Math.abs(r.amt) <= hostSum([c]) * 0.5 ? c : null;
}

const PV_FAMS: IbdOutCategory[] = ["borrowings", "lease", "otherDebt", "borrowingsAndBonds"];

function attributeContras(res: IbdV2Result, rows: Record<IbdSection, Row[]>) {
  for (const s of ["current", "nonCurrent", "unclassified"] as const) {
    const secRows = rows[s];
    const hosts = () => secRows.filter((r) => r.line && r.line.category !== "contra" && r.line.amount > 0);
    const hostSum: HostSum = (cats) =>
      hosts()
        .filter((r) => cats.includes(r.line!.category as IbdOutCategory))
        .reduce((a, r) => a + r.line!.amount, 0);
    // 사채 본계정 존재는 원금 행으로만 판정(상환할증금은 부가계정)
    const principal = (c: IbdOutCategory) =>
      hosts()
        .filter((h) => h.line!.category === c && !NAME_PREMIUM.test(h.name))
        .reduce((a, h) => a + h.line!.amount, 0);
    const unit = displayUnit(secRows.filter((r) => r.amt !== 0));
    const tolH = Math.max(unit * 3, 1000);
    const pendingPV: Row[] = [];

    for (const r of secRows.filter((x) => x.line?.category === "contra")) {
      const line = r.line!;
      if (BOND_CONTRA.test(r.name) || BOND_WORD.test(r.name)) {
        const avail = BOND_FAMILY.filter((c) => principal(c) > 0);
        const want: IbdOutCategory = /전환권|신주인수권|교환권/.test(r.name) || NAME_CONVERTIBLE.test(r.name) ? "convertible" : "bonds";
        if (!avail.length) {
          // 계층 부모 블록 안, 또는 '(사채 포함)' 차입금 행이 있으면 그 본계정에 귀속
          const parentHost = hosts().find((h) => hierarchicalChildren(secRows, h, tolH)?.includes(r));
          const withBond = hosts().find((h) => h.line!.category === "borrowings" && /사채포함/.test(h.name));
          const host = parentHost ?? withBond;
          if (host) {
            line.netOf = host.line!.category as IbdOutCategory;
            r.contraBasis = "host";
            res.notes.push(`${r.raw} — ${host.raw} 에 귀속`);
            continue;
          }
          removeLine(res, r);
          res.checks.push(`${r.raw} ${eok(r.amt)} — 사채 본계정 없음(포괄 금융부채에 묶였을 가능성) — 제외`);
          markPartial(res, "사채 차감계정만 있고 사채 본계정이 없음");
          continue;
        }
        line.netOf = avail.includes(want) ? want : avail[0];
        r.contraBasis = "bond";
        continue;
      }
      // 일반 현재가치할인차금
      if (/Deposit|Payable|Guarantee/i.test(r.id)) {
        removeLine(res, r);
        res.checks.push(`${r.raw} ${eok(r.amt)} — 비차입 계정 ID 의 할인차금 — 제외`);
        continue;
      }
      // (0) 비차입 계층 부모(임대보증금 등)의 자식 블록 안이고 그 블록에 차입 행이 없으면 제외
      const nonIbdParent = secRows.find((p) => {
        if (p.line || p.contraName || p.amt <= 0) return false;
        const k = hierarchicalChildren(secRows, p, tolH);
        return !!k && k.includes(r) && !k.some((x) => x.line && x.line.category !== "contra");
      });
      if (nonIbdParent) {
        removeLine(res, r);
        res.checks.push(`${r.raw} ${eok(r.amt)} — 비차입 부모(${nonIbdParent.raw})의 할인차금 — 제외`);
        continue;
      }
      let netOf: IbdOutCategory | null = null;
      // (i) 계층형: IBD 부모 바로 뒤 자식 블록 안
      for (const p of hosts()) {
        if (hierarchicalChildren(secRows, p, tolH)?.includes(r)) {
          netOf = pvNameCat(r, hostSum) ?? (p.line!.category as IbdOutCategory);
          r.contraBasis = "i";
          break;
        }
      }
      // (ii) 표준 ID 가 차입·리스 계열
      if (!netOf && hasStdId(r.id) && (ID_BORROW.test(r.id) || ID_LEASE.test(r.id))) {
        netOf = ID_LEASE.test(r.id) ? "lease" : "borrowings";
        r.contraBasis = "ii";
      }
      if (netOf) {
        line.netOf = netOf;
        continue;
      }
      pendingPV.push(r); // (iii) 은 구역 단위로
    }

    // (iii) (i)·(ii) 로 정해지지 않은 일반 PV 합계가 (본계정 − 이미 채택된 같은 계열 PV)의 50% 이내
    if (pendingPV.length) {
      const pvSum = pendingPV.reduce((a, r) => a + Math.abs(r.amt), 0);
      const adopted = (c: IbdOutCategory) =>
        secRows.filter((x) => x.line?.category === "contra" && x.line.netOf === c).reduce((a, x) => a + Math.abs(x.line!.amount), 0);
      const ok = PV_FAMS.map((c) => ({ c, t: hostSum([c]) - adopted(c) }))
        .filter((x) => x.t > 0 && pvSum <= x.t * 0.5)
        .sort((a, b) => b.t - a.t)[0];
      for (const r of pendingPV) {
        if (ok) {
          r.line!.netOf = pvNameCat(r, hostSum) ?? ok.c;
          r.contraBasis = "iii";
        } else {
          removeLine(res, r);
          res.checks.push(`${r.raw} ${eok(r.amt)} — 본계정 확인 불가(구역 할인차금 합계 ${eok(pvSum)}가 본계정의 50% 초과) — 제외`);
        }
      }
    }
    capBondContras(res, secRows, s);
  }
}

/** 사채 계열 차감 합계가 본계정(원금+할증금) 합을 넘으면 넘는 만큼 버린다(동률은 이름순 — 순서 무관) */
function capBondContras(res: IbdV2Result, secRows: Row[], s: IbdSection) {
  const bondHost = secRows
    .filter((r) => r.line && r.line.category !== "contra" && r.line.amount > 0 && BOND_FAMILY.includes(r.line.category as IbdOutCategory))
    .reduce((a, r) => a + r.line!.amount, 0);
  const bondContras = secRows.filter((x) => x.line?.category === "contra" && x.contraBasis === "bond");
  let over = bondContras.reduce((a, x) => a + Math.abs(x.line!.amount), 0) - bondHost;
  if (over <= 0) return;
  bondContras.sort(
    (a, b) => Math.abs(b.line!.amount) - Math.abs(a.line!.amount) || cmpStr(a.raw, b.raw) || cmpStr(String(a.line!.netOf), String(b.line!.netOf)),
  );
  for (const x of bondContras) {
    if (over <= 0) break;
    const cut = Math.min(Math.abs(x.line!.amount), over);
    x.line!.amount += cut; // 음수 → 0 쪽으로
    over -= cut;
  }
  pushUnique(res.checks, `사채 차감계정 합계가 사채 본계정을 넘음 — 초과분 제외(${SECTION_LABEL[s]})`);
  for (const x of bondContras) if (x.line && x.line.amount === 0) removeLine(res, x);
}

// ─── 4. 포괄 행 제거 — 초과분 단방향 게이트 + 정확한 부분합 + 구조 증거 ───

const PARENT_NAME = /및|합계|대체부분|차입부채$|^차입금$|^사채$/;
const UNCLASSIFIED_PARENT = /^(차입부채|차입금|차입금및사채|사채및(?:장기)?차입금)$/;
/** §0 — 형제는 account_id 오름차순(dart_ < 그 밖 < ifrs-full_). 자식 후보가 정렬상 부모보다 앞이면 형제일 수 없다 */
const sortKey = (r: Row) => (r.id.startsWith("dart_") ? "0" : r.id.startsWith("ifrs-full_") ? "2" : "1") + r.id;
const surelyChild = (p: Row, c: Row) => hasStdId(p.id) && hasStdId(c.id) && sortKey(c) < sortKey(p);

/** 반환: 금액은 맞았지만 구조 증거가 없어 남긴 후보가 있는 구역(경고 강등 금지) */
function dedupeParents(res: IbdV2Result, rows: Record<IbdSection, Row[]>, T: { current: number | null; nonCurrent: number | null }): Set<IbdSection> {
  const unproven = new Set<IbdSection>();
  for (const s of ["current", "nonCurrent"] as const) {
    const secRows = rows[s];
    const Ts = T[s];
    if (Ts == null) {
      if (secRows.filter((r) => r.line && r.line.category !== "contra").length >= 2)
        res.checks.push(`${SECTION_LABEL[s]}부채 구역 소계 없음 — 포괄 행 중복 판정 불가`);
      continue;
    }
    if (Ts <= 0) continue;
    const unit = displayUnit(secRows.filter((r) => r.amt !== 0));
    const tolP = Math.max(unit * 3, 1000);
    // 비차입 계층 부모의 중복분은 초과분에서 뺀다(자식 2행 이상 — 1행은 우연 동액 형제를 부모로 오인)
    const nonIbdDup = secRows
      .filter((r) => !r.line && !r.contraName && r.amt > 0 && hierarchicalChildren(secRows, r, tolP, 2))
      .reduce((a, r) => a + r.amt, 0);
    const X0 = secRows.reduce((a, r) => a + rowValue(r), 0) - Ts - nonIbdDup;
    if (X0 <= 0.01 * Ts) continue;
    const unprovenP = new Set<Row>();
    let removed = 0;
    for (let iter = 0; iter < 10; iter++) {
      const X = X0 - removed;
      if (X <= 0) break; // 누적 상한은 후보 필터 A ≤ X + tol 이 맡는다
      const ibd = secRows.filter((r) => r.line);
      const maxK = ibd.length > 18 ? 3 : 6;
      type Cand = { p: Row; kids: Row[]; diff: number; hasContra: boolean; block: boolean };
      const cands: Cand[] = [];
      for (const p of ibd) {
        if (p.line!.category === "contra" || p.line!.amount <= 0) continue;
        const A = p.line!.amount;
        const others = ibd.filter((r) => r !== p);
        const tolFor = (k: number) => Math.min(Math.max(1000, unit * (k + 1)), 0.0005 * A, 1e6);
        if (A > X + tolFor(1)) continue; // 단방향 상한
        const follow = followingRows(secRows, p);
        // (가) 연속 블록은 순서 기반이라 행 수와 무관하게 6행까지 항상 후보
        const prefixBlocks: Row[][] = [];
        for (let k = maxK + 1; k <= Math.min(6, follow.length); k++) {
          const blk = follow.slice(0, k);
          if (blk.every((r) => r.line)) prefixBlocks.push(blk);
        }
        for (const S of [...subsets(others, maxK), ...prefixBlocks]) {
          const sum = S.reduce((a, r) => a + r.line!.amount, 0);
          const diff = Math.abs(sum - A);
          if (diff > tolFor(S.length)) continue;
          // |S|=1 인데 그 행이 스스로 연속 자식 블록을 가진 부모면 형제로 본다
          if (S.length === 1 && hierarchicalChildren(secRows, S[0], tolP) !== null) continue;
          const block = follow.length >= S.length && follow.slice(0, S.length).every((r) => S.includes(r));
          const sameName = S.length === 1 && S[0].name === p.name;
          const parentName = S.length >= 2 && PARENT_NAME.test(p.name);
          const contras = S.filter((r) => r.line!.category === "contra");
          const gross = S.filter((r) => r.line!.category !== "contra");
          const pc = p.line!.category as IbdOutCategory;
          const gc = gross[0]?.line!.category as IbdOutCategory | undefined;
          // (라) 순액 부모 = 같은 계열 총액 행 + 차감계정
          const netParent =
            S.length === 2 && contras.length === 1 && gross.length === 1 && (gc === pc || (!!gc && BOND_FAMILY.includes(gc) && BOND_FAMILY.includes(pc)));
          const evidence =
            S.length === 1
              ? sameName || (block && (PARENT_NAME.test(p.name) || /총액/.test(p.name) || /Gross$/i.test(p.id) || surelyChild(p, S[0])))
              : block || parentName || netParent;
          if (!evidence) {
            unprovenP.add(p);
            continue;
          }
          cands.push({ p, kids: S, diff, hasContra: contras.length > 0, block });
        }
      }
      if (!cands.length) break;
      cands.sort(
        (a, b) =>
          a.diff - b.diff ||
          Number(b.hasContra) - Number(a.hasContra) ||
          Number(b.block && b.kids.length >= 2) - Number(a.block && a.kids.length >= 2) ||
          Number(b.block) - Number(a.block) ||
          b.p.line!.amount - a.p.line!.amount,
      );
      const best = cands[0];
      const A = best.p.line!.amount;
      removed += A;
      best.p.removedParent = true;
      removeLine(res, best.p);
      res.meta.dedupeRemoved.push({ section: s, account: best.p.raw, amount: A, children: best.kids.map((k) => k.raw) });
      res.notes.push(`포괄 행 제외: ${best.p.raw} ${eok(A)} = ${best.kids.map((k) => k.raw).join(" + ")}`);
    }
    if ([...unprovenP].some((p) => p.line)) unproven.add(s);
  }

  // 미구분 재무상태표 — 부채총계 대비 초과분 안에서, 이름이 포괄형이고 다른 IBD 행의 부분합과 정확히 같을 때만
  const un = rows.unclassified;
  const cands = un.filter((r) => r.line && r.line.category !== "contra" && UNCLASSIFIED_PARENT.test(r.name));
  if (cands.length) {
    const TL = res.meta.totalLiabilities;
    if (TL == null) {
      res.checks.push("미구분 재무상태표에 부채총계 없음 — 포괄 행 중복 판정 불가");
    } else {
      let Xu = un.filter((r) => !r.afterTL).reduce((a, r) => a + rowValue(r), 0) - TL;
      const unit = displayUnit(un.filter((r) => r.amt !== 0));
      for (const p of cands) {
        if (!p.line) continue;
        const A = p.line.amount;
        const tol = Math.min(Math.max(1000, unit * 3), 0.0005 * A, 1e6);
        if (A > Xu + tol) continue;
        const others = un.filter((r) => r.line && r !== p);
        for (const S of subsets(others, 6)) {
          if (Math.abs(S.reduce((a, r) => a + r.line!.amount, 0) - A) > tol) continue;
          if (S.length === 1 && p.name === "차입금" && S[0].line!.category !== "borrowings") continue;
          p.removedParent = true;
          removeLine(res, p);
          Xu -= A;
          res.meta.dedupeRemoved.push({ section: "unclassified", account: p.raw, amount: A, children: S.map((k) => k.raw) });
          res.notes.push(`포괄 행 제외: ${p.raw} ${eok(A)} = ${S.map((k) => k.raw).join(" + ")}`);
          if (S.length === 1) res.checks.push(`포괄 행 1:1 제거 — 원문 확인: ${p.raw} = ${S[0].raw}`);
          break;
        }
      }
    }
  }
  return unproven;
}

/** 포괄 행을 뺀 구역에서 (iii) 로 채택한 할인차금과 사채 상한을 남은 본계정 기준으로 다시 판정 */
function revalidateContras(res: IbdV2Result, rows: Record<IbdSection, Row[]>) {
  for (const s of ["current", "nonCurrent", "unclassified"] as const) {
    const removed = res.meta.dedupeRemoved.filter((d) => d.section === s);
    if (!removed.length) continue;
    const kids = new Set(removed.flatMap((d) => d.children));
    const secRows = rows[s];
    const hostSum: HostSum = (cats) =>
      secRows
        .filter((r) => r.line && r.line.category !== "contra" && r.line.amount > 0 && cats.includes(r.line.category as IbdOutCategory))
        .reduce((a, r) => a + r.line!.amount, 0);
    const pv = secRows.filter((r) => r.line?.category === "contra" && r.contraBasis === "iii" && !kids.has(r.raw));
    if (pv.length) {
      const pvSum = pv.reduce((a, r) => a + Math.abs(r.amt), 0);
      const ok = PV_FAMS.some((c) => hostSum([c]) > 0 && pvSum <= hostSum([c]) * 0.5);
      if (!ok)
        for (const r of pv) {
          removeLine(res, r);
          res.checks.push(`${r.raw} ${eok(r.amt)} — 포괄 행 제외 후 본계정 확인 불가 — 제외`);
        }
    }
    capBondContras(res, secRows, s);
  }
}

/** 게이트에 막히는 작은 진짜 중복을 흔적으로 남긴다 — checks 가 아니라 notes(BW=CB 정상 사례 소음 방지) */
function sameAmountNotes(res: IbdV2Result, rows: Record<IbdSection, Row[]>) {
  for (const s of ["current", "nonCurrent", "unclassified"] as const) {
    const by = new Map<number, Row[]>();
    for (const r of rows[s]) if (r.line && r.line.category !== "contra" && r.line.amount > 0) by.set(r.line.amount, [...(by.get(r.line.amount) ?? []), r]);
    for (const [amt, rs] of by)
      if (rs.length >= 2) pushUnique(res.notes, `동일 금액 IBD 행 쌍 — 중복 여부 확인: ${rs.map((r) => r.raw).join(" = ")} ${eok(amt)}(${SECTION_LABEL[s]})`);
  }
}

// ─── 4b. 본문에 리스가 없는지, 리스를 담을 행이 있는지(주석 리스 보충 판단용) ───

const CONTAINER_NAME = /기타|매입채무및|지급채무|금융부채|미지급|채무/;
const CONTAINER_ID = /Other\w*(?:Liabilities|Payables)|TradeAndOther\w*Payables|OtherFinancialLiabilities/i;
const NOT_CONTAINER = /충당|확정급여|법인세|계약부채|이연|선수|예수|보증금/;

function leaseInfo(res: IbdV2Result, rows: Record<IbdSection, Row[]>) {
  const all = [...rows.current, ...rows.nonCurrent, ...rows.unclassified];
  const hasLeaseLine = [...res.current, ...res.nonCurrent, ...res.unclassified].some((l) => l.category === "lease");
  const leaseNamed = all.some((r) => /리스/.test(r.name) && r.amt !== 0);
  const leaseInclusive = res.notes.some((n) => n === LEASE_IN_BORROW_NOTE || n === LEASE_IN_BOND_NOTE);
  res.meta.leaseAbsent = !res.excluded && !hasLeaseLine && !leaseNamed && !leaseInclusive;
  const names: string[] = [];
  for (const s of ["current", "nonCurrent"] as const) {
    const unit = displayUnit(rows[s].filter((r) => r.amt !== 0));
    const tolH = Math.max(unit * 3, 1000);
    let sum = 0;
    for (const r of rows[s]) {
      if (r.line || r.contraName || r.removedParent || r.amt <= 0) continue;
      if (!(CONTAINER_NAME.test(r.name) || CONTAINER_ID.test(r.id)) || NOT_CONTAINER.test(r.name)) continue;
      if (hierarchicalChildren(rows[s], r, tolH, 2)) continue; // 계층 부모는 자식과 이중으로 세지 않는다
      sum += r.amt;
      names.push(r.raw);
    }
    res.meta.leaseContainers[s] = sum;
  }
  res.meta.leaseContainers.names = names;
}

// ─── 5. 구역 행 합계 대조 — 비차입 부모 행으로 설명되면 참고로 강등 ───

function sectionChecks(
  res: IbdV2Result,
  rows: Record<IbdSection, Row[]>,
  T: { current: number | null; nonCurrent: number | null },
  unproven: Set<IbdSection>,
) {
  for (const s of ["current", "nonCurrent"] as const) {
    const Ts = T[s];
    if (!Ts || Ts <= 0) continue;
    const secRows = rows[s];
    const removed = res.meta.dedupeRemoved.filter((d) => d.section === s).reduce((a, d) => a + d.amount, 0);
    const X = secRows.reduce((a, r) => a + rowValue(r), 0) - removed - Ts;
    if (Math.abs(X) <= 0.01 * Ts) continue;
    const label = SECTION_LABEL[s];
    if (X < 0) {
      res.checks.push(`${label}부채 행 합계가 소계와 미달 (${((X / Ts) * 100).toFixed(1)}%) — 세부 행 누락 가능`);
      continue;
    }
    // 비차입 부모 행(바로 뒤 연속 자식 합과 같은 행)으로 초과분이 설명되는지
    const unit = displayUnit(secRows.filter((r) => r.amt !== 0));
    let explained = 0;
    const parents: string[] = [];
    for (const r of secRows) {
      if (r.line || r.removedParent || r.contraName || r.amt <= 0) continue;
      if (hierarchicalChildren(secRows, r, Math.max(unit * 3, 1000), 1)) {
        explained += r.amt;
        parents.push(r.raw);
      }
    }
    if (parents.length && !unproven.has(s) && Math.abs(X - explained) <= 0.01 * Ts && X / Ts <= 1.005) {
      res.notes.push(`비차입 부모 행 중복(IBD 영향 없음): ${parents.join(", ")}`);
    } else {
      res.checks.push(`${label}부채 행 합계가 소계와 초과 (${((X / Ts) * 100).toFixed(1)}%) — 소계 행 중복 또는 세부 행 누락 가능`);
    }
  }
}

// ─── 6. 참고 표시 — 금융부문 연결·매각예정·당기손익-공정가치 금융부채 ───

function referenceNotes(res: IbdV2Result, bs: DartFinancialItem[], hasSections: boolean, fvtpl: string[], finRelated: boolean) {
  // 업종 note 가 이미 붙은 금융 관련 업종은 생략(64992 비금융 지주는 대상)
  if (hasSections && !finRelated) {
    const fin = bs.filter((r) => FIN_SEGMENT_ID.test(r.account_id ?? "") || FIN_SEGMENT_NAME.test(normName(r.account_nm ?? "")));
    const sum = fin.reduce((a, r) => a + Math.abs(parseAmount(r.thstrm_amount) ?? 0), 0);
    if (fin.length && res.meta.totalAssets && sum >= 0.05 * res.meta.totalAssets) {
      res.meta.financialSegment = true;
      res.notes.push("금융 자회사 연결 가능 — 이자부부채에 금융부문 조달이 포함될 수 있음, 부문정보 확인");
    }
  }
  let hfsA = 0;
  let hfsL = 0;
  for (const r of bs) {
    const id = r.account_id ?? "";
    const n = normName(r.account_nm ?? "");
    const a = parseAmount(r.thstrm_amount) ?? 0;
    // 자본 구역의 매각예정 관련 OCI 등은 처분자산집단이 아니다(K-IFRS 1105 문단 38)
    if (/OtherComprehensiveIncome|Reserve|Equity/i.test(id) || /기타포괄|손익|자본|적립금|잉여금/.test(n)) continue;
    if (/LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale/i.test(id) || (/매각예정/.test(n) && /부채/.test(n))) hfsL += a;
    else if (/NoncurrentAssetsOrDisposalGroupsClassifiedAsHeldForSale/i.test(id) || (/매각예정/.test(n) && /자산/.test(n))) hfsA += a;
  }
  if (hfsL) {
    res.meta.heldForSale = { assets: hfsA, liabilities: hfsL, net: hfsA - hfsL };
    res.notes.push(`매각예정 처분자산집단 — 부채 ${eok(hfsL)}(자산 ${eok(hfsA)}) 은 이자부부채에 넣지 않음, 차입 포함 여부는 주석 확인`);
  }
  if (fvtpl.length) res.notes.push(`당기손익-공정가치 금융부채 ${fvtpl.join(", ")} — 성격(RCPS·CB·파생)은 주석 확인`);
}

// ─── 7. 사후 점검 ───

const LEASE_MISSING = "사용권자산이 있으나 리스부채를 찾지 못함";
const POST_CHECKS = [/^이자부부채 합계가 음수/, new RegExp(`^${EXCEEDS_TL_MSG}`), new RegExp(`^${LEASE_MISSING}`)];
const POST_REASONS = ["합계 음수", "부채총계 초과", "리스부채 누락 가능"];
function postChecks(res: IbdV2Result) {
  res.checks = res.checks.filter((c) => !POST_CHECKS.some((p) => p.test(c)));
  // 사후 사유도 다시 판정(주석 보충 뒤 합계가 양수가 되면 '합계 음수' 제거)
  res.completenessReasons = res.completenessReasons.filter((r) => !POST_REASONS.includes(r));
  res.completeness = res.completenessReasons.length ? "partial" : "full";
  if (res.total < 0) {
    res.checks.push("이자부부채 합계가 음수 — 차감계정 판정 확인 필요");
    markPartial(res, "합계 음수");
  }
  // 본문·주석 어디서도 리스를 못 찾았는데 사용권자산이 있으면(분기 XBRL 에 리스 태그가 없는 회사 등) 누락 가능
  res.notes = res.notes.filter((n) => !n.startsWith(LEASE_MISSING));
  const rou = res.meta.rouAssets;
  if (!res.excluded && res.meta.leaseAbsent && rou > 0 && ![...res.current, ...res.nonCurrent, ...res.unclassified].some((l) => l.category === "lease")) {
    const msg = `${LEASE_MISSING}(사용권자산 ${eok(rou)}) — 리스가 기타부채 등에 포함됐을 가능성, 원문 확인`;
    if (rou >= Math.max(1e9, 0.01 * (res.meta.totalLiabilities ?? 0))) {
      res.checks.push(msg);
      markPartial(res, "리스부채 누락 가능");
    } else res.notes.push(msg);
  }
  const tl = res.meta.totalLiabilities;
  if (tl && tl > 0 && res.total > tl * 1.001) {
    res.checks.push(`${EXCEEDS_TL_MSG} (${eok(res.total)} > ${eok(tl)}) — 원자료 확인`);
    markPartial(res, "부채총계 초과");
  }
}

/** 묶인 금융부채가 부채에서 차지하는 비중(판단 불가면 null) */
function aggShare(res: IbdV2Result): number | null {
  const T = res.meta.sectionTotals;
  const a = res.meta.aggregatedFinancialLiabilities;
  const liab = (T.current ?? 0) + (T.nonCurrent ?? 0);
  return liab > 0 ? ((a.current ?? 0) + (a.nonCurrent ?? 0)) / liab : null;
}

/** 호출부가 XBRL 조회 결과를 알려 준다(주석 보충이 필요했는데 받지 못한 경우 등) */
export function setXbrlStatus(res: IbdV2Result, status: XbrlStatus): void {
  res.meta.xbrlStatus = status;
  const MSG: Partial<Record<XbrlStatus, string>> = {
    xml_error: XBRL_ERROR_MSG,
    xml_absent: "주석 XBRL 없음 — 묶인 금융부채 안의 차입금 미확인",
    context_not_found: "주석 XBRL 에서 연결/별도 당기말 문맥을 찾지 못함 — 묶인 금융부채 안의 차입금 미확인",
    not_fetched: "주석 XBRL 미확보(원자료에 없음·옛 원자료) — 재수집 필요",
  };
  const msg = MSG[status];
  if (!msg) return;
  res.checks = res.checks.filter((c) => !c.includes("주석(XBRL) 보충 필요"));
  // 없음·문맥 없음은 '찾지 못함'과 같은 30% 문턱 — 묶인 금액이 작으면 참고로(오류·미확보는 항상 경고)
  const share = aggShare(res);
  if ((status === "xml_absent" || status === "context_not_found") && share != null && share < 0.3) {
    pushUnique(res.notes, `${msg} (묶인 금융부채가 부채의 ${Math.round(share * 100)}% — 문턱 미만)`);
    return;
  }
  pushUnique(res.checks, msg);
  markPartial(res, "주석 보충 필요하나 XBRL 없음");
}

/** 주석 보충이 필요한지 — 묶인 금융부채(차입 보충) 또는 본문에 리스가 전혀 없음(리스 보충) */
export function needsXbrlNotes(res: IbdV2Result): boolean {
  const a = res.meta.aggregatedFinancialLiabilities;
  return !res.excluded && (!!a.current || !!a.nonCurrent || res.meta.leaseAbsent);
}

/**
 * 주석(XBRL) 보충.
 *  (1) 차입 — 본문에 차입금·사채 없이 "금융부채"로 묶인 구역에 한해 주석 금액을 더한다.
 *      본문에 이미 있는 금액은 더하지 않고(총계 폴백은 잔액만), 구역 부채 소계를 넘는 금액은 보충하지 않는다.
 *      구역별로 못 넣은 곳이 있으면 알리고, 재무활동부채 조정표 합계와 대조해 과소 가능성을 알린다.
 *  (2) 리스 — 본문에 리스부채 행이 전혀 없으면(기타부채 등에 포함된 회사), 주석 리스를 담을 수 있는 행이
 *      있을 때만 더한다. 본문 차입금이 주석 차입금+리스와 같으면(차입금 행에 포함) 더하지 않는다.
 */
export function applyXbrlSupplement(res: IbdV2Result, x: XbrlDebtSummary): void {
  const agg = res.meta.aggregatedFinancialLiabilities;
  const T = res.meta.sectionTotals;
  const hasAgg = !!agg.current || !!agg.nonCurrent;
  let appliedDebt = false;
  let appliedLease = false;
  let skippedSame = false;
  let heldDebt = false;
  const add = (s: IbdSection, account: string, amount: number, category: IbdOutCategory) => {
    res[s].push({ account, amount, category, accountId: "xbrl-note" });
  };
  /** 합계를 amount 로 유지하며 차입금/사채로 비례 배분 */
  const addSplit = (s: IbdSection, label: string, amount: number, loans: number, bonds: number) => {
    const l = Math.round((amount * loans) / (loans + bonds));
    if (l) add(s, `${label} 중 차입금`, l, "borrowings");
    if (amount - l) add(s, `${label} 중 사채`, amount - l, "bonds");
    if (loans + bonds !== amount) res.notes.push(`주석 구성 요소 합과 포괄 요소 차이 ${eok(loans + bonds - amount)} — 포괄 요소 기준으로 나눔`);
  };
  /** 구역 s 에 차입 보충 — 부채 소계 상한, 가능하면 차입금/사채로 나눠 넣는다 */
  const addDebt = (s: "current" | "nonCurrent", amount: number | null, loans: number | null, bonds: number | null) => {
    if (!amount || amount <= 0) return;
    const cap = T[s];
    if (cap != null && amount > cap) {
      res.checks.push(`주석 차입금 ${eok(amount)}이 ${SECTION_LABEL[s]}부채 소계 ${eok(cap)}를 넘음 — 보충 보류`);
      markPartial(res, "주석 차입금이 부채 소계 초과 — 보충 보류");
      heldDebt = true;
      return;
    }
    const label = "차입금·사채(주석)";
    if (loans != null && bonds != null && loans + bonds > 0 && Math.abs(loans + bonds - amount) <= amount * 0.01) addSplit(s, label, amount, loans, bonds);
    else if (loans != null && bonds == null && Math.abs(loans - amount) <= amount * 0.01) add(s, `${label} 중 차입금`, amount, "borrowings");
    else if (bonds != null && loans == null && Math.abs(bonds - amount) <= amount * 0.01) add(s, `${label} 중 사채`, amount, "bonds");
    else add(s, label, amount, "borrowingsAndBonds");
    appliedDebt = true;
  };
  const allLines = () => [...res.current, ...res.nonCurrent, ...res.unclassified];
  const hasLease = (s: IbdSection) => res[s].some((l) => l.category === "lease");
  const bodyDebtOf = (lines: IbdLine[]) => lines.filter((l) => l.accountId !== "xbrl-note" && l.category !== "lease").reduce((a, l) => a + l.amount, 0);
  const noteDebtIn = (s: IbdSection) => res[s].some((l) => l.accountId === "xbrl-note" && l.category !== "lease");

  // ── (1) 차입 보충 ──
  if (hasAgg) {
    if (agg.current) {
      addDebt("current", x.current, x.currentLoans, x.currentBonds);
      if (!hasLease("current") && x.leaseCurrent && x.leaseCurrent > 0) {
        add("current", "리스부채(주석)", x.leaseCurrent, "lease");
        appliedLease = true;
      }
    }
    if (agg.nonCurrent) {
      addDebt("nonCurrent", x.nonCurrent, x.nonCurrentLoans, x.nonCurrentBonds);
      if (!hasLease("nonCurrent") && x.leaseNonCurrent && x.leaseNonCurrent > 0) {
        add("nonCurrent", "리스부채(주석)", x.leaseNonCurrent, "lease");
        appliedLease = true;
      }
    }
    // 주석 차입금 총계의 잔액 — 유동·비유동 중 일부 태그가 빠져도 총계는 태깅된 회사(LG디스플레이 유동성장기차입금 등).
    // 총계 − (본문 차입 + 이미 넣은 주석 차입) 을 묶인 금융부채의 여유 안에서 채운다.
    if (x.total && x.total > 0 && !heldDebt && (x.current != null || x.nonCurrent != null)) {
      // 차입금 총계 태그가 리스까지 품었으면(유동+비유동과의 차이 = 리스) 리스를 빼고 본다
      const comp = (x.current ?? 0) + (x.nonCurrent ?? 0);
      const leases = [(x.leaseCurrent ?? 0) + (x.leaseNonCurrent ?? 0), x.leaseNonCurrent ?? 0, x.leaseCurrent ?? 0].filter((v) => v > 0);
      const inclLease = leases.find((L) => Math.abs(x.total! - comp - L) <= L * 0.05) ?? 0;
      const totalDebt = x.total - inclLease;
      const noteDebtAdded = allLines().filter((l) => l.accountId === "xbrl-note" && l.category !== "lease").reduce((a, l) => a + l.amount, 0);
      const resid = totalDebt - bodyDebtOf(allLines()) - noteDebtAdded;
      if (resid > Math.max(0.01 * totalDebt, 1e8)) {
        const capOf = (s: "current" | "nonCurrent") =>
          agg[s] ? Math.max(0, Math.min(T[s] ?? Infinity, agg[s]!) - res[s].filter((l) => l.accountId === "xbrl-note").reduce((a, l) => a + l.amount, 0)) : 0;
        const caps = { current: capOf("current"), nonCurrent: capOf("nonCurrent") };
        const cat: IbdOutCategory = x.totalPartial && x.bondsIssued == null ? "borrowings" : "borrowingsAndBonds";
        const one = (["current", "nonCurrent"] as const).filter((s) => caps[s] >= resid).sort((a, b) => caps[b] - caps[a])[0];
        const capSum = caps.current + caps.nonCurrent;
        if (one) {
          add(one, `차입금·사채(주석 총계 잔액, ${SECTION_LABEL[one]} 추정)`, resid, cat);
          appliedDebt = true;
          res.checks.push(`주석 차입금 총계 ${eok(totalDebt)} 중 구역 태그가 없는 ${eok(resid)}를 ${SECTION_LABEL[one]}로 추정 — 원문 확인 권장`);
        } else if (capSum > 0 && resid <= capSum * 1.25) {
          // 잔액이 묶인 금융부채 여유를 넘으면 그 행 전부를 차입으로 본다(여유분만 반영)
          for (const s of ["current", "nonCurrent"] as const)
            if (caps[s] > 0) add(s, `차입금·사채(주석 총계 잔액, 묶인 금융부채 전액)`, caps[s], cat);
          appliedDebt = true;
          res.checks.push(`주석 차입금 총계 잔액 ${eok(resid)}이 묶인 금융부채 여유 ${eok(capSum)}보다 커 여유분만 반영 — 원문 확인 권장`);
        } else if (capSum > 0) {
          res.checks.push(`주석 차입금 총계 잔액 ${eok(resid)} — 묶인 금융부채에 담을 수 없어 반영 보류`);
          markPartial(res, "주석 차입금 총계 대비 과소");
        }
      }
    }
    // 주석에 유동/비유동 구분 없이 차입금 총계만 있으면(셀트리온 2025.3Q 등) 본문 차입과 대조해 잔액만 — 항상 미구분 행
    if (x.current == null && x.nonCurrent == null && x.total && x.total > 0) {
      const body = allLines().filter((l) => l.accountId !== "xbrl-note");
      const catOf = (l: IbdLine) => (l.category === "contra" ? l.netOf ?? "bonds" : l.category);
      const sumCats = (cats: IbdOutCategory[]) => body.filter((l) => cats.includes(catOf(l))).reduce((a, l) => a + l.amount, 0);
      const bLoan = sumCats(["borrowings", "otherDebt", "borrowingsAndBonds"]);
      const bBond = sumCats(["bonds", "convertible"]);
      const near = (a: number, b: number) => b > 0 && Math.abs(a - b) <= b * 0.01;
      const singles = body.filter((l) => l.category !== "contra" && l.category !== "lease").map((l) => l.amount);
      if (near(x.total, bLoan) || near(x.total, bLoan + bBond) || singles.some((v) => near(x.total!, v))) {
        skippedSame = true;
        res.notes.push("주석 차입금 총계가 본문 차입금과 같음 — 보충 생략");
      } else {
        const base = x.totalPartial && x.bondsIssued == null ? bLoan : bLoan + bBond;
        const resid = x.total - base;
        if (resid <= Math.max(0.01 * x.total, 1e8)) {
          skippedSame = true;
          res.notes.push(`주석 차입금 총계(${eok(x.total)})가 본문 차입금 이하 — 보충 생략`);
        } else {
          const cap = (agg.current ? T.current ?? 0 : 0) + (agg.nonCurrent ? T.nonCurrent ?? 0 : 0);
          if (cap && resid > cap) {
            res.checks.push(`주석 차입금 잔액 ${eok(resid)}이 부채 소계 ${eok(cap)}를 넘음 — 보충 보류`);
            markPartial(res, "주석 차입금이 부채 소계 초과 — 보충 보류");
            heldDebt = true;
          } else {
            const label = base > 0 ? "차입금·사채(주석 총계 − 본문, 유동/비유동 미구분)" : "차입금·사채(주석, 유동/비유동 미구분)";
            const lr = x.loansReceived;
            const bi = x.bondsIssued;
            if (base <= 0 && lr != null && bi != null && lr + bi > 0 && Math.abs(lr + bi - resid) <= resid * 0.01) addSplit("unclassified", label, resid, lr, bi);
            else if (base <= 0 && x.totalPartial && bi == null && lr != null) add("unclassified", `${label} 중 차입금`, resid, "borrowings");
            else add("unclassified", label, resid, "borrowingsAndBonds");
            appliedDebt = true;
            if (base > 0) res.checks.push(`주석 차입금 총계 ${eok(x.total)} 중 본문 차입금을 뺀 ${eok(resid)} 보충 — 원문 확인 권장`);
          }
        }
      }
    }
  }

  // ── (2) 리스 — 본문에 리스 행이 전혀 없을 때(구역별로, 이미 리스를 넣은 구역은 건너뜀) ──
  if (res.meta.leaseAbsent) {
    const noteLeaseSplit = (x.leaseCurrent ?? 0) + (x.leaseNonCurrent ?? 0);
    const noteLease = noteLeaseSplit || (x.leaseTotal ?? 0);
    const noteDebt = x.total ?? (x.current != null || x.nonCurrent != null ? (x.current ?? 0) + (x.nonCurrent ?? 0) : null);
    const bodyDebt = bodyDebtOf(allLines());
    const C = res.meta.leaseContainers;
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.abs(b) * tol;
    if (noteLease > 0) {
      const both = (noteDebt ?? 0) + noteLease;
      const comp = (x.current ?? 0) + (x.nonCurrent ?? 0);
      const leases = [noteLeaseSplit, x.leaseNonCurrent ?? 0, x.leaseCurrent ?? 0, x.leaseTotal ?? 0].filter((v) => v > 0);
      // 차입금 총계 태그가 리스를 품고(총계 − 유동·비유동 = 리스) 본문 차입금이 그 총계와 같으면 — 리스는 차입금 행 안(LG화학·LG에너지솔루션)
      const tagInclLease =
        x.total != null && comp > 0 && leases.some((L) => near(x.total! - comp, L, 0.05)) && bodyDebt > 0 && near(bodyDebt, x.total, 0.01);
      if (tagInclLease) {
        res.notes.push(`본문 차입금(${eok(bodyDebt)})이 리스를 품은 주석 차입금 총계와 같음 — 리스가 차입금 행에 포함된 것으로 보고 리스 보충 생략`);
      } else if (noteDebt != null && noteDebt > 0 && bodyDebt > 0 && near(bodyDebt, both, 0.01) && !near(bodyDebt, noteDebt, 0.01)) {
        res.notes.push(`본문 차입금(${eok(bodyDebt)})이 주석 차입금+리스와 같음 — 리스가 차입금 행에 포함된 것으로 보고 리스 보충 생략`);
      } else {
        let added = false;
        const miss: string[] = [];
        if (noteLeaseSplit > 0) {
          const pairs: ["current" | "nonCurrent", number | null, number | null][] = [
            ["current", x.leaseCurrent, x.current],
            ["nonCurrent", x.leaseNonCurrent, x.nonCurrent],
          ];
          for (const [s, amt, noteS] of pairs) {
            if (!amt || amt <= 0 || hasLease(s)) continue;
            // 그 구역 본문 차입이 주석 차입보다 딱 리스만큼 많으면 리스는 차입금 행 안
            const bodyS = bodyDebtOf(res[s]);
            if (noteS != null && bodyS > 0 && near(bodyS - noteS, amt, 0.05)) continue;
            if (C[s] >= amt * 0.999) {
              add(s, "리스부채(주석, 본문 기타부채 등에 포함)", amt, "lease");
              added = true;
            } else miss.push(`${SECTION_LABEL[s]} ${eok(amt)}`);
          }
        } else if (!allLines().some((l) => l.category === "lease")) {
          if (C.current + C.nonCurrent >= noteLease * 0.999) {
            add("unclassified", "리스부채(주석, 유동/비유동 미구분, 본문 기타부채 등에 포함)", noteLease, "lease");
            added = true;
          } else miss.push(`총계 ${eok(noteLease)}`);
        }
        if (added) {
          appliedLease = true;
          res.notes.push(`본문에 리스부채 행이 없어 주석 리스를 반영 — 본문 ${C.names.slice(0, 4).join("·") || "기타부채"} 등에 포함된 것으로 봄`);
        }
        if (miss.length) res.checks.push(`주석 리스 ${miss.join(", ")} — 본문에서 담긴 행을 찾지 못해 반영 보류, 원문 확인`);
      }
    }
  }

  res.checks = res.checks.filter((c) => !c.includes("주석(XBRL) 보충 필요"));
  res.meta.xbrlApplied = { debt: appliedDebt, lease: appliedLease };
  res.meta.xbrlSupplemented = appliedDebt || appliedLease;
  if (hasAgg)
    res.meta.xbrlStatus = appliedDebt ? "applied" : heldDebt ? "held" : skippedSame ? "same_as_body" : appliedLease ? "lease_only" : "no_debt_elements";
  else if (appliedLease) res.meta.xbrlStatus = "lease_only";

  if (hasAgg) {
    const liab = (T.current ?? 0) + (T.nonCurrent ?? 0);
    if (!appliedDebt && !skippedSame && !heldDebt) {
      // 무차입 회사의 '기타금융부채'(미지급·보증금 등)가 대부분이라, 묶인 금액이 부채의 30% 이상일 때만 경고
      const share = aggShare(res);
      const msg = "주석에서도 차입금·사채 금액을 찾지 못함 — 포괄 금융부채에 차입이 없거나 비표준 태그";
      if (share != null && share >= 0.3) {
        res.checks.push(`${msg} (금융부채가 부채의 ${Math.round(share * 100)}%)`);
        markPartial(res, "포괄 금융부채 안의 차입금 미확인");
      } else res.notes.push(msg);
      if (appliedLease) res.notes.push("주석 리스만 보충 — 차입금·사채는 주석에서 찾지 못함");
    } else if (heldDebt && !appliedDebt) {
      if (appliedLease) res.notes.push("주석 리스만 보충 — 주석 차입금은 부채 소계 초과로 보류");
    } else if (appliedDebt) {
      if (x.reconciles === false) res.checks.push("주석 보충 적용 — 주석 차입금 총계와 유동+비유동 불일치, 원문 확인 필요");
      else if (x.current == null && x.nonCurrent == null && x.totalPartial)
        res.checks.push("주석 보충 적용 — 차입금(LoansReceived)·사채(BondsIssued) 합계로 산정, 유동/비유동 미구분 — 원문 확인 권장");
      else res.notes.push("주석 보충 적용 — 본문 '금융부채' 안의 차입금·사채·리스를 주석 금액으로 산정");
      if (x.usedFallback) res.notes.push("주석 보충에 대체 요소(장기차입금·기타차입금·dart 사채) 사용");
      for (const s of ["current", "nonCurrent"] as const) {
        const a = agg[s];
        const debt = res[s].filter((l) => l.accountId === "xbrl-note" && l.category !== "lease").reduce((p, l) => p + l.amount, 0);
        if (a && debt > a * 1.05) res.checks.push(`${SECTION_LABEL[s]} 주석 차입 보충액이 본문 금융부채를 초과 — 원문 확인`);
      }
      // 구역별 누락 — 한 구역만 보충되면 다른 구역의 누락이 묻히지 않게
      const coveredAll = res.unclassified.some((l) => l.accountId === "xbrl-note" && l.category !== "lease");
      if (!coveredAll)
        for (const s of ["current", "nonCurrent"] as const) {
          const a = agg[s];
          if (!a || noteDebtIn(s)) continue;
          const share = liab > 0 ? a / liab : 0;
          const msg = `${SECTION_LABEL[s]} 금융부채 ${eok(a)} 안의 차입금 미확인 — 주석에 해당 구역 태그 없음`;
          if (share >= 0.1) {
            res.checks.push(`${msg} (부채의 ${Math.round(share * 100)}%)`);
            markPartial(res, `${SECTION_LABEL[s]} 금융부채 안의 차입금 미확인`);
          } else res.notes.push(msg);
        }
    } else if (appliedLease) {
      res.notes.push("주석 리스 보충 적용");
    }
  }
  recomputeTotal(res);
  // 재무활동부채 조정표 합계와 대조 — 차입을 보충한 회사에서 남은 묶인 금액 안의 과소 가능성
  if (appliedDebt && x.laffa && x.laffa > 0) {
    const gap = x.laffa - res.total;
    const noteDebt = allLines().filter((l) => l.accountId === "xbrl-note" && l.category !== "lease").reduce((a, l) => a + l.amount, 0);
    const remaining = (agg.current ?? 0) + (agg.nonCurrent ?? 0) - noteDebt;
    if (gap > Math.max(0.01 * x.laffa, 1e8) && gap <= remaining) {
      res.checks.push(`재무활동부채 조정표 기말 ${eok(x.laffa)} 대비 ${eok(gap)} 적음 — 주석에 비표준 태그 차입 가능`);
      markPartial(res, "재무활동부채 조정표 대비 과소");
    }
  }
  postChecks(res);
}

// ─── 출력(캐시) 형식 ───

/** [계정명, 금액, 범주] — 캐시·도구 상세 출력의 행 단위 */
export type IbdTuple = [string, number, IbdOutCategory];

/** 캐시에 저장하는 이자부부채(행 단위 전체). 도구는 여기서 요약·상세를 만든다(ibd-output.ts) */
export interface CompactIbd {
  total: number;
  current: IbdTuple[];
  nonCurrent: IbdTuple[];
  /** 유동/비유동 구분이 없는 재무상태표의 항목 */
  unclassified?: IbdTuple[];
  /** 합계에서 뺀 부채성 항목 [계정명, 금액, 유형(계정명 기준 추정)] */
  debtLike?: [string, number, DebtLikeType][];
  checks?: string[];
  notes?: string[];
  /** 차입이 빠졌을 가능성 — 있을 때만 */
  completeness?: "partial";
  completenessReason?: string;
}

/** 계정명만으로 범주 추정 — 범주 없는 옛 캐시(2-튜플) 변환에 쓴다 */
export function guessCategoryByName(account: string): IbdOutCategory {
  const n = normName(account);
  if (isOtherDebtName(n)) return "otherDebt";
  if (/리스/.test(n) && (/차입/.test(n) || BOND_WORD.test(n))) return leaseInclusiveCat("", n);
  if (/리스(?:유동|비유동|장기|단기)?부채|리스채무|리스미지급금|리츠부채/.test(n)) return "lease";
  if (isMixed(n)) return "borrowingsAndBonds";
  if (/전환권|신주인수권|교환권/.test(n) || NAME_CONVERTIBLE.test(n)) return "convertible";
  if ((BOND_WORD.test(n) || /기업어음|상환할증금|할인발행차금/.test(n)) && !/차입/.test(n)) return "bonds";
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
    ...(r.debtLike.length ? { debtLike: r.debtLike.map((d) => [d.account, d.amount, d.type] as [string, number, DebtLikeType]) } : {}),
    ...(r.checks.length ? { checks: r.checks } : {}),
    ...(r.notes.length ? { notes: r.notes } : {}),
    ...(r.completeness === "partial" ? { completeness: "partial" as const, completenessReason: r.completenessReasons.join("; ") } : {}),
  };
}

/**
 * 옛 캐시(v2.0·v2.1 — [계정명, 금액] 2-튜플, 미구분 항목이 nonCurrent 에 섞임)를 현재 형식으로.
 * 행 이관은 2-튜플에만, debtLike 유형 추정은 항상. 이미 3-튜플이면 행은 그대로 둔다.
 */
export function normalizeCompactIbd(ibd: unknown): CompactIbd | null {
  if (!ibd || typeof ibd !== "object") return null;
  const o = ibd as Record<string, unknown>;
  const cur = Array.isArray(o.current) ? (o.current as unknown[][]) : [];
  const non = Array.isArray(o.nonCurrent) ? (o.nonCurrent as unknown[][]) : [];
  const legacy = [...cur, ...non].some((t) => Array.isArray(t) && t.length === 2) || (!cur.length && !non.length && !o.unclassified);
  const fix = (a: unknown[][]): IbdTuple[] =>
    a.map((t) => {
      const [acc, amt, cat] = t as [string, number, IbdOutCategory | undefined];
      return [acc, amt, cat ?? guessCategoryByName(acc)] as IbdTuple;
    });
  const out: CompactIbd = {
    ...(o as unknown as CompactIbd),
    total: Number(o.total ?? 0),
    current: fix(cur),
    nonCurrent: fix(non),
    ...(o.unclassified ? { unclassified: fix(o.unclassified as unknown[][]) } : {}),
  };
  if (Array.isArray(o.debtLike))
    out.debtLike = (o.debtLike as unknown[][]).map((d) => [d[0] as string, d[1] as number, (d[2] as DebtLikeType) ?? debtLikeType(normName(String(d[0])))]);
  if (!legacy) return out;
  // 옛 형식 — 미구분 항목이 nonCurrent 에 섞여 있다
  const checks = (o.checks as string[] | undefined) ?? [];
  const moveAll = checks.some((c) => c.includes("유동/비유동 구분이 없는"));
  const toUn: IbdTuple[] = [];
  const keep: IbdTuple[] = [];
  for (const t of out.nonCurrent) {
    if (moveAll || t[0] === "리스부채(주석, 유동/비유동 미구분)" || (t[0].startsWith("차입금·사채(") && t[0].includes("미구분"))) toUn.push(t);
    else keep.push(t);
  }
  out.nonCurrent = keep;
  if (toUn.length) out.unclassified = [...(out.unclassified ?? []), ...toUn];
  return out;
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
