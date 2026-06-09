# KICPA Beta MCP Server

한국공인회계사회(KICPA) CHECKExpert+ 베타계수 + OpenDART 재무 + 네이버 금융 시장데이터를 통합한 **DCF 밸류에이션 전용 웹 MCP 서버**입니다. Vercel에 배포하여 Claude for Excel, Claude Desktop, Claude Code 등 원격 MCP 클라이언트에서 바로 사용할 수 있습니다.

핵심 설계 원칙:
- **캐시 우선, 라이브 폴백**: 분기말 기준 베타·이자부부채·시가총액과 사업보고서 본문은 서버에 사전 수집되어 있어 즉시 응답. 캐시 miss 시에만 upstream API를 호출합니다.
- **Peer Group 워크플로우 친화적**: 업종 검색 → 사업 내용 정성 필터 → 통합 배치 조회가 한 번의 에이전트 세션에서 끝나도록 도구를 설계했습니다.

---

## MCP 도구

### 캐시 기반 (고성능, 토큰 최적화)

| 도구 | 설명 | 캐시 파일 |
|------|------|-----------|
| `search_by_industry` | KSIC 업종코드/키워드로 해당 업종 전 상장사 리스트 즉시 반환 | `data/company-industry.json` |
| `get_business_content` | 사업보고서 "II. 사업의 내용 / 주요 제품 및 서비스" 원문 추출 (**2,611 / 2,617 종목, 99.8% 커버**) | `data/business-cache/{year}.json.gz` |
| `valuation_get_data` | **가치평가 통합 패키지** — 베타(W/M × 1/2/3/5Y) + 이자부부채(유동/비유동) + 비지배지분 + 세전이익 + 시가총액을 한 번에. 분기말(3/31·6/30·9/30·12/31)은 100% 캐시 히트 | `data/valuation-cache/{YYYYMMDD}.json` |

### 실시간 API 조회 (최신 데이터 확보)

| 도구 | 설명 | 데이터 소스 |
|------|------|-------------|
| `search_stock` | 종목명/종목코드로 한국 주식 종목 검색 | 네이버 금융 자동완성 |
| `dart_get_company` | DART 기업 기본정보 조회 (대표자, 업종, 설립일 등) | OpenDART |
| `dart_get_financials` | 분기/반기 보고서, 전체 재무제표, 개별(OFS) 조회 등 특수 케이스 | OpenDART |
| `compute_beta` | **베타 직접 계산** — 네이버 수정주가 + KOSPI 지수 회귀로 Weekly-2Y/Monthly-5Y 산출. 과거 KICPA 공식값과 소수점 6자리 일치. (KICPA/KOSCOM 조회는 영구 장애로 제거됨) | 네이버 금융 |
| `naver_get_market_data` | 실시간 주가·시가총액·PER·PBR·컨센서스 목표가·동종업종 기업 | 네이버 금융 |

👉 **Peer Group 분석 워크플로우**는 [`docs/PEER_GROUP_WORKFLOW.md`](docs/PEER_GROUP_WORKFLOW.md) 참조 — 에이전트가 언제 어떤 도구를 어떤 순서로 호출해야 하는지 정규 시퀀스가 정리되어 있습니다.

---

## 주요 기술적 특징

- **회사별 XBRL Taxonomy 차이 극복**: 계정 ID 화이트리스트가 아니라 `LiabilitiesArisingFromFinancingActivitiesAxis` + `ClassesOfFinancialLiabilitiesAxis` 같은 표준 Axis에서 멤버를 키워드 기반으로 분류하는 방식으로 이자부부채를 추출합니다. 연결재무제표 우선, 별도재무제표로 자동 폴백. Axis 경로가 실패해도 계정 기반 경로로 재시도하는 다층 방어선 구조.
- **사업보고서 파싱 99.8% 커버리지**: DART document.xml ZIP 내 모든 XML 파트를 순회하며 점수 기반으로 본문 섹션을 선택. 목차(TOC) 오인식 회피, 태그 사이에 끼어든 문자열 처리, 정정공시 자동 폴백 포함.
- **146MB 캐시를 Vercel 서버리스로 배포**: gzip(44.9MB) 커밋 + `outputFileTracingIncludes`로 함수 번들에 포함 + cold start에서 1회 해제 후 메모리 메모이즈.
- **에이전트 파라미터 오해 방지**: 도구 description에 `[⚠️ AI를 위한 엄격한 파라미터 규칙]` 블록으로 `year` vs `valuation_date` 관계 등을 명시.

---

## 기술 스택

- **Next.js 15** + **mcp-handler** (Streamable HTTP transport)
- **Vercel** 배포 (서버리스)
- **MCP SDK** `@modelcontextprotocol/sdk ^1.26.0`
- **MCP 엔드포인트**: `POST /api/mcp`
- **언어**: TypeScript (strict, ESM, Node ≥18)

---

## 프로젝트 구조

```
├── app/api/[transport]/route.ts   # MCP 핸들러 (도구 등록)
├── src/services/
│   ├── tools/                     # MCP 도구 정의
│   │   ├── compute-beta.ts        # compute_beta (네이버+KOSPI 직접계산)
│   │   ├── search-stock.ts        # search_stock
│   │   ├── search-by-industry.ts  # search_by_industry
│   │   ├── dart-company.ts        # dart_get_company
│   │   ├── dart-financials.ts     # dart_get_financials
│   │   ├── naver-market-data.ts   # naver_get_market_data
│   │   ├── business-content.ts    # get_business_content
│   │   └── valuation-data.ts      # valuation_get_data
│   ├── kicpa/                     # KICPA/KOSCOM 세션 & 베타 API
│   ├── opendart/                  # OpenDART 클라이언트 + XBRL IBD 파서
│   ├── naver/                     # 네이버 금융 스크래퍼
│   ├── cache/                     # valuation-cache 로더
│   ├── common/                    # 종목코드 ↔ corp_code 리졸버
│   └── utils/                     # 에러 핸들러, 포맷터
├── data/
│   ├── corp-codes.json            # DART 기업코드 매핑
│   ├── company-industry.json      # 종목 ↔ KSIC 업종 매핑
│   ├── business-cache/            # 사업보고서 본문 (.json.gz, 커밋됨)
│   └── valuation-cache/           # 분기말 밸류에이션 데이터
├── docs/
│   └── PEER_GROUP_WORKFLOW.md     # 에이전트용 워크플로우 가이드
├── scripts/
│   ├── update-corp-codes.ts       # DART corp_code 동기화
│   ├── collect-business-cache.ts  # 사업보고서 본문 수집
│   └── collect-valuation-cache.ts # 분기말 밸류에이션 캐시 수집
└── next.config.ts                 # outputFileTracingIncludes 로 캐시 파일 번들링
```

---

## 로컬 개발

```bash
npm install
npm run dev
```

서버가 `http://localhost:3000`에서 실행됩니다.

### MCP 테스트

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

### 캐시 재생성

```bash
# 사업보고서 본문 (수 시간 소요, DART rate limit 준수)
npx tsx scripts/collect-business-cache.ts

# 분기말 밸류에이션 스냅샷
npx tsx scripts/collect-valuation-cache.ts

# DART corp_code 매핑 동기화
npx tsx scripts/update-corp-codes.ts
```

---

## Vercel 배포

### 1. GitHub에 push 후 Vercel에서 import

Vercel Dashboard에서 **New Project** → GitHub 저장소 선택 → 자동 빌드/배포

### 2. 환경변수 설정

Vercel Dashboard → **Settings** → **Environment Variables**에서 아래 변수를 설정합니다.

| 변수명 | 값 |
|--------|-----|
| `OPENDART_API_KEY` | OpenDART API 키 ([발급](https://opendart.fss.or.kr)) |

KICPA 베타계수는 서버가 KOSCOM 페이지에서 JSESSIONID 세션 쿠키를 자동 획득하므로 별도 인증 불필요하며, 네이버 금융도 인증이 필요 없습니다.

### 3. 배포 완료 후 MCP URL

```
https://<your-app>.vercel.app/api/mcp
```

`next.config.ts`의 `outputFileTracingIncludes` 설정으로 `data/business-cache/**/*.gz`와 `data/corp-codes.json`이 서버리스 함수 번들에 자동 포함됩니다.

---

## 클라이언트 연결

### Claude for Excel / Claude Desktop

`사용자 지정` → `커넥터` → `커스텀 커넥터 추가`에서 다음 URL 등록:

```
https://<your-app>.vercel.app/api/mcp
```

### Claude Code

```bash
claude mcp add kicpa-beta --transport http https://<your-app>.vercel.app/api/mcp
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

URL에 `https://<your-app>.vercel.app/api/mcp` 입력.

---

## 사용 예시

### Peer Group 워크플로우 (가장 대표적인 사용 시나리오)

```
005930을 피평가 기업으로 해서 반도체 업종 Peer 5개 골라서
20251231 기준 베타·이자부부채·시가총액 평균을 표로 뽑아줘.
```

에이전트는 자동으로 `search_by_industry` → `get_business_content`(후보별 순차) → `valuation_get_data`(배치) 순서로 호출합니다. 상세 흐름은 [`docs/PEER_GROUP_WORKFLOW.md`](docs/PEER_GROUP_WORKFLOW.md) 참조.

### 단일 종목 조회

- "005930의 20251231 기준 밸류에이션 데이터 뽑아줘"
- "삼성전자의 주요 제품 및 서비스 원문 보여줘"
- "005930, 000660 종목의 5년 조정베타를 엑셀 표로"
- "현대차 시가총액·PER·컨센서스 목표가 알려줘"
- "2차전지 업종 상장사 리스트 전부 뽑아줘"

---

## 베타계수 설명

| 항목 | 설명 |
|------|------|
| **실질베타 (Raw Beta)** | 회귀분석으로 산출된 원시 베타값 |
| **조정베타 (Adjusted Beta)** | `실질베타 × 2/3 + 1/3` |
| **포인트수** | 베타 산출에 사용된 데이터 포인트 수 |
| **대표지수** | 국내 KOSPI, 미국 S&P500 |

