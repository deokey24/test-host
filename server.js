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

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dockAdmin';
const PART_SIZE = 100 * 1024 * 1024; // 100MB

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

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9]{4,19}$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,16}$/;

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
    signupChannel, searchKeyword, referrerCode, emailConsent, smsConsent
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
    req.session.memberId = result.insertId;
    req.session.memberName = name;
    res.json({ ok: true, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
      return;
    }
    throw err;
  }
});

app.post('/api/members/login', async (req, res) => {
  const { username, password } = req.body;
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
  req.session.memberId = member.id;
  req.session.memberName = member.name;
  res.json({ ok: true, name: member.name });
});

app.post('/api/members/logout', (req, res) => {
  delete req.session.memberId;
  delete req.session.memberName;
  res.json({ ok: true });
});

app.get('/api/members/me', (req, res) => {
  if (req.session.memberId) {
    res.json({ loggedIn: true, name: req.session.memberName });
  } else {
    res.json({ loggedIn: false });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
