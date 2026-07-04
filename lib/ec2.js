const {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand
} = require('@aws-sdk/client-ec2');

let client;

function getEc2Client() {
  if (!client) {
    client = new EC2Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

async function getInstanceState(instanceId) {
  const res = await getEc2Client().send(new DescribeInstancesCommand({
    InstanceIds: [instanceId]
  }));
  return res.Reservations[0].Instances[0].State.Name;
}

// 운영 서버가 새 업로드 작업을 큐에 보내기 전에 호출 — 워커가 stopped 상태면 깨움
async function wakeWorkerInstance() {
  const instanceId = process.env.WORKER_INSTANCE_ID;
  const state = await getInstanceState(instanceId);
  if (state === 'stopped') {
    await getEc2Client().send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  }
  return state;
}

// 워커 인스턴스가 유휴 상태일 때 자기 자신을 정지 (워커 쪽에서만 사용)
async function stopSelf(instanceId) {
  return getEc2Client().send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

module.exports = { getEc2Client, getInstanceState, wakeWorkerInstance, stopSelf };
