-- 2026-10-15 관리자가 지정한 회원만 웹 브라우저 플레이어(lecturePlayer.html)로 재생 허용.
-- DockPlayer(Bearer 토큰) 재생에는 영향 없음. 0=웹 재생 불가(기본), 1=허용.
-- 계획: docs/plans/web-player-permission-and-capture.md
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS web_player_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS web_player_updated_at DATETIME NULL;
