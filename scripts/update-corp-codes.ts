/**
 * Corp code updater script
 * Downloads the full corporate registry from OpenDART API and saves as JSON.
 *
 * Usage:
 *   OPENDART_API_KEY=your_key npx tsx scripts/update-corp-codes.ts
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

// Load .env.local if present
for (const envFile of [".env.local", ".env"]) {
  const envPath = join(process.cwd(), envFile);
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

const API_KEY = process.env.OPENDART_API_KEY;
if (!API_KEY) {
  console.error("Error: OPENDART_API_KEY environment variable is required.");
  console.error("Usage: OPENDART_API_KEY=your_key npx tsx scripts/update-corp-codes.ts");
  process.exit(1);
}

// GitHub 러너(해외)에서는 한국 업무 시간대에 다운로드가 2분을 넘기기도 해서
// 한 번에 5분까지 기다리고, 시간 초과·네트워크 오류·5xx 는 간격을 늘려 다시 받는다.
const DOWNLOAD_TIMEOUT_MS = 300_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

class FatalHttpError extends Error {}

async function downloadOnce(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    const msg = `HTTP error: ${response.status} ${response.statusText}`;
    // 4xx(키 오류 등)는 다시 받아도 같으므로 바로 끝낸다
    if (response.status < 500) throw new FatalHttpError(msg);
    throw new Error(msg);
  }
  return response.arrayBuffer();
}

async function downloadWithRetry(url: string): Promise<ArrayBuffer> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const buffer = await downloadOnce(url);
      console.log(`Download finished in ${((Date.now() - started) / 1000).toFixed(1)}s (attempt ${attempt})`);
      return buffer;
    } catch (err) {
      if (err instanceof FatalHttpError) throw err;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (delay === undefined) throw err;
      console.warn(`Attempt ${attempt} failed after ${((Date.now() - started) / 1000).toFixed(1)}s (${reason}); retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main() {
  console.log("Downloading corp code ZIP from OpenDART...");

  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${API_KEY}`;
  const buffer = await downloadWithRetry(url);
  const uint8 = new Uint8Array(buffer);

  if (uint8[0] !== 0x50 || uint8[1] !== 0x4b) {
    const text = new TextDecoder("utf-8").decode(uint8.slice(0, 500));
    console.error("Response is not a ZIP file:", text);
    process.exit(1);
  }

  console.log(`Downloaded ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB ZIP`);

  const unzipped = unzipSync(uint8);
  const fileNames = Object.keys(unzipped);
  const xmlFileName = fileNames.find((f) => f.toLowerCase().endsWith(".xml")) || fileNames[0];

  if (!xmlFileName) {
    console.error("No XML file found in ZIP. Files:", fileNames);
    process.exit(1);
  }

  const rawBytes = unzipped[xmlFileName];
  console.log(`Extracted ${xmlFileName} (${(rawBytes.length / 1024 / 1024).toFixed(1)}MB)`);

  const asciiPreview = new TextDecoder("ascii").decode(rawBytes.slice(0, 200));
  const encMatch = asciiPreview.match(/encoding=["']([^"']+)["']/i);
  const detectedEnc = encMatch?.[1].toLowerCase() ?? "utf-8";
  console.log(`Detected encoding: ${detectedEnc}`);

  const decoder = new TextDecoder(
    detectedEnc === "euc-kr" || detectedEnc === "cp949" ? "euc-kr" : "utf-8"
  );
  const xml = decoder.decode(rawBytes);

  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    isArray: (name) => name === "list",
  });
  const parsed = parser.parse(xml);

  const rawList = parsed?.result?.list || parsed?.list || [];
  const entries = rawList
    .map((item: Record<string, unknown>) => ({
      corp_code: String(item.corp_code || "").trim().padStart(8, "0"),
      corp_name: String(item.corp_name || "").trim(),
      stock_code: String(item.stock_code || "").trim() || "",
      modify_date: String(item.modify_date || "").trim(),
    }))
    .filter((e: { corp_name: string }) => e.corp_name.length > 0);

  console.log(`Parsed ${entries.length} companies`);

  const listedCount = entries.filter((e: { stock_code: string }) => e.stock_code).length;
  console.log(`  Listed (with stock code): ${listedCount}`);
  console.log(`  Unlisted: ${entries.length - listedCount}`);

  const outputPath = join(process.cwd(), "data", "corp-codes.json");
  writeFileSync(outputPath, JSON.stringify(entries));
  const fileSize = (Buffer.byteLength(JSON.stringify(entries)) / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${outputPath} (${fileSize}MB)`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
