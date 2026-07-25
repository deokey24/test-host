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
SDK가 PayupPaymentStandardForm      인증 완료 후 브라우저가
자동생성 + transactionId 삽입        returnUrl로 이동 (쿼리스트링에
   │ payupPaymentSubmit(form) 콜백     transactionId/orderNumber/amount)
   │ → form.action='/api/payments/approve'
   │ → form.submit() (풀 페이지 이동)      │ fetch POST /api/payments/approve-mobile
   ▼                                   ▼
[server] settlePayment() 공용 로직: payup.approvePayment() 호출(accessToken 자동
발급/캐싱) → 성공 시 payments.status='approved' + enrollMemberInVod(member, course,
'payment') 등록 → 실패 시 status='failed'
   │                                   │
   ▼                                   ▼
redirect: classDetail.html?id=X    JSON { ok, redirect } →
&payment=success|fail              클라이언트가 redirect로 이동
```

## 파일 위치

| 역할 | 파일 |
|---|---|
| accessToken 발급/캐싱, 결제 승인/취소 API 호출 | `lib/payup.js` |
| 결제 라우트 3개 (`init`/`approve`/`approve-mobile`), `settlePayment()` 공용 로직, `parseKoreanWonPrice`/`makeOrderNumber` | `server.js` — `enrollMemberInVod` 함수 바로 아래 |
| 결제 버튼(`#cdBuyBtn`), SDK 스크립트 태그, 결과 배너(`#cdPaymentNotice`) | `public-figma/classDetail.html` |
| 버튼 클릭 → `/api/payments/init` → `goPayupPay()`, `payupPaymentSubmit`/`payupPaymentClose` 콜백(SDK가 부르는 함수명 고정, 변경 금지) | `public-figma/site-content.js` — `wireVodCoursePayment`, `payupPaymentSubmit`, `payupPaymentClose` |
| 모바일 `returnUrl` 착지 페이지 (쿼리스트링 파싱 → approve-mobile 호출 → redirect) | `public-figma/payupReturn.html` |
| DB 테이블 정의 | `infra/schema.sql` — `payments` 테이블 |
| 테스트 결제 취소용 CLI | `scripts/cancel-payment.js` |

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
4. "결제하기" 클릭 → 실제 카드로 소액 결제 → `payment=success` 배너 확인.
5. 결제 취소(환불): `node --env-file-if-exists=.env scripts/cancel-payment.js <orderNumber> "사유"` — `payments.status='approved'`인 건만 취소 가능, 취소 후 `status='canceled'`로 갱신.

## 알려진 가정/한계

- **모바일 `returnUrl` 전달 방식**: 공식 문서에 정확한 전달 방식(쿼리스트링 vs POST 등) 명시가 없어서, 쿼리스트링(`?transactionId=&orderNumber=&amount=`)으로 온다고 가정하고 `payupReturn.html`을 만들었다. 실제 모바일 결제 테스트해보고 다르면 그 파일만 고치면 됨.
- **결제 취소/부분취소 API**(`/api/v1/cancel`, `/api/v1/partCancel`)는 `lib/payup.js`에 `cancelPayment()`만 구현했고, 서비스용 라우트(관리자 웹 UI에서 취소)는 아직 없음 — 지금은 `scripts/cancel-payment.js` CLI로만 가능.
- 구매 진입점이 `classDetail.html` 하나뿐. `vodDetail.html`은 아직 실제 강좌 id에 연동되지 않은 정적 목업이라 결제 버튼을 붙이지 않았다.
