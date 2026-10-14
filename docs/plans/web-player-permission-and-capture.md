# 웹 플레이어 회원별 허용(관리자 지정 + 서버 이중 검사) · 캡처 방지 옵션

작성일: 2026-10-15. 코드 조사 결과를 바탕으로 한 구현 계획(아직 구현 전).

## 0. 현재 상태 (조사 결과)

| 항목 | 위치 | 현재 동작 |
|---|---|---|
| 웹 플레이어 페이지 | `public-figma/lecturePlayer.html`, `site-content.js:890` `hydrateLecturePlayer()` | `/api/members/my-vod-lectures/:id` 성공 시 hls.js로 재생. 미등록이면 홈으로 리디렉션 |
| 마이페이지 "수강하기" | `public-figma/mypage.html:301` | `dockplayer://` 스킴 → 데스크톱 앱만 연다. 웹 플레이어 링크 없음 |
| 강좌 상세 커리큘럼 링크 | `site-content.js:553` | `has_video`면 **누구에게나** `lecturePlayer.html?id=&lecture=` 링크를 렌더링 → 수강 중인 회원은 지금도 웹에서 재생 가능 (UI만 숨긴 상태) |
| 매니페스트 라우트 | `server.js:552` `/api/stream/vod-lecture/:lectureId/master.m3u8` | `requireMemberOrApiToken`(세션 **또는** Bearer) + `checkVodAccess`(등록·만료·종료)만 검사. 세션/토큰 구분 없음 |
| 강의 목록 라우트 | `server.js:3019` `/api/members/my-vod-lectures/:vodCourseId` | `requireMember`(세션) + `checkVodAccess` |
| 키 라우트 | `server.js:571` `/key` | exp+HMAC 서명만 검증 (매니페스트 발급 시 권한 확인 완료 전제) |
| 회원 테이블 | `infra/schema.sql` `members` | 웹 재생 허용 플래그 없음 |
| 관리자 회원 상세 | `admin/members.js:209` `openMemberDetailModal`, `admin/index.html:1679` 모달 | 읽기 전용 필드 테이블 + 기기 목록 + 삭제. 회원 필드를 **수정하는 PUT 라우트가 없음** (enrollments/vod-enrollments/devices만 쓰기 가능) |
| DockPlayer(일렉트론) | `/api/v1/lectures/:id/playback` → 같은 매니페스트 라우트를 Bearer로 호출 | 이번 변경으로 **영향 받으면 안 됨** |

---

## 1. 설계 원칙

- **허용 단위는 회원(`members`)**. "특정 학생만 웹에서 보게" 라는 요구이므로 강좌별이 아니라 회원별 플래그 하나. 강좌별로 쪼개야 할 때는 `member_vod_enrollments`로 옮기면 되지만 지금은 과함.
- **이중 검사**: (1) UI는 `/api/members/me`가 내려주는 `webPlayer` 값으로 링크를 그리거나 숨기고, (2) 서버는 세션 인증으로 들어온 강의목록·매니페스트 요청마다 DB에서 플래그를 다시 읽어 403. UI를 우회해 URL을 직접 쳐도 서버에서 막힌다.
- **Bearer(DockPlayer) 경로는 플래그와 무관**. 세션으로 인증된 요청에만 플래그를 적용한다. 그래서 `requireMemberOrApiToken`이 인증 출처를 `req.authVia`로 남겨야 한다.
- 플래그는 세션에 캐시하지 않고 **매 요청 DB 조회**(members PK 조회 1회, 비용 무시 가능). 관리자가 끄면 다음 매니페스트 요청부터 즉시 차단. 단, 이미 발급된 세그먼트 프리사인 URL(`STREAM_URL_TTL_SECONDS`, 기본 6시간)은 만료 전까지 유효 — 재생 중인 영상 1편은 끝까지 볼 수 있고, 강의 전환·새로고침부터 막힌다. 더 빨리 끊고 싶으면 웹 세션 발급분만 TTL을 짧게(예: 1시간) 주는 옵션을 §3-3에 둔다.

---

## 2. DB

`infra/migrations/2026-10-15-members-web-player.sql` (신규) + `infra/schema.sql`의 `members` ALTER 블록에 같은 줄 추가:

```sql
-- 2026-10-15 관리자가 지정한 회원만 웹 브라우저 플레이어(lecturePlayer.html)로 재생 허용.
-- DockPlayer(Bearer 토큰) 재생에는 영향 없음. 0=웹 재생 불가(기본), 1=허용.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS web_player_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS web_player_updated_at DATETIME NULL;
```

- 실서버 적용은 배포와 별개로 수동(메모리 "스키마는 수동 적용" 규칙). 회원 삭제/익명화 코드(`DELETE /admin/api/members/:id`)는 컬럼을 명시 나열하지 않으므로 수정 불필요.
- `web_player_updated_at`은 관리자 감사용(언제 켰는지). 목록에 "허용일"로 보여줄 수 있다.

---

## 3. 서버 (`server.js`)

### 3-1. 인증 출처 표시
`requireMemberOrApiToken`(`server.js:193`)에서 세션 분기에 `req.authVia = 'session'`, `requireApiToken` 성공 시 `req.authVia = 'token'` 설정. (`requireApiToken` 안에서 `req.memberId`를 세팅하는 지점에 한 줄 추가.)

### 3-2. 플래그 검사 헬퍼
```js
// 웹 브라우저(세션) 재생은 관리자가 허용한 회원만. Bearer(DockPlayer)는 호출하지 않는다.
async function checkWebPlayerAllowed(memberId) {
  const [[row]] = await getPool().query('SELECT web_player_enabled FROM members WHERE id = ?', [memberId]);
  if (!row || !row.web_player_enabled) {
    return { ok: false, status: 403, reason: 'web_player_disabled', error: '웹 플레이어 이용 권한이 없습니다. DockPlayer 앱으로 시청해 주세요.' };
  }
  return { ok: true };
}
```

### 3-3. 적용 지점 (세션 경로만)
| 라우트 | 변경 |
|---|---|
| `GET /api/members/my-vod-lectures/:vodCourseId` (`:3019`) | `getVodCourseLectures` 호출 전에 `checkWebPlayerAllowed(req.session.memberId)` → 실패 시 `403 {error, reason:'web_player_disabled'}`. 기존 `expired`/`course_ended` reason과 같은 모양 |
| `GET /api/stream/vod-lecture/:lectureId/master.m3u8` (`:552`) | `checkVodAccess` 뒤에 `if (req.authVia === 'session') { const w = await checkWebPlayerAllowed(req.memberId); if (!w.ok) 403 }`. 토큰 경로는 그대로 |
| (선택) 같은 라우트의 `renderSignedManifest(..., ttlSeconds)` | 세션 경로면 `WEB_STREAM_URL_TTL_SECONDS`(env, 기본 3600) 사용해 권한 회수 지연을 1시간으로 단축. `signKeyUrl` TTL도 동일하게 |
| `GET /api/members/me` (`:2519`) | 로그인 시 `webPlayer: !!row.web_player_enabled` 추가. 현재 세션 값만 반환하므로 DB 조회 1회 추가(`SELECT web_player_enabled FROM members WHERE id=?`). 비로그인 응답은 그대로 |
| `GET /api/members/my-vod-courses` (`:3014`) | 응답을 `{ webPlayer, courses }`로 바꾸지 **말고**(마이페이지·v1 공용 헬퍼), 마이페이지가 `/api/members/me`로 따로 받게 둔다 |

`/key` 라우트, `/api/v1/*`, 진도 라우트(`/api/v1/progress`)는 손대지 않는다. 키 URL은 매니페스트 발급 시점에만 서명되므로 매니페스트에서 막히면 키도 못 받는다.

### 3-4. 관리자 API
- `GET /admin/api/members/:id` (`:1304`) SELECT에 `web_player_enabled, web_player_updated_at` 추가.
- `GET /admin/api/members` (`:1268`) 목록 SELECT에 `web_player_enabled` 추가(목록 배지용).
- 신규 `PUT /admin/api/members/:id/web-player` `requireAdminApi`, body `{ enabled: boolean }`:
  ```sql
  UPDATE members SET web_player_enabled = ?, web_player_updated_at = NOW()
  WHERE id = ? AND member_group <> 'withdrawn'
  ```
  affectedRows 0이면 404. 응답 `{ ok:true, web_player_enabled }`.
- (선택) 목록 필터 `?webPlayer=1` — 허용 회원만 보기. 1차에서는 배지만.

---

## 4. 관리자 UI (`admin/index.html`, `admin/members.js`)

회원 상세 모달(`index.html:1679`)의 "가입 시 유입" 위에 섹션 추가:

```html
<h3 style="margin:20px 0 6px;">웹 플레이어</h3>
<p class="field-hint" style="margin-bottom:10px;">
  켜면 이 회원은 마이페이지·강좌 상세에서 "웹에서 보기"가 나타나고 브라우저에서 바로 재생할 수 있습니다.
  끄면 DockPlayer 앱으로만 볼 수 있습니다(진행 중인 재생은 최대 1시간 뒤 끊김).
</p>
<label><input type="checkbox" id="memberWebPlayerToggle"> 웹 브라우저 재생 허용</label>
<span class="field-hint" id="memberWebPlayerMeta"></span>
<div class="status-text" id="memberWebPlayerStatus"></div>
```

`members.js`:
- `openMemberDetailModal`에서 `m.web_player_enabled`로 체크박스 초기화, `memberWebPlayerMeta`에 "허용일 YYYY-MM-DD" 표시. 탈퇴 회원이면 disabled.
- `change` 이벤트 → `apiFetch(PUT …/web-player, {enabled})` → 성공 시 `setStatus('저장됨')`, 실패 시 체크 원복 + 오류 표시. 로딩 중 중복 클릭 방지(`detailMember.id != detailMemberId` 가드 재사용).
- 회원 목록 행에 `web_player_enabled`면 작은 배지 "웹" 표시(`loadMembers`/`runMemberSearch` 렌더 함수, 기존 `member_group` 표시 옆). 저장 후 `loadMembers()`로 갱신.

---

## 5. 프론트(회원 사이트, `public-figma/`)

### 5-1. `site-content.js` 공용
- `getMe()`를 한 번만 fetch해 캐시하는 헬퍼가 이미 있는지 확인(로그인 상태 헤더 렌더에 `/api/members/me`를 쓰는 곳). 없으면 `let meCache; async function fetchMe()` 추가.

### 5-2. 강좌 상세 커리큘럼 (`:553`) — 현재 구멍 막기
`hydrateVodDetail`(혹은 해당 함수) 안에서 `me = await fetchMe()` 후
`step.has_video && me.loggedIn && me.webPlayer` 일 때만 `<a href="lecturePlayer.html…">`, 아니면 제목 텍스트만. 수강 여부는 서버가 막으므로 UI에선 플래그만 본다.

### 5-3. 마이페이지 (`mypage.html:294-302`)
- 만료 아님 분기에서 `me.webPlayer`면 버튼을 두 개로: `웹에서 보기` → `lecturePlayer.html?id=${course.id}`, `DockPlayer로 보기` → `dockplayer://`. 아니면 지금처럼 `dockplayer://` 하나.
- 템플릿(`:111`)에 두 번째 버튼 자리를 넣고 기본 `display:none`.

### 5-4. 플레이어 (`hydrateLecturePlayer`, `:898`)
`reason === 'web_player_disabled'` 분기 추가: `alert('웹 재생 권한이 없는 계정입니다. DockPlayer 앱으로 시청해 주세요.'); location.href = 'mypage.html'`.
(매니페스트 403은 hls.js `MANIFEST_LOAD_ERROR`로 들어오므로 `attachVideoSource`의 에러 핸들러에서 `response.code === 403`이면 같은 안내 후 마이페이지로 — 재생 도중 권한이 꺼진 경우 대응.)

---

## 6. 캡처·녹화 방지 — 브라우저 플레이어에서 가능한 것과 한계

브라우저에서 **화면 캡처 자체를 막는 유일한 수단은 하드웨어 DRM(Widevine L1 / FairPlay)** 이다. 그 외는 전부 "억제·추적" 수단이다. 현실적인 순서로 정리한다.

### 6-1. 1차 (이번 작업에 같이 넣을 만한 것, 비용 낮음)
| 수단 | 효과 | 구현 |
|---|---|---|
| **동적 워터마크(가장 중요)** | 캡처를 못 막는 대신 유출 시 **누가** 유출했는지 추적 가능 → 가장 강한 억제력. 학원 강의 업계 표준 | `lecturePlayer.html` `.lp-video-wrap` 위에 `pointer-events:none` 오버레이 div. 내용: `이름 · 아이디 · 휴대폰 뒤 4자리 · 날짜시간`. 30~60초마다 위치를 랜덤 이동, 투명도 0.25~0.35. 값은 `/api/members/my-vod-lectures` 응답에 `viewer:{name, username, mobileTail}`로 서버가 내려준다(클라이언트가 임의 조작 못 하게 DOM 삽입은 JS, 값은 서버). 전체화면 시에도 보이도록 `video`가 아니라 `.lp-video-wrap`에 `requestFullscreen()` 하도록 플레이어 수정(네이티브 `controls`의 전체화면 버튼은 video만 키우므로 커스텀 전체화면 버튼 필요) |
| **`<video>` 속성 강화** | 우클릭 저장·PiP·다운로드 버튼 제거 | `controlsList="nodownload noremoteplayback"`, `disablePictureInPicture`, `oncontextmenu="return false"`, CSS `user-select:none` |
| **포커스 이탈 시 일시정지/블러** | 녹화 프로그램 전환·다른 창 띄울 때 멈춤. 우회는 쉽지만 캐주얼 녹화는 귀찮게 만든다 | `document.visibilitychange` + `window.blur` → `video.pause()` + 오버레이 "강의 화면으로 돌아오면 재생됩니다" |
| **키보드 차단** | PrintScreen 은 OS 레벨이라 못 막는다. 대신 `keydown`에서 PrintScreen 감지 시 `video.pause()` + 검은 오버레이(일부 환경에서 타이밍상 검은 화면이 찍힘) | 효과 제한적, 비용 거의 0 |
| **서버 이상 탐지** | 다운로더 도구 차단 | 매니페스트 요청 빈도(회원당 분당 N회 초과), 같은 회원의 동시 재생 IP 수(기기 제한과 연동, `member_devices`), 세그먼트가 실시간보다 훨씬 빨리 소비되는 패턴(`/api/v1/progress` delta 대비)을 로그/플래그 → 관리자 목록에 경고 배지, 심하면 `web_player_enabled=0` 자동 전환 |
| **프리사인 TTL 단축** | 매니페스트 재배포로 공유되는 창 축소 | §3-3 웹 세션 TTL 1시간 |

### 6-2. DockPlayer(일렉트론)에서 당장 가능한 강한 수단
`BrowserWindow.setContentProtection(true)` 한 줄로 Windows(`WDA_EXCLUDEFROMCAPTURE`)·macOS에서 **화면 캡처·녹화 시 검은 화면**. OBS·Windows 게임바·스니핑툴·팀즈 화면공유 모두 적용. 비용 거의 0이며 이것이 "웹보다 앱을 권장"하는 근거가 된다. (카메라로 모니터를 찍는 건 어떤 수단으로도 못 막는다 → 워터마크로 추적.)

### 6-3. 2차 (정식 DRM — 별도 프로젝트 규모)
- **Widevine(Chrome/Edge/Android) + FairPlay(Safari/iOS) + PlayReady(Edge 일부)**. Widevine **L1(하드웨어)** 에서만 화면 캡처가 검게 나오고, PC 크롬은 대부분 **L3(소프트웨어)** 라 캡처 방지가 되지 않는다. 즉 **PC 브라우저에서는 DRM을 넣어도 화면 녹화를 못 막는다.** 모바일/스마트TV에서만 의미가 있다.
- 필요한 변경: TS 세그먼트 → **fMP4(CMAF) + CENC 패키징**으로 워커 재인코딩(`worker/src/transcode.js` 전면 수정, 기존 영상 전부 재처리), 라이선스 서버(PallyCon·EZDRM·Axinom 등 월 과금) 연동, 현재 AES-128 키 라우트 대체, hls.js EME 설정, DockPlayer는 일렉트론 Widevine CDM(캐스트랩 VMP 서명 필요).
- 결론: **지금은 넣지 않는다.** 1차 수단 + DockPlayer `setContentProtection`으로 충분하고, 모바일 앱(RN) 출시 시점에 재검토.

### 6-4. 하지 말아야 할 것
- DevTools 열림 감지(창 크기 차이 등): 오탐 많고 우회 쉬움. 정상 사용자만 괴롭힌다.
- `canvas`로 프레임을 그려 재생: 성능 저하, 캡처 방지 효과 없음.
- 세그먼트 URL 난독화: 네트워크 탭에 그대로 보이므로 무의미.

---

## 7. 구현 순서 · 검증

1. 마이그레이션 SQL 작성 → 로컬 `.env`가 실DB 직결이므로 **적용은 사용자 확인 후**.
2. `server.js`: `authVia`, `checkWebPlayerAllowed`, 세션 라우트 2곳 403, `/api/members/me` 확장, 관리자 GET 2곳 + PUT 신규.
3. 관리자 모달 토글 + 목록 배지.
4. 회원 사이트: 커리큘럼 링크 조건부, 마이페이지 버튼, 플레이어 403 안내, 워터마크·video 속성·포커스 일시정지.
5. 검증(별도 에이전트, 증거 필수):
   - 플래그 0 회원: 커리큘럼에 링크 없음(스크린샷), `lecturePlayer.html?id=` 직접 접근 시 안내 후 마이페이지 이동, `curl -b 세션쿠키 /api/stream/vod-lecture/N/master.m3u8` → 403 `{reason:'web_player_disabled'}`.
   - 플래그 1 회원: 마이페이지 "웹에서 보기" 노출, 재생 성공, 워터마크 표시·이동(스크린샷 2장), 전체화면에서도 워터마크 보임.
   - DockPlayer 경로: `Authorization: Bearer` 로 같은 매니페스트 요청 → 플래그 0이어도 200.
   - 관리자: 토글 저장 후 `SELECT web_player_enabled, web_player_updated_at FROM members WHERE id=?` 값 확인, 목록 배지 반영.
   - 재생 중 플래그 off → 다음 강의 전환 시 403 안내 동작.

## 8. 영향 범위 요약
- 변경 파일: `infra/schema.sql`, `infra/migrations/2026-10-15-members-web-player.sql`(신규), `server.js`, `admin/index.html`, `admin/members.js`, `public-figma/site-content.js`, `public-figma/mypage.html`, `public-figma/lecturePlayer.html`, `public-figma/style.css`(워터마크·오버레이 CSS).
- 미변경: `/api/v1/*`, `worker/`, `lib/`, DockPlayer. (DockPlayer `setContentProtection`은 별도 저장소 작업으로 제안만.)
- 배포 시 마이그레이션 선적용 필수 — 컬럼 없이 서버만 올라가면 `/api/members/me`·매니페스트 라우트가 SQL 오류로 500.
