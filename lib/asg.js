const {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand
} = require('@aws-sdk/client-auto-scaling');
const { GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { getSqsClient } = require('./sqs');

const ASG_NAME = process.env.WORKER_ASG_NAME || 'dockteacher-worker-asg';
const JOBS_PER_WORKER = 5; // 워커 인스턴스 1대의 동시 트랜스코딩 캡 (worker WORKER_CONCURRENCY와 일치)
const MAX_WORKERS = Number(process.env.WORKER_ASG_MAX || 3);

let client;

function getAsgClient() {
  if (!client) {
    client = new AutoScalingClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

async function getQueueDepth() {
  const res = await getSqsClient().send(new GetQueueAttributesCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
  }));
  return (
    Number(res.Attributes.ApproximateNumberOfMessages || '0') +
    Number(res.Attributes.ApproximateNumberOfMessagesNotVisible || '0')
  );
}

// 큐 깊이에 맞춰 ASG desired capacity를 올린다. 올리기만 하고 절대 내리지 않는다 —
// 내리는 건 유휴 워커 자신(TerminateInstanceInAutoScalingGroup + desired 감소)이다.
// pendingExtra: 아직 SQS에 없지만 곧 도착할 작업 수 (presign 선기동 = 1, 발행 직전 = 1)
async function ensureWorkerCapacity(pendingExtra = 0) {
  const total = await getQueueDepth() + pendingExtra;
  const needed = Math.min(MAX_WORKERS, Math.max(1, Math.ceil(total / JOBS_PER_WORKER)));

  const res = await getAsgClient().send(new DescribeAutoScalingGroupsCommand({
    AutoScalingGroupNames: [ASG_NAME]
  }));
  const group = res.AutoScalingGroups && res.AutoScalingGroups[0];
  if (!group) throw new Error(`ASG를 찾을 수 없음: ${ASG_NAME}`);

  if (needed > group.DesiredCapacity) {
    await getAsgClient().send(new SetDesiredCapacityCommand({
      AutoScalingGroupName: ASG_NAME,
      DesiredCapacity: needed
    }));
    console.log(`워커 스케일아웃: desired ${group.DesiredCapacity} → ${needed} (대기+처리중 ${total}건)`);
  }
  return needed;
}

module.exports = { ensureWorkerCapacity };
