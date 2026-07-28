// ── 강사 목록 (instructors) ──
// 추가 폼과 목록 모두 vodDetail.html 히어로의 .prof-strip 카드와 같은 모양으로 렌더한다.
// 썸네일은 cms.js의 uploadImage(scope='instructor')로 R2에 먼저 올리고 URL만 DB에 저장.

let instructorRows = [];
let newInstructorThumb = '';   // 추가 폼에서 업로드해 둔 썸네일 URL

function instructorIntroHtml(intro) {
  const lines = String(intro || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '<p class="instr-intro">소개가 없습니다.</p>';
  return `<p class="instr-intro">${lines.map(l => `· ${escapeHtml(l)}`).join('<br>')}</p>`;
}

function instructorThumbHtml(url, id) {
  const forAttr = id ? `for="instructor-file-${id}"` : '';
  return `<label class="instr-thumb" ${forAttr} title="이미지 선택">
      <img class="instr-thumb-img${url ? ' on' : ''}" src="${url ? escapeHtml(url) : ''}" alt="">
      <span class="instr-thumb-empty${url ? ' off' : ''}">이미지<br>선택</span>
    </label>
    ${id ? `<input type="file" id="instructor-file-${id}" accept="image/*" data-thumb-id="${id}" hidden>` : ''}`;
}

function renderInstructorCard(row) {
  return `<div class="instr-card" data-instructor-id="${row.id}">
    ${instructorThumbHtml(row.thumbnail_url, row.id)}
    <div class="instr-body">
      <span class="instr-name">${escapeHtml(row.name)}</span>
      ${instructorIntroHtml(row.intro)}
    </div>
    <div class="instr-actions">
      <button type="button" class="row-btn" data-edit-id="${row.id}">수정</button>
      <button type="button" class="row-btn danger" data-remove-id="${row.id}">삭제</button>
    </div>
  </div>`;
}

function renderInstructorEditCard(row) {
  return `<div class="instr-card" data-instructor-id="${row.id}">
    ${instructorThumbHtml(row.thumbnail_url, row.id)}
    <div class="instr-body">
      <input type="text" class="instr-name-input" data-edit-name="${row.id}" value="${escapeHtml(row.name)}" placeholder="강사 이름">
      <textarea class="instr-intro-input" data-edit-intro="${row.id}" rows="2" placeholder="강사 소개">${escapeHtml(row.intro || '')}</textarea>
    </div>
    <div class="instr-actions">
      <button type="button" class="row-btn" data-save-id="${row.id}">저장</button>
      <button type="button" class="row-btn" data-cancel-id="${row.id}">취소</button>
    </div>
  </div>`;
}

async function loadInstructors() {
  const listEl = document.getElementById('instructor-list');
  instructorRows = await apiFetch('/admin/api/instructors');
  document.getElementById('instructorTotal').textContent = instructorRows.length;
  listEl.innerHTML = instructorRows.length
    ? instructorRows.map(renderInstructorCard).join('')
    : '<div class="instr-empty">등록된 강사가 없습니다.</div>';
}

function resetInstructorForm() {
  newInstructorThumb = '';
  document.getElementById('instructor-new-name').value = '';
  document.getElementById('instructor-new-intro').value = '';
  const preview = document.getElementById('instructor-new-preview');
  preview.src = '';
  preview.classList.remove('on');
  document.getElementById('instructor-new-empty').classList.remove('off');
  document.getElementById('instructor-new-file').value = '';
}

// ── 추가 폼 ──
document.getElementById('instructor-new-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('instructor-add-status');
  setStatus(status, '썸네일 업로드 중...');
  try {
    const { url } = await uploadImage(file, 'instructor', Date.now());
    newInstructorThumb = url;
    const preview = document.getElementById('instructor-new-preview');
    preview.src = url;
    preview.classList.add('on');
    document.getElementById('instructor-new-empty').classList.add('off');
    setStatus(status, '썸네일이 준비되었습니다. 이름·소개를 입력하고 추가하세요.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

document.getElementById('instructor-add').addEventListener('click', async () => {
  const status = document.getElementById('instructor-add-status');
  const name = document.getElementById('instructor-new-name').value.trim();
  const intro = document.getElementById('instructor-new-intro').value;
  if (!name) { setStatus(status, '강사 이름을 입력해주세요.', 'error'); return; }
  try {
    await apiFetch('/admin/api/instructors', {
      method: 'POST',
      body: JSON.stringify({ name, intro, thumbnail_url: newInstructorThumb, sort_order: instructorRows.length })
    });
    resetInstructorForm();
    setStatus(status, '추가되었습니다.', 'ok');
    await loadInstructors();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('instructor-reset').addEventListener('click', () => {
  resetInstructorForm();
  setStatus(document.getElementById('instructor-add-status'), '');
});

// ── 목록 (수정 / 저장 / 취소 / 삭제 / 썸네일 변경) ──
document.getElementById('instructor-list').addEventListener('click', async (e) => {
  const status = document.getElementById('instructor-list-status');
  const editId = e.target.dataset.editId;
  const cancelId = e.target.dataset.cancelId;
  const saveId = e.target.dataset.saveId;
  const removeId = e.target.dataset.removeId;

  if (editId || cancelId) {
    const id = editId || cancelId;
    const row = instructorRows.find(r => String(r.id) === String(id));
    if (!row) return;
    const cardEl = document.querySelector(`.instr-card[data-instructor-id="${id}"]`);
    cardEl.outerHTML = editId ? renderInstructorEditCard(row) : renderInstructorCard(row);
    setStatus(status, '');
    return;
  }

  if (saveId) {
    const name = document.querySelector(`[data-edit-name="${saveId}"]`).value.trim();
    const intro = document.querySelector(`[data-edit-intro="${saveId}"]`).value;
    if (!name) { setStatus(status, '강사 이름을 입력해주세요.', 'error'); return; }
    try {
      await apiFetch(`/admin/api/instructors/${saveId}`, { method: 'PUT', body: JSON.stringify({ name, intro }) });
      setStatus(status, '저장되었습니다.', 'ok');
      await loadInstructors();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
    return;
  }

  if (removeId) {
    const row = instructorRows.find(r => String(r.id) === String(removeId));
    if (!confirm(`"${row ? row.name : ''}" 강사를 삭제할까요?`)) return;
    try {
      await apiFetch(`/admin/api/instructors/${removeId}`, { method: 'DELETE' });
      setStatus(status, '삭제되었습니다.', 'ok');
      await loadInstructors();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  }
});

document.getElementById('instructor-list').addEventListener('change', async (e) => {
  const id = e.target.dataset.thumbId;
  if (!id) return;
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('instructor-list-status');
  setStatus(status, '썸네일 업로드 중...');
  try {
    const { url } = await uploadImage(file, 'instructor', id);
    await apiFetch(`/admin/api/instructors/${id}`, { method: 'PUT', body: JSON.stringify({ thumbnail_url: url }) });
    setStatus(status, '썸네일이 변경되었습니다.', 'ok');
    await loadInstructors();
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

document.addEventListener('DOMContentLoaded', () => {
  loadInstructors().catch(err => {
    setStatus(document.getElementById('instructor-list-status'), err.message, 'error');
  });
});
