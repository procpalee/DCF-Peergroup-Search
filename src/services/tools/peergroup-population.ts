import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import crypto from "crypto";
import {
  getAvailableSnapshotDates,
  loadPeerSnapshot,
  resolveSnapshotDate,
  type PeerSnapshotCompany,
} from "../cache/peer-snapshot";
import { getIndustryName } from "../opendart/ksic-codes";
import { handleApiError } from "../utils/error-handler";

// ─── 스키마 ───

const PeergroupPopulationSchema = z
  .object({
    valuation_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe("평가기준일 YYYYMMDD. 분기말(0331/0630/0930/1231) 권장 — 기준일 이하 최근 분기말 스냅샷으로 해석됩니다"),
    industry_code: z
      .string()
      .regex(/^\d{1,5}$/)
      .describe("KSIC 업종코드 접두. 자릿수가 곧 매칭 깊이 (예: '264' → 264로 시작하는 전체, '26429' → 정확 일치)"),
    include_content: z
      .boolean()
      .default(false)
      .describe("false: 모집단 로스터만(경량, 기본). true: 사업의 개요+부문별 매출 포함(page 단위)"),
    content_mode: z
      .enum(["summary", "full"])
      .default("summary")
      .describe(
        "include_content=true일 때 본문 형태. summary(기본): 스냅샷에 고정 저장된 개요 요약(3~4문장)+부문별 매출 요약(최근 기수 금액·비중 한 줄) — 경량·유사성 판단용. full: 섹션 원문(max_section_chars 절단)"
      ),
    page: z.number().int().min(1).default(1).describe("include_content=true일 때 페이지 번호"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("include_content=true일 때 페이지당 종목 수 (기본 5, 최대 10)"),
    max_section_chars: z
      .number()
      .int()
      .min(500)
      .max(20000)
      .default(3000)
      .describe("섹션(개요/매출)당 최대 문자수. 초과분은 절단"),
    market: z.enum(["ALL", "KOSPI", "KOSDAQ"]).default("ALL").describe("시장 필터"),
  })
  .strict();

type PeergroupPopulationInput = z.infer<typeof PeergroupPopulationSchema>;

// ─── 헬퍼 ───

function truncate(text: string | null, maxChars: number): string | null {
  if (text === null) return null;
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[이하 생략]" : text;
}

function rosterEntry(code: string, c: PeerSnapshotCompany) {
  return {
    code,
    name: c.name,
    market: c.market,
    industryCode: c.industryCode,
    industryName: getIndustryName(c.industryCode),
    flags: {
      isSpac: c.flags.isSpac,
      isHolding: c.flags.isHolding,
      isReit: c.flags.isReit,
      fiscalMonthNot12: c.flags.fiscalMonthNot12,
      isAdministrative: c.flags.isAdministrative,
    },
  };
}

// ─── 도구 등록 ───

export function registerPeergroupPopulationTool(server: McpServer): void {
  server.registerTool(
    "peergroup_get_population",
    {
      title: "Peer Group 모집단 조회 (결정론적)",
      description: `(평가기준일, 업종코드) 입력에 대해 항상 동일한 Peer 모집단을 반환합니다. 분기말 스냅샷 캐시만 사용하며 라이브 조회로 폴백하지 않으므로, 같은 입력이면 언제 실행해도 같은 결과가 나옵니다 (감사조서 재현성 보장).

[결정론 규칙]
- 평가기준일 이하 중 가장 최근 분기말 스냅샷으로 해석 (응답 meta.snapshotDate 로 echo)
- 업종 매칭: industryCode 가 industry_code 로 시작하는 종목 (접두 자릿수 = 매칭 깊이)
- 정렬: 종목코드 오름차순 고정
- meta.populationHash: 모집단 종목코드의 sha256 앞 12자 — 조서에 snapshotDate 와 함께 기록하면 사후 재현 검증 가능

[2-phase 사용법 — Peer 워크플로우 Step 2]
- Step 2a (include_content=false, 기본): 모집단 로스터 전체 + 배제판단 플래그(스팩/지주사/리츠/12월외결산/관리종목). 여기서 1차 배제를 판단하고 populationHash 를 기록하세요.
- Step 2b (include_content=true): page 단위로 각 종목의 사업내용을 받아 피평가 기업과의 사업 유사성을 정성 판단하세요. 기본 content_mode="summary"는 스냅샷에 고정 저장된 개요 요약(3~4문장)+매출실적 표 발췌를 반환합니다(경량·재현 가능). 원문이 필요하면 content_mode="full". 페이지당 5종목 기본 — page 를 올려가며 모집단 전체를 순회합니다.
- 최종 확정 Peer 는 valuation_get_data 로 배치 조회. 원문 전체가 필요한 최종 후보 2~3개만 get_business_content 사용.

[관련 도구]
- 업종코드를 모르면 search_by_industry 로 키워드→코드를 먼저 해석하세요.
- 각 종목의 flags 는 배제 "판단 재료"입니다 — 자동 배제하지 말고 평가 목적에 따라 판단하세요.

상세는 docs/PEER_GROUP_WORKFLOW.md 참조.`,
      inputSchema: PeergroupPopulationSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: PeergroupPopulationInput) => {
      try {
        // 1. 스냅샷 floor 해석 (라이브 폴백 없음)
        const snapshotDate = await resolveSnapshotDate(params.valuation_date);
        if (!snapshotDate) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `평가기준일 ${params.valuation_date} 이전의 스냅샷이 없습니다.`,
                  availableSnapshotDates: await getAvailableSnapshotDates(),
                }),
              },
            ],
            isError: true,
          };
        }
        const snapshot = await loadPeerSnapshot(snapshotDate);
        if (!snapshot) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `스냅샷 파일 로드 실패: ${snapshotDate}`,
                  availableSnapshotDates: await getAvailableSnapshotDates(),
                }),
              },
            ],
            isError: true,
          };
        }

        // 2. 결정론적 모집단: 접두 매칭 + 시장 필터 + 종목코드 오름차순
        const population = Object.entries(snapshot.companies)
          .filter(([, c]) => c.industryCode.startsWith(params.industry_code))
          .filter(([, c]) => params.market === "ALL" || c.market === params.market)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

        const populationHash = crypto
          .createHash("sha256")
          .update(population.map(([code]) => code).join(","))
          .digest("hex")
          .slice(0, 12);

        const meta = {
          snapshotDate,
          valuationDate: params.valuation_date,
          industryPrefix: params.industry_code,
          industryPrefixName: getIndustryName(params.industry_code),
          market: params.market,
          total: population.length,
          populationHash,
          snapshotBuiltAt: snapshot._meta.builtAt,
          notes: snapshot._meta.notes,
        };

        // 3-a. 로스터 (경량)
        if (!params.include_content) {
          const result = {
            meta,
            companies: population.map(([code, c]) => rosterEntry(code, c)),
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }

        // 3-b. 콘텐츠 페이지
        const totalPages = Math.max(1, Math.ceil(population.length / params.page_size));
        const start = (params.page - 1) * params.page_size;
        const pageItems = population.slice(start, start + params.page_size);
        const result = {
          meta: {
            ...meta,
            page: params.page,
            pageSize: params.page_size,
            totalPages,
            nextPage: params.page < totalPages ? params.page + 1 : null,
          },
          companies: pageItems.map(([code, c]) => {
            // summary 모드: 스냅샷에 1회 생성 후 고정 저장된 요약 필드 사용 (없으면 원문 폴백)
            const useSummary = params.content_mode === "summary";
            const overview = useSummary
              ? c.overviewSummary ?? truncate(c.overview, params.max_section_chars)
              : truncate(c.overview, params.max_section_chars);
            const segments = useSummary
              ? c.segmentsSummary ?? c.segmentsBrief ?? truncate(c.segments, params.max_section_chars)
              : truncate(c.segments, params.max_section_chars);
            const notes: string[] = [];
            if (c.overview === null) {
              notes.push("개요 추출 실패 종목 — 원문 확인이 필요하면 get_business_content 를 사용하세요");
            } else if (useSummary && c.overviewSummary == null) {
              notes.push("요약 미생성 스냅샷 — 개요는 원문 절단본");
            }
            return {
              ...rosterEntry(code, c),
              report: c.report,
              contentMode: params.content_mode,
              overview,
              segments,
              segmentsSource: c.flags.segmentsSource,
              contentNote: notes.length ? notes.join(" / ") : undefined,
            };
          }),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );
}
