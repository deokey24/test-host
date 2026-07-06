const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand
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

async function presignUploadPart(key, uploadId, partNumber) {
  const command = new UploadPartCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber
  });
  return getSignedUrl(getR2Client(), command, { expiresIn: 3600 });
}

async function completeMultipartUpload(key, uploadId, parts) {
  return getR2Client().send(new CompleteMultipartUploadCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts }
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
  presignPutObject,
  getObject
};
