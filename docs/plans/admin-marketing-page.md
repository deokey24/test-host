# 계획: 관리자 "마케팅" 페이지 (조회 + 설정)

작성일: 2026-10-14 · 작성자: Fable(계획) · 구현: Opus 2명 병렬(서버 / 관리자 UI) + 검증 1명
선행: `analytics-and-server-conversion.md`(완료) — analytics.js, lib/conversions.js, payments.client_context

## 목표
관리자 사이드바에 "마케팅" 섹션 하나를 추가해 ① 분석 도구 ID·전환 API 키를 **코드 수정 없이 관리자에서 설정**하고 ② 가입·결제·유입경로·키워드·쿠폰·전환 전송 상태를 **기간별로 조회**한다.

## 설계 결정
- **설정 저장소**: `site_sections(page='marketing', section_key='analytics')` JSON 한 건. 키: `gtmContainerId`, `ga4MeasurementId`, `ga4ApiSecret`, `metaPixelId`, `metaCapiAccessToken`, `naverWcsId`, `clarityProjectId`. 비밀값(`ga4ApiSecret`, `metaCapiAccessToken`)은 GET에서 마스킹(`'••••' + 끝 4자`, 별도 `*_set: true`)하고, PUT에서 빈 문자열이면 기존 값 유지, `null`이면 삭제.
- **우선순위**: DB 설정 > 환경변수(기존 `GA4_*`, `META_*` env는 폴백으로 유지).
- **브라우저로 ID 전달**: `GET /analytics.js`를 Express 라우트로 가로채(정적 미들웨어보다 앞에 등록) `public-figma/analytics.js` 파일의 `var DT_ANALYTICS_CONFIG = {};` 한 줄을 DB 설정 `{gtmId, ga4MeasurementId, naverWcsId, clarityId}`로 치환해 응답. 메모리 캐시 60초, `Cache-Control: public, max-age=300`. analytics.js 정적 파일 자체의 `GTM_CONTAINER_ID` 상수는 제거하고 `DT_ANALYTICS_CONFIG`로 일원화.
- **analytics.js 동작**: `gtmId` 있으면 GTM 스니펫(GA4·네이버·Clarity는 GTM에서 해도 됨). `gtmId` 없고 `ga4MeasurementId`만 있으면 gtag.js 직접 로드 + `dtTrack`이 `gtag('event', ...)`도 호출(GTM 없이도 동작). `naverWcsId` 있으면 네이버 애널리틱스 `wcs` 스니펫, `clarityId` 있으면 Clarity 스니펫을 직접 주입(GTM 유무 무관, 단 GTM에도 같은 태그를 넣으면 중복이니 가이드에 명시). 아무것도 없으면 no-op.
- **서버 전환 전송**: `lib/conversions.js`의 `sendPurchaseConversion`이 설정 객체를 인자로 받도록(`{ga4MeasurementId, ga4ApiSecret, metaPixelId, metaCapiAccessToken}`) 바꾸고, `server.js`의 `reportPurchaseConversion`이 `getMarketingSettings()`(DB 60초 캐시 + env 폴백)로 읽어 넘긴다. `captureClientContext`의 measurementId도 같은 설정에서.

## API 계약 (서버 에이전트가 구현, UI 에이전트가 소비)
- `GET /admin/api/marketing/settings` → `{gtmContainerId, ga4MeasurementId, ga4ApiSecretMasked, ga4ApiSecretSet, metaPixelId, metaCapiAccessTokenMasked, metaCapiAccessTokenSet, naverWcsId, clarityProjectId, envFallback:{ga4:boolean, meta:boolean}}`
- `PUT /admin/api/marketing/settings` body 동일 키(비밀값은 `ga4ApiSecret`, `metaCapiAccessToken`; `''`=유지, `null`=삭제). 저장 후 analytics.js·settings 캐시 무효화. 응답 `{ok:true}`.
- `GET /admin/api/marketing/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` (기본 최근 30일, `to` 포함) →
  ```
  { range:{from,to},
    kpi:{ signups, paymentAttempts, approvedCount, revenue, approvalRate, couponPayments,
          emailConsentRate, smsConsentRate, withdrawnExcluded:true },
    daily:[{date, signups, approved, revenue}],
    channels:[{channel, signups, buyers, revenue}],        // members.signup_channel을 ', '로 split해 복수선택 각각 집계
    keywords:[{keyword, signups, buyers, revenue}],       // search_keyword TRIM·LOWER, 상위 20
    referrers:[{code, signups, buyers}],                  // referrer_code 상위 20
    courses:[{vodCourseId, title, approvedCount, revenue}],
    coupons:[{label, code, usedCount, discountTotal}],    // payments.coupon_id JOIN coupons, 기간 내 approved
    funnel:{ pending, expired, failed, canceled, approved }  // 기간 내 payments.status 분포
  }
  ```
  규칙: 기간 기준은 members.joined_at(가입), payments.approved_at(승인)·created_at(시도). `member_group='withdrawn'` 제외. buyers = 해당 그룹 회원 중 기간 내 approved 결제 1건 이상인 회원 수, revenue = 그 회원들의 approved 금액 합.
- `GET /admin/api/marketing/conversions?limit=30` → 최근 approved 결제 `[{paymentId, orderNumber, memberName, amount, approvedAt, conversionSentAt, hasGaClientId, hasFbp}]`
- `POST /admin/api/marketing/conversions/:paymentId/resend` → `conversion_sent_at`을 NULL로 되돌린 뒤 `reportPurchaseConversion` 호출(await 해서 결과 `{ga4, meta}` 반환). 설정·env 둘 다 없으면 400 `"GA4/Meta 설정이 없습니다"`.

## 관리자 UI (admin/)
- 사이드바 "결제 관리" 아래에 `<button class="side-link" data-target="marketingSection">마케팅</button>`, `admin/index.html`에 `<section id="marketingSection" class="admin-section">`, 스크립트 `admin/marketing.js` 추가(`cms.js` 섹션 전환·`apiFetch`·`setStatus` 패턴 재사용, 결제 관리 테이블 스타일 재사용).
- 카드 구성(위→아래):
  1. **기간 선택** (from/to date input + 7일/30일/90일 버튼) → summary·daily 갱신.
  2. **KPI 타일 8개**: 가입, 결제 시도, 승인, 매출, 승인 전환율, 쿠폰 사용 결제, 이메일 동의율, SMS 동의율.
  3. **일별 추이**: 가입 수·승인 수·매출 — 외부 차트 라이브러리 없이 CSS/SVG 막대. 구현 전 `dataviz` 스킬을 로드해 색·접근성 규칙을 따를 것.
  4. **가입경로별 / 검색키워드별 / 추천인코드별** 표 3개 (가입·결제자·매출·결제율).
  5. **강좌별 매출**, **쿠폰 사용** 표.
  6. **전환 전송 상태**: 최근 30건 표(전송시각, GA 클라이언트ID 유무, fbp 유무) + "재전송" 버튼(결과 토스트). 상단에 "GA4/Meta 설정됨/미설정" 배지.
  7. **분석 도구 설정** 폼: GTM 컨테이너 ID, GA4 측정 ID, GA4 API Secret(password 타입, 마스킹 표시, "설정됨" 배지), Meta 픽셀 ID, Meta 전환 API 토큰(password), 네이버 애널리틱스 ID, Clarity 프로젝트 ID, 저장 버튼. 각 입력 아래 한 줄 힌트(어디서 찾는지). GTM 사용 시 네이버·Clarity를 여기와 GTM에 중복으로 넣지 말라는 경고.
  8. **설정 가이드** 접이식 카드: GTM 컨테이너 만들기 6단계, GA4 측정 ID·API Secret 위치, Meta 픽셀·토큰 위치, 네이버 애널리틱스·Clarity ID 위치, 확인 방법(GA4 실시간/DebugView). 상세는 `docs/analytics-setup.md` 참조 문구.
- 관리자 페이지 섹션이 열릴 때(사이드바 클릭) 최초 1회 로드, 이후 기간 변경 시 재조회.

## 검증
- 설정 PUT → GET 마스킹 확인 → `GET /analytics.js` 응답에 config 치환 확인(브라우저에서 `window.DT_ANALYTICS_CONFIG`) → 저장 후 60초 캐시 무효화 확인. **테스트 후 설정은 반드시 원래(빈 값)로 되돌린다**(운영 DB `site_sections` 1행만 영향).
- summary 수치를 SQL로 교차검증(SELECT만): 기간 가입 수, approved 수·합계가 KPI와 일치. `withdrawn` 제외 확인.
- 관리자 UI: Playwright로 로그인 → 마케팅 섹션 스크린샷(1280, 2x), 기간 버튼 전환, 설정 폼 저장 흐름(값 입력→저장→새로고침→마스킹 표시→빈값 복구).
- 재전송은 설정 없을 때 400만 확인(실전송 안 함).

## 범위 밖
UTM·페이지 경로 집계(`attribution-and-journey.md`), 메일 발송.
