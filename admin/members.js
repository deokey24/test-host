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
  document.getElementById('memberList').innerHTML = rows.map(m => {
    const isNew = m.member_group === '1001';
    return `
    <tr>
      <td><span class="badge ${isNew ? 'badge-new' : 'badge-existing'}">${isNew ? '신규' : '기존'}</span></td>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(m.email)}</td>
      <td>${escapeHtml(m.phone || m.mobile)}</td>
      <td>${m.joined_at ? new Date(m.joined_at).toLocaleDateString('ko-KR') : ''}</td>
      <td><button class="row-btn" data-detail-member="${m.id}" type="button">상세</button></td>
      <td><button class="row-btn" data-enroll-member="${m.id}" data-enroll-username="${escapeHtml(m.username)}" type="button">강좌 관리</button></td>
    </tr>
  `;
  }).join('');

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
  ['birth_date', '생년월일'],
  ['email', '이메일'],
  ['phone', '전화번호'],
  ['mobile', '휴대폰'],
  ['postal_code', '우편번호'],
  ['road_address', '도로명주소'],
  ['detail_address', '상세주소'],
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
      else if (key === 'birth_date') val = val ? new Date(val).toLocaleDateString('ko-KR') : '';
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

// ── 회원별 VOD 강좌 관리 (수강 등록) ──
// 재생 권한(/api/stream/vod-lecture, /api/v1/*)은 member_vod_enrollments만 검사하므로 이 모달은 VOD 강좌만 다룬다.
let enrollMemberId = null;

async function openEnrollModal(memberId, username) {
  enrollMemberId = memberId;
  document.getElementById('enrollModalTitle').textContent = `VOD 강좌 관리 — ${username}`;
  setStatus(document.getElementById('enrollVodStatus'), '');
  document.getElementById('enrollModalOverlay').classList.add('open');

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

// 재생 기록으로 자동 집계된 진도율 — 관리자메모(progress_note)와 달리 손댈 수 없는 읽기 전용 값이다.
function progressCellHtml(r) {
  const pct = r.progress_percent || 0;
  return `
    <div class="vod-progress">
      <div class="vod-progress__bar"><span style="width:${pct}%"></span></div>
      <div class="vod-progress__text">${pct}% · ${r.completed_lectures || 0}/${r.total_lectures || 0}강 완료</div>
      <button class="row-btn" type="button" data-vod-detail-id="${r.vod_course_id}">강의별 보기</button>
    </div>
  `;
}

// 수강 만료일은 관리자가 직접 넣는 값이 아니라, VOD 강좌에 설정된 수강기간(access_days)을
// 등록 시점에 적용해 박아둔 스냅샷(expires_at)이다. 여기서는 그 결과와 근거만 보여준다.
// (강좌의 수강기간을 나중에 줄여도 기존 수강생에게 소급되지 않으므로 expires_at이 실제 기준이다.)
function expiryCellHtml(r) {
  if (!r.effective_expires_at) {
    return '<div>무제한</div><div class="field-hint">강좌에 수강기간 미설정</div>';
  }
  const date = String(r.effective_expires_at).slice(0, 10);
  const enrolled = String(r.enrolled_at).slice(0, 10);
  return `<div><strong>${date}</strong></div><div class="field-hint">등록일 ${enrolled} + ${r.access_days}일</div>`;
}

function formatDuration(seconds) {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

async function loadVodEnrollments() {
  const rows = await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments`);
  document.getElementById('enrollVodList').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}${r.is_ended ? ' <span class="badge badge-off">강좌 종료</span>' : r.is_expired ? ' <span class="badge badge-off">기간 만료</span>' : ''}</td>
      <td>${escapeHtml(r.status || '진행중')}</td>
      <td>${progressCellHtml(r)}</td>
      <td>${expiryCellHtml(r)}</td>
      <td><input type="text" data-vod-note-id="${r.id}" value="${escapeHtml(r.progress_note || '')}" placeholder="관리자 메모" style="width:100%; min-width:180px;"></td>
      <td>${r.source === 'payment' ? '결제' : '관리자'}</td>
      <td><button class="row-btn danger" data-vod-remove-id="${r.id}" type="button">삭제</button></td>
    </tr>
    <tr class="vod-progress-detail" data-vod-detail-row="${r.vod_course_id}" style="display:none;">
      <td colspan="7"><div class="field-hint">불러오는 중...</div></td>
    </tr>
  `).join('') : '<tr><td colspan="7" class="field-hint">등록된 VOD 강좌가 없습니다.</td></tr>';
}

// "강의별 보기" — 그 강좌의 강의 목록과 각 강의의 시청 시간/진도를 펼쳐서 보여준다.
document.getElementById('enrollVodList').addEventListener('click', async (e) => {
  const courseId = e.target.dataset.vodDetailId;
  if (!courseId) return;
  const row = document.querySelector(`[data-vod-detail-row="${courseId}"]`);
  if (!row) return;
  if (row.style.display !== 'none') { row.style.display = 'none'; e.target.textContent = '강의별 보기'; return; }
  row.style.display = '';
  e.target.textContent = '접기';

  const lectures = await apiFetch(`/admin/api/members/${enrollMemberId}/lecture-progress/${courseId}`);
  if (!lectures.length) {
    row.querySelector('td').innerHTML = '<div class="field-hint">등록된 강의가 없습니다.</div>';
    return;
  }
  row.querySelector('td').innerHTML = `
    <table class="vod-progress-table">
      <thead><tr><th style="width:46%;">강의</th><th>영상 길이</th><th>시청 시간</th><th class="progress-cell">진도</th><th>마지막 시청</th></tr></thead>
      <tbody>
        ${lectures.map(l => `
          <tr>
            <td>${escapeHtml(l.title)}</td>
            <td>${formatDuration(l.durationSeconds)}</td>
            <td>${l.watchedSeconds ? formatDuration(l.watchedSeconds) : '-'}</td>
            <td class="progress-cell">${l.completed ? '<span class="progress-done">완료</span>' : l.percent === null ? '-' : `${l.percent}%`}</td>
            <td>${l.lastPlayedAt ? String(l.lastPlayedAt).slice(0, 16).replace('T', ' ') : '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
});

document.getElementById('enrollVodAddBtn').addEventListener('click', async () => {
  const vodCourseId = document.getElementById('enrollVodSelect').value;
  const status = document.getElementById('enrollVodStatus');
  if (!vodCourseId) { setStatus(status, '등록할 VOD 강좌를 선택해주세요.', 'error'); return; }
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

// 상태·수강현황·수강 만료일은 모두 읽기 전용(각각 자동 판정/집계/강좌 수강기간 기반) — 관리자메모만 수정 가능
document.getElementById('enrollVodList').addEventListener('change', async (e) => {
  const noteId = e.target.dataset.vodNoteId;
  if (!noteId) return;
  await apiFetch(`/admin/api/members/${enrollMemberId}/vod-enrollments/${noteId}`, {
    method: 'PUT',
    body: JSON.stringify({ progressNote: e.target.value })
  });
});

document.getElementById('enrollVodList').addEventListener('click', async (e) => {
  const removeId = e.target.dataset.vodRemoveId;
  if (!removeId) return;
  if (!confirm('이 VOD 강좌 등록을 삭제할까요?')) return;
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
