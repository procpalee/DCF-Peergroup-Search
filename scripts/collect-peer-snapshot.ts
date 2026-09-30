/**
 * 분기말 Peer 모집단 스냅샷 캐시를 생성합니다.
 *
 * 각 분기말(평가기준일) 시점에 "이용 가능했던 최신 정기보고서"에서
 * 사업의 개요 + 부문별 매출 섹션을 추출해 종목별로 저장합니다.
 * peergroup_get_population 도구가 이 스냅샷을 읽어 결정론적 모집단을 반환합니다.
 *
 * 사용법:
 *   OPENDART_API_KEY=xxx npx tsx scripts/collect-peer-snapshot.ts            # 4개 분기 전체
 *   OPENDART_API_KEY=xxx npx tsx scripts/collect-peer-snapshot.ts --date 20251231
 *
 * 출력: data/peer-snapshot/{YYYYMMDD}.json.gz
 * 중간산출(재개용, gitignore): data/peer-snapshot/_shared/, _progress/
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import axios from "axios";
import {
  fetchBusinessContentForDocs,
  selectPeriodicReportCandidates,
  type DartListDoc,
} from "../src/services/opendart/document-parser";
import { sliceBusinessSections } from "../src/services/opendart/section-slicer";

// ─── 설정 ───
const ALL_DATES = ["20250331", "20250630", "20250930", "20251231"];
const BATCH_SIZE = 3;
const DELAY_MS = 1000;
const SAVE_INTERVAL = 10;

const BASE_DIR = path.resolve(__dirname, "../data/peer-snapshot");
const SHARED_DIR = path.join(BASE_DIR, "_shared");
const SECTIONS_DIR = path.join(SHARED_DIR, "sections");
const PROGRESS_DIR = path.join(BASE_DIR, "_progress");
const LISTS_PATH = path.join(SHARED_DIR, "report-lists.json");
const INDUSTRY_PATH = path.resolve(__dirname, "../data/company-industry.json");

const DART_API_BASE = "https://opendart.fss.or.kr/api";

// 환경변수 로드
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

interface RosterEntry {
  stockCode: string;
  name: string;
  corpCode: string;
  industryCode: string;
  market?: string;
  accMonth?: string;
  listedDate?: string;
}

interface SectionEntry {
  overview: string | null;
  segments: string | null;
  segmentsSource: "sales" | "products" | "business" | null;
  report: { rceptNo: string; type: string; name: string; rceptDt: string };
}

/** _shared/sections/{corpCode}.json — rceptNo 단위 추출 결과 (실패는 "FAILED") */
type SectionsFile = Record<string, SectionEntry | "FAILED">;

interface SnapshotCompany {
  name: string;
  corpCode: string;
  industryCode: string;
  market: string | null;
  report: SectionEntry["report"] | null;
  overview: string | null;
  segments: string | null;
  flags: {
    segmentsSource: "sales" | "products" | "business" | null;
    overviewMissing: boolean;
    isSpac: boolean;
    isHolding: boolean;
    isReit: boolean;
    fiscalMonthNot12: boolean;
    isAdministrative: boolean | null;
  };
}

// ─── 유틸 ───

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
function saveJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function monthsBefore(yyyymmdd: string, months: number): string {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const total = y * 12 + (m - 1) - months;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}01`;
}

function getRoster(): RosterEntry[] {
  const industry: Record<string, Omit<RosterEntry, "stockCode">> = JSON.parse(
    fs.readFileSync(INDUSTRY_PATH, "utf8")
  );
  return Object.entries(industry).map(([stockCode, e]) => ({ stockCode, ...e }));
}

/** KIND 관리종목 목록 (best-effort — 실패 시 null) */
async function fetchAdministrativeIssues(): Promise<Set<string> | null> {
  try {
    const res = await axios.get(
      "https://kind.krx.co.kr/investwarn/adminissue.do?method=searchAdminIssueSub&currentPageSize=3000&pageIndex=1&menuIndex=1&forward=adminissue_down",
      {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
          Referer: "https://kind.krx.co.kr/investwarn/adminissue.do?method=searchAdminIssueMain",
        },
      }
    );
    const html = new TextDecoder("euc-kr").decode(res.data);
    const codes = [...html.matchAll(/>(\d{6})</g)].map((m) => m[1]);
    if (codes.length === 0) return null;
    console.log(`[관리종목] ${codes.length}건 수집`);
    return new Set(codes);
  } catch (e: any) {
    console.warn(`[관리종목] 수집 실패 (${e.message}) — isAdministrative=null 로 저장`);
    return null;
  }
}

/** 회사당 정기공시 목록 1회 조회 (전 스냅샷 기간 공용) */
async function fetchReportList(corpCode: string, bgnDe: string, endDe: string): Promise<DartListDoc[]> {
  const res = await axios.get(`${DART_API_BASE}/list.json`, {
    params: {
      crtfc_key: apiKey,
      corp_code: corpCode,
      bgn_de: bgnDe,
      end_de: endDe,
      pblntf_ty: "A",
      page_count: 100,
    },
    timeout: 15000,
  });
  return res.data.list ?? [];
}

// ─── 메인 ───

async function main() {
  if (!apiKey) {
    console.error("OPENDART_API_KEY 환경변수를 설정해주세요.");
    process.exit(1);
  }

  const dateArgIdx = process.argv.indexOf("--date");
  const targetDates =
    dateArgIdx >= 0 ? process.argv[dateArgIdx + 1].split(",") : ALL_DATES;
  for (const d of targetDates) {
    if (!/^\d{8}$/.test(d)) {
      console.error(`잘못된 날짜: ${d}`);
      process.exit(1);
    }
  }

  ensureDir(BASE_DIR);
  ensureDir(SHARED_DIR);
  ensureDir(SECTIONS_DIR);
  ensureDir(PROGRESS_DIR);

  // ── 0단계: 로스터 + 관리종목 ──
  const roster = getRoster();
  console.log(`[로스터] ${roster.length}종목 (company-industry.json)`);
  const adminSet = await fetchAdministrativeIssues();

  // ── 1단계: 회사당 정기공시 목록 수집 (재개 지원) ──
  // 조회 기간은 요청 기준일에 맞춘다(과거엔 2025 4개 분기로 고정 → 2026 기준일에서 2026 공시가 안 보였음).
  // 목록 파일이 반영한 마지막 날짜(meta)가 가장 늦은 기준일보다 이르면 전 종목을 다시 받아 합친다.
  const sortedTargets = [...targetDates].sort();
  const listBgn = monthsBefore(sortedTargets[0], 15);
  const listEnd = sortedTargets[sortedTargets.length - 1];
  const listsMetaPath = path.join(SHARED_DIR, "report-lists.meta.json");
  const listsMeta: { fetchedThrough?: string } = loadJson(listsMetaPath) ?? { fetchedThrough: "20251231" };
  const lists: Record<string, DartListDoc[]> = loadJson(LISTS_PATH) ?? {};
  const stale = (listsMeta.fetchedThrough ?? "") < listEnd;
  const toList = roster.filter((r) => stale || !lists[r.corpCode]);
  console.log(
    `[1단계] 공시목록: 기존 ${Object.keys(lists).length} / ${stale ? `기준일 ${listEnd}까지 갱신` : "미수집"} ${toList.length}`,
  );

  let listDone = 0;
  for (let i = 0; i < toList.length; i += BATCH_SIZE) {
    const batch = toList.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (r) => {
        try {
          const fresh = await fetchReportList(r.corpCode, listBgn, listEnd);
          // 이전 기간 목록과 합친다 — 과거 기준일 스냅샷 재생성에도 쓰이므로 덮어쓰지 않는다
          const merged = new Map([...(lists[r.corpCode] ?? []), ...fresh].map((d) => [d.rcept_no, d]));
          lists[r.corpCode] = [...merged.values()];
        } catch (e: any) {
          console.error(`[list ${r.stockCode} ${r.name}] ${e.message}`);
        }
      })
    );
    listDone += batch.length;
    if (listDone % (SAVE_INTERVAL * 10) === 0 || i + BATCH_SIZE >= toList.length) {
      saveJson(LISTS_PATH, lists);
      console.log(`[1단계] ${listDone}/${toList.length}`);
    }
    if (i + BATCH_SIZE < toList.length) await sleep(DELAY_MS);
  }
  saveJson(LISTS_PATH, lists);
  if (stale) saveJson(listsMetaPath, { fetchedThrough: listEnd });

  // ── 2단계: 필요한 문서 다운로드/추출 (rcept_no 단위 중복 제거 + 후보 폴백 체인) ──
  // 각 (회사, 날짜)는 "후보 체인의 첫 성공본"을 써야 하므로, 1순위부터 순서대로
  // 미시도 후보가 나오기 전에 성공이 캐시되어 있어야만 충족으로 본다.
  // (하위 순위 후보의 성공본만 있는 상태에서 건너뛰면 다른 날짜용 구본이 잘못 채택됨)
  // 실패는 FAILED로 기록해 재시도 방지. 같은 회사의 여러 날짜가 같은 후보를 공유하면 1회만 다운로드된다.
  const isDateSatisfied = (cands: DartListDoc[], sections: SectionsFile): boolean => {
    for (const c of cands) {
      const s = sections[c.rcept_no];
      if (s === undefined) return false; // 앞 순위에 미시도 후보 존재 → 다운로드 필요
      if (s !== "FAILED") return true; // 첫 번째 확정 결과가 성공 → 충족
    }
    return true; // 전부 시도했고 전부 실패 → 더 할 일 없음
  };
  const needWork = roster.filter((r) => {
    const docs = lists[r.corpCode];
    if (!docs || docs.length === 0) return false;
    const sections: SectionsFile = loadJson(path.join(SECTIONS_DIR, `${r.corpCode}.json`)) ?? {};
    return targetDates.some((date) => {
      const cands = selectPeriodicReportCandidates(docs, date);
      if (cands.length === 0) return false;
      return !isDateSatisfied(cands, sections);
    });
  });
  console.log(`[2단계] 다운로드 대상: ${needWork.length}종목`);

  let done = 0;
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < needWork.length; i += BATCH_SIZE) {
    const batch = needWork.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (r) => {
        const sectionsPath = path.join(SECTIONS_DIR, `${r.corpCode}.json`);
        const sections: SectionsFile = loadJson(sectionsPath) ?? {};
        const docs = lists[r.corpCode];
        for (const date of targetDates) {
          const cands = selectPeriodicReportCandidates(docs, date);
          if (isDateSatisfied(cands, sections)) continue;
          for (const cand of cands) {
            const cached = sections[cand.rcept_no];
            if (cached && cached !== "FAILED") break; // 이 순위에서 이미 성공 → 이 날짜 충족
            if (cached !== undefined) continue; // FAILED 기록됨 → 다음 후보
            try {
              const result = await fetchBusinessContentForDocs([cand], apiKey);
              if (result) {
                const sliced = sliceBusinessSections(result.markdown);
                sections[result.report.rceptNo] = {
                  overview: sliced.overview,
                  segments: sliced.segments,
                  segmentsSource: sliced.segmentsSource,
                  report: result.report,
                };
                ok++;
                break; // 이 날짜의 후보 체인 성공 → 다음 날짜로
              } else {
                sections[cand.rcept_no] = "FAILED";
                fail++;
              }
            } catch (e: any) {
              // DART 일일 한도 초과는 문서 실패가 아니다 — FAILED 로 남기면 스냅샷이 영구히 비므로
              // 진행분을 저장하고 중단(종료코드 2)해 다음 실행에서 이어받는다.
              if (/020|사용한도|요청 제한/.test(e.message ?? "")) {
                saveJson(sectionsPath, sections);
                console.error(`[중단] DART 호출 한도: ${e.message} — 다음 실행에서 이어서 수집`);
                process.exit(2);
              }
              console.error(`[doc ${r.stockCode} ${cand.rcept_no}] ${e.message}`);
              sections[cand.rcept_no] = "FAILED";
              fail++;
            }
          }
        }
        saveJson(sectionsPath, sections);
      })
    );
    done += batch.length;
    if (done % SAVE_INTERVAL === 0 || i + BATCH_SIZE >= needWork.length) {
      console.log(`[2단계] ${done}/${needWork.length}종목 (문서 성공=${ok}, 실패=${fail})`);
    }
    if (i + BATCH_SIZE < needWork.length) await sleep(DELAY_MS);
  }

  // ── 3단계: 날짜별 조립 ──
  for (const date of targetDates) {
    const companies: Record<string, SnapshotCompany> = {};
    let ovNull = 0;
    let segNull = 0;
    const typeDist: Record<string, number> = {};

    for (const r of roster) {
      const docs = lists[r.corpCode];
      if (!docs || docs.length === 0) continue;
      const cands = selectPeriodicReportCandidates(docs, date);
      if (cands.length === 0) continue; // 기준일 이전 정기보고서 없음(신규상장 등) → 자연 배제

      const sections: SectionsFile =
        loadJson(path.join(SECTIONS_DIR, `${r.corpCode}.json`)) ?? {};
      // 후보 순서대로 추출 성공본 탐색
      let picked: SectionEntry | null = null;
      for (const c of cands) {
        const s = sections[c.rcept_no];
        if (s && s !== "FAILED") {
          picked = s;
          break;
        }
      }

      const flags: SnapshotCompany["flags"] = {
        segmentsSource: picked?.segmentsSource ?? null,
        overviewMissing: !picked?.overview,
        isSpac: r.name.includes("기업인수목적"),
        isHolding: r.industryCode === "64992" || /지주|홀딩스/.test(r.name),
        isReit: /리츠|부동산투자회사/.test(r.name),
        fiscalMonthNot12: r.accMonth !== undefined && r.accMonth !== "12",
        isAdministrative: adminSet ? adminSet.has(r.stockCode) : null,
      };

      companies[r.stockCode] = {
        name: r.name,
        corpCode: r.corpCode,
        industryCode: r.industryCode,
        market: r.market ?? null,
        report: picked?.report ?? null,
        overview: picked?.overview ?? null,
        segments: picked?.segments ?? null,
        flags,
      };
      if (!picked?.overview) ovNull++;
      if (!picked?.segments) segNull++;
      if (picked) typeDist[picked.report.type] = (typeDist[picked.report.type] ?? 0) + 1;
    }

    const snapshot = {
      _meta: {
        version: 1,
        snapshotDate: date,
        builtAt: new Date().toISOString(),
        companyCount: Object.keys(companies).length,
        rosterSource: "data/company-industry.json (KRX KIND corpList 기준 상장사)",
        notes:
          "빌드 시점 상장 목록 기준. 스냅샷일~빌드일 사이 상장폐지 종목은 미포함될 수 있으며 industryCode는 빌드 시점 값임 (DART/KRX API로 소급 재구성 불가).",
      },
      companies,
    };
    // 스냅샷은 불변이다 — 개요 누락이 평소(2025 분기 0.4~0.7%)보다 훨씬 많으면 수집 사고로 보고 확정하지 않는다
    const nAll = Object.keys(companies).length;
    const maxOvNull = Number(process.env.PEER_MAX_OVERVIEW_NULL ?? "0.05");
    if (nAll === 0 || ovNull / nAll > maxOvNull) {
      console.error(
        `[${date}] 개요 누락 ${ovNull}/${nAll} (${((ovNull / Math.max(nAll, 1)) * 100).toFixed(1)}%) — 한도 ${(maxOvNull * 100).toFixed(0)}% 초과, 스냅샷을 쓰지 않음`,
      );
      process.exit(2);
    }
    const json = JSON.stringify(snapshot);
    fs.writeFileSync(path.join(BASE_DIR, `${date}.json`), json);
    fs.writeFileSync(path.join(BASE_DIR, `${date}.json.gz`), zlib.gzipSync(json, { level: 9 }));

    // ── 4단계: 검증 통계 ──
    const n = Object.keys(companies).length;
    console.log(
      `[${date}] 종목 ${n} / overview null ${ovNull} (${((ovNull / n) * 100).toFixed(1)}%) / segments null ${segNull} (${((segNull / n) * 100).toFixed(1)}%) / 보고서 유형 ${JSON.stringify(typeDist)} / gz ${(fs.statSync(path.join(BASE_DIR, `${date}.json.gz`)).size / 1024 / 1024).toFixed(1)}MB`
    );
  }

  console.log("[완료]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
