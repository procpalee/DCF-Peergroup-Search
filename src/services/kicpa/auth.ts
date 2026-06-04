import axios, { AxiosResponse } from "axios";
import { API_BASE_URL, ENDPOINTS } from "./constants";

/**
 * 세션 관리: GET 페이지 접속으로 JSESSIONID 쿠키를 자동 획득.
 * 로그인 불필요 — 세션 쿠키만 있으면 API 호출 가능.
 *
 * 주의: KOSCOM 서버는 첫 응답(흔히 302 리다이렉트)에서 JSESSIONID를 내려준 뒤
 * 리다이렉트하는 경우가 있다. axios가 리다이렉트를 자동으로 따라가면(maxRedirects>0)
 * 최종 응답의 헤더만 노출되어 중간 응답의 Set-Cookie가 유실된다.
 * 따라서 리다이렉트를 직접 따라가며 각 hop의 Set-Cookie를 검사한다.
 */

let cachedSessionId: string | null = null;

// 일부 WAF/프록시가 비브라우저 UA를 차단하므로 실제 브라우저처럼 위장한다.
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
};

export function getCachedSessionId(): string | null {
  return cachedSessionId;
}

/**
 * 임의의 응답에서 JSESSIONID Set-Cookie를 찾아 캐시에 저장한다.
 * GET(세션 페이지)뿐 아니라 POST(데이터 API) 응답에서도 세션이 내려올 수 있으므로 공용으로 사용.
 * @returns 새 세션을 캡처했으면 true
 */
export function captureSessionFromResponse(response: AxiosResponse): boolean {
  const setCookieHeaders = response.headers?.["set-cookie"];
  if (!setCookieHeaders) return false;

  for (const cookie of setCookieHeaders) {
    const match = cookie.match(/JSESSIONID=([^;\s]+)/);
    // 로그아웃/만료 시 빈 값으로 내려오는 경우가 있어 유효 값만 채택
    if (match && match[1] && match[1].toLowerCase() !== "null") {
      cachedSessionId = match[1];
      return true;
    }
  }
  return false;
}

export async function getSessionCookie(): Promise<string> {
  if (cachedSessionId) {
    return cachedSessionId;
  }

  return acquireSession();
}

/**
 * 검색 페이지에 GET 요청을 보내서 JSESSIONID 세션 쿠키를 획득.
 * 리다이렉트를 직접 따라가며 각 hop의 Set-Cookie에서 JSESSIONID를 수집한다.
 */
async function acquireSession(): Promise<string> {
  console.log("[KICPA Session] Acquiring new session via page GET...");

  const diag: string[] = [];
  let url = `${API_BASE_URL}${ENDPOINTS.DAILY_SEARCH_PAGE}`;

  // 최대 5회까지 리다이렉트를 직접 따라간다.
  for (let hop = 0; hop <= 5; hop++) {
    const response = await axios.get(url, {
      maxRedirects: 0, // 직접 따라가며 모든 hop의 Set-Cookie를 검사
      validateStatus: () => true,
      timeout: 15000,
      headers: BROWSER_HEADERS,
    });

    const cookiePresent = Boolean(response.headers?.["set-cookie"]);
    diag.push(`hop${hop}=${response.status}${cookiePresent ? "+cookie" : ""}`);

    if (captureSessionFromResponse(response)) {
      console.log(
        `[KICPA Session] JSESSIONID acquired successfully (hop ${hop}, status ${response.status})`
      );
      return cachedSessionId!;
    }

    const status = response.status;
    const location = response.headers?.["location"];
    if (status >= 300 && status < 400 && location) {
      // 상대 경로 Location도 안전하게 절대 URL로 변환
      url = new URL(location, url).toString();
      continue;
    }

    // 더 이상 따라갈 리다이렉트가 없으면 중단
    break;
  }

  throw new Error(
    `SESSION_ACQUIRE_FAILED: No JSESSIONID in response (${diag.join(" -> ")})`
  );
}

export async function refreshSession(): Promise<string> {
  cachedSessionId = null;
  return acquireSession();
}

export function clearCachedSession(): void {
  cachedSessionId = null;
}
