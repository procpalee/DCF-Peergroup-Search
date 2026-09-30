/**
 * data/ 캐시 파일을 Vercel Blob 에 올린다(같은 상대경로, 공개, 덮어쓰기).
 * 런타임은 번들에 없는 파일을 KVD_BLOB_BASE_URL/{상대경로} 에서 받는다(src/services/cache/data-files.ts).
 *
 *   BLOB_READ_WRITE_TOKEN=... npx tsx scripts/upload-data-blob.ts        # 바뀐 파일만
 *   BLOB_READ_WRITE_TOKEN=... npx tsx scripts/upload-data-blob.ts --all  # 전부
 *
 * 올린 파일의 해시는 data/blob-ledger.json 에 기록해 다음 실행에서 건너뛴다(커밋 대상).
 * 첫 업로드 후 출력되는 기준 URL 을 Vercel 환경변수 KVD_BLOB_BASE_URL 로 설정한다.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { put } from "@vercel/blob";

const DATA = path.resolve(__dirname, "../data");
const LEDGER = path.join(DATA, "blob-ledger.json");

const TARGETS: [string, RegExp][] = [
  ["valuation-cache", /^\d{8}(\.meta)?\.json$/],
  ["peer-snapshot", /^\d{8}\.json\.gz$/],
  ["business-cache", /^\d{4}\.json\.gz$/],
];

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.log("BLOB_READ_WRITE_TOKEN 없음 — 업로드 생략");
    return;
  }
  const all = process.argv.includes("--all");
  const ledger: Record<string, string> = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
  const files: string[] = ["manifest.json"];
  for (const [dir, re] of TARGETS) {
    const p = path.join(DATA, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p).filter((x) => re.test(x)).sort()) files.push(`${dir}/${f}`);
  }
  let uploaded = 0;
  let baseUrl = "";
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(DATA, rel));
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    if (!all && ledger[rel] === hash) continue;
    const res = await put(rel, buf, {
      access: "public",
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: rel.endsWith(".gz") ? "application/gzip" : "application/json",
    });
    baseUrl = res.url.slice(0, res.url.length - rel.length - 1);
    ledger[rel] = hash;
    uploaded += 1;
    console.log(`↑ ${rel} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
  }
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`업로드 ${uploaded}개${baseUrl ? ` — 기준 URL(KVD_BLOB_BASE_URL): ${baseUrl}` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
