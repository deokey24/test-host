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

document.addEventListener('DOMContentLoaded', () => {
  initCertHero();
  initCertChart();
  loadCertGallery();
});
