# DockPlayer(데스크톱 플레이어) 배포·바로가기 오류 대응 가이드

최종 갱신: 2026-10-14 (0.1.3 배포)

DockPlayer는 별도 프로젝트 `C:\workspace\dock-player`(Electron + electron-vite + electron-builder, git 저장소 아님)에서 빌드하고,
설치 파일은 Cloudflare R2 → `https://cdn.dockteacher.co.kr/dock-player/`로 배포한다. 사이트와의 접점은 두 곳뿐이다.

| 접점 | 위치 |
|---|---|
| 마이페이지 "DockPlayer 설치" 버튼 | `public-figma/mypage.html` (`DockPlayer%20Setup%20<버전>.exe` 링크) |
| 앱 자동 업데이트 | 앱이 실행될 때 CDN의 `latest.yml`을 읽음 (electron-updater generic provider) |

---

## 1. 버전 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| 0.1.1 | 2026-08-01 | 초기 배포 |
| 0.1.2 | 2026-08-01 | 수강현황(진도) 전송 포함 |
| 0.1.3 | 2026-10-14 | 시작 메뉴 바로가기 자동 복구(설치기+앱), 업데이트 즉시 재시작 → "지금 재시작/나중에" 선택 |

---

## 2. 릴리스 절차 (새 버전 배포)

1. `dock-player/package.json`의 `version`을 올린다. 앱 화면 버전 표시와 `latest.yml`이 여기서 나온다.
2. `dock-player`에서 빌드한다.
   ```bash
   npm run typecheck
   npm run build:win      # dist/DockPlayer Setup <ver>.exe, .blockmap, latest.yml 생성 (수 분 소요)
   ```
3. R2 버킷 `dockteacher`의 `dock-player/` 프리픽스에 **반드시 이 순서로** 올린다.
   1. `DockPlayer Setup <ver>.exe` (`application/octet-stream`)
   2. `DockPlayer Setup <ver>.exe.blockmap` (`application/octet-stream`)
   3. `latest.yml` (`text/yaml`) — **마지막**. 이 파일이 바뀌는 순간 기존 사용자에게 업데이트가 내려가므로 exe가 먼저 있어야 한다.
   - 업로드는 `lib/r2.js`와 같은 `@aws-sdk/client-s3` `PutObject`로 150MB 단일 요청도 문제없다. 자격증명은 `.env`의 `R2_*`.
   - 이전 버전 파일은 지우지 않는다(차등 업데이트용 blockmap 참조, 롤백용).
4. 확인
   ```bash
   curl -sI "https://cdn.dockteacher.co.kr/dock-player/DockPlayer%20Setup%20<ver>.exe"   # 200 + Content-Length가 로컬 크기와 동일
   curl -s  "https://cdn.dockteacher.co.kr/dock-player/latest.yml"                        # version: <ver>
   ```
   CDN은 `cf-cache-status: DYNAMIC`(캐시 안 함)이라 바로 반영된다.
5. `public-figma/mypage.html`의 설치 링크 버전을 바꾸고 커밋 → 배포(아래 "사이트 배포 주의" 참고).
6. 롤백: `latest.yml`만 이전 버전 내용으로 되돌리면 된다(이전 exe가 남아 있으므로). 이미 새 버전을 받은 사용자는 자동으로 내려가지 않으니 수동 재설치 안내 필요.

### 사이트 배포 주의 (2026-10-14 기준)
- GitHub 웹훅이 아직 등록되지 않아 **`main` 푸시만으로는 실서버에 반영되지 않는다** (`infra/auto-deploy.md`의 등록 절차 참고).
- 수동 배포는 두 방법 중 하나.
  - 서버에서 `/home/ubuntu/deploy.sh` 실행 (`git reset --hard origin/main` + `pm2 reload`).
  - tar+scp: `git archive --format=tar.gz -o deploy.tar.gz <커밋> $(git diff --name-only <서버HEAD>..<커밋>)` → scp → 서버에서 `/home/ubuntu/test-host`에 해제 → `pm2 reload dockteacher --update-env`. 의존성(`package.json`) 변경이 있으면 `npm ci --omit=dev` 먼저.
- 2026-10-14 배포는 tar+scp로 했고, 그 결과 서버 git HEAD는 `2da05e9`, 작업 트리는 `794acf3`과 동일한 상태다. 다음에 `deploy.sh`를 돌려도 파일이 같으므로 잃는 것은 없다.

---

## 3. "DockPlayer.lnk을(를) 찾을 수 없습니다" 오류

### 증상
```
C:\Users\<이름>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\DockPlayer.lnk을(를) 찾을 수 없습니다.
```
시작 메뉴 검색 결과, 시작 화면 고정 타일, 작업 표시줄 고정 아이콘을 눌렀을 때 뜬다. 앱 오류가 아니라 바로가기 파일이 없는 것.

### 원인 (0.1.2 이하)
1. **업데이트가 바로가기를 복구하지 않음.** electron-builder NSIS 설치기는 업데이트 때 "바로가기 유지(KeepShortcuts)" 모드로 돌아 기존 .lnk를 새로 만들지 않는다. 어떤 이유로든 한 번 .lnk가 지워진 PC는 업데이트를 거듭해도 복구되지 않았다.
2. **실행 직후 즉시 재시작 설치.** 앱이 켜지자마자 업데이트를 받으면 바로 `quitAndInstall()`을 호출했다. 앱 종료 지연이나 백신 차단으로 설치가 중간에 끊기면 바로가기만 사라진 채 끝날 수 있었다.
3. **설치 파일을 "관리자 권한으로 실행"한 경우.** 사용자별 설치라 관리자 계정 폴더(`C:\Users\<관리자>\...`)에 설치되고, 로그인 계정의 시작 메뉴에는 아무것도 생기지 않는다. 재설치해도 같은 방식이면 재발한다.
4. **백신·회사 보안 정책이 서명 없는 설치기의 .lnk 생성을 차단.** 코드로 완전히 막을 수 없다.

### 0.1.3에서의 조치
- `dock-player/resources/installer.nsh`의 `customInstall` 매크로: 설치가 끝날 때 시작 메뉴 .lnk가 없으면 항상 다시 만든다(바탕화면 바로가기는 사용자가 지웠을 수 있어 손대지 않음). `electron-builder.yml`의 `nsis.include`로 연결.
- `dock-player/src/main/startMenuShortcut.ts`: 앱이 실행될 때마다 .lnk가 없으면 `shell.writeShortcutLink`로 직접 만든다. 설치기만 차단하는 백신에 대한 2중 안전장치.
- `dock-player/src/main/autoUpdate.ts`: 업데이트가 받아지면 "지금 재시작 / 나중에"(기본 나중에)를 묻고, 나중에면 앱 종료 시 설치(`autoInstallOnAppQuit`).
- 검증: 개발 PC에서 .lnk 삭제 → 0.1.3 무음 설치(`/S`) → 재생성 확인, 다시 삭제 → 앱 실행만으로 약 1초 내 재생성 확인.
- 설계 메모: `dock-player/SHORTCUT-FIX-PLAN.md`.

### 사용자 안내 문구 (오류 문의 시)
1. 마이페이지에서 "DockPlayer 설치" 파일을 받아 **그냥 더블클릭**으로 설치해 주세요. 기존 앱을 지우지 않아도 됩니다(설치기가 이전 버전을 자동 교체, 로그인·진도 유지). 설치 전에 실행 중인 DockPlayer는 종료해 주세요.
2. **"관리자 권한으로 실행"은 하지 마세요.**
3. 설치 후에도 같은 오류가 나면 시작 화면·작업 표시줄에 고정한 아이콘을 지우고 다시 고정해 주세요.
4. 그래도 안 되면 다음 경로를 직접 실행하세요: `%LOCALAPPDATA%\Programs\dock-player\DockPlayer.exe` (바탕화면 바로가기를 만들어 두면 편합니다).

### 현장 진단 (PowerShell)
```powershell
"로그인 계정: $env:USERNAME / 프로필: $env:USERPROFILE"
"시작메뉴 lnk: " + (Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DockPlayer.lnk")
"설치 exe:    " + (Test-Path "$env:LOCALAPPDATA\Programs\dock-player\DockPlayer.exe")
Get-ChildItem C:\Users\*\AppData\Local\Programs\dock-player\DockPlayer.exe -ErrorAction SilentlyContinue | Select FullName
```
- 다른 계정 폴더에 exe가 있으면 원인 3 → 그 계정에서 삭제 후 로그인 계정에서 일반 설치.
- exe와 lnk 모두 있으면 고정 아이콘 문제 → 고정 해제 후 재고정.
- exe만 있고 lnk가 없으면 백신 차단 → 앱 한 번 실행(자가 복구) 또는 exe 직접 실행.

### 남은 한계
- 코드 서명 인증서가 없어 백신·EDR이 설치기를 차단하는 PC는 완전히 막을 수 없다. 인증서 확보 시 `electron-builder.yml`에 `win.certificateFile` 또는 `CSC_LINK`/`CSC_KEY_PASSWORD` 설정.
