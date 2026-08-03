# 결제 연동 (PayUp 표준결제)

VOD 강좌 구매에 [PayUp(페이업)](https://developers.payup.co.kr) 표준결제를 연동했다. 현재는 `classDetail.html`(실제 `vod_courses` DB에 연동된 유일한 상세 페이지) 한 곳에만 구매 버튼이 붙어 있다.

## 참고 문서 (원문)
- API 전체 목록: https://developers.payup.co.kr/html/api.html
- accessToken 발급/갱신: https://developers.payup.co.kr/html/accessToken.html
- 결제창(표준결제) 연동: https://developers.payup.co.kr/html/certificationPayment.html

## 전체 흐름

```
[classDetail.html "결제하기" 클릭]
        │  fetch POST /api/payments/init  { vodCourseId }
        ▼
[server] vod_courses 가격 조회 → payments 행 status=pending 선기록
        │  응답: { merchantId, itemName, amount, userName, orderNumber, returnUrl }
        ▼
[브라우저] goPayupPay(응답데이터) → 페이업 SDK가 결제창(카드 인증) 오픈
        │
   ┌────┴─────────────────────────────┐
   │ PC                                │ 모바일
   ▼                                   ▼
SDK가 PayupPaymentStandardForm      카드사 인증 완료 후 브라우저가
자동생성 + transactionId 삽입        returnUrl로 "직접 POST"로 도착
   │ payupPaymentSubmit(form) 콜백     (실기기 테스트로 확인됨 — GET 아님)
   │ → form.action='/api/payments/approve'   │ POST /payupReturn.html
   │ → form.submit() (풀 페이지 이동)         │ (body 또는 querystring에
   ▼                                          │  transactionId/orderNumber/amount)
[server] settlePayment() 공용 로직: payup.approvePayment() 호출(accessToken 자동   ▼
발급/캐싱) → 성공 시 payments.status='approved' + enrollMemberInVod(member, course,
'payment') 등록 → 실패 시 status='failed'
   │                                   │
   ▼                                   ▼
       302 redirect: paymentComplete.html?payment=success|fail&orderNumber=..&courseId=..&itemName=..&amount=..
```

성공/실패 결과는 `classDetail.html`로 되돌리는 대신 전용 페이지 `paymentComplete.html`에서 보여준다. 표시에
필요한 값(주문번호/강좌명/금액)은 페이지가 별도 API를 호출하지 않도록 리다이렉트 쿼리스트링에 그대로 실어
보낸다(`server.js`의 `paymentCompleteRedirect()`).

모바일 경로는 카드사 인증 페이지(타 도메인)에서 넘어오는 크로스사이트 top-level POST라 세션 쿠키가 전달되지
않을 수 있다. 그래서 `/payupReturn.html` POST 핸들러는 `req.session`이 아니라 `orderNumber`로 조회한
`payments.member_id`를 신뢰 기준으로 쓴다(PC 쪽 `/api/payments/approve`는 그대로 세션을 쓴다 — 같은
출처의 폼 제출이라 문제 없음). `public-figma/payupReturn.html` 정적 페이지(+ `/api/payments/approve-mobile`
JSON 라우트)는 혹시 GET+쿼리스트링으로 오는 환경이 있을 경우를 대비한 fallback으로 남겨뒀다.

## 파일 위치

| 역할 | 파일 |
|---|---|
| accessToken 발급/캐싱, 결제 승인/취소 API 호출 | `lib/payup.js` |
| 결제 라우트 3개 (`init`/`approve`/`approve-mobile`), `settlePayment()`/`paymentCompleteRedirect()` 공용 로직, `parseKoreanWonPrice`/`makeOrderNumber` | `server.js` — `enrollMemberInVod` 함수 바로 아래 |
| 결제 버튼(`#cdBuyBtn`), SDK 스크립트 태그 | `public-figma/classDetail.html` |
| 결제 결과 페이지 (성공/실패 공용, 쿼리스트링으로 주문정보 표시) | `public-figma/paymentComplete.html` |
| 버튼 클릭 → `/api/payments/init` → `goPayupPay()`, `payupPaymentSubmit`/`payupPaymentClose` 콜백(SDK가 부르는 함수명 고정, 변경 금지) | `public-figma/site-content.js` — `wireVodCoursePayment`, `payupPaymentSubmit`, `payupPaymentClose` |
| 모바일 `returnUrl` 착지 — **실제로는 카드사 인증 페이지가 이 URL로 직접 POST** (정적 파일이 아니라 서버 라우트가 처리) | `server.js` — `app.post('/payupReturn.html', ...)` |
| 모바일 착지 페이지(정적 파일, GET 쿼리스트링으로 오는 경우를 대비한 fallback — 실기기 테스트로 확인된 주 경로는 POST) | `public-figma/payupReturn.html` |
| DB 테이블 정의 | `infra/schema.sql` — `payments` 테이블 |
| 테스트 결제 취소용 CLI | `scripts/cancel-payment.js` |
| 관리자 결제 관리 화면(조회/취소/부분취소/수동승인) | `admin/index.html`(`#paymentSection`) + `admin/payments.js` + `server.js`의 `/admin/api/payments*` 라우트 |

## `payments` 테이블

```
id, member_id, vod_course_id, order_number(UNIQUE), item_name, amount,
status ENUM('pending','approved','failed','canceled'),
transaction_id, response_code, response_msg,
created_at, approved_at, canceled_at
```
- `order_number`는 `init` 시점에 서버가 발급(`makeOrderNumber`, 형식 `YYYYMMDDHHMISS + M + memberId + 랜덤6자리`). UNIQUE 제약으로 중복 승인 방지.
- `approve`/`approve-mobile`은 승인 시점 금액을 `init` 때 기록해둔 `payments.amount`와 대조해서 위변조를 막는다.

## 환경변수 (`.env`)

```
PAYUP_ENV=live            # test → standard.testpayup.co.kr / live → standard.payup.co.kr
PAYUP_MERCHANT_ID=...
PAYUP_API_KEY=...
```
- `merchantId`는 클라이언트로도 응답에 실리므로(브라우저 네트워크 탭에서 보임) 민감정보 아님. `apiKey`는 서버(`lib/payup.js`)에서만 쓰고 절대 클라이언트로 내려가지 않는다.

## ⚠️ 현재 상태 — 실서버(live) 계정만 있음

지금 연결된 `merchantId`(ssmin2)는 **테스트서버(`standard.testpayup.co.kr`) 전용 계정이 아니라 실서버(`standard.payup.co.kr`) 계정**이다 (직접 curl로 실서버 accessToken 발급이 성공하는 것으로 확인됨). 즉:
- `.env`의 `PAYUP_ENV=live`, `classDetail.html`의 SDK `<script>`도 운영 스크립트로 맞춰져 있다.
- **지금 이 사이트에서 "결제하기"를 누르면 전부 실제 결제(진짜 카드 승인)** 다.
- 페이업에 테스트 전용 계정을 별도로 발급받으면 `.env`의 `PAYUP_ENV=test`, `classDetail.html` 상단의 SDK 스크립트 주석(테스트/운영 두 줄)만 서로 바꾸면 된다.

## 테스트 방법

1. 로컬 서버 실행 (`npm start` — 포트 3000이 다른 프로젝트와 충돌하면 `PORT=3001 npm start`로 실행. 현재 로컬 개발 시 **3001번 포트**를 쓰고 있다).
2. `/classDetail.html?id=15` — 결제 연동 테스트용으로 만들어둔 100원짜리 더미 강의(`[결제테스트] 삭제예정`). 테스트 끝나면 `DELETE FROM vod_courses WHERE id = 15;`로 정리.
3. 테스트 계정 `payuptest1@example.com` / `Test1234!` (일반 로그인 폼이 `type="email"` 검증을 하기 때문에, signup API의 아이디 형식 제약(영문자+숫자만)을 우회해 DB에 직접 만든 계정 — signup API로는 이메일 형식 아이디를 만들 수 없음). 테스트 끝나면 `DELETE FROM members WHERE username = 'payuptest1@example.com';`.
4. "결제하기" 클릭 → 실제 카드로 소액 결제 → `paymentComplete.html?payment=success`로 이동해 결과 확인.
5. 결제 취소(환불): `node --env-file-if-exists=.env scripts/cancel-payment.js <orderNumber> "사유"` — `payments.status='approved'`인 건만 취소 가능, 취소 후 `status='canceled'`로 갱신.

## 관리자 결제 관리 (`admin/index.html` "결제 관리")

- **목록/검색**: `GET /admin/api/payments` — 주문번호/거래번호/회원명/강좌명 검색, 상태 필터. `admin/payments.js`가 렌더링.
- **전액취소**: `POST /admin/api/payments/:id/cancel` — `payup.cancelPayment()` 호출 성공 시에만 `status='canceled'`로 갱신.
- **부분취소**: `POST /admin/api/payments/:id/partial-cancel` — `payup.partialCancelPayment()`(`/api/v1/partCancel`) 호출. VOD는 단건 상품이라 부분취소해도 `status`는 `approved`로 유지하고(강좌 접근권 유지) `response_msg`에 취소 이력만 남긴다.
- **수동승인**: `POST /admin/api/payments/:id/manual-approve` — PayUp에는 거래 조회(inquiry) API가 없어서, 브라우저 라운드트립이 중간에 끊겨 `pending`으로 멈춘 결제를 서버가 스스로 재확인할 방법이 없다. 관리자가 PayUp 가맹점 콘솔(`cp.payup.co.kr`)에서 실제 승인 여부를 확인한 뒤 수동으로 `approved` 처리 + `enrollMemberInVod()` 실행하는 예외 경로. `admin/payments.js`는 생성된 지 30분 넘게 `pending`인 건을 화면에서 빨간색으로 강조해 이 케이스를 발견하기 쉽게 한다(자동 탐지가 아니라 관리자가 눈으로 확인하는 방식 — 이게 현재로선 유일한 수단).
- 어떤 경로로도 결제 취소가 `member_vod_enrollments`를 자동으로 제거하지는 않는다(`scripts/cancel-payment.js`와 동일한 기존 동작 유지) — 환불 시 수강 접근을 바로 끊을지는 별도 정책 결정이 필요하다.

## 알려진 가정/한계

- **모바일 `returnUrl` 전달 방식**: 필드명(`transactionId`/`orderNumber`/`amount`)은 PayUp 공식 문서와 일치하지만, 정확히 GET 쿼리스트링인지 POST body인지는 문서에 명시가 없다. 2026-07-28 실기기 테스트에서 POST로 도착하는 것을 확인해서 `server.js`에 `app.post('/payupReturn.html', ...)`를 추가했고, `req.body`와 `req.query`를 모두 확인하도록 방어적으로 짰다.
- **PayUp에 거래 조회(inquiry) API가 없다**: 공식 문서(`api.html`)에 토큰발행/재발행/결제승인/전액취소/부분취소 5개 엔드포인트만 있고, 상태 조회 API가 없다. 즉 브라우저가 승인 라운드트립을 완주하지 못하면(카드 승인은 났는데 우리 서버가 응답을 못 받는 경우) 자동으로 재확인할 방법이 없고, 관리자 콘솔 확인 + 수동승인이 유일한 복구 수단이다.
- 구매 진입점은 `classDetail.html`과 `vodDetail.html`(`#pcBuyBtn`) 둘 다 실제 `vod_courses`에 연동되어 있다(`vodDetail_v2.html`만 아직 `href="#"` 정적 목업). 두 진입점 모두 `site-content.js`의 `wireVodCourseBuyButton()`을 공유하므로, 구매 버튼 관련 함수를 리네임/삭제할 때는 이 파일 하나만 보지 말고 `grep -r wireVodCourseBuyButton public-figma/`로 전체 호출부를 확인해야 한다(2026-08 orderConfirm.html 도입 때 `wireVodCoursePayment`를 지우면서 vodDetail.html 쪽 호출부를 놓쳐 구매 버튼이 죽었던 적이 있음).
