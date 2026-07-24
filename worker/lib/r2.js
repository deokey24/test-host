const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const pLimit = require('p-limit');

let client;

function getR2Client() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
  }
  return client;
}

async function downloadToFile(key, destPath) {
  const res = await getR2Client().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    res.Body.pipe(writeStream);
    res.Body.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
  });
}

async function uploadFromFile(key, srcPath) {
  const upload = new Upload({
    client: getR2Client(),
    params: {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(srcPath),
      ContentType: 'video/mp4'
    }
  });
  await upload.done();
}

const HLS_CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
};

// localDir 안의 모든 파일(master.m3u8 + segmentNNNNN.ts)을 R2의 `${prefix}/<파일명>`에 업로드한다.
// 인코딩이 끝난 VOD 세그먼트는 이후 절대 바뀌지 않으므로 1년 immutable 캐시를 건다.
async function uploadDirectory(prefix, localDir) {
  const files = await fsp.readdir(localDir);
  const limit = pLimit(8);
  await Promise.all(files.map((file) => limit(async () => {
    const ext = path.extname(file).toLowerCase();
    const upload = new Upload({
      client: getR2Client(),
      params: {
        Bucket: process.env.R2_BUCKET,
        Key: `${prefix}/${file}`,
        Body: fs.createReadStream(path.join(localDir, file)),
        ContentType: HLS_CONTENT_TYPES[ext] || 'application/octet-stream',
        CacheControl: 'public, max-age=31536000, immutable'
      }
    });
    await upload.done();
  })));
}

module.exports = { getR2Client, downloadToFile, uploadFromFile, uploadDirectory };
