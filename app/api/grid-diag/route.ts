import { NextResponse } from "next/server";
import { computeBetaGridBatch } from "@/services/beta-calc";

/** 임시 진단 — 8칸 베타 그리드를 20251231 캐시와 대조. 검증 후 제거. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "20251231";
  const codes = (url.searchParams.get("codes") ?? "005930,000660").split(",");

  const { weeklyMap, monthlyMap } = await computeBetaGridBatch(codes, date);
  const out: Record<string, unknown> = { date };
  for (const code of codes) {
    out[code] = {
      weekly: weeklyMap.get(code)?.betas ?? null,
      monthly: monthlyMap.get(code)?.betas ?? null,
    };
  }
  return NextResponse.json(out);
}
