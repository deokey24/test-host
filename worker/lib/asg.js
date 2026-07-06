const {
  AutoScalingClient,
  TerminateInstanceInAutoScalingGroupCommand
} = require('@aws-sdk/client-auto-scaling');

const { getSelfInstanceId } = require('./ec2');

let client;

function getAsgClient() {
  if (!client) {
    client = new AutoScalingClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

// 유휴 상태의 워커가 자기 자신을 종료하면서 ASG desired capacity도 함께 낮춘다.
// scale-in protection이 걸려 있어 ASG가 임의로 인스턴스를 고르는 일은 없고,
// 종료 시점은 항상 워커 자신이 결정한다 (진행 중인 작업이 없을 때만 호출할 것).
async function terminateSelfViaAsg() {
  const instanceId = await getSelfInstanceId();
  return getAsgClient().send(new TerminateInstanceInAutoScalingGroupCommand({
    InstanceId: instanceId,
    ShouldDecrementDesiredCapacity: true
  }));
}

module.exports = { terminateSelfViaAsg };
