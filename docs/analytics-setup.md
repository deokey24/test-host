# 웹 분석·광고 전환 설정 가이드 (GTM / GA4 / 네이버 / Clarity / Meta)

작성일: 2026-10-14 · 대상: 원청(독편사) 마케팅 담당 + 개발사
관련 코드: `public-figma/analytics.js`(GTM/gtag/네이버/Clarity 로더 + `dtTrack`), 서버측 purchase 전송은 `lib/conversions.js`
설정 위치: **관리자 페이지 → 마케팅 → 분석 도구 설정** (2026-10-14부터. 코드 수정·배포 없이 저장 즉시(최대 1~6분) 반영)

## 0. 구조 요약

- 사이트 코드에는 ID가 없다. 관리자 "마케팅 → 분석 도구 설정"에 아래 값을 저장하면 서버가 `/analytics.js` 응답에 실어 보낸다
  (저장 후 최대 약 6분(서버 캐시 1분 + 브라우저 캐시 5분) 뒤 반영).

  | 관리자 입력칸 | 쓰이는 곳 | 폴백 env |
  |---|---|---|
  | GTM 컨테이너 ID (`GTM-XXXXXXX`) | 브라우저 — GTM 로드 | `GTM_CONTAINER_ID` |
  | GA4 측정 ID (`G-XXXXXXX`) | 브라우저(GTM이 없을 때 gtag.js 직접 로드) + 서버 purchase 전송 | `GA4_MEASUREMENT_ID` |
  | GA4 API Secret | 서버 purchase 전송 전용(브라우저로 나가지 않음) | `GA4_API_SECRET` |
  | Meta 픽셀 ID | 서버 purchase 전송(브라우저 픽셀은 GTM 태그로) | `META_PIXEL_ID` |
  | Meta 전환 API 토큰 | 서버 purchase 전송 전용 | `META_CAPI_ACCESS_TOKEN` |
  | 네이버 애널리틱스 ID | 브라우저 — `wcslog.js` 직접 주입 | `NAVER_WCS_ID` |
  | Clarity 프로젝트 ID | 브라우저 — Clarity 스니펫 직접 주입 | `CLARITY_PROJECT_ID` |

  관리자 칸이 비어 있으면 운영서버 `.env`의 같은 의미 변수를 쓴다(폴백). 둘 다 비면 해당 도구는 no-op이고 `window.dataLayer`에 이벤트만 쌓인다(에러 없음).
  비밀값(API Secret·토큰)은 저장 후 화면에 `••••끝4자`로만 보이며, 빈 칸으로 저장하면 기존 값이 유지된다.
- **권장 구성은 GTM**: GTM ID를 넣고 GA4·Meta 픽셀·카카오 픽셀은 GTM 안에서 태그로 추가한다(코드 배포 없이 켜고 끈다).
  GTM 없이 GA4 측정 ID만 넣으면 사이트가 gtag.js를 직접 로드하고 아래 퍼널 이벤트를 `gtag('event', ...)`로도 보낸다.
- **네이버 애널리틱스·Clarity는 관리자 칸 또는 GTM 태그 중 한 곳에만** 넣는다. 관리자 칸에 ID가 있으면 GTM 유무와 무관하게 사이트가 직접 주입하므로, GTM에도 같은 태그(5-1, 5-2)를 넣으면 **중복 집계**된다.
- 페이지 코드는 퍼널 이벤트를 `window.dtTrack(name, params)`로 `dataLayer`에 push 한다.
  전자상거래 이벤트는 같은 값을 최상위 키(`value`, `items` …)와 `ecommerce` 객체 양쪽에 넣는다.
  그래서 GA4 이벤트 태그의 "전자상거래 데이터 보내기(Send Ecommerce data)" 옵션과 데이터 영역 변수를 둘 다 쓸 수 있다.
  직전 전자상거래 값이 섞이지 않도록 이벤트 직전에 `{ecommerce: null}`이 먼저 push 된다.

### 사이트가 보내는 이벤트

| 이벤트 | 발생 시점 | 파라미터 |
|---|---|---|
| `sign_up` | 회원가입 성공(join.html) | `method:'email'`, `signup_channel`(가입경로 체크값을 `\|`로 연결) |
| `login` | 로그인 모달에서 로그인 성공(auth.js) | `method:'email'` |
| `view_item` | 강좌 상세(classDetail.html / vodDetail.html)에서 강좌 데이터 수신 직후 | `currency:'KRW'`, `value`, `items[]` |
| `begin_checkout` | 주문확인(orderConfirm.html) "결제하기" → 수강기간 확인 후, 결제 준비 요청 직전 | `currency`, `value`(쿠폰 적용 후 최종금액), `coupon`(선택 시 쿠폰 코드 — 서버 purchase의 `coupon`과 동일 값), `items[]` |
| `purchase` | 결제완료(paymentComplete.html) 성공 화면. 주문번호당 브라우저 1회(localStorage `dt_purchase_<주문번호>`) | `transaction_id`(주문번호), `currency`, `value`, `items[]` |

`items[]` = `[{item_id: 강좌ID(문자열), item_name: 강좌명, price, quantity: 1}]`

서버도 결제 승인 시점에 GA4 Measurement Protocol·Meta 전환 API로 같은 주문번호의 `purchase`를 보낸다(브라우저 누락 보완, 6장 dedup 참고).

## 1. 계정 소유권 절차 (원청 계정으로 만들고 개발사는 권한만 받기)

광고·분석 계정은 **원청(독편사) 계정이 소유자**여야 한다. 개발사 계정으로 만들면 계약이 끝날 때 데이터와 전환 이력을 넘길 수 없다.

1. **Google 계정**: 원청 대표 메일(공용 계정 권장)로 로그인한다.
2. **GA4**: analytics.google.com → 관리 → 계정 만들기(계정명 "독편사") → 속성 만들기(시간대 대한민국, 통화 KRW) → 웹 데이터 스트림 `https://dockteacher.co.kr` 추가 → **측정 ID(G-XXXXXXX)** 확인.
   - 관리 → 계정 액세스 관리 → 개발사 메일을 **편집자**로 추가.
   - 서버 전송용: 데이터 스트림 → Measurement Protocol API 비밀번호 → 만들기. 값은 관리자 "마케팅 → 분석 도구 설정"의 **GA4 API Secret** 칸에 직접 입력한다(메신저·메일로 평문 전달 지양).
3. **GTM**: tagmanager.google.com → 계정 만들기(계정 "독편사", 컨테이너 `dockteacher.co.kr`, 타깃 "웹") → **컨테이너 ID(GTM-XXXXXXX)** 를 개발사에 전달한다.
   - 관리 → 사용자 관리 → 개발사 메일 추가: 계정 권한 "사용자", 컨테이너 권한 "게시(Publish)".
   - 관리자 "마케팅 → 분석 도구 설정"의 **GTM 컨테이너 ID** 칸에 저장한다(코드 수정·배포 불필요).
4. **네이버 애널리틱스**: analytics.naver.com → 원청 네이버 계정으로 사이트 등록 → **사이트 ID**(`wcs_add["wa"]` 값) 확인 → 관리자 **네이버 애널리틱스 ID** 칸에 저장(또는 GTM 5-1 태그 — 둘 중 하나만). 필요하면 사이트 관리의 권한 위임으로 개발사 계정을 추가한다.
5. **MS Clarity**: clarity.microsoft.com → 원청 계정으로 프로젝트 생성 → Settings → Overview의 **Project ID** 확인 → 관리자 **Clarity 프로젝트 ID** 칸에 저장(또는 GTM 5-2 태그 — 둘 중 하나만) → Team에서 개발사를 Admin으로 초대.
6. **Meta(페이스북) 픽셀**: business.facebook.com(원청 비즈니스 관리자) → 이벤트 관리자 → 데이터 소스 연결 → 웹 → **픽셀 ID** 확인.
   - 비즈니스 설정 → 파트너 → 개발사 비즈니스에 픽셀 자산 공유.
   - 서버 전송용: 이벤트 관리자 → 픽셀 → 설정 → 전환 API → 액세스 토큰 생성 → 관리자 **Meta 픽셀 ID**·**Meta 전환 API 토큰** 칸에 저장.
7. **카카오 픽셀**(선택): 카카오 비즈니스 → 픽셀&SDK 생성 → 트랙 ID. 서버 전환 API는 범위 밖이라 브라우저 태그만 쓴다.

## 2. GTM 변수 (데이터 영역 변수)

변수 → 사용자 정의 변수 → 새로 만들기 → "데이터 영역 변수", 데이터 영역 버전 2.

| 변수 이름 | 데이터 영역 변수 이름 | 용도 |
|---|---|---|
| `DLV - value` | `value` | 금액 |
| `DLV - currency` | `currency` | 통화(KRW) |
| `DLV - items` | `items` | 상품 배열 |
| `DLV - transaction_id` | `transaction_id` | 주문번호(purchase) |
| `DLV - coupon` | `coupon` | 쿠폰(begin_checkout) |
| `DLV - method` | `method` | 가입/로그인 방식 |
| `DLV - signup_channel` | `signup_channel` | 가입 경로 |
| `DLV - item_id` | `items.0.item_id` | Meta/카카오용 상품 ID |
| `CONST - GA4 ID` | (상수 변수) `G-XXXXXXX` | GA4 측정 ID |

## 3. GTM 트리거

| 트리거 이름 | 유형 | 조건 |
|---|---|---|
| `All Pages` | 페이지뷰(기본 제공) | 모든 페이지 |
| `CE - sign_up` | 맞춤 이벤트 | 이벤트 이름 `sign_up` |
| `CE - login` | 맞춤 이벤트 | 이벤트 이름 `login` |
| `CE - view_item` | 맞춤 이벤트 | 이벤트 이름 `view_item` |
| `CE - begin_checkout` | 맞춤 이벤트 | 이벤트 이름 `begin_checkout` |
| `CE - purchase` | 맞춤 이벤트 | 이벤트 이름 `purchase` |

## 4. GTM 태그

| 태그 | 유형 | 설정 | 트리거 |
|---|---|---|---|
| GA4 - 구성 | Google 태그 | 태그 ID `{{CONST - GA4 ID}}` | All Pages |
| GA4 - sign_up | GA4 이벤트 | 이벤트 이름 `sign_up`, 매개변수 `method={{DLV - method}}`, `signup_channel={{DLV - signup_channel}}` | CE - sign_up |
| GA4 - login | GA4 이벤트 | 이벤트 이름 `login`, 매개변수 `method={{DLV - method}}` | CE - login |
| GA4 - view_item | GA4 이벤트 | 이벤트 이름 `view_item`, 추가 설정 → **전자상거래 데이터 보내기** 체크(데이터 소스: 데이터 영역) | CE - view_item |
| GA4 - begin_checkout | GA4 이벤트 | 이벤트 이름 `begin_checkout`, 전자상거래 데이터 보내기 체크 | CE - begin_checkout |
| GA4 - purchase | GA4 이벤트 | 이벤트 이름 `purchase`, 전자상거래 데이터 보내기 체크 | CE - purchase |
| 네이버 애널리틱스 | 맞춤 HTML | 5-1 | All Pages |
| MS Clarity | 맞춤 HTML | 5-2 | All Pages |
| Meta 픽셀 - 기본 | 맞춤 HTML | 5-3 | All Pages |
| Meta 픽셀 - Purchase | 맞춤 HTML | 5-3 (eventID 포함) | CE - purchase |

"전자상거래 데이터 보내기" 대신 매개변수를 직접 매핑해도 된다: `currency={{DLV - currency}}`, `value={{DLV - value}}`, `items={{DLV - items}}`, `transaction_id={{DLV - transaction_id}}`, `coupon={{DLV - coupon}}`.

GA4 관리 → 이벤트(키 이벤트)에서 `purchase`, `sign_up`, `begin_checkout`을 **키 이벤트로 표시**한다.

## 5. 맞춤 HTML 태그 본문

### 5-1. 네이버 애널리틱스 (All Pages)

> 관리자 "네이버 애널리틱스 ID" 칸을 쓰면 이 태그는 만들지 않는다(중복).

```html
<script type="text/javascript" src="//wcs.naver.net/wcslog.js"></script>
<script type="text/javascript">
  if (!wcs_add) var wcs_add = {};
  wcs_add["wa"] = "네이버_사이트_ID";
  if (window.wcs) { wcs_do(); }
</script>
```

네이버 검색광고 전환 추적을 쓰면, 네이버 광고 관리자가 안내하는 구매 전환 스크립트를 CE - purchase 트리거에 별도 태그로 추가하고 금액에 `{{DLV - value}}`를 넣는다.

### 5-2. Microsoft Clarity (All Pages)

> 관리자 "Clarity 프로젝트 ID" 칸을 쓰면 이 태그는 만들지 않는다(중복).

```html
<script type="text/javascript">
  (function(c,l,a,r,i,t,y){
    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
  })(window, document, "clarity", "script", "CLARITY_PROJECT_ID");
</script>
```

Clarity 설정의 Masking은 "Balanced" 이상으로 유지한다(회원정보 입력 화면 텍스트 마스킹).

### 5-3. Meta 픽셀 — 기본 + Purchase (eventID로 중복 제거)

기본 태그(All Pages):

```html
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', 'META_PIXEL_ID');
fbq('track', 'PageView');
</script>
```

Purchase 태그(CE - purchase). 고급 설정 → 태그 순서 지정에서 "Meta 픽셀 - 기본"이 먼저 실행되게 한다.

```html
<script>
  fbq('track', 'Purchase', {
    value: {{DLV - value}},
    currency: 'KRW',
    content_ids: [{{DLV - item_id}}],
    content_type: 'product'
  }, { eventID: {{DLV - transaction_id}} });
</script>
```

GTM 맞춤 HTML 안의 `{{변수}}`는 문자열이면 따옴표가 붙은 JS 값으로 들어간다.

필요하면 `view_item` → `fbq('track','ViewContent',...)`, `begin_checkout` → `fbq('track','InitiateCheckout',...)`, `sign_up` → `fbq('track','CompleteRegistration')`도 같은 방식으로 추가한다.

## 6. 중복 제거(dedup) 원리

| 채널 | 브라우저 | 서버 | 중복 제거 키 |
|---|---|---|---|
| GA4 | GTM `purchase` 이벤트 | Measurement Protocol `purchase` | `transaction_id` = 주문번호. GA4는 transaction_id가 같은 구매를 중복 집계하지 않는다 |
| Meta | 픽셀 `Purchase` + `eventID` | 전환 API `event_id` | 브라우저 `eventID` = 서버 `event_id` = 주문번호, 이벤트 이름 `Purchase` 동일 |
| 카카오 | 픽셀만 | 없음 | — |

- 브라우저는 주문번호마다 1회만 보낸다(`localStorage['dt_purchase_<주문번호>']`). 새로고침·뒤로가기로 인한 중복을 막는다.
- 서버는 `payments.conversion_sent_at`으로 주문당 1회만 보낸다.
- 0원(쿠폰 전액) 주문도 결제완료 페이지로 이동하므로 브라우저 `purchase`(value 0)가 발생한다.
- Meta 픽셀 Purchase 태그에 **eventID를 빠뜨리면 Meta 구매가 2배로 잡힌다.** 반드시 넣는다.

## 7. 확인 방법

### 7-1. GTM 미리보기 + GA4 DebugView

1. GTM 작업공간 → **미리보기** → `https://dockteacher.co.kr` 입력 → Tag Assistant 창이 연결된다.
2. 사이트에서 강좌 상세 → 주문확인 순으로 이동한다(실결제 테스트는 원청 승인 하에서만). 좌측 타임라인에 `view_item`, `begin_checkout`(, `purchase`)가 보이고, 각 이벤트의 "Tags Fired"에 GA4 이벤트 태그가 있어야 한다. "Data Layer" 탭에서 `value`·`items` 값을 확인한다.
3. GA4 → 관리 → 데이터 표시 → **DebugView**: 미리보기 세션의 기기가 나타나고 이벤트가 실시간으로 쌓인다. 이벤트를 클릭해 `transaction_id`, `value`, `currency`, items 매개변수를 확인한다.
4. 확인이 끝나면 GTM **제출 → 게시**. 게시 전에는 실사용자에게 태그가 나가지 않는다.
5. GA4 표준 보고서 반영은 24~48시간 걸린다(실시간 보고서는 즉시).

### 7-2. 코드만 빠르게 확인(개발자)

브라우저 콘솔에서 `window.DT_ANALYTICS_CONFIG`로 서버가 내려준 ID(`gtmId`, `ga4MeasurementId`, `naverWcsId`, `clarityId`)를 확인하고, `window.dataLayer`를 출력하면 위 이벤트가 쌓여 있다(ID가 비어 있어도 동작). 설정 저장 직후 값이 안 바뀌면 캐시(서버 60초 + 브라우저 5분)를 기다리거나 강력 새로고침한다.

### 7-3. Meta

이벤트 관리자 → 테스트 이벤트 → 사이트 URL 열기 → Purchase가 "브라우저"와 "서버"로 들어오고 "중복 제거됨"으로 표시되는지 확인한다. 서버 이벤트는 실제 주문에서만 발생하므로 테스트 일정은 원청과 협의한다.

### 7-4. 서버측 전송

관리자 "마케팅 → 분석 도구 설정"의 GA4 측정 ID+API Secret, Meta 픽셀 ID+전환 API 토큰(칸이 비면 운영서버 `.env`의 `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN` 폴백). 채널별로 두 값이 다 없으면 해당 채널은 전송하지 않는다. 관리자 "마케팅 → 전환 전송 상태"에서 최근 승인 결제의 전송 시각을 보고 "재전송"으로 다시 보낼 수 있다. `CONVERSION_DEBUG=1`이면 GA4는 검증용 엔드포인트(`/debug/mp/collect`)로 보내고 검증 결과를 서버 로그에 출력한다(검증이 끝나면 제거).

## 8. 개인정보처리방침 추가 문구 초안 (원청·법무 확인 필요, 사이트 미반영)

> **제X조 (행태정보의 수집·이용 및 거부 등에 관한 사항)**
>
> ① 회사는 서비스 이용 분석 및 맞춤형 광고 제공을 위해 아래와 같이 행태정보를 수집·이용합니다.
>
> | 수집 주체 | 수집 항목 | 수집 방법 | 이용 목적 | 보유·이용 기간 |
> |---|---|---|---|---|
> | Google(Google Analytics 4, Google Tag Manager) | 웹사이트 방문 기록, 이용 페이지, 이벤트(회원가입·로그인·상품 조회·결제 진행·결제 완료), 기기·브라우저 정보, 쿠키 식별자 | 쿠키 및 스크립트, 서버 간 전송 | 서비스 이용 통계 분석, 서비스 개선, 광고 성과 측정 | 수집일로부터 14개월 |
> | NAVER(네이버 애널리틱스) | 방문 기록, 유입 경로, 기기 정보 | 쿠키 및 스크립트 | 이용 통계 분석, 검색광고 성과 측정 | 네이버 정책에 따름 |
> | Microsoft(Clarity) | 화면 이용 행태(클릭·스크롤·마우스 이동), 기기 정보 (입력값은 마스킹) | 쿠키 및 스크립트 | 사용성 개선 | 최대 13개월 |
> | Meta Platforms(Meta 픽셀·전환 API), Kakao(카카오 픽셀) | 방문·결제 이벤트, 쿠키 식별자, 기기 정보, IP 주소, 결제 완료 시 일방향 암호화(SHA-256 해시)한 이메일·휴대전화번호 | 쿠키 및 스크립트, 서버 간 전송 | 광고 성과 측정, 맞춤형 광고 제공 | 각 사 정책에 따름 |
>
> ② 회사는 결제 완료 시 광고 성과 측정을 위해 주문번호·결제금액·강좌 정보와 일방향 암호화(해시)한 이메일·휴대전화번호를 Meta Platforms, Inc.에 전송할 수 있으며, 해당 정보는 국외(미국)에서 처리됩니다. [국외 이전 고지 항목: 이전받는 자, 이전 국가, 이전 일시·방법, 이전 항목, 이용 목적, 보유 기간 — 원청 확인 후 기재]
>
> ③ 이용자는 웹브라우저의 쿠키 설정을 변경하여 행태정보 수집을 거부할 수 있습니다. (Chrome: 설정 > 개인정보 및 보안 > 서드파티 쿠키 / Safari: 설정 > 개인정보 보호 / Edge: 설정 > 쿠키 및 사이트 권한) 다만 쿠키 저장을 거부하면 로그인 유지 등 일부 서비스 이용이 어려울 수 있습니다. Google 애널리틱스 수집은 Google 애널리틱스 차단 브라우저 부가기능(https://tools.google.com/dlpage/gaoptout)으로도 거부할 수 있습니다.
>
> ④ 행태정보 관련 문의는 개인정보 보호책임자에게 연락하시기 바랍니다.

확인 필요: 보유기간(GA4 속성의 데이터 보존 기간 설정값과 일치), 국외 이전 고지 범위, 마케팅 수신 동의와의 관계, 시행일.
