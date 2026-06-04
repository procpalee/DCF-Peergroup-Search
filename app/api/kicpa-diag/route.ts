import { NextResponse } from "next/server";
import { clearCachedSession } from "@/services/kicpa/auth";
import { fetchBetaData } from "@/services/kicpa/client";
import { handleApiError } from "@/services/utils/error-handler";

/**
 * 임시 진단 라우트 — 베타 조회의 최종 사용자 메시지를 점검한다. 검증 후 제거 예정.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "20260602";

  clearCachedSession();
  try {
    const results = await fetchBetaData({
      stockCodes: ["005930", "000660"],
      date,
      country: "KR",
      periodType: "Weekly",
      betaPeriods: ["2Y"],
    });
    return NextResponse.json({ date, ok: true, count: results.length, results });
  } catch (e) {
    return NextResponse.json({
      date,
      ok: false,
      rawError: e instanceof Error ? e.message : String(e),
      userMessage: handleApiError(e),
    });
  }
}
