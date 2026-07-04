const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} = require('@aws-sdk/client-sqs');

let client;

function getSqsClient() {
  if (!client) {
    client = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

async function sendVideoJob({ videoId, rawKey, title }) {
  return getSqsClient().send(new SendMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MessageBody: JSON.stringify({ videoId, rawKey, title })
  }));
}

async function receiveVideoJobs(maxMessages = 5) {
  const res = await getSqsClient().send(new ReceiveMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MaxNumberOfMessages: Math.min(maxMessages, 10),
    WaitTimeSeconds: 20,
    VisibilityTimeout: 21600 // 6시간 — 20~30GB 영상 트랜스코딩이 길게 걸릴 수 있어 여유있게 설정
  }));
  return res.Messages || [];
}

async function deleteMessage(receiptHandle) {
  return getSqsClient().send(new DeleteMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    ReceiptHandle: receiptHandle
  }));
}

module.exports = { getSqsClient, sendVideoJob, receiveVideoJobs, deleteMessage };
