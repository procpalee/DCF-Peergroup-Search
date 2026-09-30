/**
 * 이자부부채 독립 검증용 자료 — 표본 회사의 주석 원문(차입금·사채·리스 등)과 재무상태표 본문 행을 사람이 읽는 형태로 저장.
 * 검증자(사람·에이전트)는 엔진 결과를 보지 않고 이 자료만으로 이자부부채를 산정한다.
 *
 *   npx tsx scripts/ibd-notes.ts 20260630 005930 000660 …     # 종목 지정
 *   npx tsx scripts/ibd-notes.ts 20260630 @codes.txt            # 파일(한 줄에 종목코드 하나)
 *
 * 입력: scripts/_scratch/ibd-corpus/{기준일}.index.json + _shared/raw 원자료 (scripts/ibd-corpus.ts)
 * 출력: scripts/_scratch/ibd-corpus/notes/{종목코드}.bs.md    — 재무상태표 부채 구역 본문 행(표시 순서·표준계정ID·금액)
 *       scripts/_scratch/ibd-corpus/notes/{종목코드}.debt.md  — 차입·사채·리스·금융부채 관련 주석 블록([연결]/[별도] 표시)
 *       scripts/_scratch/ibd-corpus/notes/{종목코드}.full.txt — 보고서 전체 평문(검색용)
 * DART 호출: 종목당 document.xml 1회(이미 있으면 건너뜀).
 */
import fs from "fs";
import path from "path";
import axios from "axios";
import AdmZip from "adm-zip";
import { DART_API_BASE } from "../src/services/opendart/constants";
import { createFsRawStore } from "../src/services/valuation/raw-store-fs";
import type { CorpusEntry } from "./ibd-corpus";

for (const envFile of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "scripts/_scratch/ibd-corpus");
const OUT = path.join(DIR, "notes");

/** 표를 | 구분 행으로 바꾼 평문 */
function toPlain(xml: string): string {
  const cell = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
  return xml
    // DART 문서의 표 행 — 칸(TD·TH·TE·TU) 안의 줄바꿈·태그를 걷어 한 행 = 한 줄 "| a | b |"
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
      const cells = [...row.matchAll(/<(t[dheu])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => cell(c[2]));
      return `\n| ${cells.join(" | ")} |\n`;
    })
    .replace(/<\/(p|div|br|li|h[1-6]|title|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DEBT_HEAD = /(차입금|사채|리스|금융부채|차입부채|유동화|기업어음|전환|신종자본|상환우선주|우선주부채|재무활동)/;
/** 주석 번호 제목 줄(최상위): "15. 차입금", "15 . 리스" 등 — "(1) 단기차입금"·"2) 외화사채" 같은 하위 제목은 블록을 열거나 끊지 않는다 */
const NOTE_HEAD = /^\s*(\d{1,2})\s*\.\s*([가-힣A-Za-z][^|\n]{0,44})$/;

function extractDebtBlocks(text: string): string {
  const lines = text.split("\n");
  // 연결/별도 주석 구간 표시 — 가장 최근에 나온 "연결재무제표 주석" / "재무제표 주석" 머리
  let scope = "?";
  const out: string[] = [];
  let cur: { head: string; num: string; scope: string; body: string[] } | null = null;
  const flush = () => {
    if (cur && cur.body.join("\n").length > 80) {
      const body = cur.body.join("\n");
      out.push(`\n\n===== [${cur.scope}] ${cur.head} =====\n${body.length > 20000 ? body.slice(0, 20000) + "\n…(이하 생략 — full.txt 참조)" : body}`);
    }
    cur = null;
  };
  for (const ln of lines) {
    const t = ln.trim();
    if (/^\d*\s*\.?\s*연\s*결\s*재\s*무\s*제\s*표\s*주\s*석/.test(t)) scope = "연결";
    else if (/^\d*\s*\.?\s*재\s*무\s*제\s*표\s*주\s*석/.test(t)) scope = "별도";
    const m = t.match(NOTE_HEAD);
    if (m) {
      if (cur && m[1] !== cur.num) flush();
      if (!cur && DEBT_HEAD.test(m[2])) {
        cur = { head: t, num: m[1], scope, body: [] };
        continue;
      }
    }
    if (cur) cur.body.push(ln);
  }
  flush();
  return out.join("");
}

async function main() {
  const args = process.argv.slice(2);
  const asOf = args.find((a) => /^\d{8}$/.test(a)) ?? "20260630";
  let codes = args.filter((a) => /^[0-9A-Z]{6}$/.test(a));
  for (const a of args.filter((x) => x.startsWith("@")))
    codes.push(...fs.readFileSync(a.slice(1), "utf8").split(/\s+/).filter((x) => /^[0-9A-Z]{6}$/.test(x)));
  codes = [...new Set(codes)];
  const key = process.env.OPENDART_API_KEY;
  if (!key) throw new Error("OPENDART_API_KEY 필요");
  const index: CorpusEntry[] = JSON.parse(fs.readFileSync(path.join(DIR, `${asOf}.index.json`), "utf8"));
  const byCode = new Map(index.map((e) => [e.code, e]));
  const store = createFsRawStore();
  fs.mkdirSync(OUT, { recursive: true });

  for (const code of codes) {
    const en = byCode.get(code);
    if (!en) {
      console.error(`${code}: 코퍼스에 없음`);
      continue;
    }
    const raw = store.get(en.rceptNo);
    const rcept = raw?.rceptNoReturned ?? en.rceptNo;
    // 재무상태표 본문(부채·자본 구역 전체 — 구역 판단을 검증자가 직접 하도록 전부 준다)
    if (raw) {
      const bs = raw.items.filter((i) => i.sj_div === "BS").sort((a, b) => Number(a.ord) - Number(b.ord));
      const rows = bs.map((i) => `| ${i.ord} | ${i.account_nm.trim()} | ${i.account_id} | ${i.thstrm_amount} |`);
      fs.writeFileSync(
        path.join(OUT, `${code}.bs.md`),
        `# ${en.name} (${code}) 재무상태표 — ${en.reportName}, ${raw.fsDiv === "CFS" ? "연결" : "별도"}, 접수번호 ${rcept}\n` +
          `단위: 원. 열: 표시순서 | 계정명 | 표준계정ID | 당기말 금액\n\n| ord | 계정명 | 계정ID | 금액 |\n|---|---|---|---|\n${rows.join("\n")}\n`,
      );
    }
    // 원문 zip 은 보관해 두고(추출 규칙을 고쳐도 다시 받지 않게) 평문은 매번 새로 만든다
    const zipPath = path.join(OUT, `${code}.doc.zip`);
    if (!fs.existsSync(zipPath)) {
      try {
        const res = await axios.get(`${DART_API_BASE}/document.xml`, {
          params: { crtfc_key: key, rcept_no: rcept },
          responseType: "arraybuffer",
          timeout: 90000,
        });
        if (res.data.length < 1000) {
          const msg = Buffer.from(res.data).toString("utf8");
          if (/020|사용한도/.test(msg)) {
            console.error("DART 한도 초과 — 중단");
            process.exit(2);
          }
          console.error(`${code}: 원문 없음 (${msg.slice(0, 120)})`);
          continue;
        }
        fs.writeFileSync(zipPath, Buffer.from(res.data));
      } catch (e) {
        console.error(`${code}: 원문 받기 실패 ${(e as Error).message}`);
        continue;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    const text = new AdmZip(zipPath)
      .getEntries()
      .filter((e) => e.entryName.toLowerCase().endsWith(".xml"))
      .map((e) => `\n\n######## ${e.entryName}\n` + toPlain(e.getData().toString("utf8")))
      .join("");
    fs.writeFileSync(path.join(OUT, `${code}.full.txt`), text);
    const blocks = extractDebtBlocks(text);
    fs.writeFileSync(
      path.join(OUT, `${code}.debt.md`),
      `# ${en.name} (${code}) 차입·사채·리스 관련 주석 발췌 — ${en.reportName}, 접수번호 ${rcept}\n` +
        `재무제표 구분: ${raw?.fsDiv === "OFS" ? "별도(연결 없음)" : "연결 — [연결] 블록을 기준으로 볼 것"}\n` +
        `발췌가 부족하면 ${code}.full.txt 를 검색할 것.${blocks}\n`,
    );
    console.log(`${code} ${en.name}: 주석 발췌 ${blocks.length.toLocaleString()}자`);
  }
}

main();
