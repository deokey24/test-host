-- 운영 서버(54.116.171.96)의 MySQL 8에 적용할 스키마
-- 실행: mysql -u root -p < infra/schema.sql

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
