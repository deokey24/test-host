const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { getPool } = require('./lib/db');
const r2 = require('./lib/r2');
const { sendVideoJob } = require('./lib/sqs');
const { wakeWorkerInstance } = require('./lib/ec2');
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
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 2 }
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

app.get('/admin/api/videos', requireAdminApi, async (req, res) => {
  const [rows] = await getPool().query(
    'SELECT id, title, status, final_r2_key, error_message, created_at FROM lecture_videos ORDER BY created_at DESC'
  );
  res.json(rows);
});

app.post('/admin/api/videos/presign', requireAdminApi, async (req, res) => {
  const { title, fileSize } = req.body;
  if (!title || !fileSize) {
    res.status(400).json({ error: 'title과 fileSize가 필요합니다.' });
    return;
  }

  const key = `raw/${crypto.randomUUID()}-${title.replace(/[^\w.\-가-힣 ]/g, '')}`;
  const uploadId = await r2.createMultipartUpload(key);

  const [result] = await getPool().query(
    'INSERT INTO lecture_videos (title, raw_r2_key, raw_upload_id, status) VALUES (?, ?, ?, ?)',
    [title, key, uploadId, 'uploading']
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

  res.json({ videoId, partSize: PART_SIZE, urls });
});

app.post('/admin/api/videos/:id/complete', requireAdminApi, async (req, res) => {
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

  await wakeWorkerInstance();
  await sendVideoJob({ videoId: video.id, rawKey: video.raw_r2_key, title: video.title });

  res.json({ ok: true });
});

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

app.use(express.static(path.join(__dirname, 'public')));

// 클라이언트 라우팅(history.pushState)으로만 존재하는 가상 경로 새로고침/직접 접근 대응.
// 정적 파일로 못 찾은 경로 중 확장자 없는(=페이지) 요청은 index.html을 내려 SPA가 알아서 그리게 한다.
app.get(/^\/(?!api|admin).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
