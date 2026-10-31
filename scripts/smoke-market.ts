/**
 * 시세 경로 통합 테스트 — MCP 라우트를 프로세스 안에서 호출한다.
 * 공공데이터포털 키는 URL 쿼리(datagokr_key)로만 넘기고 환경변수는 지워, 요청 단위 키 전달을 검증한다.
 *
 * 사용: npx tsx --env-file=.env.local --env-file=<DATA_GO_KR_API_KEY 가 든 .env> scripts/smoke-market.ts [도구이름...]
 *       키 없이 돌리면 키 없음 안내 경로를 확인한다.
 */
const key = process.env.DATA_GO_KR_API_KEY ?? "";
delete process.env.DATA_GO_KR_API_KEY;

const CASES: Array<[string, Record<string, unknown>]> = [
  ["search_stock", { query: "카카오" }],
  ["compute_beta", { stock_codes: ["005930", "035720"], base_date: "2025-12-31" }],
  ["valuation_get_data", { stock_codes: ["005930", "035720"], valuation_date: "20250630" }],
  ["valuation_get_data", { stock_code: "005930", valuation_date: "20251015" }],
];

async function main() {
  const { POST } = await import("../app/api/[transport]/route");
  const url = `http://localhost/api/mcp${key ? `?datagokr_key=${encodeURIComponent(key)}` : ""}`;

  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    );
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text);
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  console.log("server:", init.result?.serverInfo, "key:", key ? "query" : "없음");
  const tools = await rpc("tools/list", {});
  console.log(`tools (${tools.result.tools.length}):`, tools.result.tools.map((t: { name: string }) => t.name).join(", "));

  const only = process.argv.slice(2);
  for (const [name, args] of CASES) {
    if (only.length && !only.includes(name)) continue;
    const t0 = Date.now();
    const r = await rpc("tools/call", { name, arguments: args });
    const result = r.result ?? {};
    const text: string = result.content?.[0]?.text ?? JSON.stringify(r.error);
    console.log(`\n==== ${name} ${result.isError ? "ERROR" : "ok"} (${Date.now() - t0}ms)`);
    console.log(text.length > 2500 ? text.slice(0, 2500) + `\n…(${text.length}자)` : text);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
