import fs from "fs";
import path from "path";
import type { NextConfig } from "next";

/**
 * 서버리스 함수 번들에 넣을 data/ 캐시 파일.
 * (동적 경로로 읽는 파일은 NFT 가 추적하지 못하므로 전부 명시해야 함)
 *
 * KVD_BLOB_BASE_URL 이 설정된 빌드는 최근 분기만 번들에 넣고, 나머지는 런타임에
 * Vercel Blob 에서 받는다(src/services/cache/data-files.ts). 설정 전에는 전부 넣는다.
 */
function recent(dir: string, re: RegExp, keep: number): string[] {
  const p = path.join(process.cwd(), "data", dir);
  if (!fs.existsSync(p)) return [];
  const files = fs.readdirSync(p).filter((f) => re.test(f)).sort();
  return files.slice(-keep).map((f) => `./data/${dir}/${f}`);
}

const blob = !!process.env.KVD_BLOB_BASE_URL;
const dataFiles = [
  "./data/corp-codes.json",
  "./data/company-industry.json",
  "./data/manifest.json",
  ...(blob
    ? [
        ...recent("valuation-cache", /^\d{8}\.json$/, 4),
        ...recent("peer-snapshot", /^\d{8}\.json\.gz$/, 2),
        ...recent("business-cache", /^\d{4}\.json\.gz$/, 1),
      ]
    : ["./data/business-cache/**/*.gz", "./data/valuation-cache/*.json", "./data/peer-snapshot/*.gz"]),
];

const nextConfig: NextConfig = {
  // MCP 서버 전용 — 페이지 없음.
  outputFileTracingIncludes: {
    "/api/*": dataFiles,
  },
};

export default nextConfig;
