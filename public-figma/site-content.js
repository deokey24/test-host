function resolveCmsPath(data, path) {
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null) ? undefined : acc[key], data);
}

function escapeCmsHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hydrateCmsListItem(node, item, index) {
  if (item.color) node.style.background = item.color;
  const img = node.querySelector('.class-card-icon, img');
  if (img) { if (item.image) img.src = item.image; else img.remove(); }
  const num = node.querySelector('.num, .class-card-num');
  if (num) num.textContent = String(index + 1).padStart(2, '0');
  const h3 = node.querySelector('h3');
  if (h3 && item.title !== undefined) h3.textContent = item.title;
  const p = node.querySelector('p');
  if (p && item.body !== undefined) p.textContent = item.body;
}

function applyCmsData(data) {
  document.querySelectorAll('[data-cms]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cms);
    if (value === undefined || value === null || value === '') return;
    el.textContent = value;
  });

  document.querySelectorAll('[data-cms-lines]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cmsLines);
    if (value === undefined || value === null || value === '') return;
    el.innerHTML = escapeCmsHtml(value).replace(/\n/g, '<br>');
  });

  document.querySelectorAll('[data-cms-button]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cmsButton);
    if (!value) return;
    if (value.enabled === false) { el.style.display = 'none'; return; }
    if (value.text) el.textContent = value.text;
  });

  document.querySelectorAll('[data-cms-image]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cmsImage);
    if (!value || !value.url) return;
    const img = el.querySelector('img');
    if (img) img.src = value.url;
    if (value.ratio) el.style.aspectRatio = value.ratio.replace(':', ' / ');
  });

  document.querySelectorAll('[data-cms-accent]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cmsAccent);
    if (!value) return;
    el.style.setProperty('--hero-accent', value);
  });

  document.querySelectorAll('[data-cms-list]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cmsList);
    if (!Array.isArray(value) || value.length === 0) return;
    const template = el.querySelector('template');
    if (!template) return;
    [...el.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
    value.forEach((item, i) => {
      const node = template.content.firstElementChild.cloneNode(true);
      hydrateCmsListItem(node, item, i);
      el.appendChild(node);
    });
  });
}

function applyCmsSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  const kakao = document.querySelector('.kakao-float');
  if (kakao && settings.kakaoUrl) {
    kakao.href = settings.kakaoUrl;
    kakao.target = settings.kakaoUrl.startsWith('http') ? '_blank' : '_self';
  }
  document.querySelectorAll('.footer-contact .phone').forEach(el => { if (settings.phone) el.textContent = settings.phone; });
  document.querySelectorAll('.footer-contact .hours').forEach(el => { if (settings.hours) el.textContent = settings.hours; });
  if (Array.isArray(settings.footerLines) && settings.footerLines.length) {
    document.querySelectorAll('.footer-brand p').forEach(el => {
      el.innerHTML = settings.footerLines.map(escapeCmsHtml).join('<br>\n');
    });
  }
  document.querySelectorAll('.copyright').forEach(el => { if (settings.copyright) el.textContent = settings.copyright; });
}

// ── VOD 강의(vod_courses) 공용 하이드레이션: vod.html 그리드 / curriculum.html 행 / 홈 미리보기 ──
async function fetchVodCourses() {
  try {
    const res = await fetch('/api/vod-courses');
    if (!res.ok) return null;
    const courses = await res.json();
    return Array.isArray(courses) && courses.length ? courses : null;
  } catch {
    return null;
  }
}

async function fetchVodCourseLectures(courseId) {
  try {
    const res = await fetch(`/api/vod-courses/${courseId}/lectures`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function renderVodCourseCard(node, course) {
  node.dataset.category = course.category_label || '';
  const thumb = node.querySelector('.vod-course-thumb');
  if (thumb && course.color_variant === 'green') thumb.classList.add('green');
  const bestBadge = node.querySelector('.badge-best');
  if (bestBadge) { if (course.is_best) bestBadge.style.display = ''; else bestBadge.remove(); }
  const tag = node.querySelector('.tag'); if (tag) tag.textContent = course.category_label || '';
  const eng = node.querySelector('.eng'); if (eng) eng.textContent = course.tag || '';
  const h3 = node.querySelector('h3'); if (h3) h3.textContent = course.title || '';
  const desc = node.querySelector('.desc, p'); if (desc) desc.textContent = course.description || '';
  const meta = node.querySelector('.meta'); if (meta) meta.textContent = course.meta_text || '';
  const oldEl = node.querySelector('.old, .old-price');
  if (oldEl) { if (course.old_price) oldEl.textContent = course.old_price; else oldEl.remove(); }
  const newEl = node.querySelector('.new, .new-price'); if (newEl) newEl.textContent = course.new_price || '';
  const link = node.querySelector('.curriculum-link');
  if (link) link.href = `classDetail.html?id=${course.id}`;
  node.style.cursor = 'pointer';
  node.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    window.location.href = `classDetail.html?id=${course.id}`;
  });
  return node;
}

const VOD_PAGE_SIZE = 6;

async function hydrateVodGrid() {
  const grid = document.querySelector('[data-cms-vod-courses]');
  const pillsWrap = document.querySelector('[data-cms-vod-pills]');
  const countEl = document.querySelector('[data-cms-vod-count]');
  const paginationEl = document.querySelector('[data-cms-vod-pagination]');
  if (!grid && !pillsWrap && !countEl) return;

  const courses = await fetchVodCourses();
  if (!courses) return;

  if (countEl) countEl.textContent = courses.length;

  let activeFilter = '';
  let currentPage = 1;

  function renderPage() {
    const list = activeFilter ? courses.filter(c => c.category_label === activeFilter) : courses;
    const totalPages = Math.max(1, Math.ceil(list.length / VOD_PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * VOD_PAGE_SIZE;
    const pageItems = list.slice(start, start + VOD_PAGE_SIZE);

    if (grid) {
      const template = grid.querySelector('template');
      if (template) {
        [...grid.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
        pageItems.forEach(course => {
          const node = template.content.firstElementChild.cloneNode(true);
          grid.appendChild(renderVodCourseCard(node, course));
        });
      }
    }

    if (paginationEl) {
      if (totalPages <= 1) {
        paginationEl.innerHTML = '';
      } else {
        let html = `<button type="button" class="vod-page-arrow" data-vod-page="${currentPage - 1}"${currentPage === 1 ? ' disabled' : ''}>‹</button>`;
        for (let p = 1; p <= totalPages; p++) {
          html += `<button type="button" class="${p === currentPage ? 'active' : ''}" data-vod-page="${p}">${p}</button>`;
        }
        html += `<button type="button" class="vod-page-arrow" data-vod-page="${currentPage + 1}"${currentPage === totalPages ? ' disabled' : ''}>›</button>`;
        paginationEl.innerHTML = html;
      }
    }
  }

  if (pillsWrap) {
    const labels = [...new Set(courses.map(c => c.category_label).filter(Boolean))];
    pillsWrap.innerHTML = '<button type="button" class="active" data-filter="">전체</button>' +
      labels.map(l => `<button type="button" data-filter="${escapeCmsHtml(l)}">${escapeCmsHtml(l)}</button>`).join('');

    pillsWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      pillsWrap.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter || '';
      currentPage = 1;
      renderPage();
    });
  }

  if (paginationEl) {
    paginationEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-vod-page]');
      if (!btn || btn.disabled) return;
      currentPage = parseInt(btn.dataset.vodPage, 10) || 1;
      renderPage();
      grid?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  renderPage();
}

async function hydrateVodCurriculum() {
  const wrap = document.querySelector('[data-cms-vod-curriculum]');
  if (!wrap) return;
  const courses = await fetchVodCourses();
  if (!courses) return;
  const template = wrap.querySelector('template');
  if (!template) return;

  const rows = await Promise.all(courses.map(async course => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.id = `course-${course.id}`;
    if (course.color_variant === 'green') node.querySelector('.curriculum-summary').classList.add('green');
    node.querySelector('.eng').textContent = course.tag || '';
    node.querySelector('h3').textContent = course.title || '';
    node.querySelector('.curriculum-summary p').textContent = course.description || '';
    const oldEl = node.querySelector('.old-price');
    if (course.old_price) oldEl.textContent = course.old_price; else oldEl.remove();
    node.querySelector('.new-price').textContent = course.new_price || '';
    node.querySelector('.meta').textContent = course.meta_text || '';

    const steps = await fetchVodCourseLectures(course.id);
    const stepsEl = node.querySelector('.curriculum-steps');
    stepsEl.innerHTML = steps.slice(0, 6).map((step, i) => `
      <li><span class="num">${String(i + 1).padStart(2, '0')}</span><span class="step-title">${escapeCmsHtml(step.title)}</span></li>
    `).join('');
    const moreEl = node.querySelector('.curriculum-more');
    if (moreEl) {
      moreEl.textContent = `전체 ${steps.length}강 보기 +`;
      moreEl.href = `classDetail.html?id=${course.id}`;
    }
    return node;
  }));

  [...wrap.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
  rows.forEach(node => wrap.appendChild(node));
}

async function hydrateHomeVodPreview() {
  const previewWrap = document.querySelector('.vod-preview');
  if (!previewWrap) return;
  const courses = await fetchVodCourses();
  if (!courses) return;
  const course = courses[0];
  const steps = await fetchVodCourseLectures(course.id);

  const kicker = previewWrap.querySelector('.kicker'); if (kicker) kicker.textContent = course.tag || '';
  const h3 = previewWrap.querySelector('.vod-video-card h3'); if (h3) h3.textContent = course.title || '';
  const pill = previewWrap.querySelector('.pill'); if (pill) pill.textContent = course.meta_text || '';
  const intro = previewWrap.querySelector('.intro'); if (intro) intro.textContent = course.description || '';
  const list = previewWrap.querySelector('.curriculum-list');
  if (list && steps.length) {
    list.innerHTML = steps.map((step, i) => `
      <li><span class="num">${String(i + 1).padStart(2, '0')}</span><span class="step-title">${escapeCmsHtml(step.title)}</span></li>
    `).join('');
  }
  const oldPrice = previewWrap.querySelector('.old-price');
  if (oldPrice) { if (course.old_price) oldPrice.textContent = course.old_price; else oldPrice.remove(); }
  const newPrice = previewWrap.querySelector('.new-price'); if (newPrice) newPrice.textContent = course.new_price || '';

  const detailUrl = `classDetail.html?id=${course.id}`;
  const curriculumBtn = previewWrap.querySelector('.btn-row .btn-outline');
  if (curriculumBtn) curriculumBtn.href = detailUrl;
  const enrollBtn = previewWrap.querySelector('.btn-row .btn-fill');
  if (enrollBtn) enrollBtn.href = detailUrl;
  const videoCard = previewWrap.querySelector('.vod-video-card');
  if (videoCard) {
    videoCard.style.cursor = 'pointer';
    videoCard.addEventListener('click', () => { window.location.href = detailUrl; });
  }

  const filterPills = document.querySelector('.vod-list-section .filter-pills');
  if (filterPills) {
    const labels = [...new Set(courses.map(c => c.title).filter(Boolean))];
    filterPills.innerHTML = labels.map((l, i) => `<button type="button" class="${i === 0 ? 'active' : ''}">${escapeCmsHtml(l)}</button>`).join('');
  }
}

// ── VOD 강의 상세보기(classDetail.html) — ?id= 쿼리로 넘어온 강좌를 하이드레이션 ──
async function hydrateClassDetail() {
  const courseId = new URLSearchParams(location.search).get('id');
  const main = document.querySelector('.cd-body .cd-layout');
  if (!courseId) {
    if (main) main.innerHTML = '<p class="faq-footnote">강의 정보를 찾을 수 없습니다.</p>';
    return;
  }

  const [courseRes, lectures] = await Promise.all([
    fetch(`/api/vod-courses/${courseId}`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`/api/vod-courses/${courseId}/lectures`).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  if (!courseRes) {
    if (main) main.innerHTML = '<p class="faq-footnote">강의 정보를 찾을 수 없습니다.</p>';
    return;
  }
  const course = courseRes;

  document.title = `${course.title} · 독편사 DOCK PASS`;

  const breadcrumb = document.getElementById('cdBreadcrumb');
  if (breadcrumb) breadcrumb.textContent = `HOME / VOD 강의 / ${course.category_label || course.title}`;

  const badge = document.getElementById('cdBadge');
  if (badge) badge.style.display = course.is_best ? '' : 'none';

  const titleEl = document.getElementById('cdTitle'); if (titleEl) titleEl.textContent = course.title || '';
  const descEl = document.getElementById('cdDesc'); if (descEl) descEl.textContent = course.description || '';

  const statLectures = document.getElementById('cdStatLectures'); if (statLectures) statLectures.textContent = `${lectures.length}개 강좌`;
  const statDuration = document.getElementById('cdStatDuration'); if (statDuration) statDuration.textContent = course.total_duration_text || '-';
  const statCompletion = document.getElementById('cdStatCompletion'); if (statCompletion) statCompletion.textContent = course.completion_criteria || '-';

  const difficultyBox = document.getElementById('cdDifficultyStatBox');
  const statDifficulty = document.getElementById('cdStatDifficulty');
  const panelDifficultyRow = document.getElementById('cdPanelDifficultyRow');
  const panelDifficultyVal = document.getElementById('cdPanelDifficultyVal');
  const showDifficulty = !!course.difficulty_visible && !!course.difficulty;
  if (difficultyBox) difficultyBox.style.display = showDifficulty ? '' : 'none';
  if (panelDifficultyRow) panelDifficultyRow.style.display = showDifficulty ? '' : 'none';
  if (statDifficulty) statDifficulty.textContent = course.difficulty || '';
  if (panelDifficultyVal) panelDifficultyVal.textContent = course.difficulty || '';

  const introHeading = document.getElementById('cdIntroHeading'); if (introHeading) introHeading.textContent = course.intro_heading || '';
  const introParagraph = document.getElementById('cdIntroParagraph'); if (introParagraph) introParagraph.textContent = course.intro_paragraph || '';
  const checklist = document.getElementById('cdChecklist');
  if (checklist) checklist.innerHTML = (course.checklistItems || []).map(item => `<li>${escapeCmsHtml(item.content)}</li>`).join('');

  const recommendedHeading = document.getElementById('cdRecommendedHeading'); if (recommendedHeading) recommendedHeading.textContent = course.recommended_heading || '';
  const tagGrid = document.getElementById('cdTagGrid');
  if (tagGrid) tagGrid.innerHTML = (course.tags || []).map(tag => `<span class="cd-tag">${escapeCmsHtml(tag.label)}</span>`).join('');

  const extraSections = document.getElementById('cdExtraSections');
  if (extraSections) {
    extraSections.innerHTML = (course.sections || []).map(section => `
      <div class="cd-section">
        <h2>${escapeCmsHtml(section.heading)}</h2>
        <p>${escapeCmsHtml(section.content).replace(/\n/g, '<br>')}</p>
      </div>
    `).join('');
  }

  const curriculumMeta = document.getElementById('cdCurriculumMeta'); if (curriculumMeta) curriculumMeta.textContent = `· 총 ${lectures.length}강`;
  const curriculumList = document.getElementById('cdCurriculumList');
  if (curriculumList) {
    curriculumList.innerHTML = lectures.map((step, i) => `
      <li><span class="num">${String(i + 1).padStart(2, '0')}</span><span class="step-title">${escapeCmsHtml(step.title)}</span></li>
    `).join('');
  }

  const panelTitle = document.getElementById('cdPanelTitle'); if (panelTitle) panelTitle.textContent = course.title || '';
  const oldPriceEl = document.getElementById('cdOldPrice');
  if (oldPriceEl) { if (course.old_price) oldPriceEl.textContent = course.old_price; else oldPriceEl.remove(); }
  const newPriceEl = document.getElementById('cdNewPrice'); if (newPriceEl) newPriceEl.textContent = course.new_price || '';
}

// ── 합격 인증 차트(퍼센트/막대) + 갤러리 ──
function applyCertChartData(chart) {
  if (!chart) return;
  const percentEl = document.querySelector('[data-cms-percent]');
  if (percentEl && chart.percent !== undefined && chart.percent !== '') {
    percentEl.setAttribute('data-count-to', chart.percent);
    if (percentEl.textContent === '0') percentEl.textContent = '0';
  }
  const barsWrap = document.querySelector('[data-cms-bars]');
  if (barsWrap && Array.isArray(chart.bars) && chart.bars.length) {
    const cols = [...barsWrap.querySelectorAll('.chart-col')];
    // 원본 디자인의 막대 높이는 인원수 비례가 아니라 순서 기준 균등 계단(19.5%→92.5%)
    const minPct = 19.5, maxPct = 92.5;
    const lastIdx = Math.max(chart.bars.length - 1, 1);
    chart.bars.forEach((bar, i) => {
      const col = cols[i];
      if (!col) return;
      const count = Number(bar.count) || 0;
      const pct = minPct + (i / lastIdx) * (maxPct - minPct);
      col.style.setProperty('--h', `${pct}%`);
      const countEl = col.querySelector('.chart-value [data-count-to]');
      if (countEl) countEl.setAttribute('data-count-to', count);
      const yearEl = col.querySelector('.chart-year');
      if (yearEl && bar.year) yearEl.textContent = bar.year;
    });
    // --h가 바뀌었으니 선·점 위치 재계산 (chart-animate.js가 resize에서 다시 그림)
    window.dispatchEvent(new Event('resize'));
  }
}

async function fetchCertGallery(limit) {
  try {
    const url = limit ? `/api/cert-gallery?limit=${limit}` : '/api/cert-gallery';
    const res = await fetch(url);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch {
    return null;
  }
}

async function hydrateCertGallery() {
  const wrap = document.querySelector('[data-cms-gallery]');
  if (!wrap) return;
  const rows = await fetchCertGallery();
  if (!rows) return;
  wrap.innerHTML = rows.map(r => `<div class="cert-gallery-item"><img src="${escapeCmsHtml(r.image_url)}" alt="합격 인증"></div>`).join('');
}

async function hydrateHomeGalleryPreview() {
  const wrap = document.querySelector('[data-cms-gallery-preview]');
  if (!wrap) return;
  const track = wrap.querySelector('.gallery-slider-track');
  if (!track) return;
  const rows = await fetchCertGallery(10);
  if (!rows) return;
  const cardsHtml = rows.map(r => `
    <div class="class-card" style="height:380px;">
      <img src="${escapeCmsHtml(r.image_url)}" alt="합격 인증" style="object-fit:cover;">
    </div>
  `).join('');
  track.innerHTML = cardsHtml + cardsHtml;
}

// ── FAQ 항목(faq_items) ──
async function fetchFaqItems() {
  try {
    const res = await fetch('/api/faq-items');
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch {
    return null;
  }
}

async function hydrateFaqList() {
  const wrap = document.querySelector('[data-cms-faq-list]');
  if (!wrap) return;
  const rows = await fetchFaqItems();
  if (!rows) return;
  const template = wrap.querySelector('template');
  if (!template) return;
  [...wrap.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
  rows.forEach((item, i) => {
    const node = template.content.firstElementChild.cloneNode(true);
    if (i === 0) node.classList.add('open');
    node.querySelector('.q-text').textContent = item.question || '';
    node.querySelector('.faq-answer').innerHTML = '<p>' + escapeCmsHtml(item.answer || '').replace(/\n/g, '<br>') + '</p>';
    wrap.appendChild(node);
  });
}

// ── 공지사항(notices) ──
async function fetchNotices() {
  try {
    const res = await fetch('/api/notices');
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

async function hydrateNoticeList() {
  const wrap = document.querySelector('[data-cms-notice-list]');
  if (!wrap) return;
  const rows = await fetchNotices();
  if (!rows) return;
  const template = wrap.querySelector('template');
  if (!template) return;
  // 헤더 행(.notice-board-head)과 template은 남기고 렌더된 행만 제거한다.
  [...wrap.children].filter(c => c.tagName !== 'TEMPLATE' && !c.classList.contains('notice-board-head')).forEach(c => c.remove());
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'faq-footnote';
    empty.textContent = '등록된 공지사항이 없습니다.';
    wrap.appendChild(empty);
    return;
  }
  rows.forEach((item) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector('.notice-cat').textContent = item.category || '';
    node.querySelector('.notice-title').textContent = item.title || '';
    node.querySelector('.notice-date').textContent = item.date || '';
    node.querySelector('.notice-body').innerHTML = item.body || '';
    wrap.appendChild(node);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const page = document.body.dataset.page;

  if (page === 'vod') hydrateVodGrid();
  if (page === 'curriculum') hydrateVodCurriculum();
  if (page === 'home') { hydrateHomeVodPreview(); hydrateHomeGalleryPreview(); }
  if (page === 'cert') hydrateCertGallery();
  if (page === 'faq') { hydrateFaqList(); hydrateNoticeList(); }
  if (page === 'classDetail') hydrateClassDetail();

  if (page) {
    try {
      const res = await fetch(`/api/site/${page}`);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          applyCmsData(data);
          if (page === 'cert') applyCertChartData(data.chart);
        }
      }
    } catch { /* 하드코딩된 값 폴백 유지 */ }
  }

  try {
    const settingsRes = await fetch('/api/site/settings');
    if (settingsRes.ok) {
      const settingsData = await settingsRes.json();
      applyCmsSettings(settingsData.footer || settingsData);
    }
  } catch { /* 하드코딩된 값 폴백 유지 */ }
});
