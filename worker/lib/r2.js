const fs = require('fs');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

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
      Body: fs.createReadStream(srcPath)
    }
  });
  await upload.done();
}

module.exports = { getR2Client, downloadToFile, uploadFromFile };
