const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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

async function createMultipartUpload(key) {
  const res = await getR2Client().send(new CreateMultipartUploadCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
  return res.UploadId;
}

// 20~30GB 업로드는 1시간을 넘길 수 있으므로 파트 URL은 24시간 유효로 발급한다
async function presignUploadPart(key, uploadId, partNumber) {
  const command = new UploadPartCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber
  });
  return getSignedUrl(getR2Client(), command, { expiresIn: 86400 });
}

async function completeMultipartUpload(key, uploadId, parts) {
  return getR2Client().send(new CompleteMultipartUploadCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts }
  }));
}

// S3 호환 삭제는 멱등 — 이미 없는 키를 지워도 에러 없이 성공한다
async function deleteObject(key) {
  return getR2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
}

async function abortMultipartUpload(key, uploadId) {
  return getR2Client().send(new AbortMultipartUploadCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    UploadId: uploadId
  }));
}

async function presignPutObject(key, contentType) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ContentType: contentType
  });
  return getSignedUrl(getR2Client(), command, { expiresIn: 3600 });
}

async function getObject(key) {
  return getR2Client().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
}

module.exports = {
  getR2Client,
  createMultipartUpload,
  presignUploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  deleteObject,
  presignPutObject,
  getObject
};
