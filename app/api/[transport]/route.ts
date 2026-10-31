import { createMcpHandler } from "mcp-handler";
import { registerSearchStockTool } from "@/services/tools/search-stock";
import { registerDartCompanyTool } from "@/services/tools/dart-company";
import { registerDartFinancialsTool } from "@/services/tools/dart-financials";
import { registerNaverMarketDataTool } from "@/services/tools/naver-market-data";
import { registerValuationDataTool } from "@/services/tools/valuation-data";
import { registerSearchByIndustryTool } from "@/services/tools/search-by-industry";
import { registerBusinessContentTool } from "@/services/tools/business-content";
import { registerComputeBetaTool } from "@/services/tools/compute-beta";
import { registerPeergroupPopulationTool } from "@/services/tools/peergroup-population";

/**
 * 네이버 금융 도구는 자체 호스팅(내 PC 등)에서만 켠다. 네이버 약관이 자동 수집을 금지하므로
 * 공개 배포에서는 KVD_ENABLE_NAVER 를 설정하지 않는다.
 */
const NAVER_ENABLED = process.env.KVD_ENABLE_NAVER === "1";

const mcpHandler = createMcpHandler(
  (server) => {
    registerSearchStockTool(server);

    // OpenDART
    registerDartCompanyTool(server);
    registerDartFinancialsTool(server);

    // 통합 밸류에이션 (재무 캐시 + 이용자 키 시세)
    registerValuationDataTool(server);

    // 업종별 상장사 검색
    registerSearchByIndustryTool(server);

    // 사업보고서 원문 마크다운 추출
    registerBusinessContentTool(server);

    // 베타 직접 계산 (이용자 키 시세)
    registerComputeBetaTool(server);

    // Peer 모집단 결정론적 조회 (분기말 스냅샷)
    registerPeergroupPopulationTool(server);

    if (NAVER_ENABLED) registerNaverMarketDataTool(server);
  },
  {
    serverInfo: { name: "kr-valuation-data", version: "2.1.0" },
    instructions:
      "한국 상장사 밸류에이션 데이터 서버. 분기말 기준 이자부부채·현금·실적과 기준일 종가·시가총액·베타(valuation_get_data), " +
      "결정론적 Peer 모집단(peergroup_get_population), 업종 검색·사업보고서 본문을 제공한다. " +
      "재무는 평가기준일 당시 공시된 최신 정기보고서 기준이며, 사용 보고서가 응답에 표시된다. " +
      "종가·베타는 이용자 본인의 공공데이터포털 키(datagokr_key)로 조회하며, 키가 없으면 응답의 market.error 안내를 사용자에게 그대로 전달한다. " +
      "Peer 분석 순서는 docs/PEER_GROUP_WORKFLOW.md 를 따른다.",
  },
  {
    basePath: "/api",
    maxDuration: 60,
    // 상세 로그는 요청 정보를 남길 수 있어 끈다(이용자 키 보호)
    verboseLogs: false,
  }
);

/**
 * Claude 커스텀 커넥터는 헤더를 넣을 수 없어 이용자 키를 URL 쿼리(datagokr_key)로도 받는다.
 * 쿼리 값을 요청 헤더로 옮겨 도구가 요청 단위로 읽게 한다(서버 전역 상태 없음).
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("datagokr_key");
  if (!key || req.headers.has("x-datagokr-key")) return mcpHandler(req);
  const headers = new Headers(req.headers);
  headers.set("x-datagokr-key", key);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  return mcpHandler(new Request(req.url, { method: req.method, headers, body }));
}

export { handler as GET, handler as POST, handler as DELETE };
