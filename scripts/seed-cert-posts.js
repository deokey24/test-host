const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getPool } = require('../lib/db');

const SRC_DIR = 'C:/Users/user/Desktop/260801_todo/합격수기_10건';
const posts = require(path.join(SRC_DIR, 'posts.json'));

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function uploadImage(localPath, resourceId) {
  const ext = path.extname(localPath).slice(1).toLowerCase();
  const key = `site/cert-post/${resourceId}/${crypto.randomUUID()}.${ext}`;
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: CONTENT_TYPES[ext] || 'image/jpeg'
  }));
  return `/uploads/${key}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function main() {
  const pool = getPool();
  const [delResult] = await pool.query('DELETE FROM cert_posts');
  console.log(`기존 cert_posts ${delResult.affectedRows}건 삭제`);

  for (const post of posts) {
    const imagePath = path.join(SRC_DIR, post.image);
    const imageUrl = await uploadImage(imagePath, post.id);
    const bodyHtml = String(post.content).trim().split('\n').map(line => `<p>${escapeHtml(line)}</p>`).join('');
    const createdAt = `${post.registeredDate || post.date} 00:00:00`;
    await pool.query(
      'INSERT INTO cert_posts (title, author, body, image_url, pinned, is_active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)',
      [post.title, post.writer, bodyHtml, imageUrl, createdAt]
    );
    console.log(`등록: [${post.id}] ${post.title} -> ${imageUrl}`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
