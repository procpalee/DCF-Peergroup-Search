/**
 * 평가기준일 "당시 이용 가능했던 최신 정기보고서" 선택과 재무 API 파라미터 매핑.
 *
 * 재무 시점 정책(2026-09-30 확정): 이자부부채·비지배지분·주식수 등은 기준일 당시
 * 이미 공시된 최신 정기보고서(사업·반기·분기) 기준. 예) 2025-03-31 → 2024 사업보고서,
 * 2025-06-30 → 2025 1분기보고서. peergroup_get_population 의 사업내용 선택 규칙과 같다
 * (selectPeriodicReportCandidates 재사용).
 *
 * fnlttSinglAcntAll 은 접수번호가 아니라 (사업연도, 보고서코드)로 조회하므로, 보고서명의
 * 보고기간(YYYY.MM)과 결산월로 보고서코드를 정하고, 사업연도는 후보를 순서대로 시도해
 * 응답 접수번호가 선택한 보고서와 같은지로 확정한다(비12월 결산 법인의 사업연도 표기 차이 대응).
 */
import axios from "axios";
import { DART_API_BASE } from "./constants";
import { selectPeriodicReportCandidates, type DartListDoc } from "./document-parser";

export async function fetchPeriodicReports(
  corpCode: string,
  bgnDe: string,
  endDe: string,
  apiKey?: string,
): Promise<DartListDoc[]> {
  const key = apiKey || process.env.OPENDART_API_KEY;
  const res = await axios.get(`${DART_API_BASE}/list.json`, {
    params: { crtfc_key: key, corp_code: corpCode, bgn_de: bgnDe, end_de: endDe, pblntf_ty: "A", page_count: 100 },
    timeout: 15000,
  });
  if (res.data.status === "013") return [];
  if (res.data.status !== "000") throw new Error(`DART list: ${res.data.message} (${res.data.status})`);
  return res.data.list ?? [];
}

export interface AsOfReport {
  rceptNo: string;
  reportName: string;
  rceptDate: string;
  /** 보고기간 말 YYYYMM */
  period: string;
  reprtCode: "11011" | "11012" | "11013" | "11014";
  /** fnlttSinglAcntAll bsns_year 후보(앞쪽 우선) */
  yearCandidates: string[];
}

/** 보고서명 + 결산월 → 보고서코드. 결산월이 없으면 12월로 본다 */
export function mapReport(doc: DartListDoc, accMonth = "12"): AsOfReport | null {
  const m = doc.report_nm.match(/\((\d{4})\.(\d{2})\)/);
  if (!m) return null;
  const py = Number(m[1]);
  const pm = Number(m[2]);
  const fyEnd = Number(accMonth) || 12;
  const fyStart = (fyEnd % 12) + 1;
  const monthsIntoFy = ((pm - fyStart + 12) % 12) + 1; // 3·6·9·12
  let reprtCode: AsOfReport["reprtCode"];
  if (doc.report_nm.includes("사업보고서")) reprtCode = "11011";
  else if (doc.report_nm.includes("반기보고서")) reprtCode = "11012";
  else if (doc.report_nm.includes("분기보고서")) reprtCode = monthsIntoFy <= 3 ? "11013" : "11014";
  else return null;
  // 12월 결산이면 보고기간 연도 = 사업연도. 그 외에는 사업연도 표기가 시작연도·종료연도
  // 어느 쪽인지 회사·연도별로 섞여 있어 둘 다 시도한다.
  const yearCandidates = fyEnd === 12 ? [String(py)] : [String(py), String(py - 1)];
  return {
    rceptNo: doc.rcept_no,
    reportName: doc.report_nm.trim(),
    rceptDate: doc.rcept_dt,
    period: `${m[1]}${m[2]}`,
    reprtCode,
    yearCandidates,
  };
}

/** 기준일 당시 최신 정기보고서(정정 전후 중 기준일 이전 접수분 우선) */
export function selectAsOfReport(docs: DartListDoc[], asOfDate: string, accMonth?: string): AsOfReport | null {
  for (const d of selectPeriodicReportCandidates(docs, asOfDate)) {
    const r = mapReport(d, accMonth);
    if (r) return r;
  }
  return null;
}

/** YYYYMMDD 에서 n개월 전(일자 01) — 공시 목록 조회 시작일 계산용 */
export function monthsBeforeDate(yyyymmdd: string, months: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const mo = Number(yyyymmdd.slice(4, 6));
  const total = y * 12 + (mo - 1) - months;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}01`;
}
