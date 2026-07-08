-- 운영 서버(54.116.171.96)의 MariaDB 10.11에 적용할 스키마
-- 실행: sudo mysql < infra/schema.sql

CREATE DATABASE IF NOT EXISTS dockteacher
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE dockteacher;

CREATE TABLE IF NOT EXISTS lecture_videos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  raw_r2_key VARCHAR(512) NOT NULL,
  raw_upload_id VARCHAR(1024),  -- R2 멀티파트 UploadId는 300자 이상 (255면 ER_DATA_TOO_LONG)
  final_r2_key VARCHAR(512),
  status ENUM('uploading', 'queued', 'processing', 'done', 'failed') NOT NULL DEFAULT 'uploading',
  error_message TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 워커 인스턴스 전용 계정 생성
-- 워커는 ASG로 뜨므로 IP가 매번 달라진다 → 특정 IP가 아니라 VPC 사설 대역 와일드카드로 허용.
-- (실제 접근 차단은 보안그룹이 담당: 운영 서버 3306은 "워커 SG에서만" 인바운드 허용)
-- 아래 '172.31.%'는 운영 서버 VPC의 CIDR에 맞춰 교체 (예: VPC가 10.0.0.0/16이면 '10.0.%')
-- CREATE USER 'dockteacher_worker'@'172.31.%' IDENTIFIED BY '<강한_비밀번호>';
-- GRANT SELECT, INSERT, UPDATE ON dockteacher.lecture_videos TO 'dockteacher_worker'@'172.31.%';
-- FLUSH PRIVILEGES;

-- 카테고리 (수강신청 페이지 필터탭 겸 클래스 폼의 "카테고리" 선택지, 관리자 페이지에서 CRUD)
CREATE TABLE IF NOT EXISTS class_categories (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO class_categories (name, sort_order)
SELECT * FROM (
  SELECT '경찰대 편입' AS name, 1 AS sort_order UNION ALL
  SELECT '연고대 논술', 2 UNION ALL
  SELECT '파이널반', 3 UNION ALL
  SELECT '인강', 4
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM class_categories);

-- 클래스 (수강신청 페이지 카드, 관리자 페이지에서 CRUD)
CREATE TABLE IF NOT EXISTS classes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  filter_tab VARCHAR(50) NOT NULL DEFAULT '전체',      -- 카테고리(class_categories.name의 사본, 이름 변경 시 서버가 일괄 반영)
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
  detail_page VARCHAR(50),                             -- 상세페이지 ID (기본 classDetail, 관리자 빠른등록으로 만든 클래스는 classDetailDynamic)
  intro_content LONGTEXT,                              -- 강의 소개 탭 JSON ({ sections: [{heading, paragraph, groups:[{subheading, bullets}]}] })
  curriculum_content LONGTEXT,                         -- 커리큘럼 탭 JSON ({ totalLabel, chapters: [{label, lessonTitle, sections:[...]}] })
  banner_tag VARCHAR(200),                             -- 상세페이지 배너 상단 태그 (예: 대상 : 연세대·고려대 편입논술 준비생)
  banner_subtitle VARCHAR(100),                        -- 상세페이지 배너 부제목
  banner_title_accent VARCHAR(100),                    -- 배너 제목 중 강조 표시할 부분
  banner_title_rest VARCHAR(100),                      -- 배너 제목 중 나머지 부분
  banner_instructor_name VARCHAR(100),                 -- 배너에 표시할 강사 정보
  banner_card_type ENUM('gradient', 'image') NOT NULL DEFAULT 'gradient', -- 배너 우측 카드 비주얼 방식
  banner_card_gradient VARCHAR(200),                   -- banner_card_type='gradient'일 때 사용할 CSS gradient
  banner_image_url VARCHAR(500),                       -- banner_card_type='image'일 때 사용할 업로드 이미지 URL (R2 classes/{id}/ 경로)
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

-- 비밀번호 재설정 토큰 (2026-07 이메일 인증 도입 시 추가)
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reset_token_expires DATETIME DEFAULT NULL;

-- 마이페이지 기기 관리 (OTT 방식, 회원당 최대 3개 기기 등록 — server.js에서 강제)
CREATE TABLE IF NOT EXISTS member_devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  member_id BIGINT NOT NULL,
  device_id VARCHAR(191) NOT NULL,           -- 클라이언트 localStorage에 저장되는 고정 식별자
  device_label VARCHAR(255),                 -- User-Agent에서 뽑아낸 "OS · 브라우저" 표기
  user_agent VARCHAR(500),
  ip_address VARCHAR(100),
  session_id VARCHAR(255),
  last_login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_member_device (member_id, device_id),
  CONSTRAINT fk_member_devices_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 내 강의실 등록 (관리자 수동 배정 또는 향후 결제 자동 등록 — server.js의 enrollMemberInClass가 공통 진입점)
CREATE TABLE IF NOT EXISTS member_class_enrollments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  member_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  status ENUM('진행중', '완료') NOT NULL DEFAULT '진행중',
  progress_note VARCHAR(100),          -- 예: "10 / 26강" (자유 텍스트, 관리자가 직접 입력)
  source ENUM('admin', 'payment') NOT NULL DEFAULT 'admin',
  enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_member_class (member_id, class_id),
  CONSTRAINT fk_enrollment_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_enrollment_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 클래스별 강의 커리큘럼 (R2 courses/{course}/lectures/{번호 3자리}/video/ 경로와 1:1 대응)
CREATE TABLE IF NOT EXISTS class_lectures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  lecture_number INT NOT NULL,        -- 0 = OT
  title VARCHAR(300) NOT NULL,
  video_r2_key VARCHAR(512) NOT NULL, -- 버킷 dockteacher 기준 키 (URL 인코딩 전 원문)
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_class_lecture (class_id, lecture_number),
  CONSTRAINT fk_class_lectures_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 강의별 수업자료 (같은 강의 번호의 .../materials/ 경로 아래 파일들)
CREATE TABLE IF NOT EXISTS class_lecture_materials (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  class_lecture_id BIGINT NOT NULL,
  title VARCHAR(300) NOT NULL,        -- 원본 파일명
  file_r2_key VARCHAR(512) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_class_lecture_materials_lecture FOREIGN KEY (class_lecture_id) REFERENCES class_lectures(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 커리큘럼 챕터별 영상/자료 첨부 (관리자 클래스 콘텐츠 편집기의 "커리큘럼" 탭용, 목업 단계)
-- chapter_key는 classes.curriculum_content JSON의 각 chapters[].key(UUID)와 매칭되는 안정적 식별자
CREATE TABLE IF NOT EXISTS class_chapter_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  chapter_key VARCHAR(64) NOT NULL,
  type ENUM('video', 'material') NOT NULL,
  title VARCHAR(200) NOT NULL,          -- 표시용 파일명
  file_url VARCHAR(500) NOT NULL,       -- 공개 서빙 경로 (/uploads/{file_key})
  file_key VARCHAR(500) NOT NULL,       -- R2 오브젝트 key (classes/{class_id}/chapters/{chapter_key}/...)
  mime_type VARCHAR(100),
  file_size BIGINT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  INDEX idx_class_chapter (class_id, chapter_key)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
