import axios from "axios";
import { DART_API_BASE, DART_ENDPOINTS } from "../opendart/constants";
import type { DartCompanyInfo } from "../opendart/types";

// ─── Corp code JSON 캐시 ───

interface CorpCodeEntry {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  modify_date: string;
}

interface CorpCodeCache {
  entries: CorpCodeEntry[];
  byCorpCode: Map<string, CorpCodeEntry>;
  byStockCode: Map<string, CorpCodeEntry>;
}

let cache: CorpCodeCache | null = null;

function initCache(): CorpCodeCache {
  if (cache) return cache;

  // data/corp-codes.json을 빌드 시 번들에 포함 (scripts/update-corp-codes.ts로 생성)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const corpCodesData = require("../../../data/corp-codes.json") as CorpCodeEntry[];

  const byCorpCode = new Map<string, CorpCodeEntry>();
  const byStockCode = new Map<string, CorpCodeEntry>();

  for (const entry of corpCodesData) {
    byCorpCode.set(entry.corp_code, entry);
    if (entry.stock_code) {
      // stock_code가 "5930" 같이 앞 0이 빠진 경우 6자리로 패딩
      const padded = entry.stock_code.padStart(6, "0");
      byStockCode.set(padded, entry);
      byStockCode.set(entry.stock_code, entry);
    }
  }

  cache = { entries: corpCodesData, byCorpCode, byStockCode };
  console.log(`[StockResolver] Loaded ${corpCodesData.length} companies (${byStockCode.size} listed)`);
  return cache;
}

// ─── 기업정보 캐시 ───

const companyInfoCache = new Map<string, DartCompanyInfo>();

function resolveApiKey(apiKey?: string): string {
  const key = apiKey || process.env.OPENDART_API_KEY;
  if (!key) {
    throw new Error("OpenDART API 키가 필요합니다. api_key 파라미터를 전달하거나 OPENDART_API_KEY 환경변수를 설정해주세요.");
  }
  return key;
}

// ─── 공개 API ───

/**
 * 6자리 종목코드 → 8자리 DART corp_code 변환
 * corp-codes.json에서 즉시 조회 (API 호출 불필요)
 */
export async function resolveCorpCode(stockCode: string): Promise<string> {
  const c = initCache();
  const entry = c.byStockCode.get(stockCode);
  if (entry) {
    return entry.corp_code;
  }
  throw new Error(`종목코드 ${stockCode}에 해당하는 DART 기업코드를 찾을 수 없습니다.`);
}

/**
 * 종목코드에 대한 기업정보 조회 (캐시 우선, 없으면 DART API 호출)
 */
export async function getCompanyInfo(stockCode: string, apiKey?: string): Promise<DartCompanyInfo> {
  const cached = companyInfoCache.get(stockCode);
  if (cached) return cached;

  const corpCode = await resolveCorpCode(stockCode);

  // DART company.json으로 상세 기업정보 조회
  try {
    const response = await axios.get<DartCompanyInfo>(`${DART_API_BASE}${DART_ENDPOINTS.COMPANY}`, {
      params: { crtfc_key: resolveApiKey(apiKey), corp_code: corpCode },
      timeout: 15000,
    });

    if (response.data.status === "000") {
      companyInfoCache.set(stockCode, response.data);
      return response.data;
    }
  } catch {
    // API 호출 실패 시 기본 정보로 대체
  }

  // corp-codes.json의 기본 정보로 fallback
  const c = initCache();
  const entry = c.byStockCode.get(stockCode);
  const fallback: DartCompanyInfo = {
    status: "000",
    message: "정상 (local cache)",
    corp_code: corpCode,
    corp_name: entry?.corp_name ?? "",
    corp_name_eng: "",
    stock_name: entry?.corp_name ?? "",
    stock_code: stockCode,
    ceo_nm: "",
    corp_cls: "",
    induty_code: "",
    est_dt: "",
    acc_mt: "",
  };
  companyInfoCache.set(stockCode, fallback);
  return fallback;
}

/**
 * 회사명/종목코드/corp_code로 검색 (fuzzy 지원)
 */
export function searchCompanies(query: string, limit: number = 10, listedOnly = false): CorpCodeEntry[] {
  const c = initCache();
  const q = query.trim();
  if (!q) return [];

  // 1. 종목코드 정확 매칭
  const byStock = c.byStockCode.get(q);
  if (byStock) return [byStock];

  // 2. corp_code 정확 매칭
  const byCode = c.byCorpCode.get(q);
  if (byCode) return [byCode];

  // 3. 이름 검색: exact > prefix > contains (상장 우선)
  const qLower = q.toLowerCase().replace(/\s/g, "");
  const exact: CorpCodeEntry[] = [];
  const prefix: CorpCodeEntry[] = [];
  const contains: CorpCodeEntry[] = [];

  for (const entry of c.entries) {
    if (listedOnly && !entry.stock_code) continue;
    const name = entry.corp_name.toLowerCase().replace(/\s/g, "");
    if (name === qLower) exact.push(entry);
    else if (name.startsWith(qLower)) prefix.push(entry);
    else if (name.includes(qLower)) contains.push(entry);

    if (exact.length + prefix.length + contains.length >= limit * 3) break;
  }

  const results = [...exact, ...prefix, ...contains];
  // 상장 기업 우선 정렬
  results.sort((a, b) => (a.stock_code ? 0 : 1) - (b.stock_code ? 0 : 1));
  return results.slice(0, limit);
}
