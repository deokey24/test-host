// ── 회원목록 (검색/페이지네이션/상세/수강 관리) ──
const MEMBER_PAGE_SIZE = 15;
let memberPage = 1;
let memberSearch = '';
let memberSearchDebounce = null;

async function loadMembers() {
  const params = new URLSearchParams({ page: memberPage, pageSize: MEMBER_PAGE_SIZE });
  if (memberSearch) params.set('search', memberSearch);
  const { total, page, pageSize, rows } = await apiFetch(`/admin/api/members?${params}`);

  document.getElementById('memberTotal').textContent = total;
  document.getElementById('memberList').innerHTML = rows.map(m => `
    <tr>
      <td>${escapeHtml(m.username)}</td>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(m.email)}</td>
      <td>${escapeHtml(m.phone || m.mobile)}</td>
      <td>${m.joined_at ? new Date(m.joined_at).toLocaleDateString('ko-KR') : ''}</td>
      <td><button class="row-btn" data-detail-member="${m.id}" type="button">상세</button></td>
      <td><button class="row-btn" data-enroll-member="${m.id}" data-enroll-username="${escapeHtml(m.username)}" type="button">강의 관리</button></td>
    </tr>
  `).join('');

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('memberPageInfo').textContent = `${page} / ${totalPages}`;
  document.getElementById('memberPrevBtn').disabled = page <= 1;
  document.getElementById('memberNextBtn').disabled = page >= totalPages;
}

function runMemberSearch() {
  memberSearch = document.getElementById('memberSearch').value.trim();
  memberPage = 1;
  loadMembers();
}

document.getElementById('memberSearchBtn').addEventListener('click', runMemberSearch);
document.getElementById('memberSearch').addEventListener('input', () => {
  clearTimeout(memberSearchDebounce);
  memberSearchDebounce = setTimeout(runMemberSearch, 300);
});
document.getElementById('memberSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(memberSearchDebounce); runMemberSearch(); }
});
document.getElementById('memberPrevBtn').addEventListener('click', () => {
  if (memberPage > 1) { memberPage--; loadMembers(); }
});
document.getElementById('memberNextBtn').addEventListener('click', () => {
  memberPage++; loadMembers();
});
document.getElementById('memberList').addEventListener('click', (e) => {
  const enrollId = e.target.dataset.enrollMember;
  if (enrollId) { openEnrollModal(enrollId, e.target.dataset.enrollUsername); return; }
  const detailId = e.target.dataset.detailMember;
  if (detailId) openMemberDetailModal(detailId);
});

// ── 회원 상세정보 ──
const MEMBER_DETAIL_FIELDS = [
  ['username', '아이디'],
  ['name', '이름'],
  ['email', '이메일'],
  ['phone', '전화번호'],
  ['mobile', '휴대폰'],
  ['member_group', '회원 그룹'],
  ['signup_channel', '가입 경로'],
  ['search_keyword', '검색 키워드'],
  ['referrer_code', '추천인 코드'],
  ['email_marketing_consent', '이메일 마케팅 수신'],
  ['sms_marketing_consent', 'SMS 마케팅 수신'],
  ['has_password', '비밀번호 설정 여부'],
  ['joined_at', '가입일'],
  ['general_notes', '일반 메모'],
  ['consultation_notes', '상담 메모']
];

async function openMemberDetailModal(memberId) {
  const body = document.getElementById('memberDetailBody');
  body.innerHTML = '<tr><td>불러오는 중...</td></tr>';
  document.getElementById('memberDetailModalOverlay').classList.add('open');

  try {
    const m = await apiFetch(`/admin/api/members/${memberId}`);
    body.innerHTML = MEMBER_DETAIL_FIELDS.map(([key, label]) => {
      let val = m[key];
      if (key === 'has_password') val = val ? '설정됨' : '미설정';
      else if (key === 'joined_at') val = val ? new Date(val).toLocaleString('ko-KR') : '';
      else val = escapeHtml(val || '-');
      return `<tr><th style="white-space:nowrap;">${label}</th><td>${val}</td></tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = '<tr><td>회원 정보를 불러오지 못했습니다.</td></tr>';
  }
}

document.getElementById('memberDetailModalCloseBtn').addEventListener('click', () => {
  document.getElementById('memberDetailModalOverlay').classList.remove('open');
});
document.getElementById('memberDetailModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'memberDetailModalOverlay') document.getElementById('memberDetailModalOverlay').classList.remove('open');
});

// ── 회원별 강의 관리 (수강 등록) ──
let enrollMemberId = null;

async function openEnrollModal(memberId, username) {
  enrollMemberId = memberId;
  document.getElementById('enrollModalTitle').textContent = `강의 관리 — ${username}`;
  setStatus(document.getElementById('enrollStatus'), '');
  const select = document.getElementById('enrollClassSelect');
  select.innerHTML = '<option value="">불러오는 중...</option>';
  document.getElementById('enrollModalOverlay').classList.add('open');

  const classes = await apiFetch('/admin/api/classes');
  select.innerHTML = classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await loadEnrollments();

  const vodSelect = document.getElementById('enrollVodSelect');
  vodSelect.innerHTML = '<option value="">불러오는 중...</option>';
  const vodCourses = await apiFetch('/admin/api/vod-courses');
  vodSelect.innerHTML = vodCourses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
  await loadVodEnrollments();
}

function closeEnrollModal() {
  document.getElementById('enrollModalOverlay').classList.remove('open');
  enrollMemberId = null;
}

async function loadEnrollments() {
  const rows = await apiFetch(`/admin/api/members/${enrollMemberId}/enrollments`);
  document.getElementById('enrollList').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>
        <select data-status-id="${r.id}">
          <option value="진행중" ${r.status === '진행중' ? 'selected' : ''}>진행중</option>
          <option value="완료" ${r.status === '완료' ? 'selected' : ''}>완료</option>
        </select>
      </td>
      <td><input type="text" data-note-id="${r.id}" value="${escapeHtml(r.progress_note || '')}" placeholder="예: 10 / 26강" style="width:100px;"></td>
      <td>${r.source === 'payment' ? '결제' : '관리자'}</td>
      <td><button class="row-btn danger" data-remove-id="${r.id}" type="button">삭제</button></td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="field-hint">등록된 강의가 없습니다.</td></tr>';
}

document.getElementById('enrollAddBtn').addEventListener('click', async () => {
  const classId = document.getElementById('enrollClassSelect').value;
  const status = document.getElementById('enrollStatus');
  if (!classId) { setStatus(status, '등록할 클래스를 선택해주세요.', 'error'); return; }
  try {
    await apiFetch(`/admin/api/members/${enrollMemberId}/enrollments`, {
      method: 'POST',
      body: JSON.stringify({ classId })
    });
    setStatus(status, '등록되었습니다.', 'ok');
    await loadEnrollments();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('enrollList').addEventListener('change', async (e) => {
  const statusId = e.target.dataset.statusId;
  const noteId = e.target.dataset.noteId;
  if (statusId) {
    await apiFetch(`/admin/api/members/${enrollMemberId}/enrollments/${statusId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: e.target.value })
    });
  } else if (noteId) {
    await apiFetch(`/admin/api/members/${enrollMemberId}/enrollments/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ progressNote: e.target.value })
    });
  }
});

document.getElementById('enrollList').addEventListener('click', async (e) => {
  const removeId = e.target.dataset.removeId;
  if (!removeId) return;
  if (!confirm('이 강의 등록을 삭제할까요?')) return;
  await apiFetch(`/admin/api/members/${enrollMemberId}/enrollments/${removeId}`, { method: 'DELETE' });
  await loadEnrollments();
});

async function loadVodEnrollments() {
  const rows = await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments`);
  document.getElementById('enrollVodList').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>
        <select data-vod-status-id="${r.id}">
          <option value="진행중" ${r.status === '진행중' ? 'selected' : ''}>진행중</option>
          <option value="완료" ${r.status === '완료' ? 'selected' : ''}>완료</option>
        </select>
      </td>
      <td><input type="text" data-vod-note-id="${r.id}" value="${escapeHtml(r.progress_note || '')}" placeholder="예: 10 / 26강" style="width:100px;"></td>
      <td>${r.source === 'payment' ? '결제' : '관리자'}</td>
      <td><button class="row-btn danger" data-vod-remove-id="${r.id}" type="button">삭제</button></td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="field-hint">등록된 VOD 강의가 없습니다.</td></tr>';
}

document.getElementById('enrollVodAddBtn').addEventListener('click', async () => {
  const vodCourseId = document.getElementById('enrollVodSelect').value;
  const status = document.getElementById('enrollVodStatus');
  if (!vodCourseId) { setStatus(status, '등록할 VOD 강의를 선택해주세요.', 'error'); return; }
  try {
    await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments`, {
      method: 'POST',
      body: JSON.stringify({ vodCourseId })
    });
    setStatus(status, '등록되었습니다.', 'ok');
    await loadVodEnrollments();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('enrollVodList').addEventListener('change', async (e) => {
  const statusId = e.target.dataset.vodStatusId;
  const noteId = e.target.dataset.vodNoteId;
  if (statusId) {
    await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments/${statusId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: e.target.value })
    });
  } else if (noteId) {
    await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({ progressNote: e.target.value })
    });
  }
});

document.getElementById('enrollVodList').addEventListener('click', async (e) => {
  const removeId = e.target.dataset.vodRemoveId;
  if (!removeId) return;
  if (!confirm('이 VOD 강의 등록을 삭제할까요?')) return;
  await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments/${removeId}`, { method: 'DELETE' });
  await loadVodEnrollments();
});

document.getElementById('enrollModalCloseBtn').addEventListener('click', closeEnrollModal);
document.getElementById('enrollModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'enrollModalOverlay') closeEnrollModal();
});

document.addEventListener('DOMContentLoaded', () => {
  loadMembers();
});
