// ── 결제 관리 (payments 테이블 조회/취소/부분취소/수동승인) ──
const PAYMENT_PAGE_SIZE = 20;
let paymentPage = 1;
let paymentSearch = '';
let paymentStatusFilterVal = '';
let paymentSearchDebounce = null;

const PAYMENT_STATUS_LABEL = { pending: '대기중', approved: '승인', failed: '실패', canceled: '취소됨', expired: '만료' };
const PAYMENT_STATUS_BADGE = { pending: 'badge-uploading', approved: 'badge-done', failed: 'badge-failed', canceled: 'badge-off', expired: 'badge-off' };

// pending은 "결제하기 버튼을 눌러 결제창이 열렸다"는 뜻일 뿐이라, 결제창을 닫고 나간 회원의 행도 여기 남는다.
// 서버(expireStalePendingPayments)가 일정 시간 뒤 그런 행을 expired로 내려주므로, 화면에 계속 대기중으로
// 보이는 건 "방금 결제창을 연 회원"뿐이다 — 그래서 대기중 자체는 경고 없이 그대로 보여준다.
//
// 반대로 pending인 채로 transaction_id가 붙은 행은 서버가 만료시키지 않고 남긴다(승인 요청이 도달했다는 뜻).
// 이건 "카드 승인은 났는데 우리가 결과를 못 받은" 진짜 사고 후보라 빨갛게 강조해서 관리자 눈에 띄게 한다.
function isSuspectPayment(p) {
  return p.status === 'pending' && !!p.transaction_id;
}

function paymentRowHtml(p) {
  const createdAt = new Date(p.created_at);
  const suspect = isSuspectPayment(p);
  const actions = [];
  if (p.status === 'approved') {
    actions.push(`<button class="row-btn" data-payment-partial="${p.id}" type="button">부분취소</button>`);
    actions.push(`<button class="row-btn danger" data-payment-cancel="${p.id}" type="button">취소</button>`);
  }
  // 수동승인 버튼 임시 비활성화
  // if (p.status === 'expired' || suspect) {
  //   actions.push(`<button class="row-btn" data-payment-manual="${p.id}" type="button">수동승인</button>`);
  // }
  return `
    <tr${suspect ? ' style="background:var(--danger-bg);"' : ''}>
      <td>${escapeHtml(p.order_number)}</td>
      <td>${escapeHtml(p.member_name)} <span class="field-hint">(${escapeHtml(p.member_username)})</span></td>
      <td>${escapeHtml(p.item_name)}</td>
      <td>${Number(p.amount).toLocaleString('ko-KR')}원</td>
      <td>
        <span class="badge ${PAYMENT_STATUS_BADGE[p.status] || ''}">${PAYMENT_STATUS_LABEL[p.status] || p.status}</span>
        ${suspect ? '<span class="field-hint" style="color:var(--danger); display:block;">승인 응답 누락 의심 — 확인 필요</span>' : ''}
        ${p.status === 'expired' ? '<span class="field-hint" style="display:block; white-space:nowrap;">미결제</span>' : ''}
      </td>
      <td>${escapeHtml(p.transaction_id || '-')}</td>
      <td>${createdAt.toLocaleString('ko-KR')}</td>
      <td>${actions.join(' ') || '-'}</td>
    </tr>
  `;
}

async function loadPayments() {
  const params = new URLSearchParams({ page: paymentPage, pageSize: PAYMENT_PAGE_SIZE });
  if (paymentSearch) params.set('search', paymentSearch);
  if (paymentStatusFilterVal) params.set('status', paymentStatusFilterVal);

  const { total, page, pageSize, rows } = await apiFetch(`/admin/api/payments?${params}`);

  document.getElementById('paymentTotal').textContent = total;
  document.getElementById('paymentList').innerHTML = rows.length
    ? rows.map(paymentRowHtml).join('')
    : '<tr><td colspan="8" class="field-hint">결제 내역이 없습니다.</td></tr>';

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('paymentPageInfo').textContent = `${page} / ${totalPages}`;
  document.getElementById('paymentPrevBtn').disabled = page <= 1;
  document.getElementById('paymentNextBtn').disabled = page >= totalPages;
}

function runPaymentSearch() {
  paymentSearch = document.getElementById('paymentSearch').value.trim();
  paymentPage = 1;
  loadPayments();
}

document.getElementById('paymentSearchBtn').addEventListener('click', runPaymentSearch);
document.getElementById('paymentSearch').addEventListener('input', () => {
  clearTimeout(paymentSearchDebounce);
  paymentSearchDebounce = setTimeout(runPaymentSearch, 300);
});
document.getElementById('paymentSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(paymentSearchDebounce); runPaymentSearch(); }
});
document.getElementById('paymentStatusFilter').addEventListener('change', (e) => {
  paymentStatusFilterVal = e.target.value;
  paymentPage = 1;
  loadPayments();
});
document.getElementById('paymentPrevBtn').addEventListener('click', () => {
  if (paymentPage > 1) { paymentPage--; loadPayments(); }
});
document.getElementById('paymentNextBtn').addEventListener('click', () => {
  paymentPage++; loadPayments();
});

// ── 취소 / 부분취소 / 수동승인 모달 (동작 종류에 따라 입력 필드만 토글) ──
let paymentActionId = null;
let paymentActionType = null; // 'cancel' | 'partial' | 'manual'

function openPaymentActionModal(id, type) {
  paymentActionId = id;
  paymentActionType = type;
  const titleMap = { cancel: '결제 취소', partial: '결제 부분취소', manual: '결제 수동승인' };
  document.getElementById('paymentActionModalTitle').textContent = titleMap[type];
  document.getElementById('paymentActionAmountRow').style.display = type === 'partial' ? '' : 'none';
  document.getElementById('paymentActionTxnRow').style.display = type === 'manual' ? '' : 'none';
  document.getElementById('paymentActionReasonLabel').textContent = type === 'manual' ? '메모 (사유)' : '취소 사유';
  document.getElementById('paymentActionAmount').value = '';
  document.getElementById('paymentActionTxn').value = '';
  document.getElementById('paymentActionReason').value = '';
  setStatus(document.getElementById('paymentActionStatus'), '');
  document.getElementById('paymentActionModalOverlay').classList.add('open');
}

document.getElementById('paymentList').addEventListener('click', (e) => {
  const cancelId = e.target.dataset.paymentCancel;
  const partialId = e.target.dataset.paymentPartial;
  const manualId = e.target.dataset.paymentManual;
  if (cancelId) openPaymentActionModal(cancelId, 'cancel');
  else if (partialId) openPaymentActionModal(partialId, 'partial');
  else if (manualId) openPaymentActionModal(manualId, 'manual');
});

document.getElementById('paymentActionSubmitBtn').addEventListener('click', async () => {
  const status = document.getElementById('paymentActionStatus');
  const reason = document.getElementById('paymentActionReason').value.trim();

  if (paymentActionType === 'cancel' && !confirm('이 결제를 전액 취소할까요? PayUp 실결제 취소가 함께 진행됩니다.')) return;

  try {
    if (paymentActionType === 'cancel') {
      await apiFetch(`/admin/api/payments/${paymentActionId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    } else if (paymentActionType === 'partial') {
      const cancelAmount = document.getElementById('paymentActionAmount').value;
      if (!cancelAmount || Number(cancelAmount) <= 0) { setStatus(status, '취소 금액을 입력해주세요.', 'error'); return; }
      await apiFetch(`/admin/api/payments/${paymentActionId}/partial-cancel`, { method: 'POST', body: JSON.stringify({ cancelAmount, reason }) });
    } else if (paymentActionType === 'manual') {
      const transactionId = document.getElementById('paymentActionTxn').value.trim();
      await apiFetch(`/admin/api/payments/${paymentActionId}/manual-approve`, { method: 'POST', body: JSON.stringify({ transactionId, note: reason }) });
    }
    document.getElementById('paymentActionModalOverlay').classList.remove('open');
    await loadPayments();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('paymentActionModalCloseBtn').addEventListener('click', () => {
  document.getElementById('paymentActionModalOverlay').classList.remove('open');
});
document.getElementById('paymentActionModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'paymentActionModalOverlay') document.getElementById('paymentActionModalOverlay').classList.remove('open');
});

document.addEventListener('DOMContentLoaded', () => {
  loadPayments();
});
