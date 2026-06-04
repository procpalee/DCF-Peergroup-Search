import { NextResponse } from "next/server";
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
} from "@/services/kicpa/constants";
import {
  clearCachedSession,
  getSessionCookie,
  BROWSER_HEADERS,
} from "@/services/kicpa/auth";

/**
 * 임시 진단 라우트 — KICPA 세션 획득/베타 POST 원응답을 Vercel 네트워크에서 점검한다.
 * 수정안 검증 후 제거 예정.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "20260602";
  const periodType = (url.searchParams.get("period") ?? "Weekly") as
    | "Daily"
    | "Weekly"
    | "Monthly";

  const out: Record<string, unknown> = { date, periodType };

  clearCachedSession();
  let sessionId = "";
  try {
    sessionId = await getSessionCookie();
    out.session = { ok: true, sessionId: sessionId.slice(0, 8) + "..." };
  } catch (e) {
    out.session = { ok: false, error: e instanceof Error ? e.message : String(e) };
    return NextResponse.json(out);
  }

  // 클라이언트와 동일한 폼 파라미터 구성
  const betaItems = ["2Y"].map((p) => BETA_PERIOD_TO_ITEM[p]).filter(Boolean);
  const allItems = [...REQUIRED_ITEMS, ...BASE_ITEMS, ...betaItems];
  const formParams = new URLSearchParams();
  formParams.append("screenId", FIXED_PARAMS.screenId);
  formParams.append("menuNo", FIXED_PARAMS.menuNo);
  formParams.append("stdCode", "005930,000660");
  formParams.append("sdate", date);
  formParams.append("periodType", PERIOD_TYPE_CODE[periodType] ?? "2");
  formParams.append("gubun", COUNTRY_CODE.KR);
  for (const item of allItems) formParams.append("itemName", item);
  formParams.append("urlView", URL_VIEW);

  try {
    const resp = await axios.post(
      `${API_BASE_URL}${ENDPOINTS.DAILY_RESULT}`,
      formParams.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "User-Agent": BROWSER_HEADERS["User-Agent"],
          "X-Requested-With": "XMLHttpRequest",
          Cookie: `JSESSIONID=${sessionId}`,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    const body = resp.data;
    out.post = {
      status: resp.status,
      contentType: resp.headers["content-type"],
      resultCode: body?.resultCode,
      totalCnt: body?.totalCnt,
      resultListLen: Array.isArray(body?.resultList) ? body.resultList.length : null,
      firstRowKeys: body?.resultList?.[0] ? Object.keys(body.resultList[0]) : null,
      firstRow: body?.resultList?.[0] ?? null,
      paramVO: body?.paramVO ?? null,
      rawSnippet:
        typeof body === "string"
          ? body.slice(0, 800)
          : JSON.stringify(body).slice(0, 800),
    };
  } catch (e) {
    out.post = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(out);
}
