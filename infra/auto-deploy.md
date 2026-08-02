# main 푸시 자동 배포 (GitHub 웹훅)

`main`에 푸시하면 GitHub이 실서버로 웹훅을 쏘고, 서버가 `origin/main`을 그대로 체크아웃한 뒤 앱을 리로드한다.
**푸시 = 실서비스 반영**이므로 main에 직접 푸시할 때는 항상 이 점을 염두에 둘 것.

```
git push origin main
      ↓  (GitHub webhook, push 이벤트)
https://dockteacher.co.kr/_deploy
      ↓  (nginx → 127.0.0.1:3999)
deploy-hook.js   X-Hub-Signature-256(HMAC) 검증 → main 브랜치만 통과
      ↓  (detached 실행)
deploy.sh        git reset --hard origin/main → (필요 시 npm ci) → pm2 reload dockteacher
```

## 서버 구성 요소

| 위치 | 역할 |
|---|---|
| `/home/ubuntu/deploy.sh` | 실제 배포 스크립트 (이 저장소의 `infra/deploy.sh` 사본) |
| `/home/ubuntu/deploy-hook.js` | 웹훅 수신기, PM2 앱 이름 `deploy-hook` (사본: `infra/deploy-hook.js`) |
| `/home/ubuntu/.deploy-hook.env` | `DEPLOY_SECRET=...` (chmod 600, 커밋 금지) |
| `/etc/nginx/sites-enabled/test-host` | `location = /_deploy` 블록 (사본: `infra/nginx-deploy-location.conf`) |
| `/etc/nginx/config-backups/` | nginx 설정 백업 (sites-enabled 안에 두면 nginx가 같이 로드해서 죽는다) |

**두 스크립트의 실체는 저장소가 아니라 `/home/ubuntu/`에 둔다.** `deploy.sh`가 저장소 안에 있으면
`git reset --hard`가 실행 중인 스크립트 파일을 바꿔버려 bash가 엉뚱한 지점을 읽는다. `infra/`의 파일은 형상관리용 사본이며,
고친 뒤에는 서버로 직접 복사해야 반영된다.

**`deploy-hook`은 본 앱과 반드시 별도 PM2 프로세스여야 한다.** 배포가 `pm2 reload dockteacher`를 하므로
같은 프로세스면 자기 자신을 죽여 배포가 중간에 끊긴다.

## 동작 규칙

- `main` 외 브랜치 푸시는 204로 무시한다.
- 서명이 틀리면 401. GitHub 웹훅 설정의 Secret과 `.deploy-hook.env` 값이 일치해야 한다.
- 이미 최신이면(HEAD 변화 없음) 리로드를 생략한다 — 불필요한 순단 방지.
- `package.json`/`package-lock.json`이 바뀐 배포에서만 `npm ci --omit=dev`를 돌린다.
- `flock`으로 동시 실행을 막는다(연속 푸시 시 뒤 요청은 건너뜀 — 어차피 최신을 받아간다).

## 자동화하지 않는 것

- **DB 마이그레이션.** `infra/schema.sql`이 바뀐 배포는 로그에 경고만 남기고 넘어간다. 스키마 변경은 수동으로 적용할 것.
- **무중단 배포.** PM2가 fork 모드(단일 프로세스)라 `reload`도 사실상 재시작이고 1초 내외 502가 난다.
  cluster 모드로 바꾸려면 `express-session`의 인메모리 MemoryStore부터 DB/Redis로 옮겨야 한다(프로세스마다 세션이 따로 놀게 됨).

## 운영

```bash
# 배포 로그
pm2 logs deploy-hook --lines 50

# 수동 배포 (웹훅 없이)
/home/ubuntu/deploy.sh

# 롤백
cd /home/ubuntu/test-host && git reset --hard <이전 커밋> && pm2 reload dockteacher
```

서버 작업 트리는 `origin/main`과 1:1로 유지된다 — **서버에서 파일을 직접 고치면 다음 배포 때 되돌아간다.**

## GitHub 웹훅 설정값

저장소 → Settings → Webhooks → Add webhook

- Payload URL: `https://dockteacher.co.kr/_deploy`
- Content type: `application/json`
- Secret: `/home/ubuntu/.deploy-hook.env`의 `DEPLOY_SECRET` 값
- Events: Just the push event
