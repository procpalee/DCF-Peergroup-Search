import axios from "axios";
import type { PricePoint } from "./types";

/**
 * 네이버에서 베타 계산용 일별 시계열을 가져온다.
 * - 수정주가/지수: api.finance.naver.com/siseJson.naver (단일 range 요청, 빠름)
 * - 원주가(옵션, 정밀 모드): finance.naver.com/item/sise_day.naver (HTML 페이지네이션)
 *
 * ⚠️ siseJson 이 수정주가인지 원주가인지는 Vercel 실측으로 확정한다(R1). 기본 가정: 수정주가.
 */

const SISE_JSON_URL = "https://api.finance.naver.com/siseJson.naver";
const SISE_DAY_URL = "https://finance.naver.com/item/sise_day.naver";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * siseJson 응답(텍스트 배열)을 파싱한다.
 * 형식: [['날짜','시가','고가','저가','종가','거래량','외국인소진율'], ["20260102", 120200, ...], ...]
 * 종가(5번째 컬럼)는 정수(주식) 또는 소수(지수)일 수 있으므로 부동소수까지 파싱.
 */
export function parseSiseJson(text: string): PricePoint[] {
  const out: PricePoint[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/\["(\d{8})",\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/);
    if (!m) continue;
    const close = parseFloat(m[5]);
    if (!isFinite(close)) continue;
    out.push({ date: m[1], close });
  }
  return out;
}

/** siseJson 단일 호출 (주식 종목코드 또는 지수 심볼) */
export async function fetchSiseJson(
  symbol: string,
  startDate: string,
  endDate: string
): Promise<PricePoint[]> {
  const response = await axios.get<string>(SISE_JSON_URL, {
    params: { symbol, requestType: 1, startTime: startDate, endTime: endDate, timeframe: "day" },
    headers: { "User-Agent": UA },
    timeout: 15000,
  });
  return parseSiseJson(response.data).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 수정주가(가정) 일별 종가 */
export function fetchAdjDaily(stockCode: string, startDate: string, endDate: string) {
  return fetchSiseJson(stockCode, startDate, endDate);
}

/** KOSPI 지수 일별 종가 — 심볼은 Vercel 실측으로 확정(기본 "KOSPI") */
export function fetchKospiDaily(startDate: string, endDate: string, symbol = "KOSPI") {
  return fetchSiseJson(symbol, startDate, endDate);
}

/**
 * 원주가(미수정) 일별 종가 — sise_day.naver HTML 페이지네이션 파싱(정밀 모드/검증용).
 * startDate 이전까지 거슬러 올라가며 수집. maxPages 로 요청 수를 제한.
 * 응답은 EUC-KR 이지만 날짜(.)·숫자는 ASCII 라 텍스트 파싱으로 충분.
 */
export async function fetchRawDaily(
  stockCode: string,
  startDate: string,
  maxPages = 40
): Promise<PricePoint[]> {
  const collected: PricePoint[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await axios.get<string>(SISE_DAY_URL, {
      params: { code: stockCode, page },
      headers: { "User-Agent": UA, Referer: `${SISE_DAY_URL}?code=${stockCode}` },
      timeout: 15000,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const rows = parseSiseDayHtml(res.data);
    if (rows.length === 0) break;
    collected.push(...rows);
    // 이번 페이지 가장 오래된 날짜가 startDate 이전이면 충분히 수집됨
    const oldest = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date);
    if (oldest <= startDate) break;
  }
  // 중복 제거 + 정렬
  const map = new Map(collected.map((p) => [p.date, p.close]));
  return [...map.entries()]
    .map(([date, close]) => ({ date, close }))
    .filter((p) => p.date >= startDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * sise_day.naver HTML 한 페이지에서 (날짜, 종가) 추출.
 * 날짜: <span class="tah p10 gray03">2025.09.30</span>
 * 종가: 그 행의 첫 숫자 <td class="num"><span class="tah p11">71,200</span>
 */
export function parseSiseDayHtml(html: string): PricePoint[] {
  const out: PricePoint[] = [];
  // 행 단위로 분리 후 날짜 + 첫 숫자 매칭
  const rowRegex = /(\d{4})\.(\d{2})\.(\d{2})<\/span>[\s\S]*?<span class="tah p11">([\d,]+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(html)) !== null) {
    const date = `${m[1]}${m[2]}${m[3]}`;
    const close = parseFloat(m[4].replace(/,/g, ""));
    if (isFinite(close)) out.push({ date, close });
  }
  return out;
}
