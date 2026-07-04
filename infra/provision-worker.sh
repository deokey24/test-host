#!/usr/bin/env bash
# 영상 트랜스코딩 워커 EC2 인스턴스 프로비저닝 스크립트
#
# 사전 조건:
#   - AWS CLI가 dockteacher-provisioner IAM 사용자 자격증명으로 구성되어 있을 것
#     (aws configure, 또는 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY 환경변수)
#   - infra/iam-policy-worker-role.json, infra/iam-policy-production-role.json 존재
#   - 아래 변수(ADMIN_SSH_CIDR 등)를 환경에 맞게 수정
#
# 실행: bash infra/provision-worker.sh

set -euo pipefail

REGION="ap-northeast-2"
PROD_SERVER_IP="54.116.171.96"
KEY_PAIR_NAME="dockteacher-web"          # 기존 dockteacher-web.pem에 대응하는 AWS 키페어 이름으로 수정
ADMIN_SSH_CIDR="0.0.0.0/32"              # 관리자가 SSH로 접속할 고정 IP/32 로 반드시 교체할 것
INSTANCE_TYPE="c6i.8xlarge"
VOLUME_SIZE_GB=1024
VOLUME_THROUGHPUT=700
VOLUME_IOPS=8000
WORKER_TAG_VALUE="dockteacher-worker"
WORKER_ROLE_NAME="dockteacher-worker-role"
PROD_ROLE_NAME="dockteacher-production-role"
SQS_QUEUE_NAME="dockteacher-video-jobs"

echo "== 0. 자격증명 확인 =="
aws sts get-caller-identity --output table

echo "== 1. 운영 서버(${PROD_SERVER_IP}) 네트워크 정보 조회 =="
PROD_INSTANCE_JSON=$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=ip-address,Values=${PROD_SERVER_IP}" \
  --query "Reservations[0].Instances[0]")
PROD_INSTANCE_ID=$(echo "$PROD_INSTANCE_JSON" | jq -r '.InstanceId')
VPC_ID=$(echo "$PROD_INSTANCE_JSON" | jq -r '.VpcId')
SUBNET_ID=$(echo "$PROD_INSTANCE_JSON" | jq -r '.SubnetId')
PROD_SG_ID=$(echo "$PROD_INSTANCE_JSON" | jq -r '.SecurityGroups[0].GroupId')
echo "운영 서버 인스턴스: $PROD_INSTANCE_ID / VPC: $VPC_ID / Subnet: $SUBNET_ID / SG: $PROD_SG_ID"

echo "== 2. 워커 전용 보안그룹 생성 =="
WORKER_SG_ID=$(aws ec2 create-security-group \
  --region "$REGION" \
  --group-name "dockteacher-worker-sg" \
  --description "Worker instance for video transcoding" \
  --vpc-id "$VPC_ID" \
  --query "GroupId" --output text)
aws ec2 authorize-security-group-ingress \
  --region "$REGION" --group-id "$WORKER_SG_ID" \
  --protocol tcp --port 22 --cidr "$ADMIN_SSH_CIDR"
echo "워커 보안그룹: $WORKER_SG_ID"

echo "== 3. 운영 서버 보안그룹에 워커 → 3306(MySQL) 인바운드 허용 =="
aws ec2 authorize-security-group-ingress \
  --region "$REGION" --group-id "$PROD_SG_ID" \
  --protocol tcp --port 3306 --source-group "$WORKER_SG_ID"

echo "== 4. 워커 인스턴스용 IAM 역할/인스턴스 프로필 생성 =="
cat > /tmp/ec2-trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ec2.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF
aws iam create-role --role-name "$WORKER_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/ec2-trust-policy.json
aws iam put-role-policy --role-name "$WORKER_ROLE_NAME" \
  --policy-name "dockteacher-worker-inline" \
  --policy-document file://infra/iam-policy-worker-role.json
aws iam create-instance-profile --instance-profile-name "$WORKER_ROLE_NAME"
aws iam add-role-to-instance-profile \
  --instance-profile-name "$WORKER_ROLE_NAME" --role-name "$WORKER_ROLE_NAME"

echo "== 5. 운영 서버용 IAM 역할 생성 (신규인 경우) — 기존 운영 서버 인스턴스에는 별도로 associate-iam-instance-profile 필요 =="
aws iam create-role --role-name "$PROD_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/ec2-trust-policy.json || true
aws iam put-role-policy --role-name "$PROD_ROLE_NAME" \
  --policy-name "dockteacher-production-inline" \
  --policy-document file://infra/iam-policy-production-role.json
aws iam create-instance-profile --instance-profile-name "$PROD_ROLE_NAME" || true
aws iam add-role-to-instance-profile \
  --instance-profile-name "$PROD_ROLE_NAME" --role-name "$PROD_ROLE_NAME" || true
echo "-> 운영 서버에 아직 인스턴스 프로필이 없다면 수동으로 연결:"
echo "   aws ec2 associate-iam-instance-profile --instance-id $PROD_INSTANCE_ID --iam-instance-profile Name=$PROD_ROLE_NAME"

echo "== 6. 최신 Ubuntu 22.04 AMI 조회 =="
AMI_ID=$(aws ssm get-parameters \
  --region "$REGION" \
  --names /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id \
  --query "Parameters[0].Value" --output text)
echo "AMI: $AMI_ID"

echo "== 7. IAM 인스턴스 프로필 전파 대기 (10초) =="
sleep 10

echo "== 8. 워커 EC2 인스턴스 생성 =="
aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_PAIR_NAME" \
  --security-group-ids "$WORKER_SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --iam-instance-profile "Name=$WORKER_ROLE_NAME" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE_GB,\"VolumeType\":\"gp3\",\"Throughput\":$VOLUME_THROUGHPUT,\"Iops\":$VOLUME_IOPS}}]" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=dockteacher-worker},{Key=Project,Value=$WORKER_TAG_VALUE}]"

echo "== 9. SQS 큐 생성 =="
aws sqs create-queue --region "$REGION" --queue-name "$SQS_QUEUE_NAME" \
  --tags Project="$WORKER_TAG_VALUE"

echo "완료. 워커 인스턴스가 running 상태가 되면 SSH로 접속해 worker/README.md 절차를 진행하세요."
