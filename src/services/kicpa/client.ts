import axios from "axios";
import {
  API_BASE_URL,
  ENDPOINTS,
  FIXED_PARAMS,
  COUNTRY_CODE,
  PERIOD_TYPE_CODE,
  BETA_PERIOD_TO_ITEM,
  REQUIRED_ITEMS,
  BASE_ITEMS,
  URL_VIEW,
} from "./constants";
import type { ApiResponse, StockBetaResult } from "./types";
import {
  getSessionCookie,
  refreshSession,
  captureSessionFromResponse,
  BROWSER_HEADERS,
} from "./auth";

async function makeAuthenticatedRequest(
  url: string,
  data: string,
  retried = false
): Promise<ApiResponse> {
  // 세션 페이지 GET이 쿠키를 안 줄 수도 있으므로(서버가 POST 응답에서만 세션을 내려주는 경우)
  // 세션 획득 실패는 치명적으로 보지 않고 쿠키 없이 POST를 시도한 뒤 응답에서 세션을 캡처한다.
  let sessionId: string | null = null;
  try {
    sessionId = await getSessionCookie();
  } catch (sessionError) {
    if (retried) throw sessionError;
    console.log(
      `[KICPA API] Session page GET yielded no cookie, attempting POST to obtain session: ${
        sessionError instanceof Error ? sessionError.message : sessionError
      }`
    );
  }

  let response;
  try {
    response = await axios.post<ApiResponse>(url, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // XHR JSON 요청에 맞는 Accept (html Accept를 보내면 일부 서버가 연결을 리셋함)
        Accept: "application/json, text/javascript, */*; q=0.01",
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        "Accept-Language": BROWSER_HEADERS["Accept-Language"],
        "X-Requested-With": "XMLHttpRequest",
        ...(sessionId ? { Cookie: `JSESSIONID=${sessionId}` } : {}),
      },
      timeout: 30000,
      validateStatus: () => true,
    });
  } catch (networkError) {
    // socket hang up(ECONNRESET) 등 응답 없이 끊긴 경우: 세션 갱신 후 1회 재시도
    if (retried) throw networkError;
    console.log(
      `[KICPA API] POST network error, retrying with fresh session: ${
        networkError instanceof Error ? networkError.message : networkError
      }`
    );
    try {
      await refreshSession();
    } catch {
      /* 세션 갱신 실패는 무시하고 재시도에서 POST로 세션 확보 시도 */
    }
    return makeAuthenticatedRequest(url, data, true);
  }

  // POST 응답에 새 세션 쿠키가 실려오면 캐시를 갱신한다.
  const capturedNewSession = captureSessionFromResponse(response);

  const httpOk = response.status >= 200 && response.status < 300;
  // KOSCOM이 점검/장애 상태이면 HTML "장애안내" 페이지를 200/500으로 내려준다.
  // (JSON 대신 문자열 본문) → 세션/파라미터 문제로 오인하지 않도록 별도 감지.
  if (isKoscomOutage(response.status, response.data)) {
    if (!retried) {
      return makeAuthenticatedRequest(url, data, true);
    }
    throw new Error(
      "KICPA_UPSTREAM_UNAVAILABLE: 한국공인회계사회(KICPA) CHECKExpert+/KOSCOM 데이터 서버가 현재 점검 또는 장애 상태입니다 ('장애안내' 응답). 잠시 후 다시 시도해주세요."
    );
  }

  const failed = !httpOk || response.data?.resultCode === "error";

  if (failed && !retried) {
    console.log(
      `[KICPA API] First attempt failed (status ${response.status}, resultCode ${response.data?.resultCode}). Retrying with fresh session...`
    );
    // POST에서 방금 새 세션을 받았다면 그걸로 즉시 재시도, 아니면 세션 페이지를 다시 긁는다.
    if (!capturedNewSession) {
      try {
        await refreshSession();
      } catch (refreshError) {
        console.log(
          `[KICPA API] Session refresh failed: ${
            refreshError instanceof Error ? refreshError.message : refreshError
          }`
        );
      }
    }
    return makeAuthenticatedRequest(url, data, true);
  }

  return response.data;
}

/**
 * KOSCOM 데이터몰 점검/장애 응답인지 판별한다.
 * 정상 응답은 JSON(resultCode 포함)이지만, 장애 시 HTML "장애안내" 페이지가 내려온다.
 */
function isKoscomOutage(status: number, body: unknown): boolean {
  if (typeof body === "string") {
    return (
      body.includes("장애안내") ||
      body.includes("장애 안내") ||
      (status >= 500 && body.includes("<html"))
    );
  }
  return false;
}

export interface FetchBetaParams {
  stockCodes: string[];
  date: string;
  country: "KR" | "US";
  periodType: "Daily" | "Weekly" | "Monthly";
  betaPeriods: string[];
}

export async function fetchBetaData(
  params: FetchBetaParams
): Promise<StockBetaResult[]> {
  const { stockCodes, date, country, periodType, betaPeriods } = params;

  const betaItems = betaPeriods.map((p) => BETA_PERIOD_TO_ITEM[p]).filter(Boolean);
  const allItems = [...REQUIRED_ITEMS, ...BASE_ITEMS, ...betaItems];

  const formParams = new URLSearchParams();
  formParams.append("screenId", FIXED_PARAMS.screenId);
  formParams.append("menuNo", FIXED_PARAMS.menuNo);
  formParams.append("stdCode", stockCodes.join(","));
  formParams.append("sdate", date);
  formParams.append("periodType", PERIOD_TYPE_CODE[periodType] ?? "2");
  formParams.append("gubun", COUNTRY_CODE[country]);
  for (const item of allItems) {
    formParams.append("itemName", item);
  }
  formParams.append("urlView", URL_VIEW);

  const apiResponse = await makeAuthenticatedRequest(
    `${API_BASE_URL}${ENDPOINTS.DAILY_RESULT}`,
    formParams.toString()
  );

  if (apiResponse.resultCode !== "success" || !apiResponse.resultList) {
    throw new Error(
      "API_ERROR: 데이터 조회에 실패했습니다. 유효하지 않은 조회 조건이거나 일시적인 서버 오류입니다."
    );
  }

  return parseResultList(apiResponse.resultList, stockCodes, betaPeriods, date);
}

function parseResultList(
  resultList: Record<string, string | number | undefined>[],
  stockCodes: string[],
  betaPeriods: string[],
  date: string
): StockBetaResult[] {
  const stockMap = new Map<string, StockBetaResult>();

  for (const row of resultList) {
    // 응답 필드명은 camelCase (nameK, nameE, marketName, closePrice 등)
    const nameKr = String(row["nameK"] ?? row["NAME_K"] ?? "");
    const nameEn = String(row["nameE"] ?? row["NAME_E"] ?? "");
    const market = String(row["marketName"] ?? row["MARKET_NAME"] ?? "");
    const closePrice = String(row["closePrice"] ?? row["CLOSE_PRICE"] ?? "");
    const tradeDate = String(row["tradeDate"] ?? row["TRADE_DATE"] ?? date);
    const simpleCode = String(row["simpleCode"] ?? row["SIMPLE_CODE"] ?? "");

    const key = simpleCode || nameKr || nameEn || market;
    if (!stockMap.has(key)) {
      const idx = stockMap.size;
      stockMap.set(key, {
        stockCode: simpleCode || (stockCodes[idx] ?? ""),
        stockNameKr: nameKr,
        stockNameEn: nameEn,
        market,
        closePrice,
        date: String(tradeDate),
        betas: {},
      });
    }

    const stock = stockMap.get(key)!;

    for (const period of betaPeriods) {
      const itemKey = BETA_PERIOD_TO_ITEM[period];
      if (!itemKey) continue;

      // 응답 필드명 직접 매핑: Y1_BETA→y1Beta, Y2_BETA→y2Beta 등
      const num = itemKey.charAt(1); // "1", "2", "3", "5"
      const raw = Number(row[`y${num}Beta`] ?? row[`${itemKey}_1`] ?? NaN);
      const adjusted = Number(row[`y${num}BetaAdj`] ?? row[`${itemKey}_2`] ?? NaN);
      const points = Number(row[`y${num}BetaPoint`] ?? row[`${itemKey}_3`] ?? NaN);

      if (!isNaN(raw) || !isNaN(adjusted) || !isNaN(points)) {
        stock.betas[period] = {
          raw: isNaN(raw) ? null : raw,
          adjusted: isNaN(adjusted) ? null : adjusted,
          dataPoints: isNaN(points) ? null : points,
        };
      }
    }
  }

  return Array.from(stockMap.values());
}
