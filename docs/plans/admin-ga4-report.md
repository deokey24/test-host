# 계획: GA4 방문 통계를 관리자 마케팅 화면에서 보기

작성일: 2026-10-14 · 작성자: Fable(계획) · 선행: `admin-marketing-page.md`(설정·요약), `attribution-and-journey.md`(결제자 여정)
목표: 가입·결제 없이 떠난 방문자까지 포함한 **전체 방문 통계**(일별 방문, 페이지별 조회·평균 체류시간, 유입 소스, 랜딩, 퍼널 이벤트 수)를 GA4 Data API로 받아 관리자 "마케팅" 화면에 표시한다. 우리 DB에는 방문 로그를 쌓지 않는다(계획 2-E 보류 유지).

## 0. 결론 요약
- GA4 Data API(`analyticsdata.googleapis.com/v1beta`)를 **서비스 계정 + JWT(RS256)** 로 호출한다. 외부 패키지 없이 Node `crypto`·전역 `fetch`(Node 20)로 구현.
- 설정 키 2개 추가: `ga4PropertyId`(숫자 속성 ID), `ga4ServiceAccountJson`(비밀, 서비스 계정 키 JSON 원문). 기존 `site_sections(marketing/analytics)` JSON에 함께 저장, env 폴백 `GA4_PROPERTY_ID`, `GA4_SERVICE_ACCOUNT_JSON`.
- 라우트 3개: `GET /admin/api/marketing/ga4?from&to`(보고서 묶음, 서버 1시간 캐시), `GET /admin/api/marketing/ga4/realtime`(현재 접속자, 30초 캐시), `POST /admin/api/marketing/ga4/test`(설정 연결 테스트).
- UI: 마케팅 섹션에 "GA4 방문 통계" 카드(`mkGa4Card`) 추가, 설정 카드에 속성 ID·서비스 계정 JSON 입력 + "연결 테스트" 버튼.
- 사용자 준비물: Google Cloud 프로젝트에서 Analytics Data API 사용 설정 → 서비스 계정 생성·키(JSON) 발급 → GA4 속성 액세스 관리에 서비스 계정 이메일을 **뷰어**로 추가 → 속성 ID 확인. 절차는 `docs/analytics-setup.md` 10장에 적는다.

## 1. 서버 (`lib/ga4-data.js` 신규, `server.js` 수정)

### 1-1. 인증
- `parseServiceAccount(jsonText)` → `{client_email, private_key, token_uri}` 검증(필수 키, `private_key`가 `-----BEGIN PRIVATE KEY-----` 포함). 실패 시 `null`.
- `getAccessToken(sa)`: JWT 헤더 `{alg:'RS256',typ:'JWT'}`, 클레임 `{iss: client_email, scope:'https://www.googleapis.com/auth/analytics.readonly', aud: token_uri, iat, exp: iat+3600}` → `crypto.sign('RSA-SHA256', ...)` base64url → `POST token_uri` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) → `access_token`. **client_email 기준 메모리 캐시**(만료 60초 전까지 재사용). 설정이 바뀌면(이메일 변경) 자동으로 새 토큰.
- 모든 외부 호출 타임아웃 10초(`AbortController`).

### 1-2. 보고서
- `runReport(sa, propertyId, body)` → `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`. 비 2xx면 `{status, message}`를 담은 Error(구글 `error.message` 그대로, 403이면 "서비스 계정을 GA4 속성에 뷰어로 추가했는지 확인" 힌트 추가).
- `fetchOverview(sa, propertyId, {from, to})` → **배치 1회**(`:batchRunReports`, 최대 5개) 로 아래 5개 표를 받아 응답 모양으로 정규화. 기간은 `YYYY-MM-DD` 문자열 그대로(GA4 속성 시간대=대한민국이라 KST 달력일과 일치).
  | 키 | dimensions | metrics | 정렬/제한 |
  |---|---|---|---|
  | `daily` | `date` | `sessions, totalUsers, newUsers, screenPageViews, keyEvents` | date 오름차순 |
  | `pages` | `pagePath` | `screenPageViews, totalUsers, userEngagementDuration, engagementRate` | screenPageViews 내림차순 50 |
  | `sources` | `sessionSource, sessionMedium` | `sessions, totalUsers, engagedSessions, keyEvents` | sessions 내림차순 30 |
  | `landings` | `landingPage` | `sessions, totalUsers, keyEvents` | sessions 내림차순 30 |
  | `events` | `eventName` | `eventCount, totalUsers` | `eventName` IN (page_view, view_item, sign_up, login, begin_checkout, purchase) 필터 |
  - `pages`에 파생값 `avgEngagementSec = userEngagementDuration / screenPageViews`(반올림 초). 쿼리스트링은 GA4가 `pagePath`에서 이미 제거함.
  - 숫자는 모두 Number로 변환, 비율은 0~1.
- `fetchRealtime(sa, propertyId)` → `:runRealtimeReport` `metrics: activeUsers` (dimension 없음) → `{activeUsers}`.
- 캐시: `overview`는 `(propertyId, from, to)` 키로 **1시간** 메모리 캐시(최대 50개 엔트리 LRU 정도의 단순 Map), `realtime`은 30초. 응답에 `fetchedAt`·`cached` 포함. 설정 저장(`invalidateMarketingSettings`) 시 캐시 비움. 쿼터(속성당 하루 토큰 25,000) 보호 목적.

### 1-3. 설정 (`server.js` 마케팅 설정 블록)
- `MARKETING_SETTING_ENV`에 `ga4PropertyId: 'GA4_PROPERTY_ID'`, `ga4ServiceAccountJson: 'GA4_SERVICE_ACCOUNT_JSON'` 추가. `MARKETING_SECRET_KEYS`에 `ga4ServiceAccountJson` 추가.
- 형식: `ga4PropertyId` `/^\d{5,15}$/`; `ga4ServiceAccountJson`은 정규식 대신 **커스텀 검증**(`parseServiceAccount` 성공, 길이 ≤ 10,000, `type==='service_account'`). PUT 로직의 `[re,msg]` 분기에 함수형 검증을 허용하도록 소폭 확장(`validate(val) → 에러 문자열|null`).
- GET 마스킹: 서비스 계정 JSON은 `maskSecret` 대신 `{masked:'••••', clientEmail}`로 내려 화면에 "연결된 계정: xxx@yyy.iam.gserviceaccount.com" 표시. 기존 비밀키 마스킹 응답 형식(`'••••'+끝4자`)과 다르므로 응답 키를 `ga4ServiceAccountJson: '••••'`, `ga4ServiceAccountEmail: '<email>'`로 분리해 기존 클라이언트 로직을 깨지 않는다.
- `getMarketingSettings()` 결과에 두 키가 자연히 포함됨. `GET /analytics.js` 치환에는 **넣지 않는다**(브라우저 노출 금지 — `analyticsConfigForBrowser` 같은 선택 로직이 키를 명시 열거하는지 확인하고, 열거 방식이 아니면 명시 열거로 바꾼다).

### 1-4. 라우트
- `GET /admin/api/marketing/ga4?from&to` — `parseMarketingRange` 재사용(최대 400일). 설정 없으면 `{configured:false}` 200(화면이 안내 표시). 구글 오류는 502 `{error, hint}`. 정상: `{configured:true, propertyId, range, fetchedAt, cached, daily, pages, sources, landings, events}`.
- `GET /admin/api/marketing/ga4/realtime` — `{configured, activeUsers, fetchedAt}`.
- `POST /admin/api/marketing/ga4/test` — body 없음. 저장된 설정으로 `runReport`(최근 7일 `sessions` 1개) 호출 → `{ok:true, sessions7d, propertyName?}` 또는 `{ok:false, error, hint}` 200(화면이 메시지 표시). 저장 전 값으로 테스트하지 않고 **저장 후** 테스트하는 단순 흐름.

## 2. 관리자 UI (`admin/marketing.js`, `admin/index.html`, `admin/cms.css`)
- 카드 `mkGa4Card` "GA4 방문 통계"를 `mkDailyCard`(결제 일별) 다음에 추가. 기존 기간 필터(`mkRangeCard`) 공유, `loadAll`/기간 변경 시 `loadGa4()` 호출.
  - 상단: "현재 접속 N명"(realtime, 60초마다 갱신, 섹션이 보일 때만) + 기간 합계 칩(세션·사용자·신규·페이지뷰).
  - 표 1 "일별": 날짜·세션·사용자·신규·페이지뷰·주요 이벤트. 막대(세션) 미니 바 — 기존 `mkDailyCard` 스타일 재사용.
  - 표 2 "페이지별": 경로·조회수·사용자·평균 체류(초→`1분 23초`)·참여율. 경로를 사이트 링크로.
  - 표 3 "유입 소스별": 소스/매체·세션·사용자·참여 세션·주요 이벤트.
  - 표 4 "랜딩 페이지별": 경로·세션·사용자·주요 이벤트.
  - 표 5 "퍼널 이벤트": page_view → view_item → begin_checkout → purchase, sign_up, login 각 이벤트 수·사용자 수와 이전 단계 대비 비율.
  - 미설정: "GA4 Data API가 연결되지 않았습니다 — 아래 설정 카드에서 속성 ID와 서비스 계정 JSON을 저장하세요" + 가이드 링크(`mkGuideCard` 펼침). 오류: 구글 메시지와 힌트 표시. `cached`면 "N분 전 조회(1시간 캐시)" 문구, "새로 조회" 버튼(`?refresh=1` → 캐시 무시, 분당 1회 제한 클라이언트에서).
  - 안내 문구: "GA4 표준 집계는 보통 1~2일 지연됩니다. 오늘 수치는 아직 작을 수 있습니다."
- 설정 카드(`mkSettingsCard`)에 두 필드 추가: `mkGa4PropertyId`(텍스트, 힌트 "GA4 관리 → 속성 설정 → 속성 ID(숫자)"), `mkGa4SaJson`(textarea, password 아님, 저장 후 비워짐 + 배지 "연결된 계정: email", "저장된 값 삭제" 체크 — 기존 `SECRET_FIELDS` 패턴). 저장 버튼 옆 "연결 테스트" 버튼 → `/ga4/test` 결과를 상태줄에.
- `mkGuideCard`에 "GA4 Data API 연결" 절(아래 3장 요약) 추가.

## 3. 사용자 준비 절차 (`docs/analytics-setup.md` 10장)
1. console.cloud.google.com → 프로젝트 만들기(이름 `dockteacher-analytics`) → "API 및 서비스 → 라이브러리" → **Google Analytics Data API** 검색 → 사용 설정.
2. "IAM 및 관리자 → 서비스 계정 → 만들기": 이름 `ga4-reader` → 역할은 부여하지 않음(완료) → 생성된 계정 클릭 → "키 → 키 추가 → 새 키 만들기 → JSON" → 다운로드된 JSON 파일 내용 전체를 관리자 설정 "GA4 서비스 계정 JSON"에 붙여넣기.
3. analytics.google.com → 관리 → 속성 열 "속성 액세스 관리" → "+ 사용자 추가" → 이메일에 서비스 계정 이메일(`ga4-reader@....iam.gserviceaccount.com`) → 역할 **뷰어** → 추가.
4. 관리 → "속성 설정"(속성 세부정보) → **속성 ID**(숫자 9자리) → 관리자 설정 "GA4 속성 ID"에 입력 → 저장 → "연결 테스트".
5. 주의: JSON 키 파일은 메일·메신저로 보내지 말고 붙여넣은 뒤 삭제. 키 유출 시 Cloud 콘솔에서 키 삭제 후 재발급.

## 4. 검증 계획
- 단위: 로컬 생성 RSA 키로 JWT 서명·디코딩 검증, `fetch` 모킹으로 토큰 캐시·403 힌트·batchRunReports 정규화(`avgEngagementSec`, 숫자 변환, 빈 행) 테스트.
- 라우트: 가짜 app으로 미설정 `{configured:false}`, 기간 400 검증, 구글 502 전달, `test` 응답 모양.
- 설정: PUT에 잘못된 JSON → 400, 올바른 JSON → 저장 후 GET 마스킹에 이메일만 노출, `/analytics.js`에 JSON·속성 ID가 없음을 grep.
- 실데이터 확인은 사용자가 서비스 계정을 만든 뒤 "연결 테스트"로.

## 5. 범위 밖·주의
- GA4 쿼터: 속성당 일 25,000 토큰, 동시 10요청. 1시간 캐시 + 배치 1회(≈5~10토큰)로 충분. 관리자 여러 명이 기간을 자주 바꿔도 캐시 키가 다르면 호출이 늘어나므로 "새로 조회"에 분당 1회 제한.
- 서비스 계정 JSON은 운영 DB 평문 저장(기존 API Secret과 동일 수준). 공개 `/api/site/marketing` 차단은 이미 적용됨.
- 익명 집계만 다루므로 개인정보 처리 추가 없음(GA4 자체 고지는 이미 8장).
