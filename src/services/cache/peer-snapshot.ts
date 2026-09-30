import fs from "fs";
import path from "path";
import { readDataJson, readManifest } from "./data-files";

/**
 * 분기말 Peer 모집단 스냅샷 로더.
 * scripts/collect-peer-snapshot.ts 가 생성한 data/peer-snapshot/{YYYYMMDD}.json.gz 를 읽는다.
 * 스냅샷 파일은 커밋 후 불변(immutable) — 이것이 peergroup_get_population 결정론의 근거.
 */

export interface PeerSnapshotCompany {
  name: string;
  corpCode: string;
  industryCode: string;
  market: string | null;
  report: { rceptNo: string; type: string; name: string; rceptDt: string } | null;
  overview: string | null;
  segments: string | null;
  /** scripts/summarize-peer-snapshot.ts 후처리 — LLM 3~4문장 개요 요약 (1회 생성 후 고정) */
  overviewSummary?: string | null;
  /** scripts/summarize-peer-snapshot.ts 후처리 — 부문별 매출 금액·비중 한 줄 LLM 요약 (1회 생성 후 고정) */
  segmentsSummary?: string | null;
  /** scripts/summarize-peer-snapshot.ts 후처리 — 매출실적 표 구간만 결정론적 절단 (요약 폴백) */
  segmentsBrief?: string | null;
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

export interface PeerSnapshot {
  _meta: {
    version: number;
    snapshotDate: string;
    builtAt: string;
    companyCount: number;
    rosterSource: string;
    notes: string;
    summary?: {
      method: string;
      summarizedAt: string;
      overviewSummaryCount: number;
      segmentsSummaryCount?: number;
      segmentsBriefCount: number;
    };
  };
  companies: Record<string, PeerSnapshotCompany>;
}

const BASE_DIR = () => path.resolve(process.cwd(), "data/peer-snapshot");

// gunzip+parse 는 비용이 크므로 cold start 이후 memoize
const snapshotMemo = new Map<string, Promise<PeerSnapshot | null>>();
let datesMemo: Promise<string[]> | null = null;

/** 사용 가능한 스냅샷 날짜 목록 (오름차순) — 번들 파일 ∪ data/manifest.json(Blob 에만 있는 날짜) */
export function getAvailableSnapshotDates(): Promise<string[]> {
  if (!datesMemo) {
    datesMemo = (async () => {
      const dates = new Set<string>();
      try {
        for (const f of fs.readdirSync(BASE_DIR())) {
          const m = f.match(/^(\d{8})\.json(\.gz)?$/);
          if (m) dates.add(m[1]);
        }
      } catch {
        // 디렉토리 없음 → 빈 목록
      }
      for (const d of (await readManifest())?.peerSnapshot ?? []) dates.add(d);
      return [...dates].sort();
    })();
  }
  return datesMemo;
}

/**
 * 평가기준일 이하 중 가장 최근 스냅샷 날짜로 해석 (floor).
 * 스냅샷은 미래 방향으로만 추가되고 과거 파일은 불변이므로,
 * 과거 valuation_date 에 대한 floor 결과는 영원히 동일 → 결정론 성립.
 */
export async function resolveSnapshotDate(valuationDate: string): Promise<string | null> {
  let best: string | null = null;
  for (const d of await getAvailableSnapshotDates()) {
    if (d <= valuationDate) best = d;
    else break;
  }
  return best;
}

/** 스냅샷 로드 (gz 우선, 없으면 raw json; 번들 → Blob 순). 파일 없으면 null. */
export function loadPeerSnapshot(snapshotDate: string): Promise<PeerSnapshot | null> {
  let p = snapshotMemo.get(snapshotDate);
  if (!p) {
    p = readDataJson<PeerSnapshot>(`peer-snapshot/${snapshotDate}.json.gz`, `peer-snapshot/${snapshotDate}.json`);
    snapshotMemo.set(snapshotDate, p);
  }
  return p;
}
