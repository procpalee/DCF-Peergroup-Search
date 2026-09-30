/**
 * 이자부부채 도구 출력 — 캐시(행 단위 전체, CompactIbd)에서 요약·상세를 만든다.
 *
 *  기본(요약): total + 구역별 범주 소계 [범주명, 금액] + 범주별 합계(byCategory)
 *    - current/nonCurrent 를 [이름, 금액] 쌍으로 유지해 기존 소비자(엑셀 애드인 xlwork 의 합산)가 그대로 동작한다.
 *  상세(ibd_detail=true): 요약 + lines — 재무상태표 계정(또는 주석 보충) 행 단위 [계정명, 금액, 범주]
 */
import { normalizeCompactIbd, type CompactIbd, type DebtLikeType, type IbdOutCategory, type IbdTuple } from "../opendart/ibd-engine";

export const IBD_CATEGORY_LABEL: Record<IbdOutCategory, string> = {
  borrowings: "차입금",
  bonds: "사채",
  convertible: "전환사채 등(CB·BW·EB)",
  borrowingsAndBonds: "차입금·사채(구분 불가)",
  lease: "리스부채",
  otherDebt: "기타 차입성 부채",
};
const ORDER: IbdOutCategory[] = ["borrowings", "bonds", "convertible", "borrowingsAndBonds", "lease", "otherDebt"];

export interface IbdOutput {
  total: number;
  /** 유동 — 범주별 소계 [범주명, 금액] */
  current: [string, number][];
  /** 비유동 — 범주별 소계 [범주명, 금액] */
  nonCurrent: [string, number][];
  /** 유동/비유동 구분이 없는 재무상태표의 범주별 소계 */
  unclassified?: [string, number][];
  /** 범주별 합계(구역 합산) — 예: 리스 제외 이자부부채 = total − byCategory.lease */
  byCategory: Record<IbdOutCategory, number>;
  /** 합계에서 뺀 부채성 항목 [계정명, 금액, 유형(계정명 기준 추정: rcps·cps·convDerivative·hybrid·unknown)] */
  debtLike?: [string, number, DebtLikeType][];
  checks?: string[];
  notes?: string[];
  /** 차입이 빠졌을 가능성이 있으면 'partial' 과 사유 */
  completeness?: "partial";
  completenessReason?: string;
  /** ibd_detail=true 일 때만 — 계정 행 단위 [계정명, 금액, 범주] */
  lines?: { current: IbdTuple[]; nonCurrent: IbdTuple[]; unclassified?: IbdTuple[] };
}

function bySection(lines: IbdTuple[]): [string, number][] {
  return ORDER.map((c) => [IBD_CATEGORY_LABEL[c], lines.filter((l) => l[2] === c).reduce((s, l) => s + l[1], 0)] as [string, number])
    .filter(([, v]) => v !== 0);
}

export function formatIbd(raw: unknown, detail = false): IbdOutput | null {
  const ibd: CompactIbd | null = normalizeCompactIbd(raw);
  if (!ibd) return null;
  const all = [...ibd.current, ...ibd.nonCurrent, ...(ibd.unclassified ?? [])];
  const byCategory = Object.fromEntries(
    ORDER.map((c) => [c, all.filter((l) => l[2] === c).reduce((s, l) => s + l[1], 0)]),
  ) as Record<IbdOutCategory, number>;
  return {
    total: ibd.total,
    current: bySection(ibd.current),
    nonCurrent: bySection(ibd.nonCurrent),
    ...(ibd.unclassified?.length ? { unclassified: bySection(ibd.unclassified) } : {}),
    byCategory,
    ...(ibd.completeness === "partial" ? { completeness: "partial" as const, completenessReason: ibd.completenessReason } : {}),
    ...(ibd.debtLike?.length ? { debtLike: ibd.debtLike } : {}),
    ...(ibd.checks?.length ? { checks: ibd.checks } : {}),
    ...(ibd.notes?.length ? { notes: ibd.notes } : {}),
    ...(detail
      ? {
          lines: {
            current: ibd.current,
            nonCurrent: ibd.nonCurrent,
            ...(ibd.unclassified?.length ? { unclassified: ibd.unclassified } : {}),
          },
        }
      : {}),
  };
}
