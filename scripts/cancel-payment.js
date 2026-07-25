// 테스트 결제 정리용 CLI. 관리자 웹 라우트가 아직 없어 우선 스크립트로 제공한다.
// 사용법: node --env-file-if-exists=.env scripts/cancel-payment.js <orderNumber> [취소사유]
const { getPool } = require('../lib/db');
const payup = require('../lib/payup');

async function main() {
  const [orderNumber, reason] = process.argv.slice(2);
  if (!orderNumber) {
    console.error('사용법: node --env-file-if-exists=.env scripts/cancel-payment.js <orderNumber> [취소사유]');
    process.exit(1);
  }

  const pool = getPool();
  const [[payment]] = await pool.query('SELECT * FROM payments WHERE order_number = ?', [orderNumber]);
  if (!payment) {
    console.error(`주문번호를 찾을 수 없습니다: ${orderNumber}`);
    process.exit(1);
  }
  if (payment.status !== 'approved') {
    console.error(`approved 상태가 아니라 취소할 수 없습니다 (현재 상태: ${payment.status})`);
    process.exit(1);
  }

  console.log(`취소 대상: 주문 ${orderNumber} / 거래번호 ${payment.transaction_id} / ${payment.amount}원 (${payup.BASE_URL})`);
  const result = await payup.cancelPayment({
    transactionId: payment.transaction_id,
    cancelReason: reason || '테스트 결제 취소'
  });

  if (!result.ok) {
    console.error('취소 실패:', JSON.stringify(result.raw, null, 2));
    process.exit(1);
  }

  await pool.query(
    `UPDATE payments SET status = 'canceled', canceled_at = NOW() WHERE order_number = ?`,
    [orderNumber]
  );
  console.log('취소 완료:', JSON.stringify(result.raw.data, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
