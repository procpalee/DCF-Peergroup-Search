# kr-valuation-data

한국 상장사 **밸류에이션 데이터 MCP 서버**입니다(구 KICPA Beta MCP / DCF-Peergroup-Search). 네이버 주가·KOSPI 회귀 베타, OpenDART 재무(이자부부채 엔진 v2), 네이버 금융 시장데이터를 분기말 기준으로 사전 수집해 제공합니다. Vercel에 배포하여 Claude for Excel, Claude Desktop, Claude Code 등 원격 MCP 클라이언트에서 바로 사용할 수 있습니다.

핵심 설계 원칙:
- **캐시 우선, 라이브 폴백**: 분기말 기준 베타·이자부부채·시가총액·현금·실적과 사업보고서 본문은 서버에 사전 수집되어 있어 즉시 응답. 캐시 miss 시에만 같은 규칙으로 실시간 계산합니다.
- **시점 일치**: 재무는 평가기준일 당시 공시된 최신 정기보고서(예: 2025-06-30 → 2025 1분기보고서), 주가는 기준일 종가. 사용한 보고서를 응답에 표시합니다.
- **분기 자동 갱신**: GitHub Actions 가 분기말 직후 수집 → 품질 검사 → 커밋 → Vercel 배포까지 자동으로 수행합니다.
- **결정론적 Peer 모집단**: (평가기준일, 업종코드) → 항상 동일한 모집단을 반환하는 `peergroup_get_population` 은 불변 분기말 스냅샷만 사용하고 라이브로 폴백하지 않습니다. 응답의 `populationHash` 로 감사 재현성을 보장합니다.
- **Peer Group 워크플로우 친화적**: 모집단 확정(결정론) → 개요·부문별매출 정성 필터 → 통합 배치 조회가 한 번의 에이전트 세션에서 끝나도록 도구를 설계했습니다.

---

## MCP 도구

### 캐시 기반 (고성능, 토큰 최적화)

| 도구 | 설명 | 캐시 파일 |
|------|------|-----------|
| `peergroup_get_population` | **결정론적 Peer 모집단** — (평가기준일, 업종코드) → 불변 분기말 스냅샷에서 동일 모집단 반환. 종목별 사업의 개요 + 부문별 매출(2-phase 페이지네이션) + 배제판단 플래그(스팩/지주사/리츠/12월외결산/관리종목) + `populationHash`. 라이브 폴백 없음 | `data/peer-snapshot/{YYYYMMDD}.json.gz` |
| `search_by_industry` | KSIC 업종코드/키워드로 해당 업종 전 상장사 리스트 즉시 반환 (최신본, 시점 미고정 — 모집단 확정엔 위 도구 사용) | `data/company-industry.json` |
| `get_business_content` | 사업보고서 "II. 사업의 내용 / 주요 제품 및 서비스" 원문 추출 (**2,611 / 2,617 종목, 99.8% 커버**) | `data/business-cache/{year}.json.gz` |
| `valuation_get_data` | **가치평가 통합 패키지** — 베타(Weekly-2Y·Monthly-5Y) + 이자부부채(유동/비유동, 부채성 항목 분리) + 비지배지분 + 세전이익 + 시가총액 + 현금·자본·실적 + 순차입금·EV. 분기말은 캐시 히트 | `data/valuation-cache/{YYYYMMDD}.json` |

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

- **이자부부채 엔진 v2** (`src/services/opendart/ibd-engine.ts`): 재무상태표 본문 계정을 근거로, 유동/비유동은 "유동부채·비유동부채" 머리 행으로 판정합니다(계정명 부분 문자열 추측 금지). 차입금이 "금융부채"로 묶인 회사(한국전력·셀트리온 등)는 같은 보고서의 XBRL 주석 금액으로 보충하고, 할인발행차금·전환권조정은 차감, 상환전환우선주부채·신종자본증권은 부채성 항목으로 분리합니다. 금융업(은행·보험·증권·금융지주)은 산정하지 않습니다. 25개 표본 회귀 테스트(`npm run test:ibd`)로 고정.
  - v1(주석 멤버 이름 추측)은 SK하이닉스 차입금 누락, 유동/비유동 오분류 107개사 등이 있어 2026-09-30 교체했습니다.
- **주식수 검증**: DART 유통주식수를 네이버 현재 상장주식수와 대조해 단위 입력 오류(×1,000·×1,000,000)를 보정하고, 분기보고서에 주식수가 없으면 반기·직전 사업보고서로 대체합니다.
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
│   │   ├── peergroup-population.ts # peergroup_get_population (결정론적 모집단)
│   │   ├── compute-beta.ts        # compute_beta (네이버+KOSPI 직접계산)
│   │   ├── search-stock.ts        # search_stock
│   │   ├── search-by-industry.ts  # search_by_industry
│   │   ├── dart-company.ts        # dart_get_company
│   │   ├── dart-financials.ts     # dart_get_financials
│   │   ├── naver-market-data.ts   # naver_get_market_data
│   │   ├── business-content.ts    # get_business_content
│   │   └── valuation-data.ts      # valuation_get_data
│   ├── beta-calc/                 # 네이버+KOSPI 회귀 베타 직접계산
│   ├── opendart/                  # OpenDART 클라이언트 + XBRL IBD 파서 + 섹션 슬라이서
│   ├── naver/                     # 네이버 금융 스크래퍼
│   ├── kicpa/types.ts             # 베타 결과 공유 타입 (KICPA 조회 경로는 제거됨)
│   ├── cache/                     # valuation-cache / peer-snapshot 로더
│   ├── common/                    # 종목코드 ↔ corp_code 리졸버
│   └── utils/                     # 에러 핸들러, 포맷터
├── data/
│   ├── corp-codes.json            # DART 기업코드 매핑
│   ├── company-industry.json      # 종목 ↔ KSIC 업종 + 시장구분/결산월/상장일
│   ├── business-cache/            # 사업보고서 본문 (.json.gz, 커밋됨)
│   ├── valuation-cache/           # 분기말 밸류에이션 데이터
│   └── peer-snapshot/             # 분기말 Peer 모집단 스냅샷 (.json.gz, 불변)
├── docs/
│   └── PEER_GROUP_WORKFLOW.md     # 에이전트용 워크플로우 가이드
├── scripts/
│   ├── update-corp-codes.ts       # DART corp_code 동기화
│   ├── update-industry-data.ts    # 업종/시장구분 매핑 수집
│   ├── collect-business-cache.ts  # 사업보고서 본문 수집
│   ├── collect-valuation-cache.ts # 분기말 밸류에이션 캐시 수집
│   ├── collect-peer-snapshot.ts   # 분기말 Peer 모집단 스냅샷 수집
│   └── verify-beta-calc.ts        # 베타 수학 검증 (네트워크 불필요)
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
# 분기말 밸류에이션 캐시 (기준일 당시 최신 공시 기준 재무 + 기준일 종가·베타)
npx tsx scripts/collect-valuation-cache.ts 20260630            # 지정 기준일
npx tsx scripts/collect-valuation-cache.ts --latest            # 아직 없는 최근 분기말
npm run test:ibd                                               # 이자부부채 엔진 회귀 테스트
npx tsx scripts/check-valuation-cache.ts                       # 품질 검사

# 분기말 Peer 모집단 스냅샷 (분기말 직후 실행, 결과는 불변)
npx tsx scripts/collect-peer-snapshot.ts --date 20260630
npx tsx scripts/summarize-peer-snapshot.ts 20260630            # LLM 요약(로컬 수동)

# 사업보고서 본문 (연 1회, 수 시간)
npx tsx scripts/collect-business-cache.ts

# 기준정보 (자동: 매주 월요일)
npx tsx scripts/update-industry-data.ts
npx tsx scripts/update-corp-codes.ts

# 파일 목록·Blob 업로드
npx tsx scripts/build-data-manifest.ts
BLOB_READ_WRITE_TOKEN=... npx tsx scripts/upload-data-blob.ts
```

DART 일일 호출 한도(키당 2만 회)에 걸리면 수집 스크립트는 진행 파일을 남기고 종료코드 2로 끝납니다. 같은 명령을 다시 실행하면 이어서 진행합니다.

### 자동 수집 (GitHub Actions)

| 워크플로 | 시점 | 내용 |
|---|---|---|
| `collect-quarterly.yml` | 1·4·7·10월 1~12일 매일 | 최근 분기말 밸류에이션 캐시 + Peer 스냅샷 → 품질 검사 → 커밋·Blob 업로드 → Vercel 배포 |
| `refresh-reference.yml` | 매주 월요일 | DART 기업코드, 업종·시장구분·결산월·상장일 |

저장소 Secrets 에 `OPENDART_API_KEY`(필수), `BLOB_READ_WRITE_TOKEN`(선택)을 등록합니다.

### 저장 — Vercel Blob

번들 한도(250MB) 때문에 `KVD_BLOB_BASE_URL` 이 설정된 빌드는 최근 분기(밸류에이션 4개·Peer 스냅샷 2개·사업보고서 1년)만 번들에 넣고, 나머지는 런타임에 Blob 에서 받습니다(`src/services/cache/data-files.ts`). 설정 전에는 모든 파일을 번들에 넣습니다.

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

운영 주소는 `https://krvaluation.procpa.co.kr/api/mcp` 입니다(기존 `kicpa-beta-mcp.vercel.app`·`dcf-peergroup-search.vercel.app` 도 같은 배포로 연결).

```
https://krvaluation.procpa.co.kr/api/mcp
```

`next.config.ts`의 `outputFileTracingIncludes` 설정으로 `data/business-cache/**/*.gz`와 `data/corp-codes.json`이 서버리스 함수 번들에 자동 포함됩니다.

---

## 클라이언트 연결

### Claude for Excel / Claude Desktop

`사용자 지정` → `커넥터` → `커스텀 커넥터 추가`에서 다음 URL 등록:

```
https://krvaluation.procpa.co.kr/api/mcp
```

### Claude Code

```bash
claude mcp add kr-valuation-data --transport http https://krvaluation.procpa.co.kr/api/mcp
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

URL에 `https://krvaluation.procpa.co.kr/api/mcp` 입력.

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

