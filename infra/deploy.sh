#!/usr/bin/env bash
# origin/main을 실서버에 반영한다. GitHub 웹훅(deploy-hook.js)이 호출하고, 수동 실행도 가능하다.
# 서버 작업 트리는 origin/main과 1:1로 유지한다 — 서버에서 파일을 직접 고치면 다음 배포 때 되돌아간다.
set -euo pipefail

REPO=/home/ubuntu/test-host
LOCK=/tmp/dockteacher-deploy.lock

# 동시 실행 방지 (연속 푸시로 웹훅이 겹쳐 들어오는 경우)
exec 9>"$LOCK"
flock -n 9 || { echo "$(date -Is) 다른 배포가 진행 중 — 건너뜀"; exit 0; }

cd "$REPO"
BEFORE=$(git rev-parse HEAD)

git fetch --prune --quiet origin
git reset --hard --quiet origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "$(date -Is) 변경 없음 (${AFTER:0:7}) — 재시작 생략"
  exit 0
fi

# 의존성은 package.json/package-lock.json이 바뀐 배포에서만 다시 설치
if ! git diff --quiet "$BEFORE" "$AFTER" -- package.json package-lock.json; then
  echo "$(date -Is) 의존성 변경 감지 — npm ci"
  npm ci --omit=dev
fi

# 스키마 변경이 섞인 배포는 로그로만 알린다 (DB 마이그레이션은 자동 적용하지 않음)
if ! git diff --quiet "$BEFORE" "$AFTER" -- infra/schema.sql; then
  echo "$(date -Is) [주의] infra/schema.sql이 변경되었습니다 — DB 마이그레이션은 수동으로 적용해야 합니다"
fi

pm2 reload dockteacher --update-env
echo "$(date -Is) 배포 완료 ${BEFORE:0:7} -> ${AFTER:0:7} : $(git log -1 --format=%s)"
