/**
 * 이자부부채 검증 코퍼스 — 기준일의 전 종목 원자료(재무 행·XBRL 주석 사실·주식수)를 _shared/raw 에 채운다.
 * 수집 스크립트와 같은 보고서 선택 규칙을 쓰고, 검증을 위해 XBRL 주석 사실은 모든 회사에 대해 받는다.
 *
 *   npx tsx scripts/ibd-corpus.ts 20260630            # 원자료 채우기(이어받기 가능, DART 한도 초과 시 종료코드 2)
 *   npx tsx scripts/ibd-corpus.ts 20260630 --no-xbrl  # 재무 행·주식수만
 *   npx tsx scripts/ibd-corpus.ts 20260630 --codes 005930,000660   # 일부 종목만(시험)
 *
 * 출력: data/valuation-cache/_shared/raw/…(원자료), scripts/_scratch/ibd-corpus/{기준일}.index.json(종목 목록)
 */
import fs from "fs";
import path from "path";
import { selectAsOfReport } from "../src/services/opendart/report-asof";
import { fetchFinForReport, ensureXbrlFacts } from "../src/services/valuation/asof-financials";
import { createFsRawStore } from "../src/services/valuation/raw-store-fs";
import type { DartListDoc } from "../src/services/opendart/document-parser";

for (const envFile of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}
const apiKey = process.env.OPENDART_API_KEY ?? "";

const ROOT = path.resolve(__dirname, "..");
const LISTS = path.join(ROOT, "data/valuation-cache/_shared/report-lists.json");
const INDUSTRY = path.join(ROOT, "data/company-industry.json");
const OUT_DIR = path.join(ROOT, "scripts/_scratch/ibd-corpus");
const BATCH = 3;
const DELAY_MS = 1000;

class FatalApiError extends Error {}
function checkFatal(e: unknown) {
  const msg = (e as Error)?.message ?? "";
  if (/status: 020|사용한도|요청 제한/.test(msg)) throw new FatalApiError(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CorpusEntry {
  code: string;
  name: string;
  corpCode: string;
  industryCode: string;
  accMonth: string;
  rceptNo: string;
  reprtCode: string;
  reportName: string;
}

async function main() {
  const asOf = process.argv.slice(2).find((a) => /^\d{8}$/.test(a)) ?? "20260630";
  const withXbrl = !process.argv.includes("--no-xbrl");
  if (!apiKey) throw new Error("OPENDART_API_KEY 필요");
  const lists: Record<string, { docs: DartListDoc[] }> = JSON.parse(fs.readFileSync(LISTS, "utf8"));
  const industry: Record<string, { name: string; corpCode: string; industryCode: string; accMonth?: string; listedDate?: string }> =
    JSON.parse(fs.readFileSync(INDUSTRY, "utf8"));
  const store = createFsRawStore();

  const entries: CorpusEntry[] = [];
  for (const [code, e] of Object.entries(industry)) {
    if (e.listedDate && e.listedDate.replace(/-/g, "") > asOf) continue;
    const rep = selectAsOfReport(lists[e.corpCode]?.docs ?? [], asOf, e.accMonth ?? "12");
    if (!rep) continue;
    entries.push({
      code,
      name: e.name,
      corpCode: e.corpCode,
      industryCode: e.industryCode,
      accMonth: e.accMonth ?? "12",
      rceptNo: rep.rceptNo,
      reprtCode: rep.reprtCode,
      reportName: rep.reportName,
    });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${asOf}.index.json`), JSON.stringify(entries));
  console.log(`[코퍼스 ${asOf}] 대상 ${entries.length}종목`);

  const ci = process.argv.indexOf("--codes");
  const only = ci >= 0 ? new Set(process.argv[ci + 1].split(",")) : null;
  const targets = only ? entries.filter((e) => only.has(e.code)) : entries;

  let done = 0;
  let fetched = 0;
  try {
    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      let network = false;
      await Promise.all(
        batch.map(async (en) => {
          const raw0 = store.get(en.rceptNo);
          const complete = raw0 && raw0.shares && (!withXbrl || raw0.xbrl !== undefined);
          if (complete) return;
          network = true;
          const rep = selectAsOfReport(lists[en.corpCode]?.docs ?? [], asOf, en.accMonth)!;
          try {
            await fetchFinForReport(en, rep, apiKey, checkFatal, store);
            const raw = store.get(en.rceptNo);
            if (raw && withXbrl && raw.xbrl === undefined) {
              await ensureXbrlFacts(raw, en.reprtCode, apiKey);
              store.put(en.rceptNo, raw);
            }
            fetched += 1;
          } catch (e) {
            checkFatal(e);
            console.error(`${en.code} 실패: ${(e as Error).message}`);
          }
        }),
      );
      done += batch.length;
      if ((i / BATCH) % 50 === 0 || done >= targets.length) console.log(`[코퍼스 ${asOf}] ${done}/${targets.length} (새로 받음 ${fetched})`);
      if (network) await sleep(DELAY_MS);
    }
  } catch (e) {
    if (e instanceof FatalApiError) {
      console.error(`DART 한도 초과로 중단 — 내일 같은 명령으로 이어서 실행: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const missing = targets.filter((e) => !store.has(e.rceptNo)).length;
  console.log(`[코퍼스 ${asOf}] 완료 — 원자료 없음 ${missing}`);
}

main();
