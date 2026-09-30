# Peer Group 분석 워크플로우 가이드

> 이 문서는 MCP 에이전트(Claude Code, Claude for Excel 등)가 **Peer Group을 선정하고 밸류에이션 데이터를 추출**할 때 따라야 하는 정규 호출 시퀀스를 정의합니다. 이 서버의 캐시 구조와 도구 분담을 최대한 활용해 **불필요한 라이브 API 호출을 줄이고 응답 속도와 일관성**을 확보하는 것이 목적입니다.

---

## 0. 언제 이 워크플로우를 쓰나

사용자 요청에 다음과 같은 신호가 있으면 이 워크플로우를 그대로 따르세요:

- "Peer Group 선정", "동종업계 비교", "Comparable Company Analysis", "CCA"
- "베타 평균/중앙값", "이자부부채 비율 평균"
- "피평가 기업 X에 대해 유사 상장사 N개 골라줘"
- "반도체/자동차/바이오 Peer 5개 뽑아서 재무 비교"
- 특정 종목 밸류에이션 산정을 위한 **유사 기업 탐색**

라이브 실시간 주가·PER/PBR 단건 조회 같은 요청에는 이 워크플로우가 과합니다 — `naver_get_market_data` 단독 사용이 맞습니다.

---

## 1. 캐시 커버리지 (중요)

이 서버는 **분기말 기준**의 Peer Group 분석용 데이터를 사전 캐싱해 두고 있습니다. 이 사실이 워크플로우 설계의 전부입니다.

| 캐시 파일 | 커버 | 담긴 필드 | 관련 도구 |
|---|---|---|---|
| `data/company-industry.json` | 전 상장사 | 종목코드 ↔ 회사명 ↔ KSIC 업종코드 + 시장구분/결산월/상장일 | `search_by_industry` |
| `data/peer-snapshot/20250331.json.gz`<br>`… 20250630 / 20250930 / 20251231` | 각 ~2,590 | **Peer 모집단 스냅샷** (분기말 시점 고정, 불변)<br>사업의 개요 + 부문별 매출(매출 및 수주상황 표)<br>배제판단 플래그 (스팩/지주사/리츠/12월외결산/관리종목)<br>근거 보고서 메타 (rceptNo/유형/접수일) | `peergroup_get_population` |
| `data/business-cache/2025.json.gz` | 2,611 / 2,617 (99.8%) | 사업보고서 "II. 사업의 내용" 본문 (주요 제품 및 서비스) | `get_business_content` |
| `data/valuation-cache/20250331.json`<br>`data/valuation-cache/20250630.json`<br>`data/valuation-cache/20250930.json`<br>`data/valuation-cache/20251231.json` | 각 2,617 | **베타** (W/M × 1/2/3/5Y)<br>**이자부부채** (유동/비유동 세부)<br>**비지배지분**<br>**세전이익**<br>**시가총액** (price / shares / total) | `valuation_get_data` |
| `data/corp-codes.json` | 전 상장사 | 종목코드 ↔ DART corp_code | (내부) |

### 핵심 원칙

> **평가기준일(`valuation_date`)이 분기말(0331 / 0630 / 0930 / 1231)이라면, `valuation_get_data` 한 번 호출로 베타 + 이자부부채 + 비지배지분 + 세전이익 + 시가총액이 전부 나옵니다.**

이 경우 `compute_beta`, `dart_get_financials`, `naver_get_market_data`를 따로 호출할 이유가 **없습니다**. 따로 부르면:
- ❌ 라이브 소스(네이버, DART)를 불필요하게 호출
- ❌ 응답이 10배 이상 느려짐
- ❌ 캐시된 값과 미세한 수치 차이 발생 가능

---

## 2. Step-by-Step 워크플로우

### Step 1 — 피평가 기업(Target) 확정

**목적**: Peer Group을 뽑을 기준이 되는 종목의 종목코드·업종코드를 확정.

| 상황 | 호출 |
|---|---|
| 사용자가 회사명만 제시 ("삼성전자") | `search_stock(query="삼성전자")` → 종목코드 6자리 확정 |
| 사용자가 종목코드 제시 ("005930") | 생략 가능 |
| 업종코드까지 확인하고 싶을 때 | `dart_get_company(stock_code="005930")` — `induty_code` 필드 확인 |

출력 예: `{ code: "005930", name: "삼성전자", induty_code: "26429" }`

### Step 2a — 모집단 확정 (결정론적)

**목적**: (평가기준일, 업종코드) 기준으로 **재현 가능한 Peer 모집단**을 확정한다. 같은 입력이면 언제 실행해도 같은 결과 — `snapshotDate` 와 `populationHash` 를 조서(산출물)에 기록하면 사후 재현 검증이 가능합니다.

```
peergroup_get_population(valuation_date="20251231", industry_code="264")
```

- 업종코드 접두 자릿수가 곧 매칭 깊이 (`"264"` → 264로 시작하는 전체, `"26429"` → 정확 일치).
- 업종코드를 모르면 먼저 `search_by_industry(query="반도체")` 로 코드를 해석하세요. 단, **모집단 확정은 반드시 `peergroup_get_population`** — `search_by_industry` 는 최신 목록 기준이라 시점이 고정되지 않습니다.
- 반환: 모집단 로스터 전체 (종목코드/회사명/시장/업종 + 배제판단 플래그) + `meta.populationHash`.
- **플래그로 1차 배제 판단**: `isSpac`(기업인수목적), `isHolding`(지주사), `isReit`, `fiscalMonthNot12`(12월외결산), `isAdministrative`(관리종목)는 통상 Peer 부적격 후보입니다. 자동 배제가 아니라 평가 목적에 따라 판단하되, 배제 사유를 기록하세요.

### Step 2b — 개요·부문별 매출 기반 정성 필터링

**목적**: 모집단의 각 종목이 피평가 기업과 **진짜로 비교 가능한가** 를 판단. KSIC 업종코드는 같아도 실제 제품/매출 구성은 다를 수 있습니다(예: 같은 "반도체 제조업"인데 메모리 vs 시스템 반도체 vs 장비).

```
peergroup_get_population(valuation_date="20251231", industry_code="264",
                         include_content=true, page=1)   # 페이지당 5종목
peergroup_get_population(..., page=2)                    # meta.nextPage 로 순회
```

- 각 종목의 **사업의 개요** + **부문별 매출**(매출 및 수주상황 표)이 함께 옵니다. 이 데이터는 평가기준일 시점에 이용 가능했던 최신 정기보고서(사업/반기/분기)에서 추출된 것입니다 (`report` 필드가 근거 공시).
- **`content_mode="summary"` (기본)**: 스냅샷에 1회 생성 후 고정 저장된 개요 요약(3~4문장) + 부문별 매출 요약(최근 기수 기준 "부문 금액(비중%)" 한 줄)을 반환합니다 — 종목당 ~0.5KB로 경량이고, 저장된 요약을 그대로 읽으므로 재현 가능합니다. 원문(절단본)이 필요하면 `content_mode="full"` (종목당 ~5KB, `max_section_chars` 적용).
- summary 기준 페이지당 ~5KB — `get_business_content` 원문 전체(20~40KB/종목)를 종목마다 받는 것 대비 컨텍스트 사용이 크게 줄어듭니다.

#### 판단 기준 예시
- 주력 제품군이 피평가 기업과 겹치는가?
- 매출 비중 상위 1~2개 제품이 유사한가?
- B2B/B2C 구조, 전방산업이 유사한가?

이 판단은 LLM(에이전트)이 자연어로 수행합니다. 자동화하지 않습니다.

### Step 3 — (선택) 최종 후보 심층 확인

**목적**: 최종 후보 2~3개와 피평가 기업에 대해서만 "사업의 내용" **원문 전체**를 확인. 모집단 필터링 용도가 아닙니다 — 그건 Step 2b에서 끝났어야 합니다.

```
get_business_content(stock_code="005930", year="2025")   # 피평가 기업
get_business_content(stock_code="000660", year="2025")   # 최종 후보 확인용
```

- **한 번에 한 종목씩** 호출하세요 (본문 20~40KB).
- **`year` 는 반드시 `valuation_date`의 연도와 일치**시켜야 합니다.

### Step 4 — 확정 Peer Group 밸류에이션 데이터 배치 조회

**목적**: 최종 확정된 Peer 5~10개의 베타·이자부부채·NCI·세전이익·시총을 **한 번의 호출**로 뽑는다.

```
valuation_get_data(
  stock_codes=["005930", "000660", "042700", "240810", "005070"],
  valuation_date="20251231"
)
```

#### ⚠️ 파라미터 규칙
- `stock_codes`: **최대 10개** 배열. 단일 종목은 문자열도 허용.
- `valuation_date`: 분기말(`YYYY0331` / `YYYY0630` / `YYYY0930` / `YYYY1231`)이면 캐시로 즉시 응답. 그 외 날짜도 같은 규칙으로 실시간 계산(느림).
- `ibd_detail`: 기본 `false` — 이자부부채는 총액과 구역·범주별 소계만. 계정 단위 근거가 필요하면(검토·조서) `true` 로 `ibd.lines` 까지 받는다.
- `year`: 더 이상 쓰지 않습니다. 재무는 **평가기준일 당시 공시된 최신 정기보고서**로 자동 선택되고(예: 20250630 → 2025 1분기보고서), `financials.report` 에 표시됩니다.

#### 반환 포맷 (compact JSON — 종목당)
```json
{
  "code": "005930",
  "name": "삼성전자",
  "industry": { "code": "264", "name": "..." },
  "year": "2025",
  "valuationDate": "20251231",
  "beta": { "weekly": { "2Y": [raw, adjusted, dataPoints] }, "monthly": { "5Y": [raw, adjusted, dataPoints] } },
  "ibd": {
    "total": 25239139000000,
    "current":    [["차입금", 18752488000000]],
    "nonCurrent": [["차입금", 6479517000000], ["사채", 7134000000]],
    "byCategory": { "borrowings": 25232005000000, "bonds": 7134000000, "lease": 0, "otherDebt": 0 },
    "debtLike": [["상환전환우선주부채", 0]],
    "checks": ["…산정 경고(있을 때만)…"],
    "lines": { "current": [["단기차입금", 17574980000000, "borrowings"], ["유동성장기부채", 1177508000000, "borrowings"]], "nonCurrent": ["…ibd_detail=true 일 때만…"] }
  },
  "ibdExcluded": "금융업일 때만 — 산정 제외 사유",
  "nci": 1234,
  "pretaxIncome": 56789,
  "marketCap": { "price": 72000, "shares": 5969782550, "total": 429824343600000, "sharesNote": "보정·대체 시에만" },
  "financials": {
    "report": { "rceptNo": "…", "name": "분기보고서 (2025.09)", "filedDate": "20251114", "period": "202509", "fs": "CFS" },
    "cash": 0, "shortTermDeposits": 0, "equityParent": 0, "revenue": 0, "operatingIncome": 0,
    "netIncomeParent": 0, "incomeTax": 0, "incomeMonths": 9
  },
  "derived": { "netDebt": 0, "enterpriseValue": 0, "note": "…" }
}
```

### Step 5 — 집계·파생 지표 계산

이 단계는 도구 호출이 아니라 **LLM이 반환된 JSON을 읽어 표/평균/중앙값을 계산**하는 단계입니다. 예:

- Peer 베타 평균 (Weekly 2Y 조정베타) = `mean(peers[*].beta.weekly.2Y[1])`
- D/E 비율 = `ibd.total / marketCap.total` (금융업은 `ibd=null` → Peer 에서 제외하거나 별도 처리)
- 순차입금·EV = `derived.netDebt`, `derived.enterpriseValue`
- 손익 멀티플은 `financials.incomeMonths` 가 12가 아니면 누적 기간이므로 연환산 여부를 명시할 것
- `ibd.debtLike`(상환전환우선주부채 등) 포함 여부는 사용자 판단 — 기본 합계에는 빠져 있음
- 리스부채를 빼고 보려면 `ibd.total − ibd.byCategory.lease` (IFRS 16 이전 기준과 비교할 때 등). 범주: borrowings 차입금, bonds 사채(차감계정 순액), lease 리스부채, otherDebt 유동화채무·판매후리스 등

엑셀에서 사용 중이면 `response_format="table"` 같은 옵션이 없으므로 LLM이 직접 TSV/Markdown 표로 정리해 돌려주세요.

---

## 3. 캐시 vs 라이브 판단 매트릭스

| 데이터 | 캐시 여부 | 호출 도구 |
|---|---|---|
| **Peer 모집단 + 개요/부문별매출 (분기말)** | ✅ 캐시 (라이브 폴백 **없음** — 결정론 보장) | `peergroup_get_population` |
| 업종별 상장사 리스트 (최신, 시점 미고정) | ✅ 캐시 | `search_by_industry` |
| 사업 내용 원문 (2025 사업연도) | ✅ 캐시 | `get_business_content(year="2025")` |
| 베타 (분기말) | ✅ 캐시 | `valuation_get_data(valuation_date=YYYY{0331,0630,0930,1231})` |
| 이자부부채 / NCI / 세전이익 (분기말) | ✅ 캐시 | `valuation_get_data` 동일 호출 |
| 시가총액 (분기말) | ✅ 캐시 | `valuation_get_data` 동일 호출 |
| **임의 영업일** 베타 | 🧮 직접계산 | `valuation_get_data`(베타 자동 직접계산) 또는 `compute_beta` |
| **당일** 주가·PER·PBR·컨센서스 | ❌ 라이브 | `naver_get_market_data` |
| 분기/반기 보고서 재무, 전체 계정 | ❌ 라이브 | `dart_get_financials` |
| 사업연도 2025 외 (예: 2023 사업보고서) | ❌ 라이브 | `get_business_content(year="2023")` (DART 실시간 다운로드) |

캐시 miss가 발생하면 각 도구가 **자동으로** 라이브 API 폴백을 수행합니다 (워크플로우 #6). 에이전트가 별도 처리할 필요는 없습니다. **예외: `peergroup_get_population` 은 결정론이 목적이므로 절대 라이브로 폴백하지 않습니다** — 스냅샷이 없는 기준일이면 에러와 함께 사용 가능한 날짜 목록을 반환합니다.

---

## 4. 자주 하는 실수

| ❌ 나쁜 예 | ✅ 좋은 예 |
|---|---|
| `search_by_industry` 결과로 모집단 확정 (시점 미고정 — 재실행 시 결과가 달라질 수 있음) | `peergroup_get_population(valuation_date, industry_code)` 으로 결정론적 확정 |
| 모집단 필터링을 위해 `get_business_content` 를 종목마다 호출 (종목당 20~40KB) | `peergroup_get_population(include_content=true, page=N)` 페이지 순회 (종목당 ~5KB) |
| `include_content=true` 를 page 없이 같은 페이지만 반복 호출 | `meta.nextPage` 를 따라 순회 |
| Peer 5개에 대해 `compute_beta` + `dart_get_financials` + `naver_get_market_data` 각각 호출 | `valuation_get_data(stock_codes=[...5개], valuation_date="20251231")` 한 번 |
| `get_business_content`를 5개 종목에 동시에 배치 호출 | 최종 후보 2~3개만, 한 종목씩 |
| 분기말이면 더 빠름(캐시) — 임의 평일은 직접계산이라 다소 느릴 수 있음 | 가능하면 분기말 기준일 사용 |
| `valuation_date` 를 모른 채 오늘 날짜로 호출 | 사용자에게 평가기준일 확인 후 호출 |
| "Peer 30개 다 뽑아서 데이터 비교" | Step 2b에서 5~10개로 좁힌 뒤 Step 4 |
| 조서에 Peer 목록만 기록 | `snapshotDate` + `populationHash` + 배제 사유까지 기록 (재현성 증빙) |

---

## 5. 엔드투엔드 예시

### 예시 1 — 반도체 Peer 5개 베타/IBD 평균

**사용자 프롬프트**
> 005930을 피평가 기업으로 해서 반도체 업종 Peer 5개 골라서 2025-12-31 기준 베타·이자부부채·시가총액 평균 뽑아줘.

**에이전트 호출 시퀀스**
1. `dart_get_company(stock_code="005930")` → `induty_code` 확인 (예: "26429" → 접두 "264" 사용 결정)
2. `peergroup_get_population(valuation_date="20251231", industry_code="264")`
   → 모집단 로스터 + 플래그. `snapshotDate`/`populationHash` 기록, 스팩·관리종목 등 1차 배제
3. `peergroup_get_population(..., include_content=true, page=1)` → `page=2, 3, ...` 순회
   → 개요·부문별 매출로 메모리·시스템·장비 구분, 삼성전자와 겹치는 메모리 반도체 Peer 5개 확정 (배제 사유 기록)
4. (선택) 최종 후보 중 애매한 1~2개만 `get_business_content` 로 원문 심층 확인
5. `valuation_get_data(stock_codes=["000660","042700","240810","005070","<피어5>"], valuation_date="20251231")`
6. 반환된 JSON을 파싱해서 Weekly-2Y / Monthly-5Y 조정베타 평균·중앙값, IBD 합계, 시총 합계를 표로 정리

**절대 호출하지 말 것**: `dart_get_financials`, `naver_get_market_data` (valuation_get_data 가 모두 포함)

### 예시 2 — 특정 회사 사업 내용만 빠르게

**사용자 프롬프트**
> 290120의 주요 제품이 뭐야?

**에이전트 호출 시퀀스**
1. `get_business_content(stock_code="290120", year="2025")` 한 번

(Peer Group 워크플로우 과잉 적용 금지.)

### 예시 3 — 임의 평일 베타

**사용자 프롬프트**
> 005930의 2025-08-15 기준 베타 알려줘.

**에이전트 호출 시퀀스**
1. `compute_beta(stock_codes=["005930"], base_date="2025-08-15")` → Weekly-2Y, Monthly-5Y 직접계산

(분기말이 아니면 `valuation_get_data` 도 베타를 직접계산해 반환합니다. 베타만 빠르게 보려면 `compute_beta`.)

---

## 6. 요약 체크리스트

Peer Group 워크플로우를 수행하기 전 에이전트가 확인할 항목:

- [ ] 피평가 기업 종목코드·업종코드 확정 (Step 1)
- [ ] `peergroup_get_population`으로 모집단 확정 — **`snapshotDate` + `populationHash` 를 산출물(조서)에 기록** (Step 2a)
- [ ] 플래그(스팩/지주사/리츠/12월외결산/관리종목) 기반 1차 배제 + 사유 기록 (Step 2a)
- [ ] `include_content=true` 페이지 순회로 개요·부문별 매출 정성 필터링 (Step 2b)
- [ ] 최종 Peer 5~10개 배열 구성 (배제 사유 기록)
- [ ] `valuation_date`는 분기말(캐시), 재무 보고서는 `financials.report` 로 확인
- [ ] `valuation_get_data` **한 번** 호출로 베타+IBD+NCI+세전이익+시총 수집 (Step 4)
- [ ] 결과 집계·표 정리는 LLM이 직접 (Step 5)

---

## 참고
- 도구별 상세 파라미터는 각 도구의 `tools/list` description을 참조.
- 캐시 재생성 스크립트: `scripts/collect-business-cache.ts`, `scripts/collect-valuation-cache.ts`, `scripts/collect-peer-snapshot.ts` (분기말 직후 실행 권장 — 빌드 랙이 길어지면 그 사이 상장폐지 종목이 스냅샷에서 누락됨)
- 이 워크플로우는 **정성 판단(Peer 선정)은 LLM**, **정량 데이터 집계는 캐시** 라는 역할 분담을 전제로 합니다.
