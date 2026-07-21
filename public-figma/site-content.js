function resolveCmsPath(data, path) {
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null) ? undefined : acc[key], data);
}

function escapeCmsHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hydrateCmsListItem(node, item, index) {
  const img = node.querySelector('img');
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
  if (link) link.href = `curriculum.html#course-${course.id}`;
  return node;
}

async function hydrateVodGrid() {
  const grid = document.querySelector('[data-cms-vod-courses]');
  const pillsWrap = document.querySelector('[data-cms-vod-pills]');
  const countEl = document.querySelector('[data-cms-vod-count]');
  if (!grid && !pillsWrap && !countEl) return;

  const courses = await fetchVodCourses();
  if (!courses) return;

  if (countEl) countEl.textContent = courses.length;

  if (pillsWrap) {
    const labels = [...new Set(courses.map(c => c.category_label).filter(Boolean))];
    pillsWrap.innerHTML = '<button type="button" class="active">전체</button>' +
      labels.map(l => `<button type="button">${escapeCmsHtml(l)}</button>`).join('');
  }

  if (grid) {
    const template = grid.querySelector('template');
    if (template) {
      [...grid.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
      courses.forEach(course => {
        const node = template.content.firstElementChild.cloneNode(true);
        grid.appendChild(renderVodCourseCard(node, course));
      });
    }
  }
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
    stepsEl.innerHTML = steps.map((step, i) => `
      <li><span class="num">${String(i + 1).padStart(2, '0')}</span><span class="step-title">${escapeCmsHtml(step.title)}</span></li>
    `).join('');
    const moreEl = node.querySelector('.curriculum-more');
    if (moreEl) moreEl.textContent = `전체 ${steps.length}강 보기 +`;
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

  const filterPills = document.querySelector('.vod-list-section .filter-pills');
  if (filterPills) {
    const labels = [...new Set(courses.map(c => c.title).filter(Boolean))];
    filterPills.innerHTML = labels.map((l, i) => `<button type="button" class="${i === 0 ? 'active' : ''}">${escapeCmsHtml(l)}</button>`).join('');
  }
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

document.addEventListener('DOMContentLoaded', async () => {
  const page = document.body.dataset.page;

  if (page === 'vod') hydrateVodGrid();
  if (page === 'curriculum') hydrateVodCurriculum();
  if (page === 'home') { hydrateHomeVodPreview(); hydrateHomeGalleryPreview(); }
  if (page === 'cert') hydrateCertGallery();
  if (page === 'faq') hydrateFaqList();

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
