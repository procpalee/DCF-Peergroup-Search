/**
 * 평가기준일별 밸류에이션 데이터 사전 수집 스크립트
 *
 * 사용법:
 *   OPENDART_API_KEY=xxx npx tsx scripts/collect-valuation-cache.ts
 *
 * 단계:
 *   1. DART 재무 데이터 수집 (IBD, NCI, 세전이익, 주식수) — 1회, 공유
 *   2. 종가 수집 (날짜별, 네이버금융)
 *   3. 베타 직접계산 (날짜별, 네이버 주가 + KOSPI 회귀 — Weekly-2Y/Monthly-5Y)
 *   4. 조립 → 날짜별 JSON 캐시 파일 생성
 *   5. 검증
 *
 * 이어받기: 중단 후 재실행하면 이미 수집된 종목은 건너뜁니다.
 */

import fs from "fs";
import path from "path";
import { resolveCorpCode } from "../src/services/common/stock-code-resolver";
import { fetchFinancials, fetchStockQuantity, extractSharesInfo, extractNciAndPretax, extractDebtSummary } from "../src/services/opendart/client";
import { extractDebtFromXbrl } from "../src/services/opendart/xbrl-parser";
import { REPORT_CODE } from "../src/services/opendart/constants";
import { fetchHistoricalPrices } from "../src/services/naver/client";
import { computeBetaGridBatch } from "../src/services/beta-calc";
import { getIndustryName } from "../src/services/opendart/ksic-codes";
import type { DebtSummary } from "../src/services/opendart/types";

// ─── 설정 ───

// 2025 분기말 캐시는 이미 생성되어 있음(data/valuation-cache/2025*.json). 재생성/신규 분기
// 추가 시에만 이 스크립트를 실행한다. 베타는 네이버+KOSPI 직접계산(KICPA 제거됨).
const FISCAL_YEAR = "2025";
const VALUATION_DATES = ["20250331", "20250630", "20250930", "20251231"];
const DART_BATCH_SIZE = 3;
const DART_DELAY_MS = 1000;    // 분당 ~180회 (안전)
const NAVER_CONCURRENCY = 10;
const BETA_BATCH_SIZE = 20;    // 베타 직접계산 배치 크기
const SAVE_INTERVAL = 50;

const BASE_DIR = path.resolve(__dirname, "../data/valuation-cache");
const SHARED_DIR = path.join(BASE_DIR, "_shared");
const PROGRESS_DIR = path.join(BASE_DIR, "_progress");
const INDUSTRY_PATH = path.resolve(__dirname, "../data/company-industry.json");

// Load .env.local if present
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(process.cwd(), envFile);
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

const apiKey = process.env.OPENDART_API_KEY ?? "";

// ─── 타입 ───

interface DartData {
  ibd: { current: [string, number][]; nonCurrent: [string, number][]; total: number } | null;
  nci: number | null;
  pretaxIncome: number | null;
  shares: number | null;
}

// ─── 유틸리티 ───

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function getListedStocks(): Array<{ code: string; name: string; industryCode: string }> {
  const industry: Record<string, { name: string; corpCode: string; industryCode: string }> =
    JSON.parse(fs.readFileSync(INDUSTRY_PATH, "utf8"));
  return Object.entries(industry).map(([code, entry]) => ({
    code,
    name: entry.name,
    industryCode: entry.industryCode,
  }));
}

// ─── 단계 1: DART 재무 데이터 (1회, 공유) ───

async function collectDartData(stocks: Array<{ code: string }>): Promise<Record<string, DartData>> {
  const sharedPath = path.join(SHARED_DIR, `dart-${FISCAL_YEAR}.json`);
  const progressPath = path.join(PROGRESS_DIR, "dart.json");

  const existing: Record<string, DartData> = loadJson(sharedPath) ?? {};
  const progress: Set<string> = new Set(loadJson<string[]>(progressPath) ?? []);

  const toFetch = stocks.filter((s) => !progress.has(s.code));
  console.log(`[DART] 기존: ${progress.size} / 미수집: ${toFetch.length}`);

  if (toFetch.length === 0) return existing;

  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < toFetch.length; i += DART_BATCH_SIZE) {
    const batch = toFetch.slice(i, i + DART_BATCH_SIZE);

    await Promise.all(batch.map(async (s) => {
      try {
        const corpCode = await resolveCorpCode(s.code);
        const [finResult, qtyResult] = await Promise.allSettled([
          fetchFinancials(corpCode, FISCAL_YEAR, REPORT_CODE.annual, "CFS", apiKey),
          fetchStockQuantity(corpCode, FISCAL_YEAR, REPORT_CODE.annual, apiKey),
        ]);

        let ibd: DartData["ibd"] = null;
        let nci: number | null = null;
        let pretaxIncome: number | null = null;

        if (finResult.status === "fulfilled" && finResult.value.length > 0) {
          const items = finResult.value;
          const np = extractNciAndPretax(items);
          nci = np.nonControllingInterest;
          pretaxIncome = np.pretaxIncome;

          const rceptNo = items[0]?.rcept_no;
          let debt: DebtSummary | null = null;
          if (rceptNo) {
            const xd = await extractDebtFromXbrl(rceptNo, FISCAL_YEAR, apiKey);
            if (xd) debt = { ...xd, nonControllingInterest: nci, pretaxIncome };
          }
          if (!debt) {
            const fb = extractDebtSummary(items) as DebtSummary & { _isDebtFree?: boolean };
            if (fb.interestBearingDebt > 0 || fb._isDebtFree) debt = fb;
          }
          if (debt) {
            ibd = {
              current: debt.current.items.map((x) => [x.account, x.amount]),
              nonCurrent: debt.nonCurrent.items.map((x) => [x.account, x.amount]),
              total: debt.interestBearingDebt,
            };
          }
        }

        const shares = qtyResult.status === "fulfilled"
          ? extractSharesInfo(qtyResult.value, FISCAL_YEAR, REPORT_CODE.annual)?.outstanding ?? null
          : null;

        existing[s.code] = { ibd, nci, pretaxIncome, shares };
        progress.add(s.code);
        fetched++;
      } catch {
        progress.add(s.code); // 실패해도 재시도 방지
        failed++;
      }
    }));

    const total = fetched + failed;
    if (total % SAVE_INTERVAL === 0 || i + DART_BATCH_SIZE >= toFetch.length) {
      saveJson(sharedPath, existing);
      saveJson(progressPath, [...progress]);
      console.log(`[DART] ${total}/${toFetch.length} (success=${fetched}, fail=${failed})`);
    }

    if (i + DART_BATCH_SIZE < toFetch.length) await sleep(DART_DELAY_MS);
  }

  saveJson(sharedPath, existing);
  saveJson(progressPath, [...progress]);
  console.log(`[DART] 완료: ${fetched} 수집, ${failed} 실패`);
  return existing;
}

// ─── 단계 2: 종가 수집 (날짜별) ───

async function collectPrices(
  stocks: Array<{ code: string }>,
  valuationDate: string,
): Promise<Record<string, number | null>> {
  const progressPath = path.join(PROGRESS_DIR, `price-${valuationDate}.json`);
  const existing: Record<string, number | null> = loadJson(progressPath) ?? {};

  const toFetch = stocks.filter((s) => !(s.code in existing));
  console.log(`[PRICE ${valuationDate}] 기존: ${Object.keys(existing).length} / 미수집: ${toFetch.length}`);

  if (toFetch.length === 0) return existing;

  // 평가기준일 이전 14일간 조회 → 마지막 거래일 종가
  const endDate = valuationDate;
  const d = new Date(`${valuationDate.slice(0, 4)}-${valuationDate.slice(4, 6)}-${valuationDate.slice(6, 8)}`);
  d.setDate(d.getDate() - 14);
  const startDate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  let done = 0;

  for (let i = 0; i < toFetch.length; i += NAVER_CONCURRENCY) {
    const batch = toFetch.slice(i, i + NAVER_CONCURRENCY);

    await Promise.all(batch.map(async (s) => {
      try {
        const prices = await fetchHistoricalPrices(s.code, startDate, endDate);
        // 평가기준일 이하에서 가장 가까운 거래일
        const valid = prices.filter((p) => p.date <= valuationDate);
        existing[s.code] = valid.length > 0 ? valid[valid.length - 1].close : null;
      } catch {
        existing[s.code] = null;
      }
      done++;
    }));

    if (done % (SAVE_INTERVAL * NAVER_CONCURRENCY) === 0 || i + NAVER_CONCURRENCY >= toFetch.length) {
      saveJson(progressPath, existing);
      console.log(`[PRICE ${valuationDate}] ${done}/${toFetch.length}`);
    }
  }

  saveJson(progressPath, existing);
  console.log(`[PRICE ${valuationDate}] 완료`);
  return existing;
}

// ─── 단계 3: 베타 수집 (날짜별) ───

async function collectBetas(
  stocks: Array<{ code: string }>,
  valuationDate: string,
): Promise<Record<string, { weekly: Record<string, [number | null, number | null, number | null]> | null; monthly: Record<string, [number | null, number | null, number | null]> | null }>> {
  const progressPath = path.join(PROGRESS_DIR, `beta-${valuationDate}.json`);
  const existing: Record<string, { weekly: any; monthly: any }> = loadJson(progressPath) ?? {};

  const toFetch = stocks.filter((s) => !(s.code in existing));
  console.log(`[BETA ${valuationDate}] 기존: ${Object.keys(existing).length} / 미수집: ${toFetch.length}`);

  if (toFetch.length === 0) return existing;

  const codes = toFetch.map((s) => s.code);

  for (let i = 0; i < codes.length; i += BETA_BATCH_SIZE) {
    const batch = codes.slice(i, i + BETA_BATCH_SIZE);

    try {
      // 네이버 주가 + KOSPI 회귀로 직접 계산 (Weekly-2Y, Monthly-5Y)
      const { weeklyMap, monthlyMap } = await computeBetaGridBatch(batch, valuationDate);

      for (const code of batch) {
        const w = weeklyMap.get(code);
        const m = monthlyMap.get(code);

        const compactW = w ? Object.fromEntries(Object.entries(w.betas).map(([p, v]) => [p, [v.raw, v.adjusted, v.dataPoints]])) : null;
        const compactM = m ? Object.fromEntries(Object.entries(m.betas).map(([p, v]) => [p, [v.raw, v.adjusted, v.dataPoints]])) : null;

        existing[code] = { weekly: compactW, monthly: compactM };
      }
    } catch {
      for (const code of batch) {
        existing[code] = { weekly: null, monthly: null };
      }
    }

    const done = Math.min(i + BETA_BATCH_SIZE, codes.length);
    if (done % (SAVE_INTERVAL) === 0 || done >= codes.length) {
      saveJson(progressPath, existing);
      console.log(`[BETA ${valuationDate}] ${done}/${codes.length}`);
    }
  }

  saveJson(progressPath, existing);
  console.log(`[BETA ${valuationDate}] 완료`);
  return existing;
}

// ─── 단계 4: 조립 ───

function assemble(
  stocks: Array<{ code: string; name: string; industryCode: string }>,
  dartData: Record<string, DartData>,
  prices: Record<string, number | null>,
  betas: Record<string, { weekly: any; monthly: any }>,
  valuationDate: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const s of stocks) {
    const dart = dartData[s.code];
    const price = prices[s.code] ?? null;
    const beta = betas[s.code] ?? { weekly: null, monthly: null };
    const shares = dart?.shares ?? null;
    const mcapTotal = price && shares ? price * shares : null;

    result[s.code] = {
      code: s.code,
      name: s.name,
      industry: { code: s.industryCode, name: getIndustryName(s.industryCode) },
      year: FISCAL_YEAR,
      valuationDate,
      beta,
      ibd: dart?.ibd ?? null,
      nci: dart?.nci ?? null,
      pretaxIncome: dart?.pretaxIncome ?? null,
      marketCap: { price, shares, total: mcapTotal },
    };
  }

  return result;
}

// ─── 메인 ───

async function main() {
  if (!apiKey) {
    console.error("OPENDART_API_KEY 환경변수를 설정해주세요.");
    process.exit(1);
  }

  ensureDir(SHARED_DIR);
  ensureDir(PROGRESS_DIR);

  const stocks = getListedStocks();
  console.log(`총 ${stocks.length}개 상장사, ${VALUATION_DATES.length}개 평가기준일\n`);

  // 단계 1: DART 재무 (1회)
  console.log("=== 단계 1: DART 재무 데이터 ===");
  const dartData = await collectDartData(stocks);

  // 단계 2-3: 날짜별 종가 + 베타
  for (const vDate of VALUATION_DATES) {
    console.log(`\n=== 단계 2: 종가 (${vDate}) ===`);
    const prices = await collectPrices(stocks, vDate);

    console.log(`\n=== 단계 3: 베타 (${vDate}) ===`);
    const betas = await collectBetas(stocks, vDate);

    // 단계 4: 조립
    console.log(`\n=== 단계 4: 조립 (${vDate}) ===`);
    const assembled = assemble(stocks, dartData, prices, betas, vDate);
    const outPath = path.join(BASE_DIR, `${vDate}.json`);
    saveJson(outPath, assembled);
    console.log(`저장: ${outPath} (${Object.keys(assembled).length}개 종목)`);
  }

  // 단계 5: 검증
  console.log("\n=== 단계 5: 검증 ===");
  const testCodes = ["005930", "005380", "007660"];
  const testDate = VALUATION_DATES[0];
  const cache = loadJson<Record<string, any>>(path.join(BASE_DIR, `${testDate}.json`));
  if (cache) {
    for (const code of testCodes) {
      const entry = cache[code];
      if (entry) {
        console.log(`${entry.name} (${code}): IBD=${entry.ibd?.total?.toLocaleString() ?? "null"}, price=${entry.marketCap?.price}, beta_w=${entry.beta?.weekly ? "OK" : "null"}`);
      } else {
        console.log(`${code}: NOT FOUND`);
      }
    }

    // 통계
    const entries = Object.values(cache) as any[];
    const ibdNull = entries.filter((e) => !e.ibd).length;
    const betaNull = entries.filter((e) => !e.beta?.weekly).length;
    const priceNull = entries.filter((e) => !e.marketCap?.price).length;
    console.log(`\n통계 (${testDate}):`);
    console.log(`  총: ${entries.length}개`);
    console.log(`  IBD null: ${ibdNull}개`);
    console.log(`  베타 null: ${betaNull}개`);
    console.log(`  종가 null: ${priceNull}개`);
  }

  console.log("\n완료!");
}

main();
