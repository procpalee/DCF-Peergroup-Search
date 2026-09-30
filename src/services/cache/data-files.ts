/**
 * 데이터 파일 읽기 — 번들(로컬) 우선, 없으면 Vercel Blob(공개 URL)에서 받아 메모리에 캐시.
 *
 * 배경(2026-09-30): 분기마다 캐시가 약 12MB·연 45MB씩 늘어 서버리스 번들 한도(250MB)에
 * 닿는다. 최근 분기만 번들에 넣고(next.config.ts) 나머지는 Blob 에서 요청 시 내려받는다.
 * KVD_BLOB_BASE_URL 이 없으면 지금처럼 로컬 파일만 쓴다(설정 전에도 동작 동일).
 *
 * 경로는 data/ 기준 상대경로(예: "valuation-cache/20251231.json").
 * Blob 에는 같은 상대경로로 올린다(scripts/upload-data-blob.ts).
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";

const DATA_DIR = () => path.resolve(process.cwd(), "data");
const REMOTE = () => (process.env.KVD_BLOB_BASE_URL ?? "").replace(/\/+$/, "");

const memo = new Map<string, Promise<Buffer | null>>();

async function fetchRemote(rel: string): Promise<Buffer | null> {
  const base = REMOTE();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/${rel}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** 원본 바이트 — 로컬 → 원격 순. 결과(없음 포함)는 인스턴스 수명 동안 메모이즈 */
export function readDataBuffer(rel: string): Promise<Buffer | null> {
  let p = memo.get(rel);
  if (!p) {
    p = (async () => {
      const local = path.join(DATA_DIR(), rel);
      if (fs.existsSync(local)) return fs.readFileSync(local);
      return fetchRemote(rel);
    })();
    memo.set(rel, p);
  }
  return p;
}

/** JSON 읽기 — .gz 면 풀어서 파싱. 후보 경로를 순서대로 시도(예: gz → json) */
export async function readDataJson<T>(...rels: string[]): Promise<T | null> {
  for (const rel of rels) {
    const buf = await readDataBuffer(rel);
    if (!buf) continue;
    try {
      const text = rel.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      return JSON.parse(text) as T;
    } catch {
      continue;
    }
  }
  return null;
}

export interface DataManifest {
  generatedAt: string;
  valuationCache: string[];
  peerSnapshot: string[];
  businessCache: string[];
}

let manifestMemo: Promise<DataManifest | null> | null = null;

/** data/manifest.json — 사용할 수 있는 기준일·연도 목록(번들에 없는 파일 포함) */
export function readManifest(): Promise<DataManifest | null> {
  if (!manifestMemo) manifestMemo = readDataJson<DataManifest>("manifest.json");
  return manifestMemo;
}
