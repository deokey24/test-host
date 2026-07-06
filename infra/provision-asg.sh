#!/usr/bin/env bash
# 워커 오토스케일링 인프라 프로비저닝 — DLQ, Launch Template, ASG, 백업 CloudWatch 경보
# 전제: 골든 AMI가 이미 베이크되어 있음 (infra/autoscaling-design.md 1절, README의 AMI 베이크 절차 참고)
# 사용: 아래 변수들을 채운 뒤 실행. 각 단계는 재실행해도 안전하도록 존재 확인 없이 실패 시 계속 진행하지 않음.
set -euo pipefail

REGION=ap-northeast-2
ASG_NAME=dockteacher-worker-asg
LAUNCH_TEMPLATE_NAME=dockteacher-worker
QUEUE_NAME=dockteacher-video-jobs
DLQ_NAME=dockteacher-video-jobs-dlq

# ── 반드시 채워야 하는 값 ─────────────────────────────────────────
AMI_ID="<골든 AMI ID>"
SUBNET_IDS="<운영서버와 동일 VPC의 서브넷 ID (쉼표 구분으로 복수 가능)>"
WORKER_SG_ID="<워커 보안그룹 ID>"
KEY_NAME="<기존 dockteacher-web 키페어 이름>"
MAX_WORKERS=3
# ────────────────────────────────────────────────────────────────

echo "== 1. DLQ 생성 + 본 큐에 redrive policy(maxReceiveCount=3) 연결 =="
DLQ_URL=$(aws sqs create-queue --queue-name "$DLQ_NAME" --region "$REGION" \
  --tags Project=dockteacher-worker --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --region "$REGION" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
QUEUE_URL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" \
  --query QueueUrl --output text)
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

echo "== 2. Launch Template 생성 =="
USER_DATA=$(base64 -w0 infra/worker-user-data.sh)
aws ec2 create-launch-template --region "$REGION" \
  --launch-template-name "$LAUNCH_TEMPLATE_NAME" \
  --launch-template-data "{
    \"ImageId\": \"$AMI_ID\",
    \"InstanceType\": \"c6i.8xlarge\",
    \"KeyName\": \"$KEY_NAME\",
    \"SecurityGroupIds\": [\"$WORKER_SG_ID\"],
    \"IamInstanceProfile\": { \"Name\": \"dockteacher-worker-role\" },
    \"UserData\": \"$USER_DATA\",
    \"BlockDeviceMappings\": [{
      \"DeviceName\": \"/dev/sda1\",
      \"Ebs\": { \"VolumeSize\": 1024, \"VolumeType\": \"gp3\", \"Throughput\": 700, \"Iops\": 8000, \"DeleteOnTermination\": true }
    }],
    \"TagSpecifications\": [{
      \"ResourceType\": \"instance\",
      \"Tags\": [
        { \"Key\": \"Name\", \"Value\": \"dockteacher-worker\" },
        { \"Key\": \"Project\", \"Value\": \"dockteacher-worker\" }
      ]
    }]
  }"

echo "== 3. ASG 생성 (min=0, desired=0, scale-in protection) =="
# scale-in protection: ASG가 임의로 인스턴스를 골라 죽이지 못하게 함.
# 축소는 유휴 워커가 TerminateInstanceInAutoScalingGroup(desired 감소)으로 스스로 수행.
aws autoscaling create-auto-scaling-group --region "$REGION" \
  --auto-scaling-group-name "$ASG_NAME" \
  --launch-template "LaunchTemplateName=$LAUNCH_TEMPLATE_NAME,Version=\$Latest" \
  --min-size 0 --max-size "$MAX_WORKERS" --desired-capacity 0 \
  --vpc-zone-identifier "$SUBNET_IDS" \
  --new-instances-protected-from-scale-in \
  --default-instance-warmup 180 \
  --tags "Key=Project,Value=dockteacher-worker,PropagateAtLaunch=true,ResourceId=$ASG_NAME,ResourceType=auto-scaling-group"

echo "== 4. 백업 스케일아웃 경보 (운영 서버의 SetDesiredCapacity 실패 시 안전망) =="
# 평시엔 운영 서버가 presign/complete 시점에 desired를 먼저 올리므로 이 경보는 발동하지 않는다.
# 큐에 메시지가 5분 이상 보이는데 아무도 안 가져가는 상황에서만 +1.
POLICY_ARN=$(aws autoscaling put-scaling-policy --region "$REGION" \
  --auto-scaling-group-name "$ASG_NAME" \
  --policy-name backlog-backup-scale-out \
  --policy-type StepScaling \
  --adjustment-type ChangeInCapacity \
  --step-adjustments "MetricIntervalLowerBound=0,ScalingAdjustment=1" \
  --query PolicyARN --output text)

aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name dockteacher-video-jobs-backlog \
  --alarm-description "SQS에 영상 작업이 5분 이상 방치되면 워커 +1 (백업 안전망)" \
  --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions "Name=QueueName,Value=$QUEUE_NAME" \
  --statistic Maximum --period 60 --evaluation-periods 5 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "$POLICY_ARN"

echo "완료. 다음을 확인하세요:"
echo "  - IAM: dockteacher-worker-role / dockteacher-production-role 정책이 infra/iam-policy-*.json 최신본으로 갱신됐는지"
echo "  - SSM: /dockteacher/worker/* 파라미터 등록 (infra/README.md 참고)"
echo "  - 운영 서버 .env: WORKER_INSTANCE_ID 제거, (필요 시) WORKER_ASG_NAME/WORKER_ASG_MAX 설정"
