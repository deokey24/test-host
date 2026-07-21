// ── 공지사항 카테고리 (기본 접힘 — 펼치기/접기 토글) ──
let noticeCategoriesCache = [];

function noticeCatRowHtml(cat) {
  return `
    <li class="drag-item" data-id="${cat.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <input type="text" class="notice-cat-name-input" value="${escapeHtml(cat.name)}">
      </div>
      <button type="button" class="row-btn danger" data-remove-cat="${cat.id}">삭제</button>
    </li>
  `;
}

function renderNoticeCategoryOptions() {
  const sel = document.getElementById('nfCategory');
  const current = sel.value;
  sel.innerHTML = '<option value="">없음</option>' +
    noticeCategoriesCache.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  if (current && noticeCategoriesCache.some(c => c.name === current)) sel.value = current;
}

async function loadNoticeCategories() {
  const rows = await apiFetch('/admin/api/notice-categories');
  noticeCategoriesCache = rows;
  const listEl = document.getElementById('notice-cat-list');
  listEl.innerHTML = rows.map(noticeCatRowHtml).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/notice-categories/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    noticeCategoriesCache = ids.map(id => noticeCategoriesCache.find(c => String(c.id) === String(id)));
  });
  renderNoticeCategoryOptions();
}

function initNoticeCategoryToggle() {
  const toggleBtn = document.getElementById('notice-cat-toggle');
  const body = document.getElementById('notice-cat-body');
  toggleBtn.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    toggleBtn.textContent = isOpen ? '펼치기' : '접기';
  });
}

function initNoticeCategories() {
  const listEl = document.getElementById('notice-cat-list');
  const status = document.getElementById('notice-cat-status');
  const newInput = document.getElementById('notice-cat-new');

  document.getElementById('notice-cat-add').addEventListener('click', async () => {
    const name = newInput.value.trim();
    if (!name) return;
    try {
      await apiFetch('/admin/api/notice-categories', {
        method: 'POST', body: JSON.stringify({ name, sort_order: listEl.children.length })
      });
      newInput.value = '';
      await loadNoticeCategories();
      setStatus(status, '추가되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('notice-cat-add').click(); }
  });

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.removeCat;
    if (!id) return;
    if (!confirm('이 카테고리를 삭제할까요?')) return;
    try {
      await apiFetch(`/admin/api/notice-categories/${id}`, { method: 'DELETE' });
      await loadNoticeCategories();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  listEl.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('notice-cat-name-input')) return;
    const row = e.target.closest('.drag-item');
    const id = row.dataset.id;
    try {
      await apiFetch(`/admin/api/notice-categories/${id}`, {
        method: 'PUT', body: JSON.stringify({ name: e.target.value.trim() })
      });
      // 이름이 바뀌면 이미 그려둔 목록/셀렉트에 남아있는 옛 이름도 새로고침해야 한다.
      await loadNoticeCategories();
      await loadNotices();
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 공지사항 목록 (표 + 작성/수정 페이지) ──
let noticeCache = [];
let currentNoticeId = null;
let noticeEditor = null;

function getNoticeEditor() {
  if (!noticeEditor) {
    noticeEditor = new toastui.Editor({
      el: document.getElementById('nfBodyEditor'),
      height: '420px',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      language: 'ko-KR',
      hooks: {
        addImageBlobHook: async (blob, callback) => {
          try {
            const file = blob instanceof File ? blob : new File([blob], 'image.png', { type: blob.type });
            const { url } = await uploadImage(file, 'notice', currentNoticeId || 'new');
            callback(url, 'image');
          } catch (err) {
            alert(err.message);
          }
          return false;
        }
      }
    });
  }
  return noticeEditor;
}

function noticeRowHtml(item) {
  return `
    <tr>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${item.pinned ? '고정' : '-'}</td>
      <td>${escapeHtml(item.date || '')}</td>
      <td>
        <button class="row-btn" data-edit-notice="${item.id}">수정</button>
        <button class="row-btn danger" data-delete-notice="${item.id}">삭제</button>
      </td>
    </tr>
  `;
}

async function loadNotices() {
  noticeCache = await apiFetch('/admin/api/notices');
  document.getElementById('noticeTotal').textContent = noticeCache.length;
  document.getElementById('notice-list').innerHTML = noticeCache.length
    ? noticeCache.map(noticeRowHtml).join('')
    : '<tr><td colspan="5" style="color:var(--text-soft);">등록된 공지사항이 없습니다.</td></tr>';
}

function openNoticeForm() {
  document.getElementById('notice-add').style.display = 'none';
  document.getElementById('noticeFormTitle').style.display = '';
  document.getElementById('noticeFormBody').style.display = '';
  document.getElementById('noticeFormActions').style.display = 'flex';
}

function closeNoticeForm() {
  currentNoticeId = null;
  document.getElementById('notice-add').style.display = '';
  document.getElementById('noticeFormTitle').style.display = 'none';
  document.getElementById('noticeFormBody').style.display = 'none';
  document.getElementById('noticeFormActions').style.display = 'none';
  setStatus(document.getElementById('noticeFormStatus'), '');
}

function fillNoticeForm(item) {
  renderNoticeCategoryOptions();
  document.getElementById('nfCategory').value = item?.category || '';
  document.getElementById('nfTitle').value = item?.title || '';
  document.getElementById('nfPinned').checked = !!item?.pinned;
  getNoticeEditor().setHTML(item?.body || '');
}

function initNotices() {
  document.getElementById('notice-add').addEventListener('click', () => {
    currentNoticeId = null;
    document.getElementById('noticeFormTitle').textContent = '새 공지 작성';
    fillNoticeForm(null);
    setStatus(document.getElementById('noticeFormStatus'), '');
    openNoticeForm();
  });

  document.getElementById('notice-list').addEventListener('click', async (e) => {
    const editId = e.target.dataset.editNotice;
    const deleteId = e.target.dataset.deleteNotice;
    if (editId) {
      const item = noticeCache.find(n => String(n.id) === editId);
      if (!item) return;
      currentNoticeId = item.id;
      document.getElementById('noticeFormTitle').textContent = '공지 수정';
      fillNoticeForm(item);
      setStatus(document.getElementById('noticeFormStatus'), '');
      openNoticeForm();
      document.getElementById('noticeWriteCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (deleteId) {
      const item = noticeCache.find(n => String(n.id) === deleteId);
      if (!item || !confirm(`"${item.title}" 공지를 삭제하시겠습니까?`)) return;
      try {
        await apiFetch(`/admin/api/notices/${deleteId}`, { method: 'DELETE' });
        await loadNotices();
      } catch (err) {
        alert(err.message);
      }
    }
  });

  document.getElementById('noticeCancelBtn').addEventListener('click', closeNoticeForm);

  document.getElementById('noticeSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('noticeFormStatus');
    const body = {
      category: document.getElementById('nfCategory').value,
      title: document.getElementById('nfTitle').value.trim(),
      body: getNoticeEditor().getHTML(),
      pinned: document.getElementById('nfPinned').checked
    };
    if (!body.title) {
      setStatus(status, '제목을 입력해주세요.', 'error');
      return;
    }
    try {
      if (currentNoticeId) {
        await apiFetch(`/admin/api/notices/${currentNoticeId}`, { method: 'PUT', body: JSON.stringify(body) });
        setStatus(status, '저장되었습니다.', 'ok');
      } else {
        await apiFetch('/admin/api/notices', { method: 'POST', body: JSON.stringify(body) });
        setStatus(status, '작성되었습니다.', 'ok');
      }
      await loadNotices();
      closeNoticeForm();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initNoticeCategoryToggle();
  initNoticeCategories();
  initNotices();
  await loadNoticeCategories();
  await loadNotices();
});
