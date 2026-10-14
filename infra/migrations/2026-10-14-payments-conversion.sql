-- 2026-10-14 서버측 purchase 전환 전송(GA4 Measurement Protocol + Meta 전환 API, lib/conversions.js)
-- 배포 전에 운영 DB에 먼저 적용해야 한다 — 컬럼 없이 새 server.js가 뜨면 /api/payments/init INSERT가 500.
-- client_context:     /api/payments/init 시점의 브라우저 식별 스냅샷 JSON {ga_client_id, ga_session_id, fbp, fbc, ip, ua}
-- conversion_sent_at: 전환 전송 시각(멱등 선점용, 실패 시 NULL로 복구)
ALTER TABLE payments
  ADD COLUMN client_context TEXT NULL,
  ADD COLUMN conversion_sent_at DATETIME NULL;
