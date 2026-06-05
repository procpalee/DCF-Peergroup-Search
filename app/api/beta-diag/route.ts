import { NextResponse } from "next/server";
import {
  fetchAdjDaily,
  fetchKospiDaily,
  fetchRawDaily,
  fetchSiseJson,
} from "@/services/beta-calc/data-source";
import { computeBetaData } from "@/services/beta-calc";

/** 임시 진단 라우트 — 베타 직접계산의 데이터 소스/결과를 Vercel 네트워크에서 점검. 검증 후 제거. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseDate = url.searchParams.get("date") ?? "20250930";
  const kospiSymbol = url.searchParams.get("kospi") ?? "KOSPI";
  const start = "20250101";
  const out: Record<string, unknown> = { baseDate, kospiSymbol };

  // 1) KOSPI 지수 엔드포인트 확인 (심볼 후보 비교)
  try {
    const candidates = [kospiSymbol, "KS11"];
    const idx: Record<string, unknown> = {};
    for (const sym of [...new Set(candidates)]) {
      try {
        const s = await fetchSiseJson(sym, start, baseDate);
        idx[sym] = { count: s.length, first: s[0], last: s[s.length - 1] };
      } catch (e) {
        idx[sym] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    out.index = idx;
  } catch (e) {
    out.index = { error: String(e) };
  }

  // 2) siseJson 수정주가 vs sise_day 원주가 비교 (204840)
  try {
    const adj = await fetchAdjDaily("204840", start, baseDate);
    const raw = await fetchRawDaily("204840", start, 3).catch((e) => {
      out.rawError = e instanceof Error ? e.message : String(e);
      return [] as { date: string; close: number }[];
    });
    const rawMap = new Map(raw.map((p) => [p.date, p.close]));
    const overlaps = adj
      .filter((p) => rawMap.has(p.date))
      .slice(-5)
      .map((p) => ({ date: p.date, siseJson: p.close, sise_day: rawMap.get(p.date) }));
    out.priceCompare = {
      adjCount: adj.length,
      adjSample: { first: adj[0], last: adj[adj.length - 1] },
      rawCount: raw.length,
      rawSample: raw.slice(-3),
      overlaps,
      verdict:
        overlaps.length > 0
          ? overlaps.every((o) => o.siseJson === o.sise_day)
            ? "siseJson == sise_day (siseJson은 원주가일 가능성)"
            : "siseJson != sise_day (siseJson은 수정주가일 가능성)"
          : "비교 불가",
    };
  } catch (e) {
    out.priceCompare = { error: e instanceof Error ? e.message : String(e) };
  }

  // 3) 계산 결과: 캐시 비교용 (005930, 000660) — 수정주가 모드
  try {
    out.computedAdjMode = await computeBetaData({
      stockCodes: ["005930", "000660"],
      date: baseDate,
      kospiSymbol,
    });
  } catch (e) {
    out.computedAdjMode = { error: e instanceof Error ? e.message : String(e) };
  }

  // 5) 스크립트 대상 종목 (204840)
  try {
    out.computed204840 = await computeBetaData({
      stockCodes: ["204840"],
      date: baseDate,
      kospiSymbol,
    });
  } catch (e) {
    out.computed204840 = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(out);
}
