/**
 * 재무제표(fnlttSinglAcntAll) → 밸류에이션 기초값.
 * 표준계정 ID 우선, 없으면 계정명 폴백. 손익은 분기·반기 보고서면 누적(thstrm_add_amount)을 쓰고
 * 누적 개월 수를 함께 남긴다(연환산·LTM 은 호출부 몫).
 */
import type { DartFinancialItem } from "./types";

export interface Fundamentals {
  cash: number | null;
  shortTermDeposits: number | null;
  equityTotal: number | null;
  equityParent: number | null;
  nci: number | null;
  equityMethodInvestments: number | null;
  revenue: number | null;
  operatingIncome: number | null;
  pretaxIncome: number | null;
  incomeTax: number | null;
  netIncome: number | null;
  netIncomeParent: number | null;
  /** 손익 누적 개월 수(3·6·9·12) */
  incomeMonths: number;
}

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/[,\s]/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const norm = (s: string) => s.replace(/^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|\(?\d+\)?)\s*[.)]\s*/u, "").replace(/\s+/g, "");

function pick(
  rows: DartFinancialItem[],
  ids: string[],
  names: RegExp | null,
  amount: (r: DartFinancialItem) => number | null,
): number | null {
  for (const id of ids) {
    const r = rows.find((x) => x.account_id === id);
    if (r) {
      const v = amount(r);
      if (v != null) return v;
    }
  }
  if (names) {
    const r = rows.find((x) => (!x.account_id || x.account_id.startsWith("-")) && names.test(norm(x.account_nm)));
    if (r) return amount(r);
  }
  return null;
}

export function extractFundamentals(items: DartFinancialItem[], incomeMonths: number): Fundamentals {
  const bs = items.filter((i) => i.sj_div === "BS");
  // 손익은 IS 를 우선하고 없으면 CIS(단일 포괄손익계산서)
  const isRows = items.filter((i) => i.sj_div === "IS");
  const pl = isRows.length ? [...isRows, ...items.filter((i) => i.sj_div === "CIS")] : items.filter((i) => i.sj_div === "CIS");
  const bsAmt = (r: DartFinancialItem) => num(r.thstrm_amount);
  // 분기·반기는 누적 금액이 thstrm_add_amount 에 있다(사업보고서는 비어 있음)
  const plAmt = (r: DartFinancialItem) =>
    incomeMonths < 12 ? num(r.thstrm_add_amount) ?? num(r.thstrm_amount) : num(r.thstrm_amount);

  return {
    cash: pick(bs, ["ifrs-full_CashAndCashEquivalents"], /^현금및현금성자산$/, bsAmt),
    shortTermDeposits: pick(bs, ["ifrs-full_ShorttermDepositsNotClassifiedAsCashEquivalents"], /^단기금융상품$/, bsAmt),
    equityTotal: pick(bs, ["ifrs-full_Equity"], /^자본총계$/, bsAmt),
    equityParent: pick(bs, ["ifrs-full_EquityAttributableToOwnersOfParent"], /^지배기업(?:의)?소유주(?:에게귀속되는)?(?:지분|자본)$/, bsAmt),
    nci: pick(bs, ["ifrs-full_NoncontrollingInterests"], /^(?:비지배지분|소수주주지분)$/, bsAmt),
    equityMethodInvestments: pick(bs, ["ifrs-full_InvestmentAccountedForUsingEquityMethod"], /관계기업.*투자/, bsAmt),
    revenue: pick(pl, ["ifrs-full_Revenue"], /^(?:매출액|수익\(매출액\)|영업수익|매출)$/, plAmt),
    operatingIncome: pick(pl, ["dart_OperatingIncomeLoss"], /^영업(?:이익|손실|이익\(손실\))$/, plAmt),
    pretaxIncome: pick(pl, ["ifrs-full_ProfitLossBeforeTax"], /법인세비용차감전/, plAmt),
    incomeTax: pick(pl, ["ifrs-full_IncomeTaxExpenseContinuingOperations"], /^법인세비용/, plAmt),
    netIncome: pick(pl, ["ifrs-full_ProfitLoss"], /^당기순(?:이익|손실|이익\(손실\))$/, plAmt),
    netIncomeParent: pick(pl, ["ifrs-full_ProfitLossAttributableToOwnersOfParent"], null, plAmt),
    incomeMonths,
  };
}
