// ── 섹션 전환 ──
document.querySelectorAll('.side-link').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.side-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    link.classList.add('active');
    const target = document.getElementById(link.dataset.target);
    target.classList.add('active');
    document.getElementById('sectionTitle').textContent = link.textContent.trim();
  });
});

// ── 공용 헬퍼 ──
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

function setStatus(el, message, kind) {
  el.textContent = message;
  el.classList.remove('ok', 'error');
  if (kind) el.classList.add(kind);
}

// ── 범용 이미지 업로드 (presign → PUT → URL 반환) ──
async function uploadImage(file, scope, resourceId) {
  const { key, uploadUrl, url } = await apiFetch('/admin/api/site/upload/presign', {
    method: 'POST',
    body: JSON.stringify({ scope, resourceId, contentType: file.type })
  });
  const putRes = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  if (!putRes.ok) throw new Error('이미지 업로드에 실패했습니다.');
  return { key, url };
}

// ── AspectImagePicker: {url, ratio} 상태를 다루는 이미지 선택 컴포넌트 ──
// containerEl 안에 .ratio-btn[data-ratio], input[type=file], img.preview-img, .empty-note 가 있다고 가정.
function initAspectImagePicker(containerEl, { scope, resourceId, initial, onChange }) {
  const state = { url: initial?.url || '', ratio: initial?.ratio || '1:1' };
  const previewImg = containerEl.querySelector('.preview-img');
  const emptyNote = containerEl.querySelector('.empty-note');
  const fileInput = containerEl.querySelector('input[type="file"]');
  const ratioBtns = containerEl.querySelectorAll('.ratio-btn');
  const statusEl = containerEl.querySelector('.status-text');

  function render() {
    if (state.url) {
      previewImg.src = state.url;
      previewImg.style.display = 'block';
      if (emptyNote) emptyNote.style.display = 'none';
    } else {
      previewImg.style.display = 'none';
      if (emptyNote) emptyNote.style.display = 'block';
    }
    previewImg.style.aspectRatio = state.ratio.replace(':', ' / ');
    if (emptyNote) emptyNote.style.aspectRatio = state.ratio.replace(':', ' / ');
    ratioBtns.forEach(b => b.classList.toggle('selected', b.dataset.ratio === state.ratio));
  }

  ratioBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      state.ratio = btn.dataset.ratio;
      render();
      onChange && onChange({ ...state });
    });
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (statusEl) setStatus(statusEl, '업로드 중...');
    try {
      const { url } = await uploadImage(file, scope, resourceId);
      state.url = url;
      render();
      onChange && onChange({ ...state });
      if (statusEl) setStatus(statusEl, '업로드 완료', 'ok');
    } catch (err) {
      if (statusEl) setStatus(statusEl, err.message, 'error');
    } finally {
      fileInput.value = '';
    }
  });

  render();
  return { getState: () => ({ ...state }), setState: (next) => { Object.assign(state, next); render(); } };
}

// ── ColorPaletteField: 프리셋 스와치 + 커스텀 hex ──
const CMS_COLOR_PRESETS = ['#a98254', '#e3cdaf', '#fee500', '#ffffff', '#15191c'];

function initColorPaletteField(containerEl, { initial, onChange }) {
  let value = initial || CMS_COLOR_PRESETS[0];
  const swatchWrap = containerEl.querySelector('.swatch-wrap');
  const customInput = containerEl.querySelector('input[type="color"]');
  const hexLabel = containerEl.querySelector('.hex-label');

  function render() {
    swatchWrap.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('selected', sw.dataset.color.toLowerCase() === value.toLowerCase());
    });
    customInput.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#a98254';
    hexLabel.textContent = value;
  }

  swatchWrap.innerHTML = CMS_COLOR_PRESETS.map(c =>
    `<button type="button" class="color-swatch" data-color="${c}" style="background:${c};"></button>`
  ).join('');
  swatchWrap.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => { value = sw.dataset.color; render(); onChange && onChange(value); });
  });
  customInput.addEventListener('input', () => { value = customInput.value; render(); onChange && onChange(value); });

  render();
  return { getValue: () => value, setValue: (v) => { value = v; render(); } };
}

// ── SearchableSelect: 텍스트 입력으로 실시간 검색되는 드롭다운 (VOD 커리큘럼 영상 연결 등) ──
// containerEl 안에 input.ss-input, div.ss-dropdown 이 있다고 가정. options: [{id, label}]
document.addEventListener('click', (e) => {
  document.querySelectorAll('.searchable-select .ss-dropdown.open').forEach(dd => {
    if (!dd.closest('.searchable-select').contains(e.target)) dd.classList.remove('open');
  });
});

function initSearchableSelect(containerEl, options, { value, placeholder, emptyLabel, onSelect }) {
  const input = containerEl.querySelector('.ss-input');
  const dropdown = containerEl.querySelector('.ss-dropdown');
  if (placeholder) input.placeholder = placeholder;
  let selectedId = value != null ? String(value) : '';

  function labelFor(id) {
    const opt = options.find(o => String(o.id) === String(id));
    return opt ? opt.label : '';
  }
  input.value = labelFor(selectedId);

  function renderOptions(filterText) {
    const q = (filterText || '').trim().toLowerCase();
    const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
    dropdown.innerHTML = `<div class="ss-option ss-option-muted" data-id="">${escapeHtml(emptyLabel || '(연결 안 함)')}</div>` +
      (filtered.length ? filtered.map(o => `<div class="ss-option" data-id="${escapeHtml(String(o.id))}">${escapeHtml(o.label)}</div>`).join('') : '<div class="ss-option-empty">검색 결과가 없습니다.</div>');
    dropdown.classList.add('open');
  }

  input.addEventListener('focus', () => renderOptions(''));
  input.addEventListener('input', () => renderOptions(input.value));
  input.addEventListener('blur', () => { input.value = labelFor(selectedId); });
  dropdown.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.ss-option[data-id]');
    if (!opt) return;
    e.preventDefault();
    selectedId = opt.dataset.id;
    input.value = labelFor(selectedId);
    dropdown.classList.remove('open');
    onSelect(selectedId);
  });
}

// ── DragReorderList: pointer-capture 드래그 정렬 (admin/v1.html의 카테고리 정렬 로직을 범용화) ──
function attachDragReorder(listEl, onReorder) {
  listEl.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      const dragItem = handle.closest('.drag-item');
      dragItem.classList.add('dragging');
      listEl.setPointerCapture(e.pointerId);
      e.preventDefault();

      const onMove = (ev) => {
        const items = [...listEl.querySelectorAll('.drag-item')];
        const afterItem = items.find(item => {
          if (item === dragItem) return false;
          const rect = item.getBoundingClientRect();
          return ev.clientY < rect.top + rect.height / 2;
        });
        if (afterItem) listEl.insertBefore(dragItem, afterItem);
        else listEl.appendChild(dragItem);
      };

      const onUp = async (ev) => {
        listEl.releasePointerCapture(ev.pointerId);
        listEl.removeEventListener('pointermove', onMove);
        listEl.removeEventListener('pointerup', onUp);
        listEl.removeEventListener('pointercancel', onUp);
        dragItem.classList.remove('dragging');
        const ids = [...listEl.querySelectorAll('.drag-item')].map(item => item.dataset.id);
        await onReorder(ids);
      };

      listEl.addEventListener('pointermove', onMove);
      listEl.addEventListener('pointerup', onUp);
      listEl.addEventListener('pointercancel', onUp);
    });
  });
}
