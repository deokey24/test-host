const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
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

async function main() {
  const pool = getPool();
  const [rows] = await pool.query('SELECT id, image_url FROM cert_posts');
  const postByOriginalId = new Map(posts.map(p => [String(p.id), p]));

  for (const row of rows) {
    // image_url: /uploads/site/cert-post/<originalId>/<uuid>.<ext>
    const match = row.image_url.match(/^\/uploads\/(site\/cert-post\/(\d+)\/[^/]+)$/);
    if (!match) { console.log(`스킵(형식 불일치): id=${row.id} ${row.image_url}`); continue; }
    const [, key, originalId] = match;
    const post = postByOriginalId.get(originalId);
    if (!post) { console.log(`스킵(원본 매핑 없음): id=${row.id} ${row.image_url}`); continue; }

    const localPath = path.join(SRC_DIR, post.image);
    const before = fs.statSync(localPath).size;
    const optimized = await sharp(localPath)
      .rotate()
      .resize({ width: 960, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: optimized,
      ContentType: 'image/jpeg'
    }));
    console.log(`id=${row.id} ${key}: ${(before / 1024).toFixed(0)}KB -> ${(optimized.length / 1024).toFixed(0)}KB`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
