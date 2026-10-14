# 계획: 웹 분석 도구 설치(1번) + 서버측 purchase 전환 전송(4번)

작성일: 2026-10-14 · 작성자: Fable(계획) · 구현/검증: Opus 서브에이전트
근거 문서: `marketing-meeting-prep.md` 1-1·1-3·7장, `marketing-feature-list.md` A1·A4

## 목표
1. 라이브 사이트(`public-figma/`, HTML 19개)에 GTM 컨테이너를 심고, GA4·네이버 애널리틱스·MS Clarity는 GTM 안에서 설정(코드 수정 0)한다. 퍼널 이벤트 `view_item`·`sign_up`·`login`·`begin_checkout`·`purchase`를 `dataLayer`로 보낸다.
2. 결제 승인 시점에 서버가 GA4 Measurement Protocol과 Meta 전환 API로 `purchase`를 직접 보낸다(브라우저 라운드트립 끊김·수동승인·광고차단 누락 보완). 카카오는 서버측 전환 API 공개 스펙이 없어 **GTM 브라우저 픽셀만** 적용(범위 외).

## 설계 결정
- **ID는 코드에 하나만**: GTM 컨테이너 ID. GA4 측정 ID·네이버 wcs ID·Clarity ID는 GTM 태그로 넣는다. 서버측 전송용 `GA4_MEASUREMENT_ID`·`GA4_API_SECRET`·`META_PIXEL_ID`·`META_CAPI_ACCESS_TOKEN`은 환경변수. 값이 비어 있으면 전부 no-op(로컬·미설정 상태에서 에러 없이 동작).
- **공용 스크립트 1개**: `public-figma/analytics.js`. 모든 HTML `<head>` 최상단(첫 `<script>` 앞, CSS보다 앞)에 `<script src="analytics.js?v=20261014"></script>`. 내용: `window.dataLayer=[]` 초기화 → GTM 스니펫(ID 비면 skip) → `window.dtTrack(name, params)` 헬퍼(`dataLayer.push({event:name, ...params})`) → `view_item` 자동(body `data-page`가 vodDetail/vodDetail_v2/classDetail이고 URL `id` 있으면, 강좌 정보는 페이지 JS가 `/api/vod-courses/:id` 응답을 받은 뒤 `dtTrack` 호출로 보완).
- **스키마 변경(payments)**: `client_context TEXT NULL`(JSON: `ga_client_id`, `ga_session_id`, `fbp`, `fbc`, `ip`, `ua`), `conversion_sent_at DATETIME NULL`. 운영 DB에 수동 ALTER 필요(`infra/schema.sql` 갱신 + 아래 마이그레이션 SQL). 로컬 `.env`가 운영 DB에 직결되어 있으므로 **ALTER는 사용자 승인 후에만** 실행.
- **멱등성**: 전환 전송 직전 `UPDATE payments SET conversion_sent_at=NOW() WHERE id=? AND conversion_sent_at IS NULL`의 affectedRows=1일 때만 전송. 전송 실패 시 `conversion_sent_at`을 NULL로 되돌린다.
- **dedup**: GA4는 `transaction_id=order_number`(브라우저 purchase와 동일 값 → GA4가 중복 집계 억제). Meta는 `event_id=order_number`를 서버·브라우저(GTM Meta 픽셀 태그의 eventID) 양쪽에 같이 넣어 중복 제거.

## 구현 작업

### A. 프런트(에이전트 1) — `public-figma/`
1. `analytics.js` 신규. 상단 상수 `const GTM_CONTAINER_ID = '';`(사용자가 ID 주면 채움). 쿠키 헬퍼 불필요.
2. HTML 19개 `<head>` 첫 자식으로 스크립트 삽입(`cert, classDetail, curriculum, faq, index, intro, join, lecturePlayer, mypage, notice, orderConfirm, paymentComplete, payupReturn, privacy, reviews, terms, vod, vodDetail, vodDetail_v2`). `<meta charset>` 다음에 둔다.
3. 이벤트
   - `sign_up`: `join.html` 가입 성공 분기(`$('joinSuccess')` 표시 직전) `dtTrack('sign_up',{method:'email', signup_channel: signupChannel.join('|')})`.
   - `login`: `auth.js` 로그인 성공 콜백에 `dtTrack('login',{method:'email'})`.
   - `view_item`: `site-content.js`에서 강좌 상세 렌더 함수가 코스 데이터를 받은 직후 `dtTrack('view_item',{currency:'KRW', value:new_price, items:[{item_id, item_name, price}]})`.
   - `begin_checkout`: `wireOrderConfirmPayButton`의 `/api/payments/init` fetch 직전 `dtTrack('begin_checkout',{currency:'KRW', value, coupon: couponSelect.value||undefined, items:[...]})` (course 객체 사용).
   - `purchase`: `paymentComplete.html` 인라인 스크립트에서 `ok`일 때. 중복 방지: `localStorage['dt_purchase_'+orderNumber]`가 있으면 skip. 파라미터 `transaction_id: orderNumber, currency:'KRW', value:Number(amount), items:[{item_id: courseIdNum, item_name: itemName, price: Number(amount), quantity:1}]`. 0원 쿠폰 결제도 `payData.redirect`가 이 페이지이므로 동일 경로로 잡힌다.
4. `paymentComplete.html` 쿼리에 `courseId`가 없을 수 있으면 `paymentCompleteRedirect()`(server.js)가 이미 넣는지 확인하고 없으면 추가.
5. 운영 문서 `docs/analytics-setup.md`: GTM에서 만들 태그·트리거 표(GA4 구성 태그, GA4 이벤트 태그 5개와 dataLayer 변수 매핑, 네이버 애널리틱스 Custom HTML, Clarity Custom HTML, Meta 픽셀 purchase 태그에 `eventID` 넣는 법), 원청 계정으로 GTM/GA4 만들고 개발사에 편집권한 주는 절차, GA4 DebugView로 확인하는 방법, 개인정보처리방침 추가 문구 초안(분석도구·쿠키·픽셀 — 원청 확인 필요).

### B. 서버(에이전트 2) — `server.js`, `lib/`, `infra/`
1. `lib/conversions.js` 신규
   - `parseCookies(header)` 소형 헬퍼(의존성 추가 없음).
   - `captureClientContext(req)` → `{ga_client_id, ga_session_id, fbp, fbc, ip, ua}`. `_ga` = `GA1.1.<cid1>.<cid2>` → `cid1.cid2`. `_ga_<ID>` 값은 `GS1.1.<sid>...` 또는 `GS2.1.s<sid>$o...` 두 형식 모두 파싱(첫 `_ga_` 접두 쿠키 사용). `ip`는 `x-forwarded-for` 첫 값(nginx 뒤), `ua`는 255자 절단.
   - `sendPurchaseConversion({payment, member})`: GA4 MP(`https://www.google-analytics.com/mp/collect?measurement_id&api_secret`, body `{client_id, events:[{name:'purchase', params:{transaction_id, value, currency:'KRW', coupon, session_id, engagement_time_msec:100, items:[...]}}]}`; client_id 없으면 `srv.<member_id>` 대체 — GA4 집계에는 잡히되 유입 귀속은 안 됨) + Meta CAPI(`https://graph.facebook.com/v21.0/<PIXEL>/events`, `event_name:'Purchase', event_time, event_id:order_number, action_source:'website', user_data:{em:[sha256(normalized email)], ph:[sha256(digits with 82 country code)], client_ip_address, client_user_agent, fbp, fbc}, custom_data:{currency:'KRW', value, content_ids:[vod_course_id], content_type:'product', order_id}`). 각 채널은 env 비면 skip. Node 20 내장 `fetch`, 타임아웃 5초(AbortController). 실패는 `console.error`만.
   - `CONVERSION_DEBUG=1`이면 GA4는 `/debug/mp/collect`로 보내 validationMessages를 로그에 출력(검증용).
2. `server.js`
   - `/api/payments/init`: 두 INSERT(1697 0원 승인, 1716 pending)에 `client_context` 컬럼 추가 저장(JSON.stringify).
   - 공용 `reportPurchaseConversion(paymentId)`: payments+members 조회 → 멱등 UPDATE → `sendPurchaseConversion` fire-and-forget(`.catch`). 호출 지점 3곳: `settlePayment` 승인 분기(`enrollMemberInVod` 뒤), `/api/payments/init` 0원 즉시승인 분기, `/admin/api/payments/:id/manual-approve`.
   - `paymentCompleteRedirect()`에 `courseId` 파라미터가 포함돼 있는지 확인(없으면 추가).
3. `infra/schema.sql` payments 정의에 두 컬럼 + 주석. `infra/migrations/2026-10-14-payments-conversion.sql`에 `ALTER TABLE payments ADD COLUMN client_context TEXT NULL, ADD COLUMN conversion_sent_at DATETIME NULL;`.
4. `infra/README.md`(환경변수 절)에 `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `CONVERSION_DEBUG` 설명 추가. `CLAUDE.md`에 분석·전환 절 3~5줄 추가.

### C. 검증(에이전트 3, 구현과 별도)
- 프런트: 로컬 서버 기동 후 Playwright로 index/vodDetail/join/orderConfirm/paymentComplete 열어 `window.dataLayer` 내용 캡처. `GTM_CONTAINER_ID`를 임시 `GTM-TEST`로 두고 GTM 스크립트 요청이 나가는지 네트워크 확인 후 원복. `paymentComplete.html?payment=success&orderNumber=T1&amount=1000&courseId=1&itemName=x` 2회 로드 → purchase 1회만 push되는지. 증거: dataLayer JSON 덤프·스크린샷.
- 서버: 운영 DB에 ALTER가 적용된 뒤에만 DB 경유 테스트. 적용 전에는 `lib/conversions.js`를 단독 스크립트로 호출해 `CONVERSION_DEBUG=1` + 더미 측정ID로 요청 payload·쿠키 파싱(`GS1`/`GS2` 두 형식, `_ga` 형식)을 검증. `node -e`로 `parseCookies`·`captureClientContext` 단위 확인. 증거: 로그 출력.
- 운영 DB 쓰기(결제 생성·승인) 테스트는 하지 않는다.

## 사용자에게 필요한 것
- GTM 컨테이너 ID(없으면 `''`로 두고 배포 후 교체 — `analytics.js` 상수 1줄).
- 운영 DB ALTER 실행 승인(배포 전 반드시 선적용. 컬럼 없이 새 코드가 뜨면 `/api/payments/init`이 500).
- GA4 API secret·Meta 토큰은 운영서버 `.env`에 사용자가 직접 넣는다.

## 범위 밖(후속)
robots/sitemap(5번), UTM 서버 저장(2번), 카카오 서버 전환, 개인정보처리방침 실제 반영.
