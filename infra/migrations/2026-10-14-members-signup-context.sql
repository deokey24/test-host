-- 2026-10-14 유입·여정 수집(docs/plans/attribution-and-journey.md 2-A)
-- 배포 전에 운영 DB에 먼저 적용해야 한다 — 컬럼 없이 새 server.js가 뜨면 /api/members/signup INSERT가 500.
-- signup_context: 가입 시점 스냅샷 JSON {attribution: {first, last} | null, journey: [{path, q, t, d}], ua}
--   attribution = 브라우저 dt_attr 쿠키(첫 방문·마지막 광고/외부 유입), journey = sessionStorage dt_journey(최근 20 페이지·체류초)
--   서버(lib/conversions.js attachAttributionContext)가 화이트리스트·길이·8KB 상한 검증 후 저장.
--   회원 삭제 시 익명화 경로에서 NULL 처리(server.js anonymize/delete).
-- 결제 쪽 같은 정보는 새 컬럼 없이 payments.client_context JSON의 attribution·journey 키에 들어간다.
ALTER TABLE members ADD COLUMN signup_context TEXT NULL;
