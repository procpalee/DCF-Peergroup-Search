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
| `data/company-industry.json` | 전 상장사 | 종목코드 ↔ 회사명 ↔ KSIC 업종코드 | `search_by_industry` |
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

### Step 2 — 업종 기반 Peer 후보군 추출

**목적**: 피평가 기업과 같은 업종의 상장사 리스트를 뽑는다. (전체 데이터는 `company-industry.json` 캐시에서 즉시 반환)

```
search_by_industry(query="26429")      # 업종코드로 정확 매칭 + 하위 코드
# 또는
search_by_industry(query="반도체")     # KSIC 업종명 키워드로 fuzzy
```

- 업종코드 3자리만 넣으면 하위 코드까지 재귀 매칭됩니다 (예: `"264"` → `26410`, `26421`, `26429` ... 전부).
- 반환값: `{ industries: [...], companies: [{code, name}, ...], count: N }`
- 후보가 20개 이상이면 **일단 모두 받고** 다음 Step에서 정성 필터링합니다.

### Step 3 — 사업 내용 기반 정성 필터링

**목적**: Step 2에서 뽑힌 후보들이 피평가 기업과 **진짜로 비교 가능한가** 를 판단. KSIC 업종코드는 같아도 실제 제품/매출 구성은 다를 수 있습니다(예: 같은 "반도체 제조업"인데 메모리 vs 시스템 반도체 vs 장비).

```
get_business_content(stock_code="005930", year="2025")   # 피평가 기업
get_business_content(stock_code="000660", year="2025")   # 후보 1
get_business_content(stock_code="042700", year="2025")   # 후보 2
...
```

#### ⚠️ 주의
- **한 번에 한 종목씩** 호출하세요. 사업 내용 본문은 보통 20~40KB(~10K 토큰)이므로 여러 종목을 동시에 받으면 컨텍스트가 폭발합니다.
- **`year` 는 반드시 `valuation_date`의 연도와 일치**시켜야 합니다. 2025.12.31 기준이면 `year="2025"` (2024 아님).
- 후보가 너무 많으면 먼저 이름/시총 기반으로 5~10개로 좁힌 뒤 이 Step을 수행하세요.

#### 판단 기준 예시
- 주력 제품군이 피평가 기업과 겹치는가?
- 매출 비중 상위 1~2개 제품이 유사한가?
- B2B/B2C 구조, 전방산업이 유사한가?

이 판단은 LLM(에이전트)이 자연어로 수행합니다. 자동화하지 않습니다.

### Step 4 — 확정 Peer Group 밸류에이션 데이터 배치 조회

**목적**: 최종 확정된 Peer 5~10개의 베타·이자부부채·NCI·세전이익·시총을 **한 번의 호출**로 뽑는다.

```
valuation_get_data(
  stock_codes=["005930", "000660", "042700", "240810", "005070"],
  valuation_date="20251231",
  year="2025"
)
```

#### ⚠️ 파라미터 규칙
- `stock_codes`: **최대 10개** 배열. 단일 종목은 문자열도 허용.
- `valuation_date`: **반드시 분기말**(`YYYY0331` / `YYYY0630` / `YYYY0930` / `YYYY1231`) 중 하나. 이외 날짜는 캐시 miss → 느림.
- `year`: **반드시 `valuation_date`의 연도와 동일**. 예: `20251231` → `"2025"` (관습적으로 "작년"이라 생각해 `"2024"`를 넣지 마세요).

#### 반환 포맷 (compact JSON — 종목당)
```json
{
  "code": "005930",
  "name": "삼성전자",
  "industry": { "code": "26429", "name": "..." },
  "year": "2025",
  "valuationDate": "20251231",
  "beta": {
    "weekly":  { "1Y": [raw, adjusted, dataPoints], "2Y": [...], "3Y": [...], "5Y": [...] },
    "monthly": { "1Y": [...], "2Y": [...], "3Y": [...], "5Y": [...] }
  },
  "ibd": {
    "current":    [["단기차입금", 12345], ["유동성장기부채", 678]],
    "nonCurrent": [["사채", 90000], ...],
    "total": 123456
  },
  "nci": 1234,
  "pretaxIncome": 56789,
  "marketCap": { "price": 72000, "shares": 5969782550, "total": 429824343600000 }
}
```

### Step 5 — 집계·파생 지표 계산

이 단계는 도구 호출이 아니라 **LLM이 반환된 JSON을 읽어 표/평균/중앙값을 계산**하는 단계입니다. 예:

- Peer 베타 평균 (Weekly 5Y 조정베타) = `mean(peers[*].beta.weekly.5Y[1])`
- D/E 비율 = `ibd.total / (marketCap.total)`
- Peer 평균 이자부부채 비율 / P/E / EV/EBITDA 등

엑셀에서 사용 중이면 `response_format="table"` 같은 옵션이 없으므로 LLM이 직접 TSV/Markdown 표로 정리해 돌려주세요.

---

## 3. 캐시 vs 라이브 판단 매트릭스

| 데이터 | 캐시 여부 | 호출 도구 |
|---|---|---|
| 업종별 상장사 리스트 | ✅ 캐시 | `search_by_industry` |
| 사업 내용 원문 (2025 사업연도) | ✅ 캐시 | `get_business_content(year="2025")` |
| 베타 (분기말) | ✅ 캐시 | `valuation_get_data(valuation_date=YYYY{0331,0630,0930,1231})` |
| 이자부부채 / NCI / 세전이익 (분기말) | ✅ 캐시 | `valuation_get_data` 동일 호출 |
| 시가총액 (분기말) | ✅ 캐시 | `valuation_get_data` 동일 호출 |
| **임의 영업일** 베타 | 🧮 직접계산 | `valuation_get_data`(베타 자동 직접계산) 또는 `compute_beta` |
| **당일** 주가·PER·PBR·컨센서스 | ❌ 라이브 | `naver_get_market_data` |
| 분기/반기 보고서 재무, 전체 계정 | ❌ 라이브 | `dart_get_financials` |
| 사업연도 2025 외 (예: 2023 사업보고서) | ❌ 라이브 | `get_business_content(year="2023")` (DART 실시간 다운로드) |

캐시 miss가 발생하면 각 도구가 **자동으로** 라이브 API 폴백을 수행합니다 (워크플로우 #6). 에이전트가 별도 처리할 필요는 없습니다.

---

## 4. 자주 하는 실수

| ❌ 나쁜 예 | ✅ 좋은 예 |
|---|---|
| Peer 5개에 대해 `compute_beta` + `dart_get_financials` + `naver_get_market_data` 각각 호출 | `valuation_get_data(stock_codes=[...5개], valuation_date="20251231")` 한 번 |
| `get_business_content`를 5개 종목에 동시에 배치 호출 | 한 종목씩, 판단 후 다음 종목 |
| 분기말이면 더 빠름(캐시) — 임의 평일은 직접계산이라 다소 느릴 수 있음 | 가능하면 분기말 기준일 사용 |
| `valuation_date="20251231"` + `year="2024"` | `year="2025"` (연도 일치) |
| "Peer 30개 다 뽑아서 데이터 비교" | Step 3에서 5~10개로 좁힌 뒤 Step 4 |
| Step 2 없이 `search_stock` 결과만으로 Peer 선정 | `search_by_industry`로 업종 기반 후보군 먼저 확보 |

---

## 5. 엔드투엔드 예시

### 예시 1 — 반도체 Peer 5개 베타/IBD 평균

**사용자 프롬프트**
> 005930을 피평가 기업으로 해서 반도체 업종 Peer 5개 골라서 2025-12-31 기준 베타·이자부부채·시가총액 평균 뽑아줘.

**에이전트 호출 시퀀스**
1. `dart_get_company(stock_code="005930")` → `induty_code` 확인
2. `search_by_industry(query="반도체")` → 후보 20~30개 반환
3. (선택) 시총 기준으로 상위 10개 후보 좁히기
4. `get_business_content(stock_code="<후보1>", year="2025")` × 10 회 (순차 호출)
   → 메모리·시스템·장비 구분해서 삼성전자와 겹치는 메모리 반도체 Peer 5개 확정
5. `valuation_get_data(stock_codes=["000660","042700","240810","005070","<피어5>"], valuation_date="20251231", year="2025")`
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

- [ ] 피평가 기업 종목코드 확정 (Step 1)
- [ ] `search_by_industry`로 업종 후보군 확보 (Step 2)
- [ ] `get_business_content`로 후보 정성 필터링, **한 번에 한 종목씩** (Step 3)
- [ ] 최종 Peer 5~10개 배열 구성
- [ ] `valuation_date`는 분기말, `year`는 같은 연도
- [ ] `valuation_get_data` **한 번** 호출로 베타+IBD+NCI+세전이익+시총 수집 (Step 4)
- [ ] 결과 집계·표 정리는 LLM이 직접 (Step 5)

---

## 참고
- 도구별 상세 파라미터는 각 도구의 `tools/list` description을 참조.
- 캐시 재생성 스크립트: `scripts/collect-business-cache.ts`, `scripts/collect-valuation-cache.ts`
- 이 워크플로우는 **정성 판단(Peer 선정)은 LLM**, **정량 데이터 집계는 캐시** 라는 역할 분담을 전제로 합니다.
