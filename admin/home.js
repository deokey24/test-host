async function loadHomeSectionData(key) {
  try {
    return await apiFetch(`/admin/api/site/home/${key}`);
  } catch {
    return {};
  }
}

// ── 카드 목록 공용 렌더러 (온라인클래스 / 독편사 VOD소개) ──
function renderCardList(listEl, cards, { withImage, imageScope, withColor }) {
  listEl.innerHTML = cards.map((card, i) => `
    <li class="drag-item" data-id="${i}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        ${withImage ? `
        <div class="image-picker" style="margin-bottom:10px;">
          <div class="image-picker-preview" data-card-preview="${i}" style="width:90px; height:90px; ${withColor ? `background:${escapeHtml(card.color || '#15191c')};` : ''}">
            <img class="preview-img" src="${escapeHtml(card.image || '')}" style="${card.image ? '' : 'display:none;'} ${withColor ? 'object-fit:contain; width:60%; height:60%; margin:auto;' : ''}">
            <div class="empty-note" style="${card.image ? 'display:none;' : ''}">${withColor ? '아이콘' : '이미지'} 없음</div>
          </div>
          <div class="image-picker-controls">
            <div class="file-row"><input type="file" accept="image/*" data-card-image="${i}"></div>
            <div class="status-text" data-card-image-status="${i}"></div>
          </div>
        </div>` : ''}
        ${withColor ? `
        <div class="field-row">
          <label class="field-label">배경 색상</label>
          <div class="color-field" data-card-color="${i}">
            <div class="swatch-wrap"></div>
            <input type="color">
            <span class="hex-label"></span>
          </div>
        </div>` : ''}
        <div class="field-row"><input type="text" data-card-title="${i}" value="${escapeHtml(card.title || '')}" placeholder="카드 제목"></div>
        <div class="field-row"><textarea rows="2" data-card-body="${i}" placeholder="카드 내용">${escapeHtml(card.body || '')}</textarea></div>
      </div>
      <button type="button" class="row-btn danger drag-item-remove" data-card-remove="${i}">삭제</button>
    </li>
  `).join('');

  listEl.querySelectorAll('[data-card-title]').forEach(el => {
    el.addEventListener('change', () => { cards[+el.dataset.cardTitle].title = el.value; });
  });
  listEl.querySelectorAll('[data-card-body]').forEach(el => {
    el.addEventListener('change', () => { cards[+el.dataset.cardBody].body = el.value; });
  });
  listEl.querySelectorAll('[data-card-remove]').forEach(el => {
    el.addEventListener('click', () => {
      cards.splice(+el.dataset.cardRemove, 1);
      renderCardList(listEl, cards, { withImage, imageScope, withColor });
    });
  });
  if (withImage) {
    listEl.querySelectorAll('[data-card-image]').forEach(el => {
      el.addEventListener('change', async () => {
        const i = +el.dataset.cardImage;
        const file = el.files[0];
        if (!file) return;
        const statusEl = listEl.querySelector(`[data-card-image-status="${i}"]`);
        setStatus(statusEl, '업로드 중...');
        try {
          const { url } = await uploadImage(file, imageScope, String(i));
          cards[i].image = url;
          renderCardList(listEl, cards, { withImage, imageScope, withColor });
        } catch (err) {
          setStatus(statusEl, err.message, 'error');
        }
      });
    });
  }
  if (withColor) {
    listEl.querySelectorAll('[data-card-color]').forEach(el => {
      const i = +el.dataset.cardColor;
      initColorPaletteField(el, {
        initial: cards[i].color || '#15191c',
        onChange: (v) => {
          cards[i].color = v;
          const preview = listEl.querySelector(`[data-card-preview="${i}"]`);
          if (preview) preview.style.background = v;
        }
      });
    });
  }

  attachDragReorder(listEl, async (ids) => {
    const reordered = ids.map(id => cards[+id]);
    cards.length = 0;
    cards.push(...reordered);
    renderCardList(listEl, cards, { withImage, imageScope, withColor });
  });
}

// ── 타이틀 (히어로) ──
let heroImagePicker, heroColorPicker;

async function initHeroCard() {
  const data = await loadHomeSectionData('hero');
  document.getElementById('home-hero-badge').value = data.badge || '';
  document.getElementById('home-hero-title').value = data.title || '';
  document.getElementById('home-hero-body').value = data.body || '';
  document.getElementById('home-hero-btn-enabled').checked = data.button ? !!data.button.enabled : true;
  document.getElementById('home-hero-btn-text').value = (data.button && data.button.text) || '';
  updateHeroButtonEnabled();

  heroColorPicker = initColorPaletteField(document.getElementById('home-hero-color'), {
    initial: data.accentColor || '#a98254'
  });
  heroImagePicker = initAspectImagePicker(document.getElementById('home-hero-image'), {
    scope: 'home-hero', resourceId: 'hero',
    initial: data.image || { url: '', ratio: '3:4' }
  });

  document.getElementById('home-hero-btn-enabled').addEventListener('change', updateHeroButtonEnabled);
  document.getElementById('home-hero-save').addEventListener('click', saveHeroCard);
}

function updateHeroButtonEnabled() {
  document.getElementById('home-hero-btn-text').disabled = !document.getElementById('home-hero-btn-enabled').checked;
}

async function saveHeroCard() {
  const status = document.getElementById('home-hero-status');
  const payload = {
    badge: document.getElementById('home-hero-badge').value.trim(),
    accentColor: heroColorPicker.getValue(),
    title: document.getElementById('home-hero-title').value,
    body: document.getElementById('home-hero-body').value,
    button: {
      enabled: document.getElementById('home-hero-btn-enabled').checked,
      text: document.getElementById('home-hero-btn-text').value.trim()
    },
    image: heroImagePicker.getState()
  };
  try {
    await apiFetch('/admin/api/site/home/hero', { method: 'PUT', body: JSON.stringify(payload) });
    setStatus(status, '저장되었습니다.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

// ── 온라인 클래스 ──
let ocCards = [];

async function initOnlineClassCard() {
  const data = await loadHomeSectionData('online_class');
  document.getElementById('home-oc-badge').value = data.badge || '';
  document.getElementById('home-oc-title').value = data.title || '';
  document.getElementById('home-oc-body').value = data.body || '';
  ocCards = Array.isArray(data.cards) ? data.cards : [];
  renderCardList(document.getElementById('home-oc-cards'), ocCards, { withImage: true, imageScope: 'home-online-class', withColor: true });

  document.getElementById('home-oc-add').addEventListener('click', () => {
    ocCards.push({ image: '', title: '', body: '' });
    renderCardList(document.getElementById('home-oc-cards'), ocCards, { withImage: true, imageScope: 'home-online-class', withColor: true });
  });
  document.getElementById('home-oc-save').addEventListener('click', async () => {
    const status = document.getElementById('home-oc-status');
    const payload = {
      badge: document.getElementById('home-oc-badge').value.trim(),
      title: document.getElementById('home-oc-title').value.trim(),
      body: document.getElementById('home-oc-body').value,
      cards: ocCards
    };
    try {
      await apiFetch('/admin/api/site/home/online_class', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 합격 인증 (홈) ──
async function initCertifiedCard() {
  const data = await loadHomeSectionData('certified');
  document.getElementById('home-cert-badge').value = data.badge || '';
  document.getElementById('home-cert-title').value = data.title || '';
  document.getElementById('home-cert-save').addEventListener('click', async () => {
    const status = document.getElementById('home-cert-status');
    const payload = {
      badge: document.getElementById('home-cert-badge').value.trim(),
      title: document.getElementById('home-cert-title').value.trim()
    };
    try {
      await apiFetch('/admin/api/site/home/certified', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── VOD 클래스 (홈) ──
async function initVodListCard() {
  const data = await loadHomeSectionData('vod_list');
  document.getElementById('home-vl-badge').value = data.badge || '';
  document.getElementById('home-vl-title').value = data.title || '';
  document.getElementById('home-vl-save').addEventListener('click', async () => {
    const status = document.getElementById('home-vl-status');
    const payload = {
      badge: document.getElementById('home-vl-badge').value.trim(),
      title: document.getElementById('home-vl-title').value.trim()
    };
    try {
      await apiFetch('/admin/api/site/home/vod_list', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 독편사 VOD소개 (why) ──
let whyCards = [];

async function initWhyCard() {
  const data = await loadHomeSectionData('why');
  document.getElementById('home-why-title').value = data.title || '';
  document.getElementById('home-why-cta').value = data.ctaText || '';
  whyCards = Array.isArray(data.cards) ? data.cards : [];
  renderCardList(document.getElementById('home-why-cards'), whyCards, { withImage: false });

  document.getElementById('home-why-add').addEventListener('click', () => {
    whyCards.push({ title: '', body: '' });
    renderCardList(document.getElementById('home-why-cards'), whyCards, { withImage: false });
  });
  document.getElementById('home-why-save').addEventListener('click', async () => {
    const status = document.getElementById('home-why-status');
    const payload = {
      title: document.getElementById('home-why-title').value.trim(),
      ctaText: document.getElementById('home-why-cta').value.trim(),
      cards: whyCards
    };
    try {
      await apiFetch('/admin/api/site/home/why', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 리뷰 ──
async function initReviewsCard() {
  const data = await loadHomeSectionData('reviews');
  document.getElementById('home-reviews-badge').value = data.badge || '';
  document.getElementById('home-reviews-title').value = data.title || '';
  const cards = Array.isArray(data.cards) ? data.cards : [];
  for (let i = 0; i < 3; i++) {
    document.getElementById(`home-reviews-quote-${i}`).value = (cards[i] && cards[i].quote) || '';
    document.getElementById(`home-reviews-author-${i}`).value = (cards[i] && cards[i].author) || '';
  }
  document.getElementById('home-reviews-save').addEventListener('click', async () => {
    const status = document.getElementById('home-reviews-status');
    const payload = {
      badge: document.getElementById('home-reviews-badge').value.trim(),
      title: document.getElementById('home-reviews-title').value.trim(),
      cards: [0, 1, 2].map(i => ({
        quote: document.getElementById(`home-reviews-quote-${i}`).value.trim(),
        author: document.getElementById(`home-reviews-author-${i}`).value.trim()
      }))
    };
    try {
      await apiFetch('/admin/api/site/home/reviews', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initHeroCard();
  initOnlineClassCard();
  initCertifiedCard();
  initVodListCard();
  initWhyCard();
  initReviewsCard();
});
