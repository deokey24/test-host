const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { getPool } = require('./lib/db');
const r2 = require('./lib/r2');
const { sendVideoJob } = require('./lib/sqs');
const { ensureWorkerCapacity } = require('./lib/asg');
const { sendEmail } = require('./lib/ses');

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

app.use(session({
  secret: process.env.SESSION_SECRET || 'dockteacher-admin-session',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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

// 관리자 셸의 정적 자산(cms.css/cms.js/home.js 등). 위의 명시적 /admin, /admin/v1, /admin/api/* 라우트가
// 먼저 매칭되므로 이 미들웨어는 그 외의 admin/ 하위 파일 요청만 처리한다.
app.use('/admin', express.static(path.join(__dirname, 'admin')));

app.get('/admin/api/videos', requireAdminApi, wrapAsync(async (req, res) => {
  const { folderId, all } = req.query;
  // all=1: 폴더 무관하게 전체 조회 (VOD 강의 편집기의 "강의 영상 선택"처럼 폴더 트리와 무관하게
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
  res.json(rows.map(v => ({ ...v, final_url: v.final_r2_key ? buildCdnUrl(v.final_r2_key) : null })));
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
  if (video.final_r2_key) await r2.deleteObject(video.final_r2_key);

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

app.get('/uploads/*', wrapAsync(async (req, res) => {
  const key = req.params[0];
  try {
    const object = await r2.getObject(key);
    if (object.ContentType) res.setHeader('Content-Type', object.ContentType);
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
    `SELECT id, username, name, email, phone, mobile, joined_at, (password IS NOT NULL) AS has_password
     FROM members ${where}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [...likeParams, pageSize, offset]
  );

  res.json({ total, page, pageSize, rows });
});

app.get('/admin/api/members/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT id, username, name, member_group, phone, mobile, email,
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
async function enrollMemberInVod(memberId, vodCourseId, source = 'admin', extra = {}) {
  const status = extra.status === '완료' ? '완료' : '진행중';
  const progressNote = extra.progressNote || null;
  await getPool().query(
    `INSERT INTO member_vod_enrollments (member_id, vod_course_id, status, progress_note, source)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), progress_note = VALUES(progress_note)`,
    [memberId, vodCourseId, status, progressNote, source]
  );
}

app.get('/admin/api/members/:id/vod-enrollments', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT e.id, e.vod_course_id, e.status, e.progress_note, e.source, e.enrolled_at, c.title AS name
     FROM member_vod_enrollments e
     JOIN vod_courses c ON c.id = e.vod_course_id
     WHERE e.member_id = ?
     ORDER BY e.enrolled_at DESC`,
    [req.params.id]
  );
  res.json(rows);
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

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9]{4,19}$/;
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
    res.status(400).json({ error: '아이디 형식이 올바르지 않습니다.' });
    return;
  }
  const [rows] = await getPool().query('SELECT id FROM members WHERE username = ?', [username]);
  res.json({ available: rows.length === 0 });
});

app.post('/api/members/signup', async (req, res) => {
  const {
    username, password, email, name, phone, mobile,
    signupChannel, searchKeyword, referrerCode, emailConsent, smsConsent,
    deviceId, keepLoggedIn
  } = req.body;

  if (!username || !password || !email || !name) {
    res.status(400).json({ error: '필수 항목을 모두 입력해주세요.' });
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: '아이디는 영문자로 시작하는 영문자/숫자 5~20자여야 합니다.' });
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
        (username, password, name, phone, mobile, email, signup_channel, search_keyword, referrer_code, email_marketing_consent, sms_marketing_consent, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        username, passwordHash, name, phone || null, mobile || null, email,
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

app.get('/api/members/my-info', requireMember, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT username, name, email, phone, mobile FROM members WHERE id = ?',
    [req.session.memberId]
  );
  if (!rows[0]) {
    res.status(404).json({ error: '회원 정보를 찾을 수 없습니다.' });
    return;
  }
  res.json(rows[0]);
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
      videoUrl: buildCdnUrl(l.video_r2_key),
      materials: materialsByLecture[l.id] || []
    }))
  });
}));

app.get('/api/members/my-vod-courses', requireMember, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT c.id, c.tag, c.category_label, c.title, c.description, c.meta_text,
            c.is_best, c.color_variant, c.old_price, c.new_price, c.thumbnail_url,
            e.status, e.progress_note
     FROM member_vod_enrollments e
     JOIN vod_courses c ON c.id = e.vod_course_id
     WHERE e.member_id = ?
     ORDER BY e.enrolled_at DESC`,
    [req.session.memberId]
  );
  res.json(rows);
}));

// 로그인한 회원이 실제로 그 VOD 강좌를 수강 중일 때만 강의 목록(영상+콘텐츠)을 내려준다.
app.get('/api/members/my-vod-lectures/:vodCourseId', requireMember, wrapAsync(async (req, res) => {
  const [enrollRows] = await getPool().query(
    'SELECT id FROM member_vod_enrollments WHERE member_id = ? AND vod_course_id = ?',
    [req.session.memberId, req.params.vodCourseId]
  );
  if (!enrollRows[0]) {
    res.status(403).json({ error: '수강 중인 강좌가 아닙니다.' });
    return;
  }

  const [courseRows] = await getPool().query('SELECT id, title FROM vod_courses WHERE id = ?', [req.params.vodCourseId]);
  if (!courseRows[0]) {
    res.status(404).json({ error: '강좌를 찾을 수 없습니다.' });
    return;
  }

  const [lectures] = await getPool().query(
    'SELECT id, lecture_number, title, video_r2_key, content_markdown FROM vod_course_lectures WHERE vod_course_id = ? ORDER BY sort_order, lecture_number',
    [req.params.vodCourseId]
  );
  const [materials] = await getPool().query(
    `SELECT m.vod_course_lecture_id, m.title, m.file_url
     FROM vod_course_lecture_materials m
     JOIN vod_course_lectures l ON l.id = m.vod_course_lecture_id
     WHERE l.vod_course_id = ?
     ORDER BY m.sort_order, m.id`,
    [req.params.vodCourseId]
  );
  const materialsByLecture = {};
  materials.forEach(m => {
    (materialsByLecture[m.vod_course_lecture_id] ||= []).push({ title: m.title, url: m.file_url });
  });

  res.json({
    course: courseRows[0],
    lectures: lectures.map(({ id, video_r2_key, ...l }) => ({
      ...l,
      video_url: video_r2_key ? buildCdnUrl(video_r2_key) : null,
      materials: materialsByLecture[id] || []
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
  const [result] = await getPool().query(
    'DELETE FROM member_devices WHERE id = ? AND member_id = ?',
    [req.params.id, req.session.memberId]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: '기기를 찾을 수 없습니다.' });
    return;
  }
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════
// 신규 Figma 사이트(public-figma) CMS — site_sections / vod_courses / cert_gallery_images / faq_items
// ══════════════════════════════════════════════════════════════════

const ALLOWED_UPLOAD_SCOPES = [
  'home-hero', 'home-online-class', 'home-why', 'vod-course', 'cert-gallery', 'notice'
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
  res.json({ ok: true });
}));

// ── vod_courses: VOD 강의 상품 (vod.html/curriculum.html/홈 미리보기 공용 소스) ──
const VOD_COURSE_FIELDS = [
  'tag', 'category_label', 'title', 'description', 'meta_text', 'is_best',
  'color_variant', 'old_price', 'new_price', 'thumbnail_url', 'sort_order', 'is_active',
  'completion_criteria', 'total_duration_text', 'difficulty', 'difficulty_visible',
  'intro_heading', 'intro_paragraph', 'recommended_heading'
];

function validateVodCourseBody(body) {
  if (!body.title || !String(body.title).trim()) return 'title은 필수 항목입니다.';
  if (!body.new_price || !String(body.new_price).trim()) return 'new_price는 필수 항목입니다.';
  if (body.color_variant && !['default', 'green'].includes(body.color_variant)) {
    return 'color_variant는 default, green 중 하나여야 합니다.';
  }
  return null;
}

function vodCourseValues(body) {
  return VOD_COURSE_FIELDS.map(field => {
    if (field === 'sort_order') return parseInt(body.sort_order, 10) || 0;
    if (field === 'is_best') return body.is_best ? 1 : 0;
    if (field === 'is_active') return body.is_active === false || body.is_active === 0 || body.is_active === '0' ? 0 : 1;
    if (field === 'difficulty_visible') return body.difficulty_visible === false || body.difficulty_visible === 0 || body.difficulty_visible === '0' ? 0 : 1;
    if (field === 'color_variant') return body.color_variant || 'default';
    if (field === 'intro_heading') return body.intro_heading && String(body.intro_heading).trim() ? String(body.intro_heading).trim() : '클래스에서 배울 수 있는 내용이에요';
    if (field === 'recommended_heading') return body.recommended_heading && String(body.recommended_heading).trim() ? String(body.recommended_heading).trim() : '이런 분들께 추천해요';
    const value = body[field];
    return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
  });
}

app.get('/api/vod-courses', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT * FROM vod_courses WHERE is_active = 1 ORDER BY sort_order, id'
  );
  res.json(rows);
}));

app.get('/admin/api/vod-courses', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query('SELECT * FROM vod_courses ORDER BY sort_order, id');
  res.json(rows);
}));

async function fetchVodCourseIntroParts(courseId) {
  const [[checklistItems], [tags], [sections]] = await Promise.all([
    getPool().query('SELECT id, content, sort_order FROM vod_course_checklist_items WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId]),
    getPool().query('SELECT id, label, sort_order FROM vod_course_tags WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId]),
    getPool().query('SELECT id, heading, content, sort_order FROM vod_course_sections WHERE vod_course_id = ? ORDER BY sort_order, id', [courseId])
  ]);
  return { checklistItems, tags, sections };
}

app.get('/api/vod-courses/:id', wrapAsync(async (req, res) => {
  const [[course]] = await getPool().query('SELECT * FROM vod_courses WHERE id = ? AND is_active = 1', [req.params.id]);
  if (!course) { res.status(404).json({ error: 'VOD 강의를 찾을 수 없습니다.' }); return; }
  const introParts = await fetchVodCourseIntroParts(req.params.id);
  res.json({ ...course, ...introParts });
}));

app.get('/admin/api/vod-courses/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [[course]] = await getPool().query('SELECT * FROM vod_courses WHERE id = ?', [req.params.id]);
  if (!course) { res.status(404).json({ error: 'VOD 강의를 찾을 수 없습니다.' }); return; }
  const introParts = await fetchVodCourseIntroParts(req.params.id);
  res.json({ ...course, ...introParts });
}));

app.post('/admin/api/vod-courses', requireAdminApi, wrapAsync(async (req, res) => {
  const error = validateVodCourseBody(req.body);
  if (error) { res.status(400).json({ error }); return; }
  const [result] = await getPool().query(
    `INSERT INTO vod_courses (${VOD_COURSE_FIELDS.join(', ')}) VALUES (${VOD_COURSE_FIELDS.map(() => '?').join(', ')})`,
    vodCourseValues(req.body)
  );
  res.json({ ok: true, id: result.insertId });
}));

app.put('/admin/api/vod-courses/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const error = validateVodCourseBody(req.body);
  if (error) { res.status(400).json({ error }); return; }
  const [result] = await getPool().query(
    `UPDATE vod_courses SET ${VOD_COURSE_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
    [...vodCourseValues(req.body), req.params.id]
  );
  if (result.affectedRows === 0) { res.status(404).json({ error: 'VOD 강의를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

app.delete('/admin/api/vod-courses/:id', requireAdminApi, wrapAsync(async (req, res) => {
  const [result] = await getPool().query('DELETE FROM vod_courses WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) { res.status(404).json({ error: 'VOD 강의를 찾을 수 없습니다.' }); return; }
  res.json({ ok: true });
}));

// vod_course_lectures — class_lectures와 동일한 패턴. 커리큘럼 스텝 목록 겸 영상 연결 목록.
app.get('/api/vod-courses/:id/lectures', wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT lecture_number, title, video_r2_key, content_markdown FROM vod_course_lectures WHERE vod_course_id = ? ORDER BY sort_order, lecture_number',
    [req.params.id]
  );
  res.json(rows.map(({ video_r2_key, ...r }) => ({ ...r, has_video: !!video_r2_key })));
}));

app.get('/admin/api/vod-courses/:id/lectures', requireAdminApi, wrapAsync(async (req, res) => {
  const [rows] = await getPool().query(
    `SELECT l.id, l.lecture_number, l.title, l.video_r2_key, l.sort_order, l.content_markdown,
            v.id AS video_id, v.title AS video_title
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
      res.status(404).json({ error: 'VOD 강의를 찾을 수 없습니다.' });
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

// ── vod_categories (notice_categories와 동일 패턴) ──
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
    res.status(409).json({ error: `이 카테고리를 사용 중인 강의가 ${cnt}개 있습니다. 먼저 해당 강의의 카테고리를 변경해주세요.` });
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
      if (err.code === 'ER_NO_REFERENCED_ROW_2') { res.status(404).json({ error: 'VOD 강의를 찾을 수 없습니다.' }); return; }
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

// 기존 사이트(public/)는 /v1 하위로 이전. 신규 루트(피그마 디자인)와 분리.
app.use('/v1', express.static(path.join(__dirname, 'public')));

app.get(/^\/v1(\/.*)?$/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 신규 루트: 피그마 디자인 기반 페이지
app.use(express.static(path.join(__dirname, 'public-figma')));

// 강의 상세페이지 시안 (확장자 없이 /classDetail로 접근)
app.get('/classDetail', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-figma', 'classDetail.html'));
});

// 클라이언트 라우팅(history.pushState)으로만 존재하는 가상 경로 새로고침/직접 접근 대응.
// 정적 파일로 못 찾은 경로 중 확장자 없는(=페이지) 요청은 index.html을 내려 SPA가 알아서 그리게 한다.
app.get(/^\/(?!v1|api|admin|uploads).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public-figma', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
