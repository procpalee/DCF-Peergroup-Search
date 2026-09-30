import { readDataJson } from "./data-files";

// 캐시 파일 한 종목 = valuation_get_data 의 출력 전 결과(StoredResult — 이자부부채는 행 단위 전체)
type CachedResult = import("../tools/valuation-data").StoredResult;

// 날짜별 캐시: valuationDate → (stockCode → CachedResult). 파일이 없으면 null 로 기억
const cacheMap = new Map<string, Promise<Map<string, CachedResult> | null>>();

function loadCache(valuationDate: string): Promise<Map<string, CachedResult> | null> {
  let p = cacheMap.get(valuationDate);
  if (!p) {
    p = readDataJson<Record<string, CachedResult>>(`valuation-cache/${valuationDate}.json`).then((data) =>
      data ? new Map(Object.entries(data)) : null,
    );
    cacheMap.set(valuationDate, p);
  }
  return p;
}

/**
 * 캐시에서 밸류에이션 데이터를 조회합니다(번들 → Vercel Blob 순).
 * 캐시 히트 시 StoredResult 반환(도구가 요약·상세로 가공), 미스 시 null.
 */
export async function getCachedValuation(stockCode: string, valuationDate: string): Promise<CachedResult | null> {
  const cache = await loadCache(valuationDate);
  if (!cache) return null;
  return cache.get(stockCode) ?? null;
}
