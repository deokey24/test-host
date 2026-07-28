// ── 결제 관리 (payments 테이블 조회/취소/부분취소/수동승인) ──
const PAYMENT_PAGE_SIZE = 20;
let paymentPage = 1;
let paymentSearch = '';
let paymentStatusFilterVal = '';
let paymentSearchDebounce = null;

const PAYMENT_STATUS_LABEL = { pending: '대기중', approved: '승인완료', failed: '실패', canceled: '취소됨' };
const PAYMENT_STATUS_BADGE = { pending: 'badge-uploading', approved: 'badge-done', failed: 'badge-failed', canceled: 'badge-off' };
// PayUp에는 거래 조회 API가 없어서, 브라우저 라운드트립이 중간에 끊긴 pending 건을 서버가 스스로 재확인할
// 방법이 없다. 생성된 지 30분이 지나도 여전히 pending이면 "결제창은 인증됐는데 승인 응답을 못 받은" 것으로
// 의심하고 화면에서 강조 표시한다 — 이게 사실상 유일한 탐지 수단이라 관리자가 눈으로 보고 처리해야 한다.
const PENDING_STALE_MS = 30 * 60 * 1000;

function paymentRowHtml(p) {
  const createdAt = new Date(p.created_at);
  const isStalePending = p.status === 'pending' && (Date.now() - createdAt.getTime() > PENDING_STALE_MS);
  const actions = [];
  if (p.status === 'approved') {
    actions.push(`<button class="row-btn" data-payment-partial="${p.id}" type="button">부분취소</button>`);
    actions.push(`<button class="row-btn danger" data-payment-cancel="${p.id}" type="button">취소</button>`);
  }
  if (isStalePending) {
    actions.push(`<button class="row-btn" data-payment-manual="${p.id}" type="button">수동승인</button>`);
  }
  return `
    <tr${isStalePending ? ' style="background:var(--danger-bg);"' : ''}>
      <td>${escapeHtml(p.order_number)}</td>
      <td>${escapeHtml(p.member_name)} <span class="field-hint">(${escapeHtml(p.member_username)})</span></td>
      <td>${escapeHtml(p.item_name)}</td>
      <td>${Number(p.amount).toLocaleString('ko-KR')}원</td>
      <td>
        <span class="badge ${PAYMENT_STATUS_BADGE[p.status] || ''}">${PAYMENT_STATUS_LABEL[p.status] || p.status}</span>
        ${isStalePending ? '<span class="field-hint" style="color:var(--danger); display:block;">30분 이상 대기 — 확인 필요</span>' : ''}
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
