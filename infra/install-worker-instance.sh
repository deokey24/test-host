#!/usr/bin/env bash
# 골든 AMI 베이크용 셋업 스크립트 — 베이스 인스턴스(Ubuntu 22.04)에 1회 실행한 뒤 AMI로 굽는다.
# 실행: ssh -i dockteacher-web.pem ubuntu@<베이스 인스턴스 IP> 'bash -s' < infra/install-worker-instance.sh
#
# AMI에 포함되는 것: ffmpeg, Node, 워커 코드+의존성, systemd 유닛(disabled)
# AMI에 포함되면 안 되는 것: worker/.env (시크릿은 부팅 시 user-data가 SSM에서 로드)

set -euo pipefail

REPO_URL="https://github.com/deokey24/test-host.git"
REPO_DIR="/home/ubuntu/dockteacher-web"

echo "== ffmpeg 설치 =="
sudo apt-get update
sudo apt-get install -y ffmpeg

echo "== Node.js 20 설치 =="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== 임시 작업 디렉터리 준비 (EBS 볼륨) =="
sudo mkdir -p /mnt/worker-tmp
sudo chown ubuntu:ubuntu /mnt/worker-tmp

echo "== 저장소 클론 =="
if [ ! -d "$REPO_DIR" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
fi

echo "== 워커 의존성 설치 =="
cd "$REPO_DIR/worker"
npm ci --omit=dev

echo "== systemd 서비스 등록 (enable하지 않음 — 부팅 시 user-data가 .env 생성 후 start) =="
sudo cp "$REPO_DIR/infra/dockteacher-worker.service" /etc/systemd/system/dockteacher-worker.service
sudo systemctl daemon-reload

echo "== AMI 베이크 전 정리 (시크릿/호스트 고유 파일 제거) =="
rm -f "$REPO_DIR/worker/.env"
sudo cloud-init clean --logs || true   # 다음 부팅에서 user-data가 다시 실행되도록

echo "완료. 이 인스턴스를 정지한 뒤 AMI로 생성하세요:"
echo "  aws ec2 stop-instances --instance-ids <이 인스턴스 ID>"
echo "  aws ec2 create-image --instance-id <이 인스턴스 ID> --name dockteacher-worker-\$(date +%Y%m%d)"
echo "이후 infra/provision-asg.sh의 AMI_ID에 새 AMI를 넣고 실행."
