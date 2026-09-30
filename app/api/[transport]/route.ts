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

const handler = createMcpHandler(
  (server) => {
    registerSearchStockTool(server);

    // OpenDART (신규)
    registerDartCompanyTool(server);
    registerDartFinancialsTool(server);

    // 네이버 금융 (신규)
    registerNaverMarketDataTool(server);

    // 통합 밸류에이션 (신규)
    registerValuationDataTool(server);

    // 업종별 상장사 검색
    registerSearchByIndustryTool(server);

    // 사업보고서 원문 마크다운 추출
    registerBusinessContentTool(server);

    // 베타 직접 계산 (네이버 기반, KICPA 비의존)
    registerComputeBetaTool(server);

    // Peer 모집단 결정론적 조회 (분기말 스냅샷)
    registerPeergroupPopulationTool(server);
  },
  {
    serverInfo: { name: "kr-valuation-data", version: "2.0.0" },
    instructions:
      "한국 상장사 밸류에이션 데이터 서버. 분기말 기준 베타·이자부부채·시가총액·현금·실적(valuation_get_data), " +
      "결정론적 Peer 모집단(peergroup_get_population), 업종 검색·사업보고서 본문을 제공한다. " +
      "재무는 평가기준일 당시 공시된 최신 정기보고서 기준이며, 사용 보고서가 응답에 표시된다. " +
      "Peer 분석 순서는 docs/PEER_GROUP_WORKFLOW.md 를 따른다.",
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
