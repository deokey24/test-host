// ── 타이틀 ──
async function loadIntroSectionData(section) {
  try {
    return await apiFetch(`/admin/api/site/intro/${section}`);
  } catch {
    return {};
  }
}

async function initIntroHero() {
  const data = await loadIntroSectionData('hero');
  document.getElementById('intro-hero-title').value = data.title || '';
  document.getElementById('intro-hero-body').value = data.body || '';
  document.getElementById('intro-hero-save').addEventListener('click', async () => {
    const status = document.getElementById('intro-hero-status');
    try {
      await apiFetch('/admin/api/site/intro/hero', {
        method: 'PUT',
        body: JSON.stringify({
          title: document.getElementById('intro-hero-title').value.trim(),
          body: document.getElementById('intro-hero-body').value.trim()
        })
      });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 학습소개 탭 관리 (intro.html 좌측 탭 목록 + 탭별 상세 이미지) ──
let introTabRows = [];
let newIntroTabThumb = '';   // 추가 모달에서 업로드해 둔 이미지 URL

function introTabRowHtml(tab) {
  return `
    <li class="drag-item" data-id="${tab.id}">
      <span class="drag-handle">☰</span>
      <label class="instr-thumb" for="intro-tab-file-${tab.id}" title="이미지 변경">
        <img class="instr-thumb-img${tab.image_url ? ' on' : ''}" src="${tab.image_url ? escapeHtml(tab.image_url) : ''}" alt="">
        <span class="instr-thumb-empty${tab.image_url ? ' off' : ''}">이미지<br>선택</span>
      </label>
      <input type="file" id="intro-tab-file-${tab.id}" accept="image/*" data-thumb-id="${tab.id}" hidden>
      <div class="drag-item-body">
        <input type="text" class="intro-tab-label-input" data-id="${tab.id}" value="${escapeHtml(tab.label)}">
      </div>
      <button type="button" class="row-btn danger drag-item-remove" data-remove-tab="${tab.id}">삭제</button>
    </li>
  `;
}

async function loadIntroTabs() {
  introTabRows = await apiFetch('/admin/api/intro-tabs');
  const listEl = document.getElementById('intro-tab-list');
  listEl.innerHTML = introTabRows.length
    ? introTabRows.map(introTabRowHtml).join('')
    : '<li class="field-hint">등록된 탭이 없습니다.</li>';
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/intro-tabs/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
  });
}

function openIntroTabModal() {
  newIntroTabThumb = '';
  document.getElementById('itName').value = '';
  const preview = document.getElementById('itPreview');
  preview.src = '';
  preview.style.display = 'none';
  document.getElementById('itFile').value = '';
  setStatus(document.getElementById('introTabModalStatus'), '');
  document.getElementById('introTabModalOverlay').classList.add('open');
  document.getElementById('itName').focus();
}

function closeIntroTabModal() {
  document.getElementById('introTabModalOverlay').classList.remove('open');
}

function initIntroTabs() {
  const listEl = document.getElementById('intro-tab-list');
  const status = document.getElementById('intro-tab-status');

  document.getElementById('intro-tab-add').addEventListener('click', openIntroTabModal);
  document.getElementById('introTabModalCloseBtn').addEventListener('click', closeIntroTabModal);
  document.getElementById('introTabModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'introTabModalOverlay') closeIntroTabModal();
  });

  document.getElementById('itFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const modalStatus = document.getElementById('introTabModalStatus');
    setStatus(modalStatus, '업로드 중...');
    try {
      const { url } = await uploadImage(file, 'intro', Date.now());
      newIntroTabThumb = url;
      const preview = document.getElementById('itPreview');
      preview.src = url;
      preview.style.display = 'block';
      setStatus(modalStatus, '이미지가 준비되었습니다.', 'ok');
    } catch (err) {
      setStatus(modalStatus, err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('introTabModalSaveBtn').addEventListener('click', async () => {
    const modalStatus = document.getElementById('introTabModalStatus');
    const label = document.getElementById('itName').value.trim();
    if (!label) {
      setStatus(modalStatus, '탭 이름을 입력해주세요.', 'error');
      return;
    }
    try {
      await apiFetch('/admin/api/intro-tabs', {
        method: 'POST',
        body: JSON.stringify({ label, image_url: newIntroTabThumb, sort_order: introTabRows.length })
      });
      await loadIntroTabs();
      closeIntroTabModal();
    } catch (err) {
      setStatus(modalStatus, err.message, 'error');
    }
  });

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.removeTab;
    if (!id) return;
    const tab = introTabRows.find(t => String(t.id) === String(id));
    if (!confirm(`"${tab ? tab.label : ''}" 탭을 삭제할까요?`)) return;
    try {
      await apiFetch(`/admin/api/intro-tabs/${id}`, { method: 'DELETE' });
      await loadIntroTabs();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  listEl.addEventListener('change', async (e) => {
    const thumbId = e.target.dataset.thumbId;
    if (thumbId) {
      const file = e.target.files[0];
      if (!file) return;
      setStatus(status, '이미지 업로드 중...');
      try {
        const { url } = await uploadImage(file, 'intro', thumbId);
        await apiFetch(`/admin/api/intro-tabs/${thumbId}`, { method: 'PUT', body: JSON.stringify({ image_url: url }) });
        setStatus(status, '이미지가 변경되었습니다.', 'ok');
        await loadIntroTabs();
      } catch (err) {
        setStatus(status, err.message, 'error');
      } finally {
        e.target.value = '';
      }
      return;
    }

    if (e.target.classList.contains('intro-tab-label-input')) {
      const id = e.target.dataset.id;
      const label = e.target.value.trim();
      if (!label) { setStatus(status, '탭 이름을 입력해주세요.', 'error'); return; }
      try {
        await apiFetch(`/admin/api/intro-tabs/${id}`, { method: 'PUT', body: JSON.stringify({ label }) });
        setStatus(status, '저장되었습니다.', 'ok');
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initIntroHero();
  initIntroTabs();
  loadIntroTabs();
});
