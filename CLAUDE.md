# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

독편사편입논술학원(DOCKTEACHER) 홈페이지. 프론트엔드는 HTML/CSS/JS로 구성된 정적 SPA이며, Node.js(Express) 서버가 `/`에서 정적 사이트를 서빙하고 `/admin`에 비밀번호로 보호되는 관리자 페이지를 제공.

## Development

```bash
npm install
npm start   # http://localhost:3000
```

`PORT`, `ADMIN_PASSWORD`, `SESSION_SECRET` 환경변수로 설정 오버라이드 가능 (기본 비밀번호: `dockAdmin`).

## Architecture

### 파일 구조

- `server.js` — Express 서버. `/admin`은 세션 기반 비밀번호 인증
- `admin/login.html`, `admin/index.html` — 관리자 로그인 폼 / 인증 후 빈 페이지 (정적 서빙 대상 아님, `server.js`가 직접 `sendFile`)
- **실제 라이브 사이트는 `public-figma/`가 `/`에 서빙된다.** 구 사이트(`public/`)는 `/v1` 경로로만 남아있음(`app.use('/v1', express.static('public'))`) — `public/index.html`·`public/script.js`를 고치는 건 `/v1`에만 영향을 주고 실제 사용자가 보는 페이지에는 영향이 없으니 혼동 주의.
- `public/index.html` — (구 v1 사이트) 모든 페이지 마크업 + 페이지별 CSS (`<style>` 블록)
- `public/style.css` — (구 v1 사이트) 네비게이션, 전역 레이아웃, 기본 컴포넌트 스타일
- `public/script.js` — (구 v1 사이트) 모든 JS 로직 (하드코딩된 데이터 포함)
- `public/images/` — 슬라이더용 이미지
- `public-figma/` — **현재 라이브 사이트**. `lecturePlayer.html` + `site-content.js`가 실제 강의 재생 페이지/로직을 담당(HLS 재생, hls.js 포함)

### 관리자 페이지 (`/admin`)

세션 쿠키(`express-session`) 기반 비밀번호 인증. `GET /admin`은 미인증 시 로그인 폼, 인증 시 관리자 화면을 반환. `POST /admin/login`으로 비밀번호(`dockAdmin`) 확인 후 세션에 `isAdmin` 플래그 설정, `POST /admin/logout`으로 세션 파기.

### 대용량 영상 업로드 파이프라인

관리자 페이지에서 20~30GB급 강의 영상을 업로드 → ffmpeg로 HLS(`master.m3u8` + `segmentNNNNN.ts`) 트랜스코딩 → Cloudflare R2 저장 → 경로를 MySQL에 기록하는 별도 파이프라인. 상세 설계는 `infra/README.md`와 바탕화면 `영상업로드-아키텍처.md` 참고.

- `lib/` — 운영 서버(`server.js`)가 쓰는 R2 presigned URL(`r2.js`, PUT/GET 프리사인 + 프리픽스 일괄 삭제), SQS 발행(`sqs.js`), 워커 ASG 스케일아웃(`asg.js`), MySQL(`db.js`) 헬퍼
- `admin/index.html` — 파일 선택 → R2 멀티파트 presigned URL로 브라우저가 R2에 직접 업로드 → 완료 시 SQS에 작업 발행
- `worker/` — 골든 AMI로 구워 ASG(min=0, max=3)로 운영되는 독립 Node 프로젝트. SQS 컨슈머, ffmpeg HLS 트랜스코딩(동시 5개 캡핑), R2에 `hls/<uuid>-title/` 프리픽스로 재업로드, DB 갱신, 유휴 시 ASG를 통해 자기 자신 terminate. 스케일아웃은 운영 서버가 presign/complete 시점에 desired capacity를 올려서 수행. 상세 설계: `infra/autoscaling-design.md`
- `infra/` — IAM 정책, AWS CLI 프로비저닝 스크립트(`provision-asg.sh`), MySQL 스키마, systemd 유닛, 골든 AMI 셋업(`install-worker-instance.sh`)·부팅 user-data(`worker-user-data.sh`) 스크립트
- 운영 서버와 워커 인스턴스는 원본 대용량 파일이 오가지 않도록 분리되어 있고 (브라우저 ↔ R2 직접 통신), 완료 신호는 SQS 메타데이터만 오간다
- **재생 접근 제어**: HLS 영상은 R2 커스텀 도메인(`cdn.dockteacher.co.kr`)에 공개 서빙하지 않는다 (`hls/` 프리픽스는 Cloudflare WAF 커스텀 규칙으로 공개 차단됨). 대신 회원 세션 인증된 `/api/stream/class-lecture/:lectureId/master.m3u8`, `/api/stream/vod-lecture/:lectureId/master.m3u8`(`server.js`)가 매 요청마다 세그먼트 줄을 R2 프리사인 GET URL(`STREAM_URL_TTL_SECONDS`, 기본 6시간)로 치환한 매니페스트를 내려준다. 레거시로 이미 mp4로 인코딩된 영상(`final_r2_key`가 `.mp4`)은 하위호환을 위해 그대로 공개 CDN URL로 서빙.
- **공개 영상(`lecture_videos.is_public`)**: 로그인 없이 열리는 영상은 vod.html 상단 인트로 하나뿐이다(`/api/stream/vod-intro/*`). 어떤 영상인지는 `site_sections`(vod/intro)가 정하고, "공개해도 되는가"의 최종 권한은 `is_public` 플래그가 갖는다(매니페스트·키 라우트 둘 다 `is_public = 1`을 요구). 관리자가 "VOD 강좌 → VOD 페이지 인트로"를 저장할 때마다 `syncPublicIntroVideo()`(`server.js`)가 **고른 영상만 1, 나머지는 전부 0**으로 맞추므로 영상을 교체하면 직전 영상은 즉시 다시 잠긴다. 공개 노출 자리가 늘어나면 이 "나머지 전부 0" 규칙부터 손봐야 한다.
- **AES-128 세그먼트 암호화**: 워커가 인코딩 시 영상별 랜덤 16바이트 키로 세그먼트를 암호화(`worker/src/transcode.js`, `-hls_key_info_file`). 키는 R2에 절대 올리지 않고 `lecture_videos.hls_key_base64` 컬럼에만 저장. 매니페스트의 `#EXT-X-KEY` URI는 서버가 `signKeyUrl()`(`server.js`)로 서명한 `.../key?exp=<unix ts>&sig=<hmac>` 형태로 치환해서 내려준다 — 키 라우트 자체는 세션/토큰 인증이 아니라 `verifySignedKeyUrl()`의 exp+HMAC 검증만 통과하면 응답한다(세그먼트가 이미 R2 프리사인 절대 URL로 "자체완결적"인 것과 동일한 이유: 매니페스트 발급 시 이미 enrollment를 확인했고, 네이티브 HLS 플레이어 엔진(AVPlayer/ExoPlayer, 일렉트론)은 매니페스트 안의 URI를 직접 요청하므로 커스텀 인증 헤더를 실을 수 없음). 캐주얼한 세그먼트 다운로더 도구를 막는 용도이며 정식 DRM은 아님(권한 있는 클라이언트는 키도 그대로 받아감).

### 네이티브 앱(일렉트론/RN) API — `/api/v1/*`

일렉트론 데스크톱 플레이어(추후 React Native로 iOS/Android 재사용 예정)를 위한 별도 API 네임스페이스. 기존 웹의 `express-session`(인메모리 MemoryStore, 서버 재시작 시 전부 로그아웃됨)과 완전히 분리된 DB 기반 opaque Bearer 토큰 인증을 쓴다. **VOD 강좌(`vod_course_lectures`)만 지원, class 강의는 아직 없음.**

- **`api_tokens` 테이블**(`infra/schema.sql`) — `member_id`, `device_id`, `token_hash`(원본 토큰의 SHA-256, 원본은 저장 안 함), `platform`(`electron`/`ios`/`android`). `member_devices.token_id`가 이 테이블을 참조 — 마이페이지에서 기기를 삭제하면 대응하는 `api_tokens` 행도 같이 삭제되어 즉시 토큰이 무효화됨(`DELETE /api/members/devices/:id`).
- **`requireApiToken`/`hashApiToken`**(`server.js`) — `Authorization: Bearer <token>` 검증 미들웨어, `req.memberId`/`req.apiTokenId` 설정. **`requireMemberOrApiToken`**은 세션 쿠키와 Bearer 토큰을 모두 받아 `req.memberId`로 통일하는 이중 인증 미들웨어(`/api/stream/vod-lecture/:id/master.m3u8`에 적용 — 웹 플레이어와 네이티브 앱이 같은 라우트를 공유).
- **라우트**: `POST /api/v1/auth/login`(`{username,password,deviceId,platform}` → `registerMemberDevice()` 재사용 후 토큰 발급) · `POST /api/v1/auth/logout` · `GET /api/v1/me` · `GET /api/v1/courses` · `GET /api/v1/courses/:id/lectures` · `GET /api/v1/lectures/:id/playback`(`{kind:"hls"|"mp4", url}` 반환, HLS면 기존 `/api/stream/vod-lecture/:id/master.m3u8` 재사용).
- **공용 헬퍼** `getMemberVodCourses()`/`getVodCourseLectures()`(`server.js`) — 웹 라우트(`/api/members/my-vod-courses`, `/api/members/my-vod-lectures/:id`)와 `/api/v1/*`가 SQL/enrollment 체크 로직을 공유, 응답 모양만 다르게 조립.
- 클라이언트 가이드: 일렉트론은 `keytar`/`safeStorage`로 토큰 보관 + `<video>`+hls.js(웹과 동일한 `attachVideoSource` 패턴 재사용 가능), RN은 `react-native-keychain` + `react-native-video`(네이티브 디코더가 HLS+AES-128 직접 처리, hls.js 불필요). 둘 다 재생 직전 `/api/v1/lectures/:id/playback` 호출, 매니페스트 URL 미리 캐싱 안 함.

### SPA 페이지 전환 방식

모든 페이지는 `<div id="페이지명" class="page">` 구조. JS의 `showPage(id)` 함수가 `.active` 클래스를 토글해 페이지를 전환함. 기본 활성 페이지는 `#home`.

**페이지 ID 목록:** `home`, `notice`, `classes`, `classDetail`, `textbook`, `lecture`, `lecturePlayer`, `myLectures`

### CSS 설계

CSS 변수가 두 곳에 선언되어 있어 주의 필요:

- `style.css :root` — `--black`, `--white`, `--gray-*`, `--font-kr`, `--nav-height`
- `index.html <style> :root` — `--gold`, `--gold-light`, `--gold-dark`, `--dark`, `--dark2`, `--gray`, `--light-gray`

페이지별 스타일은 `index.html` 내 인라인 `<style>` 블록에 작성. `style.css`는 전역 기반 스타일만 담당.

### JavaScript 주요 함수 (script.js)

- `loadLectureVideo(lectureNum)` — 강의 번호로 영상 로드 및 재생
- `attachVideoSource(videoEl, url)` — HLS(.m3u8)/레거시 mp4 공용 재생 헬퍼. HLS면 hls.js(`window.Hls`)로 attachMedia, Safari는 네이티브, 아니면 `<source>`에 직접 대입
- `renderReviews()` / `renderCards()` — 무한 슬라이더용 카드 2배 복제 렌더링
- `renderFaq()` — FAQ 아코디언 동적 생성
- `initHamburger()` — 모바일 햄버거 메뉴
- `doLogin()` / `doLogout()` — 로그인 UI 토글 (더미)

### 데이터

수강신청 클래스 카드는 MySQL `classes` 테이블에서 로드(`GET /api/classes`, `script.js`의 `renderClassCards()`), 관리자 페이지 "클래스 관리" 섹션에서 CRUD. DB 미연결 시 `index.html`의 하드코딩 카드 9개가 폴백으로 유지됨.

나머지 콘텐츠(강의 영상, 수강 후기, FAQ)는 `script.js` 상단 상수 배열에 하드코딩:
- `lectureVideos` — 강의 영상 URL 목록
- `reviews`, `reviewData` — 수강 후기
- `faqData` — FAQ 항목

### 반응형 브레이크포인트

`max-width: 900px`, `600px`, `560px`, `480px` 순으로 적용.

### 외부 리소스

- 폰트: SUIT (CDN), Noto Serif KR, Nanum Brush Script (Google Fonts)
- 영상/이미지 CDN: `img.wecandoeat.com`
- OG 이미지: `https://dockteacher.co.kr/assets/og/dockpass-og-dark.png` (`public-figma/assets/og/dockpass-og-dark.png`)
- HLS 재생: hls.js (jsDelivr CDN, `index.html`에서 `script.js`보다 먼저 로드)

## Git

**커밋은 요청 시 자유롭게 할 수 있지만, `git push`는 사용자가 `git-push`라고 명시적으로 입력한 경우에만 실행한다. 그 전까지는 로컬 커밋만 하고 원격 저장소에 반영하지 않는다.**

**`main` 푸시는 곧 실서비스 배포다.** GitHub 웹훅이 실서버의 `deploy.sh`를 호출해 `origin/main`을 체크아웃하고 PM2를 리로드한다(상세: `infra/auto-deploy.md`). 스키마 변경이 섞인 배포는 DB 마이그레이션을 별도로 적용해야 한다.

## 실서버 (Production)

**원격 서버 작업은 사용자가 명시적으로 요청한 경우에만 수행한다. 코드 수정, 배포, 테스트 등 어떤 작업도 요청 없이 실서버에 적용하지 않는다.**

- **도메인**: `https://dockteacher.co.kr`
- **IP**: `54.116.171.96`
- **서버**: AWS EC2 Ubuntu, nginx
- **웹 루트**: `/home/ubuntu/test-host/`
- **SSH**: `ssh -i dockteacher-web.pem ubuntu@54.116.171.96`
- **HTTPS**: Let's Encrypt 인증서 적용 (만료 2026-09-21, 자동 갱신)
