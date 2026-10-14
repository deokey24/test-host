# 웹 로그인 세션을 MySQL에 저장 (배포·재시작에도 로그인 유지) + rolling 연장

작성일: 2026-10-15. 사용자 보고 "로그인이 짧게 끊긴다" → 조사 결과 설정값(12시간/로그인 유지 30일)은 문제가 아니고,
`express-session`이 **MemoryStore**라 `pm2 reload`(배포)마다 전 회원·관리자가 강제 로그아웃되는 것이 원인.

## 0. 현재 상태 (조사)
| 항목 | 위치 | 내용 |
|---|---|---|
| 세션 설정 | `server.js:102-109` | `new session.MemoryStore()`, `resave:false`, `saveUninitialized:false`, `cookie.maxAge` 12h, `rolling` 미설정 |
| 로그인 유지 | `server.js:23`, `:2461`, `:2501` | `keepLoggedIn`이면 `cookie.maxAge`를 30일로 |
| 회원 세션 강제 종료 | `server.js:113-122` `destroyMemberSessions(memberId)` | `sessionStore.all()`로 전부 훑어 memberId 일치 sid를 destroy — 회원 삭제/익명화에서 호출 |
| 기기 ↔ 세션 | `server.js:2375,2394` | `member_devices.session_id = req.sessionID` 저장. 기기 삭제(`DELETE /api/members/devices/:id`)는 api_tokens만 지우고 **웹 세션은 안 끊음** |
| 로그아웃 | `server.js:2561` | 세션 필드만 delete (destroy 아님) |
| DB 헬퍼 | `lib/db.js` | mysql2 pool, `timezone:'Z'` |
| 의존성 | `package.json` | `express-session ^1.18`, `mysql2 ^3.22`. **새 패키지 추가 없음** — 배포가 tar+scp라 서버 `node_modules`를 안 건드리므로 자체 스토어를 작성한다 |

## 1. 설계
- `lib/session-store.js`(신규): `express-session`의 `Store`를 상속한 `MySQLSessionStore`. 외부 패키지 없이 기존 `getPool()` 사용.
  - 메서드: `get(sid, cb)`, `set(sid, sess, cb)`, `destroy(sid, cb)`, `touch(sid, sess, cb)`(rolling 시 만료만 갱신), `destroyByMember(memberId)`(Promise, 삭제 건수 반환), `cleanup()`(만료 행 삭제).
  - 만료 계산: `sess.cookie.expires`가 있으면 그 값, 없으면 `now + cookie.maxAge`(둘 다 없으면 12h). `get`은 `expires_at > NOW()`만 반환하고, 만료된 행은 지운다.
  - `set`은 `INSERT ... ON DUPLICATE KEY UPDATE`. `member_id`는 `sess.memberId || null`을 별도 컬럼으로 빼서 `destroyByMember`가 인덱스로 바로 지우게 한다(MemoryStore의 전수 스캔 대체).
  - DB 오류 시 `cb(err)`로 넘기되 `get`의 "행 없음"은 `cb(null, null)`. 서버 기동 시 DB가 없으면(로컬 DB 미연결) express-session이 오류를 next(err)로 올리므로, 생성자 옵션 `fallbackToMemory`는 두지 않는다(운영은 항상 DB).
  - 1시간마다 `cleanup()` (`setInterval(...).unref()`).
- `server.js`
  - `const sessionStore = new MySQLSessionStore()`로 교체, `rolling: true` 추가(활동마다 maxAge 연장 — 12h/30일이 "마지막 활동 기준"이 됨). `resave:false` 유지(rolling이면 express-session이 touch를 호출).
  - `destroyMemberSessions(memberId)` 본문을 `return sessionStore.destroyByMember(memberId)`로 교체.
  - 기기 삭제 라우트(`DELETE /api/members/devices/:id`, 약 3115행): 삭제 대상 `device.session_id`가 있고 현재 세션(`req.sessionID`)과 다르면 `sessionStore.destroy(session_id)` 호출 → 다른 브라우저의 로그인이 즉시 끊김(지금은 쿠키 만료까지 유지되던 구멍). 현재 세션이면 건드리지 않음(기기 목록 응답을 돌려줘야 하므로).
  - 로그아웃(`:2561`)은 그대로(필드 삭제 → set으로 저장됨, member_id NULL). 변경 없음.
- 스키마: `infra/schema.sql` 추가 + `infra/migrations/2026-10-15-web-sessions.sql`
  ```sql
  -- 2026-10-15 express-session 저장소(lib/session-store.js). 서버 재시작/배포에도 로그인 유지.
  CREATE TABLE IF NOT EXISTS web_sessions (
    sid VARCHAR(128) NOT NULL PRIMARY KEY,
    member_id BIGINT NULL,
    expires_at DATETIME NOT NULL,
    data MEDIUMTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_web_sessions_member (member_id),
    KEY idx_web_sessions_expires (expires_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  ```
  FK는 걸지 않는다(관리자 세션은 member_id NULL, 회원 삭제 시 `destroyByMember`가 먼저 지움).
- 시간대: pool이 `timezone:'Z'`이므로 `expires_at`은 JS Date를 그대로 바인딩(UTC로 저장)하고 비교는 `expires_at > UTC_TIMESTAMP()`로 통일.
- `CLAUDE.md`의 "네이티브 앱 API" 단락에 있는 "express-session(인메모리 MemoryStore, 서버 재시작 시 전부 로그아웃됨)" 설명을 MySQL 저장소로 갱신.

## 2. 영향·주의
- 이번 배포의 `pm2 reload` 한 번은 여전히 전원 로그아웃(메모리 세션 소실). 그 이후부터 유지됨.
- 세션 데이터에 비밀값 없음(memberId, memberName, deviceId, isAdmin, cookie). 그대로 JSON 저장.
- 관리자 세션도 DB에 남으므로 관리자 로그아웃은 기존처럼 `req.session.destroy()` → 행 삭제.
- `saveUninitialized:false` 유지라 비로그인 방문자는 행이 생기지 않는다(세션 테이블 비대화 방지).

## 3. 검증(별도 에이전트)
1. 로컬 `PORT=3400` 기동 → 회원 로그인 → `web_sessions`에 행 1개(member_id=1953, expires_at≈now+12h) → `/api/members/me` 로그인 상태.
2. **서버 프로세스 재시작** 후 같은 쿠키로 `/api/members/me` → 여전히 `loggedIn:true` (핵심).
3. rolling: 요청 후 `expires_at`이 앞으로 밀리는지(두 번 조회 비교).
4. `keepLoggedIn:true` 로그인 → expires_at≈now+30일.
5. 관리자 로그인 → 행(member_id NULL) → 재시작 후에도 `/admin`이 로그인 화면이 아닌 관리자 화면.
6. 다른 브라우저(쿠키 2개)로 같은 계정 로그인 → 마이페이지에서 첫 번째 기기 삭제 → 첫 번째 쿠키로 `/api/members/me` → `loggedIn:false`.
7. 로그아웃 → 행의 member_id NULL, `/api/members/me` 비로그인.
8. 만료 행 cleanup: `expires_at`을 과거로 UPDATE한 행이 `get`에서 안 읽히고 지워지는지.
9. 테스트 계정 외 데이터 미변경, 끝나면 verify 기기 삭제.

## 4. 배포
`git-push` 후 tar+scp: `server.js`, `lib/session-store.js`, `infra/*`, `CLAUDE.md`. 마이그레이션은 로컬에서 실DB에 먼저 적용(CREATE TABLE IF NOT EXISTS). `pm2 reload` 1회(마지막 전원 로그아웃).
