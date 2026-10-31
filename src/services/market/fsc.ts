import axios from "axios";
import type { PricePoint } from "../beta-calc/types";

/**
 * 공공데이터포털 금융위원회 시세 API — 주가·시가총액·베타 계산의 유일한 시세 출처.
 *
 * - 주식시세정보(15094808)·지수시세정보(15094807) 모두 이용허락범위 제4유형(출처표시·상업적 이용금지·변경금지)이고
 *   제3자 제공·재배포가 금지된다. 그래서 서버는 시세를 수집·저장·캐시하지 않고, 요청마다 **이용자 본인의 키**로 조회한다.
 * - 2020-01-02 이후만 제공, 기준일 다음 영업일 13시 이후 갱신(T+1).
 * - endBasDt 는 "보다 작은"(미포함) 조건이라 기준일 +1일을 넘긴다(2026-10-31 실측).
 * - 종가(clpr)는 수정 전 원주가다. 대비(vs)가 거래소 기준가(분할·증자 반영) 대비 값이라
 *   clpr/(clpr−vs) 를 이어 붙이면 수정수익률이 된다 — 카카오 2020~2021(액면분할 포함) 495거래일에서
 *   네이버 수정주가 수익률과 최대 0.003%p 차이(네이버 수정주가의 원 단위 반올림 영향).
 */

export const FSC_SOURCE = "금융위원회 주식시세정보·지수시세정보(공공데이터포털, 이용자 키로 조회)";
export const FSC_FIRST_DATE = "20200102";

const STOCK_API = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const INDEX_API = "https://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getStockMarketIndex";
const STOCK_APPLY_URL = "https://www.data.go.kr/data/15094808/openapi.do";
const INDEX_APPLY_URL = "https://www.data.go.kr/data/15094807/openapi.do";
const PAGE_ROWS = 3000;
const KOSPI_NAME = "코스피";

export interface StockDay {
  date: string; // YYYYMMDD
  name: string;
  market: string;
  close: number; // 원주가 종가
  change: number; // 거래소 기준가 대비
  listedShares: number;
}

/** 이용자 키가 없을 때 — 도구는 이 메시지를 결과에 그대로 싣는다 */
export const MARKET_KEY_MISSING =
  "시세(주가·시가총액·베타)는 이용자 본인의 공공데이터포털 키로만 조회합니다. " +
  `연결 주소에 ?datagokr_key=<일반 인증키(Decoding)> 를 붙이거나 x-datagokr-key 헤더로 보내고, ` +
  `「금융위원회_주식시세정보」(${STOCK_APPLY_URL})와 「금융위원회_지수시세정보」(${INDEX_APPLY_URL})를 활용신청하세요.`;

type Headers = Record<string, string | string[] | undefined> | undefined;

/** 요청 헤더(route 가 쿼리 datagokr_key 를 옮겨 둔 값) → 자체 호스팅용 환경변수 순 */
export function datagokrKey(headers: Headers): string | null {
  const v = headers?.["x-datagokr-key"];
  const fromHeader = (Array.isArray(v) ? v[0] : v)?.trim();
  const key = fromHeader || process.env.DATA_GO_KR_API_KEY?.trim() || "";
  if (!key) return null;
  // Encoding 키(%2B 등)를 넣어도 동작하게 한 번 푼다. 요청 때 axios 가 다시 인코딩한다.
  if (/%[0-9A-Fa-f]{2}/.test(key)) {
    try {
      return decodeURIComponent(key);
    } catch {
      return key;
    }
  }
  return key;
}

async function fetchAll(
  url: string,
  params: Record<string, string>,
  key: string,
  label: string,
  applyUrl: string,
): Promise<Array<Record<string, string>>> {
  const out: Array<Record<string, string>> = [];
  for (let page = 1; page < 20; page++) {
    const res = await axios.get<string>(url, {
      params: { serviceKey: key, resultType: "json", numOfRows: String(PAGE_ROWS), pageNo: String(page), ...params },
      responseType: "text",
      transformResponse: (d) => d,
      validateStatus: () => true,
      timeout: 30000,
    });
    const text = String(res.data ?? "");
    if (res.status !== 200 || !text.trim().startsWith("{")) throw portalError(res.status, text, label, applyUrl);
    const body = (JSON.parse(text) as { response?: { body?: Record<string, unknown> } }).response?.body ?? {};
    const node = body.items as { item?: unknown } | undefined;
    let rows = (node && typeof node === "object" ? node.item : []) as Array<Record<string, string>> | Record<string, string>;
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
    out.push(...rows);
    if (out.length >= Number(body.totalCount ?? 0) || rows.length === 0) break;
  }
  return out;
}

/** 공공데이터포털 게이트웨이 오류는 상태코드·XML 로 온다. 메시지는 사용자에게 그대로 보인다(키는 담지 않는다). */
function portalError(status: number, text: string, label: string, applyUrl: string): Error {
  if (status === 401 || status === 403 || /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|Unauthorized|Forbidden/i.test(text)) {
    return new Error(
      `API_ERROR: 공공데이터포털 「${label}」 호출이 거부됐습니다(HTTP ${status}). 키가 Decoding 값인지, 이 데이터셋을 활용신청했는지 확인하세요: ${applyUrl}`,
    );
  }
  if (status === 429 || /LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) {
    return new Error(`API_ERROR: 공공데이터포털 「${label}」 일일 호출 한도를 넘었습니다.`);
  }
  return new Error(`API_ERROR: 공공데이터포털 「${label}」 응답 오류 (HTTP ${status}): ${text.replace(/\s+/g, " ").slice(0, 160)}`);
}

function nextDay(yyyymmdd: string): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + 1));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function clampStart(start: string): string {
  return start < FSC_FIRST_DATE ? FSC_FIRST_DATE : start;
}

/** 한 종목의 일별 시세 (start ≤ 날짜 ≤ end), 날짜 오름차순 */
export async function fetchStockDays(code: string, start: string, end: string, key: string): Promise<StockDay[]> {
  // likeSrtnCd 는 부분일치라 종목코드를 정확히 한 번 더 거른다
  const rows = await fetchAll(
    STOCK_API,
    { likeSrtnCd: code, beginBasDt: clampStart(start), endBasDt: nextDay(end) },
    key,
    "금융위원회_주식시세정보",
    STOCK_APPLY_URL,
  );
  return rows
    .filter((r) => r.srtnCd === code)
    .map((r) => ({
      date: r.basDt,
      name: r.itmsNm,
      market: r.mrktCtg,
      close: Number(r.clpr),
      change: Number(r.vs),
      listedShares: Number(r.lstgStCnt),
    }))
    .filter((d) => Number.isFinite(d.close) && d.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** KOSPI 지수 일별 종가 (start ≤ 날짜 ≤ end), 날짜 오름차순 */
export async function fetchKospiDays(start: string, end: string, key: string): Promise<PricePoint[]> {
  const rows = await fetchAll(
    INDEX_API,
    { idxNm: KOSPI_NAME, beginBasDt: clampStart(start), endBasDt: nextDay(end) },
    key,
    "금융위원회_지수시세정보",
    INDEX_APPLY_URL,
  );
  return rows
    .filter((r) => r.idxNm === KOSPI_NAME)
    .map((r) => ({ date: r.basDt, close: Number(r.clpr) }))
    .filter((p) => Number.isFinite(p.close) && p.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 원주가 + 기준가 대비 → 수정주가 시계열. 마지막 날 값은 실제 종가와 같고,
 * 그 이전은 하루씩 거꾸로 (1 + 수정수익률)로 나눠 만든다.
 */
export function adjustedCloses(days: StockDay[]): PricePoint[] {
  const n = days.length;
  const out: PricePoint[] = new Array(n);
  if (n === 0) return out;
  let level = days[n - 1].close;
  out[n - 1] = { date: days[n - 1].date, close: level };
  for (let i = n - 1; i > 0; i--) {
    const base = days[i].close - days[i].change;
    const ret = base > 0 ? days[i].close / base : 1;
    level = level / ret;
    out[i - 1] = { date: days[i - 1].date, close: level };
  }
  return out;
}
