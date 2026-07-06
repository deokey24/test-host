const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand
} = require('@aws-sdk/client-sqs');

// 인스턴스가 처리 도중 죽으면(terminate/스팟 회수) 이 시간 안에 메시지가 다시 보여
// 다른 인스턴스가 재처리한다. 살아있는 동안엔 index.js의 하트비트가 주기적으로 연장.
const VISIBILITY_TIMEOUT_SECONDS = 1800;

let client;

function getSqsClient() {
  if (!client) {
    client = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

async function receiveVideoJobs(maxMessages = 5) {
  const res = await getSqsClient().send(new ReceiveMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MaxNumberOfMessages: Math.min(maxMessages, 10),
    WaitTimeSeconds: 20,
    VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS
  }));
  return res.Messages || [];
}

async function deleteMessage(receiptHandle) {
  return getSqsClient().send(new DeleteMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    ReceiptHandle: receiptHandle
  }));
}

// 처리 중인 메시지의 visibility를 연장 (하트비트)
async function extendVisibility(receiptHandle, seconds = VISIBILITY_TIMEOUT_SECONDS) {
  return getSqsClient().send(new ChangeMessageVisibilityCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    ReceiptHandle: receiptHandle,
    VisibilityTimeout: seconds
  }));
}

async function isQueueEmpty() {
  const res = await getSqsClient().send(new GetQueueAttributesCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
  }));
  const visible = Number(res.Attributes.ApproximateNumberOfMessages || '0');
  const inFlight = Number(res.Attributes.ApproximateNumberOfMessagesNotVisible || '0');
  return visible === 0 && inFlight === 0;
}

module.exports = {
  getSqsClient,
  receiveVideoJobs,
  deleteMessage,
  extendVisibility,
  isQueueEmpty,
  VISIBILITY_TIMEOUT_SECONDS
};
