// GitHub push 웹훅 수신기 — 127.0.0.1:3999 에서만 듣고, nginx가 https://.../_deploy 로 프록시한다.
// 본 앱(dockteacher)과 반드시 별도 프로세스여야 한다: deploy.sh가 pm2 reload dockteacher를 하므로
// 같은 프로세스면 자기 자신을 죽여 배포가 중간에 끊긴다.
//
// 인증은 GitHub이 보내는 X-Hub-Signature-256(공유 시크릿 HMAC) 검증뿐이다.
// 시크릿은 /home/ubuntu/.deploy-hook.env 에 두고 node --env-file 로 주입한다(chmod 600).
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SECRET = process.env.DEPLOY_SECRET;
const PORT = Number(process.env.DEPLOY_HOOK_PORT || 3999);
const BRANCH = 'refs/heads/main';
const SCRIPT = '/home/ubuntu/deploy.sh';

if (!SECRET) {
  console.error('DEPLOY_SECRET이 없습니다 (/home/ubuntu/.deploy-hook.env 확인)');
  process.exit(1);
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 2_000_000) { res.writeHead(413).end(); req.destroy(); return; }
    chunks.push(c);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    if (!timingSafeEqualStr(req.headers['x-hub-signature-256'] || '', expected)) {
      console.log(`${new Date().toISOString()} 서명 불일치 — 거부`);
      res.writeHead(401).end('bad signature');
      return;
    }

    const event = req.headers['x-github-event'];
    if (event === 'ping') { res.writeHead(200).end('pong'); return; }
    if (event !== 'push') { res.writeHead(204).end(); return; }

    let payload = {};
    try { payload = JSON.parse(body.toString('utf8')); } catch { /* 무시 */ }
    if (payload.ref !== BRANCH) {
      console.log(`${new Date().toISOString()} ${payload.ref} — main이 아니라 건너뜀`);
      res.writeHead(204).end();
      return;
    }

    // 배포는 오래 걸릴 수 있고 우리 프로세스를 죽이지도 않으므로, 응답부터 돌려주고 백그라운드로 실행한다.
    res.writeHead(202).end('deploying');
    console.log(`${new Date().toISOString()} 배포 시작 — ${payload.after?.slice(0, 7)} by ${payload.pusher?.name}`);
    execFile('/bin/bash', [SCRIPT], { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) console.error(`${new Date().toISOString()} 배포 실패:`, err.message);
    });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`deploy-hook listening on 127.0.0.1:${PORT}`);
});
