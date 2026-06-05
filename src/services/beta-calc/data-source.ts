import axios from "axios";
import type { PricePoint } from "./types";

/**
 * 네이버에서 베타 계산용 일별 시계열을 가져온다.
 * - 수정주가/지수: api.finance.naver.com/siseJson.naver (단일 range 요청)
 *
 * Vercel 실측 확인: siseJson 종가는 수정주가이며, 이 수정수익률을 KOSPI 지수에
 * 회귀하면 KICPA 공식 베타(Weekly-2Y / Monthly-5Y)와 소수점 6자리까지 일치한다.
 * 지수 심볼은 "KOSPI" 가 유효(KS11 은 빈 응답).
 */

const SISE_JSON_URL = "https://api.finance.naver.com/siseJson.naver";
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

/** KOSPI 지수 일별 종가 (기본 심볼 "KOSPI") */
export function fetchKospiDaily(startDate: string, endDate: string, symbol = "KOSPI") {
  return fetchSiseJson(symbol, startDate, endDate);
}
