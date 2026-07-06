# 영상 트랜스코딩 워커

SQS에서 업로드 완료 작업을 받아 R2 원본을 다운로드 → ffmpeg 압축 → R2에 재업로드 → MySQL에 최종 경로를 기록하는 독립 실행형 Node.js 앱. 운영 서버(`server.js`)와는 별도의 EC2 인스턴스에 배포한다.

## 배포 — Auto Scaling Group 기반 (설계: `infra/autoscaling-design.md`)

워커는 골든 AMI로 구운 뒤 ASG(min=0, max=3)가 큐 깊이에 따라 띄우고, 유휴 시 스스로 terminate한다:

1. 베이스 인스턴스에 `infra/install-worker-instance.sh` 실행 (ffmpeg/Node/코드/systemd 유닛 셋업) → AMI 베이크
2. `infra/provision-asg.sh`로 DLQ / Launch Template / ASG / 백업 경보 생성
3. 부팅 시마다 `infra/worker-user-data.sh`가 `git pull` + SSM에서 `.env` 생성 + `systemctl start` — **코드 변경은 git push만 하면 다음 부팅부터 반영** (AMI 재베이크 불필요)

로그 확인: `journalctl -u dockteacher-worker -f`, user-data 로그는 `/var/log/worker-user-data.log`

## AWS 자격증명 관련

- **SQS 소비 / ASG 자기 종료 / SSM 파라미터 읽기**: 워커 인스턴스에 연결된 IAM 인스턴스 프로필(`dockteacher-worker-role`, `infra/iam-policy-worker-role.json`)을 통해 자동으로 인증된다. `.env`에 AWS Access Key를 넣을 필요 없음 (SDK 기본 자격증명 체인이 인스턴스 프로필을 사용).
- **R2 / DB 등 시크릿**: SSM Parameter Store `/dockteacher/worker/*`(SecureString)에 저장하고 부팅 시 user-data가 `.env`로 내려받는다. AMI에 시크릿을 굽지 않는다.

## 동작 흐름

1. `index.js`가 SQS를 롱폴링, 현재 처리 중인 작업 수(`activeJobs`)만큼의 여유 용량(capacity)으로만 메시지를 가져옴
2. 메시지 수신 시 먼저 DB `status` 확인 — 이미 `done`이면 스킵 (인스턴스 급사 후 재전달된 메시지 멱등 처리)
3. 메시지당 `processJob()` 실행 — `p-limit(5)`로 동시 실행 개수를 하드 캡핑 (환경변수 `WORKER_CONCURRENCY`로 조정 가능). 처리 중엔 10분마다 `ChangeMessageVisibility`로 메시지를 30분씩 연장(하트비트) — 인스턴스가 죽으면 연장이 끊겨 30분 내 다른 인스턴스가 재처리 (원본이 R2 `raw/`에 있으므로 처음부터 다시 하면 됨, `maxReceiveCount=3` 초과 시 DLQ)
4. R2 raw 다운로드 → `src/transcode.js`(ffmpeg) 압축 → R2 final 업로드 → DB `status=done` 기록 → 로컬 임시 파일 삭제 → SQS 메시지 삭제
5. 앱 레벨 실패(ffmpeg 에러 등) 시 DB에 `status=failed` 기록 + 메시지 삭제 — 재시도해도 같은 결과이므로 관리자 재업로드 전제. SQS 재전달은 인스턴스 급사 케이스만 담당
6. **유휴 자기 종료**: 롱폴링이 빈손으로 돌아온 직후, 처리 중 작업이 없고 `IDLE_TIMEOUT_MINUTES`(기본 10분) 경과 + 큐가 완전히 비었으면 `TerminateInstanceInAutoScalingGroup`(desired 감소)으로 자기 자신 terminate — 스케일아웃은 운영 서버가 presign/complete 시점에 `SetDesiredCapacity`로 수행 (`lib/asg.js`의 `ensureWorkerCapacity()`)
7. **SIGTERM 드레인**: 새 메시지 수신을 멈추고 진행 중 작업을 끝까지 마무리한 뒤 종료 (systemd `TimeoutStopSec=7200`)
