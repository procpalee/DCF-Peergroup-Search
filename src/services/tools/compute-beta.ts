import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeBetaData } from "../beta-calc";
import type { ComputeBetaStockResult } from "../beta-calc";
import { MAX_COMPUTE_STOCKS } from "../beta-calc/constants";
import type { BetaLabel } from "../beta-calc/types";
import { handleApiError } from "../utils/error-handler";

const ComputeBetaInputSchema = z.object({
  stock_codes: z
    .array(z.string().min(1))
    .min(1, "종목코드를 최소 1개 입력해주세요")
    .max(MAX_COMPUTE_STOCKS, `종목코드는 최대 ${MAX_COMPUTE_STOCKS}개까지 가능합니다`)
    .describe("국내 종목코드 6자리 배열 (예: ['005930','000660'])"),
  base_date: z
    .string()
    .regex(/^\d{4}-?\d{2}-?\d{2}$/, "기준일은 YYYY-MM-DD 또는 YYYYMMDD 형식이어야 합니다")
    .describe("평가기준일 (YYYY-MM-DD 또는 YYYYMMDD)"),
  periods: z
    .array(z.enum(["Weekly-2Y", "Monthly-5Y"]))
    .default(["Weekly-2Y", "Monthly-5Y"])
    .describe("계산할 (주기-기간) 조합. 기본: Weekly-2Y + Monthly-5Y"),
  response_format: z
    .enum(["markdown", "json", "table"])
    .default("markdown")
    .describe("출력 형식: markdown, json, table(TSV, 엑셀 붙여넣기용)"),
}).strict();

type ComputeBetaInput = z.infer<typeof ComputeBetaInputSchema>;

export function registerComputeBetaTool(server: McpServer): void {
  server.registerTool(
    "compute_beta",
    {
      title: "베타 직접 계산 (네이버 기반, KICPA 비의존)",
      description: `네이버 금융 주가 + KOSPI 지수로 베타계수를 **직접 회귀 계산**합니다.
KICPA/KOSCOM 서버에 의존하지 않으므로 KICPA 장애 시에도 동작합니다.

[방법론]
- 수정주가 기준 주간/월간 수익률을 KOSPI 지수 수익률에 회귀(OLS)하여 실질베타를 산출
- 조정베타 = 실질베타 × 2/3 + 1/3
- Weekly-2Y(약 104주), Monthly-5Y(약 60개월) 관측치

[정확도] 검증상 005930·000660의 분기말 Weekly-2Y/Monthly-5Y 가 과거 KICPA 공식값과
소수점 6자리까지 일치했습니다. 분기말 캐시가 있으면 valuation_get_data 가 그 값을 우선 사용합니다.

Args:
  - stock_codes (string[]): 국내 종목코드 6자리 (최대 ${MAX_COMPUTE_STOCKS}개)
  - base_date (string): 평가기준일 YYYY-MM-DD 또는 YYYYMMDD
  - periods (string[]): ["Weekly-2Y","Monthly-5Y"] (기본 전체)
  - response_format ('markdown'|'json'|'table')

Examples:
  - 삼성전자 Weekly 2년 / Monthly 5년: stock_codes=["005930"], base_date="2025-09-30"
  - 삼성전자+SK하이닉스: stock_codes=["005930","000660"], base_date="20250930"`,
      inputSchema: ComputeBetaInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ComputeBetaInput) => {
      try {
        const results = await computeBetaData({
          stockCodes: params.stock_codes,
          date: params.base_date,
          periods: params.periods as BetaLabel[],
        });

        let text: string;
        if (params.response_format === "json") {
          text = JSON.stringify(results, null, 2);
        } else if (params.response_format === "table") {
          text = formatTable(results, params.periods as BetaLabel[]);
        } else {
          text = formatMarkdown(results, params.periods as BetaLabel[]);
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

function fmt(n: number | undefined, d = 6): string {
  return n === undefined || !isFinite(n) ? "-" : n.toFixed(d);
}

function formatMarkdown(results: ComputeBetaStockResult[], periods: BetaLabel[]): string {
  const parts: string[] = [];
  for (const r of results) {
    parts.push(`## ${r.stockName ?? r.stockCode} (${r.stockCode})`);
    parts.push(`기준일: ${r.baseDate} · 출처: 네이버 직접계산(KICPA 비공식 근사)`);
    if (r.error) {
      parts.push(`> ⚠️ ${r.error}`);
      parts.push("");
      continue;
    }
    parts.push("");
    parts.push("| 주기-기간 | 실질베타 | 조정베타 | R² | 관측치 N |");
    parts.push("|---|---|---|---|---|");
    for (const label of periods) {
      const b = r.results[label];
      parts.push(
        `| ${label} | ${fmt(b?.raw)} | ${fmt(b?.adjusted)} | ${fmt(b?.rSquared, 4)} | ${b?.dataPoints ?? "-"} |`
      );
    }
    parts.push("");
  }
  return parts.join("\n");
}

function formatTable(results: ComputeBetaStockResult[], periods: BetaLabel[]): string {
  const lines: string[] = ["종목코드\t종목명\t기준일\t주기-기간\t실질베타\t조정베타\tR2\t관측치N"];
  for (const r of results) {
    for (const label of periods) {
      const b = r.results[label];
      lines.push(
        [
          r.stockCode,
          r.stockName ?? "",
          r.baseDate,
          label,
          fmt(b?.raw),
          fmt(b?.adjusted),
          fmt(b?.rSquared, 4),
          b?.dataPoints ?? "",
        ].join("\t")
      );
    }
  }
  return lines.join("\n");
}
