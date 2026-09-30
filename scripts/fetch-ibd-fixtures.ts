/**
 * 이자부부채 엔진 회귀 테스트용 원자료(fixture) 수집.
 * DART fnlttSinglAcntAll(연결 우선, 없으면 별도) 응답을 종목별 JSON 으로 저장한다.
 *
 * 사용법:
 *   npx tsx scripts/fetch-ibd-fixtures.ts                 # 기본 표본 전체
 *   npx tsx scripts/fetch-ibd-fixtures.ts 000660 035720   # 지정 종목만
 *
 * 출력: tests/fixtures/ibd/{종목코드}-{연도}-{보고서코드}.json
 *       tests/fixtures/ibd/{종목코드}-{연도}-{보고서코드}.xbrl.json  (주석 차입금·리스 사실 — 연결/별도)
 */
import fs from "fs";
import path from "path";
import { resolveCorpCode } from "../src/services/common/stock-code-resolver";
import { fetchFinancials } from "../src/services/opendart/client";
import { fetchXbrlXml, parseXbrlDebtFacts } from "../src/services/opendart/xbrl-debt-facts";

for (const envFile of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}

// 문제 유형별 표본 (2026-09-30 전수 점검에서 드러난 사례 + 대형주)
export const DEFAULT_SAMPLE = [
  "005930", // 삼성전자 — 단기차입금 비표준 ID, 리스부채 본문 미표시
  "000660", // SK하이닉스 — v1 이 리스만 인식
  "035720", // 카카오 — 예수부채·보험계약부채 혼재
  "005380", // 현대차 — 금융부문 포함 대규모 사채
  "373220", // LG에너지솔루션
  "012450", // 한화에어로스페이스 — '차입금및사채'
  "034020", // 두산에너빌리티 — 판매후리스·유동화채무
  "010130", // 고려아연 — 로마숫자 머리 행
  "138040", // 메리츠금융지주 — 금융업 형태
  "105560", // KB금융 — 금융지주
  "034730", // SK — 비금융 지주(64992)
  "003550", // LG — 비금융 지주(64992)
  "106520", // 노블엠앤비 — 총액+유동성대체 이중계상 의심
  "103230", // 에스앤더블류
  "111380", // 동인기연 — '단기차입금및사채'
  "258790", // 소프트캠프 — 주식수 단위 오류
  "229640", // 엘에스에코에너지 — 주식수 단위 오류
  "051910", // LG화학
  "005490", // 포스코홀딩스
  "035420", // 네이버
  "207940", // 삼성바이오로직스
  "028260", // 삼성물산
  "015760", // 한국전력
  "377300", // 카카오페이 — 금융 관련 업종(66199)
  "068270", // 셀트리온
];

async function main() {
  const year = process.env.IBD_YEAR ?? "2025";
  const reprt = process.env.IBD_REPRT ?? "11011";
  const codes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SAMPLE;
  const outDir = path.resolve(__dirname, "../tests/fixtures/ibd");
  fs.mkdirSync(outDir, { recursive: true });
  for (const code of codes) {
    const out = path.join(outDir, `${code}-${year}-${reprt}.json`);
    const outX = path.join(outDir, `${code}-${year}-${reprt}.xbrl.json`);
    try {
      if (!fs.existsSync(out)) {
        const corp = await resolveCorpCode(code);
        const items = await fetchFinancials(corp, year, reprt, "CFS");
        // 재무상태표·손익만 보관(용량 절감)
        const keep = items.filter((i) => ["BS", "IS", "CIS"].includes(i.sj_div));
        fs.writeFileSync(out, JSON.stringify(keep));
        console.log(`${code} ${keep.length}행 저장`);
        await new Promise((r) => setTimeout(r, 700));
      }
      if (!fs.existsSync(outX)) {
        const rcept = JSON.parse(fs.readFileSync(out, "utf8"))[0]?.rcept_no;
        const xml = rcept ? await fetchXbrlXml(rcept, reprt) : null;
        const facts = xml
          ? {
              ConsolidatedMember: parseXbrlDebtFacts(xml, year, "ConsolidatedMember"),
              SeparateMember: parseXbrlDebtFacts(xml, year, "SeparateMember"),
            }
          : null;
        fs.writeFileSync(outX, JSON.stringify(facts));
        console.log(`${code} 주석 사실 ${facts ? Object.keys(facts.ConsolidatedMember).length : 0}개 저장`);
      }
    } catch (e) {
      console.error(`${code} 실패: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

main();
