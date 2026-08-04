const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { getPool } = require('./lib/db');
const r2 = require('./lib/r2');
const { sendVideoJob } = require('./lib/sqs');
const { ensureWorkerCapacity } = require('./lib/asg');
const { sendEmail } = require('./lib/ses');
const payup = require('./lib/payup');

const app = express();
app.set('trust proxy', 1); // nginx가 X-Forwarded-For를 넘겨줌 — req.ip가 실제 클라이언트 IP를 보게 함
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dockAdmin';
const PART_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_DEVICES_PER_MEMBER = 3;
const KEEP_LOGGED_IN_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30일
const CDN_BASE_URL = process.env.CDN_BASE_URL || 'https://cdn.dockteacher.co.kr';

function buildCdnUrl(r2Key) {
  return CDN_BASE_URL + '/' + r2Key.split('/').map(encodeURIComponent).join('/');
}

const STREAM_URL_TTL_SECONDS = Number(process.env.STREAM_URL_TTL_SECONDS || 21600); // 6시간
// AES-128 키 URL 자체 서명용 — 세그먼트 프리사인 URL과 달리 이건 R2 서명이 아니라
// 우리가 직접 발급하는 exp+sig 쿼리라 별도 시크릿이 필요하다 (네이티브 HLS 플레이어가
// 커스텀 인증 헤더 없이도 키를 받아갈 수 있어야 하므로).
const STREAM_SIGNING_SECRET = process.env.STREAM_SIGNING_SECRET || 'dockteacher-stream-signing';

function isHlsKey(key) {
  return !!key && key.endsWith('.m3u8');
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// master.m3u8의 세그먼트 줄(상대경로)은 쿼리스트링을 상속받지 못하므로,
// 요청마다 각 세그먼트를 새로 프리사인한 절대 URL로 치환해 내려준다.
// AES-128 암호화된 영상은 #EXT-X-KEY의 URI(워커가 심어둔 placeholder "key.bin")도
// 이 요청의 인증된 키 배포 엔드포인트(keyUrl)로 치환한다 — 키 파일 자체는 R2에 없다.
async function renderSignedManifest(manifestKey, keyUrl, ttlSeconds = STREAM_URL_TTL_SECONDS) {
  const prefix = manifestKey.slice(0, manifestKey.lastIndexOf('/') + 1);
  const obj = await r2.getObject(manifestKey);
  const text = await streamToString(obj.Body);
  const signedLines = await Promise.all(text.split('\n').map(async (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-KEY')) {
      return keyUrl ? line.replace(/URI="[^"]*"/, `URI="${keyUrl}"`) : line;
    }
    if (!trimmed || trimmed.startsWith('#')) return line;
    return r2.presignGetObject(prefix + trimmed, ttlSeconds);
  }));
  return signedLines.join('\n');
}

// AES-128 키 URL 자체 서명 — 세그먼트처럼 URL 자체가 자기완결적 capability token이
// 되도록 만든다. 매니페스트 발급 시(enrollment 확인이 끝난 시점) 서명해서 심어두면,
// 네이티브 HLS 플레이어 엔진이 인증 헤더 없이 이 URL만으로 키를 받아갈 수 있다.
function signKeyUrl(basePath, ttlSeconds = STREAM_URL_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', STREAM_SIGNING_SECRET).update(`${basePath}.${exp}`).digest('hex');
  return `${basePath}?exp=${exp}&sig=${sig}`;
}

function verifySignedKeyUrl(basePath, exp, sig) {
  if (!exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', STREAM_SIGNING_SECRET).update(`${basePath}.${expNum}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(String(sig), 'hex');
  if (expectedBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, sigBuf);
}

function sendHlsKey(res, hlsKeyBase64) {
  if (!hlsKeyBase64) {
    res.status(404).json({ error: '키를 찾을 수 없습니다.' });
    return;
  }
  res.set('Content-Type', 'application/octet-stream');
  res.set('Cache-Control', 'no-store');
  res.send(Buffer.from(hlsKeyBase64, 'base64'));
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'dockteacher-admin-session',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 네이티브 앱(일렉트론/RN) renderer/WebView가 hls.js로 매니페스트를 직접 fetch하면
// dockteacher.co.kr과 다른 origin(file://, localhost dev 서버 등)에서 요청하게 되어
// 브라우저가 CORS를 강제한다 — Authorization 헤더를 실으면 preflight(OPTIONS)까지 발생.
// 이 두 네임스페이스는 쿠키가 아니라 Bearer 토큰/자체 서명 URL로 인증하므로
// Allow-Credentials 없이 Allow-Origin: * 를 열어도 세션 쿠키 노출 위험이 없다.
app.use(['/api/v1', '/api/stream'], (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin');
}

function requireAdminApi(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function requireMember(req, res, next) {
  if (req.session.memberId) return next();
  res.status(401).json({ error: '로그인이 필요합니다.' });
}

// 일렉트론/RN 등 네이티브 앱 전용 — 웹의 express-session(인메모리)과 완전히 분리된
// DB 기반 Bearer 토큰 인증. api_tokens에는 원본 토큰이 아니라 SHA-256 해시만 저장한다.
function hashApiToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

async function requireApiToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!rawToken) {
    res.status(401).json({ error: '로그인이 필요합니다.' });
    return;
  }
  try {
    const [[row]] = await getPool().query(
      'SELECT id, member_id FROM api_tokens WHERE token_hash = ?',
      [hashApiToken(rawToken)]
    );
    if (!row) {
      res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
      return;
    }
    req.memberId = row.member_id;
    req.apiTokenId = row.id;
    // 진도 하트비트처럼 수십 초마다 호출되는 라우트가 생겨서, 매 요청 쓰기를 하지 않도록 5분에 한 번만 갱신한다.
    getPool().query(
      'UPDATE api_tokens SET last_used_at = NOW() WHERE id = ? AND last_used_at < NOW() - INTERVAL 5 MINUTE',
      [row.id]
    ).catch(() => {});
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

// 웹 세션 쿠키와 네이티브 앱 Bearer 토큰을 모두 받아 req.memberId로 통일 —
// 매니페스트 라우트처럼 두 종류 클라이언트가 같이 호출하는 경로에 사용한다.
async function requireMemberOrApiToken(req, res, next) {
  if (req.session.memberId) {
    req.memberId = req.session.memberId;
    next();
    return;
  }
  await requireApiToken(req, res, next);
}

app.get('/admin', (req, res) => {
  if (req.session.isAdmin) {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
    return;
  }
  const loginPage = fs.readFileSync(path.join(__dirname, 'admin', 'login.html'), 'utf8');
  const errorHtml = req.query.error ? '<p class="error">비밀번호가 올바르지 않습니다.</p>' : '';
  res.send(loginPage.replace('{{ERROR}}', errorHtml));
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin?error=1');
  }
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// 기존(브라운/골드 테마) 관리자 화면 — 새 셸의 "v1" 탭이 iframe으로 띄운다. 로그인은 상위 /admin에서만 처리.
app.get('/admin/v1', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'v1.html'));
});

// 관리자 셸의 정적 자산(cms.css/cms.js/banners.js 등). 위의 명시적 /admin, /admin/v1, /admin/api/* 라우트가
// 먼저 매칭되므로 이 미들웨어는 그 외의 admin/ 하위 파일 요청만 처리한다.
app.use('/admin', express.static(path.join(__dirname, 'admin')));

app.get('/admin/api/videos', requireAdminApi, wrapAsync(async (req, res) => {
  const { folderId, all } = req.query;
  // all=1: 폴더 무관하게 전체 조회 (VOD 강좌 편집기의 "강의 영상 선택"처럼 폴더 트리와 무관하게
  // 검색으로 골라야 하는 화면용). 그 외에는 폴더 브라우저(admin/video.js)용 폴더 스코프 필터.
  let where = 'WHERE folder_id IS NULL';
  let params = [];
  if (all) {
    where = '';
  } else if (folderId) {
    where = 'WHERE folder_id = ?';
    params = [folderId];
  }
  const [rows] = await getPool().query(
    `SELECT id, title, status, final_r2_key, error_message, created_at, folder_id FROM lecture_videos ${where} ORDER BY created_at DESC`,
    params
  );
  res.json(rows.map(v => ({
    ...v,
    final_url: !v.final_r2_key ? null
      : isHlsKey(v.final_r2_key) ? `/admin/api/videos/${v.id}/stream/master.m3u8`
      : buildCdnUrl(v.final_r2_key)
  })));
}));

app.post('/admin/api/videos/presign', requireAdminApi, wrapAsync(async (req, res) => {
  const { title, fileSize, folderId } = req.body;
  if (!title || !fileSize) {
    res.status(400).json({ error: 'title과 fileSize가 필요합니다.' });
    return;
  }
  if (folderId) {
    const [[{ cnt }]] = await getPool().query('SELECT COUNT(*) AS cnt FROM video_folders WHERE id = ?', [folderId]);
    if (cnt === 0) {
      res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
      return;
    }
  }

  const key = `raw/${crypto.randomUUID()}-${title.replace(/[^\w.\-가-힣 ]/g, '')}`;
  const uploadId = await r2.createMultipartUpload(key);

  const [result] = await getPool().query(
    'INSERT INTO lecture_videos (title, raw_r2_key, raw_upload_id, status, folder_id) VALUES (?, ?, ?, ?, ?)',
    [title, key, uploadId, 'uploading', folderId || null]
  );
  const videoId = result.insertId;

  const partCount = Math.ceil(fileSize / PART_SIZE);
  const urls = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    urls.push({
      partNumber,
      url: await r2.presignUploadPart(key, uploadId, partNumber)
    });
  }

  // 워커 선기동: 20~30GB 업로드가 수십 분 걸리므로 지금 띄우면 부팅(~2분)이 업로드 시간에 숨는다.
  // 실패해도 업로드는 진행 가능 — complete 시점 재시도 + CloudWatch 백업 경보가 커버.
  ensureWorkerCapacity(1).catch((err) => console.error('워커 선기동 실패:', err));

  res.json({ videoId, partSize: PART_SIZE, urls });
}));

app.post('/admin/api/videos/:id/complete', requireAdminApi, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const { parts } = req.body;

  const [rows] = await getPool().query('SELECT * FROM lecture_videos WHERE id = ?', [id]);
  const video = rows[0];
  if (!video) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }

  await r2.completeMultipartUpload(video.raw_r2_key, video.raw_upload_id, parts);
  await getPool().query('UPDATE lecture_videos SET status = ? WHERE id = ?', ['queued', id]);

  // 큐 깊이 기준 desired 재계산(다중 동시 업로드 대응). 실패해도 발행은 진행 —
  // 큐에 쌓인 메시지는 CloudWatch 백업 경보(step scaling)가 처리한다.
  await ensureWorkerCapacity(1).catch((err) => console.error('워커 스케일아웃 실패:', err));

  try {
    await sendVideoJob({ videoId: video.id, rawKey: video.raw_r2_key, title: video.title });
  } catch (err) {
    // SQS 발행 실패를 여기서 못 잡으면 DB는 이미 queued인데 워커에 갈 메시지가 없어
    // 영원히 대기 상태로 남는다 — failed로 남겨 관리자 화면에서 바로 보이게 한다
    console.error('SQS 작업 발행 실패:', err);
    await getPool().query(
      'UPDATE lecture_videos SET status = ?, error_message = ? WHERE id = ?',
      ['failed', String(err.message || err).slice(0, 2000), id]
    );
    res.status(500).json({ error: '압축 대기열 등록에 실패했습니다.' });
    return;
  }

  res.json({ ok: true });
}));

app.delete('/admin/api/videos/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { id } = req.params;

  const [rows] = await getPool().query('SELECT * FROM lecture_videos WHERE id = ?', [id]);
  const video = rows[0];
  if (!video) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  // 인코딩 중엔 워커가 파일을 만들고 있어 삭제하면 R2에 고아 파일이 남는다 — 완료/실패 후에만 허용
  if (video.status === 'processing') {
    res.status(409).json({ error: '인코딩이 진행 중인 영상은 삭제할 수 없습니다. 완료 후 다시 시도하세요.' });
    return;
  }
  // 클래스 강의로 연결된 영상을 지우면 수강생 재생이 깨진다 — 연결 해제 후에만 삭제 허용
  if (video.final_r2_key) {
    const [[{ cnt }]] = await getPool().query(
      'SELECT COUNT(*) AS cnt FROM class_lectures WHERE video_r2_key = ?',
      [video.final_r2_key]
    );
    if (cnt > 0) {
      res.status(409).json({ error: `클래스 강의 ${cnt}개에 연결된 영상입니다. 클래스 편집의 "강의 영상" 탭에서 연결을 해제한 후 삭제해주세요.` });
      return;
    }
  }

  // 업로드가 완료되지 않은 멀티파트가 남아 있으면 중단 (이미 완료/중단된 경우의 에러는 무시)
  if (video.status === 'uploading' && video.raw_upload_id) {
    await r2.abortMultipartUpload(video.raw_r2_key, video.raw_upload_id).catch(() => {});
  }
  if (video.raw_r2_key) await r2.deleteObject(video.raw_r2_key);
  if (video.final_r2_key) {
    if (isHlsKey(video.final_r2_key)) {
      // HLS는 master.m3u8 + segment*.ts가 프리픽스 아래 여러 개 있으므로 폴더째로 지운다
      const prefix = video.final_r2_key.slice(0, video.final_r2_key.lastIndexOf('/') + 1);
      await r2.deleteObjectsByPrefix(prefix);
    } else {
      await r2.deleteObject(video.final_r2_key); // 레거시 mp4 단일 파일
    }
  }

  // DB 행을 지우면 큐에 남은 작업 메시지는 워커가 "행 없음"으로 판단해 스킵한다 (queued 상태도 안전)
  await getPool().query('DELETE FROM lecture_videos WHERE id = ?', [id]);

  res.json({ ok: true });
}));

app.put('/admin/api/videos/:id/move', requireAdminApi, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const { folderId } = req.body;
  const [rows] = await getPool().query('SELECT id FROM lecture_videos WHERE id = ?', [id]);
  if (!rows[0]) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  if (folderId) {
    const [[{ cnt }]] = await getPool().query('SELECT COUNT(*) AS cnt FROM video_folders WHERE id = ?', [folderId]);
    if (cnt === 0) {
      res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
      return;
    }
  }
  await getPool().query('UPDATE lecture_videos SET folder_id = ? WHERE id = ?', [folderId || null, id]);
  res.json({ ok: true });
}));

app.put('/admin/api/videos/:id/rename', requireAdminApi, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const title = (req.body.title || '').trim();
  if (!title) {
    res.status(400).json({ error: '제목을 입력해주세요.' });
    return;
  }
  const [rows] = await getPool().query('SELECT id FROM lecture_videos WHERE id = ?', [id]);
  if (!rows[0]) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  await getPool().query('UPDATE lecture_videos SET title = ? WHERE id = ?', [title, id]);
  res.json({ ok: true });
}));

// 관리자 미리보기용 — HLS 영상의 서명된 매니페스트를 내려준다 (레거시 mp4는 final_url을 그대로 재생)
app.get('/admin/api/videos/:id/stream/master.m3u8', requireAdminApi, wrapAsync(async (req, res) => {
  const [[video]] = await getPool().query('SELECT final_r2_key FROM lecture_videos WHERE id = ?', [req.params.id]);
  if (!video || !isHlsKey(video.final_r2_key)) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const manifest = await renderSignedManifest(video.final_r2_key, signKeyUrl(`/admin/api/videos/${req.params.id}/stream/key`));
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Cache-Control', 'no-store');
  res.send(manifest);
}));

// 키 라우트는 세션/토큰이 아니라 매니페스트 발급 시점에 심어둔 exp+sig 서명으로만 인증한다 —
// 네이티브 HLS 플레이어(AVPlayer/ExoPlayer, 일렉트론)는 매니페스트 안의 URI를 플레이어 엔진이
// 직접 요청하므로 커스텀 인증 헤더를 실을 수 없다. 세그먼트가 이미 R2 프리사인 절대 URL로
// "자체완결적"인 것과 같은 이유 — enrollment 확인은 매니페스트 발급 시 이미 끝났다.
app.get('/admin/api/videos/:id/stream/key', wrapAsync(async (req, res) => {
  if (!verifySignedKeyUrl(`/admin/api/videos/${req.params.id}/stream/key`, req.query.exp, req.query.sig)) {
    res.status(403).json({ error: '유효하지 않거나 만료된 요청입니다.' });
    return;
  }
  const [[video]] = await getPool().query('SELECT hls_key_base64 FROM lecture_videos WHERE id = ?', [req.params.id]);
  sendHlsKey(res, video?.hls_key_base64);
}));

// vod.html 상단 인트로 영상 — 로그인 없이 누구나 볼 수 있는 유일한 공개 강의(기본: 0강 연고대 편입논술 OT).
// enrollment 확인 없이 항상 이 한 영상만 내려주므로 :id 파라미터를 받지 않는다(임의 lecture_videos.id 스트리밍 노출 방지).
// 어떤 영상을 쓸지는 관리자 "VOD 강좌 → VOD 페이지 인트로"에서 고른 값(site_sections)을 따른다.
//
// 공개 여부는 lecture_videos.is_public 플래그가 최종 권한을 갖는다. 인트로 영상을 저장할 때마다
// syncPublicIntroVideo()가 "고른 영상만 1, 나머지는 전부 0"으로 맞추므로, 영상을 바꾸면
// 이전 영상은 그 즉시 다시 회원 전용으로 잠긴다. 플래그를 직접 0으로 내리는 것만으로도 공개가 끊긴다.
const PUBLIC_VOD_INTRO_LECTURE_ID = 24; // 관리자가 아직 지정하지 않았을 때의 기본값

function parseIntroVideoId(content) {
  try {
    const id = Number(JSON.parse(content).lectureVideoId);
    return Number.isInteger(id) && id > 0 ? id : PUBLIC_VOD_INTRO_LECTURE_ID;
  } catch {
    return PUBLIC_VOD_INTRO_LECTURE_ID;
  }
}

async function getPublicVodIntroVideoId() {
  const [rows] = await getPool().query(
    "SELECT content FROM site_sections WHERE page = 'vod' AND section_key = 'intro'"
  );
  return rows[0] ? parseIntroVideoId(rows[0].content) : PUBLIC_VOD_INTRO_LECTURE_ID;
}

// 인트로에 걸린 영상 하나만 공개로 남긴다. 지금은 공개 노출 자리가 인트로뿐이라
// "나머지 전부 0"으로 되돌리는 게 곧 이전 영상 자동 잠금이다.
// 공개 자리가 늘어나면 여기서 다른 자리에 쓰이는 영상을 제외해야 한다.
async function syncPublicIntroVideo(lectureVideoId) {
  const publicId = parseIntroVideoId(JSON.stringify({ lectureVideoId }));
  await getPool().query('UPDATE lecture_videos SET is_public = 0 WHERE is_public = 1 AND id <> ?', [publicId]);
  await getPool().query('UPDATE lecture_videos SET is_public = 1 WHERE id = ? AND is_public = 0', [publicId]);
}

app.get('/api/stream/vod-intro/master.m3u8', wrapAsync(async (req, res) => {
  const [[video]] = await getPool().query(
    'SELECT final_r2_key FROM lecture_videos WHERE id = ? AND is_public = 1',
    [await getPublicVodIntroVideoId()]
  );
  if (!video || !isHlsKey(video.final_r2_key)) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const manifest = await renderSignedManifest(video.final_r2_key, signKeyUrl('/api/stream/vod-intro/key'));
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Cache-Control', 'no-store');
  res.send(manifest);
}));

app.get('/api/stream/vod-intro/key', wrapAsync(async (req, res) => {
  if (!verifySignedKeyUrl('/api/stream/vod-intro/key', req.query.exp, req.query.sig)) {
    res.status(403).json({ error: '유효하지 않거나 만료된 요청입니다.' });
    return;
  }
  // 매니페스트와 같은 조건으로 다시 확인 — 공개를 내린 뒤 이미 발급된 서명 키 URL로 계속 받아가는 걸 막는다.
  const [[video]] = await getPool().query(
    'SELECT hls_key_base64 FROM lecture_videos WHERE id = ? AND is_public = 1',
    [await getPublicVodIntroVideoId()]
  );
  sendHlsKey(res, video?.hls_key_base64);
}));

// 회원이 실제로 수강 중인 클래스/VOD 강좌의 HLS 영상만 서명된 매니페스트로 내려준다.
// videoUrl을 이 경로로 내려주는 쪽은 /api/members/my-lectures/:classId, /api/members/my-vod-lectures/:vodCourseId.
app.get('/api/stream/class-lecture/:lectureId/master.m3u8', requireMember, wrapAsync(async (req, res) => {
  const [[lecture]] = await getPool().query(
    'SELECT class_id, video_r2_key FROM class_lectures WHERE id = ?',
    [req.params.lectureId]
  );
  if (!lecture || !isHlsKey(lecture.video_r2_key)) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const [enrollRows] = await getPool().query(
    'SELECT id FROM member_class_enrollments WHERE member_id = ? AND class_id = ?',
    [req.session.memberId, lecture.class_id]
  );
  if (!enrollRows[0]) {
    res.status(403).json({ error: '수강 중인 클래스가 아닙니다.' });
    return;
  }
  const manifest = await renderSignedManifest(lecture.video_r2_key, signKeyUrl(`/api/stream/class-lecture/${req.params.lectureId}/key`));
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Cache-Control', 'no-store');
  res.send(manifest);
}));

app.get('/api/stream/class-lecture/:lectureId/key', wrapAsync(async (req, res) => {
  if (!verifySignedKeyUrl(`/api/stream/class-lecture/${req.params.lectureId}/key`, req.query.exp, req.query.sig)) {
    res.status(403).json({ error: '유효하지 않거나 만료된 요청입니다.' });
    return;
  }
  const [[lecture]] = await getPool().query('SELECT video_r2_key FROM class_lectures WHERE id = ?', [req.params.lectureId]);
  if (!lecture) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const [[video]] = await getPool().query('SELECT hls_key_base64 FROM lecture_videos WHERE final_r2_key = ?', [lecture.video_r2_key]);
  sendHlsKey(res, video?.hls_key_base64);
}));

// 웹 세션(쿠키)과 네이티브 앱 Bearer 토큰 둘 다 허용 — 매니페스트는 앱 코드가 직접 fetch로
// 호출하므로(플레이어 엔진이 아니라) 둘 중 하나만 실으면 된다.
app.get('/api/stream/vod-lecture/:lectureId/master.m3u8', requireMemberOrApiToken, wrapAsync(async (req, res) => {
  const [[lecture]] = await getPool().query(
    'SELECT vod_course_id, video_r2_key FROM vod_course_lectures WHERE id = ?',
    [req.params.lectureId]
  );
  if (!lecture || !isHlsKey(lecture.video_r2_key)) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const access = await checkVodAccess(req.memberId, lecture.vod_course_id);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error, reason: access.reason });
    return;
  }
  const manifest = await renderSignedManifest(lecture.video_r2_key, signKeyUrl(`/api/stream/vod-lecture/${req.params.lectureId}/key`));
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Cache-Control', 'no-store');
  res.send(manifest);
}));

app.get('/api/stream/vod-lecture/:lectureId/key', wrapAsync(async (req, res) => {
  if (!verifySignedKeyUrl(`/api/stream/vod-lecture/${req.params.lectureId}/key`, req.query.exp, req.query.sig)) {
    res.status(403).json({ error: '유효하지 않거나 만료된 요청입니다.' });
    return;
  }
  const [[lecture]] = await getPool().query('SELECT video_r2_key FROM vod_course_lectures WHERE id = ?', [req.params.lectureId]);
  if (!lecture) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const [[video]] = await getPool().query('SELECT hls_key_base64 FROM lecture_videos WHERE final_r2_key = ?', [lecture.video_r2_key]);
  sendHlsKey(res, video?.hls_key_base64);
}));

// ── video_folders (영상 업로드 다중 계층 폴더, FTP 스타일) ──
app.get('/admin/api/video-folders', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT f.id, f.parent_id, f.name, f.sort_order,
            (SELECT COUNT(*) FROM video_folders WHERE parent_id = f.id) AS folder_count,
            (SELECT COUNT(*) FROM lecture_videos WHERE folder_id = f.id) AS video_count
     FROM video_folders f
     ORDER BY f.sort_order, f.id`
  );
  res.json(rows);
}));

app.post('/admin/api/video-folders', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, parent_id, sort_order } = req.body;
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: '폴더 이름을 입력해주세요.' });
    return;
  }
  if (parent_id) {
    const [[{ cnt }]] = await getPool().query('SELECT COUNT(*) AS cnt FROM video_folders WHERE id = ?', [parent_id]);
    if (cnt === 0) {
      res.status(404).json({ error: '상위 폴더를 찾을 수 없습니다.' });
      return;
    }
  }
  try {
    const [result] = await getPool().query(
      'INSERT INTO video_folders (parent_id, name, sort_order) VALUES (?, ?, ?)',
      [parent_id || null, String(name).trim(), parseInt(sort_order, 10) || 0]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '같은 위치에 이미 존재하는 폴더 이름입니다.' });
      return;
    }
    throw err;
  }
}));

app.put('/admin/api/video-folders/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const { name, parent_id, sort_order } = req.body;
  const [rows] = await getPool().query('SELECT * FROM video_folders WHERE id = ?', [id]);
  const folder = rows[0];
  if (!folder) {
    res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
    return;
  }

  const fields = [];
  const values = [];
  if (name !== undefined) {
    const newName = String(name).trim();
    if (!newName) {
      res.status(400).json({ error: '폴더 이름을 입력해주세요.' });
      return;
    }
    fields.push('name = ?');
    values.push(newName);
  }
  if (sort_order !== undefined) {
    fields.push('sort_order = ?');
    values.push(parseInt(sort_order, 10) || 0);
  }
  if (parent_id !== undefined) {
    const newParentId = parent_id || null;
    if (newParentId) {
      if (String(newParentId) === String(id)) {
        res.status(400).json({ error: '폴더를 자기 자신의 하위로 옮길 수 없습니다.' });
        return;
      }
      const [allRows] = await getPool().query('SELECT id, parent_id FROM video_folders');
      const parentOf = new Map(allRows.map(f => [String(f.id), f.parent_id != null ? String(f.parent_id) : null]));
      let cursor = String(newParentId);
      while (cursor != null) {
        if (cursor === String(id)) {
          res.status(400).json({ error: '하위 폴더로는 이동할 수 없습니다.' });
          return;
        }
        cursor = parentOf.get(cursor) ?? null;
      }
      if (!parentOf.has(String(newParentId))) {
        res.status(404).json({ error: '상위 폴더를 찾을 수 없습니다.' });
        return;
      }
    }
    fields.push('parent_id = ?');
    values.push(newParentId);
  }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }

  try {
    values.push(id);
    await getPool().query(`UPDATE video_folders SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '같은 위치에 이미 존재하는 폴더 이름입니다.' });
      return;
    }
    throw err;
  }
}));

app.delete('/admin/api/video-folders/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { id } = req.params;
  const [rows] = await getPool().query('SELECT id FROM video_folders WHERE id = ?', [id]);
  if (!rows[0]) {
    res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
    return;
  }
  const [[{ folderCnt }]] = await getPool().query('SELECT COUNT(*) AS folderCnt FROM video_folders WHERE parent_id = ?', [id]);
  const [[{ videoCnt }]] = await getPool().query('SELECT COUNT(*) AS videoCnt FROM lecture_videos WHERE folder_id = ?', [id]);
  if (folderCnt > 0 || videoCnt > 0) {
    res.status(409).json({ error: '폴더 안에 하위 폴더나 영상이 있어 삭제할 수 없습니다. 먼저 비워주세요.' });
    return;
  }
  await getPool().query('DELETE FROM video_folders WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// Express 4는 async 라우트의 reject를 잡지 못하므로 명시적으로 500 처리
function wrapAsync(handler) {
  return (req, res) => {
    handler(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    });
  };
}

const CLASS_FIELDS = [
  'filter_tab', 'category', 'badge_style', 'badge_text', 'thumb_title', 'thumb_subject',
  'thumb_gradient', 'name', 'enroll_period', 'course_period', 'capacity_note',
  'discount', 'price', 'original_price', 'detail_page', 'sort_order', 'is_active'
];
const BADGE_STYLES = ['enroll', 'hot', 'new'];

function validateClassBody(body) {
  for (const field of ['category', 'thumb_title', 'name', 'price']) {
    if (!body[field] || !String(body[field]).trim()) {
      return `${field}은(는) 필수 항목입니다.`;
    }
  }
  if (body.badge_style && !BADGE_STYLES.includes(body.badge_style)) {
    return 'badge_style은 enroll, hot, new 중 하나여야 합니다.';
  }
  return null;
}

function classValues(body) {
  return CLASS_FIELDS.map(field => {
    if (field === 'sort_order') return parseInt(body.sort_order, 10) || 0;
    if (field === 'is_active') {
      return body.is_active === false || body.is_active === 0 || body.is_active === '0' ? 0 : 1;
    }
    if (field === 'badge_style') return body.badge_style || 'new';
    if (field === 'badge_text') return body.badge_text || 'NEW';
    if (field === 'filter_tab') return body.filter_tab || '전체';
    if (field === 'thumb_gradient') return body.thumb_gradient || 'linear-gradient(135deg,#0d1b2a 0%,#1a2d40 100%)';
    const value = body[field];
    return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
  });
}

app.get('/api/classes', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT * FROM classes WHERE is_active = 1 ORDER BY sort_order, id'
  );
  res.json(rows);
}));

app.get('/admin/api/classes', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT * FROM classes ORDER BY sort_order, id');
  res.json(rows);
}));

app.post('/admin/api/classes', requireAdminApi, wrapAsync(async (req, res) => {
  const error = validateClassBody(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [result] = await getPool().query(
    `INSERT INTO classes (${CLASS_FIELDS.join(', ')}) VALUES (${CLASS_FIELDS.map(() => '?').join(', ')})`,
    classValues(req.body)
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/classes/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const error = validateClassBody(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [result] = await getPool().query(
    `UPDATE classes SET ${CLASS_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
    [...classValues(req.body), req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

app.delete('/admin/api/classes/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM classes WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

// intro_content/curriculum_content는 MariaDB에서 longtext로 저장되므로 직접 JSON 문자열로 변환/파싱한다.
const BANNER_FIELDS = [
  'banner_tag', 'banner_subtitle', 'banner_title_accent', 'banner_title_rest',
  'banner_instructor_name', 'banner_card_type', 'banner_card_gradient', 'banner_image_url'
];

app.get('/admin/api/classes/:id/content', requireAdminApi, wrapAsync(async (req, res) => {
  const [[row]] = await getPool().query(
    `SELECT id, name, intro_content, curriculum_content, ${BANNER_FIELDS.join(', ')} FROM classes WHERE id = ?`,
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }
  res.json({
    id: row.id,
    name: row.name,
    intro_content: row.intro_content ? JSON.parse(row.intro_content) : null,
    curriculum_content: row.curriculum_content ? JSON.parse(row.curriculum_content) : null,
    ...Object.fromEntries(BANNER_FIELDS.map(f => [f, row[f]]))
  });
}));

app.put('/admin/api/classes/:id/content', requireAdminApi, wrapAsync(async (req, res) => {
  const introContent = req.body.intro_content ? JSON.stringify(req.body.intro_content) : null;
  const curriculumContent = req.body.curriculum_content ? JSON.stringify(req.body.curriculum_content) : null;
  const bannerValues = BANNER_FIELDS.map(f => {
    if (f === 'banner_card_type') return req.body.banner_card_type === 'image' ? 'image' : 'gradient';
    const value = req.body[f];
    return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
  });
  const [result] = await getPool().query(
    `UPDATE classes SET intro_content = ?, curriculum_content = ?, ${BANNER_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
    [introContent, curriculumContent, ...bannerValues, req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

app.post('/admin/api/classes/:id/banner-image/presign', requireAdminApi, wrapAsync(async (req, res) => {
  const { contentType } = req.body;
  if (!contentType || !contentType.startsWith('image/')) {
    res.status(400).json({ error: 'contentType이 이미지 형식이어야 합니다.' });
    return;
  }
  const ext = contentType.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'jpg';
  const key = `classes/${req.params.id}/banner-${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await r2.presignPutObject(key, contentType);
  res.json({ key, uploadUrl });
}));

app.post('/admin/api/classes/:id/banner-image/confirm', requireAdminApi, wrapAsync(async (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith(`classes/${req.params.id}/`)) {
    res.status(400).json({ error: '유효하지 않은 key입니다.' });
    return;
  }
  const url = `/uploads/${key}`;
  const [result] = await getPool().query(
    'UPDATE classes SET banner_card_type = ?, banner_image_url = ? WHERE id = ?',
    ['image', url, req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true, url });
}));

// ── 관리자 업로드 PNG의 무손실 WebP 변환 캐시 ──
// R2에 있는 원본 PNG(강좌 썸네일·배너 등)는 장당 1~2MB라 홈 첫 화면을 가장 크게 잡아먹는다.
// R2 원본은 그대로 두고, 서버 디스크에 무손실 WebP를 만들어 두었다가 WebP를 받는 브라우저에만 대신 내려준다.
// - 무손실(lossless)만 사용 — 보이는 픽셀은 원본과 100% 동일하다. 화질 저하 없음.
// - JPEG는 변환하지 않는다: 이미 손실 압축이라 무손실 WebP로 감싸면 오히려 커진다.
// - 캐시 미스인 첫 요청은 원본을 그대로 내려주고 변환은 백그라운드로 돌린다(첫 방문자가 변환을 기다리지 않음).
// - 변환 결과가 원본보다 크면 빈 마커를 남겨 다시 시도하지 않고 계속 원본을 쓴다.
const UPLOADS_WEBP_CACHE = path.join(__dirname, '.cache', 'uploads-webp');
const WEBP_CONVERT_MAX_BYTES = 40 * 1024 * 1024; // 이 이상 큰 원본은 메모리 보호 차원에서 변환하지 않음
const webpConverting = new Set(); // 같은 키를 동시에 여러 번 변환하지 않도록
fs.mkdirSync(UPLOADS_WEBP_CACHE, { recursive: true });

function uploadsWebpPath(key) {
  // 키에 슬래시·확장자가 섞여 있으므로 해시로 평평하게 저장(경로 탈출 걱정도 없어진다)
  return path.join(UPLOADS_WEBP_CACHE, crypto.createHash('sha256').update(key).digest('hex') + '.webp');
}

async function convertUploadToWebp(key, cachePath) {
  if (webpConverting.has(key)) return;
  webpConverting.add(key);
  try {
    const object = await r2.getObject(key);
    if (Number(object.ContentLength) > WEBP_CONVERT_MAX_BYTES) { await fs.promises.writeFile(cachePath, ''); return; }
    const chunks = [];
    for await (const chunk of object.Body) chunks.push(chunk);
    const original = Buffer.concat(chunks);
    const webp = await sharp(original).webp({ lossless: true, effort: 6 }).toBuffer();
    // 원본보다 크면 이득이 없다 → 빈 파일을 마커로 남겨 매번 재변환하지 않게 한다
    await fs.promises.writeFile(cachePath, webp.length < original.length ? webp : Buffer.alloc(0));
  } catch (err) {
    console.error('[uploads-webp] 변환 실패', key, err.message);
  } finally {
    webpConverting.delete(key);
  }
}

// 업로드 이미지 썸네일(`/uploads/...?w=320`) — 원본은 900~1700px인데 카드에서는 150~300px로 줄여 쓴다.
// 브라우저 축소만 맡기면 스캔 문서의 잔글씨가 뭉개지므로, sharp로 미리 줄이면서 가볍게 샤픈해 캐시해 둔다.
// 비율은 건드리지 않는다(합격증 이미지 비율이 0.56~0.86으로 제각각이라 자르면 잘려나가는 부분이 생긴다).
const UPLOADS_THUMB_CACHE = path.join(__dirname, '.cache', 'uploads-thumb');
const THUMB_WIDTHS = [160, 200, 240, 320, 400, 480, 640, 800]; // 캐시가 무한정 늘지 않도록 허용 폭 고정
fs.mkdirSync(UPLOADS_THUMB_CACHE, { recursive: true });

function uploadsThumbPath(key, width, format) {
  return path.join(UPLOADS_THUMB_CACHE, crypto.createHash('sha256').update(`${key}@${width}.${format}`).digest('hex') + '.' + format);
}

async function makeUploadThumb(key, width, format, cachePath) {
  const object = await r2.getObject(key);
  const chunks = [];
  for await (const chunk of object.Body) chunks.push(chunk);
  const pipeline = sharp(Buffer.concat(chunks))
    .rotate()                                     // EXIF 회전 반영(휴대폰으로 찍어 올린 합격증)
    .resize({ width, withoutEnlargement: true })  // 비율 유지 — 자르지 않는다
    .sharpen();                                   // 축소하면 흐려지므로 되살린다
  const buf = await (format === 'webp' ? pipeline.webp({ quality: 82 }) : pipeline.jpeg({ quality: 84, mozjpeg: true })).toBuffer();
  // 동시 요청이 반쯤 쓰인 파일을 읽지 않도록 임시 파일에 쓰고 옮긴다
  const tmpPath = `${cachePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tmpPath, buf);
  await fs.promises.rename(tmpPath, cachePath);
  return buf;
}

app.get('/uploads/*', wrapAsync(async (req, res) => {
  const key = req.params[0];
  const thumbWidth = THUMB_WIDTHS.includes(Number(req.query.w)) ? Number(req.query.w) : 0;
  if (thumbWidth && /\.(png|jpe?g|webp)$/i.test(key)) {
    const format = (req.headers.accept || '').includes('image/webp') ? 'webp' : 'jpeg';
    const cachePath = uploadsThumbPath(key, thumbWidth, format);
    try {
      let cached = null;
      try { cached = await fs.promises.stat(cachePath); } catch { /* 캐시 없음 */ }
      const buf = cached && cached.size > 0 ? null : await makeUploadThumb(key, thumbWidth, format, cachePath);
      res.setHeader('Content-Type', `image/${format}`);
      res.setHeader('Vary', 'Accept');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (buf) res.end(buf); else res.sendFile(cachePath);
      return;
    } catch (err) {
      // 썸네일을 못 만들면 아래로 흘려보내 원본을 그대로 내려준다
      console.error('[uploads-thumb] 생성 실패', key, err.message);
    }
  }
  const wantsWebp = (req.headers.accept || '').includes('image/webp') && /\.png$/i.test(key);
  if (wantsWebp) {
    const cachePath = uploadsWebpPath(key);
    let cached = null;
    try { cached = await fs.promises.stat(cachePath); } catch { /* 캐시 없음 */ }
    if (cached && cached.size > 0) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Vary', 'Accept');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(cachePath);
      return;
    }
    // 캐시 미스(또는 "변환해도 이득 없음" 마커) — 원본을 내려주고, 아직 안 만들었으면 백그라운드로 만든다
    if (!cached) convertUploadToWebp(key, cachePath);
  }
  try {
    const object = await r2.getObject(key);
    if (object.ContentType) res.setHeader('Content-Type', object.ContentType);
    if (/\.png$/i.test(key)) res.setHeader('Vary', 'Accept'); // 위 WebP 대체와 짝을 맞춘다
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    object.Body.pipe(res);
  } catch (err) {
    res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  }
}));

// 커리큘럼 챕터별 영상/자료 첨부 (목업 단계 — 소용량 파일 단일 PUT 업로드, 대용량 강의 영상은 별도 워커 파이프라인 사용)
const ATTACHMENT_TYPES = ['video', 'material'];

app.post('/admin/api/classes/:id/chapter-attachments/presign', requireAdminApi, wrapAsync(async (req, res) => {
  const { chapterKey, type, contentType, filename } = req.body;
  if (!chapterKey || !ATTACHMENT_TYPES.includes(type) || !contentType) {
    res.status(400).json({ error: 'chapterKey, type, contentType가 필요합니다.' });
    return;
  }
  const extFromName = filename && filename.includes('.') ? filename.split('.').pop() : '';
  const ext = (extFromName || contentType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  const key = `classes/${req.params.id}/chapters/${chapterKey}/${type}-${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await r2.presignPutObject(key, contentType);
  res.json({ key, uploadUrl });
}));

app.post('/admin/api/classes/:id/chapter-attachments/confirm', requireAdminApi, wrapAsync(async (req, res) => {
  const { chapterKey, type, key, title, contentType, fileSize } = req.body;
  if (!chapterKey || !ATTACHMENT_TYPES.includes(type) || !key || !title) {
    res.status(400).json({ error: 'chapterKey, type, key, title이 필요합니다.' });
    return;
  }
  if (!key.startsWith(`classes/${req.params.id}/chapters/${chapterKey}/`)) {
    res.status(400).json({ error: '유효하지 않은 key입니다.' });
    return;
  }
  const url = `/uploads/${key}`;
  const [result] = await getPool().query(
    'INSERT INTO class_chapter_attachments (class_id, chapter_key, type, title, file_url, file_key, mime_type, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.params.id, chapterKey, type, title, url, key, contentType || null, fileSize || null]
  );
  res.json({ ok: true, id: result.insertId, url });
}));

app.get('/admin/api/classes/:id/chapter-attachments', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT * FROM class_chapter_attachments WHERE class_id = ? ORDER BY chapter_key, type, sort_order, id',
    [req.params.id]
  );
  res.json(rows);
}));

app.delete('/admin/api/classes/:id/chapter-attachments/:attachmentId', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    'DELETE FROM class_chapter_attachments WHERE id = ? AND class_id = ?',
    [req.params.attachmentId, req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '첨부파일을 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

// ── 클래스 ↔ 업로드 영상 연결 (class_lectures) — 시청 페이지가 읽는 실제 강의 목록 ──
app.get('/admin/api/classes/:id/lectures', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT l.id, l.lecture_number, l.title, l.video_r2_key, l.sort_order,
            v.id AS video_id, v.title AS video_title
     FROM class_lectures l
     LEFT JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     WHERE l.class_id = ?
     ORDER BY l.sort_order, l.lecture_number`,
    [req.params.id]
  );
  res.json(rows);
}));

app.post('/admin/api/classes/:id/lectures', requireAdminApi, wrapAsync(async (req, res) => {
  const { videoId, lectureNumber, title } = req.body;
  const num = parseInt(lectureNumber, 10);
  if (!videoId || Number.isNaN(num) || num < 0) {
    res.status(400).json({ error: 'videoId와 0 이상의 lectureNumber가 필요합니다.' });
    return;
  }
  const [[video]] = await getPool().query('SELECT id, title, status, final_r2_key FROM lecture_videos WHERE id = ?', [videoId]);
  if (!video) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  if (video.status !== 'done' || !video.final_r2_key) {
    res.status(409).json({ error: '인코딩이 완료된(done) 영상만 클래스에 연결할 수 있습니다.' });
    return;
  }
  try {
    const [result] = await getPool().query(
      'INSERT INTO class_lectures (class_id, lecture_number, title, video_r2_key, sort_order) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, num, String(title || video.title).trim(), video.final_r2_key, num]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: `${num}강은 이미 등록되어 있습니다. 다른 번호를 사용하거나 기존 강의를 해제해주세요.` });
      return;
    }
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
      return;
    }
    throw err;
  }
}));

app.put('/admin/api/classes/:id/lectures/:lectureId', requireAdminApi, wrapAsync(async (req, res) => {
  const { lectureNumber, title } = req.body;
  const fields = [];
  const values = [];
  if (lectureNumber !== undefined) {
    const num = parseInt(lectureNumber, 10);
    if (Number.isNaN(num) || num < 0) {
      res.status(400).json({ error: '강의 번호는 0 이상의 숫자여야 합니다.' });
      return;
    }
    fields.push('lecture_number = ?', 'sort_order = ?');
    values.push(num, num);
  }
  if (title !== undefined) {
    if (!String(title).trim()) {
      res.status(400).json({ error: '제목을 입력해주세요.' });
      return;
    }
    fields.push('title = ?');
    values.push(String(title).trim());
  }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }
  try {
    values.push(req.params.lectureId, req.params.id);
    const [result] = await getPool().query(
      `UPDATE class_lectures SET ${fields.join(', ')} WHERE id = ? AND class_id = ?`,
      values
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: '강의를 찾을 수 없습니다.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '해당 번호의 강의가 이미 있습니다.' });
      return;
    }
    throw err;
  }
}));

// 연결 해제만 수행 — R2 파일과 lecture_videos 행은 그대로 남는다 (수업자료 행은 FK cascade로 함께 삭제)
app.delete('/admin/api/classes/:id/lectures/:lectureId', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    'DELETE FROM class_lectures WHERE id = ? AND class_id = ?',
    [req.params.lectureId, req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '강의를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

app.get('/api/classes/:id/chapter-attachments', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT chapter_key, type, title, file_url, mime_type, file_size FROM class_chapter_attachments WHERE class_id = ? ORDER BY chapter_key, type, sort_order, id',
    [req.params.id]
  );
  res.json(rows);
}));

app.get('/api/classes/:id/content', wrapAsync(async (req, res) => {
  const [[row]] = await getPool().query(
    `SELECT id, name, filter_tab, category, price, intro_content, curriculum_content, ${BANNER_FIELDS.join(', ')} FROM classes WHERE id = ? AND is_active = 1`,
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }
  res.json({
    id: row.id,
    name: row.name,
    filter_tab: row.filter_tab,
    category: row.category,
    price: row.price,
    intro_content: row.intro_content ? JSON.parse(row.intro_content) : null,
    curriculum_content: row.curriculum_content ? JSON.parse(row.curriculum_content) : null,
    ...Object.fromEntries(BANNER_FIELDS.map(f => [f, row[f]]))
  });
}));

app.get('/api/class-categories', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT id, name, sort_order FROM class_categories ORDER BY sort_order, id'
  );
  res.json(rows);
}));

app.get('/admin/api/class-categories', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT c.id, c.name, c.sort_order,
            (SELECT COUNT(*) FROM classes WHERE filter_tab = c.name) AS class_count
     FROM class_categories c
     ORDER BY c.sort_order, c.id`
  );
  res.json(rows);
}));

app.post('/admin/api/class-categories', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, sort_order } = req.body;
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: '카테고리 이름을 입력해주세요.' });
    return;
  }
  try {
    const [result] = await getPool().query(
      'INSERT INTO class_categories (name, sort_order) VALUES (?, ?)',
      [String(name).trim(), parseInt(sort_order, 10) || 0]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
      return;
    }
    throw err;
  }
}));

app.put('/admin/api/class-categories/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, sort_order } = req.body;
  const [rows] = await getPool().query('SELECT name FROM class_categories WHERE id = ?', [req.params.id]);
  const existing = rows[0];
  if (!existing) {
    res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    return;
  }

  const fields = [];
  const values = [];
  const newName = name !== undefined ? String(name).trim() : null;
  if (newName) { fields.push('name = ?'); values.push(newName); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }

  try {
    values.push(req.params.id);
    await getPool().query(`UPDATE class_categories SET ${fields.join(', ')} WHERE id = ?`, values);
    if (newName && newName !== existing.name) {
      // 이름이 바뀌면 이 카테고리를 쓰던 기존 클래스들도 같은 이름으로 따라간다.
      await getPool().query('UPDATE classes SET filter_tab = ? WHERE filter_tab = ?', [newName, existing.name]);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
      return;
    }
    throw err;
  }
}));

app.delete('/admin/api/class-categories/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT name FROM class_categories WHERE id = ?', [req.params.id]);
  const category = rows[0];
  if (!category) {
    res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    return;
  }
  const [[{ cnt }]] = await getPool().query('SELECT COUNT(*) AS cnt FROM classes WHERE filter_tab = ?', [category.name]);
  if (cnt > 0) {
    res.status(409).json({ error: `이 카테고리를 사용 중인 클래스가 ${cnt}개 있습니다. 먼저 해당 클래스의 카테고리를 변경해주세요.` });
    return;
  }
  await getPool().query('DELETE FROM class_categories WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/admin/api/members', requireAdminApi, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const offset = (page - 1) * pageSize;
  const search = (req.query.search || '').trim();

  const where = search ? 'WHERE username LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ? OR mobile LIKE ?' : '';
  const likeParams = search ? Array(5).fill(`%${search}%`) : [];

  const [[{ total }]] = await getPool().query(
    `SELECT COUNT(*) AS total FROM members ${where}`,
    likeParams
  );
  const [rows] = await getPool().query(
    `SELECT id, username, name, email, phone, mobile, joined_at, member_group, (password IS NOT NULL) AS has_password
     FROM members ${where}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [...likeParams, pageSize, offset]
  );

  res.json({ total, page, pageSize, rows });
});

app.get('/admin/api/members/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, username, name, birth_date, member_group, phone, mobile, email,
            postal_code, road_address, detail_address,
            signup_channel, search_keyword, referrer_code,
            email_marketing_consent, sms_marketing_consent,
            joined_at, general_notes, consultation_notes,
            (password IS NOT NULL) AS has_password
     FROM members WHERE id = ?`,
    [req.params.id]
  );
  if (!rows[0]) {
    res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
    return;
  }
  res.json(rows[0]);
}));

// 학생을 클래스에 등록하는 공통 진입점 — 지금은 관리자 수동 배정에서만 쓰이지만,
// 추후 결제 완료 웹훅에서도 동일하게 enrollMemberInClass(memberId, classId, 'payment')로 호출하면 된다.
async function enrollMemberInClass(memberId, classId, source = 'admin', extra = {}) {
  const status = extra.status === '완료' ? '완료' : '진행중';
  const progressNote = extra.progressNote || null;
  await getPool().query(
    `INSERT INTO member_class_enrollments (member_id, class_id, status, progress_note, source)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), progress_note = VALUES(progress_note)`,
    [memberId, classId, status, progressNote, source]
  );
}

app.get('/admin/api/members/:id/enrollments', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT e.id, e.class_id, e.status, e.progress_note, e.source, e.enrolled_at, c.name
     FROM member_class_enrollments e
     JOIN classes c ON c.id = e.class_id
     WHERE e.member_id = ?
     ORDER BY e.enrolled_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

app.post('/admin/api/members/:id/enrollments', requireAdminApi, wrapAsync(async (req, res) => {
  const { classId, status, progressNote } = req.body;
  if (!classId) {
    res.status(400).json({ error: 'classId가 필요합니다.' });
    return;
  }
  await enrollMemberInClass(req.params.id, classId, 'admin', { status, progressNote });
  res.json({ ok: true });
}));

app.put('/admin/api/members/:id/enrollments/:enrollmentId', requireAdminApi, wrapAsync(async (req, res) => {
  const { status, progressNote } = req.body;
  const fields = [];
  const values = [];
  if (status !== undefined) { fields.push('status = ?'); values.push(status === '완료' ? '완료' : '진행중'); }
  if (progressNote !== undefined) { fields.push('progress_note = ?'); values.push(progressNote || null); }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }
  values.push(req.params.enrollmentId, req.params.id);
  const [result] = await getPool().query(
    `UPDATE member_class_enrollments SET ${fields.join(', ')} WHERE id = ? AND member_id = ?`,
    values
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '등록 정보를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

app.delete('/admin/api/members/:id/enrollments/:enrollmentId', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    'DELETE FROM member_class_enrollments WHERE id = ? AND member_id = ?',
    [req.params.enrollmentId, req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '등록 정보를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

// VOD 강좌 수강 등록 — enrollMemberInClass와 동일한 패턴, vod_courses 전용.
// vod_courses.access_days가 설정돼 있으면 등록 시점 기준 만료일(expires_at)을 계산해 행에 박아둔다.
// 스냅샷으로 저장하는 이유: 나중에 관리자가 강좌의 수강기간을 줄여도 기존 구매자에게 소급 적용되지 않고,
// 개별 회원 연장(고객 응대)도 이 행 하나만 고치면 되기 때문.
async function enrollMemberInVod(memberId, vodCourseId, source = 'admin', extra = {}) {
  const status = extra.status === '완료' ? '완료' : '진행중';
  const progressNote = extra.progressNote || null;
  const [[course]] = await getPool().query('SELECT access_days FROM vod_courses WHERE id = ?', [vodCourseId]);
  const accessDays = course && course.access_days > 0 ? course.access_days : null;

  // 신규 등록은 오늘부터 access_days.
  // 이미 행이 있을 때는 등록 경로에 따라 다르게 처리한다:
  //  - 재구매(payment): 남은 기간에 이어서 연장. 만료됐으면 오늘부터 다시 시작.
  //    단 기존 행이 무제한(expires_at IS NULL)이면 그대로 무제한 — 과거 구매자를 소급해서 제한하지 않는다.
  //  - 관리자 재등록(admin): 의도적인 조작이므로 오늘부터 다시 계산한다.
  const insertExpires = accessDays ? 'DATE_ADD(NOW(), INTERVAL ? DAY)' : 'NULL';
  const updateExpires = accessDays
    ? (source === 'payment'
        ? 'IF(expires_at IS NULL, NULL, DATE_ADD(GREATEST(NOW(), expires_at), INTERVAL ? DAY))'
        : 'DATE_ADD(NOW(), INTERVAL ? DAY)')
    : 'NULL';
  const params = [memberId, vodCourseId, status, progressNote, source];
  if (accessDays) params.push(accessDays, accessDays);

  await getPool().query(
    `INSERT INTO member_vod_enrollments (member_id, vod_course_id, status, progress_note, source, expires_at)
     VALUES (?, ?, ?, ?, ?, ${insertExpires})
     ON DUPLICATE KEY UPDATE status = VALUES(status), progress_note = VALUES(progress_note),
       expires_at = ${updateExpires}`,
    params
  );
}

// ── VOD 수강 접근 판정 (단일 진실공급원) ──
// 수강권한 = 등록 존재 + 개인 수강기간(expires_at) 유효 + 강좌 종료일(ends_at) 미도래.
// 스트림 매니페스트 / 강의 목록 / 재생 URL / Q&A 작성 게이트가 전부 이 함수만 쓰도록 통일한다
// (체크가 흩어져 있으면 한 군데를 빠뜨렸을 때 그대로 우회 경로가 된다).
// ends_at은 DATE라 "종료일 당일 자정까지"는 시청 가능하도록 >= CURDATE()로 비교한다.
async function checkVodAccess(memberId, vodCourseId) {
  const [[row]] = await getPool().query(
    `SELECT e.expires_at, c.ends_at,
            (e.expires_at IS NOT NULL AND e.expires_at <= NOW()) AS is_expired,
            (c.ends_at IS NOT NULL AND c.ends_at < CURDATE()) AS is_ended
     FROM member_vod_enrollments e
     JOIN vod_courses c ON c.id = e.vod_course_id
     WHERE e.member_id = ? AND e.vod_course_id = ?`,
    [memberId, vodCourseId]
  );
  if (!row) return { ok: false, status: 403, reason: 'not_enrolled', error: '수강 중인 강좌가 아닙니다.' };
  // 종료(재구매 불가)가 만료(재구매 가능)보다 강한 사유라 먼저 판정한다.
  if (row.is_ended) return { ok: false, status: 403, reason: 'course_ended', error: '종료된 강좌입니다.' };
  if (row.is_expired) return { ok: false, status: 403, reason: 'expired', error: '수강 기간이 만료되었습니다.' };
  return { ok: true, expiresAt: row.expires_at, endsAt: row.ends_at };
}

// ── PayUp 표준결제 (VOD 강좌 구매) ──
// 1) POST /api/payments/init      — 결제창(goPayupPay)에 넘길 데이터 발급, payments 행을 pending으로 선기록
// 2) POST /api/payments/approve   — PC: PayupPaymentStandardForm이 그대로 POST하는 승인 요청 URL (풀 페이지 이동, 응답도 redirect)
// 3) POST /api/payments/approve-mobile — 모바일: returnUrl 페이지가 fetch로 호출 (JSON 응답)
function parseKoreanWonPrice(priceText) {
  const digits = String(priceText || '').replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function makeOrderNumber(memberId) {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // YYYYMMDDHHMISS
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${ts}M${memberId}${rand}`;
}

// 쿠폰(coupons) — 관리자페이지 "쿠폰관리"에서 발급한 16자리 코드를 마이페이지에서 등록(claim)한 회원만
// 자기 쿠폰을 쓸 수 있다. vod_course_id가 NULL이면 강좌 무관 범용 쿠폰, 있으면 그 강좌 전용.
// 주문확인 페이지 쿠폰 드롭다운과 /api/payments/init 서버측 금액 재검증이 이 함수 하나를 공유해야
// "화면에 안 보이던 쿠폰을 id만 조작해서 적용" 같은 우회가 막힌다.
async function getEligibleCoupons(memberId, vodCourseId) {
  const [rows] = await getPool().query(
    `SELECT id, code, vod_course_id, discount_type, discount_value, label
     FROM coupons
     WHERE member_id = ? AND status = '등록됨' AND (vod_course_id IS NULL OR vod_course_id = ?)
     ORDER BY created_at ASC`,
    [memberId, vodCourseId]
  );
  return rows;
}

// discount_value의 의미가 fixed(원)/percent(%)로 갈리므로, "이 금액에 적용하면 실제로 얼마나 깎이는지"는
// 매번 이 함수로 계산한다 — 쿠폰이 강좌 가격보다 큰 정액이거나 반올림 오차가 있어도 절대 원가를 넘지 않는다.
function computeCouponDiscountAmount(amount, coupon) {
  if (coupon.discount_type === 'percent') {
    return Math.min(amount, Math.round(amount * coupon.discount_value / 100));
  }
  return Math.min(amount, coupon.discount_value);
}

function couponDisplayLabel(coupon) {
  if (coupon.label) return coupon.label;
  return coupon.discount_type === 'percent'
    ? `${coupon.discount_value}% 할인 쿠폰`
    : `${Number(coupon.discount_value).toLocaleString('ko-KR')}원 할인 쿠폰`;
}

app.get('/api/payments/coupons', requireMember, wrapAsync(async (req, res) => {
  const vodCourseId = parseInt(req.query.vodCourseId, 10);
  if (!vodCourseId) { res.status(400).json({ error: 'vodCourseId가 필요합니다.' }); return; }
  const [[course]] = await getPool().query('SELECT new_price FROM vod_courses WHERE id = ?', [vodCourseId]);
  const basePrice = course ? parseKoreanWonPrice(course.new_price) : 0;
  const coupons = await getEligibleCoupons(req.session.memberId, vodCourseId);
  res.json(coupons.map(c => ({
    id: c.id,
    label: couponDisplayLabel(c),
    discountAmount: computeCouponDiscountAmount(basePrice, c)
  })));
}));

app.post('/api/payments/init', requireMember, wrapAsync(async (req, res) => {
  const vodCourseId = parseInt(req.body.vodCourseId, 10);
  if (!vodCourseId) { res.status(400).json({ error: 'vodCourseId가 필요합니다.' }); return; }

  const [[course]] = await getPool().query(
    `SELECT id, title, new_price, (ends_at IS NOT NULL AND ends_at < CURDATE()) AS is_ended
     FROM vod_courses WHERE id = ? AND is_active = 1`, [vodCourseId]
  );
  if (!course) { res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' }); return; }
  // 종료된 강좌는 결제해도 바로 시청 불가라 결제창 발급 자체를 막는다 (프론트에서 버튼을 막는 것과 이중 방어).
  if (course.is_ended) { res.status(409).json({ error: '종료된 강좌는 구매할 수 없습니다.' }); return; }

  const baseAmount = parseKoreanWonPrice(course.new_price);
  if (!baseAmount) { res.status(400).json({ error: '이 강좌는 가격이 설정되어 있지 않습니다.' }); return; }

  let amount = baseAmount;
  let couponId = null;
  const requestedCouponId = parseInt(req.body.couponId, 10);
  if (requestedCouponId) {
    // 프론트가 보낸 할인 금액은 신뢰하지 않고, 회원이 실제로 등록한 쿠폰인지 다시 조회해 서버가 직접 금액을 정한다.
    const eligibleCoupons = await getEligibleCoupons(req.session.memberId, vodCourseId);
    const coupon = eligibleCoupons.find(c => c.id === requestedCouponId);
    if (!coupon) { res.status(400).json({ error: '적용할 수 없는 쿠폰입니다.' }); return; }
    amount = Math.max(0, baseAmount - computeCouponDiscountAmount(baseAmount, coupon));
    couponId = coupon.id;
  }

  const [[member]] = await getPool().query('SELECT name FROM members WHERE id = ?', [req.session.memberId]);
  const orderNumber = makeOrderNumber(req.session.memberId);

  await getPool().query(
    `INSERT INTO payments (member_id, vod_course_id, order_number, item_name, amount, status, coupon_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [req.session.memberId, vodCourseId, orderNumber, course.title, amount, couponId]
  );

  res.json({
    merchantId: payup.MERCHANT_ID,
    itemName: course.title,
    amount: String(amount),
    userName: member?.name || '',
    orderNumber,
    // 모바일 SDK 전용 — goPayupPay에 그대로 얹으면 됨 (PC에서는 무시됨)
    returnUrl: `${process.env.SITE_URL || ''}/payupReturn.html`
  });
}));

// 결제 성공/실패 결과를 보여주는 paymentComplete.html로 가는 링크. 주문 정보를 페이지 자체 API 호출 없이
// 그려낼 수 있도록 표시에 필요한 값을 쿼리스트링에 그대로 실어 보낸다(courseId는 항상 숫자라 그대로 써도 안전).
function paymentCompleteRedirect(payment, ok, reason) {
  const params = new URLSearchParams({
    payment: ok ? 'success' : 'fail',
    orderNumber: payment.order_number,
    courseId: String(payment.vod_course_id),
    itemName: payment.item_name,
    amount: String(payment.amount)
  });
  if (reason) params.set('reason', reason);
  return `paymentComplete.html?${params.toString()}`;
}

async function settlePayment({ orderNumber, transactionId, amount, memberId }) {
  const [[payment]] = await getPool().query('SELECT * FROM payments WHERE order_number = ?', [orderNumber]);
  if (!payment) return { ok: false, redirect: 'vod.html', reason: '주문 정보를 찾을 수 없습니다.' };
  if (payment.member_id !== memberId) return { ok: false, redirect: 'vod.html', reason: '본인 주문이 아닙니다.' };
  if (payment.status === 'approved') {
    return { ok: true, redirect: paymentCompleteRedirect(payment, true) };
  }
  if (String(payment.amount) !== String(amount)) {
    return { ok: false, redirect: paymentCompleteRedirect(payment, false, '결제 금액이 일치하지 않습니다.') };
  }

  const result = await payup.approvePayment({ transactionId, orderNumber, amount: payment.amount });
  const data = result.raw?.data || {};

  if (result.ok) {
    await getPool().query(
      `UPDATE payments SET status = 'approved', transaction_id = ?, response_code = ?, response_msg = ?, approved_at = NOW()
       WHERE order_number = ?`,
      [transactionId, data.responseCode || null, data.responseMsg || null, orderNumber]
    );
    await enrollMemberInVod(memberId, payment.vod_course_id, 'payment');
    if (payment.coupon_id) {
      await getPool().query(
        `UPDATE coupons SET status = '사용완료', used_at = NOW(), payment_id = ? WHERE id = ? AND member_id = ?`,
        [payment.id, payment.coupon_id, memberId]
      );
    }
    return { ok: true, redirect: paymentCompleteRedirect(payment, true) };
  }

  await getPool().query(
    `UPDATE payments SET status = 'failed', transaction_id = ?, response_code = ?, response_msg = ?
     WHERE order_number = ?`,
    [transactionId || null, data.responseCode || result.raw?.messageCode || null, data.responseMsg || result.raw?.message || null, orderNumber]
  );
  const reason = data.responseMsg || result.raw?.message;
  return { ok: false, redirect: paymentCompleteRedirect(payment, false, reason), reason };
}

// PC 표준결제창 SDK가 만든 PayupPaymentStandardForm이 그대로 POST하는 승인 요청 URL.
// 브라우저 풀 페이지 이동으로 도착하므로 JSON이 아니라 redirect로 응답한다.
app.post('/api/payments/approve', requireMember, wrapAsync(async (req, res) => {
  const { orderNumber, transactionId, amount } = req.body;
  if (!orderNumber || !transactionId || !amount) { res.redirect('/vod.html'); return; }
  const result = await settlePayment({ orderNumber, transactionId, amount, memberId: req.session.memberId });
  res.redirect('/' + result.redirect);
}));

// 모바일 SDK — 인증 완료 후 returnUrl(payupReturn.html)이 이 엔드포인트를 fetch로 호출한다.
app.post('/api/payments/approve-mobile', requireMember, wrapAsync(async (req, res) => {
  const { orderNumber, transactionId, amount } = req.body;
  if (!orderNumber || !transactionId || !amount) { res.status(400).json({ ok: false, redirect: 'vod.html' }); return; }
  const result = await settlePayment({ orderNumber, transactionId, amount, memberId: req.session.memberId });
  res.json(result);
}));

// 실기기 테스트 결과 카드사 인증 완료 후 브라우저가 returnUrl(payupReturn.html)로 "직접 POST"로 도착하는 것으로
// 확인됨 (GET+쿼리스트링이 아님) — public-figma는 정적 서빙이라 GET만 받으므로 이 라우트가 없으면 Express가
// "Cannot POST /payupReturn.html"을 반환한다. 카드사 인증 페이지(타 도메인)에서 넘어오는 크로스사이트 top-level
// POST라 세션 쿠키가 SameSite 정책으로 전달되지 않을 수 있어(payupReturn.html 자체도 이 요청으로는 로드되지
// 않고 서버가 바로 302 리다이렉트로 응답), req.session이 아니라 init 시점에 이미 기록해둔
// payments.member_id로 주문 소유자를 확인한다 — 결제 승인 자체는 어차피 PayUp에 실제 transactionId를
// 대조해야 통과되므로 세션 검증 없이도 위변조 방어는 유지된다.
app.post('/payupReturn.html', wrapAsync(async (req, res) => {
  const orderNumber = req.body.orderNumber || req.query.orderNumber;
  const transactionId = req.body.transactionId || req.query.transactionId;
  const amount = req.body.amount || req.query.amount;
  if (!orderNumber || !transactionId || !amount) { res.redirect('/vod.html'); return; }

  const [[payment]] = await getPool().query('SELECT member_id FROM payments WHERE order_number = ?', [orderNumber]);
  if (!payment) { res.redirect('/vod.html'); return; }

  const result = await settlePayment({ orderNumber, transactionId, amount, memberId: payment.member_id });
  res.redirect('/' + result.redirect);
}));

// ── 관리자 결제 관리 (payments 테이블 조회/취소/부분취소/수동승인) ──
app.get('/admin/api/payments', requireAdminApi, wrapAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const offset = (page - 1) * pageSize;
  const status = (req.query.status || '').trim();
  const search = (req.query.search || '').trim();

  const conditions = [];
  const params = [];
  if (status) { conditions.push('p.status = ?'); params.push(status); }
  if (search) {
    conditions.push('(p.order_number LIKE ? OR p.transaction_id LIKE ? OR m.name LIKE ? OR m.username LIKE ? OR p.item_name LIKE ?)');
    params.push(...Array(5).fill(`%${search}%`));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [[{ total }]] = await getPool().query(
    `SELECT COUNT(*) AS total FROM payments p JOIN members m ON m.id = p.member_id ${where}`,
    params
  );
  const [rows] = await getPool().query(
    `SELECT p.id, p.order_number, p.item_name, p.amount, p.status, p.transaction_id,
            p.response_code, p.response_msg, p.created_at, p.approved_at, p.canceled_at,
            m.name AS member_name, m.username AS member_username
     FROM payments p JOIN members m ON m.id = p.member_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  res.json({ total, page, pageSize, rows });
}));

// 전액 취소 — PayUp 취소 API 호출 성공 시에만 DB를 canceled로 갱신한다.
app.post('/admin/api/payments/:id/cancel', requireAdminApi, wrapAsync(async (req, res) => {
  const { reason } = req.body;
  const [[payment]] = await getPool().query('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) { res.status(404).json({ error: '결제 내역을 찾을 수 없습니다.' }); return; }
  if (payment.status !== 'approved') { res.status(400).json({ error: 'approved 상태의 결제만 취소할 수 있습니다.' }); return; }

  const result = await payup.cancelPayment({ transactionId: payment.transaction_id, cancelReason: reason || '관리자 취소' });
  if (!result.ok) { res.status(400).json({ error: result.raw?.message || '결제 취소에 실패했습니다.' }); return; }

  await getPool().query(`UPDATE payments SET status = 'canceled', canceled_at = NOW() WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

// 부분 취소 — VOD 단건 상품이라 강좌 접근권은 유지한 채 일부 금액만 환불할 때 사용(상태는 approved로 유지).
app.post('/admin/api/payments/:id/partial-cancel', requireAdminApi, wrapAsync(async (req, res) => {
  const { cancelAmount, reason } = req.body;
  const amount = parseInt(cancelAmount, 10);
  if (!amount || amount <= 0) { res.status(400).json({ error: '취소 금액을 확인해주세요.' }); return; }

  const [[payment]] = await getPool().query('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) { res.status(404).json({ error: '결제 내역을 찾을 수 없습니다.' }); return; }
  if (payment.status !== 'approved') { res.status(400).json({ error: 'approved 상태의 결제만 부분취소할 수 있습니다.' }); return; }

  const result = await payup.partialCancelPayment({
    transactionId: payment.transaction_id, cancelAmount: amount, cancelReason: reason || '관리자 부분취소'
  });
  if (!result.ok) { res.status(400).json({ error: result.raw?.message || '부분취소에 실패했습니다.' }); return; }

  const data = result.raw?.data || {};
  await getPool().query(
    `UPDATE payments SET response_msg = ? WHERE id = ?`,
    [`부분취소 ${data.cancelAmount || amount}원 (${reason || '관리자 부분취소'})`, req.params.id]
  );
  res.json({ ok: true });
}));

// 수동승인 — PayUp에 거래 조회 API가 없어서(문서에 미제공) 브라우저 라운드트립이 끊겨 pending으로 멈춘 건을
// 자동으로 재확인할 방법이 없다. 관리자가 PayUp 가맹점 콘솔(cp.payup.co.kr)에서 실제 승인 여부를 눈으로 확인한
// 뒤 수동으로 승인 처리하는 예외 경로 — transactionId/사유를 response_msg에 남겨 회계 추적이 되게 한다.
app.post('/admin/api/payments/:id/manual-approve', requireAdminApi, wrapAsync(async (req, res) => {
  const { transactionId, note } = req.body;
  const [[payment]] = await getPool().query('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) { res.status(404).json({ error: '결제 내역을 찾을 수 없습니다.' }); return; }
  if (payment.status === 'approved') { res.status(400).json({ error: '이미 승인된 결제입니다.' }); return; }

  await getPool().query(
    `UPDATE payments SET status = 'approved', transaction_id = COALESCE(?, transaction_id),
     response_msg = ?, approved_at = NOW() WHERE id = ?`,
    [transactionId || null, `관리자 수동승인${note ? `: ${note}` : ''}`, req.params.id]
  );
  await enrollMemberInVod(payment.member_id, payment.vod_course_id, 'payment');
  res.json({ ok: true });
}));

// ── 관리자 쿠폰 관리 (coupons 테이블 발급/조회/회수) ──
// 0/O, 1/I/L처럼 사람이 옮겨 적을 때 헷갈리는 문자는 코드 알파벳에서 아예 뺀다.
const COUPON_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCouponCode() {
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (let i = 0; i < 16; i++) code += COUPON_CODE_CHARS[bytes[i] % COUPON_CODE_CHARS.length];
  return code;
}

app.post('/admin/api/coupons', requireAdminApi, wrapAsync(async (req, res) => {
  const vodCourseId = req.body.vodCourseId ? parseInt(req.body.vodCourseId, 10) : null;
  const discountType = req.body.discountType === 'percent' ? 'percent' : 'fixed';
  const discountValue = parseInt(req.body.discountValue, 10);
  const label = (req.body.label || '').trim() || null;

  if (!discountValue || discountValue <= 0) { res.status(400).json({ error: '할인 값을 입력해주세요.' }); return; }
  if (discountType === 'percent' && discountValue > 100) { res.status(400).json({ error: '할인율은 100을 넘을 수 없습니다.' }); return; }
  if (!label) { res.status(400).json({ error: '쿠폰명을 입력해주세요.' }); return; }

  // 학생 지정 발급: 코드 입력(등록) 단계를 건너뛰고 처음부터 해당 회원에게 귀속시킨다.
  const memberIds = Array.isArray(req.body.memberIds)
    ? [...new Set(req.body.memberIds.map(id => parseInt(id, 10)).filter(Boolean))]
    : null;

  if (memberIds) {
    if (!memberIds.length) { res.status(400).json({ error: '학생을 선택해주세요.' }); return; }
    if (memberIds.length > 200) { res.status(400).json({ error: '한 번에 최대 200명까지 발급할 수 있습니다.' }); return; }

    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [members] = await conn.query(
        `SELECT id, name, username FROM members WHERE id IN (${memberIds.map(() => '?').join(',')})`,
        memberIds
      );
      if (members.length !== memberIds.length) {
        await conn.rollback();
        res.status(400).json({ error: '존재하지 않는 회원이 포함되어 있습니다.' });
        return;
      }

      const issued = [];
      for (const m of members) {
        let code = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = generateCouponCode();
          try {
            await conn.query(
              `INSERT INTO coupons (code, vod_course_id, discount_type, discount_value, label, status, member_id, claimed_at)
               VALUES (?, ?, ?, ?, ?, '등록됨', ?, NOW())`,
              [candidate, vodCourseId, discountType, discountValue, label, m.id]
            );
            code = candidate;
            break;
          } catch (err) {
            if (err.code !== 'ER_DUP_ENTRY' || attempt === 4) throw err;
          }
        }
        issued.push({ memberId: m.id, name: m.name, username: m.username, code });
      }
      await conn.commit();
      res.json({ ok: true, issued });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return;
  }

  const quantity = Math.min(50, Math.max(1, parseInt(req.body.quantity, 10) || 1));
  const codes = [];
  for (let i = 0; i < quantity; i++) {
    // 코드 유일성은 UNIQUE 제약이 최종 보장 — 극히 낮은 확률의 충돌만 재시도로 흡수한다.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCouponCode();
      try {
        await getPool().query(
          `INSERT INTO coupons (code, vod_course_id, discount_type, discount_value, label) VALUES (?, ?, ?, ?, ?)`,
          [code, vodCourseId, discountType, discountValue, label]
        );
        codes.push(code);
        break;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY' || attempt === 4) throw err;
      }
    }
  }
  res.json({ ok: true, codes });
}));

app.get('/admin/api/coupons', requireAdminApi, wrapAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const offset = (page - 1) * pageSize;
  const status = (req.query.status || '').trim();
  const search = (req.query.search || '').trim();

  const conditions = [];
  const params = [];
  if (status) { conditions.push('c.status = ?'); params.push(status); }
  if (search) {
    conditions.push('(c.code LIKE ? OR c.label LIKE ? OR m.name LIKE ? OR m.username LIKE ? OR v.title LIKE ?)');
    params.push(...Array(5).fill(`%${search}%`));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [[{ total }]] = await getPool().query(
    `SELECT COUNT(*) AS total FROM coupons c
     LEFT JOIN members m ON m.id = c.member_id
     LEFT JOIN vod_courses v ON v.id = c.vod_course_id
     ${where}`,
    params
  );

  const [rows] = await getPool().query(
    `SELECT c.id, c.code, c.discount_type, c.discount_value, c.label, c.status,
            c.claimed_at, c.used_at, c.created_at,
            v.title AS vod_course_title,
            m.name AS member_name, m.username AS member_username
     FROM coupons c
     LEFT JOIN members m ON m.id = c.member_id
     LEFT JOIN vod_courses v ON v.id = c.vod_course_id
     ${where}
     ORDER BY c.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  res.json({ total, page, pageSize, rows });
}));

app.delete('/admin/api/coupons/:id', requireAdminApi, wrapAsync(async (req, res) => {
  // 이미 학생이 등록했거나 사용한 쿠폰은 회수하지 않는다(아직 아무도 안 쓴 코드만 삭제 가능).
  const [result] = await getPool().query(`DELETE FROM coupons WHERE id = ? AND status = '미등록'`, [req.params.id]);
  if (result.affectedRows === 0) { res.status(409).json({ error: '이미 등록되었거나 사용된 쿠폰은 삭제할 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── 쿠폰 발급 템플릿 (반복되는 발급 조합을 이름 붙여 저장/재사용) ──
app.get('/admin/api/coupon-templates', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT t.id, t.name, t.vod_course_id, t.discount_type, t.discount_value, t.label,
            v.title AS vod_course_title
     FROM coupon_templates t
     LEFT JOIN vod_courses v ON v.id = t.vod_course_id
     ORDER BY t.created_at DESC`
  );
  res.json({ rows });
}));

app.post('/admin/api/coupon-templates', requireAdminApi, wrapAsync(async (req, res) => {
  const name = (req.body.name || '').trim();
  const vodCourseId = req.body.vodCourseId ? parseInt(req.body.vodCourseId, 10) : null;
  const discountType = req.body.discountType === 'percent' ? 'percent' : 'fixed';
  const discountValue = parseInt(req.body.discountValue, 10);
  const label = (req.body.label || '').trim() || null;

  if (!name) { res.status(400).json({ error: '템플릿 이름을 입력해주세요.' }); return; }
  if (!discountValue || discountValue <= 0) { res.status(400).json({ error: '할인 값을 입력해주세요.' }); return; }
  if (discountType === 'percent' && discountValue > 100) { res.status(400).json({ error: '할인율은 100을 넘을 수 없습니다.' }); return; }

  const [result] = await getPool().query(
    `INSERT INTO coupon_templates (name, vod_course_id, discount_type, discount_value, label) VALUES (?, ?, ?, ?, ?)`,
    [name, vodCourseId, discountType, discountValue, label]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.delete('/admin/api/coupon-templates/:id', requireAdminApi, wrapAsync(async (req, res) => {
  await getPool().query(`DELETE FROM coupon_templates WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/admin/api/members/:id/vod-enrollments', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT e.id, e.vod_course_id, e.status, e.progress_note, e.source, e.enrolled_at, e.expires_at,
            c.title AS name, c.ends_at, c.access_days,
            -- 화면에 보여줄 만료일. 보통은 등록 시점에 박아둔 스냅샷(expires_at)이지만,
            -- 강좌에 수강기간(access_days)이 설정되기 전에 등록된 행은 스냅샷이 NULL이라
            -- 강좌의 현재 수강기간을 등록일에 적용해 계산해서 보여준다.
            COALESCE(e.expires_at,
                     CASE WHEN c.access_days > 0 THEN DATE_ADD(e.enrolled_at, INTERVAL c.access_days DAY) END
            ) AS effective_expires_at,
            (e.expires_at IS NULL AND c.access_days > 0) AS expiry_is_derived,
            (e.expires_at IS NOT NULL AND e.expires_at <= NOW()) AS is_expired,
            (c.ends_at IS NOT NULL AND c.ends_at < CURDATE()) AS is_ended
     FROM member_vod_enrollments e
     JOIN vod_courses c ON c.id = e.vod_course_id
     WHERE e.member_id = ?
     ORDER BY e.enrolled_at DESC`,
    [req.params.id]
  );
  // 재생 기록으로 자동 집계된 진도율(progress_note는 관리자 수기 메모라 별개 값이다)
  const progressMap = await computeVodCourseProgress(req.params.id, rows.map(r => r.vod_course_id));
  res.json(rows.map(r => ({
    ...r,
    ends_at: toDateOnly(r.ends_at),
    progress_percent: progressMap[r.vod_course_id]?.percent ?? 0,
    completed_lectures: progressMap[r.vod_course_id]?.completedLectures ?? 0,
    total_lectures: progressMap[r.vod_course_id]?.totalLectures ?? 0
  })));
}));

// 회원의 강의별 수강현황 — 관리자 모달에서 강좌 행을 펼쳤을 때 조회한다.
app.get('/admin/api/members/:id/lecture-progress/:vodCourseId', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT l.id AS lectureId, l.lecture_number, l.title, v.duration_seconds,
            p.last_position_seconds, p.watched_seconds, p.completed, p.last_played_at
     FROM vod_course_lectures l
     LEFT JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     LEFT JOIN member_lecture_progress p ON p.vod_course_lecture_id = l.id AND p.member_id = ?
     WHERE l.vod_course_id = ?
     ORDER BY l.sort_order, l.lecture_number`,
    [req.params.id, req.params.vodCourseId]
  );
  res.json(rows.map(r => ({
    lectureId: r.lectureId,
    lectureNumber: r.lecture_number,
    title: r.title,
    durationSeconds: r.duration_seconds,
    watchedSeconds: r.watched_seconds || 0,
    position: r.last_position_seconds || 0,
    percent: r.duration_seconds ? Math.min(100, Math.round(((r.watched_seconds || 0) / r.duration_seconds) * 100)) : null,
    completed: !!r.completed,
    lastPlayedAt: r.last_played_at
  })));
}));

app.post('/admin/api/members/:id/vod-enrollments', requireAdminApi, wrapAsync(async (req, res) => {
  const { vodCourseId, status, progressNote } = req.body;
  if (!vodCourseId) {
    res.status(400).json({ error: 'vodCourseId가 필요합니다.' });
    return;
  }
  await enrollMemberInVod(req.params.id, vodCourseId, 'admin', { status, progressNote });
  res.json({ ok: true });
}));

app.put('/admin/api/members/:id/vod-enrollments/:enrollmentId', requireAdminApi, wrapAsync(async (req, res) => {
  const { status, progressNote, expiresAt } = req.body;
  const fields = [];
  const values = [];
  if (status !== undefined) { fields.push('status = ?'); values.push(status === '완료' ? '완료' : '진행중'); }
  if (progressNote !== undefined) { fields.push('progress_note = ?'); values.push(progressNote || null); }
  // 수강기간 연장/해제 (고객 응대용). 빈 값으로 저장하면 무제한.
  if (expiresAt !== undefined) {
    const date = String(expiresAt || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: '수강 만료일은 YYYY-MM-DD 형식이어야 합니다.' });
      return;
    }
    fields.push('expires_at = ?');
    values.push(date ? `${date} 23:59:59` : null);
  }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }
  values.push(req.params.enrollmentId, req.params.id);
  const [result] = await getPool().query(
    `UPDATE member_vod_enrollments SET ${fields.join(', ')} WHERE id = ? AND member_id = ?`,
    values
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '등록 정보를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

app.delete('/admin/api/members/:id/vod-enrollments/:enrollmentId', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    'DELETE FROM member_vod_enrollments WHERE id = ? AND member_id = ?',
    [req.params.enrollmentId, req.params.id]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '등록 정보를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

const USERNAME_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,16}$/;

function parseDeviceLabel(userAgent) {
  const ua = userAgent || '';
  let os = '기타 OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Macintosh/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '기타 브라우저';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return `${os} · ${browser}`;
}

// 기기당 1행을 upsert하고, 신규 기기인데 이미 정원(MAX_DEVICES_PER_MEMBER)이 찼으면 로그인을 거부한다.
async function registerMemberDevice(memberId, deviceId, req) {
  if (!deviceId) return { ok: true };
  const pool = getPool();
  const userAgent = req.headers['user-agent'] || '';
  const label = parseDeviceLabel(userAgent);

  const [existing] = await pool.query(
    'SELECT id FROM member_devices WHERE member_id = ? AND device_id = ?',
    [memberId, deviceId]
  );
  if (existing[0]) {
    await pool.query(
      'UPDATE member_devices SET device_label = ?, user_agent = ?, ip_address = ?, session_id = ?, last_login_at = NOW() WHERE id = ?',
      [label, userAgent, req.ip, req.sessionID, existing[0].id]
    );
    return { ok: true };
  }

  const [[{ cnt }]] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM member_devices WHERE member_id = ?',
    [memberId]
  );
  if (cnt >= MAX_DEVICES_PER_MEMBER) {
    return {
      ok: false,
      error: `최대 ${MAX_DEVICES_PER_MEMBER}개의 기기까지만 로그인할 수 있습니다. 마이페이지 > 기기 관리에서 기존 기기를 삭제한 후 다시 시도해주세요.`
    };
  }

  await pool.query(
    'INSERT INTO member_devices (member_id, device_id, device_label, user_agent, ip_address, session_id, last_login_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
    [memberId, deviceId, label, userAgent, req.ip, req.sessionID]
  );
  return { ok: true };
}

app.post('/api/members/check-username', async (req, res) => {
  const { username } = req.body;
  if (!username || !USERNAME_RE.test(username)) {
    res.status(400).json({ error: '올바른 이메일 형식을 입력해주세요.' });
    return;
  }
  const [rows] = await getPool().query('SELECT id FROM members WHERE username = ?', [username]);
  res.json({ available: rows.length === 0 });
});

app.post('/api/members/signup', async (req, res) => {
  const {
    username, password, email, name, birthDate, phone, mobile,
    postalCode, roadAddress, detailAddress,
    signupChannel, searchKeyword, referrerCode, emailConsent, smsConsent,
    deviceId, keepLoggedIn
  } = req.body;

  if (!username || !password || !email || !name || !postalCode || !roadAddress || !detailAddress) {
    res.status(400).json({ error: '필수 항목을 모두 입력해주세요.' });
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: '올바른 이메일 형식을 입력해주세요.' });
    return;
  }
  if (!PASSWORD_RE.test(password)) {
    res.status(400).json({ error: '비밀번호는 영문자, 숫자, 특수문자를 모두 포함한 8~16자여야 합니다.' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const channelStr = Array.isArray(signupChannel) ? signupChannel.join(', ') : (signupChannel || null);

  try {
    const [result] = await getPool().query(
      `INSERT INTO members
        (username, password, name, birth_date, member_group, phone, mobile, email, postal_code, road_address, detail_address, signup_channel, search_keyword, referrer_code, email_marketing_consent, sms_marketing_consent, joined_at)
       VALUES (?, ?, ?, ?, '1001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        username, passwordHash, name, birthDate || null, phone || null, mobile || null, email,
        postalCode, roadAddress, detailAddress,
        channelStr, searchKeyword || null, referrerCode || null,
        emailConsent === '1' ? '허용' : '거부',
        smsConsent === '1' ? '허용' : '거부'
      ]
    );
    await registerMemberDevice(result.insertId, deviceId, req);
    req.session.memberId = result.insertId;
    req.session.memberName = name;
    req.session.deviceId = deviceId || null;
    if (keepLoggedIn) req.session.cookie.maxAge = KEEP_LOGGED_IN_MAX_AGE;
    res.json({ ok: true, name });

    sendEmail({
      to: email,
      subject: '[독편사편입논술학원] 회원가입이 완료되었습니다',
      html: `<p>${name}님, 안녕하세요.</p><p>독편사편입논술학원(dockteacher.co.kr) 회원가입이 완료되었습니다.</p><p>아이디: ${username}</p>`
    }).catch(err => console.error('가입 확인 메일 발송 실패:', err));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
      return;
    }
    throw err;
  }
});

app.post('/api/members/login', async (req, res) => {
  const { username, password, deviceId, keepLoggedIn } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
    return;
  }
  const [rows] = await getPool().query('SELECT id, name, password FROM members WHERE username = ?', [username]);
  const member = rows[0];
  if (!member || !member.password || !(await bcrypt.compare(password, member.password))) {
    res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    return;
  }

  const deviceResult = await registerMemberDevice(member.id, deviceId, req);
  if (!deviceResult.ok) {
    res.status(403).json({ error: deviceResult.error });
    return;
  }

  req.session.memberId = member.id;
  req.session.memberName = member.name;
  req.session.deviceId = deviceId || null;
  if (keepLoggedIn) req.session.cookie.maxAge = KEEP_LOGGED_IN_MAX_AGE;
  res.json({ ok: true, name: member.name });
});

app.post('/api/members/forgot-password', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    res.status(400).json({ error: '아이디를 입력해주세요.' });
    return;
  }

  const [rows] = await getPool().query('SELECT id, email FROM members WHERE username = ?', [username]);
  const member = rows[0];
  if (member && member.email) {
    const token = crypto.randomBytes(32).toString('hex');
    await getPool().query(
      'UPDATE members SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id = ?',
      [token, member.id]
    );
    const resetUrl = `${process.env.SITE_URL || 'https://dockteacher.co.kr'}/?resetToken=${token}`;
    sendEmail({
      to: member.email,
      subject: '[독편사편입논술학원] 비밀번호 재설정 안내',
      html: `<p>비밀번호 재설정을 요청하셨습니다.</p><p>아래 링크는 30분간 유효합니다.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>본인이 요청하지 않았다면 이 메일을 무시해주세요.</p>`
    }).catch(err => console.error('비밀번호 재설정 메일 발송 실패:', err));
  }

  // 계정 존재 여부가 노출되지 않도록 항상 동일한 응답을 반환한다.
  res.json({ ok: true });
});

app.post('/api/members/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    res.status(400).json({ error: '토큰과 새 비밀번호를 입력해주세요.' });
    return;
  }
  if (!PASSWORD_RE.test(newPassword)) {
    res.status(400).json({ error: '비밀번호는 영문자, 숫자, 특수문자를 모두 포함한 8~16자여야 합니다.' });
    return;
  }

  const [rows] = await getPool().query(
    'SELECT id FROM members WHERE reset_token = ? AND reset_token_expires > NOW()',
    [token]
  );
  const member = rows[0];
  if (!member) {
    res.status(400).json({ error: '링크가 유효하지 않거나 만료되었습니다. 비밀번호 재설정을 다시 요청해주세요.' });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await getPool().query(
    'UPDATE members SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
    [passwordHash, member.id]
  );
  res.json({ ok: true });
});

app.post('/api/members/logout', (req, res) => {
  delete req.session.memberId;
  delete req.session.memberName;
  delete req.session.deviceId;
  res.json({ ok: true });
});

app.get('/api/members/me', (req, res) => {
  if (req.session.memberId) {
    res.json({ loggedIn: true, name: req.session.memberName });
  } else {
    res.json({ loggedIn: false });
  }
});

// ── /api/v1 — 네이티브 앱(일렉트론/RN) 전용, Bearer 토큰 인증. 웹 세션과 완전히 분리 ──

app.post('/api/v1/auth/login', wrapAsync(async (req, res) => {
  const { username, password, deviceId, platform } = req.body;
  if (!username || !password || !deviceId || !platform) {
    res.status(400).json({ error: 'username, password, deviceId, platform이 모두 필요합니다.' });
    return;
  }
  if (!['electron', 'ios', 'android'].includes(platform)) {
    res.status(400).json({ error: 'platform은 electron/ios/android 중 하나여야 합니다.' });
    return;
  }

  const [rows] = await getPool().query('SELECT id, name, password FROM members WHERE username = ?', [username]);
  const member = rows[0];
  if (!member || !member.password || !(await bcrypt.compare(password, member.password))) {
    res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    return;
  }

  // 기기 3대 cap은 웹 로그인과 같은 풀을 공유한다 (registerMemberDevice 재사용)
  const deviceResult = await registerMemberDevice(member.id, deviceId, req);
  if (!deviceResult.ok) {
    res.status(403).json({ error: deviceResult.error });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const [tokenResult] = await getPool().query(
    'INSERT INTO api_tokens (member_id, device_id, token_hash, platform) VALUES (?, ?, ?, ?)',
    [member.id, deviceId, hashApiToken(rawToken), platform]
  );
  await getPool().query(
    'UPDATE member_devices SET token_id = ? WHERE member_id = ? AND device_id = ?',
    [tokenResult.insertId, member.id, deviceId]
  );

  res.json({ token: rawToken, member: { id: member.id, name: member.name } });
}));

app.post('/api/v1/auth/logout', requireApiToken, wrapAsync(async (req, res) => {
  await getPool().query('DELETE FROM member_devices WHERE token_id = ?', [req.apiTokenId]);
  await getPool().query('DELETE FROM api_tokens WHERE id = ?', [req.apiTokenId]);
  res.json({ ok: true });
}));

app.get('/api/v1/me', requireApiToken, wrapAsync(async (req, res) => {
  const [[member]] = await getPool().query('SELECT id, name FROM members WHERE id = ?', [req.memberId]);
  res.json(member);
}));

app.get('/api/v1/courses', requireApiToken, wrapAsync(async (req, res) => {
  const rows = await getMemberVodCourses(req.memberId);
  // 네이티브 앱에는 재생 가능한 강좌만 내려준다 (만료 건 재구매는 웹에서만 가능).
  res.json(rows.filter(c => c.access_state === 'active').map(c => ({
    id: c.id,
    title: c.title,
    thumbnailUrl: c.thumbnail_url,
    status: c.status,
    progressNote: c.progress_note,
    progressPercent: c.progress_percent,
    completedLectures: c.completed_lectures,
    totalLectures: c.total_lectures,
    expiresAt: c.expires_at
  })));
}));

app.get('/api/v1/courses/:id/lectures', requireApiToken, wrapAsync(async (req, res) => {
  const result = await getVodCourseLectures(req.memberId, req.params.id);
  if (result.error) {
    res.status(result.status).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({
    course: result.course,
    lectures: result.lectures.map(l => ({
      id: l.id,
      lectureNumber: l.lecture_number,
      title: l.title,
      contentMarkdown: l.content_markdown,
      hasVideo: !!l.video_r2_key,
      materials: l.materials
    }))
  });
}));

// 재생 직전에만 호출 — 여기서만 실제 서명된 스트림 URL을 발급한다 (목록 조회 시점엔 발급 안 함).
app.get('/api/v1/lectures/:id/playback', requireApiToken, wrapAsync(async (req, res) => {
  const [[lecture]] = await getPool().query(
    'SELECT vod_course_id, video_r2_key FROM vod_course_lectures WHERE id = ?',
    [req.params.id]
  );
  if (!lecture || !lecture.video_r2_key) {
    res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    return;
  }
  const access = await checkVodAccess(req.memberId, lecture.vod_course_id);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error, reason: access.reason });
    return;
  }

  if (isHlsKey(lecture.video_r2_key)) {
    res.json({ kind: 'hls', url: `/api/stream/vod-lecture/${req.params.id}/master.m3u8` });
  } else {
    res.json({ kind: 'mp4', url: buildCdnUrl(lecture.video_r2_key) });
  }
}));

// ── 수강현황(진도) — 웹 플레이어(세션 쿠키)와 데스크톱 앱(Bearer)이 공유하는 라우트 ──
// 클라이언트는 재생 중 주기적으로(기본 25초) + 일시정지·강의전환·이탈 시점에 하트비트를 보낸다.
// 핵심: 보내는 값이 "현재 위치"가 아니라 "직전 전송 이후 실제로 재생된 미디어 시간(delta)"이라
// 서버가 그걸 더한다. 그래서 (1) 전송 주기를 바꿔도 진도율 정확도가 그대로고 (2) 배속 재생이
// 자연히 반영되며 (3) 시크바를 끝까지 드래그해도 delta가 생기지 않아 진도율이 오르지 않는다.
// 이어보기 지점(last_position_seconds)은 별개로 마지막 위치를 그대로 덮어쓴다.
const PROGRESS_COMPLETE_RATIO = 0.9;      // 영상 길이의 90% 이상 재생하면 그 강의를 완료로 본다(엔딩·인사말 감안)
const PROGRESS_MAX_PLAYBACK_RATE = 2;     // 플레이어가 허용하는 최대 배속 — delta 상한 계산용
const PROGRESS_DELTA_GRACE_SECONDS = 90;  // 하트비트 지터 + 첫 전송분 보정 여유
const PROGRESS_MAX_ITEMS = 100;           // 오프라인 큐를 한 번에 flush할 때의 상한

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 강좌 단위 진도율(%) — 길이를 아는 강의만 분모에 넣는다(아직 인코딩 중인 강의는 자연히 빠짐).
async function computeVodCourseProgress(memberId, courseIds) {
  if (!courseIds.length) return {};
  const [rows] = await getPool().query(
    `SELECT l.vod_course_id AS courseId,
            SUM(COALESCE(p.watched_seconds, 0)) AS watched,
            SUM(v.duration_seconds) AS total,
            SUM(COALESCE(p.completed, 0)) AS completedLectures,
            COUNT(*) AS totalLectures
     FROM vod_course_lectures l
     JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key AND v.duration_seconds IS NOT NULL
     LEFT JOIN member_lecture_progress p ON p.vod_course_lecture_id = l.id AND p.member_id = ?
     WHERE l.vod_course_id IN (?)
     GROUP BY l.vod_course_id`,
    [memberId, courseIds]
  );
  const map = {};
  rows.forEach(r => {
    map[r.courseId] = {
      percent: r.total > 0 ? Math.min(100, Math.round((r.watched / r.total) * 100)) : 0,
      completedLectures: Number(r.completedLectures) || 0,
      totalLectures: Number(r.totalLectures) || 0
    };
  });
  return map;
}

app.post('/api/v1/progress', requireMemberOrApiToken, wrapAsync(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || !items.length) {
    res.status(400).json({ error: 'items 배열이 필요합니다.' });
    return;
  }
  if (items.length > PROGRESS_MAX_ITEMS) {
    res.status(400).json({ error: `한 번에 보낼 수 있는 항목은 ${PROGRESS_MAX_ITEMS}개까지입니다.` });
    return;
  }

  // 오프라인 큐를 flush하면 같은 강의 항목이 여러 개 올라온다 — 강의별로 미리 합쳐서
  // 강의당 조회/UPSERT를 1회로 줄인다(delta는 합계, position은 가장 최근 항목의 것).
  const merged = new Map();
  for (const item of items) {
    const lectureId = toFiniteNumber(item?.lectureId);
    const position = toFiniteNumber(item?.position);
    const delta = toFiniteNumber(item?.delta);
    if (!lectureId || lectureId <= 0 || position === null || position < 0 || delta === null || delta < 0) {
      res.status(400).json({ error: 'lectureId/position/delta 형식이 올바르지 않습니다.' });
      return;
    }
    const at = toFiniteNumber(item?.at) ?? Date.now();
    const prev = merged.get(lectureId);
    if (!prev) {
      merged.set(lectureId, { lectureId, position, delta, at, firstAt: at });
    } else {
      prev.delta += delta;
      prev.firstAt = Math.min(prev.firstAt, at);
      if (at >= prev.at) { prev.position = position; prev.at = at; }
    }
  }

  const lectureIds = [...merged.keys()];
  const [lectureRows] = await getPool().query(
    `SELECT l.id, l.vod_course_id, v.duration_seconds
     FROM vod_course_lectures l
     LEFT JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     WHERE l.id IN (?)`,
    [lectureIds]
  );
  const lectureById = new Map(lectureRows.map(l => [l.id, l]));

  // 강좌 단위로 한 번씩만 수강권한을 확인한다(같은 강좌의 강의가 여러 개 올라오는 게 보통).
  const accessByCourse = new Map();
  for (const l of lectureRows) {
    if (!accessByCourse.has(l.vod_course_id)) {
      accessByCourse.set(l.vod_course_id, await checkVodAccess(req.memberId, l.vod_course_id));
    }
  }

  // 경과 시간은 반드시 SQL에서 구한다 — last_played_at은 타임존 없는 DATETIME이라
  // Node의 Date.now()와 빼면 앱 서버와 DB 서버의 타임존 차이(로컬 KST ↔ DB UTC = 9시간)가
  // 그대로 경과시간으로 잡혀 아래 delta 클램프가 통째로 무력화된다.
  const [existingRows] = await getPool().query(
    `SELECT vod_course_lecture_id, watched_seconds, completed,
            TIMESTAMPDIFF(SECOND, last_played_at, NOW()) AS elapsed_seconds
     FROM member_lecture_progress WHERE member_id = ? AND vod_course_lecture_id IN (?)`,
    [req.memberId, lectureIds]
  );
  const existingById = new Map(existingRows.map(r => [r.vod_course_lecture_id, r]));

  const saved = [];
  for (const item of merged.values()) {
    const lecture = lectureById.get(item.lectureId);
    if (!lecture) continue;                                   // 없는 강의 id는 조용히 건너뛴다(배치 전체를 실패시키지 않음)
    if (!accessByCourse.get(lecture.vod_course_id)?.ok) continue; // 수강 중이 아닌 강좌 → 기록하지 않음
    const existing = existingById.get(item.lectureId);
    const duration = lecture.duration_seconds || 0;

    // delta 상한 = (기준 시점 이후 실제로 흐른 시간) × 최대 배속 + 여유.
    // 기준 시점은 이미 기록이 있으면 서버가 찍어둔 last_played_at(클라이언트 시계는 믿지 않는다),
    // 첫 기록이면 이 배치 항목들이 걸쳐 있는 구간 — 오프라인 큐를 모아 보낸 경우 그만큼 허용된다.
    const referenceElapsed = existing
      ? existing.elapsed_seconds
      : (item.at - item.firstAt) / 1000;
    const allowedDelta = Math.max(0, referenceElapsed) * PROGRESS_MAX_PLAYBACK_RATE + PROGRESS_DELTA_GRACE_SECONDS;

    const delta = Math.min(item.delta, allowedDelta);
    let watched = (existing?.watched_seconds || 0) + delta;
    if (duration) watched = Math.min(watched, duration);
    watched = Math.round(watched);
    const position = Math.round(duration ? Math.min(item.position, duration) : item.position);
    const completed = duration ? watched >= duration * PROGRESS_COMPLETE_RATIO : !!existing?.completed;

    // 같은 강의를 두 기기에서 동시에 보면 position은 나중에 쓴 쪽이 이긴다(watched_seconds는 누적이라 무관).
    await getPool().query(
      `INSERT INTO member_lecture_progress
         (member_id, vod_course_lecture_id, vod_course_id, last_position_seconds, watched_seconds, completed, last_played_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         last_position_seconds = VALUES(last_position_seconds),
         watched_seconds = VALUES(watched_seconds),
         completed = VALUES(completed),
         last_played_at = NOW()`,
      [req.memberId, item.lectureId, lecture.vod_course_id, position, watched, completed ? 1 : 0]
    );

    saved.push({
      lectureId: item.lectureId,
      position,
      watchedSeconds: watched,
      durationSeconds: duration || null,
      percent: duration ? Math.min(100, Math.round((watched / duration) * 100)) : null,
      completed
    });
  }

  res.json({ ok: true, progress: saved });
}));

// 강좌의 강의별 진도 + 강좌 집계. 플레이어가 목록을 그릴 때와 이어보기 지점을 잡을 때 호출한다.
app.get('/api/v1/courses/:id/progress', requireMemberOrApiToken, wrapAsync(async (req, res) => {
  const access = await checkVodAccess(req.memberId, req.params.id);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error, reason: access.reason });
    return;
  }
  const [rows] = await getPool().query(
    `SELECT l.id AS lectureId, v.duration_seconds,
            p.last_position_seconds, p.watched_seconds, p.completed, p.last_played_at
     FROM vod_course_lectures l
     LEFT JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     LEFT JOIN member_lecture_progress p ON p.vod_course_lecture_id = l.id AND p.member_id = ?
     WHERE l.vod_course_id = ?
     ORDER BY l.sort_order, l.lecture_number`,
    [req.memberId, req.params.id]
  );

  let watchedTotal = 0, durationTotal = 0, lastLectureId = null, lastPlayedAt = null;
  const lectures = rows.map(r => {
    const duration = r.duration_seconds || 0;
    const watched = r.watched_seconds || 0;
    if (duration) { durationTotal += duration; watchedTotal += Math.min(watched, duration); }
    if (r.last_played_at && (!lastPlayedAt || r.last_played_at > lastPlayedAt)) {
      lastPlayedAt = r.last_played_at;
      lastLectureId = r.lectureId;
    }
    return {
      lectureId: r.lectureId,
      position: r.last_position_seconds || 0,
      watchedSeconds: watched,
      durationSeconds: duration || null,
      percent: duration ? Math.min(100, Math.round((watched / duration) * 100)) : null,
      completed: !!r.completed
    };
  });

  res.json({
    lectures,
    course: {
      percent: durationTotal > 0 ? Math.min(100, Math.round((watchedTotal / durationTotal) * 100)) : 0,
      completedLectures: lectures.filter(l => l.completed).length,
      totalLectures: lectures.length,
      // 이어보기 진입점 — 마지막으로 재생한 강의
      lastLectureId
    }
  });
}));

app.get('/api/members/my-info', requireMember, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT username, name, email, phone, mobile, postal_code, road_address, detail_address FROM members WHERE id = ?',
    [req.session.memberId]
  );
  if (!rows[0]) {
    res.status(404).json({ error: '회원 정보를 찾을 수 없습니다.' });
    return;
  }
  res.json(rows[0]);
}));

app.put('/api/members/address', requireMember, wrapAsync(async (req, res) => {
  const { postalCode, roadAddress, detailAddress } = req.body;
  if (!postalCode || !roadAddress || !detailAddress) {
    res.status(400).json({ error: '주소를 모두 입력해주세요.' });
    return;
  }
  await getPool().query(
    'UPDATE members SET postal_code = ?, road_address = ?, detail_address = ? WHERE id = ?',
    [postalCode, roadAddress, detailAddress, req.session.memberId]
  );
  res.json({ ok: true });
}));

app.post('/api/members/change-password', requireMember, wrapAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 입력해주세요.' });
    return;
  }
  if (!PASSWORD_RE.test(newPassword)) {
    res.status(400).json({ error: '비밀번호는 영문자, 숫자, 특수문자를 모두 포함한 8~16자여야 합니다.' });
    return;
  }

  const [rows] = await getPool().query('SELECT password FROM members WHERE id = ?', [req.session.memberId]);
  const member = rows[0];
  if (!member || !member.password || !(await bcrypt.compare(currentPassword, member.password))) {
    res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await getPool().query('UPDATE members SET password = ? WHERE id = ?', [passwordHash, req.session.memberId]);
  res.json({ ok: true });
}));

app.get('/api/members/my-lectures', requireMember, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT e.id, e.status, e.progress_note,
            c.id AS class_id, c.name, c.thumb_title, c.thumb_subject, c.thumb_gradient, c.category, c.detail_page
     FROM member_class_enrollments e
     JOIN classes c ON c.id = e.class_id
     WHERE e.member_id = ?
     ORDER BY e.enrolled_at DESC`,
    [req.session.memberId]
  );
  res.json(rows);
}));

// 로그인한 회원이 실제로 그 클래스를 수강 중일 때만 강의 목록(영상+자료 URL)을 내려준다.
app.get('/api/members/my-lectures/:classId', requireMember, wrapAsync(async (req, res) => {
  const [enrollRows] = await getPool().query(
    'SELECT id FROM member_class_enrollments WHERE member_id = ? AND class_id = ?',
    [req.session.memberId, req.params.classId]
  );
  if (!enrollRows[0]) {
    res.status(403).json({ error: '수강 중인 클래스가 아닙니다.' });
    return;
  }

  const [classRows] = await getPool().query('SELECT id, name FROM classes WHERE id = ?', [req.params.classId]);
  if (!classRows[0]) {
    res.status(404).json({ error: '클래스를 찾을 수 없습니다.' });
    return;
  }

  const [lectures] = await getPool().query(
    'SELECT id, lecture_number, title, video_r2_key FROM class_lectures WHERE class_id = ? ORDER BY sort_order, lecture_number',
    [req.params.classId]
  );
  const [materials] = await getPool().query(
    `SELECT m.class_lecture_id, m.title, m.file_r2_key
     FROM class_lecture_materials m
     JOIN class_lectures cl ON cl.id = m.class_lecture_id
     WHERE cl.class_id = ?
     ORDER BY m.sort_order`,
    [req.params.classId]
  );

  const materialsByLecture = {};
  materials.forEach(m => {
    (materialsByLecture[m.class_lecture_id] ||= []).push({
      title: m.title,
      url: buildCdnUrl(m.file_r2_key)
    });
  });

  res.json({
    class: classRows[0],
    lectures: lectures.map(l => ({
      id: l.id,
      lectureNumber: l.lecture_number,
      title: l.title,
      videoUrl: isHlsKey(l.video_r2_key) ? `/api/stream/class-lecture/${l.id}/master.m3u8` : buildCdnUrl(l.video_r2_key),
      materials: materialsByLecture[l.id] || []
    }))
  });
}));

// 회원이 수강 중인 VOD 강좌 목록 — 웹(/api/members/my-vod-courses)과 신규 /api/v1/courses가 공유.
// access_state: 'active'(수강 가능) | 'expired'(수강기간 만료 — 재구매하면 다시 볼 수 있음).
// 강좌 자체가 종료된 건은 재구매 경로도 없으므로 목록에서 아예 제외한다.
async function getMemberVodCourses(memberId) {
  const [rows] = await getPool().query(
    `SELECT c.id, c.tag, c.category_label, c.title, c.description, c.meta_text,
            c.is_best, c.color_variant, c.old_price, c.new_price, c.thumbnail_url,
            e.status, e.progress_note, e.expires_at, c.ends_at,
            (e.expires_at IS NOT NULL AND e.expires_at <= NOW()) AS is_expired,
            (c.ends_at IS NOT NULL AND c.ends_at < CURDATE()) AS is_ended
     FROM member_vod_enrollments e
     JOIN vod_courses c ON c.id = e.vod_course_id
     WHERE e.member_id = ?
     ORDER BY e.enrolled_at DESC`,
    [memberId]
  );
  const visible = rows.filter(r => !r.is_ended);
  const progressMap = await computeVodCourseProgress(memberId, visible.map(r => r.id));
  return visible.map(({ is_expired, is_ended, ...r }) => ({
    ...r,
    ends_at: toDateOnly(r.ends_at),
    access_state: is_expired ? 'expired' : 'active',
    // 자동 집계 진도율. progress_note(관리자 수기 메모)와는 별개 값이다.
    progress_percent: progressMap[r.id]?.percent ?? 0,
    completed_lectures: progressMap[r.id]?.completedLectures ?? 0,
    total_lectures: progressMap[r.id]?.totalLectures ?? 0
  }));
}

// 실제로 그 회원이 수강 중인 강좌일 때만 강의 목록(원본 video_r2_key 포함)을 반환한다.
// 응답 모양(video_url 노출 여부 등)은 호출부(웹 라우트 vs /api/v1)가 각자 조립한다.
// 반환: { error, status } 실패 시, 또는 { course, lectures } 성공 시 — lectures[i]는
// { id, lecture_number, title, content_markdown, video_r2_key, materials } 원본 필드 그대로.
async function getVodCourseLectures(memberId, vodCourseId) {
  const access = await checkVodAccess(memberId, vodCourseId);
  if (!access.ok) return { error: access.error, status: access.status, reason: access.reason };

  const [courseRows] = await getPool().query('SELECT id, title FROM vod_courses WHERE id = ?', [vodCourseId]);
  if (!courseRows[0]) return { error: '강좌를 찾을 수 없습니다.', status: 404 };

  const [lectures] = await getPool().query(
    'SELECT id, lecture_number, title, video_r2_key, content_markdown FROM vod_course_lectures WHERE vod_course_id = ? ORDER BY sort_order, lecture_number',
    [vodCourseId]
  );
  const [materials] = await getPool().query(
    `SELECT m.vod_course_lecture_id, m.title, m.file_url
     FROM vod_course_lecture_materials m
     JOIN vod_course_lectures l ON l.id = m.vod_course_lecture_id
     WHERE l.vod_course_id = ?
     ORDER BY m.sort_order, m.id`,
    [vodCourseId]
  );
  const materialsByLecture = {};
  materials.forEach(m => {
    (materialsByLecture[m.vod_course_lecture_id] ||= []).push({ title: m.title, url: m.file_url });
  });

  return {
    course: courseRows[0],
    lectures: lectures.map(l => ({ ...l, materials: materialsByLecture[l.id] || [] }))
  };
}

app.get('/api/members/my-vod-courses', requireMember, wrapAsync(async (req, res) => {
  res.json(await getMemberVodCourses(req.session.memberId));
}));

// 로그인한 회원이 실제로 그 VOD 강좌를 수강 중일 때만 강의 목록(영상+콘텐츠)을 내려준다.
app.get('/api/members/my-vod-lectures/:vodCourseId', requireMember, wrapAsync(async (req, res) => {
  const result = await getVodCourseLectures(req.session.memberId, req.params.vodCourseId);
  if (result.error) {
    res.status(result.status).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({
    course: result.course,
    lectures: result.lectures.map(({ video_r2_key, ...l }) => ({
      ...l,
      video_url: !video_r2_key ? null
        : isHlsKey(video_r2_key) ? `/api/stream/vod-lecture/${l.id}/master.m3u8`
        : buildCdnUrl(video_r2_key)
    }))
  });
}));

app.get('/api/members/devices', requireMember, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT id, device_id, device_label, ip_address, last_login_at FROM member_devices WHERE member_id = ? ORDER BY last_login_at DESC',
    [req.session.memberId]
  );
  res.json(rows.map(r => ({
    id: r.id,
    label: r.device_label,
    ip: r.ip_address,
    lastLoginAt: r.last_login_at,
    isCurrent: r.device_id === req.session.deviceId
  })));
}));

app.delete('/api/members/devices/:id', requireMember, wrapAsync(async (req, res) => {
  const [[device]] = await getPool().query(
    'SELECT device_id FROM member_devices WHERE id = ? AND member_id = ?',
    [req.params.id, req.session.memberId]
  );
  if (!device) {
    res.status(404).json({ error: '기기를 찾을 수 없습니다.' });
    return;
  }
  // 네이티브 앱 로그인으로 만들어진 기기라면 api_tokens도 같이 지워서 즉시 무효화한다.
  await getPool().query(
    'DELETE FROM api_tokens WHERE member_id = ? AND device_id = ?',
    [req.session.memberId, device.device_id]
  );
  await getPool().query('DELETE FROM member_devices WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ── 마이페이지 쿠폰 — 관리자가 발급한 16자리 코드를 입력해 내 계정에 등록하고, 등록된 쿠폰 목록을 본다 ──
app.get('/api/members/coupons', requireMember, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT c.id, c.code, c.discount_type, c.discount_value, c.label, c.status, c.claimed_at, c.used_at,
            v.title AS vod_course_title
     FROM coupons c
     LEFT JOIN vod_courses v ON v.id = c.vod_course_id
     WHERE c.member_id = ?
     ORDER BY c.claimed_at DESC`,
    [req.session.memberId]
  );
  res.json(rows.map(r => ({
    id: r.id,
    code: r.code,
    label: couponDisplayLabel(r),
    courseTitle: r.vod_course_title || null,
    status: r.status,
    claimedAt: r.claimed_at,
    usedAt: r.used_at
  })));
}));

// 코드 존재 여부와 상태를 먼저 확인해 구분되는 에러 메시지를 주되, 실제 귀속은 UPDATE의 status='미등록'
// 조건 하나로 원자적으로 처리한다 — 동시에 같은 코드를 등록 시도해도 affectedRows로 승자만 가려진다.
app.post('/api/members/coupons/claim', requireMember, wrapAsync(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) { res.status(400).json({ error: '쿠폰 코드를 입력해주세요.' }); return; }

  const [[coupon]] = await getPool().query('SELECT id, status FROM coupons WHERE code = ?', [code]);
  if (!coupon) { res.status(404).json({ error: '존재하지 않는 쿠폰 코드입니다.' }); return; }
  if (coupon.status !== '미등록') { res.status(409).json({ error: '이미 등록되었거나 사용된 쿠폰입니다.' }); return; }

  const [result] = await getPool().query(
    `UPDATE coupons SET status = '등록됨', member_id = ?, claimed_at = NOW() WHERE id = ? AND status = '미등록'`,
    [req.session.memberId, coupon.id]
  );
  if (result.affectedRows === 0) { res.status(409).json({ error: '이미 등록되었거나 사용된 쿠폰입니다.' }); return; }
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════
// 신규 Figma 사이트(public-figma) CMS — site_sections / vod_courses / cert_gallery_images / faq_items
// ══════════════════════════════════════════════════════════════════

const ALLOWED_UPLOAD_SCOPES = [
  'vod-course', 'cert-post', 'notice', 'instructor', 'popup', 'intro', 'content-banner'
];

app.post('/admin/api/site/upload/presign', requireAdminApi, wrapAsync(async (req, res) => {
  const { scope, resourceId, contentType } = req.body;
  if (!ALLOWED_UPLOAD_SCOPES.includes(scope)) {
    res.status(400).json({ error: `scope는 ${ALLOWED_UPLOAD_SCOPES.join(', ')} 중 하나여야 합니다.` });
    return;
  }
  if (!contentType || !contentType.startsWith('image/')) {
    res.status(400).json({ error: 'contentType이 이미지 형식이어야 합니다.' });
    return;
  }
  const ext = contentType.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'jpg';
  const safeResourceId = resourceId ? String(resourceId).replace(/[^\w-]/g, '') : String(Date.now());
  const key = `site/${scope}/${safeResourceId}/${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await r2.presignPutObject(key, contentType);
  res.json({ key, uploadUrl, url: `/uploads/${key}` });
}));

// ── site_sections: 페이지별 단일 섹션 콘텐츠 (JSON blob) ──
app.get('/api/site/:page', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT section_key, content FROM site_sections WHERE page = ?',
    [req.params.page]
  );
  const result = {};
  for (const row of rows) {
    try { result[row.section_key] = JSON.parse(row.content); } catch { /* 손상된 값은 무시 */ }
  }
  res.json(result);
}));

app.get('/admin/api/site/:page/:section', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT content FROM site_sections WHERE page = ? AND section_key = ?',
    [req.params.page, req.params.section]
  );
  if (!rows[0]) { res.json({}); return; }
  try { res.json(JSON.parse(rows[0].content)); } catch { res.json({}); }
}));

app.put('/admin/api/site/:page/:section', requireAdminApi, wrapAsync(async (req, res) => {
  const content = JSON.stringify(req.body || {});
  await getPool().query(
    `INSERT INTO site_sections (page, section_key, content) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
    [req.params.page, req.params.section, content]
  );
  // VOD 페이지 인트로에 고른 영상은 로그인 없이 열리므로, 저장과 동시에 공개 플래그를 맞춘다
  // (새로 고른 영상 공개 + 직전 영상 자동 잠금). 자세한 규칙은 syncPublicIntroVideo 주석 참고.
  if (req.params.page === 'vod' && req.params.section === 'intro') {
    await syncPublicIntroVideo(req.body?.lectureVideoId);
  }
  res.json({ ok: true });
}));

// ── vod_courses: VOD 강좌 상품 (vod.html/curriculum.html/홈 미리보기 공용 소스) ──
const VOD_COURSE_FIELDS = [
  'category_label', 'title', 'description', 'tags_text',
  'old_price', 'new_price', 'thumbnail_url', 'is_active',
  'total_duration_text', 'difficulty', 'difficulty_visible', 'has_feedback', 'instructor_id',
  'intro_heading', 'intro_paragraph', 'recommended_heading', 'access_days', 'ends_at'
];

function validateVodCourseBody(body) {
  if (!body.title || !String(body.title).trim()) return 'title은 필수 항목입니다.';
  if (!body.new_price || !String(body.new_price).trim()) return 'new_price는 필수 항목입니다.';
  if (body.has_feedback && !['제공', '미제공'].includes(body.has_feedback)) {
    return 'has_feedback는 제공, 미제공 중 하나여야 합니다.';
  }
  return null;
}

function vodCourseValues(body) {
  return VOD_COURSE_FIELDS.map(field => {
    if (field === 'is_active') return body.is_active === false || body.is_active === 0 || body.is_active === '0' ? 0 : 1;
    if (field === 'difficulty_visible') return body.difficulty_visible === false || body.difficulty_visible === 0 || body.difficulty_visible === '0' ? 0 : 1;
    if (field === 'instructor_id') return body.instructor_id ? parseInt(body.instructor_id, 10) || null : null;
    if (field === 'access_days') { const n = parseInt(body.access_days, 10); return Number.isNaN(n) || n <= 0 ? null : n; }
    if (field === 'ends_at') return /^\d{4}-\d{2}-\d{2}$/.test(String(body.ends_at || '').trim()) ? String(body.ends_at).trim() : null;
    if (field === 'intro_heading') return body.intro_heading && String(body.intro_heading).trim() ? String(body.intro_heading).trim() : '클래스에서 배울 수 있는 내용이에요';
    if (field === 'recommended_heading') return body.recommended_heading && String(body.recommended_heading).trim() ? String(body.recommended_heading).trim() : '이런 분들께 추천해요';
    const value = body[field];
    return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
  });
}

// "총 학습시간" 자동 계산 — 워커가 트랜스코딩 완료 시 채우는 lecture_videos.duration_seconds를
// vod_course_lectures.video_r2_key로 조인해 강좌 단위로 합산한다. 영상이 없거나 아직 처리 중인
// 강의는 duration_seconds가 NULL이라 자연히 합산에서 빠진다(부분 합계로라도 표시됨).
async function computeVodCourseDurationSeconds(courseIds) {
  if (!courseIds.length) return {};
  const [rows] = await getPool().query(
    `SELECT l.vod_course_id AS courseId, SUM(v.duration_seconds) AS totalSeconds
     FROM vod_course_lectures l
     JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     WHERE l.vod_course_id IN (?) AND v.duration_seconds IS NOT NULL
     GROUP BY l.vod_course_id`,
    [courseIds]
  );
  const map = {};
  rows.forEach(r => { map[r.courseId] = r.totalSeconds; });
  return map;
}

function formatDurationSeconds(totalSeconds) {
  if (!totalSeconds) return null;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}시간 ${minutes}분`;
  if (hours > 0) return `${hours}시간`;
  return `${minutes}분`;
}

async function computeVodCourseLectureCounts(courseIds) {
  if (!courseIds.length) return {};
  const [rows] = await getPool().query(
    `SELECT vod_course_id AS courseId, COUNT(*) AS cnt
     FROM vod_course_lectures
     WHERE vod_course_id IN (?)
     GROUP BY vod_course_id`,
    [courseIds]
  );
  const map = {};
  rows.forEach(r => { map[r.courseId] = r.cnt; });
  return map;
}

// mysql2는 DATE 컬럼을 "로컬 자정" Date 객체로 돌려주는데, JSON 직렬화(toISOString)에서 UTC로 밀리면서
// KST 기준 2026-12-31이 클라이언트엔 2026-12-30으로 도착한다. 밖으로 나가는 날짜는 항상 'YYYY-MM-DD' 문자열로 고정.
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = n => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

async function withComputedTotalDuration(courses) {
  const courseIds = courses.map(c => c.id);
  const [durationMap, lectureCountMap] = await Promise.all([
    computeVodCourseDurationSeconds(courseIds),
    computeVodCourseLectureCounts(courseIds)
  ]);
  return courses.map(c => ({
    ...c,
    ends_at: toDateOnly(c.ends_at),
    total_duration_text: formatDurationSeconds(durationMap[c.id]) || c.total_duration_text,
    lecture_count: lectureCountMap[c.id] || 0
  }));
}

// 종료일이 지난 강좌는 공개 목록(vod.html/홈/커리큘럼)에서 자동으로 빠진다 —
// 배치 잡으로 is_active를 내리지 않고 조회 시점에 걸러서 ends_at을 단일 진실공급원으로 유지한다.
app.get('/api/vod-courses', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT * FROM vod_courses WHERE is_active = 1 AND (ends_at IS NULL OR ends_at >= CURDATE()) ORDER BY sort_order, id'
  );
  res.json(await withComputedTotalDuration(rows));
}));

// 관리자 목록에는 종료된 강좌도 계속 보여야 하므로(종료일 수정/연장) is_ended 플래그만 실어 보낸다.
app.get('/admin/api/vod-courses', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT *, (ends_at IS NOT NULL AND ends_at < CURDATE()) AS is_ended FROM vod_courses ORDER BY sort_order, id'
  );
  res.json(await withComputedTotalDuration(rows));
}));

async function fetchVodCourseIntroParts(courseId) {
  const [[checklistItems], [tags], [sections], [purchaseHighlights]] = await Promise.all([
    getPool().query('SELECT id, content, sort_order FROM vod_course_checklist_items WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId]),
    getPool().query('SELECT id, label, sort_order FROM vod_course_tags WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId]),
    getPool().query('SELECT id, heading, content, sort_order FROM vod_course_sections WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId]),
    getPool().query('SELECT id, content, sort_order FROM vod_course_purchase_highlights WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId])
  ]);
  return { checklistItems, tags, sections, purchaseHighlights };
}

// 상세는 종료된 강좌도 404로 끊지 않고 is_ended를 실어 내려준다 — 북마크/검색으로 들어온 사용자에게
// 깨진 화면 대신 "종료된 강좌" 안내를 보여주고 구매 버튼만 막기 위해서.
app.get('/api/vod-courses/:id', wrapAsync(async (req, res) => {
  const [[course]] = await getPool().query(
    'SELECT *, (ends_at IS NOT NULL AND ends_at < CURDATE()) AS is_ended FROM vod_courses WHERE id = ? AND is_active = 1',
    [req.params.id]
  );
  if (!course) { res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' }); return; }
  const [introParts, [courseWithDuration]] = await Promise.all([
    fetchVodCourseIntroParts(req.params.id),
    withComputedTotalDuration([course])
  ]);
  res.json({ ...courseWithDuration, ...introParts });
}));

app.get('/admin/api/vod-courses/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [[course]] = await getPool().query('SELECT * FROM vod_courses WHERE id = ?', [req.params.id]);
  if (!course) { res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' }); return; }
  const [introParts, [courseWithDuration]] = await Promise.all([
    fetchVodCourseIntroParts(req.params.id),
    withComputedTotalDuration([course])
  ]);
  res.json({ ...courseWithDuration, ...introParts });
}));

app.post('/admin/api/vod-courses', requireAdminApi, wrapAsync(async (req, res) => {
  const error = validateVodCourseBody(req.body);
  if (error) { res.status(400).json({ error }); return; }
  // sort_order 컬럼 기본값(0)에 맡기면 새로 추가할 때마다 전부 0으로 겹쳐서, 항상 현재 최댓값 다음 순번을 붙여 작성순서를 유지한다.
  const [[{ nextSortOrder }]] = await getPool().query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSortOrder FROM vod_courses');
  const [result] = await getPool().query(
    `INSERT INTO vod_courses (${VOD_COURSE_FIELDS.join(', ')}, sort_order) VALUES (${VOD_COURSE_FIELDS.map(() => '?').join(', ')}, ?)`,
    [...vodCourseValues(req.body), nextSortOrder]
  );
  res.json({ ok: true, id: result.insertId });
}));

// 강좌 카드 노출 순서 일괄 재정렬(관리자 목록 드래그). PUT /:id는 VOD_COURSE_FIELDS 전체를 덮어쓰는 라우트라
// "순서만" 바꿀 수 없어 별도 라우트를 둔다. PUT이 아니라 POST인 이유: PUT /admin/api/vod-courses/:id가
// :id="reorder"로 이 요청을 먼저 삼키는 함정을 라우트 선언 순서에 의존하지 않고 피할 수 있다(POST에는 /:id가 없음).
// 받은 배열의 인덱스를 그대로 sort_order로 다시 쓰므로, 강좌 삭제로 생긴 순번 구멍도 정렬할 때마다 0..n-1로 정리된다.
app.post('/admin/api/vod-courses/reorder', requireAdminApi, wrapAsync(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => parseInt(id, 10)) : null;
  if (!ids || !ids.length || ids.some(id => Number.isNaN(id))) {
    res.status(400).json({ error: 'ids는 강좌 id 배열이어야 합니다.' });
    return;
  }
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    for (const [idx, id] of ids.entries()) {
      await conn.query('UPDATE vod_courses SET sort_order = ? WHERE id = ?', [idx, id]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ ok: true });
}));

app.put('/admin/api/vod-courses/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const error = validateVodCourseBody(req.body);
  if (error) { res.status(400).json({ error }); return; }
  const [result] = await getPool().query(
    `UPDATE vod_courses SET ${VOD_COURSE_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
    [...vodCourseValues(req.body), req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/vod-courses/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM vod_courses WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// vod_course_lectures — class_lectures와 동일한 패턴. 커리큘럼 스텝 목록 겸 영상 연결 목록.
// duration_seconds는 워커가 트랜스코딩 완료 시 lecture_videos에 채워둔 값 — 커리큘럼에 차시별 재생시간을
// 표시하려고 조인해서 같이 내려준다. 영상 미연결/인코딩 중이면 NULL이라 프론트에서 자연히 표시가 생략된다.
app.get('/api/vod-courses/:id/lectures', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT l.lecture_number, l.title, l.video_r2_key, l.content_markdown, v.duration_seconds
     FROM vod_course_lectures l
     LEFT JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     WHERE l.vod_course_id = ? ORDER BY l.sort_order, l.lecture_number`,
    [req.params.id]
  );
  res.json(rows.map(({ video_r2_key, ...r }) => ({ ...r, has_video: !!video_r2_key })));
}));

app.get('/admin/api/vod-courses/:id/lectures', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT l.id, l.lecture_number, l.title, l.video_r2_key, l.sort_order, l.content_markdown,
            v.id AS video_id, v.title AS video_title, v.duration_seconds
     FROM vod_course_lectures l
     LEFT JOIN lecture_videos v ON v.final_r2_key = l.video_r2_key
     WHERE l.vod_course_id = ?
     ORDER BY l.sort_order, l.lecture_number`,
    [req.params.id]
  );
  res.json(rows);
}));

app.post('/admin/api/vod-courses/:id/lectures', requireAdminApi, wrapAsync(async (req, res) => {
  const { videoId, lectureNumber, title } = req.body;
  const num = parseInt(lectureNumber, 10);
  if (!title || Number.isNaN(num) || num < 0) {
    res.status(400).json({ error: 'title과 0 이상의 lectureNumber가 필요합니다.' });
    return;
  }
  let videoR2Key = null;
  if (videoId) {
    const [[video]] = await getPool().query('SELECT id, status, final_r2_key FROM lecture_videos WHERE id = ?', [videoId]);
    if (!video) { res.status(404).json({ error: '영상을 찾을 수 없습니다.' }); return; }
    if (video.status !== 'done' || !video.final_r2_key) {
      res.status(409).json({ error: '인코딩이 완료된(done) 영상만 연결할 수 있습니다.' });
      return;
    }
    videoR2Key = video.final_r2_key;
  }
  try {
    const [result] = await getPool().query(
      'INSERT INTO vod_course_lectures (vod_course_id, lecture_number, title, video_r2_key, sort_order) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, num, String(title).trim(), videoR2Key, num]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: `${num}강은 이미 등록되어 있습니다.` });
      return;
    }
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' });
      return;
    }
    throw err;
  }
}));

app.put('/admin/api/vod-courses/:id/lectures/:lectureId', requireAdminApi, wrapAsync(async (req, res) => {
  const { videoId, lectureNumber, title, contentMarkdown } = req.body;
  const fields = [];
  const values = [];
  if (lectureNumber !== undefined) {
    const num = parseInt(lectureNumber, 10);
    if (Number.isNaN(num) || num < 0) { res.status(400).json({ error: '강의 번호는 0 이상의 숫자여야 합니다.' }); return; }
    fields.push('lecture_number = ?', 'sort_order = ?');
    values.push(num, num);
  }
  if (title !== undefined) {
    if (!String(title).trim()) { res.status(400).json({ error: '제목을 입력해주세요.' }); return; }
    fields.push('title = ?');
    values.push(String(title).trim());
  }
  if (videoId !== undefined) {
    if (videoId === null || videoId === '') {
      fields.push('video_r2_key = ?');
      values.push(null);
    } else {
      const [[video]] = await getPool().query('SELECT id, status, final_r2_key FROM lecture_videos WHERE id = ?', [videoId]);
      if (!video) { res.status(404).json({ error: '영상을 찾을 수 없습니다.' }); return; }
      if (video.status !== 'done' || !video.final_r2_key) {
        res.status(409).json({ error: '인코딩이 완료된(done) 영상만 연결할 수 있습니다.' });
        return;
      }
      fields.push('video_r2_key = ?');
      values.push(video.final_r2_key);
    }
  }
  if (contentMarkdown !== undefined) {
    fields.push('content_markdown = ?');
    values.push(contentMarkdown === null ? null : String(contentMarkdown));
  }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  try {
    values.push(req.params.lectureId, req.params.id);
    const [result] = await getPool().query(
      `UPDATE vod_course_lectures SET ${fields.join(', ')} WHERE id = ? AND vod_course_id = ?`,
      values
    );
    if (result.affectedRows === 0) { res.status(404).json({ error: '강의를 찾을 수 없습니다.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: '해당 번호의 강의가 이미 있습니다.' }); return; }
    throw err;
  }
}));

app.delete('/admin/api/vod-courses/:id/lectures/:lectureId', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    'DELETE FROM vod_course_lectures WHERE id = ? AND vod_course_id = ?',
    [req.params.lectureId, req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: '강의를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── vod_course_lecture_materials — 강의별 자료 첨부 (class_chapter_attachments와 동일한 presign→PUT→confirm 패턴) ──
app.get('/admin/api/vod-courses/:id/lecture-materials', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT m.* FROM vod_course_lecture_materials m
     JOIN vod_course_lectures l ON l.id = m.vod_course_lecture_id
     WHERE l.vod_course_id = ? ORDER BY m.sort_order, m.id`,
    [req.params.id]
  );
  res.json(rows);
}));

app.post('/admin/api/vod-courses/:id/lectures/:lectureId/materials/presign', requireAdminApi, wrapAsync(async (req, res) => {
  const { contentType, filename } = req.body;
  if (!contentType) { res.status(400).json({ error: 'contentType이 필요합니다.' }); return; }
  const [[lecture]] = await getPool().query(
    'SELECT id FROM vod_course_lectures WHERE id = ? AND vod_course_id = ?',
    [req.params.lectureId, req.params.id]
  );
  if (!lecture) { res.status(404).json({ error: '강의를 찾을 수 없습니다.' }); return; }
  const extFromName = filename && filename.includes('.') ? filename.split('.').pop() : '';
  const ext = (extFromName || contentType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  const key = `vod-courses/${req.params.id}/lectures/${req.params.lectureId}/materials/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await r2.presignPutObject(key, contentType);
  res.json({ key, uploadUrl });
}));

app.post('/admin/api/vod-courses/:id/lectures/:lectureId/materials/confirm', requireAdminApi, wrapAsync(async (req, res) => {
  const { key, title, contentType, fileSize } = req.body;
  if (!key || !title) { res.status(400).json({ error: 'key, title이 필요합니다.' }); return; }
  if (!key.startsWith(`vod-courses/${req.params.id}/lectures/${req.params.lectureId}/materials/`)) {
    res.status(400).json({ error: '유효하지 않은 key입니다.' });
    return;
  }
  const url = `/uploads/${key}`;
  const [result] = await getPool().query(
    'INSERT INTO vod_course_lecture_materials (vod_course_lecture_id, title, file_url, file_key, mime_type, file_size) VALUES (?, ?, ?, ?, ?, ?)',
    [req.params.lectureId, title, url, key, contentType || null, fileSize || null]
  );
  res.json({ ok: true, id: result.insertId, url });
}));

app.delete('/admin/api/vod-courses/:id/lectures/:lectureId/materials/:materialId', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    `DELETE m FROM vod_course_lecture_materials m
     JOIN vod_course_lectures l ON l.id = m.vod_course_lecture_id
     WHERE m.id = ? AND m.vod_course_lecture_id = ? AND l.vod_course_id = ?`,
    [req.params.materialId, req.params.lectureId, req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: '자료를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── vod_course_questions — VOD 강좌별 Q&A 게시판 (vodDetail.html QnA 탭, FAQ 대체) ──
function maskQuestionAuthorName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '회원';
  if (trimmed.length === 1) return trimmed;
  if (trimmed.length === 2) return trimmed[0] + '○';
  return trimmed[0] + '○'.repeat(trimmed.length - 2) + trimmed[trimmed.length - 1];
}

// 비밀글은 작성자 본인(세션 memberId 일치)이 아니면 title/body/answer를 전부 감추고 masked:true만 내려준다.
// 관리자(강사)는 /admin/api 쪽 별도 라우트로 항상 전체 열람.
app.get('/api/vod-courses/:id/questions', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT q.id, q.member_id, q.title, q.body, q.is_secret, q.answer, q.answered_at, q.created_at, m.name AS member_name
     FROM vod_course_questions q
     JOIN members m ON m.id = q.member_id
     WHERE q.vod_course_id = ?
     ORDER BY q.created_at DESC`,
    [req.params.id]
  );
  const myMemberId = req.session.memberId || null;
  res.json(rows.map(r => {
    const isOwner = myMemberId != null && String(myMemberId) === String(r.member_id);
    const masked = !!r.is_secret && !isOwner;
    return {
      id: r.id,
      isSecret: !!r.is_secret,
      isOwner,
      masked,
      title: masked ? null : r.title,
      body: masked ? null : r.body,
      answer: masked ? null : r.answer,
      answeredAt: masked ? null : r.answered_at,
      answered: !!r.answered_at,
      authorName: maskQuestionAuthorName(r.member_name),
      createdAt: r.created_at
    };
  }));
}));

// 로그인 + 해당 강좌를 실제 수강 중(member_vod_enrollments)인 회원만 질문 작성 가능
app.post('/api/vod-courses/:id/questions', requireMember, wrapAsync(async (req, res) => {
  const { title, body, isSecret } = req.body;
  if (!title || !String(title).trim() || !body || !String(body).trim()) {
    res.status(400).json({ error: '제목과 내용을 입력해주세요.' });
    return;
  }
  const access = await checkVodAccess(req.session.memberId, req.params.id);
  if (!access.ok) {
    res.status(access.status).json({
      error: access.reason === 'not_enrolled' ? '수강 중인 강좌만 질문을 작성할 수 있습니다.' : access.error,
      reason: access.reason
    });
    return;
  }
  const [result] = await getPool().query(
    'INSERT INTO vod_course_questions (vod_course_id, member_id, title, body, is_secret) VALUES (?, ?, ?, ?, ?)',
    [req.params.id, req.session.memberId, String(title).trim(), String(body).trim(), isSecret ? 1 : 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

// ── 관리자 Q&A 관리 — 강좌별 목록/답변/삭제, 비밀글도 항상 전체 열람 ──
app.get('/admin/api/vod-courses/:id/questions', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT q.*, m.name AS member_name
     FROM vod_course_questions q
     JOIN members m ON m.id = q.member_id
     WHERE q.vod_course_id = ?
     ORDER BY q.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

app.put('/admin/api/vod-courses/:id/questions/:qid', requireAdminApi, wrapAsync(async (req, res) => {
  const { answer } = req.body;
  if (!answer || !String(answer).trim()) { res.status(400).json({ error: '답변 내용을 입력해주세요.' }); return; }
  const [result] = await getPool().query(
    'UPDATE vod_course_questions SET answer = ?, answered_at = NOW() WHERE id = ? AND vod_course_id = ?',
    [String(answer).trim(), req.params.qid, req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: '질문을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/vod-courses/:id/questions/:qid', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query(
    'DELETE FROM vod_course_questions WHERE id = ? AND vod_course_id = ?',
    [req.params.qid, req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: '질문을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── vod_categories (notice_categories와 동일 패턴) ──
app.get('/api/vod-categories', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT id, name, sort_order FROM vod_categories ORDER BY sort_order, id'
  );
  res.json(rows);
}));

app.get('/admin/api/vod-categories', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT c.id, c.name, c.sort_order,
            (SELECT COUNT(*) FROM vod_courses WHERE category_label = c.name) AS course_count
     FROM vod_categories c
     ORDER BY c.sort_order, c.id`
  );
  res.json(rows);
}));

app.post('/admin/api/vod-categories', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, sort_order } = req.body;
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: '카테고리 이름을 입력해주세요.' });
    return;
  }
  try {
    const [result] = await getPool().query(
      'INSERT INTO vod_categories (name, sort_order) VALUES (?, ?)',
      [String(name).trim(), parseInt(sort_order, 10) || 0]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
      return;
    }
    throw err;
  }
}));

app.put('/admin/api/vod-categories/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, sort_order } = req.body;
  const [rows] = await getPool().query('SELECT name FROM vod_categories WHERE id = ?', [req.params.id]);
  const existing = rows[0];
  if (!existing) {
    res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    return;
  }

  const fields = [];
  const values = [];
  const newName = name !== undefined ? String(name).trim() : null;
  if (newName) { fields.push('name = ?'); values.push(newName); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }

  try {
    values.push(req.params.id);
    await getPool().query(`UPDATE vod_categories SET ${fields.join(', ')} WHERE id = ?`, values);
    if (newName && newName !== existing.name) {
      // 이름이 바뀌면 이 카테고리를 쓰던 기존 강좌들도 같은 이름으로 따라간다.
      await getPool().query('UPDATE vod_courses SET category_label = ? WHERE category_label = ?', [newName, existing.name]);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
      return;
    }
    throw err;
  }
}));

app.delete('/admin/api/vod-categories/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT name FROM vod_categories WHERE id = ?', [req.params.id]);
  const category = rows[0];
  if (!category) {
    res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    return;
  }
  const [[{ cnt }]] = await getPool().query('SELECT COUNT(*) AS cnt FROM vod_courses WHERE category_label = ?', [category.name]);
  if (cnt > 0) {
    res.status(409).json({ error: `이 카테고리를 사용 중인 강좌가 ${cnt}개 있습니다. 먼저 해당 강좌의 카테고리를 변경해주세요.` });
    return;
  }
  await getPool().query('DELETE FROM vod_categories WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ── vod_course_checklist_items / vod_course_tags / vod_course_sections (클래스소개 탭 하위 목록) ──
// 세 리소스가 필드 이름만 다를 뿐 구조가 동일해서 팩토리로 CRUD 라우트를 한 번에 등록한다.
function registerVodCourseSubListRoutes(resourcePath, table, textFields) {
  app.post(`/admin/api/vod-courses/:id/${resourcePath}`, requireAdminApi, wrapAsync(async (req, res) => {
    const values = textFields.map(f => req.body[f]);
    if (values.some(v => !v || !String(v).trim())) {
      res.status(400).json({ error: `${textFields.join(', ')} 값을 모두 입력해주세요.` });
      return;
    }
    try {
      const [result] = await getPool().query(
        `INSERT INTO ${table} (vod_course_id, ${textFields.join(', ')}, sort_order) VALUES (?, ${textFields.map(() => '?').join(', ')}, ?)`,
        [req.params.id, ...values.map(v => String(v).trim()), parseInt(req.body.sort_order, 10) || 0]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      if (err.code === 'ER_NO_REFERENCED_ROW_2') { res.status(404).json({ error: 'VOD 강좌를 찾을 수 없습니다.' }); return; }
      throw err;
    }
  }));

  app.put(`/admin/api/vod-courses/:id/${resourcePath}/:itemId`, requireAdminApi, wrapAsync(async (req, res) => {
    const fields = [];
    const values = [];
    textFields.forEach(f => {
      if (req.body[f] !== undefined) { fields.push(`${f} = ?`); values.push(String(req.body[f]).trim()); }
    });
    if (req.body.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(req.body.sort_order, 10) || 0); }
    if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
    values.push(req.params.itemId, req.params.id);
    const [result] = await getPool().query(
      `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ? AND vod_course_id = ?`,
      values
    );
    if (result.affectedRows === 0) { res.status(404).json({ error: '항목을 찾을 수 없습니다.' }); return; }
    res.json({ ok: true });
  }));

  app.delete(`/admin/api/vod-courses/:id/${resourcePath}/:itemId`, requireAdminApi, wrapAsync(async (req, res) => {
    const [result] = await getPool().query(
      `DELETE FROM ${table} WHERE id = ? AND vod_course_id = ?`,
      [req.params.itemId, req.params.id]
    );
    if (result.affectedRows === 0) { res.status(404).json({ error: '항목을 찾을 수 없습니다.' }); return; }
    res.json({ ok: true });
  }));
}

registerVodCourseSubListRoutes('checklist-items', 'vod_course_checklist_items', ['content']);
registerVodCourseSubListRoutes('tags', 'vod_course_tags', ['label']);
registerVodCourseSubListRoutes('sections', 'vod_course_sections', ['heading', 'content']);
registerVodCourseSubListRoutes('purchase-highlights', 'vod_course_purchase_highlights', ['content']);

// ── cert_gallery_images ──
app.get('/api/cert-gallery', wrapAsync(async (req, res) => {
  const limit = parseInt(req.query.limit, 10);
  if (limit > 0) {
    const [rows] = await getPool().query('SELECT id, image_url, sort_order FROM cert_gallery_images ORDER BY id DESC LIMIT ?', [limit]);
    res.json(rows);
    return;
  }
  const [rows] = await getPool().query('SELECT id, image_url, sort_order FROM cert_gallery_images ORDER BY sort_order, id');
  res.json(rows);
}));

app.get('/admin/api/cert-gallery', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT id, image_url, sort_order FROM cert_gallery_images ORDER BY sort_order, id');
  res.json(rows);
}));

app.post('/admin/api/cert-gallery', requireAdminApi, wrapAsync(async (req, res) => {
  const { image_url, sort_order } = req.body;
  if (!image_url || !String(image_url).trim()) { res.status(400).json({ error: 'image_url이 필요합니다.' }); return; }
  const [result] = await getPool().query(
    'INSERT INTO cert_gallery_images (image_url, sort_order) VALUES (?, ?)',
    [String(image_url).trim(), parseInt(sort_order, 10) || 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/cert-gallery/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { sort_order } = req.body;
  if (sort_order === undefined) { res.status(400).json({ error: 'sort_order가 필요합니다.' }); return; }
  const [result] = await getPool().query(
    'UPDATE cert_gallery_images SET sort_order = ? WHERE id = ?',
    [parseInt(sort_order, 10) || 0, req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: '이미지를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/cert-gallery/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM cert_gallery_images WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '이미지를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── cert_posts — 합격 인증 게시판 ──
// 목록은 페이지네이션(번호는 최신글이 큰 번호가 되도록 전체 개수 기준으로 서버가 계산해서 내려준다).
const CERT_POSTS_PAGE_SIZE = 15;

// 본문 HTML(관리자 에디터 산출물)을 카드에 얹을 한 줄 요약으로 — 태그 제거 후 공백 정리해서 앞부분만
function certBodyExcerpt(html, limit = 220) {
  const text = String(html || '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

// focus=<id> — 홈 카드에서 특정 수기로 바로 들어올 때, 그 글이 몇 페이지에 있는지 서버가 찾아준다.
// 목록 정렬(pinned DESC, created_at DESC, id DESC)에서 그 글보다 앞에 오는 글 수를 세면 그대로 순번이 된다.
async function findCertPostPage(id, size) {
  const [[row]] = await getPool().query(
    `SELECT COUNT(*) AS ahead
       FROM cert_posts p JOIN cert_posts t ON t.id = ? AND t.is_active = 1
      WHERE p.is_active = 1
        AND (p.pinned > t.pinned
          OR (p.pinned = t.pinned
            AND (p.created_at > t.created_at
              OR (p.created_at = t.created_at AND p.id > t.id))))`,
    [id]
  );
  return Math.floor(Number(row.ahead) / size) + 1; // 글이 없으면 ahead=0 → 1페이지로 폴백
}

app.get('/api/cert-posts', wrapAsync(async (req, res) => {
  const size = Math.min(50, Math.max(1, Number(req.query.size) || CERT_POSTS_PAGE_SIZE));
  const focusId = Number(req.query.focus) || 0;
  const page = focusId ? await findCertPostPage(focusId, size) : Math.max(1, Number(req.query.page) || 1);
  // preview=1 — 홈 "실제 합격 인증" 카드용. 목록에 합격증 이미지와 본문 발췌까지 같이 실어 보내고(카드 한 장에
  // 필요한 정보가 다 있어야 함), 고정글 우선 없이 최신순으로만 정렬한다(게시판과 달리 최근 인증을 흘려보내는 용도).
  const preview = req.query.preview === '1';
  const [[{ total }]] = await getPool().query('SELECT COUNT(*) AS total FROM cert_posts WHERE is_active = 1');
  const [rows] = await getPool().query(
    `SELECT id, title, author, view_count, pinned, ${preview ? 'image_url, body,' : ''}
            DATE_FORMAT(created_at, '%Y.%m.%d') AS created_date
     FROM cert_posts WHERE is_active = 1
     ORDER BY ${preview ? '' : 'pinned DESC, '}created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [size, (page - 1) * size]
  );
  // 화면에 찍히는 글번호 — 최신글이 가장 큰 번호(일반적인 게시판 방식)
  const firstNo = total - (page - 1) * size;
  const items = rows.map((r, i) => {
    const item = { ...r, no: firstNo - i, pinned: !!r.pinned };
    if (preview) {
      item.excerpt = certBodyExcerpt(item.body);
      delete item.body; // 원본 HTML은 상세 API에서만
    }
    return item;
  });
  res.json({ items, total, page, size, totalPages: Math.max(1, Math.ceil(total / size)) });
}));

app.get('/api/cert-posts/:id', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, title, author, body, image_url, view_count,
            DATE_FORMAT(created_at, '%Y.%m.%d') AS created_date
     FROM cert_posts WHERE id = ? AND is_active = 1`,
    [req.params.id]
  );
  if (!rows.length) { res.status(404).json({ error: '게시글을 찾을 수 없습니다.' }); return; }
  // 상세를 열 때만 조회수 증가(목록 조회로는 오르지 않는다). 실패해도 본문은 그대로 내려준다.
  getPool().query('UPDATE cert_posts SET view_count = view_count + 1 WHERE id = ?', [req.params.id]).catch(() => {});
  res.json({ ...rows[0], view_count: rows[0].view_count + 1 });
}));

app.get('/admin/api/cert-posts', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, title, author, body, image_url, view_count, pinned, is_active,
            DATE_FORMAT(created_at, '%Y.%m.%d') AS created_date
     FROM cert_posts ORDER BY pinned DESC, created_at DESC, id DESC`
  );
  res.json(rows);
}));

app.post('/admin/api/cert-posts', requireAdminApi, wrapAsync(async (req, res) => {
  const { title, author, body, image_url, pinned, is_active } = req.body;
  if (!title || !String(title).trim()) { res.status(400).json({ error: '제목을 입력해주세요.' }); return; }
  if (!author || !String(author).trim()) { res.status(400).json({ error: '작성자를 입력해주세요.' }); return; }
  const [result] = await getPool().query(
    'INSERT INTO cert_posts (title, author, body, image_url, pinned, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [String(title).trim(), String(author).trim(), body ? String(body) : null,
     image_url ? String(image_url) : null, pinned ? 1 : 0, is_active === false ? 0 : 1]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/cert-posts/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { title, author, body, image_url, pinned, is_active, view_count } = req.body;
  const fields = [];
  const values = [];
  if (title !== undefined) { fields.push('title = ?'); values.push(String(title).trim()); }
  if (author !== undefined) { fields.push('author = ?'); values.push(String(author).trim()); }
  if (body !== undefined) { fields.push('body = ?'); values.push(String(body)); }
  if (image_url !== undefined) { fields.push('image_url = ?'); values.push(image_url ? String(image_url) : null); }
  if (pinned !== undefined) { fields.push('pinned = ?'); values.push(pinned ? 1 : 0); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (view_count !== undefined) { fields.push('view_count = ?'); values.push(Math.max(0, Number(view_count) || 0)); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE cert_posts SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '게시글을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/cert-posts/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM cert_posts WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '게시글을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── faq_items ──
app.get('/api/faq-items', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT id, question, answer, sort_order FROM faq_items WHERE is_active = 1 ORDER BY sort_order, id');
  res.json(rows);
}));

app.get('/admin/api/faq-items', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT * FROM faq_items ORDER BY sort_order, id');
  res.json(rows);
}));

app.post('/admin/api/faq-items', requireAdminApi, wrapAsync(async (req, res) => {
  const { question, answer, sort_order } = req.body;
  if (!question || !String(question).trim() || !answer || !String(answer).trim()) {
    res.status(400).json({ error: 'question과 answer가 필요합니다.' });
    return;
  }
  const [result] = await getPool().query(
    'INSERT INTO faq_items (question, answer, sort_order) VALUES (?, ?, ?)',
    [String(question).trim(), String(answer).trim(), parseInt(sort_order, 10) || 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/faq-items/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { question, answer, sort_order, is_active } = req.body;
  const fields = [];
  const values = [];
  if (question !== undefined) { fields.push('question = ?'); values.push(String(question).trim()); }
  if (answer !== undefined) { fields.push('answer = ?'); values.push(String(answer).trim()); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE faq_items SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '항목을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/faq-items/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM faq_items WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '항목을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── reviews (수강후기) ──
app.get('/api/reviews', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, student_name, DATE_FORMAT(review_date, '%Y.%m.%d') AS review_date, course_name, rating, review_text
     FROM reviews WHERE is_active = 1 ORDER BY review_date DESC, sort_order`
  );
  res.json(rows);
}));

app.get('/admin/api/reviews', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, student_name, DATE_FORMAT(review_date, '%Y-%m-%d') AS review_date, course_name, rating, review_text, sort_order, is_active, created_at
     FROM reviews ORDER BY sort_order, id`
  );
  res.json(rows);
}));

app.post('/admin/api/reviews', requireAdminApi, wrapAsync(async (req, res) => {
  const { student_name, review_date, course_name, rating, review_text, sort_order } = req.body;
  if (!student_name || !String(student_name).trim() || !review_date || !course_name || !String(course_name).trim() || !review_text || !String(review_text).trim()) {
    res.status(400).json({ error: 'student_name, review_date, course_name, review_text가 필요합니다.' });
    return;
  }
  const [result] = await getPool().query(
    'INSERT INTO reviews (student_name, review_date, course_name, rating, review_text, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [String(student_name).trim(), review_date, String(course_name).trim(), parseFloat(rating) || 5.0, String(review_text).trim(), parseInt(sort_order, 10) || 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/reviews/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { student_name, review_date, course_name, rating, review_text, sort_order, is_active } = req.body;
  const fields = [];
  const values = [];
  if (student_name !== undefined) { fields.push('student_name = ?'); values.push(String(student_name).trim()); }
  if (review_date !== undefined) { fields.push('review_date = ?'); values.push(review_date); }
  if (course_name !== undefined) { fields.push('course_name = ?'); values.push(String(course_name).trim()); }
  if (rating !== undefined) { fields.push('rating = ?'); values.push(parseFloat(rating) || 5.0); }
  if (review_text !== undefined) { fields.push('review_text = ?'); values.push(String(review_text).trim()); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '항목을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/reviews/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '항목을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── instructors — 강사 목록 (썸네일/이름/소개, cert_gallery와 동일한 presign→PUT 업로드 패턴) ──
app.get('/api/instructors', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT id, name, intro, thumbnail_url, sort_order FROM instructors WHERE is_active = 1 ORDER BY sort_order, id'
  );
  res.json(rows);
}));

app.get('/admin/api/instructors', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT id, name, intro, thumbnail_url, sort_order, is_active, created_at FROM instructors ORDER BY sort_order, id'
  );
  res.json(rows);
}));

app.post('/admin/api/instructors', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, intro, thumbnail_url, sort_order } = req.body;
  if (!name || !String(name).trim()) { res.status(400).json({ error: '강사 이름이 필요합니다.' }); return; }
  const [result] = await getPool().query(
    'INSERT INTO instructors (name, intro, thumbnail_url, sort_order) VALUES (?, ?, ?, ?)',
    [String(name).trim(), intro ? String(intro).trim() : null, thumbnail_url ? String(thumbnail_url).trim() : null, parseInt(sort_order, 10) || 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/instructors/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, intro, thumbnail_url, sort_order, is_active } = req.body;
  const fields = [];
  const values = [];
  if (name !== undefined) {
    if (!String(name).trim()) { res.status(400).json({ error: '강사 이름이 필요합니다.' }); return; }
    fields.push('name = ?'); values.push(String(name).trim());
  }
  if (intro !== undefined) { fields.push('intro = ?'); values.push(intro ? String(intro).trim() : null); }
  if (thumbnail_url !== undefined) { fields.push('thumbnail_url = ?'); values.push(thumbnail_url ? String(thumbnail_url).trim() : null); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE instructors SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '강사를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/instructors/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM instructors WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '강사를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── intro_tabs — 학습소개 탭 목록 (관리자가 자유롭게 추가/수정/삭제/순서변경) ──
app.get('/api/intro-tabs', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT id, label, image_url, sort_order FROM intro_tabs ORDER BY sort_order, id');
  res.json(rows);
}));

app.get('/admin/api/intro-tabs', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT * FROM intro_tabs ORDER BY sort_order, id');
  res.json(rows);
}));

app.post('/admin/api/intro-tabs', requireAdminApi, wrapAsync(async (req, res) => {
  const { label, image_url, sort_order } = req.body;
  if (!label || !String(label).trim()) { res.status(400).json({ error: '탭 이름이 필요합니다.' }); return; }
  const [result] = await getPool().query(
    'INSERT INTO intro_tabs (label, image_url, sort_order) VALUES (?, ?, ?)',
    [String(label).trim(), image_url ? String(image_url).trim() : null, parseInt(sort_order, 10) || 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/intro-tabs/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { label, image_url, sort_order } = req.body;
  const fields = [];
  const values = [];
  if (label !== undefined) {
    if (!String(label).trim()) { res.status(400).json({ error: '탭 이름이 필요합니다.' }); return; }
    fields.push('label = ?'); values.push(String(label).trim());
  }
  if (image_url !== undefined) { fields.push('image_url = ?'); values.push(image_url ? String(image_url).trim() : null); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE intro_tabs SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '탭을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/intro-tabs/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM intro_tabs WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '탭을 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── notice_categories (class_categories와 동일 패턴) ──
app.get('/api/notice-categories', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT id, name, sort_order FROM notice_categories ORDER BY sort_order, id');
  res.json(rows);
}));

app.get('/admin/api/notice-categories', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT c.id, c.name, c.sort_order,
            (SELECT COUNT(*) FROM notices WHERE category = c.name) AS notice_count
     FROM notice_categories c
     ORDER BY c.sort_order, c.id`
  );
  res.json(rows);
}));

app.post('/admin/api/notice-categories', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, sort_order } = req.body;
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: '카테고리 이름을 입력해주세요.' });
    return;
  }
  try {
    const [result] = await getPool().query(
      'INSERT INTO notice_categories (name, sort_order) VALUES (?, ?)',
      [String(name).trim(), parseInt(sort_order, 10) || 0]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
      return;
    }
    throw err;
  }
}));

app.put('/admin/api/notice-categories/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { name, sort_order } = req.body;
  const [rows] = await getPool().query('SELECT name FROM notice_categories WHERE id = ?', [req.params.id]);
  const existing = rows[0];
  if (!existing) {
    res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    return;
  }

  const fields = [];
  const values = [];
  const newName = name !== undefined ? String(name).trim() : null;
  if (newName) { fields.push('name = ?'); values.push(newName); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (fields.length === 0) {
    res.status(400).json({ error: '변경할 값이 없습니다.' });
    return;
  }

  try {
    values.push(req.params.id);
    await getPool().query(`UPDATE notice_categories SET ${fields.join(', ')} WHERE id = ?`, values);
    if (newName && newName !== existing.name) {
      // 이름이 바뀌면 이 카테고리를 쓰던 기존 공지들도 같은 이름으로 따라간다.
      await getPool().query('UPDATE notices SET category = ? WHERE category = ?', [newName, existing.name]);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 존재하는 카테고리입니다.' });
      return;
    }
    throw err;
  }
}));

app.delete('/admin/api/notice-categories/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT name FROM notice_categories WHERE id = ?', [req.params.id]);
  const category = rows[0];
  if (!category) {
    res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' });
    return;
  }
  const [[{ cnt }]] = await getPool().query('SELECT COUNT(*) AS cnt FROM notices WHERE category = ?', [category.name]);
  if (cnt > 0) {
    res.status(409).json({ error: `이 카테고리를 사용 중인 공지가 ${cnt}개 있습니다. 먼저 해당 공지의 카테고리를 변경해주세요.` });
    return;
  }
  await getPool().query('DELETE FROM notice_categories WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ── notices (dock-pass 관리자 공지사항 기능 이식) ──
app.get('/api/notices', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, category, title, body, pinned, DATE_FORMAT(notice_date, '%Y.%m.%d') AS date
     FROM notices ORDER BY pinned DESC, notice_date DESC, id DESC`
  );
  res.json(rows);
}));

app.get('/admin/api/notices', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, category, title, body, pinned, DATE_FORMAT(notice_date, '%Y.%m.%d') AS date, created_at
     FROM notices ORDER BY pinned DESC, notice_date DESC, id DESC`
  );
  res.json(rows);
}));

app.post('/admin/api/notices', requireAdminApi, wrapAsync(async (req, res) => {
  const { category, title, body } = req.body;
  const pinned = req.body.pinned;
  if (!title || !String(title).trim()) {
    res.status(400).json({ error: '제목을 입력해주세요.' });
    return;
  }
  const categoryValue = category && String(category).trim() ? String(category).trim() : null;
  const [result] = await getPool().query(
    'INSERT INTO notices (category, title, body, pinned, notice_date) VALUES (?, ?, ?, ?, CURDATE())',
    [categoryValue, String(title).trim(), body ? String(body) : null, pinned ? 1 : 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/notices/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { category, title, body, pinned } = req.body;
  const fields = [];
  const values = [];
  if (category !== undefined) {
    const trimmed = String(category).trim();
    fields.push('category = ?'); values.push(trimmed ? trimmed : null);
  }
  if (title !== undefined) { fields.push('title = ?'); values.push(String(title).trim()); }
  if (body !== undefined) { fields.push('body = ?'); values.push(String(body)); }
  if (pinned !== undefined) { fields.push('pinned = ?'); values.push(pinned ? 1 : 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '공지를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/notices/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM notices WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '공지를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── popup_banners (dock-pass 관리자 팝업배너 기능 이식) ──
const POPUP_POSITIONS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

app.get('/api/popup-banners', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, image_url, link_url, position
     FROM popup_banners
     WHERE visible = 1 AND start_date <= CURDATE() AND end_date >= CURDATE()
     ORDER BY sort_order, id`
  );
  res.json(rows);
}));

app.get('/admin/api/popup-banners', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, image_url, link_url, position, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, visible, sort_order
     FROM popup_banners ORDER BY sort_order, id`
  );
  res.json(rows);
}));

app.post('/admin/api/popup-banners', requireAdminApi, wrapAsync(async (req, res) => {
  const { image_url, link_url, position, start_date, end_date, visible, sort_order } = req.body;
  if (!image_url || !String(image_url).trim()) {
    res.status(400).json({ error: '이미지를 업로드해주세요.' });
    return;
  }
  if (position && !POPUP_POSITIONS.includes(position)) {
    res.status(400).json({ error: '유효하지 않은 position입니다.' });
    return;
  }
  if (!start_date || !end_date) {
    res.status(400).json({ error: '노출 시작일/종료일을 입력해주세요.' });
    return;
  }
  if (String(end_date) < String(start_date)) {
    res.status(400).json({ error: '종료일은 시작일보다 빠를 수 없습니다.' });
    return;
  }
  const [result] = await getPool().query(
    'INSERT INTO popup_banners (image_url, link_url, position, start_date, end_date, visible, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [String(image_url).trim(), link_url ? String(link_url).trim() : null, position || 'center', start_date, end_date, visible === false ? 0 : 1, parseInt(sort_order, 10) || 0]
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/popup-banners/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { image_url, link_url, position, start_date, end_date, visible, sort_order } = req.body;
  const fields = [];
  const values = [];
  if (image_url !== undefined) {
    if (!String(image_url).trim()) { res.status(400).json({ error: '이미지를 업로드해주세요.' }); return; }
    fields.push('image_url = ?'); values.push(String(image_url).trim());
  }
  if (link_url !== undefined) {
    fields.push('link_url = ?'); values.push(link_url ? String(link_url).trim() : null);
  }
  if (position !== undefined) {
    if (!POPUP_POSITIONS.includes(position)) { res.status(400).json({ error: '유효하지 않은 position입니다.' }); return; }
    fields.push('position = ?'); values.push(position);
  }
  if (start_date !== undefined) { fields.push('start_date = ?'); values.push(start_date); }
  if (end_date !== undefined) { fields.push('end_date = ?'); values.push(end_date); }
  if (visible !== undefined) { fields.push('visible = ?'); values.push(visible ? 1 : 0); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE popup_banners SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '팝업 배너를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/popup-banners/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM popup_banners WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '팝업 배너를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// ── content_banners (관리자 "메인 페이지 배너" — 헤더 좌/우, 상단/중간/콘텐츠/사이드/하단 7종) ──
// header-left/header-right: 모든 페이지 공통 헤더의 로고 좌/우 배너(각 230×80, public-figma/header.js).
// top/middle: 홈 상단 슬라이더. content/side: DOCK NEWS 섹션 좌(탭+이미지)/우(고정 이미지).
// bottom: 홈 맨 아래 FAQ 옆 CTA 자리 슬라이더(PC 1080×500 / 모바일 720×600, mobile_image_url 사용).
// content 타입의 label은 프론트에서 DOCK NEWS 탭 버튼 이름으로 쓰인다.
const BANNER_TYPES = ['header-left', 'header-right', 'top', 'middle', 'content', 'side', 'bottom'];
const BANNER_MOBILE_FOCUS = ['left', 'center', 'right'];

// mobile_image_url/mobile_focus는 나중에 추가된 컬럼(infra/schema.sql 하단 ALTER).
// 마이그레이션 전 DB에 이 코드가 먼저 올라가도 홈 배너가 500으로 죽지 않도록 컬럼 유무를 한 번만 확인해 캐시한다.
// 있다고 확인되면 영구 캐시, 없으면 60초 후 다시 확인 — 마이그레이션을 적용해도 서버를 재시작해야 하는 상황을 피한다.
let bannerMobileCols = { value: false, checkedAt: 0 };
async function hasBannerMobileCols() {
  if (bannerMobileCols.value) return true;
  if (Date.now() - bannerMobileCols.checkedAt < 60_000) return false;
  bannerMobileCols.checkedAt = Date.now();
  try {
    const [rows] = await getPool().query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'content_banners'
         AND column_name IN ('mobile_image_url', 'mobile_focus')`
    );
    bannerMobileCols.value = Number(rows[0]?.n) === 2;
  } catch (err) {
    bannerMobileCols.value = false;
  }
  return bannerMobileCols.value;
}

app.get('/api/content-banners', wrapAsync(async (req, res) => {
  const mobileCols = await hasBannerMobileCols() ? ', mobile_image_url, mobile_focus' : '';
  const [rows] = await getPool().query(
    `SELECT id, banner_type, label, image_url, link_url${mobileCols}
     FROM content_banners
     WHERE visible = 1
     ORDER BY banner_type, sort_order, id`
  );
  res.json(rows);
}));

app.get('/admin/api/content-banners', requireAdminApi, wrapAsync(async (req, res) => {
  const mobileCols = await hasBannerMobileCols() ? ', mobile_image_url, mobile_focus' : '';
  const [rows] = await getPool().query(
    `SELECT id, banner_type, label, image_url, link_url, visible, sort_order${mobileCols}
     FROM content_banners ORDER BY banner_type, sort_order, id`
  );
  res.json(rows);
}));

app.post('/admin/api/content-banners', requireAdminApi, wrapAsync(async (req, res) => {
  const { banner_type, label, image_url, link_url, visible, sort_order, mobile_image_url, mobile_focus } = req.body;
  if (!BANNER_TYPES.includes(banner_type)) {
    res.status(400).json({ error: `banner_type은 ${BANNER_TYPES.join(', ')} 중 하나여야 합니다.` });
    return;
  }
  if (!image_url || !String(image_url).trim()) {
    res.status(400).json({ error: '이미지를 업로드해주세요.' });
    return;
  }
  if (mobile_focus !== undefined && mobile_focus !== null && !BANNER_MOBILE_FOCUS.includes(mobile_focus)) {
    res.status(400).json({ error: `mobile_focus는 ${BANNER_MOBILE_FOCUS.join(', ')} 중 하나여야 합니다.` });
    return;
  }
  const cols = ['banner_type', 'label', 'image_url', 'link_url', 'visible', 'sort_order'];
  const vals = [banner_type, label ? String(label).trim() : null, String(image_url).trim(), link_url ? String(link_url).trim() : null, visible === false ? 0 : 1, parseInt(sort_order, 10) || 0];
  if (await hasBannerMobileCols()) {
    cols.push('mobile_image_url', 'mobile_focus');
    vals.push(mobile_image_url ? String(mobile_image_url).trim() : null, mobile_focus || 'center');
  } else if (mobile_image_url) {
    res.status(400).json({ error: 'DB에 mobile_image_url 컬럼이 없습니다. infra/schema.sql의 content_banners ALTER를 먼저 적용해주세요.' });
    return;
  }
  const [result] = await getPool().query(
    `INSERT INTO content_banners (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/content-banners/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const { banner_type, label, image_url, link_url, visible, sort_order, mobile_image_url, mobile_focus } = req.body;
  const fields = [];
  const values = [];
  if (mobile_image_url !== undefined || mobile_focus !== undefined) {
    if (!await hasBannerMobileCols()) {
      res.status(400).json({ error: 'DB에 mobile_image_url 컬럼이 없습니다. infra/schema.sql의 content_banners ALTER를 먼저 적용해주세요.' });
      return;
    }
    // 빈 문자열/null → NULL(모바일 전용 이미지 해제 → 프론트가 데스크톱 이미지를 확대 크롭)
    if (mobile_image_url !== undefined) {
      fields.push('mobile_image_url = ?');
      values.push(mobile_image_url && String(mobile_image_url).trim() ? String(mobile_image_url).trim() : null);
    }
    if (mobile_focus !== undefined) {
      if (!BANNER_MOBILE_FOCUS.includes(mobile_focus)) { res.status(400).json({ error: `mobile_focus는 ${BANNER_MOBILE_FOCUS.join(', ')} 중 하나여야 합니다.` }); return; }
      fields.push('mobile_focus = ?'); values.push(mobile_focus);
    }
  }
  if (banner_type !== undefined) {
    if (!BANNER_TYPES.includes(banner_type)) { res.status(400).json({ error: `banner_type은 ${BANNER_TYPES.join(', ')} 중 하나여야 합니다.` }); return; }
    fields.push('banner_type = ?'); values.push(banner_type);
  }
  if (label !== undefined) { fields.push('label = ?'); values.push(label ? String(label).trim() : null); }
  if (image_url !== undefined) {
    if (!String(image_url).trim()) { res.status(400).json({ error: '이미지를 업로드해주세요.' }); return; }
    fields.push('image_url = ?'); values.push(String(image_url).trim());
  }
  if (link_url !== undefined) { fields.push('link_url = ?'); values.push(link_url ? String(link_url).trim() : null); }
  if (visible !== undefined) { fields.push('visible = ?'); values.push(visible ? 1 : 0); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(sort_order, 10) || 0); }
  if (fields.length === 0) { res.status(400).json({ error: '변경할 값이 없습니다.' }); return; }
  values.push(req.params.id);
  const [result] = await getPool().query(`UPDATE content_banners SET ${fields.join(', ')} WHERE id = ?`, values);
  if (result.affectedRows === 0) { res.status(404).json({ error: '배너를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/content-banners/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM content_banners WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: '배너를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// 기존 사이트(public/)는 /v1 하위로 이전. 신규 루트(피그마 디자인)와 분리.
app.use('/v1', express.static(path.join(__dirname, 'public')));

app.get(/^\/v1(\/.*)?$/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 이미지 최적화 미들웨어 ──
// PNG 옆에 같은 이름의 무손실(lossless) .webp가 있으면, WebP를 받을 수 있는 브라우저에는 그쪽을 대신 내려준다.
// 픽셀은 원본 PNG와 100% 동일하고 용량만 30~40% 작다. URL은 그대로라서 HTML/DB에 저장된 .png 경로를
// 하나도 고칠 필요가 없다(관리자가 DB에 등록한 /assets/... 배너 경로도 자동 적용).
// 캐시 프록시가 PNG/WebP를 섞어 내보내지 않도록 Vary: Accept 필수.
const WEBP_ROOT = path.join(__dirname, 'public-figma');
const STATIC_IMAGE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 이미지/폰트 캐시 기간 7일
app.get(/^\/assets\/.*\.png$/, (req, res, next) => {
  if (!(req.headers.accept || '').includes('image/webp')) return next();
  const webpRel = req.path.replace(/\.png$/, '.webp');
  const webpAbs = path.join(WEBP_ROOT, webpRel);
  // 경로 탈출 방지 — 정규식상 /assets/로 시작하지만 ..%2f 류 디코딩 결과까지 한 번 더 확인한다.
  if (!webpAbs.startsWith(path.join(WEBP_ROOT, 'assets') + path.sep)) return next();
  fs.access(webpAbs, fs.constants.R_OK, (err) => {
    if (err) return next(); // .webp가 없으면 평소대로 PNG
    res.setHeader('Vary', 'Accept');
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(webpAbs, { maxAge: STATIC_IMAGE_MAX_AGE }, (e) => { if (e) next(); });
  });
});

// 신규 루트: 피그마 디자인 기반 페이지
// 이미지/폰트는 오래 캐시(재방문 시 재다운로드 없음), HTML/JS/CSS는 배포 즉시 반영돼야 하므로 매번 재검증.
app.use(express.static(path.join(__dirname, 'public-figma'), {
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', `public, max-age=${STATIC_IMAGE_MAX_AGE / 1000}`);
      if (/\.png$/i.test(filePath)) res.setHeader('Vary', 'Accept'); // 위 WebP 대체와 짝을 맞춘다
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// 강좌 상세페이지 시안 (확장자 없이 /classDetail로 접근)
app.get('/classDetail', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-figma', 'classDetail.html'));
});

// 클라이언트 라우팅(history.pushState)으로만 존재하는 가상 경로 새로고침/직접 접근 대응.
// 정적 파일로 못 찾은 경로 중 확장자 없는(=페이지) 요청은 index.html을 내려 SPA가 알아서 그리게 한다.
app.get(/^\/(?!v1|api|admin|uploads).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public-figma', 'index.html'));
});

// 홈 첫 화면에 쓰이는 업로드 이미지들을 미리 WebP로 변환해둔다.
// 안 하면 배포 직후 첫 방문자만 원본 PNG를 받게 된다(캐시는 두 번째 요청부터 효과).
// 디스크 캐시는 재시작해도 남으므로 두 번째 기동부터는 사실상 아무 일도 하지 않는다.
// 실패해도 서버 기동/서비스에는 영향이 없다 — 그냥 원본 PNG로 서빙될 뿐.
async function warmUploadsWebpCache() {
  try {
    const [rows] = await getPool().query(
      `SELECT image_url AS u FROM content_banners WHERE visible = 1
       UNION SELECT mobile_image_url FROM content_banners WHERE visible = 1
       UNION SELECT thumbnail_url FROM vod_courses WHERE is_active = 1
       UNION SELECT image_url FROM popup_banners WHERE visible = 1`
    );
    const keys = rows
      .map(r => r.u)
      .filter(u => typeof u === 'string' && u.startsWith('/uploads/') && /\.png$/i.test(u))
      .map(u => u.replace(/^\/uploads\//, ''));
    let made = 0;
    for (const key of keys) {
      const cachePath = uploadsWebpPath(key);
      try { await fs.promises.stat(cachePath); continue; } catch { /* 없으면 변환 */ }
      await convertUploadToWebp(key, cachePath);
      made++;
    }
    if (made) console.log(`[uploads-webp] 예열 완료: ${made}개 변환 (대상 ${keys.length}개)`);
  } catch (err) {
    console.error('[uploads-webp] 예열 건너뜀:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  setTimeout(warmUploadsWebpCache, 3000); // 기동 직후 요청 처리와 겹치지 않게 잠깐 미룬 뒤 시작
});
