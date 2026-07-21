let vodCache = [];
let currentVodId = null;
let vodLecturesCache = [];

async function loadVodCourses() {
  vodCache = await apiFetch('/admin/api/vod-courses');
  document.getElementById('vodTotal').textContent = vodCache.length;
  document.getElementById('vodList').innerHTML = vodCache.map(c => `
    <tr>
      <td>${c.sort_order}</td>
      <td>${escapeHtml(c.title)}</td>
      <td>${escapeHtml(c.category_label || '')}</td>
      <td>${escapeHtml(c.new_price)}</td>
      <td><span class="badge ${c.is_active ? 'badge-on' : 'badge-off'}">${c.is_active ? '노출' : '숨김'}</span></td>
      <td>
        <button class="row-btn" data-edit-vod="${c.id}">수정</button>
        <button class="row-btn danger" data-delete-vod="${c.id}">삭제</button>
      </td>
    </tr>
  `).join('');
}

function openVodModal() { document.getElementById('vodModalOverlay').classList.add('open'); }
function closeVodModal() { document.getElementById('vodModalOverlay').classList.remove('open'); }

function fillVodForm(course) {
  document.getElementById('vfTag').value = course?.tag || '';
  document.getElementById('vfCategoryLabel').value = course?.category_label || '';
  document.getElementById('vfTitle').value = course?.title || '';
  document.getElementById('vfDescription').value = course?.description || '';
  document.getElementById('vfMetaText').value = course?.meta_text || '';
  document.getElementById('vfColorVariant').value = course?.color_variant || 'default';
  document.getElementById('vfOldPrice').value = course?.old_price || '';
  document.getElementById('vfNewPrice').value = course?.new_price || '';
  document.getElementById('vfSortOrder').value = course?.sort_order ?? 0;
  document.getElementById('vfIsBest').checked = !!course?.is_best;
  document.getElementById('vfIsActive').checked = course ? !!course.is_active : true;
}

function readVodForm() {
  return {
    tag: document.getElementById('vfTag').value.trim(),
    category_label: document.getElementById('vfCategoryLabel').value.trim(),
    title: document.getElementById('vfTitle').value.trim(),
    description: document.getElementById('vfDescription').value.trim(),
    meta_text: document.getElementById('vfMetaText').value.trim(),
    color_variant: document.getElementById('vfColorVariant').value,
    old_price: document.getElementById('vfOldPrice').value.trim(),
    new_price: document.getElementById('vfNewPrice').value.trim(),
    sort_order: parseInt(document.getElementById('vfSortOrder').value, 10) || 0,
    is_best: document.getElementById('vfIsBest').checked,
    is_active: document.getElementById('vfIsActive').checked
  };
}

function setLectureSectionVisible(visible) {
  const table = document.getElementById('vodLectureList').closest('table');
  const addRow = document.getElementById('vodLectureAddBtn').closest('div');
  [table, addRow].forEach(el => { if (el) el.style.display = visible ? '' : 'none'; });
}

document.getElementById('vodAddBtn').addEventListener('click', () => {
  currentVodId = null;
  document.getElementById('vodFormTitle').textContent = 'VOD 강의 추가';
  fillVodForm(null);
  setStatus(document.getElementById('vodFormStatus'), '');
  setLectureSectionVisible(false);
  openVodModal();
});

document.getElementById('vodList').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editVod;
  const deleteId = e.target.dataset.deleteVod;
  if (editId) {
    const course = vodCache.find(c => String(c.id) === editId);
    if (!course) return;
    currentVodId = course.id;
    document.getElementById('vodFormTitle').textContent = 'VOD 강의 수정';
    fillVodForm(course);
    setStatus(document.getElementById('vodFormStatus'), '');
    setLectureSectionVisible(true);
    openVodModal();
    await loadVodLectures();
  } else if (deleteId) {
    const course = vodCache.find(c => String(c.id) === deleteId);
    if (!course || !confirm(`"${course.title}"을(를) 삭제할까요? 연결된 강의 목록도 함께 삭제됩니다.`)) return;
    try {
      await apiFetch(`/admin/api/vod-courses/${deleteId}`, { method: 'DELETE' });
      await loadVodCourses();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('vodModalCloseBtn').addEventListener('click', closeVodModal);
document.getElementById('vodModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'vodModalOverlay') closeVodModal();
});

document.getElementById('vodSaveBtn').addEventListener('click', async () => {
  const status = document.getElementById('vodFormStatus');
  const body = readVodForm();
  if (!body.title || !body.new_price) {
    setStatus(status, '강좌명과 판매가는 필수입니다.', 'error');
    return;
  }
  try {
    if (currentVodId) {
      await apiFetch(`/admin/api/vod-courses/${currentVodId}`, { method: 'PUT', body: JSON.stringify(body) });
      setStatus(status, '저장되었습니다.', 'ok');
    } else {
      const result = await apiFetch('/admin/api/vod-courses', { method: 'POST', body: JSON.stringify(body) });
      currentVodId = result.id;
      document.getElementById('vodFormTitle').textContent = 'VOD 강의 수정';
      setStatus(status, '추가되었습니다. 아래에서 커리큘럼을 연결할 수 있습니다.', 'ok');
      setLectureSectionVisible(true);
      await loadVodLectures();
    }
    await loadVodCourses();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

// ── 커리큘럼 스텝 / 영상 연결 ──
async function loadVodLectures() {
  if (!currentVodId) return;
  const [lectures, videos] = await Promise.all([
    apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures`),
    apiFetch('/admin/api/videos')
  ]);
  vodLecturesCache = lectures;
  const linkedKeys = new Set(lectures.map(l => l.video_r2_key).filter(Boolean));
  const doneVideos = videos.filter(v => v.status === 'done' && v.final_r2_key);
  const select = document.getElementById('vodLectureVideoSelect');
  select.innerHTML = '<option value="">(영상 연결 안 함)</option>' +
    doneVideos.map(v => `<option value="${v.id}">${linkedKeys.has(v.final_r2_key) ? '✓ ' : ''}${escapeHtml(v.title)}</option>`).join('');

  document.getElementById('vodLectureList').innerHTML = lectures.length ? lectures.map(l => `
    <tr>
      <td><input type="number" data-lec-num="${l.id}" value="${l.lecture_number}" min="0" style="width:60px; margin-bottom:0;"></td>
      <td><input type="text" data-lec-title="${l.id}" value="${escapeHtml(l.title)}" style="margin-bottom:0;"></td>
      <td style="font-size:11.5px; color:var(--text-soft);">${l.video_r2_key ? escapeHtml(l.video_title || '연결됨') : '미연결'}</td>
      <td><button class="row-btn danger" data-unlink-lec="${l.id}">삭제</button></td>
    </tr>
  `).join('') : '<tr><td colspan="4" style="color:var(--text-soft);">등록된 커리큘럼 스텝이 없습니다.</td></tr>';
}

document.getElementById('vodLectureAddBtn').addEventListener('click', async () => {
  if (!currentVodId) return;
  const status = document.getElementById('vodLectureStatus');
  const videoId = document.getElementById('vodLectureVideoSelect').value;
  const lectureNumber = document.getElementById('vodLectureNumberInput').value;
  const title = document.getElementById('vodLectureTitleInput').value.trim();
  if (lectureNumber === '' || !title) { setStatus(status, '번호와 제목을 입력해주세요.', 'error'); return; }
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures`, {
      method: 'POST',
      body: JSON.stringify({ videoId: videoId || undefined, lectureNumber, title })
    });
    setStatus(status, '추가되었습니다.', 'ok');
    document.getElementById('vodLectureNumberInput').value = '';
    document.getElementById('vodLectureTitleInput').value = '';
    await loadVodLectures();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('vodLectureList').addEventListener('change', async (e) => {
  const numId = e.target.dataset.lecNum;
  const titleId = e.target.dataset.lecTitle;
  const id = numId || titleId;
  if (!id) return;
  const body = numId ? { lectureNumber: e.target.value } : { title: e.target.value };
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    setStatus(document.getElementById('vodLectureStatus'), '수정되었습니다.', 'ok');
    await loadVodLectures();
  } catch (err) {
    setStatus(document.getElementById('vodLectureStatus'), err.message, 'error');
  }
});

document.getElementById('vodLectureList').addEventListener('click', async (e) => {
  const id = e.target.dataset.unlinkLec;
  if (!id) return;
  const lecture = vodLecturesCache.find(l => String(l.id) === id);
  if (!lecture || !confirm(`"${lecture.title}" 스텝을 삭제할까요?`)) return;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${id}`, { method: 'DELETE' });
    await loadVodLectures();
  } catch (err) {
    setStatus(document.getElementById('vodLectureStatus'), err.message, 'error');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  loadVodCourses();
});
