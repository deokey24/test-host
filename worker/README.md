# 영상 트랜스코딩 워커

SQS에서 업로드 완료 작업을 받아 R2 원본을 다운로드 → ffmpeg 압축 → R2에 재업로드 → MySQL에 최종 경로를 기록하는 독립 실행형 Node.js 앱. 운영 서버(`server.js`)와는 별도의 EC2 인스턴스에 배포한다.

## 배포 (워커 인스턴스가 이미 생성된 이후)

전체 부트스트랩은 `infra/install-worker-instance.sh` 참고 (ffmpeg/Node 설치, 저장소 클론, systemd 등록까지 자동화). 요약:

```bash
ssh -i dockteacher-web.pem ubuntu@<워커 인스턴스 IP> 'bash -s' < infra/install-worker-instance.sh
```

이후 워커 인스턴스에서 `worker/.env.example`을 참고해 `worker/.env`를 작성하고:

```bash
sudo systemctl start dockteacher-worker
sudo systemctl status dockteacher-worker
journalctl -u dockteacher-worker -f
```

## AWS 자격증명 관련

- **SQS 소비 / 자기 자신 stop**: 워커 인스턴스에 연결된 IAM 인스턴스 프로필(`dockteacher-worker-role`, `infra/iam-policy-worker-role.json`)을 통해 자동으로 인증된다. `.env`에 AWS Access Key를 넣을 필요 없음 (SDK 기본 자격증명 체인이 인스턴스 프로필을 사용).
- **R2**: Cloudflare는 AWS IAM을 쓰지 않으므로 `.env`의 `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`가 반드시 필요.

## 동작 흐름

1. `index.js`가 SQS를 롱폴링, 현재 처리 중인 작업 수(`activeJobs`)만큼의 여유 용량(capacity)으로만 메시지를 가져옴
2. 메시지당 `processJob()` 실행 — `p-limit(5)`로 동시 실행 개수를 하드 캡핑 (환경변수 `WORKER_CONCURRENCY`로 조정 가능)
3. R2 raw 다운로드 → `src/transcode.js`(ffmpeg) 압축 → R2 final 업로드 → DB `status=done` 기록 → 로컬 임시 파일 삭제 → SQS 메시지 삭제
4. 실패 시 DB에 `status=failed`와 에러 메시지 기록 (재시도 로직은 없음 — 실패한 영상은 관리자가 확인 후 재업로드하는 것을 전제로 단순하게 구현)
5. `idleShutdownWatcher()`가 1분마다 확인: 처리 중인 작업이 없고, SQS 큐가 완전히 비어있고, 마지막 활동 이후 `IDLE_TIMEOUT_MINUTES`(기본 10분) 이상 지났으면 자기 자신을 `stop-instances` — 운영 서버가 다음 업로드 시 자동으로 다시 깨움 (`lib/ec2.js`의 `wakeWorkerInstance()`)
