// ── 타이틀 ──
async function initCertHero() {
  const data = await loadHomeSectionDataFor('cert', 'hero');
  document.getElementById('cert-hero-title').value = data.title || '';
  document.getElementById('cert-hero-body').value = data.body || '';
  document.getElementById('cert-hero-save').addEventListener('click', async () => {
    const status = document.getElementById('cert-hero-status');
    try {
      await apiFetch('/admin/api/site/cert/hero', {
        method: 'PUT',
        body: JSON.stringify({
          title: document.getElementById('cert-hero-title').value.trim(),
          body: document.getElementById('cert-hero-body').value.trim()
        })
      });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// 페이지 무관 공용 로더 (home.js의 loadHomeSectionData와 동일 패턴, page 인자만 추가)
async function loadHomeSectionDataFor(page, section) {
  try {
    return await apiFetch(`/admin/api/site/${page}/${section}`);
  } catch {
    return {};
  }
}

// ── 그래프 ──
async function initCertChart() {
  const data = await loadHomeSectionDataFor('cert', 'chart');
  document.getElementById('cert-chart-kicker').value = data.kicker || '';
  document.getElementById('cert-chart-percent').value = data.percent ?? '';
  document.getElementById('cert-chart-title').value = data.title || '';
  document.getElementById('cert-chart-highlight').value = data.highlight || '';
  document.getElementById('cert-chart-body').value = data.body || '';
  const bars = Array.isArray(data.bars) && data.bars.length === 4 ? data.bars : [
    { year: '2023', count: 47 }, { year: '2024', count: 74 }, { year: '2025', count: 80 }, { year: '2026', count: 88 }
  ];
  bars.forEach((bar, i) => {
    document.getElementById(`cert-bar-year-${i}`).value = bar.year || '';
    document.getElementById(`cert-bar-count-${i}`).value = bar.count ?? '';
  });

  document.getElementById('cert-chart-save').addEventListener('click', async () => {
    const status = document.getElementById('cert-chart-status');
    const payload = {
      kicker: document.getElementById('cert-chart-kicker').value.trim(),
      percent: parseInt(document.getElementById('cert-chart-percent').value, 10) || 0,
      title: document.getElementById('cert-chart-title').value.trim(),
      highlight: document.getElementById('cert-chart-highlight').value.trim(),
      body: document.getElementById('cert-chart-body').value,
      bars: [0, 1, 2, 3].map(i => ({
        year: document.getElementById(`cert-bar-year-${i}`).value.trim(),
        count: parseInt(document.getElementById(`cert-bar-count-${i}`).value, 10) || 0
      }))
    };
    try {
      await apiFetch('/admin/api/site/cert/chart', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 인증 갤러리 ──
async function loadCertGallery() {
  const rows = await apiFetch('/admin/api/cert-gallery');
  const listEl = document.getElementById('cert-gallery-list');
  listEl.innerHTML = rows.map(r => `
    <li class="drag-item" data-id="${r.id}" style="align-items:center;">
      <span class="drag-handle">☰</span>
      <img src="${escapeHtml(r.image_url)}" style="width:70px; height:70px; object-fit:cover; border-radius:6px;">
      <div class="drag-item-body"></div>
      <button type="button" class="row-btn danger drag-item-remove" data-remove-gallery="${r.id}">삭제</button>
    </li>
  `).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/cert-gallery/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    await loadCertGallery();
  });
}

document.getElementById('cert-gallery-file').addEventListener('change', async () => {
  const fileInput = document.getElementById('cert-gallery-file');
  const file = fileInput.files[0];
  if (!file) return;
  const status = document.getElementById('cert-gallery-upload-status');
  setStatus(status, '업로드 중...');
  try {
    const { url } = await uploadImage(file, 'cert-gallery', Date.now());
    await apiFetch('/admin/api/cert-gallery', { method: 'POST', body: JSON.stringify({ image_url: url }) });
    setStatus(status, '추가되었습니다.', 'ok');
    await loadCertGallery();
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    fileInput.value = '';
  }
});

document.getElementById('cert-gallery-list').addEventListener('click', async (e) => {
  const id = e.target.dataset.removeGallery;
  if (!id) return;
  if (!confirm('이 이미지를 삭제할까요?')) return;
  try {
    await apiFetch(`/admin/api/cert-gallery/${id}`, { method: 'DELETE' });
    await loadCertGallery();
  } catch (err) {
    setStatus(document.getElementById('cert-gallery-upload-status'), err.message, 'error');
  }
});

// ── 합격 인증 게시판(cert_posts) ──
// 공지사항(notice.js)과 같은 "카드 안에서 펼쳐지는 작성 폼 + 아래 목록 표" 패턴.
let certPostCache = [];
let currentCertPostId = null;
let certPostEditor = null;
let certPostImageUrl = '';

function getCertPostEditor() {
  if (!certPostEditor) {
    certPostEditor = new toastui.Editor({
      el: document.getElementById('cpBodyEditor'),
      height: '420px',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      language: 'ko-KR',
      hooks: {
        addImageBlobHook: async (blob, callback) => {
          try {
            const file = blob instanceof File ? blob : new File([blob], 'image.png', { type: blob.type });
            const { url } = await uploadImage(file, 'cert-post', currentCertPostId || 'new');
            callback(url, 'image');
          } catch (err) {
            alert(err.message);
          }
          return false;
        }
      }
    });
  }
  return certPostEditor;
}

function certPostRowHtml(item) {
  return `
    <tr>
      <td>${item.id}</td>
      <td>${escapeHtml(item.title)}${item.pinned ? ' <span class="badge">고정</span>' : ''}</td>
      <td>${escapeHtml(item.author)}</td>
      <td>${item.view_count}</td>
      <td>${escapeHtml(item.created_date)}</td>
      <td>${item.is_active ? '노출' : '숨김'}</td>
      <td>
        <button class="row-btn" data-edit-cert-post="${item.id}">수정</button>
        <button class="row-btn danger" data-delete-cert-post="${item.id}">삭제</button>
      </td>
    </tr>
  `;
}

async function loadCertPosts() {
  certPostCache = await apiFetch('/admin/api/cert-posts');
  document.getElementById('certPostTotal').textContent = certPostCache.length;
  document.getElementById('cert-post-list').innerHTML = certPostCache.length
    ? certPostCache.map(certPostRowHtml).join('')
    : '<tr><td colspan="7" style="color:var(--text-soft);">등록된 인증글이 없습니다.</td></tr>';
}

function openCertPostForm() {
  document.getElementById('cert-post-add').style.display = 'none';
  document.getElementById('certPostFormTitle').style.display = '';
  document.getElementById('certPostFormBody').style.display = '';
  document.getElementById('certPostFormActions').style.display = 'flex';
}

function closeCertPostForm() {
  currentCertPostId = null;
  document.getElementById('cert-post-add').style.display = '';
  document.getElementById('certPostFormTitle').style.display = 'none';
  document.getElementById('certPostFormBody').style.display = 'none';
  document.getElementById('certPostFormActions').style.display = 'none';
  setStatus(document.getElementById('certPostFormStatus'), '');
}

function setCertPostImage(url) {
  certPostImageUrl = url || '';
  const preview = document.getElementById('cpImagePreview');
  preview.src = certPostImageUrl;
  preview.style.display = certPostImageUrl ? '' : 'none';
}

function fillCertPostForm(item) {
  document.getElementById('cpTitle').value = item?.title || '';
  document.getElementById('cpAuthor').value = item?.author || '';
  document.getElementById('cpPinned').checked = !!item?.pinned;
  setCertPostImage(item?.image_url || '');
  setStatus(document.getElementById('cpImageStatus'), '');
  document.getElementById('cpImageFile').value = '';
  getCertPostEditor().setHTML(item?.body || '');
}

function initCertPosts() {
  document.getElementById('cert-post-add').addEventListener('click', () => {
    currentCertPostId = null;
    document.getElementById('certPostFormTitle').textContent = '새 인증글 작성';
    fillCertPostForm(null);
    setStatus(document.getElementById('certPostFormStatus'), '');
    openCertPostForm();
  });

  document.getElementById('cpImageFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('cpImageStatus');
    setStatus(status, '업로드 중...');
    try {
      const { url } = await uploadImage(file, 'cert-post', currentCertPostId || 'new');
      setCertPostImage(url);
      setStatus(status, '업로드되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  document.getElementById('cert-post-list').addEventListener('click', async (e) => {
    const editId = e.target.dataset.editCertPost;
    const deleteId = e.target.dataset.deleteCertPost;
    if (editId) {
      const item = certPostCache.find(p => String(p.id) === editId);
      if (!item) return;
      currentCertPostId = item.id;
      document.getElementById('certPostFormTitle').textContent = '인증글 수정';
      fillCertPostForm(item);
      setStatus(document.getElementById('certPostFormStatus'), '');
      openCertPostForm();
      document.getElementById('certPostWriteCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (deleteId) {
      const item = certPostCache.find(p => String(p.id) === deleteId);
      if (!item || !confirm(`"${item.title}" 글을 삭제하시겠습니까?`)) return;
      try {
        await apiFetch(`/admin/api/cert-posts/${deleteId}`, { method: 'DELETE' });
        await loadCertPosts();
      } catch (err) {
        alert(err.message);
      }
    }
  });

  document.getElementById('certPostCancelBtn').addEventListener('click', closeCertPostForm);

  document.getElementById('certPostSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('certPostFormStatus');
    const body = {
      title: document.getElementById('cpTitle').value.trim(),
      author: document.getElementById('cpAuthor').value.trim(),
      body: getCertPostEditor().getHTML(),
      image_url: certPostImageUrl,
      pinned: document.getElementById('cpPinned').checked
    };
    if (!body.title) { setStatus(status, '제목을 입력해주세요.', 'error'); return; }
    if (!body.author) { setStatus(status, '작성자를 입력해주세요.', 'error'); return; }
    try {
      if (currentCertPostId) {
        await apiFetch(`/admin/api/cert-posts/${currentCertPostId}`, { method: 'PUT', body: JSON.stringify(body) });
        setStatus(status, '저장되었습니다.', 'ok');
      } else {
        await apiFetch('/admin/api/cert-posts', { method: 'POST', body: JSON.stringify(body) });
        setStatus(status, '작성되었습니다.', 'ok');
      }
      await loadCertPosts();
      closeCertPostForm();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initCertHero();
  initCertChart();
  loadCertGallery();
  initCertPosts();
  loadCertPosts();
});
