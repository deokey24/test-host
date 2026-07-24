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

-- VOD 강좌 수강 등록 (member_class_enrollments와 동일한 패턴, vod_courses 전용)
CREATE TABLE IF NOT EXISTS member_vod_enrollments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  member_id BIGINT NOT NULL,
  vod_course_id BIGINT NOT NULL,
  status ENUM('진행중', '완료') NOT NULL DEFAULT '진행중',
  progress_note VARCHAR(100),
  source ENUM('admin', 'payment') NOT NULL DEFAULT 'admin',
  enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_member_vod (member_id, vod_course_id),
  CONSTRAINT fk_vod_enrollment_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_vod_enrollment_course FOREIGN KEY (vod_course_id) REFERENCES vod_courses(id) ON DELETE CASCADE
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

-- ── 신규 Figma 사이트(public-figma) CMS — 관리자 페이지 개편 (2026-07) ──

-- 페이지별 단일 섹션 콘텐츠 (제목/본문/버튼/색상 등 자유 형식 JSON)
CREATE TABLE IF NOT EXISTS site_sections (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  page VARCHAR(30) NOT NULL,          -- home, vod, cert, curriculum, faq, settings
  section_key VARCHAR(40) NOT NULL,   -- hero, online_class, certified, vod_list, why, reviews, footer ...
  content LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_page_section (page, section_key)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- VOD 강의 상품 (vod.html 카드 / curriculum.html 행 / 홈 미리보기 카드 공용 소스)
CREATE TABLE IF NOT EXISTS vod_courses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tag VARCHAR(50),                    -- 영문 라벨, 예: READING THEORY
  category_label VARCHAR(50),         -- 한글 태그, 예: 독해
  title VARCHAR(200) NOT NULL,
  description TEXT,
  meta_text VARCHAR(200),             -- 예: 12강 · 수강 무제한
  is_best TINYINT(1) NOT NULL DEFAULT 0,
  color_variant ENUM('default', 'green') NOT NULL DEFAULT 'default',
  old_price VARCHAR(50),
  new_price VARCHAR(50) NOT NULL,
  thumbnail_url VARCHAR(500),
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- VOD 강의별 커리큘럼 스텝 겸 영상 연결 (class_lectures와 동일 구조/역할)
CREATE TABLE IF NOT EXISTS vod_course_lectures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  vod_course_id BIGINT NOT NULL,
  lecture_number INT NOT NULL,
  title VARCHAR(300) NOT NULL,
  video_r2_key VARCHAR(512),          -- NULL 허용: 목차만 먼저 등록하고 영상은 나중에 연결 가능
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vod_course_lecture (vod_course_id, lecture_number),
  CONSTRAINT fk_vcl_course FOREIGN KEY (vod_course_id) REFERENCES vod_courses(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 합격 인증 갤러리 이미지 (cert.html 갤러리 + 홈 certified 섹션 공용)
CREATE TABLE IF NOT EXISTS cert_gallery_images (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  image_url VARCHAR(500) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- FAQ 항목 (faq.html 자주 묻는 질문 탭)
CREATE TABLE IF NOT EXISTS faq_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  question VARCHAR(300) NOT NULL,
  answer LONGTEXT NOT NULL,           -- 줄바꿈 포함 텍스트, 빈 줄로 문단 구분
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 공지사항 카테고리 (faq.html "공지사항" 탭 배지, 관리자 페이지에서 CRUD) — class_categories와 동일 패턴
CREATE TABLE IF NOT EXISTS notice_categories (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 공지사항 (faq.html "공지사항" 탭 — dock-pass 관리자의 공지사항 기능 이식)
-- category는 NULL 허용: 관리자가 카테고리 없이 작성할 수 있고, 이 경우 목록에 빈 칸으로 노출된다.
CREATE TABLE IF NOT EXISTS notices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(50) DEFAULT NULL,
  title VARCHAR(255) NOT NULL,
  body LONGTEXT,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  notice_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_notices_pinned_date (pinned, notice_date)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 기존에 이미 테이블이 생성된 환경(운영 DB)에서는 CREATE TABLE IF NOT EXISTS가 무시되므로 직접 반영.
ALTER TABLE notices MODIFY COLUMN category VARCHAR(50) DEFAULT NULL;

-- vod_courses/curriculum.html이 CMS 하이드레이션 전환 후 빈 화면으로 뜨지 않도록 기존 하드코딩 6개 강좌를 시드
INSERT INTO vod_courses
  (tag, category_label, title, description, meta_text, is_best, color_variant, old_price, new_price, sort_order)
SELECT * FROM (
  SELECT 'READING THEORY' AS tag, '독해' AS category_label, '독해학개론' AS title,
         '연고대 논술 3대 독해 스킬 — 차원 구획·기능어·연결 독해를 실전 기출로 완성합니다.' AS description,
         '12강 · 수강 무제한' AS meta_text, 0 AS is_best, 'default' AS color_variant,
         '250,000원' AS old_price, '210,000원' AS new_price, 1 AS sort_order UNION ALL
  SELECT 'PREMIUM CLASS', '프리미엄', '연고대 편입논술 프리미엄반',
         '라이브 + VOD + 1:1 첨삭 + 실시간 모의고사까지, 1년 전 과정을 밀착 관리합니다.',
         '라이브+VOD · 1:1 첨삭 · 16강+', 1, 'green', '6,000,000원', '4,000,000원', 2 UNION ALL
  SELECT 'TYPE MASTER', '유형별', '논술 유형별 대처법',
         '요약형·비교형·적용형 3대 유형의 패턴과 답안 공식을 유형별로 완성합니다.',
         '요약·비교·적용 6강 · 수강 무제한', 0, 'default', NULL, '320,000원', 3 UNION ALL
  SELECT '1-YEAR COMPLETE', '완성', '연고대 편입논술 완성',
         'OT부터 독해 원리·3대 유형·실전 기출까지 1년 커리큘럼을 하나로 완성합니다.',
         'OT + 12강 · 1년 커리큘럼', 0, 'green', NULL, '가격 문의', 4 UNION ALL
  SELECT 'YONSEI SPECIAL', '연세대', '연세대 특별반',
         '연세대 출제 원리·다면형 사고·상위 개념 독해를 집중 훈련하는 특화 과정입니다.',
         '5강 · 연세대 출제 원리 특화', 0, 'default', NULL, '600,000원', 5 UNION ALL
  SELECT 'DATA ANALYSIS', '자료해석', '자료해석특강',
         '도표·그래프 자료해석 — 변수·인과·회귀모형을 실제 기출로 훈련합니다.',
         '4강 · 도표·그래프 자료해석', 0, 'green', NULL, '200,000원', 6
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM vod_courses);

INSERT INTO vod_course_lectures (vod_course_id, lecture_number, title, sort_order)
SELECT * FROM (
  SELECT (SELECT id FROM vod_courses WHERE title = '독해학개론') AS vod_course_id, 1 AS lecture_number, '지문 핵심 독해법 — 차원 구획과 기능어 마스터' AS title, 1 AS sort_order UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '독해학개론'), 2, '거시 독해 실전과 이론·사례 연결 독해', 2 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '독해학개론'), 3, '실전 독해 테스트와 기능어·추론 메커니즘', 3 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '독해학개론'), 4, '분배적 정의와 인과관계 오류 추론', 4 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '독해학개론'), 5, '형식 논리학 기초와 실전 변수·구조 추론', 5 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '독해학개론'), 6, '논술 배경지식의 뼈대와 문학 지문 독해', 6 UNION ALL

  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 프리미엄반'), 1, '독해학개론(1) — 3대 원리와 맞춤형 서류 전략', 1 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 프리미엄반'), 2, '출제 기조 분석과 인과관계 도식화 독해', 2 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 프리미엄반'), 3, '문학작품 독해 — 사건·정서·태도로 시사점', 3 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 프리미엄반'), 4, '개념지식 기반 하향식 독해와 실전 논증', 4 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 프리미엄반'), 5, '연고대편입반 OT — 연간 커리큘럼과 독해 원리', 5 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 프리미엄반'), 6, '독해의 핵심 원리 — 연결·차원 구획·기능어', 6 UNION ALL

  SELECT (SELECT id FROM vod_courses WHERE title = '논술 유형별 대처법'), 1, '요약형 1강 — 논술 독해의 본질과 합격 전략', 1 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '논술 유형별 대처법'), 2, '요약형 2강 — 유형별 요약 패턴과 구조 독해', 2 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '논술 유형별 대처법'), 3, '비교형 1강 — 비교 기준 설정과 학술적 범주화', 3 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '논술 유형별 대처법'), 4, '비교형 2강 — P-S 구조와 Frame Map 개요 설계', 4 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '논술 유형별 대처법'), 5, '적용형 1강 — 기준→대상 평가 방법론', 5 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '논술 유형별 대처법'), 6, '적용형 2강 — 3단계 변형 원리와 기출 적용', 6 UNION ALL

  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 완성'), 1, '0강 — 2027 연고대 편입논술 OT', 1 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 완성'), 2, '1강 — 독해의 핵심 원리 1 (차원 구획·기능어)', 2 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 완성'), 3, '2강 — 독해의 핵심 원리 2 (대립 구조 요약법)', 3 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 완성'), 4, '3강 — 독해 TEST 및 기능어 실전 적용', 4 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 완성'), 5, '4강 — 유비추론과 문학 작품 실전 독해', 5 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연고대 편입논술 완성'), 6, '5강 — 요약형의 본질과 비문학 9가지 구조', 6 UNION ALL

  SELECT (SELECT id FROM vod_courses WHERE title = '연세대 특별반'), 1, '1강 — 연세대 논술 출제 원리와 문제 접근법', 1 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연세대 특별반'), 2, '2강 — 상위 개념 독해법과 제시문 분석', 2 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연세대 특별반'), 3, '3강 — 온건한 대립항과 연세대식 다면형 사고', 3 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연세대 특별반'), 4, '4강 — 도표·그래프 해석과 사회과학 변수 분석', 4 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '연세대 특별반'), 5, '5강 — 실전 기출 분석과 답안 작성 원리', 5 UNION ALL

  SELECT (SELECT id FROM vod_courses WHERE title = '자료해석특강'), 1, '1강 — 도표·그래프 해석 원리와 자료분석 기초', 1 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '자료해석특강'), 2, '2강 — 집단 비교 실전 적용과 도표 해석 작성', 2 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '자료해석특강'), 3, '3강 — 상관·인과관계 분석과 회귀모형 실전', 3 UNION ALL
  SELECT (SELECT id FROM vod_courses WHERE title = '자료해석특강'), 4, '4강 — 연세대·고려대 사회계열 기출 적용', 4
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM vod_course_lectures);

-- site_sections/cert_gallery_images/faq_items도 위와 같은 이유로 시드: 관리자 페이지 신규 CMS 탭이
-- 빈 값만 보여주지 않도록, public-figma/*.html에 하드코딩되어 있던 문구를 그대로 최초 값으로 채운다.
-- (각 section_key는 UNIQUE(page, section_key)라 항목별로 개별 가드)
INSERT INTO site_sections (page, section_key, content)
SELECT 'home', 'hero', JSON_OBJECT(
  'badge', 'CERTIFIED · 2026 최종 합격',
  'accentColor', '#0ea968',
  'title', '결과로 증명하는\n연고대 편입 합격',
  'body', '말이 아니라 실제 합격 인증으로 확인하세요.\n연세대·고려대 최종 합격 88명 · 1차 222명.',
  'button', JSON_OBJECT('enabled', true, 'text', '합격 인증 보기 →'),
  'image', JSON_OBJECT('url', 'assets/home/hero-cert.jpg', 'ratio', '3:4')
) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'home' AND section_key = 'hero');

INSERT INTO site_sections (page, section_key, content)
SELECT 'home', 'online_class', JSON_OBJECT(
  'badge', 'ONLINE CLASS · 현강을 그대로',
  'title', '강의실에 오지 못해도,\n합격까지는 조금도 멀지 않습니다',
  'body', '직장인, 군인, 재학생 — 오프라인 수업이 어려운 학생들을 위해 독편사가 현강 수업을 그대로 온라인에 옮겼습니다. 같은 강의, 같은 첨삭, 같은 관리. 이제 장소가 아니라 실력으로 승부하세요.',
  'cards', JSON_ARRAY(
    JSON_OBJECT('image', 'assets/home/class-card-1.png', 'title', '현강과 100% 동일한 커리큘럼', 'body', '오프라인에서 진행하는 강의를 순서도 밀도도 그대로. 온라인이라고 덜어낸 것은 없습니다.'),
    JSON_OBJECT('image', 'assets/home/class-card-2.png', 'title', '1:1 실시간 첨삭 관리', 'body', '제출한 답안을 강사가 직접 첨삭하고, 주간 피드백으로 합격까지 끝까지 관리합니다.'),
    JSON_OBJECT('image', 'assets/home/class-card-3.png', 'title', '시간과 장소의 제약 없이', 'body', '배수·횟수 제한 없는 무제한 반복 수강. 새벽에도, 부대에서도, 퇴근 후에도.')
  )
) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'home' AND section_key = 'online_class');

INSERT INTO site_sections (page, section_key, content)
SELECT 'home', 'certified', JSON_OBJECT('badge', 'CERTIFIED PASS', 'title', '합격생들의 생생한 인증') FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'home' AND section_key = 'certified');

INSERT INTO site_sections (page, section_key, content)
SELECT 'home', 'vod_list', JSON_OBJECT('badge', 'VOD CLASS', 'title', '지금 수강 가능한 VOD 강의') FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'home' AND section_key = 'vod_list');

INSERT INTO site_sections (page, section_key, content)
SELECT 'home', 'why', JSON_OBJECT(
  'title', '왜 독편사 VOD인가',
  'ctaText', '입학 TEST 신청 →',
  'cards', JSON_ARRAY(
    JSON_OBJECT('title', '완벽한 풀 첨삭 시스템', 'body', '인강의 최대 단점인 ''피드백 부재''를 해결합니다. 강사가 직접 첨삭하여 답안의 논리력을 실시간으로 교정합니다.'),
    JSON_OBJECT('title', '100% 복원 기출문제', 'body', '인터넷의 불완전한 기출이 아닙니다. 교수진이 직접 응시·복원한 가장 신뢰도 높은 자료로 공부합니다.')
  )
) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'home' AND section_key = 'why');

INSERT INTO site_sections (page, section_key, content)
SELECT 'home', 'reviews', JSON_OBJECT(
  'badge', 'REVIEWS',
  'title', '수강생들이 남긴 이야기',
  'cards', JSON_ARRAY(
    JSON_OBJECT('quote', '지방이라 걱정 많았는데 VOD로 연대 합격했어요. 현강\n그대로의 밀도였습니다.', 'author', '연세대 편입 합격 · 2026'),
    JSON_OBJECT('quote', '직장 다니면서 준비했는데 첨삭 피드백이 정말 꼼꼼했어요.\n방향이 명확해졌습니다.', 'author', '고려대 편입 합격 · 2026'),
    JSON_OBJECT('quote', '복원 기출문제 덕분에 시험장 분위기에 완벽히\n적응했습니다. 실전 감각이 달랐어요.', 'author', '연세대 편입 합격 · 2025')
  )
) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'home' AND section_key = 'reviews');

INSERT INTO site_sections (page, section_key, content)
SELECT 'cert', 'hero', JSON_OBJECT('title', '합격 인증', 'body', '데이터가 아닌, 합격생들의 실제 인증. 연세대·고려대 최종 합격 기준입니다.') FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'cert' AND section_key = 'hero');

INSERT INTO site_sections (page, section_key, content)
SELECT 'cert', 'chart', JSON_OBJECT(
  'kicker', 'GROWTH · 최종 합격자 추이',
  'percent', 87,
  'title', '연고대 최종합격자',
  'highlight', '4년간 폭발적',
  'body', '연세대·고려대 최종 합격자 수\n2023년 47명 → 2026년 88명',
  'bars', JSON_ARRAY(
    JSON_OBJECT('year', '2023', 'count', 47),
    JSON_OBJECT('year', '2024', 'count', 74),
    JSON_OBJECT('year', '2025', 'count', 80),
    JSON_OBJECT('year', '2026', 'count', 88)
  )
) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'cert' AND section_key = 'chart');

INSERT INTO site_sections (page, section_key, content)
SELECT 'faq', 'hero', JSON_OBJECT('title', 'FAQ', 'body', '프리미엄 VOD 관련 자주 묻는 질문과 공지사항을 확인하세요.') FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'faq' AND section_key = 'hero');

INSERT INTO site_sections (page, section_key, content)
SELECT 'curriculum', 'hero', JSON_OBJECT('title', '커리큘럼', 'body', '강좌별 상세 커리큘럼입니다. 독해 원리부터 유형별 실전, 대학별 특화까지 단계적으로 구성했습니다.') FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'curriculum' AND section_key = 'hero');

-- 카카오톡 상담 링크는 원본 사이트에도 실제 채널 URL 없이 '#' 자리표시자였다 — 관리자 페이지에서 실제 링크로 교체 필요.
INSERT INTO site_sections (page, section_key, content)
SELECT 'settings', 'footer', JSON_OBJECT(
  'kakaoUrl', '#',
  'phone', '02-6404-1018',
  'hours', '상담 월~금 15:00–20:00',
  'footerLines', JSON_ARRAY(
    '서울특별시 서대문구 신촌로 221 엠앤씨빌딩 2층 201호',
    '학원설립·운영등록번호 제2020-0006호 · 사업자등록번호 104-94-47747',
    '평일 운영 월~금 14:00–22:00 · 상담 월~금 15:00–20:00'
  ),
  'copyright', 'Copyright © 독편사편입학원 All Rights Reserved'
) FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM site_sections WHERE page = 'settings' AND section_key = 'footer');

-- cert.html/홈 갤러리 미리보기가 공용으로 쓰던 기존 정적 이미지 12장을 그대로 시드
INSERT INTO cert_gallery_images (image_url, sort_order)
SELECT * FROM (
  SELECT 'assets/pass/gallery-1.jpg' AS image_url, 1 AS sort_order UNION ALL
  SELECT 'assets/pass/gallery-2.jpg', 2 UNION ALL
  SELECT 'assets/pass/gallery-3.jpg', 3 UNION ALL
  SELECT 'assets/pass/gallery-4.jpg', 4 UNION ALL
  SELECT 'assets/pass/gallery-5.jpg', 5 UNION ALL
  SELECT 'assets/pass/gallery-6.jpg', 6 UNION ALL
  SELECT 'assets/pass/gallery-7.jpg', 7 UNION ALL
  SELECT 'assets/pass/gallery-8.jpg', 8 UNION ALL
  SELECT 'assets/pass/gallery-9.jpg', 9 UNION ALL
  SELECT 'assets/pass/gallery-10.jpg', 10 UNION ALL
  SELECT 'assets/pass/gallery-11.jpg', 11 UNION ALL
  SELECT 'assets/pass/gallery-12.jpg', 12
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM cert_gallery_images);

-- faq.html에 하드코딩되어 있던 환불 규정 FAQ 6개 시드
INSERT INTO faq_items (question, answer, sort_order)
SELECT * FROM (
  SELECT '중도 환불이 가능한가요?' AS question,
    '본 상품은 등록 즉시 프리미엄 VOD, 자체 제작 모의논술, 학교별 분석자료, 학습 시스템 이용권이 개방되는 즉시 제공형 연간 패키지 상품입니다.\n\n환불 요청 시 관계 법령 및 소비자분쟁해결기준에 따라 처리하되, 이미 제공되었거나 개방된 콘텐츠·자료·시스템 세팅 비용·사용된 첨삭권은 제공분으로 산정되어 공제될 수 있습니다.\n\n학원법 시행령은 수강을 포기한 경우 반환사유가 발생한 것으로 보고, 발생일부터 5일 이내 별표 기준에 따라 반환하도록 정하며, 원격교습은 실제 수강했거나 저장한 부분을 제외하고 반환하도록 규정합니다.' AS answer,
    1 AS sort_order UNION ALL
  SELECT '7월에 등록하고 8월에 환불을 요청하면 어떻게 계산되나요?',
    '결제일과 환불 요청일 사이의 이용 기간, 열람한 콘텐츠, 사용한 첨삭권을 기준으로 관계 법령에 따라 공제 후 정산됩니다.',
    2 UNION ALL
  SELECT 'VOD를 아직 많이 보지 않았어도 공제되나요?',
    '시청 여부와 관계없이 등록 즉시 개방된 콘텐츠·시스템 이용권은 제공분으로 산정되어 공제될 수 있습니다.',
    3 UNION ALL
  SELECT '첨삭권은 사용하지 않으면 환불되나요?',
    '사용하지 않은 첨삭권은 환불 산정 시 반영되며, 이미 사용된 첨삭권은 제공분으로 공제됩니다.',
    4 UNION ALL
  SELECT '첨삭권은 다음 달로 이월되나요?',
    '첨삭권 이월 여부는 상품별 이용 약관에 따라 다르므로 고객센터로 문의해주세요.',
    5 UNION ALL
  SELECT '단순 변심으로도 환불이 가능한가요?',
    '관계 법령 및 소비자분쟁해결기준에 따라 단순 변심의 경우에도 환불 요청이 가능하나, 이미 제공된 콘텐츠·자료·시스템 세팅 비용은 공제될 수 있습니다.',
    6
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM faq_items);

-- 공지사항 카테고리 시드 (dock-pass 참고 — 공지/이벤트/업데이트 기본 3종)
INSERT INTO notice_categories (name, sort_order)
SELECT * FROM (
  SELECT '공지' AS name, 1 AS sort_order UNION ALL
  SELECT '이벤트', 2 UNION ALL
  SELECT '업데이트', 3
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM notice_categories);

-- 공지사항 1건 시드 (관리자 페이지 신규 탭이 빈 화면으로 뜨지 않도록)
INSERT INTO notices (category, title, body, pinned, notice_date)
SELECT '공지', '독편사 DOCK PASS 서비스 오픈 안내', '프리미엄 VOD 서비스가 정식 오픈했습니다. 많은 이용 바랍니다.', 1, CURDATE()
WHERE NOT EXISTS (SELECT 1 FROM notices);

-- ── VOD 강의 상세보기 개편 (2026-07) — 카테고리 관리, 클래스소개 체크리스트/태그/자유섹션, 커리큘럼 ──

-- VOD 카테고리 (notice_categories와 동일 패턴, 관리자 페이지에서 CRUD)
CREATE TABLE IF NOT EXISTS vod_categories (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 관리자 카테고리 드롭다운이 vod_categories 테이블 기준으로만 채워지므로, 이미 vod_courses.category_label에
-- 쓰이고 있던 기존 값들을 여기 백필해야 기존 강의를 수정할 때 카테고리가 "없음"으로 보이지 않는다.
-- (재실행 안전: 이미 등록된 이름은 건너뛴다)
INSERT INTO vod_categories (name, sort_order)
SELECT DISTINCT category_label, 0
FROM vod_courses
WHERE category_label IS NOT NULL AND category_label != ''
  AND category_label NOT IN (SELECT * FROM (SELECT name FROM vod_categories) AS existing_names);

-- 클래스소개 탭 "CLASS INTRO" 체크리스트 항목
CREATE TABLE IF NOT EXISTS vod_course_checklist_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  vod_course_id BIGINT NOT NULL,
  content VARCHAR(500) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vci_course FOREIGN KEY (vod_course_id) REFERENCES vod_courses(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 클래스소개 탭 "RECOMMENDED FOR" 추천 대상 태그
CREATE TABLE IF NOT EXISTS vod_course_tags (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  vod_course_id BIGINT NOT NULL,
  label VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vct_course FOREIGN KEY (vod_course_id) REFERENCES vod_courses(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 클래스소개 탭에 자유롭게 추가하는 제목+내용 섹션
CREATE TABLE IF NOT EXISTS vod_course_sections (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  vod_course_id BIGINT NOT NULL,
  heading VARCHAR(300) NOT NULL,
  content TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vcs_course FOREIGN KEY (vod_course_id) REFERENCES vod_courses(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 타이틀영역 신규 필드 (기존 members 테이블에 썼던 것과 동일한 idempotent ALTER 패턴)
ALTER TABLE vod_courses
  ADD COLUMN IF NOT EXISTS completion_criteria VARCHAR(200) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS total_duration_text VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS difficulty VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS difficulty_visible TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS intro_heading VARCHAR(300) DEFAULT '클래스에서 배울 수 있는 내용이에요',
  ADD COLUMN IF NOT EXISTS intro_paragraph TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS recommended_heading VARCHAR(300) DEFAULT '이런 분들께 추천해요';

-- ── VOD 강의 수정 페이지 개편 (2026-07) — 커리큘럼 스텝별 자료 첨부 ──
-- class_chapter_attachments와 동일한 presign→PUT→confirm 업로드 패턴. VOD는 챕터가 아닌
-- vod_course_lectures 행이 이미 존재하므로 chapter_key 대신 lecture id로 바로 묶는다.
CREATE TABLE IF NOT EXISTS vod_course_lecture_materials (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  vod_course_lecture_id BIGINT NOT NULL,
  title VARCHAR(300) NOT NULL,        -- 표시용 파일명
  file_url VARCHAR(500) NOT NULL,     -- 공개 서빙 경로 (/uploads/{file_key})
  file_key VARCHAR(500) NOT NULL,     -- R2 오브젝트 key
  mime_type VARCHAR(100),
  file_size BIGINT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vclm_lecture FOREIGN KEY (vod_course_lecture_id) REFERENCES vod_course_lectures(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 커리큘럼 스텝별 소개 콘텐츠 (강좌 개요·수강 대상·학습 목차 등). v1의 섹션/그룹/불릿 구조화 편집 대신
-- TOAST UI 에디터로 마크다운 원문을 한 번에 작성 — 관리자 작성 속도 우선, 원문 그대로 저장한다.
ALTER TABLE vod_course_lectures
  ADD COLUMN IF NOT EXISTS content_markdown LONGTEXT DEFAULT NULL;

-- ── 영상 업로드 다중 계층 폴더 (FTP 스타일, 2026-07) ──
-- lecture_videos가 하나의 평평한 목록이라 강의 수가 늘어나면 찾기 어려워짐 → 폴더/하위폴더로 구조화.
CREATE TABLE IF NOT EXISTS video_folders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT DEFAULT NULL,      -- NULL = 최상위(루트) 폴더
  name VARCHAR(200) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_video_folders_parent FOREIGN KEY (parent_id) REFERENCES video_folders(id) ON DELETE RESTRICT,
  UNIQUE KEY uq_video_folder_name (parent_id, name)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- folder_id는 애플리케이션 레이어에서 유효성 검증 (notices.category/vod_courses.category_label과
-- 동일하게 FK 제약 없는 느슨한 참조 — 기존 테이블에 idempotent하게 FK를 추가하는 문법 리스크를 피함)
ALTER TABLE lecture_videos
  ADD COLUMN IF NOT EXISTS folder_id BIGINT DEFAULT NULL;

-- ── 수강후기 (reviews.html) ──
-- course_name은 vod_courses.title과 자유 참조(FK 없음) — notices.category/vod_courses.category_label과 동일한 이유.
CREATE TABLE IF NOT EXISTS reviews (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_name VARCHAR(50) NOT NULL,   -- 이미 마스킹된 형태로 저장, 예: "이○준 수강생"
  review_date DATE NOT NULL,
  course_name VARCHAR(100) NOT NULL,
  rating DECIMAL(2,1) NOT NULL DEFAULT 5.0,
  review_text LONGTEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- reviews.html에 하드코딩되어 있던 후기 10개 시드
INSERT INTO reviews (student_name, review_date, course_name, rating, review_text, sort_order)
SELECT * FROM (
  SELECT '이○준 수강생' AS student_name, '2026-02-14' AS review_date, '독해학개론' AS course_name, 5.0 AS rating,
    '이제 막 논술을 시작해 노베이스 상태인 저에게는 본강의가 독해의 기본적인 방향을 익히는것에 많은 도움이 되었습니다. 논술시험의 답안과 평가자료를 함께 보여주시며 평가자의 입장에서 어떤 방향으로 독해를 하고 글을 써야 좋은 평가를 받을 수 있는지, 어떤 부분을 이해하며 글을 읽어야 하는지 등 무심코 지나칠 수 있는 부분을 날카롭게 잡아주셨고 특히 저와같이 노베이스인 수강생들도 이해하기 쉬운 예시와 직접적인 표현을 사용해주시는 점이 만족스러웠습니다.' AS review_text,
    1 AS sort_order UNION ALL
  SELECT '김○영 수강생', '2026-03-22', '자료해석특강', 5.0,
    '대학에서 부전공으로 정치외교학을 들을 만큼 정치학이라는 분야에 관심이 많아 내가 아는 부분을 확인해 보자는 생각으로 편안한 마음을 가지고 김현수 선생님의 민주주의 특강을 수강하였습니다. 강의를 들으며 민주주의와 법치주의라는 방대하고 모호할 수도 있는 개념들을 최근의 사례와 판례를 가지고 설명을 해주셔서 이해가 잘 되었습니다. 논술 준비를 위해서만이 아니라 살면서 알아가야 할 소양을 쌓을 수 있는 계기가 되었습니다.',
    2 UNION ALL
  SELECT '최○민 수강생', '2026-01-30', '연세대 특별반', 4.5,
    '논술기초를 다지기 위해 정지윤 선생님이 속한 방특반을 수강했었습니다! 선생님께서 기본부터 잘 가르쳐주시고, 편입논술대비를 위해 유형별로 하나씩 배워나가는 과정 속에서 도움을 많이 받은 것 같습니다. 비록 어려운 문제를 마주했을때는 저 스스로 문제 풀이에 어려움이 있었지만, 앞으로 첨삭과 복습을 통해 다시 공부해나가도록 하겠습니다!',
    3 UNION ALL
  SELECT '박○희 수강생', '2026-05-11', '연고대 편입논술 완성', 5.0,
    '3월부터 독편사 편입 논술학원을 다니고 있는데요! 저는 전북 완주의 작은 시골 동네에 살고 있어서 논술을 제대로 공부할 곳이 마땅치 않아 포기해야하나 싶었는데, 정말 우연찮게 이렇게나 좋은 학원을 알게 돼서 진심으로 행운이라고 생각합니다. 현강을 못 가서 소외되진 않을까 걱정했는데 전혀요. 오히려 공부 환경이 좋지 않다는 걸 알고 더 신경 써주시는 게 눈에 보여서 감사할 뿐입니다. 연고대 편입 논술 준비하시는 모든 분들, 여기가 짱입니다.',
    4 UNION ALL
  SELECT '정○아 수강생', '2026-04-03', '연고대 편입논술 프리미엄반', 5.0,
    '민유정 선생님께서는 항상 열정적으로 강의하십니다. 지문 해석과 답안 해설을 하실 때 곧장 답을 알려주시지 않으시고 시간을 내어 생각하게 하셔서 사고의 힘을 길러주실 뿐만 아니라 따로 정리할 시간도 주셔서 좋습니다. 가면 갈수록 제 글의 문제점을 잘 알게 하시고 그래서 저 또한 글을 쓰고 나서 문제점을 파악하고 보완까지 할 수 있어서 글쓰기에 정말 도움이 됩니다.',
    5 UNION ALL
  SELECT '한○솔 수강생', '2026-06-19', '자료해석특강', 5.0,
    '자료해석 유형이 오랫동안 약점이었는데 이 강의를 듣고 나서야 접근 방식 자체가 잘못됐다는 걸 알았습니다. 표와 그래프를 읽는 순서, 시간 배분까지 실전 문제로 반복 훈련을 시켜주셔서 실전 감각이 확실히 붙었습니다. 혼자 풀 때는 늘 시간이 부족했는데 이제는 여유 있게 검토까지 할 수 있게 됐어요.',
    6 UNION ALL
  SELECT '윤○호 수강생', '2026-02-27', '논술 유형별 대처법', 5.0,
    '연고대 기출을 연도별로 꼼꼼하게 짚어주셔서 출제 경향이 눈에 들어오기 시작했습니다. 단순히 문제를 푸는 데 그치지 않고 왜 그 답이 고득점 답안인지 채점 기준까지 짚어주셔서 실전에서 무엇을 써야 할지 감을 잡을 수 있었습니다. 마무리 단계에 정말 추천하는 패키지입니다.',
    7 UNION ALL
  SELECT '서○진 수강생', '2026-07-02', '독해학개론', 4.5,
    '지문 구조를 파악하는 방법을 체계적으로 배우고 나니 독해 속도가 눈에 띄게 빨라졌어요. 처음에는 기초 개념 위주라 조금 지루하게 느껴졌지만, 뒤로 갈수록 실전 지문에 바로 적용할 수 있어서 결과적으로 가장 기본기를 탄탄히 잡아준 강의였습니다.',
    8 UNION ALL
  SELECT '임○우 수강생', '2026-03-15', '연세대 특별반', 5.0,
    '연세대 기출 분석이 정말 꼼꼼해서 실전 감각을 확실히 익혔습니다. 다른 대학과 헷갈리기 쉬운 연세대만의 출제 포인트를 짚어주셔서 저처럼 연세대만 목표로 하는 수강생에게는 더할 나위 없이 유용했어요. 강사님 설명도 명쾌하고 질문에도 늘 성심껏 답해주셨습니다.',
    9 UNION ALL
  SELECT '오○연 수강생', '2026-05-28', '연고대 편입논술 프리미엄반', 5.0,
    '혼자 1년을 준비할 자신이 없어서 관리형인 프리미엄반을 선택했는데 결과적으로 정말 잘한 선택이었습니다. 매주 정해진 분량을 못 채우면 먼저 연락 주셔서 다잡아 주시고, 첨삭도 꼼꼼해서 끝까지 완주할 수 있었습니다. 관리받으며 공부하는 게 이렇게 큰 힘이 될 줄 몰랐어요.',
    10
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM reviews);
