/**
 * data/manifest.json 생성 — 사용할 수 있는 기준일·연도 목록.
 * 번들에는 최근 분기만 넣고 나머지는 Vercel Blob 에 두므로(next.config.ts),
 * 런타임이 "어떤 날짜가 존재하는지"를 이 파일로 안다. 수집 후·Blob 업로드 전에 실행한다.
 *
 *   npx tsx scripts/build-data-manifest.ts
 */
import fs from "fs";
import path from "path";

const DATA = path.resolve(__dirname, "../data");

function list(dir: string, re: RegExp): string[] {
  const p = path.join(DATA, dir);
  if (!fs.existsSync(p)) return [];
  return [...new Set(fs.readdirSync(p).map((f) => f.match(re)?.[1]).filter((x): x is string => !!x))].sort();
}

const manifest = {
  generatedAt: new Date().toISOString(),
  valuationCache: list("valuation-cache", /^(\d{8})\.json$/),
  peerSnapshot: list("peer-snapshot", /^(\d{8})\.json\.gz$/),
  businessCache: list("business-cache", /^(\d{4})\.json\.gz$/),
};
fs.writeFileSync(path.join(DATA, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `manifest: 밸류에이션 ${manifest.valuationCache.length} · Peer 스냅샷 ${manifest.peerSnapshot.length} · 사업보고서 ${manifest.businessCache.length}`,
);
