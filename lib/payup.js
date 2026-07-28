// 페이업(PayUp) 표준결제 연동 — https://developers.payup.co.kr
// accessToken 발급/캐싱 + 결제 승인 요청만 다룬다 (취소/부분취소는 아직 미사용).
const BASE_URL = process.env.PAYUP_ENV === 'live'
  ? 'https://standard.payup.co.kr'
  : 'https://standard.testpayup.co.kr';

const MERCHANT_ID = process.env.PAYUP_MERCHANT_ID;
const API_KEY = process.env.PAYUP_API_KEY;

let cachedToken = null; // { accessToken, expiresAt }

async function fetchAccessToken() {
  const res = await fetch(`${BASE_URL}/auth/v1/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId: MERCHANT_ID, apiKey: API_KEY })
  });
  const data = await res.json();
  if (!res.ok || data.status !== 'SUCCESS') {
    throw new Error(`PayUp accessToken 발급 실패: ${data.message || res.status}`);
  }
  return data.data;
}

// 만료 1분 전에는 미리 갱신해서, 요청 중간에 토큰이 만료되는 것을 피한다.
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.accessToken;
  }
  const tokenData = await fetchAccessToken();
  cachedToken = {
    accessToken: tokenData.accessToken,
    expiresAt: Date.now() + tokenData.accessTokenValidityInSec * 1000
  };
  return cachedToken.accessToken;
}

// 결제 승인 — 표준결제창 인증 완료 후 전달받은 transactionId로 실제 승인을 요청한다.
async function approvePayment({ transactionId, orderNumber, amount }) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${BASE_URL}/api/v1/payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': accessToken
    },
    body: JSON.stringify({ transactionId, merchantId: MERCHANT_ID, orderNumber, amount: String(amount) })
  });
  const data = await res.json();
  const ok = res.ok && data.status === 'SUCCESS' && data.data?.responseCode === '0000';
  return { ok, httpStatus: res.status, raw: data };
}

// 결제 취소 — 승인 완료된 거래를 전체 취소한다.
async function cancelPayment({ transactionId, cancelReason }) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${BASE_URL}/api/v1/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': accessToken
    },
    body: JSON.stringify({ transactionId, cancelReason })
  });
  const data = await res.json();
  const ok = res.ok && data.status === 'SUCCESS' && data.data?.responseCode === '0000';
  return { ok, httpStatus: res.status, raw: data };
}

// 결제 부분 취소 — 승인 완료된 거래 중 일부 금액만 취소한다.
async function partialCancelPayment({ transactionId, cancelAmount, cancelReason }) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${BASE_URL}/api/v1/partCancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': accessToken
    },
    body: JSON.stringify({ transactionId, cancelAmount: String(cancelAmount), cancelReason })
  });
  const data = await res.json();
  const ok = res.ok && data.status === 'SUCCESS' && data.data?.responseCode === '0000';
  return { ok, httpStatus: res.status, raw: data };
}

module.exports = { BASE_URL, MERCHANT_ID, getAccessToken, approvePayment, cancelPayment, partialCancelPayment };
