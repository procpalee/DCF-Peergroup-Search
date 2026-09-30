import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchBusinessContent } from "../opendart/document-parser";
import { resolveCorpCode } from "../common/stock-code-resolver";
import { readDataJson } from "../cache/data-files";

const BusinessContentInputSchema = z.object({
  stock_code: z.string().describe("종목코드 6자리 (예: 005930)"),
  year: z.string().describe("대상 사업연도 (예: 2024)")
});

// 연도별 캐시 인메모리 보관 (cold start에서 1회 로딩, 이후 O(1) lookup) — 번들 → Vercel Blob 순
const cacheMemo = new Map<string, Promise<Record<string, string> | null>>();

function loadYearCache(year: string): Promise<Record<string, string> | null> {
  let p = cacheMemo.get(year);
  if (!p) {
    p = readDataJson<Record<string, string>>(`business-cache/${year}.json.gz`, `business-cache/${year}.json`);
    cacheMemo.set(year, p);
  }
  return p;
}

export function registerBusinessContentTool(server: McpServer): void {
  server.registerTool(
    "get_business_content",
    {
      title: "사업보고서 제품/서비스 원문 추출",
      description: `특정 기업의 사업보고서 원본에서 "II. 사업의 내용 / 주요 제품 및 서비스" 섹션의 텍스트와 표(Markdown)를 추출합니다.
이 도구는 기업이 무엇을 통해 돈을 버는지, 어떤 제품의 매출 비중이 높은지 분석해야 할 때 사용합니다.

[⚠️ AI를 위한 엄격한 year 파라미터 규칙]
- year 는 "사업연도(결산 기준연도)"입니다. "보고서 제출연도"가 아닙니다.
- valuation_date(평가기준일)가 주어졌다면, year 는 반드시 valuation_date 의 연도와 동일해야 합니다.
  예: 평가기준일 20251231 → year="2025" (2025.12말 결산 사업보고서)
  예: 평가기준일 20241231 → year="2024" (2024.12말 결산 사업보고서)
- 관습적으로 "작년 사업보고서"를 조회하려 하지 마세요. 캐시는 최신 사업연도 기준으로 채워져 있습니다.
- 평가기준일을 모르면 현재 연도(2025 또는 그 이상)를 우선 시도하세요.

[주의점]
- 텍스트 정보가 긴 편이므로 전체 재무 지표를 뽑는 valuation_get_data 툴과 혼합 사용은 지양하고 필요할 때만 단독 호출하세요.

[Peer 워크플로우 Step 3]
Peer Group 선정 시 이 도구는 "후보군의 주요 제품/서비스가 피평가 기업과 실제로 겹치는지" 정성 필터링 용도로 씁니다. 한 번에 한 종목씩 호출하세요 (본문이 20~40KB라 배치 호출 시 컨텍스트 폭발). 정성 필터링이 끝난 후에는 확정 Peer 리스트로 valuation_get_data 를 한 번만 배치 호출하세요. 상세는 docs/PEER_GROUP_WORKFLOW.md 참조.`,
      inputSchema: BusinessContentInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: z.infer<typeof BusinessContentInputSchema>) => {
      try {
        // 1. 오프라인 캐시 우선 (gzipped JSON, cold start에서 1회만 로드)
        const cacheData = await loadYearCache(params.year);
        if (cacheData && cacheData[params.stock_code]) {
          return { content: [{ type: "text" as const, text: cacheData[params.stock_code] }] };
        }

        // 2. 캐시 miss → 실시간 다운로드 폴백
        const corpCode = await resolveCorpCode(params.stock_code);
        if (!corpCode) {
          return { content: [{ type: "text" as const, text: "해당 종목을 찾을 수 없거나 DART 고유번호 매핑에 실패했습니다." }] };
        }

        const markdown = await fetchBusinessContent(corpCode, params.year);
        return { content: [{ type: "text" as const, text: markdown }] };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: `Data Fetch Error: ${error.message}` }], isError: true };
      }
    }
  );
}
