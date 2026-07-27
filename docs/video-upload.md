# 강의 영상 업로드 / 재인코딩 관련 문서

로컬에 있는 영상 파일을 서비스에 반영하는 방법 두 가지와, 실제로 12개 강의를 CRF18로
일괄 재인코딩했던 작업 방식/노하우를 정리한다. 전체 파이프라인 설계는
`CLAUDE.md`의 "대용량 영상 업로드 파이프라인" 절과 `infra/README.md`,
`infra/autoscaling-design.md` 참고.

## 1. 신규 로컬 파일 업로드 — 정식 경로 (관리자 페이지)

`admin/index.html`의 "강의 업로드" 기능이 원래 이 용도로 설계되어 있다:

1. 관리자 페이지에서 로컬 영상 파일 선택
2. 브라우저가 R2 멀티파트 presigned URL로 **R2에 직접** 업로드 (서버는 원본 대용량 파일을
   거치지 않음)
3. 업로드 완료 시 SQS에 작업 발행 → 워커(ASG, min=0)가 자동으로 픽업
4. 워커가 ffmpeg로 HLS 트랜스코딩(AES-128 세그먼트 암호화 포함, `worker/src/transcode.js`)
   → R2 `hls/<uuid>-title/` 프리픽스로 재업로드 → MySQL(`lecture_videos`) 갱신

기본 CRF는 `worker/src/transcode.js`의 `FFMPEG_CRF` 기본값(`23`)을 따른다. 화질을
더 높이고 싶으면(용량은 늘어남) 워커 인스턴스의 환경변수로 `FFMPEG_CRF`를 낮게
(예: `18`) 설정해야 하는데, 이건 골든 AMI/SSM Parameter Store 쪽 설정이라 즉시
반영은 안 되고 아래 2번 방식(수동 처리)이 더 빠르다.

## 2. 기존 R2 영상 재인코딩 / 워커 우회 수동 처리

2026-07에 강의 12개(1강~12강)를 CRF18로 일괄 재인코딩할 때 쓴 방식. **정식
SQS/워커 경로를 타지 않고, 로컬(개발 PC)에서 직접 `transcode()`를 호출**한다 —
이미 R2에 있는 영상을 다시 인코딩하거나, 워커 ASG를 띄우지 않고 급하게 처리해야
할 때 유효한 방법.

### 핵심 재사용 모듈
- `worker/src/transcode.js`의 `transcode(inputPath, outputDir)` — env `FFMPEG_CRF`
  / `FFMPEG_PRESET` / `HLS_SEGMENT_SECONDS`로 품질 조절 (require 하기 **전에**
  `process.env.FFMPEG_CRF` 등을 먼저 설정해야 반영됨 — 모듈 상단에서 한 번만 읽음)
- `worker/lib/r2.js`의 `getR2Client()` / `uploadDirectory(prefix, localDir)`
- DB 갱신 시 **커넥션은 강의(파일)마다 새로 생성** — 인코딩에 수십 분씩 걸리므로
  하나의 커넥션을 오래 붙들면 MySQL `wait_timeout`에 걸려 끊길 수 있음

### 처리 순서 (강의 1개 기준)
1. `lecture_videos`에서 `final_r2_key` 조회 → 이미 `.m3u8`로 끝나면 스킵(재실행 시
   이어서 진행 가능한 멱등성 체크)
2. R2에서 원본 mp4 다운로드 (`GetObjectCommand`)
3. `transcode(rawPath, hlsDir)` 호출 → HLS(`master.m3u8` + `segmentNNNNN.ts`) +
   암호화 키 반환
4. `uploadDirectory(prefix, hlsDir)`로 R2 업로드 (`prefix` 예:
   `hls/lecture-<id>-<제목 슬러그>-crf18`)
5. `lecture_videos.final_r2_key`/`hls_key_base64`/`status='done'` 갱신 +
   `vod_course_lectures.video_r2_key`를 옛 키 → 새 키로 갱신 (강의-영상 연결 유지)
6. 로컬 임시 파일(원본 mp4, HLS 산출물) 정리

### Windows에서 주의할 점 (실제로 겪은 함정)
- **경로는 반드시 `C:/...` 스타일** — Git Bash식 `/c/workspace/...` 문자열을 그대로
  Node에 넘기면 `MODULE_NOT_FOUND` / 파일을 못 찾는 오류가 남
- **스크립트는 `worker/` 디렉터리 안에 두고 실행할 것** — Node의 bare `require()`는
  "실행되는 파일 자신의 위치" 기준으로 모듈을 찾는다. scratchpad 등 다른 폴더에서
  실행하면 `worker/node_modules`의 `mysql2`/`@aws-sdk/client-s3`를 못 찾고 실패함
- **장시간(수십 분~몇 시간) 배치는 세션에 종속되지 않게 완전히 분리해서 실행**할 것.
  bash의 `run_in_background`는 세션의 프로세스 트리에 매달려 있어 세션이 끊기면 같이
  죽을 위험이 있다. PowerShell `Start-Process -WindowStyle Hidden -RedirectStandardOutput
  ... -RedirectStandardError ... -PassThru`로 띄우면 완전히 분리된 프로세스가 되고,
  `Get-CimInstance Win32_Process`로 부모 프로세스가 이미 종료됐는지 확인해서 검증 가능
- 강의별로 결과(`ok`, 원본/결과 용량, 소요 시간)를 매 반복마다 JSON 파일로
  저장해두면, 중간에 실패/중단되어도 어디까지 끝났는지 바로 알 수 있고 재실행 시
  1번의 멱등성 체크로 자동으로 이어서 진행됨

### CRF18 재인코딩 결과 (2026-07, 실측)
용량은 원본과 "비슷하거나 소폭 증가"하는 경우가 많았다 — CRF는 비트레이트가 아니라
품질을 고정하는 방식이라, 필기/화면전환이 잦은 강의 컨텐츠는 정적인 인트로 영상보다
압축 효율이 훨씬 떨어진다(0강 인트로 영상은 51% 감소였지만 실제 강의 영상 12개는
대부분 98~112%, 예외적으로 1강·2강만 53%/70%로 크게 줄었음). **화질 우선 목적에는
부합하지만, 용량 절감을 기대하고 재인코딩할 때는 주의**.

### 실서버 반영 시점
로컬 `.env`의 DB가 운영 서버 DB에 직결되어 있어([[project_local_env_points_to_prod_db]]
참고), 이 방식으로 DB를 갱신하면 **별도 배포 없이 즉시 실서버에 반영**된다. R2 버킷도
운영과 공유이므로 업로드 즉시 실제 서비스에서 재생 가능.

## 어떤 방법을 쓸지 판단 기준

| 상황 | 방법 |
|---|---|
| 새 강의 영상을 실제 서비스에 처음 등록 | 1번 (관리자 페이지 정식 업로드) |
| 이미 올라간 영상을 다른 화질/설정으로 다시 인코딩 | 2번 (수동 처리) |
| 워커 ASG가 아직 프로비저닝 안 됐거나 급하게 처리해야 함 | 2번 (수동 처리) |
| 여러 개를 한 번에 배치로 처리 | 2번 (수동 처리, 강의마다 순차 처리 + 결과 JSON 기록) |
