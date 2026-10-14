// ── 회원목록 (검색/페이지네이션/상세/수강 관리) ──
const MEMBER_PAGE_SIZE = 15;
let memberPage = 1;
let memberSearch = '';
let memberSearchDebounce = null;
// 일괄 삭제용 선택 상태 (현재 페이지 기준 — 페이지/검색/필터가 바뀌면 비운다). id → username
const selectedMembers = new Map();

async function loadMembers() {
  clearMemberSelection();
  const params = new URLSearchParams({ page: memberPage, pageSize: MEMBER_PAGE_SIZE });
  if (memberSearch) params.set('search', memberSearch);
  if (document.getElementById('memberIncludeWithdrawn').checked) params.set('includeWithdrawn', '1');
  const { total, page, pageSize, rows } = await apiFetch(`/admin/api/members?${params}`);

  // 회원 삭제 직후 마지막 페이지가 비면 한 칸 앞으로 당겨 다시 조회한다.
  if (!rows.length && memberPage > 1) {
    memberPage = Math.max(1, Math.ceil(total / pageSize));
    return loadMembers();
  }

  document.getElementById('memberTotal').textContent = total;
  document.getElementById('memberList').innerHTML = rows.map(m => {
    const isNew = m.member_group === '1001';
    const isWithdrawn = m.member_group === 'withdrawn';
    const badge = isWithdrawn
      ? '<span class="badge badge-off">탈퇴</span>'
      : `<span class="badge ${isNew ? 'badge-new' : 'badge-existing'}">${isNew ? '신규' : '기존'}</span>`;
    // 관리자가 웹 브라우저 재생을 허용한 회원 표시 (members.web_player_enabled)
    const webBadge = m.web_player_enabled && !isWithdrawn
      ? ' <span class="badge badge-processing" title="웹 브라우저 재생 허용">웹</span>'
      : '';
    // 탈퇴 회원은 결제기록 보존용이라 상세 열람만 허용하고 강좌 관리는 막는다.
    const enrollCell = isWithdrawn
      ? '-'
      : `<button class="row-btn" data-enroll-member="${m.id}" data-enroll-username="${escapeHtml(m.username)}" type="button">강좌 관리</button>`;
    // 탈퇴 회원은 이미 익명화돼 삭제 대상이 아니므로 체크 불가.
    const checkCell = isWithdrawn
      ? '<input type="checkbox" disabled>'
      : `<input type="checkbox" class="member-select" data-select-member="${m.id}" data-select-username="${escapeHtml(m.username)}">`;
    return `
    <tr>
      <td>${checkCell}</td>
      <td>${badge}${webBadge}</td>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(m.email)}</td>
      <td>${escapeHtml(m.phone || m.mobile)}</td>
      <td>${m.joined_at ? new Date(m.joined_at).toLocaleDateString('ko-KR') : ''}</td>
      <td><button class="row-btn" data-detail-member="${m.id}" type="button">상세</button></td>
      <td>${enrollCell}</td>
    </tr>
  `;
  }).join('');

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('memberPageInfo').textContent = `${page} / ${totalPages}`;
  document.getElementById('memberPrevBtn').disabled = page <= 1;
  document.getElementById('memberNextBtn').disabled = page >= totalPages;
  document.getElementById('memberSelectAll').disabled = !document.querySelector('#memberList .member-select');
}

// ── 회원 일괄 삭제 (체크박스 선택 → 기존 단건 DELETE를 순차 호출, 회원별 트랜잭션·결과 유지) ──
function clearMemberSelection() {
  selectedMembers.clear();
  document.querySelectorAll('#memberList .member-select').forEach(cb => { cb.checked = false; });
  syncMemberSelectionUi();
}

function syncMemberSelectionUi() {
  const boxes = [...document.querySelectorAll('#memberList .member-select')];
  const all = document.getElementById('memberSelectAll');
  all.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
  all.indeterminate = !all.checked && boxes.some(cb => cb.checked);
  document.getElementById('memberBulkDeleteCount').textContent = selectedMembers.size;
  document.getElementById('memberBulkDeleteBtn').style.display = selectedMembers.size ? '' : 'none';
}

document.getElementById('memberList').addEventListener('change', (e) => {
  const cb = e.target.closest('.member-select');
  if (!cb) return;
  if (cb.checked) selectedMembers.set(cb.dataset.selectMember, cb.dataset.selectUsername);
  else selectedMembers.delete(cb.dataset.selectMember);
  syncMemberSelectionUi();
});

document.getElementById('memberSelectAll').addEventListener('change', (e) => {
  document.querySelectorAll('#memberList .member-select').forEach(cb => {
    cb.checked = e.target.checked;
    if (cb.checked) selectedMembers.set(cb.dataset.selectMember, cb.dataset.selectUsername);
    else selectedMembers.delete(cb.dataset.selectMember);
  });
  syncMemberSelectionUi();
});

document.getElementById('memberBulkDeleteBtn').addEventListener('click', async () => {
  const targets = [...selectedMembers.entries()];
  if (!targets.length) return;
  if (!confirm(`선택한 ${targets.length}명의 회원을 삭제할까요?`)) return;

  const btn = document.getElementById('memberBulkDeleteBtn');
  btn.disabled = true; // 처리 중 중복 클릭 방지
  let okCount = 0;
  const failures = [];
  // 동시 요청 대신 순차 호출 — 서버 쪽 회원별 트랜잭션·세션 파기를 그대로 재사용한다.
  for (const [id, username] of targets) {
    try {
      await apiFetch(`/admin/api/members/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmUsername: username })
      });
      okCount++;
    } catch (err) {
      failures.push(`${username}: ${err.message}`);
    }
  }
  btn.disabled = false;

  let msg = `${okCount}명 삭제 완료`;
  if (failures.length) msg += `\n\n실패 ${failures.length}명:\n${failures.join('\n')}`;
  alert(msg);
  await loadMembers();
});

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
document.getElementById('memberIncludeWithdrawn').addEventListener('change', () => {
  memberPage = 1;
  loadMembers();
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

let detailMemberId = null;
let detailMember = null; // 삭제 confirm 문구·confirmUsername 용

async function loadMemberDevices() {
  const list = document.getElementById('memberDeviceList');
  try {
    const rows = await apiFetch(`/admin/api/members/${detailMemberId}/devices`);
    list.innerHTML = rows.length ? rows.map(d => `
      <tr>
        <td>${escapeHtml(d.label || '알 수 없는 기기')}</td>
        <td>${d.isApp ? '앱' : '웹'}</td>
        <td>${escapeHtml(d.ip || '-')}</td>
        <td>${d.lastLoginAt ? new Date(d.lastLoginAt).toLocaleString('ko-KR') : '-'}</td>
        <td><button class="row-btn danger" data-device-remove-id="${d.id}" type="button">삭제</button></td>
      </tr>
    `).join('') : '<tr><td colspan="5" class="field-hint">등록된 기기가 없습니다.</td></tr>';
  } catch (err) {
    list.innerHTML = '<tr><td colspan="5" class="field-hint">기기 목록을 불러오지 못했습니다.</td></tr>';
  }
}

document.getElementById('memberDeviceList').addEventListener('click', async (e) => {
  const removeId = e.target.dataset.deviceRemoveId;
  if (!removeId) return;
  if (!confirm('이 기기를 삭제할까요? 해당 기기는 다시 로그인해야 합니다.')) return;
  const status = document.getElementById('memberDeviceStatus');
  try {
    await apiFetch(`/admin/api/members/${detailMemberId}/devices/${removeId}`, { method: 'DELETE' });
    setStatus(status, '기기가 삭제되었습니다.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
  await loadMemberDevices();
});

async function openMemberDetailModal(memberId) {
  detailMemberId = memberId;
  detailMember = null;
  const body = document.getElementById('memberDetailBody');
  body.innerHTML = '<tr><td>불러오는 중...</td></tr>';
  document.getElementById('memberDeviceList').innerHTML = '<tr><td colspan="5" class="field-hint">불러오는 중...</td></tr>';
  setStatus(document.getElementById('memberDeviceStatus'), '');
  setStatus(document.getElementById('memberDeleteStatus'), '');
  document.getElementById('memberDeleteSection').style.display = 'none';
  document.getElementById('memberWithdrawnNotice').style.display = 'none';
  const webToggle = document.getElementById('memberWebPlayerToggle');
  webToggle.checked = false;
  webToggle.disabled = true; // 상세 로딩 전 토글 방지
  document.getElementById('memberWebPlayerMeta').textContent = '';
  setStatus(document.getElementById('memberWebPlayerStatus'), '');
  document.getElementById('memberDetailModalOverlay').classList.add('open');
  loadMemberDevices();
  // 가입 시 유입(first/last·가입 직전 경로) — admin/journey.js
  if (typeof Journey !== 'undefined') Journey.renderMemberSignup(document.getElementById('memberSignupAttribution'), memberId);

  try {
    const m = await apiFetch(`/admin/api/members/${memberId}`);
    const isWithdrawn = m.member_group === 'withdrawn';
    detailMember = m;
    body.innerHTML = MEMBER_DETAIL_FIELDS.map(([key, label]) => {
      let val = m[key];
      if (key === 'has_password') val = val ? '설정됨' : '미설정';
      else if (key === 'joined_at') val = val ? new Date(val).toLocaleString('ko-KR') : '';
      else if (key === 'birth_date') val = val ? new Date(val).toLocaleDateString('ko-KR') : '';
      else if (key === 'member_group' && isWithdrawn) val = '탈퇴(익명화)';
      else val = escapeHtml(val || '-');
      return `<tr><th style="white-space:nowrap;">${label}</th><td>${val}</td></tr>`;
    }).join('');
    document.getElementById('memberDeleteSection').style.display = isWithdrawn ? 'none' : '';
    document.getElementById('memberWithdrawnNotice').style.display = isWithdrawn ? '' : 'none';
    renderMemberWebPlayer(m);
  } catch (err) {
    body.innerHTML = '<tr><td>회원 정보를 불러오지 못했습니다.</td></tr>';
  }
}

// ── 웹 플레이어 허용 (members.web_player_enabled — 세션 웹 재생만 영향, DockPlayer는 무관) ──
function renderMemberWebPlayer(m) {
  const toggle = document.getElementById('memberWebPlayerToggle');
  const isWithdrawn = m.member_group === 'withdrawn';
  toggle.checked = !!m.web_player_enabled;
  toggle.disabled = isWithdrawn;
  const meta = document.getElementById('memberWebPlayerMeta');
  const updatedAt = m.web_player_updated_at ? new Date(m.web_player_updated_at) : null;
  const ymd = updatedAt
    ? `${updatedAt.getFullYear()}-${String(updatedAt.getMonth() + 1).padStart(2, '0')}-${String(updatedAt.getDate()).padStart(2, '0')}`
    : '';
  meta.textContent = isWithdrawn ? ' 탈퇴 회원은 변경할 수 없습니다.'
    : ymd ? ` ${m.web_player_enabled ? '허용일' : '해제일'} ${ymd}` : '';
}

document.getElementById('memberWebPlayerToggle').addEventListener('change', async (e) => {
  const toggle = e.target;
  const m = detailMember;
  const status = document.getElementById('memberWebPlayerStatus');
  if (!m || m.id != detailMemberId) { // 상세 로딩 전 클릭 방지
    toggle.checked = !toggle.checked;
    return;
  }
  const enabled = toggle.checked;
  toggle.disabled = true; // 요청 중 중복 클릭 방지
  try {
    const r = await apiFetch(`/admin/api/members/${detailMemberId}/web-player`, {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    });
    m.web_player_enabled = r.web_player_enabled;
    m.web_player_updated_at = new Date().toISOString();
    renderMemberWebPlayer(m);
    setStatus(status, '저장됨', 'ok');
    loadMembers().catch(() => {});
  } catch (err) {
    toggle.checked = !enabled;
    setStatus(status, err.message, 'error');
  } finally {
    if (m.member_group !== 'withdrawn') toggle.disabled = false;
  }
});

function closeMemberDetailModal() {
  document.getElementById('memberDetailModalOverlay').classList.remove('open');
}

// ── 회원 삭제 (결제 이력 없으면 완전 삭제, 있으면 익명화 탈퇴 — 판정은 서버가 한다) ──
document.getElementById('memberDeleteBtn').addEventListener('click', async () => {
  const m = detailMember;
  if (!m || m.id != detailMemberId) return; // 상세 로딩 전 클릭 방지
  if (!confirm(`"${m.name || '-'}(${m.username})" 회원을 삭제할까요?`)) return;
  const btn = document.getElementById('memberDeleteBtn');
  btn.disabled = true; // 요청 중 중복 클릭 방지
  try {
    // 서버가 요구하는 아이디 재확인 값은 상세 조회한 아이디를 그대로 실어 보낸다.
    const r = await apiFetch(`/admin/api/members/${detailMemberId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmUsername: m.username })
    });
    closeMemberDetailModal();
    alert(r.mode === 'delete' ? '회원이 삭제되었습니다.' : '탈퇴 처리되었습니다. (결제기록 보존)');
    await loadMembers();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('memberDetailModalCloseBtn').addEventListener('click', closeMemberDetailModal);
document.getElementById('memberDetailModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'memberDetailModalOverlay') closeMemberDetailModal();
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
