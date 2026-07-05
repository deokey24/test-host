-- 운영 서버(54.116.171.96)의 MariaDB 10.11에 적용할 스키마
-- 실행: sudo mysql < infra/schema.sql

CREATE DATABASE IF NOT EXISTS dockteacher
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE dockteacher;

CREATE TABLE IF NOT EXISTS lecture_videos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  raw_r2_key VARCHAR(512) NOT NULL,
  raw_upload_id VARCHAR(255),
  final_r2_key VARCHAR(512),
  status ENUM('uploading', 'queued', 'processing', 'done', 'failed') NOT NULL DEFAULT 'uploading',
  error_message TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 워커 인스턴스 전용 계정 생성 (운영 서버 실행 후 아래 IP를 워커 인스턴스의 "사설 IP"로 교체)
-- CREATE USER 'dockteacher_worker'@'<워커_인스턴스_사설IP>' IDENTIFIED BY '<강한_비밀번호>';
-- GRANT SELECT, INSERT, UPDATE ON dockteacher.lecture_videos TO 'dockteacher_worker'@'<워커_인스턴스_사설IP>';
-- FLUSH PRIVILEGES;

-- 클래스 (수강신청 페이지 카드, 관리자 페이지에서 CRUD)
CREATE TABLE IF NOT EXISTS classes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  filter_tab VARCHAR(50) NOT NULL DEFAULT '전체',      -- 필터 탭: 경찰대 편입 / 연고대 논술 / 파이널반 / 인강
  category VARCHAR(100) NOT NULL,                      -- 썸네일 좌상단 카테고리 라벨
  badge_style ENUM('enroll', 'hot', 'new') NOT NULL DEFAULT 'new',
  badge_text VARCHAR(50) NOT NULL DEFAULT 'NEW',
  thumb_title VARCHAR(200) NOT NULL,                   -- 썸네일 제목 (줄바꿈은 \n)
  thumb_subject VARCHAR(100),                          -- 예: 언어논리 · 황성찬
  thumb_gradient VARCHAR(200) NOT NULL DEFAULT 'linear-gradient(135deg,#0d1b2a 0%,#1a2d40 100%)',
  name VARCHAR(300) NOT NULL,                          -- 카드 본문 강좌명
  enroll_period VARCHAR(100),                          -- 수강 신청 기간
  course_period VARCHAR(100),                          -- 수강 기간
  capacity_note VARCHAR(100),                          -- 모집인원 표기
  discount VARCHAR(20),                                -- 할인율 표기 (예: 25%)
  price VARCHAR(50) NOT NULL,                          -- 예: 280,000원 / 가격 문의
  original_price VARCHAR(50),                          -- 할인 전 가격
  detail_page VARCHAR(50),                             -- 상세페이지 ID (기본 classDetail)
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 기존 하드코딩 카드 9개 시드 (테이블이 비어있을 때만 삽입되어 재실행 안전)
INSERT INTO classes
  (filter_tab, category, badge_style, badge_text, thumb_title, thumb_subject, thumb_gradient, name, enroll_period, course_period, capacity_note, discount, price, original_price, detail_page, sort_order)
SELECT * FROM (
  SELECT '경찰대 편입' AS filter_tab, '2027 경찰대 편입' AS category, 'enroll' AS badge_style, '수강신청' AS badge_text, '경찰대 언어논리\n4월 신규반' AS thumb_title, '언어논리 · 황성찬' AS thumb_subject, 'linear-gradient(135deg,#0d1b2a 0%,#1a2d40 100%)' AS thumb_gradient, '[경찰대 편입] 2027년 대비 황성찬T 경찰대 언어논리 4월 신규반 개강' AS name, '2026.03.20 ~ 2026.04.10' AS enroll_period, '2026.04.01 ~ 2026.11.30' AS course_period, 'N수생 25% 할인' AS capacity_note, NULL AS discount, '280,000원' AS price, NULL AS original_price, NULL AS detail_page, 1 AS sort_order UNION ALL
  SELECT '경찰대 편입', '2027 경찰대 편입', 'hot', 'HOT', '경찰대 언어논리\n5월 신규반', '언어논리 · 황성찬', 'linear-gradient(135deg,#0d1b2a 0%,#1a2d40 100%)', '[경찰대 편입] 2027년 대비 황성찬T 경찰대 언어논리 5월 신규반 개강', '2026.04.15 ~ 2026.05.10', '2026.05.01 ~ 2026.11.30', 'N수생 25% 할인', NULL, '280,000원', NULL, NULL, 2 UNION ALL
  SELECT '파이널반', '2027 경찰대 파이널', 'new', 'NEW', '언어논리&자소서\n100일 완성반', '언어논리 · 황성찬', 'linear-gradient(135deg,#0d1b2a 0%,#162535 100%)', '[경찰대 편입] 황성찬T 경찰대 언어논리&자소서 100일 완성반 8월 대개강', '2026.07.01 ~ 2026.08.10', '2026.08.01 ~ 2026.11.30', '무료 실전 모의고사 포함', '25%', '380,000원', '510,000원', NULL, 3 UNION ALL
  SELECT '연고대 논술', '연고대 편입논술', 'hot', 'HOT', '연고대 편입논술\n6월 개강반', '편입논술 · 황성찬', 'linear-gradient(135deg,#1a0d2a 0%,#2d1a40 100%)', '연고대 편입논술반 6월 개강반 등록 신청 안내', '2026.05.01 ~ 2026.06.01', '2026.06.01 ~ 2026.11.30', '선착순 마감', NULL, '350,000원', NULL, NULL, 4 UNION ALL
  SELECT '연고대 논술', '연고대 편입논술', 'enroll', '수강신청', '김현수·황성찬T\n2월 개강반', '편입논술 · 황성찬', 'linear-gradient(135deg,#1a0d2a 0%,#2a1540 100%)', '[연고대 논술] 김현수·황성찬T 2월 개강반 소개 (선착순 마감)', '2026.01.10 ~ 2026.02.01', '2026.02.01 ~ 2026.07.31', '선착순 마감', NULL, '420,000원', NULL, NULL, 5 UNION ALL
  SELECT '연고대 논술', '2026 합격 성과', 'hot', '⭐ 합격', '연고대 문과\n1차 222명 합격', '편입논술 · 황성찬', 'linear-gradient(135deg,#1a1a0d 0%,#2d2a10 100%)', '⭐ 2026학년도 연고대 문과 1차 합격 결과 공개 — 연고대 1차 222명 합격', '기간 무제한', '2026.01.04 ~ 2026.12.31', '인원 무제한', NULL, '500,000원', NULL, NULL, 6 UNION ALL
  SELECT '파이널반', '경찰대 파이널', 'new', 'NEW', '경찰대 언어논리\n10월 파이널반', '언어논리 · 황성찬', 'linear-gradient(135deg,#0d1b2a 0%,#1a3040 100%)', '[경찰대 편입] 황성찬T 경찰대 언어논리 10월 파이널반 개강 — N수생 25% 할인', '2026.09.01 ~ 2026.10.05', '2026.10.01 ~ 2026.11.30', 'N수생 25% 할인', '25%', '210,000원', '280,000원', NULL, 7 UNION ALL
  SELECT '연고대 논술', '연고대 편입논술', 'new', 'NEW', '연고대 편입논술\n12월 신규반', '편입논술 · 황성찬', 'linear-gradient(135deg,#1a0d20 0%,#2a1535 100%)', '[연고대논술] 2027년 대비 12월 신규반 개강 안내 (6주 과정)', '2025.11.10 ~ 2025.12.01', '2025.12.01 ~ 2026.01.15', '선착순 마감', NULL, '320,000원', NULL, NULL, 8 UNION ALL
  SELECT '인강', '연고대 편입논술', 'new', 'NEW', '연고대 편입논술\n완성 (전 13강)', '편입논술 · 황성찬', 'linear-gradient(135deg,#0d1b2a 0%,#1a2d40 100%)', '[연고대 편입논술] 연고대 편입논술 완성 — 독해원리부터 실전 논술까지 (OT+12강)', '상시 모집', '등록일 ~ 2026.12.31', '인원 무제한', NULL, '가격 문의', NULL, 'classDetailNew', 9
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM classes);

-- 회원 (기존 엑셀 회원 리스트 마이그레이션, 2026-07-06 1770건 적용)
CREATE TABLE IF NOT EXISTS members (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  seq_no INT,
  username VARCHAR(100) NOT NULL,
  password VARCHAR(255) DEFAULT NULL,
  name VARCHAR(100),
  member_group VARCHAR(50),
  phone VARCHAR(50),
  mobile VARCHAR(50),
  email VARCHAR(255),
  signup_channel VARCHAR(255),
  search_keyword VARCHAR(255),
  referrer_code VARCHAR(255),
  email_marketing_consent VARCHAR(10),
  sms_marketing_consent VARCHAR(10),
  joined_at DATETIME,
  general_notes TEXT,
  consultation_notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_members_username (username)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
