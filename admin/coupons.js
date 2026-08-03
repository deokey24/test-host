// ── 쿠폰관리 (coupons 테이블 발급/조회/회수) ──
const COUPON_PAGE_SIZE = 20;
let couponPage = 1;
let couponSearchVal = '';
let couponStatusFilterVal = '';
let couponSearchDebounce = null;

const COUPON_STATUS_BADGE = { '미등록': 'badge-off', '등록됨': 'badge-uploading', '사용완료': 'badge-done' };

function couponDiscountText(c) {
  return c.discount_type === 'percent'
    ? `${c.discount_value}%`
    : `${Number(c.discount_value).toLocaleString('ko-KR')}원`;
}

function couponRowHtml(c) {
  const memberText = c.member_name ? `${escapeHtml(c.member_name)} <span class="field-hint">(${escapeHtml(c.member_username)})</span>` : '-';
  const canDelete = c.status === '미등록';
  return `
    <tr>
      <td style="font-family:monospace; letter-spacing:.03em;">${escapeHtml(c.code)}</td>
      <td>${escapeHtml(c.vod_course_title || '전체 강좌 공통')}</td>
      <td>${couponDiscountText(c)}</td>
      <td>${escapeHtml(c.label || '-')}</td>
      <td><span class="badge ${COUPON_STATUS_BADGE[c.status] || ''}">${escapeHtml(c.status)}</span></td>
      <td>${memberText}</td>
      <td>${new Date(c.created_at).toLocaleString('ko-KR')}</td>
      <td>${c.used_at ? new Date(c.used_at).toLocaleString('ko-KR') : '-'}</td>
      <td>${canDelete ? `<button class="row-btn danger" data-coupon-delete="${c.id}" type="button">삭제</button>` : '-'}</td>
    </tr>
  `;
}

async function loadCoupons() {
  const params = new URLSearchParams({ page: couponPage, pageSize: COUPON_PAGE_SIZE });
  if (couponSearchVal) params.set('search', couponSearchVal);
  if (couponStatusFilterVal) params.set('status', couponStatusFilterVal);

  const { total, page, pageSize, rows } = await apiFetch(`/admin/api/coupons?${params}`);

  document.getElementById('couponTotal').textContent = total;
  document.getElementById('couponList').innerHTML = rows.length
    ? rows.map(couponRowHtml).join('')
    : '<tr><td colspan="9" class="field-hint">발급된 쿠폰이 없습니다.</td></tr>';

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('couponPageInfo').textContent = `${page} / ${totalPages}`;
  document.getElementById('couponPrevBtn').disabled = page <= 1;
  document.getElementById('couponNextBtn').disabled = page >= totalPages;
}

function runCouponSearch() {
  couponSearchVal = document.getElementById('couponSearch').value.trim();
  couponPage = 1;
  loadCoupons();
}

document.getElementById('couponSearchBtn').addEventListener('click', runCouponSearch);
document.getElementById('couponSearch').addEventListener('input', () => {
  clearTimeout(couponSearchDebounce);
  couponSearchDebounce = setTimeout(runCouponSearch, 300);
});
document.getElementById('couponSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(couponSearchDebounce); runCouponSearch(); }
});
document.getElementById('couponStatusFilter').addEventListener('change', (e) => {
  couponStatusFilterVal = e.target.value;
  couponPage = 1;
  loadCoupons();
});
document.getElementById('couponPrevBtn').addEventListener('click', () => {
  if (couponPage > 1) { couponPage--; loadCoupons(); }
});
document.getElementById('couponNextBtn').addEventListener('click', () => {
  couponPage++; loadCoupons();
});

document.getElementById('couponList').addEventListener('click', async (e) => {
  const id = e.target.dataset.couponDelete;
  if (!id) return;
  if (!confirm('이 쿠폰을 삭제할까요? 아직 아무도 등록하지 않은 코드만 삭제할 수 있습니다.')) return;
  try {
    await apiFetch(`/admin/api/coupons/${id}`, { method: 'DELETE' });
    await loadCoupons();
  } catch (err) {
    alert(err.message);
  }
});

// ── 발급 폼 ──
document.getElementById('coupon-discount-type').addEventListener('change', (e) => {
  document.getElementById('coupon-discount-value-label').textContent =
    e.target.value === 'percent' ? '할인율 (%)' : '할인 금액 (원)';
});

document.getElementById('couponIssueBtn').addEventListener('click', async () => {
  const status = document.getElementById('couponIssueStatus');
  const vodCourseId = document.getElementById('coupon-vod-select').value;
  const discountType = document.getElementById('coupon-discount-type').value;
  const discountValue = document.getElementById('coupon-discount-value').value;
  const quantity = document.getElementById('coupon-quantity').value;
  const label = document.getElementById('coupon-label').value.trim();

  if (!discountValue || Number(discountValue) <= 0) {
    setStatus(status, '할인 값을 입력해주세요.', 'error');
    return;
  }
  if (!label) {
    setStatus(status, '쿠폰명을 입력해주세요.', 'error');
    return;
  }

  try {
    const { codes } = await apiFetch('/admin/api/coupons', {
      method: 'POST',
      body: JSON.stringify({ vodCourseId: vodCourseId || null, discountType, discountValue, quantity, label })
    });
    setStatus(status, `${codes.length}개 발급되었습니다.`, 'ok');
    const resultWrap = document.getElementById('couponIssueResult');
    resultWrap.style.display = '';
    document.getElementById('couponIssueResultCodes').innerHTML = codes.map(code => `
      <span class="coupon-code-chip">${escapeHtml(code)}<button type="button" data-copy-code="${escapeHtml(code)}">복사</button></span>
    `).join('');
    await loadCoupons();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('couponIssueResultCodes').addEventListener('click', (e) => {
  const code = e.target.dataset.copyCode;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const original = e.target.textContent;
    e.target.textContent = '복사됨';
    setTimeout(() => { e.target.textContent = original; }, 1500);
  });
});

async function loadCouponVodSelect() {
  const select = document.getElementById('coupon-vod-select');
  const vodCourses = await apiFetch('/admin/api/vod-courses');
  select.innerHTML = '<option value="">전체 강좌 공통(범용 쿠폰)</option>'
    + vodCourses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  loadCouponVodSelect();
  loadCoupons();
});
