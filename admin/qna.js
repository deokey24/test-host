// ── Q&A 관리 (강좌별 vod_course_questions 목록/답변/삭제) ──
// 비밀글은 관리자(강사)에게는 항상 전체 공개 — /admin/api/vod-courses/:id/questions는 마스킹 없이 원본을 내려준다.

let qnaCourses = [];
let qnaRows = [];
let qnaCurrentCourseId = '';

function qnaFormatDate(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

async function loadQnaCourseOptions() {
  const sel = document.getElementById('qnaCourseSelect');
  try {
    qnaCourses = await apiFetch('/admin/api/vod-courses');
    sel.innerHTML = '<option value="">강좌를 선택하세요</option>' +
      qnaCourses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">강좌를 선택하세요</option>';
  }
}

function qnaRowHtml(row) {
  const lock = row.is_secret ? '<svg class="qna-lock-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' : '';
  const statusBadge = row.answered_at
    ? '<span class="badge badge-done">답변완료</span>'
    : '<span class="badge badge-off">미답변</span>';
  return `
    <tr data-id="${row.id}">
      <td>${lock}${escapeHtml(row.title)}</td>
      <td>${escapeHtml(row.member_name || '')}</td>
      <td>${statusBadge}</td>
      <td>${qnaFormatDate(row.created_at)}</td>
      <td><button type="button" class="row-btn" data-qna-open="${row.id}">보기/답변</button></td>
    </tr>
  `;
}

async function loadQnaList(courseId) {
  const status = document.getElementById('qna-status');
  const listEl = document.getElementById('qna-list');
  if (!courseId) {
    qnaRows = [];
    listEl.innerHTML = '';
    document.getElementById('qnaTotal').textContent = '0';
    setStatus(status, '강좌를 먼저 선택하세요.');
    return;
  }
  try {
    qnaRows = await apiFetch(`/admin/api/vod-courses/${courseId}/questions`);
    document.getElementById('qnaTotal').textContent = qnaRows.length;
    listEl.innerHTML = qnaRows.length
      ? qnaRows.map(qnaRowHtml).join('')
      : '<tr><td colspan="5" class="field-hint">등록된 질문이 없습니다.</td></tr>';
    setStatus(status, '');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

function qnaDetailHtml(row) {
  const secretNote = row.is_secret ? ' · <b style="color:var(--danger)">비밀글</b>' : '';
  const answerHtml = row.answer
    ? `<div class="qna-detail-answer"><b>답변</b><br>${escapeHtml(row.answer)}</div>`
    : '';
  return `
    <div class="qna-detail-title">${escapeHtml(row.title)}</div>
    <div class="qna-detail-meta">${escapeHtml(row.member_name || '')} · ${qnaFormatDate(row.created_at)}${secretNote}</div>
    <div class="qna-detail-body">${escapeHtml(row.body)}</div>
    ${answerHtml}
  `;
}

function openQnaModal(id) {
  const row = qnaRows.find(r => String(r.id) === String(id));
  if (!row) return;
  document.getElementById('qnaDetailBox').innerHTML = qnaDetailHtml(row);
  document.getElementById('qnaAnswerInput').value = row.answer || '';
  document.getElementById('qnaAnswerInput').dataset.qid = row.id;
  setStatus(document.getElementById('qnaModalStatus'), '');
  document.getElementById('qnaModalOverlay').classList.add('open');
}

function closeQnaModal() {
  document.getElementById('qnaModalOverlay').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  loadQnaCourseOptions();

  document.getElementById('qnaCourseSelect').addEventListener('change', (e) => {
    qnaCurrentCourseId = e.target.value;
    loadQnaList(qnaCurrentCourseId);
  });

  document.getElementById('qna-list').addEventListener('click', (e) => {
    const id = e.target.dataset.qnaOpen;
    if (!id) return;
    openQnaModal(id);
  });

  document.getElementById('qnaModalCloseBtn').addEventListener('click', closeQnaModal);
  document.getElementById('qnaModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'qnaModalOverlay') closeQnaModal();
  });

  document.getElementById('qnaSaveAnswerBtn').addEventListener('click', async () => {
    const modalStatus = document.getElementById('qnaModalStatus');
    const qid = document.getElementById('qnaAnswerInput').dataset.qid;
    const answer = document.getElementById('qnaAnswerInput').value.trim();
    if (!answer) { setStatus(modalStatus, '답변 내용을 입력해주세요.', 'error'); return; }
    try {
      await apiFetch(`/admin/api/vod-courses/${qnaCurrentCourseId}/questions/${qid}`, {
        method: 'PUT', body: JSON.stringify({ answer })
      });
      await loadQnaList(qnaCurrentCourseId);
      openQnaModal(qid);
      setStatus(document.getElementById('qnaModalStatus'), '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(modalStatus, err.message, 'error');
    }
  });

  document.getElementById('qnaDeleteBtn').addEventListener('click', async () => {
    const modalStatus = document.getElementById('qnaModalStatus');
    const qid = document.getElementById('qnaAnswerInput').dataset.qid;
    if (!confirm('이 질문을 삭제할까요? 답변도 함께 삭제됩니다.')) return;
    try {
      await apiFetch(`/admin/api/vod-courses/${qnaCurrentCourseId}/questions/${qid}`, { method: 'DELETE' });
      closeQnaModal();
      await loadQnaList(qnaCurrentCourseId);
    } catch (err) {
      setStatus(modalStatus, err.message, 'error');
    }
  });
});
