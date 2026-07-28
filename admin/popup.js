// ── 팝업 배너 (dock-pass 관리자 팝업배너 기능 이식) ──
const POPUP_POSITION_LABELS = {
  'top-left': '좌상단', top: '상단', 'top-right': '우상단',
  left: '좌측', center: '중앙', right: '우측',
  'bottom-left': '좌하단', bottom: '하단', 'bottom-right': '우하단'
};

let popupCache = [];
let currentPopupId = null;
let newPopupImageUrl = '';

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function weekLaterDateString() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function popupRowHtml(item) {
  return `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <img class="popup-list-thumb" src="${escapeHtml(item.image_url)}" alt="">
      <div class="drag-item-body">
        <div style="font-weight:700;">${escapeHtml(POPUP_POSITION_LABELS[item.position] || item.position)} · ${escapeHtml(item.start_date)} ~ ${escapeHtml(item.end_date)}</div>
        <div style="color:var(--text-soft); font-size:12px;">${item.link_url ? escapeHtml(item.link_url) : '링크 없음'}</div>
      </div>
      <button type="button" class="row-btn${item.visible ? '' : ' danger'}" data-toggle-visible="${item.id}">${item.visible ? '노출중' : '숨김'}</button>
      <button type="button" class="row-btn" data-edit-id="${item.id}">수정</button>
      <button type="button" class="row-btn danger" data-remove-id="${item.id}">삭제</button>
    </li>
  `;
}

async function loadPopups() {
  popupCache = await apiFetch('/admin/api/popup-banners');
  document.getElementById('popupTotal').textContent = popupCache.length;
  const listEl = document.getElementById('popup-list');
  listEl.innerHTML = popupCache.length
    ? popupCache.map(popupRowHtml).join('')
    : '<li class="instr-empty">등록된 팝업 배너가 없습니다.</li>';
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/popup-banners/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    popupCache = ids.map(id => popupCache.find(p => String(p.id) === String(id)));
  });
}

function setPopupPosition(position) {
  document.querySelectorAll('#popup-position-grid .popup-position-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.position === position);
  });
}

function getSelectedPopupPosition() {
  const selected = document.querySelector('#popup-position-grid .popup-position-btn.selected');
  return selected ? selected.dataset.position : 'center';
}

function resetPopupForm() {
  currentPopupId = null;
  newPopupImageUrl = '';
  document.getElementById('popupFormTitle').textContent = '새 팝업 배너 추가';
  document.getElementById('popup-link').value = '';
  document.getElementById('popup-start-date').value = todayDateString();
  document.getElementById('popup-end-date').value = weekLaterDateString();
  document.getElementById('popup-visible').checked = true;
  setPopupPosition('center');
  const preview = document.getElementById('popup-preview');
  preview.src = '';
  preview.classList.remove('on');
  document.getElementById('popup-preview-empty').classList.remove('off');
  document.getElementById('popup-file').value = '';
  document.getElementById('popupSaveBtn').textContent = '추가';
  document.getElementById('popupCancelBtn').style.display = 'none';
  setStatus(document.getElementById('popupFormStatus'), '');
}

function fillPopupForm(item) {
  currentPopupId = item.id;
  newPopupImageUrl = item.image_url;
  document.getElementById('popupFormTitle').textContent = '팝업 배너 수정';
  document.getElementById('popup-link').value = item.link_url || '';
  document.getElementById('popup-start-date').value = item.start_date;
  document.getElementById('popup-end-date').value = item.end_date;
  document.getElementById('popup-visible').checked = !!item.visible;
  setPopupPosition(item.position);
  const preview = document.getElementById('popup-preview');
  preview.src = item.image_url;
  preview.classList.add('on');
  document.getElementById('popup-preview-empty').classList.add('off');
  document.getElementById('popupSaveBtn').textContent = '저장';
  document.getElementById('popupCancelBtn').style.display = '';
  setStatus(document.getElementById('popupFormStatus'), '');
}

function initPopups() {
  resetPopupForm();

  document.getElementById('popup-position-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.popup-position-btn');
    if (!btn) return;
    setPopupPosition(btn.dataset.position);
  });

  document.getElementById('popup-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('popupFormStatus');
    setStatus(status, '이미지 업로드 중...');
    try {
      const { url } = await uploadImage(file, 'popup', currentPopupId || 'new');
      newPopupImageUrl = url;
      const preview = document.getElementById('popup-preview');
      preview.src = url;
      preview.classList.add('on');
      document.getElementById('popup-preview-empty').classList.add('off');
      setStatus(status, '이미지가 준비되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('popupSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('popupFormStatus');
    const body = {
      image_url: newPopupImageUrl,
      link_url: document.getElementById('popup-link').value.trim(),
      position: getSelectedPopupPosition(),
      start_date: document.getElementById('popup-start-date').value,
      end_date: document.getElementById('popup-end-date').value,
      visible: document.getElementById('popup-visible').checked
    };
    if (!body.image_url) { setStatus(status, '이미지를 업로드해주세요.', 'error'); return; }
    if (!body.start_date || !body.end_date) { setStatus(status, '노출 시작일/종료일을 입력해주세요.', 'error'); return; }
    if (body.end_date < body.start_date) { setStatus(status, '종료일은 시작일보다 빠를 수 없습니다.', 'error'); return; }
    try {
      if (currentPopupId) {
        await apiFetch(`/admin/api/popup-banners/${currentPopupId}`, { method: 'PUT', body: JSON.stringify(body) });
        setStatus(status, '저장되었습니다.', 'ok');
      } else {
        await apiFetch('/admin/api/popup-banners', {
          method: 'POST', body: JSON.stringify({ ...body, sort_order: popupCache.length })
        });
        setStatus(status, '추가되었습니다.', 'ok');
      }
      resetPopupForm();
      await loadPopups();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  document.getElementById('popupCancelBtn').addEventListener('click', resetPopupForm);

  document.getElementById('popup-list').addEventListener('click', async (e) => {
    const status = document.getElementById('popup-list-status');
    const editId = e.target.dataset.editId;
    const removeId = e.target.dataset.removeId;
    const toggleId = e.target.dataset.toggleVisible;

    if (editId) {
      const item = popupCache.find(p => String(p.id) === editId);
      if (!item) return;
      fillPopupForm(item);
      document.getElementById('popupWriteCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (toggleId) {
      const item = popupCache.find(p => String(p.id) === toggleId);
      if (!item) return;
      try {
        await apiFetch(`/admin/api/popup-banners/${toggleId}`, {
          method: 'PUT', body: JSON.stringify({ visible: !item.visible })
        });
        await loadPopups();
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
      return;
    }

    if (removeId) {
      if (!confirm('이 팝업 배너를 삭제할까요?')) return;
      try {
        await apiFetch(`/admin/api/popup-banners/${removeId}`, { method: 'DELETE' });
        if (String(currentPopupId) === removeId) resetPopupForm();
        await loadPopups();
        setStatus(status, '삭제되었습니다.', 'ok');
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initPopups();
  await loadPopups();
});
