#!/bin/bash
# Launch Template의 user-data — 골든 AMI로 부팅한 워커 인스턴스가 매 부팅 시 실행.
# AMI에는 ffmpeg/Node/워커 코드/systemd 유닛(disabled)만 있고, 시크릿과 최신 코드는 여기서 주입한다.
set -euo pipefail
exec > /var/log/worker-user-data.log 2>&1

REPO_DIR=/home/ubuntu/dockteacher-web
REGION=ap-northeast-2

echo "== 1. 워커 코드 최신화 (AMI 재베이크 없이 git push만으로 반영) =="
sudo -u ubuntu git -C "$REPO_DIR" pull --ff-only
sudo -u ubuntu bash -c "cd '$REPO_DIR/worker' && npm ci --omit=dev"

echo "== 2. SSM Parameter Store에서 시크릿 로드 → worker/.env 생성 =="
# /dockteacher/worker/<KEY> = <VALUE> (SecureString) → .env의 KEY=VALUE 로 변환
ENV_FILE="$REPO_DIR/worker/.env"
: > "$ENV_FILE"
aws ssm get-parameters-by-path \
  --path /dockteacher/worker --with-decryption --region "$REGION" \
  --query "Parameters[].[Name,Value]" --output text |
while IFS=$'\t' read -r name value; do
  echo "${name##*/}=${value}" >> "$ENV_FILE"
done
chown ubuntu:ubuntu "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [ ! -s "$ENV_FILE" ]; then
  echo "오류: SSM에서 파라미터를 하나도 받지 못함 — 워커를 시작하지 않는다" >&2
  exit 1
fi

echo "== 3. 임시 작업 디렉터리 =="
mkdir -p /mnt/worker-tmp
chown ubuntu:ubuntu /mnt/worker-tmp

echo "== 4. 워커 시작 (.env 준비 후에만 — AMI에서 유닛은 disabled 상태) =="
systemctl start dockteacher-worker

echo "완료"
