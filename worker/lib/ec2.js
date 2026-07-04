const { EC2Client, StopInstancesCommand } = require('@aws-sdk/client-ec2');

let client;
let cachedInstanceId;

function getEc2Client() {
  if (!client) {
    client = new EC2Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

// IMDSv2로 이 인스턴스 자신의 instance-id를 조회
async function getSelfInstanceId() {
  if (cachedInstanceId) return cachedInstanceId;

  const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' }
  });
  const token = await tokenRes.text();

  const idRes = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
    headers: { 'X-aws-ec2-metadata-token': token }
  });
  cachedInstanceId = await idRes.text();
  return cachedInstanceId;
}

async function stopSelf() {
  const instanceId = await getSelfInstanceId();
  return getEc2Client().send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

module.exports = { getSelfInstanceId, stopSelf };
