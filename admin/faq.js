// ── 타이틀 ──
async function initFaqHero() {
  const data = await loadHomeSectionDataFor('faq', 'hero');
  document.getElementById('faq-hero-title').value = data.title || '';
  document.getElementById('faq-hero-body').value = data.body || '';
  document.getElementById('faq-hero-save').addEventListener('click', async () => {
    const status = document.getElementById('faq-hero-status');
    try {
      await apiFetch('/admin/api/site/faq/hero', {
        method: 'PUT',
        body: JSON.stringify({
          title: document.getElementById('faq-hero-title').value.trim(),
          body: document.getElementById('faq-hero-body').value.trim()
        })
      });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── FAQ 항목 관리 ──
function faqItemRowHtml(item) {
  return `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <div class="field-row">
          <label class="field-label">질문</label>
          <input type="text" class="faq-q-input" value="${escapeHtml(item.question)}">
        </div>
        <div class="field-row">
          <label class="field-label">답변</label>
          <textarea class="faq-a-input" rows="2">${escapeHtml(item.answer)}</textarea>
        </div>
      </div>
      <button type="button" class="row-btn danger drag-item-remove" data-remove-faq="${item.id}">삭제</button>
    </li>
  `;
}

async function loadFaqItems() {
  const rows = await apiFetch('/admin/api/faq-items');
  const listEl = document.getElementById('faq-item-list');
  listEl.innerHTML = rows.map(faqItemRowHtml).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/faq-items/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
  });
}

function initFaqItems() {
  const listEl = document.getElementById('faq-item-list');
  const status = document.getElementById('faq-item-status');

  document.getElementById('faq-item-add').addEventListener('click', async () => {
    try {
      await apiFetch('/admin/api/faq-items', {
        method: 'POST',
        body: JSON.stringify({ question: '새 질문', answer: '답변을 입력하세요.', sort_order: listEl.children.length })
      });
      await loadFaqItems();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.removeFaq;
    if (!id) return;
    if (!confirm('이 항목을 삭제할까요?')) return;
    try {
      await apiFetch(`/admin/api/faq-items/${id}`, { method: 'DELETE' });
      await loadFaqItems();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  listEl.addEventListener('change', async (e) => {
    const row = e.target.closest('.drag-item');
    if (!row) return;
    const id = row.dataset.id;
    const payload = {};
    if (e.target.classList.contains('faq-q-input')) payload.question = e.target.value.trim();
    if (e.target.classList.contains('faq-a-input')) payload.answer = e.target.value.trim();
    if (Object.keys(payload).length === 0) return;
    try {
      await apiFetch(`/admin/api/faq-items/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initFaqHero();
  initFaqItems();
  loadFaqItems();
});
