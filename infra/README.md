# 영상 업로드 파이프라인 — 인프라 준비 가이드

전체 설계는 계획 문서(`C:\Users\user\.claude\plans\sharded-frolicking-harp.md`, 바탕화면 `영상업로드-아키텍처.md`)를 참고. 이 문서는 **사용자가 직접 AWS/Cloudflare 콘솔에서 준비해야 할 것**과, 준비가 끝난 뒤 실행할 프로비저닝 절차를 정리한다.

## 1. 사용자가 먼저 해야 할 것

### 1-1. AWS IAM 사용자 생성 (프로비저닝용)
1. IAM 콘솔에서 사용자 `dockteacher-provisioner` 생성 (프로그래밍 방식 액세스)
2. `infra/iam-policy-provisioner.json` 내용을 인라인 정책으로 연결
   - 이 정책은 EC2 인스턴스/보안그룹/역할 생성과 SQS 큐 생성만 허용하며, `iam:*`·`s3:*`·결제 권한은 포함하지 않음
3. Access Key ID / Secret Access Key를 생성해서 전달 (콘솔 로그인 정보 아님, 프로그래밍 방식 키만)
4. **작업이 끝나면 이 사용자를 삭제하거나 키를 폐기(rotate)할 것**

### 1-2. Cloudflare R2 버킷 + API 토큰
1. Cloudflare 대시보드 → R2 → 버킷 생성: `dockteacher-videos`
2. R2 API 토큰 발급 시 **이 버킷에 한정된** Object Read & Write 권한만 부여 (Global API Key 전체 공유 금지)
3. Account ID, Access Key ID, Secret Access Key, 엔드포인트 URL(`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)을 전달

준비가 끝나면 두 가지(AWS Access Key, R2 자격증명)를 `.env`에만 등록하고 커밋하지 않는다 (`.gitignore`에 이미 포함됨).

### 1-3. R2 버킷 CORS 설정 (필수)
관리자 브라우저가 presigned URL로 R2에 **직접** PUT 요청을 보내고, 응답의 `ETag` 헤더를 읽어야 멀티파트 업로드를 완료할 수 있다. R2 버킷 설정 → CORS 정책에 아래를 추가:
```json
[
  {
    "AllowedOrigins": ["https://dockteacher.co.kr"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```
`ExposeHeaders`에 `ETag`가 빠지면 브라우저 JS에서 `response.headers.get('ETag')`가 항상 `null`로 나와 업로드 완료 처리가 실패한다.

### 1-4. SES 도메인 신원 확인 (회원가입/비밀번호 재설정 메일 발송용)

**현재 상태 (2026-07 `aws sesv2 get-account` / `list-email-identities` 확인 결과):**
- 검증된 신원: 도메인 `mail.dockteacher.co.kr` (SUCCESS), 테스트용 이메일 `nickname_m@naver.com` (SUCCESS)
- 계정은 **여전히 샌드박스 모드** (`ProductionAccessEnabled: false`)
- production access 신청 케이스(**178320428400132**)는 **DENIED** 상태 — 재신청/어필 필요

샌드박스 상태에서는 위 두 검증된 신원(그리고 `mail.dockteacher.co.kr` 하위 발신 주소)으로만 메일을 보낼 수 있고, DB에 있는 실제 회원 이메일(예: 개인 gmail/naver 등)로는 보낼 수 없다. `no-reply@mail.dockteacher.co.kr`에서 보내는 메일은 지금도 정상 발송되지만, 수신자가 검증된 주소가 아니면 SES가 `MessageRejected`로 거부한다.

1. (완료) SES 콘솔 → **Verified identities** → 도메인 `mail.dockteacher.co.kr` Easy DKIM 검증 완료
2. `.env`의 `SES_FROM_EMAIL=no-reply@mail.dockteacher.co.kr` 로 설정됨
3. 검증 상태 재확인 CLI:
   ```bash
   aws sesv2 get-email-identity --email-identity mail.dockteacher.co.kr --region ap-northeast-2
   aws sesv2 get-account --region ap-northeast-2
   ```
4. 실제 회원에게 발송하려면 production access 재신청이 필요하다. 케이스가 한 번 거부됐으므로, 재신청 시 거부 사유가 될 만한 부분(예: "기존 시스템에서 마이그레이션된 회원 목록"이라는 표현이 "구매/수집한 리스트"처럼 읽혔을 가능성)을 구체적으로 보완해서 새 케이스를 열거나 기존 케이스에 추가 답변을 보내야 한다.
5. 재신청 승인 전까지는 `nickname_m@naver.com`(검증된 테스트 주소)로만 실제 발송 테스트가 가능하다.
6. 운영 서버(EC2)에 연결된 `dockteacher-production-role`에 `infra/iam-policy-production-role.json`의 `SendMemberEmail` 문(`ses:SendEmail`, 리소스 `identity/mail.dockteacher.co.kr`)이 반영되어 있어야 한다.

## 2. 프로비저닝 순서 (자격증명 확보 후 실행)

```bash
# 0. AWS CLI 자격증명 등록 확인
aws sts get-caller-identity

# 1. 운영 서버(54.116.171.96)가 속한 VPC/서브넷/보안그룹 확인
aws ec2 describe-instances --filters "Name=ip-address,Values=54.116.171.96" \
  --query "Reservations[0].Instances[0].[VpcId,SubnetId,SecurityGroups]"

# 2. 워커 인스턴스용 IAM 역할 생성 + 인스턴스 프로필 연결
#    (infra/iam-policy-worker-role.json을 정책으로 연결한 dockteacher-worker-role)

# 3. 운영 서버용 IAM 역할 생성 (기존에 역할이 없다면)
#    (infra/iam-policy-production-role.json을 정책으로 연결한 dockteacher-production-role)
#    운영 서버 EC2에 이 역할을 인스턴스 프로필로 연결

# 4. 워커 전용 보안그룹 생성 (인바운드: 관리자 IP의 SSH만, 아웃바운드: 전체 허용)

# 5. 워커 인스턴스 생성 (같은 VPC/서브넷, Project=dockteacher-worker 태그 필수 — IAM 정책의 태그 조건과 매칭)
aws ec2 run-instances \
  --image-id <UBUNTU_22_04_AMI_ID> \
  --instance-type c6i.8xlarge \
  --key-name <기존 dockteacher-web 키페어 이름> \
  --security-group-ids <워커 보안그룹ID> \
  --subnet-id <운영서버와 동일 서브넷ID> \
  --iam-instance-profile Name=dockteacher-worker-role \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":1024,"VolumeType":"gp3","Throughput":700,"Iops":8000}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=dockteacher-worker},{Key=Project,Value=dockteacher-worker}]'

# 6. 운영 서버 보안그룹에 "워커 보안그룹 → 3306(MySQL)" 인바운드 규칙 추가
aws ec2 authorize-security-group-ingress \
  --group-id <운영서버 보안그룹ID> \
  --protocol tcp --port 3306 \
  --source-group <워커 보안그룹ID>

# 7. SQS 큐 생성
aws sqs create-queue --queue-name dockteacher-video-jobs --region ap-northeast-2 \
  --tags Project=dockteacher-worker
```

이후 단계(MySQL 스키마 적용, 애플리케이션 코드 배포, systemd 서비스 등록)는 각각 `worker/README.md`, `lib/`, `server.js`의 관련 코드를 참고.

## 3. 왜 이렇게 나눴는가 (요약)
- 프로비저닝용 IAM 사용자는 **작업 후 폐기 가능한 임시 권한**으로 최소화
- 워커/운영 서버 각각의 **런타임 역할**은 필요한 액션만 최소 권한으로 분리 (worker는 SQS 소비 + 자기 자신 stop만, 운영 서버는 SQS 발행 + 워커 start만)
- `Project=dockteacher-worker` 태그를 기준으로 조건을 걸어, 인스턴스 ID가 생성되기 전에도 정책을 미리 작성할 수 있도록 함
