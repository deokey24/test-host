# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

독편사편입논술학원(DOCKTEACHER) 홈페이지. 빌드 도구 없이 HTML/CSS/JS만으로 구성된 정적 SPA.

## Development

빌드 단계 없음. 정적 파일 서버로 바로 실행:

```bash
# 간단한 로컬 서버
python3 -m http.server 8080
# 또는
npx serve .
```

`index.html`을 브라우저에서 직접 열어도 동작하지만, 일부 리소스는 서버가 필요할 수 있음.

## Architecture

### 파일 구조

- `index.html` — 모든 페이지 마크업 + 페이지별 CSS (`<style>` 블록)
- `style.css` — 네비게이션, 전역 레이아웃, 기본 컴포넌트 스타일
- `script.js` — 모든 JS 로직 (하드코딩된 데이터 포함)
- `images/` — 슬라이더용 이미지

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
