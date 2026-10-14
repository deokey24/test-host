-- 2026-10-15 express-session 저장소(lib/session-store.js). 서버 재시작/배포에도 로그인 유지.
-- FK는 걸지 않는다(관리자 세션은 member_id NULL, 회원 삭제 시 destroyByMember가 먼저 지움).
CREATE TABLE IF NOT EXISTS web_sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  member_id BIGINT NULL,
  expires_at DATETIME NOT NULL,
  data MEDIUMTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_web_sessions_member (member_id),
  KEY idx_web_sessions_expires (expires_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
