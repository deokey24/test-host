const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand
} = require('@aws-sdk/client-sqs');

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
    VisibilityTimeout: 21600
  }));
  return res.Messages || [];
}

async function deleteMessage(receiptHandle) {
  return getSqsClient().send(new DeleteMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    ReceiptHandle: receiptHandle
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

module.exports = { getSqsClient, receiveVideoJobs, deleteMessage, isQueueEmpty };
