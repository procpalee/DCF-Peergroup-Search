import { NextResponse } from "next/server";
import axios from "axios";
import { API_BASE_URL, ENDPOINTS } from "@/services/kicpa/constants";
import {
  clearCachedSession,
  getSessionCookie,
  BROWSER_HEADERS,
} from "@/services/kicpa/auth";
import { fetchBetaData } from "@/services/kicpa/client";

/**
 * 임시 진단 라우트 — KICPA 세션 획득/베타 조회를 Vercel 네트워크에서 점검한다.
 * 수정안 검증 후 제거 예정.
 */
export async function GET() {
  const out: Record<string, unknown> = {};

  // 1) 원본 동작 재현: 리다이렉트 자동 추적 시 Set-Cookie 노출 여부
  try {
    const r = await axios.get(`${API_BASE_URL}${ENDPOINTS.DAILY_SEARCH_PAGE}`, {
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 15000,
      headers: BROWSER_HEADERS,
    });
    out.autoFollow = {
      finalStatus: r.status,
      hasSetCookie: Boolean(r.headers["set-cookie"]),
      setCookie: r.headers["set-cookie"] ?? null,
    };
  } catch (e) {
    out.autoFollow = { error: e instanceof Error ? e.message : String(e) };
  }

  // 2) 수정안: 직접 리다이렉트 추적
  clearCachedSession();
  try {
    const sessionId = await getSessionCookie();
    out.manualFollow = { ok: true, sessionId: sessionId.slice(0, 8) + "..." };
  } catch (e) {
    out.manualFollow = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 3) 엔드투엔드 베타 조회
  clearCachedSession();
  try {
    const results = await fetchBetaData({
      stockCodes: ["005930", "000660"],
      date: "20260602",
      country: "KR",
      periodType: "Weekly",
      betaPeriods: ["2Y"],
    });
    out.betaFetch = { ok: true, count: results.length, sample: results[0] ?? null };
  } catch (e) {
    out.betaFetch = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(out);
}
