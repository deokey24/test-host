# 워커 오토스케일링 설계 — 단일 인스턴스 stop/start → Auto Scaling Group 전환

기존 설계(바탕화면 `영상업로드-아키텍처.md`, Phase E-0)는 단일 워커 인스턴스를 stop/start로 재사용하는 방식이었다.
이 문서는 그것을 **ASG(min=0) 기반 — 필요할 때 인스턴스를 띄우고, 끝나면 terminate — 방식**으로 전환하는 설계다.
여러 관리자가 동시에 업로드해도 큐 깊이에 따라 인스턴스가 늘어나고, 일이 끝나면 0대로 돌아간다.

## 유지되는 것 (변경 없음)

- **브라우저 → R2 직접 업로드** (presigned multipart). 워커 인스턴스는 파일을 "받는" 게 아니라 R2 `raw/`에서 당겨간다. 관리자 페이지 업로드 UI, presign/complete API 구조 동일.
- **SQS 작업 큐** — 메시지엔 `{ videoId, rawKey, title }` 메타데이터만.
- **MySQL 상태 추적** (`uploading → queued → processing → done/failed`), 워커 SG → 운영 서버 3306 규칙은 SG 단위 참조라 ASG 인스턴스 전체에 자동 적용됨.
- **인스턴스당 동시 처리 5개 캡핑** (`p-limit`), `c6i.8xlarge` + gp3 1TB 사양 근거.

## 바뀌는 것 — 개요

```
[관리자 브라우저] ── presign 요청 ──▶ [운영 서버]
                                        │ ① DB 레코드 생성 + presigned URL 발급
                                        │ ② 이 시점에 ASG desired capacity 선반영
                                        │    (업로드가 수십 분 걸리므로 부팅 시간이 업로드 시간에 숨음)
[브라우저 ──▶ R2 raw/ 멀티파트 업로드 (수십 분)]
                                        │ ③ /complete → SQS 발행 + desired 재계산
                                        ▼
[ASG: dockteacher-worker-asg (min=0, max=3)]
   │ 큐 깊이에 따라 0~3대. 각 인스턴스는 골든 AMI로 부팅
   │ → user-data가 SSM에서 .env 로드 + git pull → systemd로 워커 시작
   │ → SQS 소비, 동시 5개 처리
   │ → 유휴(큐 비고 작업 없음, N분)면 자기 자신을
   │    TerminateInstanceInAutoScalingGroup(desired 감소)으로 종료
   ▼
[R2 final/ 업로드 + MySQL done 기록] — 기존과 동일
```

## 1. 골든 AMI + Launch Template

### AMI
- 현재 `infra/install-worker-instance.sh`로 셋업한 인스턴스(ffmpeg, Node, 워커 코드, systemd 유닛 등록)를 **AMI로 베이크**한다.
- **`.env`(시크릿)는 AMI에 굽지 않는다** — 인스턴스가 여러 개라 파일 배포가 불가능하고, AMI 유출 시 시크릿까지 유출되기 때문. 대신 SSM Parameter Store(아래 3절).
- systemd 유닛은 AMI에서 `disabled` 상태로 두고, user-data가 `.env` 생성 후 `systemctl start`한다 (`.env` 없이 서비스가 먼저 뜨는 순서 문제 방지).

### "AMI 최신화 관리 포인트" 해소
기존 문서가 ASG를 보류한 이유가 이것이었다. 해소 방법:
- user-data에서 부팅 시 `git pull && npm ci --omit=dev` → **워커 코드 변경은 AMI 재베이크 없이 다음 부팅부터 반영**.
- AMI 재베이크가 필요한 경우는 OS/ffmpeg/Node 버전 업그레이드뿐 — 드물고, 그때만 새 AMI로 Launch Template 새 버전 발행.

### Launch Template
- 인스턴스 타입 `c6i.8xlarge`, 워커 SG, `dockteacher-worker-role` 인스턴스 프로필
- 블록 디바이스: gp3 1TB, Throughput 700MB/s, IOPS 8000, `DeleteOnTermination: true`
  - terminate 방식이므로 **정지 중 EBS 보관 비용(월 ~$100/TB)도 0이 됨** — stop/start 대비 추가 절감
- 태그 `Project=dockteacher-worker` (IAM 정책 조건과 매칭)
- user-data: SSM에서 시크릿 로드 → `.env` 작성 → `git pull` + `npm ci` → `systemctl start dockteacher-worker`

## 2. 스케일아웃 — 운영 서버가 desired capacity를 직접 올림

CloudWatch 경보 기반 target tracking도 가능하지만, SQS 지표는 1분 단위 + 경보 평가 지연이 있어 최대 수 분 늦는다. 업로드 이벤트를 운영 서버가 이미 알고 있으므로 **운영 서버가 직접 올리는 게 가장 빠르고 단순**하다.

- `lib/ec2.js`의 `wakeWorkerInstance()` → `lib/asg.js`의 `ensureWorkerCapacity()`로 교체:
  ```
  총작업수 = SQS visible + inFlight + (지금 발행하려는 1건)
  needed  = min(MAX_WORKERS, ceil(총작업수 / 5))
  if (needed > 현재 desired) SetDesiredCapacity(needed)
  ```
- **올리기만 하고 절대 내리지 않는다.** 내리는 건 워커 자신(3절). 이 비대칭이 레이스를 없애는 핵심.
- 호출 시점 2곳:
  1. **`POST /admin/api/videos/presign`** — 업로드 시작 시점에 1대 선기동. 20~30GB 업로드가 수십 분 걸리므로 부팅(~2분)이 업로드 시간에 완전히 숨는다. 업로드가 중도 포기되어도 유휴 타이머로 알아서 내려가므로 부작용 없음.
  2. **`POST /admin/api/videos/:id/complete`** — SQS 발행 직전에 큐 깊이 기준 재계산 (다중 동시 업로드 대응).
- **백업 안전망**: CloudWatch 경보 `ApproximateNumberOfMessagesVisible ≥ 1 (5분 지속)` → step scaling으로 +1. 운영 서버의 SetDesiredCapacity 호출이 어떤 이유로 실패해도 큐가 방치되지 않게 하는 2차 장치. (평시엔 운영 서버가 먼저 올려놓으므로 발동하지 않음)

### 동시 사용자 시나리오
관리자 3명이 총 7건 업로드 → complete 시점 큐 깊이 7 → desired = ceil(7/5) = 2 → 2대가 5 + 2건 분담. max=3이면 최대 15건 동시 처리, 16건째부터는 큐 대기 (인스턴스가 비는 즉시 소비).

## 3. 스케일인 — 워커의 자기 종료 (stop → terminate)

ASG가 임의로 인스턴스를 골라 죽이면 트랜스코딩 중인 작업이 날아간다. 따라서:

- ASG에 **`NewInstancesProtectedFromScaleIn: true`** — ASG 주도 스케일인을 원천 차단.
- 워커의 `idleShutdownWatcher`를 다음으로 교체 (`stopSelf` 제거):
  1. 유휴 조건 충족(activeJobs=0, 큐 empty, N분 경과) → **폴링 루프 중단**
  2. 큐를 한 번 더 확인 (종료 결심 직후 도착한 메시지 레이스 방지)
  3. 여전히 비어있으면 `TerminateInstanceInAutoScalingGroup(instanceId, ShouldDecrementDesiredCapacity: true)` — 자기 자신 종료 + desired 감소를 원자적으로 처리
  4. 2에서 메시지가 발견되면 폴링 재개
- 3의 재확인을 뚫고 메시지가 남는 극단적 레이스가 나도, 백업 CloudWatch 경보(2절)가 5분 내 새 인스턴스를 띄우므로 작업이 유실되지 않는다.

## 4. 중단 내성 보강 — 인스턴스가 일회용이 되므로 필수

기존 단일 인스턴스 전제에서는 없어도 됐지만, terminate/스팟/다중 인스턴스 환경에선 아래가 필요하다.

### 4-1. SQS visibility 하트비트
- 현재: `VisibilityTimeout: 21600`(6시간) 고정 → 인스턴스가 급사하면 메시지가 6시간 동안 잠김.
- 변경: 수신 시 30분 + **처리 중 10분마다 `ChangeMessageVisibility`로 30분씩 연장**.
- 효과: 처리 중 인스턴스가 죽으면 최대 30분 내 메시지가 다시 보이고, 다른(또는 새) 인스턴스가 재처리. **원본이 R2 `raw/`에 있으므로 처음부터 다시 하면 된다** — 기존 설계의 "원본 안전성" 원칙이 여기서 진가를 발휘.

### 4-2. 멱등성
- 재전달된 메시지를 받으면 먼저 DB에서 `status` 확인 — 이미 `done`이면 메시지만 삭제하고 스킵.
- `processing`이면 이전 인스턴스가 죽은 것이므로 정상 재처리. (final 업로드는 같은 키 덮어쓰기라 중복 실행도 무해)

### 4-3. DLQ
- `dockteacher-video-jobs-dlq` 생성, redrive policy `maxReceiveCount: 3`.
- 3번 재처리에도 실패(인스턴스 반복 사망 등)하면 DLQ로 빠지고, 워커가 DB에 `failed`를 기록하지 못한 케이스는 관리자 목록에서 `processing` 정체로 드러남 → 운영 서버가 목록 조회 시 "processing인데 SQS에 메시지 없음" 상태를 `failed`로 정리하는 스윕(선택).
- 앱 레벨 실패(ffmpeg 에러 등)는 기존대로 `failed` 기록 + 메시지 삭제 유지 (SQS 재시도는 인스턴스 급사 케이스만 담당).

### 4-4. SIGTERM 그레이스풀 드레인
- SIGTERM 수신 시: 폴링 중단 → 진행 중 작업 완료까지 대기 → 종료.
- systemd 유닛에 `TimeoutStopSec=7200` 설정 (강제 kill 방지).
- 수동 종료·배포 재시작 시 작업 유실 방지. (스팟 회수 2분 경고에는 트랜스코딩을 못 끝내므로 — 그 경우는 4-1의 재처리에 맡긴다)

## 5. 시크릿 관리 — SSM Parameter Store

인스턴스가 여러 개 + 일회용이라 `.env` 수동 배포가 불가능해지므로:

- `/dockteacher/worker/R2_ACCESS_KEY_ID`, `/dockteacher/worker/R2_SECRET_ACCESS_KEY`, `/dockteacher/worker/DB_PASSWORD` 등을 SecureString으로 저장.
- user-data가 부팅 시 `aws ssm get-parameters-by-path --with-decryption`으로 받아 `.env` 생성.
- 키 로테이션 = SSM 값 교체 (다음 부팅부터 반영, AMI/인스턴스 손댈 필요 없음).

## 6. IAM 변경

### `dockteacher-worker-role` (워커 인스턴스)
- 제거: `ec2:StopInstances`
- 추가:
  - `autoscaling:TerminateInstanceInAutoScalingGroup` — `ResourceTag/Project=dockteacher-worker` 조건
  - `sqs:ChangeMessageVisibility` — 기존 큐 ARN 한정
  - `ssm:GetParameter*` — `parameter/dockteacher/worker/*` 한정 (+ 해당 KMS 키 `kms:Decrypt`)

### `dockteacher-production-role` (운영 서버)
- 제거: `ec2:StartInstances`, `ec2:DescribeInstances`(워커용)
- 추가:
  - `autoscaling:SetDesiredCapacity` — `ResourceTag/Project=dockteacher-worker` 조건
  - `autoscaling:DescribeAutoScalingGroups` (Describe는 리소스 조건 불가 — 전체 허용이지만 읽기 전용)
  - `sqs:GetQueueAttributes` (큐 깊이 조회, 기존에 없다면)

## 7. 스팟 인스턴스 (선택 — 2단계)

4절의 재처리 내성이 갖춰지면 스팟 도입이 안전해진다:
- Mixed Instances Policy: 스팟 우선, 온디맨드 폴백. 인스턴스 타입 다변화(`c6i.8xlarge`, `m6i.8xlarge`, `c5.9xlarge`)로 스팟 가용성 확보. 할당 전략 `capacity-optimized`.
- 절감: 온디맨드 대비 약 60~70%.
- 트레이드오프: 트랜스코딩 도중 회수되면 해당 작업은 처음부터 재시작 (최대 수십 분 손실). 업로드가 급하지 않은 워크로드 특성상 허용 가능 — 단, **먼저 온디맨드로 전체 파이프라인을 안정화한 뒤** 도입할 것.

## 8. 비용 비교 (참고)

| 항목 | stop/start (기존) | ASG terminate (신규) |
|---|---|---|
| 컴퓨팅 (유휴 시) | 0 | 0 |
| EBS 1TB (유휴 시) | 월 ~$100 상시 발생 | **0** (볼륨도 삭제됨) |
| 기동 지연 | ~40초 | ~2분 (presign 선기동으로 체감 0) |
| 동시 처리 상한 | 5건 (1대 고정) | 5 × max대 (기본 15건) |
| 코드 배포 | 인스턴스에 직접 | git push → 다음 부팅 자동 반영 |

컴퓨팅: `c6i.8xlarge` 서울 온디맨드 시간당 약 $1.7 — 30GB 영상 1건당 트랜스코딩 30~60분 가정 시 건당 $1~2 수준. 스팟 적용 시 그 30~40%.

## 9. 구축 순서 (Phase F)

기존 Phase A~E 위에 증분으로 진행. **F-1은 ASG 없이도 가치가 있으므로 먼저 배포해 검증.**

- **F-1. 워커 내성 보강** (현재 단일 인스턴스에서 먼저 적용·검증)
  - visibility 하트비트(4-1), 멱등성 체크(4-2), DLQ + redrive(4-3), SIGTERM 드레인(4-4)
- **F-2. 시크릿·부트스트랩**
  - SSM 파라미터 등록, user-data 스크립트 작성(`infra/worker-user-data.sh`), systemd 유닛 disabled 전환
  - 현 인스턴스에서 user-data 절차 수동 리허설 → 골든 AMI 베이크
- **F-3. ASG 생성**
  - Launch Template + ASG(min=0, desired=0, max=3, scale-in protection) 생성 스크립트 (`infra/provision-asg.sh`)
  - IAM 두 역할 정책 개정(6절), 백업 CloudWatch 경보 + step scaling
- **F-4. 애플리케이션 전환**
  - 워커: `stopSelf` → `terminateSelfViaAsg` (3절 시퀀스)
  - 운영 서버: `wakeWorkerInstance` → `ensureWorkerCapacity` (presign + complete 두 지점)
- **F-5. 컷오버**
  - 소용량 영상으로 ASG 경로 전체 흐름 검증 → 기존 단일 인스턴스 종료 (AMI가 원본이므로 보존 불필요)
- **F-6. (선택) 스팟 전환** — 7절

## 10. 검증 시나리오

1. 큐에 1건 → presign 시점에 desired 0→1, 인스턴스 부팅 → user-data로 `.env`/코드 셋업 → 처리 → `done` → N분 후 자기 종료 & desired 1→0
2. 동시 7건 투입 → desired 2로 스케일아웃, 두 인스턴스가 분담 처리
3. **처리 중 인스턴스 강제 terminate** → 30분 내 메시지 재노출 → (경보 또는 잔여 인스턴스가) 재처리 → 최종 `done` (원본 유실 없음 확인)
4. 이미 `done`인 videoId 메시지 중복 투입 → 스킵되고 삭제되는지 (멱등성)
5. 처리 중 `systemctl stop` → 진행 중 작업 완료 후 종료되는지 (드레인)
6. 운영 서버의 SetDesiredCapacity를 인위적으로 실패시킨 뒤 → CloudWatch 백업 경보로 5분 내 기동되는지
7. MySQL `max_connections` — 3대 × 커넥션 풀 크기 동시 접속 여유 확인
