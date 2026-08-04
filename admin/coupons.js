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

// ── 발급 방식 토글: "코드만 발급" / "학생 지정 발급" ──
let couponMode = 'code';
document.querySelectorAll('input[name="couponMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    couponMode = document.querySelector('input[name="couponMode"]:checked').value;
    document.getElementById('coupon-quantity-row').style.display = couponMode === 'member' ? 'none' : '';
    document.getElementById('coupon-member-picker-row').style.display = couponMode === 'member' ? '' : 'none';
  });
});

// ── 학생 지정 발급: 회원 검색 + 다중 선택 ──
const couponSelectedMembers = new Map(); // id -> {id, name, username}
let couponMemberSearchDebounce = null;
const couponMemberInput = document.getElementById('coupon-member-search-input');
const couponMemberDropdown = document.getElementById('coupon-member-search-dropdown');

async function searchCouponMembers(q) {
  if (!q.trim()) { couponMemberDropdown.classList.remove('open'); return; }
  const { rows } = await apiFetch(`/admin/api/members?page=1&pageSize=20&search=${encodeURIComponent(q.trim())}`);
  couponMemberDropdown.innerHTML = rows.length ? rows.map(m => {
    const already = couponSelectedMembers.has(m.id);
    return `<div class="ss-option${already ? ' ss-option-muted' : ''}" data-member-id="${m.id}" data-member-name="${escapeHtml(m.name)}" data-member-username="${escapeHtml(m.username)}">
      ${escapeHtml(m.name)} <span class="field-hint">(${escapeHtml(m.username)})</span>${already ? ' · 선택됨' : ''}
    </div>`;
  }).join('') : '<div class="ss-option-empty">검색 결과가 없습니다.</div>';
  couponMemberDropdown.classList.add('open');
}

couponMemberInput.addEventListener('input', () => {
  clearTimeout(couponMemberSearchDebounce);
  couponMemberSearchDebounce = setTimeout(() => searchCouponMembers(couponMemberInput.value), 300);
});
couponMemberInput.addEventListener('focus', () => { if (couponMemberInput.value.trim()) searchCouponMembers(couponMemberInput.value); });

couponMemberDropdown.addEventListener('mousedown', (e) => {
  const opt = e.target.closest('.ss-option[data-member-id]');
  if (!opt) return;
  e.preventDefault();
  const id = Number(opt.dataset.memberId);
  couponSelectedMembers.set(id, { id, name: opt.dataset.memberName, username: opt.dataset.memberUsername });
  renderCouponMemberChips();
  couponMemberInput.value = '';
  couponMemberDropdown.classList.remove('open');
});

function renderCouponMemberChips() {
  document.getElementById('coupon-member-chips').innerHTML = [...couponSelectedMembers.values()].map(m => `
    <span class="material-chip">${escapeHtml(m.name)} (${escapeHtml(m.username)})<button type="button" data-remove-member="${m.id}">×</button></span>
  `).join('');
}

document.getElementById('coupon-member-chips').addEventListener('click', (e) => {
  const id = e.target.dataset.removeMember;
  if (!id) return;
  couponSelectedMembers.delete(Number(id));
  renderCouponMemberChips();
});

document.getElementById('couponIssueBtn').addEventListener('click', async () => {
  const status = document.getElementById('couponIssueStatus');
  const vodCourseId = document.getElementById('coupon-vod-select').value;
  const discountType = document.getElementById('coupon-discount-type').value;
  const discountValue = document.getElementById('coupon-discount-value').value;
  const label = document.getElementById('coupon-label').value.trim();

  if (!discountValue || Number(discountValue) <= 0) {
    setStatus(status, '할인 값을 입력해주세요.', 'error');
    return;
  }
  if (!label) {
    setStatus(status, '쿠폰명을 입력해주세요.', 'error');
    return;
  }

  const resultWrap = document.getElementById('couponIssueResult');
  const resultCodes = document.getElementById('couponIssueResultCodes');

  if (couponMode === 'member') {
    const memberIds = [...couponSelectedMembers.keys()];
    if (!memberIds.length) {
      setStatus(status, '학생을 한 명 이상 선택해주세요.', 'error');
      return;
    }
    try {
      const { issued } = await apiFetch('/admin/api/coupons', {
        method: 'POST',
        body: JSON.stringify({ vodCourseId: vodCourseId || null, discountType, discountValue, label, memberIds })
      });
      setStatus(status, `${issued.length}명에게 발급되었습니다.`, 'ok');
      resultWrap.style.display = '';
      resultCodes.innerHTML = issued.map(i => `
        <span class="coupon-code-chip">${escapeHtml(i.name)} (${escapeHtml(i.username)}) — ${escapeHtml(i.code)}<button type="button" data-copy-code="${escapeHtml(i.code)}">복사</button></span>
      `).join('');
      couponSelectedMembers.clear();
      renderCouponMemberChips();
      await loadCoupons();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
    return;
  }

  const quantity = document.getElementById('coupon-quantity').value;
  try {
    const { codes } = await apiFetch('/admin/api/coupons', {
      method: 'POST',
      body: JSON.stringify({ vodCourseId: vodCourseId || null, discountType, discountValue, quantity, label })
    });
    setStatus(status, `${codes.length}개 발급되었습니다.`, 'ok');
    resultWrap.style.display = '';
    resultCodes.innerHTML = codes.map(code => `
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

// ── 발급 템플릿: 자주 쓰는 강좌/할인/쿠폰명 조합을 이름 붙여 저장해두고 다시 불러다 쓴다 ──
let couponTemplates = [];

function couponTemplateOptionLabel(t) {
  const course = t.vod_course_title || '전체 강좌 공통';
  const discount = t.discount_type === 'percent' ? `${t.discount_value}%` : `${Number(t.discount_value).toLocaleString('ko-KR')}원`;
  return `${t.name} — ${course} · ${discount}`;
}

async function loadCouponTemplates() {
  const { rows } = await apiFetch('/admin/api/coupon-templates');
  couponTemplates = rows;
  const select = document.getElementById('coupon-template-select');
  const prevValue = select.value;
  select.innerHTML = '<option value="">템플릿 선택...</option>'
    + couponTemplates.map(t => `<option value="${t.id}">${escapeHtml(couponTemplateOptionLabel(t))}</option>`).join('');
  select.value = couponTemplates.some(t => String(t.id) === prevValue) ? prevValue : '';
  document.getElementById('couponTemplateDeleteBtn').disabled = !select.value;
}

document.getElementById('coupon-template-select').addEventListener('change', (e) => {
  const id = e.target.value;
  document.getElementById('couponTemplateDeleteBtn').disabled = !id;
  if (!id) return;
  const t = couponTemplates.find(t => String(t.id) === id);
  if (!t) return;
  document.getElementById('coupon-vod-select').value = t.vod_course_id || '';
  document.getElementById('coupon-discount-type').value = t.discount_type;
  document.getElementById('coupon-discount-type').dispatchEvent(new Event('change'));
  document.getElementById('coupon-discount-value').value = t.discount_value;
  document.getElementById('coupon-label').value = t.label || '';
});

document.getElementById('couponTemplateDeleteBtn').addEventListener('click', async () => {
  const select = document.getElementById('coupon-template-select');
  const id = select.value;
  if (!id) return;
  const t = couponTemplates.find(t => String(t.id) === id);
  if (!confirm(`"${t ? t.name : ''}" 템플릿을 삭제할까요?`)) return;
  await apiFetch(`/admin/api/coupon-templates/${id}`, { method: 'DELETE' });
  await loadCouponTemplates();
});

document.getElementById('couponTemplateSaveBtn').addEventListener('click', async () => {
  const status = document.getElementById('couponIssueStatus');
  const discountValue = document.getElementById('coupon-discount-value').value;
  const label = document.getElementById('coupon-label').value.trim();
  if (!discountValue || Number(discountValue) <= 0) {
    setStatus(status, '할인 값을 입력해주세요.', 'error');
    return;
  }
  const name = window.prompt('템플릿 이름을 입력하세요', label);
  if (!name || !name.trim()) return;
  try {
    await apiFetch('/admin/api/coupon-templates', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        vodCourseId: document.getElementById('coupon-vod-select').value || null,
        discountType: document.getElementById('coupon-discount-type').value,
        discountValue,
        label
      })
    });
    setStatus(status, '템플릿이 저장되었습니다.', 'ok');
    await loadCouponTemplates();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  loadCouponVodSelect();
  loadCoupons();
  loadCouponTemplates();
});
