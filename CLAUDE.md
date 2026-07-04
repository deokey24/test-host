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

- `server.js` — Express 서버. `/`는 `public/` 정적 서빙, `/admin`은 세션 기반 비밀번호 인증
- `admin/login.html`, `admin/index.html` — 관리자 로그인 폼 / 인증 후 빈 페이지 (정적 서빙 대상 아님, `server.js`가 직접 `sendFile`)
- `public/index.html` — 모든 페이지 마크업 + 페이지별 CSS (`<style>` 블록)
- `public/style.css` — 네비게이션, 전역 레이아웃, 기본 컴포넌트 스타일
- `public/script.js` — 모든 JS 로직 (하드코딩된 데이터 포함)
- `public/images/` — 슬라이더용 이미지

### 관리자 페이지 (`/admin`)

세션 쿠키(`express-session`) 기반 비밀번호 인증. `GET /admin`은 미인증 시 로그인 폼, 인증 시 관리자 화면을 반환. `POST /admin/login`으로 비밀번호(`dockAdmin`) 확인 후 세션에 `isAdmin` 플래그 설정, `POST /admin/logout`으로 세션 파기.

### 대용량 영상 업로드 파이프라인

관리자 페이지에서 20~30GB급 강의 영상을 업로드 → ffmpeg 압축 → Cloudflare R2 저장 → 경로를 MySQL에 기록하는 별도 파이프라인. 상세 설계는 `infra/README.md`와 바탕화면 `영상업로드-아키텍처.md` 참고.

- `lib/` — 운영 서버(`server.js`)가 쓰는 R2 presigned URL(`r2.js`), SQS 발행(`sqs.js`), 워커 기동(`ec2.js`), MySQL(`db.js`) 헬퍼
- `admin/index.html` — 파일 선택 → R2 멀티파트 presigned URL로 브라우저가 R2에 직접 업로드 → 완료 시 SQS에 작업 발행
- `worker/` — 별도 EC2 인스턴스에 배포되는 독립 Node 프로젝트. SQS 컨슈머, ffmpeg 압축(동시 5개 캡핑), R2 재업로드, DB 갱신, 유휴 시 자기 자신 `stop-instances`
- `infra/` — IAM 정책, AWS CLI 프로비저닝 스크립트, MySQL 스키마, systemd 유닛, 워커 인스턴스 부트스트랩 스크립트
- 운영 서버와 워커 인스턴스는 원본 대용량 파일이 오가지 않도록 분리되어 있고 (브라우저 ↔ R2 직접 통신), 완료 신호는 SQS 메타데이터만 오간다

### SPA 페이지 전환 방식

모든 페이지는 `<div id="페이지명" class="page">` 구조. JS의 `showPage(id)` 함수가 `.active` 클래스를 토글해 페이지를 전환함. 기본 활성 페이지는 `#home`.

**페이지 ID 목록:** `home`, `notice`, `classes`, `classDetail`, `textbook`, `lecture`, `lecturePlayer`, `myLectures`

### CSS 설계

CSS 변수가 두 곳에 선언되어 있어 주의 필요:

- `style.css :root` — `--black`, `--white`, `--gray-*`, `--font-kr`, `--nav-height`
- `index.html <style> :root` — `--gold`, `--gold-light`, `--gold-dark`, `--dark`, `--dark2`, `--gray`, `--light-gray`

페이지별 스타일은 `index.html` 내 인라인 `<style>` 블록에 작성. `style.css`는 전역 기반 스타일만 담당.

### JavaScript 주요 함수 (script.js)

- `loadLectureVideo(lectureNum)` — 강의 번호로 MP4 영상 로드 및 재생
- `renderReviews()` / `renderCards()` — 무한 슬라이더용 카드 2배 복제 렌더링
- `renderFaq()` — FAQ 아코디언 동적 생성
- `initHamburger()` — 모바일 햄버거 메뉴
- `doLogin()` / `doLogout()` — 로그인 UI 토글 (더미)

### 데이터

모든 콘텐츠(강의 목록, 수강 후기, FAQ)는 `script.js` 상단 상수 배열에 하드코딩:
- `lectureVideos` — 강의 영상 URL 목록
- `reviews`, `reviewData` — 수강 후기
- `faqData` — FAQ 항목

### 반응형 브레이크포인트

`max-width: 900px`, `600px`, `560px`, `480px` 순으로 적용.

### 외부 리소스

- 폰트: SUIT (CDN), Noto Serif KR, Nanum Brush Script (Google Fonts)
- 영상/이미지 CDN: `img.wecandoeat.com`
- OG 이미지: `https://img.wecandoeat.com/uploads/logo_resize.png`

## 실서버 (Production)

**원격 서버 작업은 사용자가 명시적으로 요청한 경우에만 수행한다. 코드 수정, 배포, 테스트 등 어떤 작업도 요청 없이 실서버에 적용하지 않는다.**

- **도메인**: `https://dockteacher.co.kr`
- **IP**: `54.116.171.96`
- **서버**: AWS EC2 Ubuntu, nginx
- **웹 루트**: `/home/ubuntu/test-host/`
- **SSH**: `ssh -i dockteacher-web.pem ubuntu@54.116.171.96`
- **HTTPS**: Let's Encrypt 인증서 적용 (만료 2026-09-21, 자동 갱신)
