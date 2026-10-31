import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { searchCompanies } from "../common/stock-code-resolver";
import { handleApiError } from "../utils/error-handler";

const SearchStockInputSchema = z.object({
  query: z.string()
    .min(1, "검색어를 입력해주세요")
    .max(100, "검색어가 너무 깁니다")
    .describe("종목명 또는 종목코드 (예: '삼성전자', '005930', '삼성')"),
  response_format: z.enum(["markdown", "json"])
    .default("markdown")
    .describe("출력 형식: markdown 또는 json"),
}).strict();

type SearchStockInput = z.infer<typeof SearchStockInputSchema>;

/** 시장 구분은 data/company-industry.json(주간 갱신)에서 읽는다 */
let markets: Record<string, { market?: string }> | null = null;
function marketOf(code: string): string {
  if (!markets) {
    const p = path.resolve(process.cwd(), "data/company-industry.json");
    markets = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  }
  return markets![code]?.market ?? "";
}

export function registerSearchStockTool(server: McpServer): void {
  server.registerTool(
    "search_stock",
    {
      title: "종목코드 검색",
      description: `종목명 또는 종목코드로 한국 상장 종목을 검색합니다. (OpenDART 고유번호 목록 기준, 외부 호출 없음)

다른 도구(valuation_get_data, dart_get_financials, compute_beta 등)에서 사용할 종목코드를 찾을 때 유용합니다.

Args:
  - query (string): 종목명 또는 종목코드 (예: '삼성전자', '삼성', '005930')
  - response_format ('markdown' | 'json'): 출력 형식 (기본: markdown)

Examples:
  - 삼성 관련 종목 검색: query="삼성"
  - 현대차 검색: query="현대자동차"
  - 코드로 검색: query="005930"`,
      inputSchema: SearchStockInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: SearchStockInput) => {
      try {
        const stocks = searchCompanies(params.query, 20, true)
          .filter((e) => e.stock_code)
          .map((e) => {
            const code = e.stock_code.padStart(6, "0");
            return { code, name: e.corp_name, market: marketOf(code), corpCode: e.corp_code };
          });

        if (stocks.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `'${params.query}'에 해당하는 상장 종목이 없습니다. 정식 회사명(예: 현대자동차)으로 다시 검색해 보세요.`,
            }],
          };
        }

        let text: string;
        if (params.response_format === "json") {
          text = JSON.stringify(stocks, null, 2);
        } else {
          const lines = [`## 종목 검색 결과: '${params.query}'`, "", `총 ${stocks.length}건`, ""];
          lines.push("| 종목코드 | 종목명 | 시장 | DART 고유번호 |");
          lines.push("|---------|--------|------|------|");
          for (const s of stocks) {
            lines.push(`| ${s.code} | ${s.name} | ${s.market || "-"} | ${s.corpCode} |`);
          }
          text = lines.join("\n");
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );
}
