#!/usr/bin/env bash
# 워커 EC2 인스턴스에 SSH로 접속한 뒤 최초 1회 실행하는 부트스트랩 스크립트
# 실행: ssh -i dockteacher-web.pem ubuntu@<워커 인스턴스 IP> 'bash -s' < infra/install-worker-instance.sh

set -euo pipefail

REPO_URL="<이 저장소의 git remote URL로 교체>"
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
npm install --omit=dev

echo "== .env 파일을 아직 만들지 않았다면 worker/.env.example을 참고해 worker/.env를 직접 작성하세요 =="

echo "== systemd 서비스 등록 =="
sudo cp "$REPO_DIR/infra/dockteacher-worker.service" /etc/systemd/system/dockteacher-worker.service
sudo systemctl daemon-reload
sudo systemctl enable dockteacher-worker

echo "완료. worker/.env 작성 후 다음 명령으로 서비스를 시작하세요:"
echo "  sudo systemctl start dockteacher-worker"
echo "  sudo systemctl status dockteacher-worker"
echo "  journalctl -u dockteacher-worker -f"
