/**
 * 보고서 원자료 저장소(파일) — 수집·검증 스크립트 전용(서버 런타임에서는 쓰지 않는다).
 * data/valuation-cache/_shared/raw/{접수일자 8자리}/{접수번호}.json.gz
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import type { RawReport, RawStore } from "./asof-financials";

export const DEFAULT_RAW_DIR = process.env.KVD_RAW_DIR ?? path.resolve(__dirname, "../../../data/valuation-cache/_shared/raw");

export function createFsRawStore(dir: string = DEFAULT_RAW_DIR): RawStore & { has(rceptNo: string): boolean; dir: string } {
  const file = (r: string) => path.join(dir, r.slice(0, 8), `${r}.json.gz`);
  return {
    dir,
    has: (r) => fs.existsSync(file(r)),
    get(r) {
      const f = file(r);
      if (!fs.existsSync(f)) return null;
      try {
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8")) as RawReport;
      } catch {
        return null; // 쓰다 끊긴 파일 — 다시 받는다
      }
    },
    put(r, raw) {
      const f = file(r);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // 프로세스마다 다른 임시 파일 — 두 수집이 겹쳐도 서로의 임시 파일을 덮지 않게
      const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(raw)));
      fs.renameSync(tmp, f);
    },
  };
}
