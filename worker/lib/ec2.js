// IMDSv2로 이 인스턴스 자신의 instance-id를 조회
let cachedInstanceId;

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

module.exports = { getSelfInstanceId };
