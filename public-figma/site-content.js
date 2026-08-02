// Cloudflare가 이 파일에 브라우저 캐시 TTL을 길게(수 시간) 붙이므로, 이 파일이나 auth.js를
// 고치고 배포할 때는 모든 페이지의 <script src="site-content.js?v=...">/auth.js?v=... 쿼리스트링을
// 함께 올려야 실기기에 반영된다 (안 올리면 사용자 브라우저가 캐시된 이전 버전을 계속 씀).
function resolveCmsPath(data, path) {
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null) ? undefined : acc[key], data);
}

function escapeCmsHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 다음(카카오) 우편번호 서비스 팝업 — join.html/mypage.html 공용 ──
// 무료 서비스, API 키 불필요. 스크립트는 각 페이지에서
// <script src="//t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js"></script>로 미리 로드해둔다.
function openDaumPostcode(onComplete) {
  if (typeof daum === 'undefined' || !daum.Postcode) {
    alert('주소 검색 서비스를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    return;
  }
  new daum.Postcode({
    oncomplete(data) {
      onComplete({
        postalCode: data.zonecode,
        roadAddress: data.roadAddress || data.jibunAddress
      });
    }
  }).open();
}

// ── 최근에 둘러본 VOD 강좌 (localStorage) — vodDetail.html에서 기록, vod.html 사이드바에서 표시 ──
const RECENT_VOD_COURSES_KEY = 'dockRecentlyViewedVodCourses';
const RECENT_VOD_COURSES_MAX = 6;

function getRecentVodCourses() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_VOD_COURSES_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function recordRecentVodCourse(course) {
  if (!course || !course.id) return;
  const entry = { id: course.id, title: course.title || '', thumbnail_url: course.thumbnail_url || '' };
  const rest = getRecentVodCourses().filter(c => String(c.id) !== String(course.id));
  const next = [entry, ...rest].slice(0, RECENT_VOD_COURSES_MAX);
  try { localStorage.setItem(RECENT_VOD_COURSES_KEY, JSON.stringify(next)); } catch { /* 저장 공간 부족 등은 무시 */ }
}

// HLS(.m3u8)와 레거시 mp4를 모두 지원하는 공용 재생 헬퍼.
// hls.js는 <video>에 직접 attachMedia하므로 HLS일 때는 video.load()를 호출하면 안 된다
// (붙인 MediaSource 스트림이 끊김).
let _hlsInstance = null;
function attachVideoSource(videoEl, url) {
  if (_hlsInstance) {
    _hlsInstance.destroy();
    _hlsInstance = null;
  }
  const isHls = !!url && /\.m3u8(\?|$)/i.test(url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    _hlsInstance = new window.Hls();
    _hlsInstance.loadSource(url);
    _hlsInstance.attachMedia(videoEl);
    return;
  }
  videoEl.src = url; // Safari 네이티브 HLS 또는 레거시 mp4
  videoEl.load();
}

// ── 수강현황(진도) 전송 ──
// 서버 계약은 dock-player/API_SPEC.md 7·8번과 같다. dock-player에도 같은 알고리즘의 트래커가
// 따로 있으므로(별도 저장소라 코드 공유 불가), 규약이나 delta 계산 방식을 바꾸면 그쪽도 같이 고쳐야 한다.
//
// 핵심은 "현재 위치"가 아니라 "직전 전송 이후 실제로 재생된 미디어 시간(delta)"을 보낸다는 것 —
// timeupdate의 currentTime 증가분만 누적하므로 배속 재생은 자연히 반영되고, 시크 점프는
// 정상 재생 폭을 넘어 버려지기 때문에 시크바를 끝까지 끌어도 진도가 오르지 않는다.
const PROGRESS_ENDPOINT = '/api/v1/progress';
const PROGRESS_INTERVAL_MS = 25000;
const PROGRESS_MAX_STEP_SECONDS = 3;  // timeupdate 한 번에 인정하는 최대 재생 폭(넘으면 시크로 간주해 버림)
const PROGRESS_QUEUE_MAX = 100;       // 전송 실패분 보관 상한(서버가 받는 배치 상한과 동일)

function createProgressTracker(videoEl, onSaved) {
  let lectureId = null;
  let accumulated = 0;
  let prevTime = 0;
  let timer = null;
  let stopped = false;
  let queue = [];

  function accumulate() {
    const now = videoEl.currentTime;
    const step = now - prevTime;
    prevTime = now;
    if (step > 0 && step <= PROGRESS_MAX_STEP_SECONDS) accumulated += step;
  }

  function stopTimer() { clearInterval(timer); timer = null; }
  function stop() { stopped = true; stopTimer(); }

  // beacon: 탭을 닫는 중에는 fetch가 취소되므로 sendBeacon으로 보낸다.
  function flush({ beacon = false } = {}) {
    if (stopped || !lectureId) return;
    const item = { lectureId, position: Math.round(videoEl.currentTime), delta: Math.round(accumulated), at: Date.now() };
    if (!item.delta && !queue.length) return; // 보낼 게 없으면(일시정지 상태 등) 요청 자체를 하지 않는다
    accumulated = 0;
    const items = queue.concat(item);
    queue = [];
    const payload = JSON.stringify({ items });

    if (beacon && navigator.sendBeacon) {
      if (!navigator.sendBeacon(PROGRESS_ENDPOINT, new Blob([payload], { type: 'application/json' }))) queue = items;
      return;
    }
    fetch(PROGRESS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).then(res => {
      if (res.status === 401) { stop(); return null; } // 세션 만료(서버 재시작 포함) — 조용히 중단
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(data => {
      if (data && onSaved) onSaved(data.progress || []);
    }).catch(() => {
      // 네트워크 실패분은 다음 flush에 함께 보낸다(넘치면 오래된 것부터 버린다)
      queue = items.concat(queue).slice(-PROGRESS_QUEUE_MAX);
    });
  }

  videoEl.addEventListener('timeupdate', accumulate);
  videoEl.addEventListener('playing', () => {
    prevTime = videoEl.currentTime;
    if (!timer && !stopped) timer = setInterval(() => { accumulate(); flush(); }, PROGRESS_INTERVAL_MS);
  });
  videoEl.addEventListener('seeked', () => { prevTime = videoEl.currentTime; });
  videoEl.addEventListener('pause', () => { accumulate(); stopTimer(); flush(); });
  videoEl.addEventListener('ended', () => { accumulate(); stopTimer(); flush(); });
  // 탭을 숨기거나 닫는 순간이 마지막 구간을 건질 유일한 기회라 반드시 beacon으로 보낸다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { accumulate(); flush({ beacon: true }); }
  });
  window.addEventListener('pagehide', () => { accumulate(); flush({ beacon: true }); });

  return {
    // 강의를 바꿀 때 호출 — 이전 강의의 마지막 구간을 먼저 보내고 대상만 갈아끼운다.
    // (video의 src를 갈기 전에 불러야 currentTime이 아직 이전 강의의 것이다)
    setLecture(nextId) {
      if (lectureId && nextId !== lectureId) { accumulate(); flush(); }
      lectureId = nextId;
      accumulated = 0;
      prevTime = 0;
      stopTimer();
    }
  };
}

// 관리자에서 TOAST UI 마크다운 에디터로 작성한 텍스트를 프론트 el에 읽기전용 뷰어로 렌더링
// (이 TOAST UI 버전엔 문자열 변환용 정적 메서드가 없어 viewer:true 인스턴스를 직접 마운트해야 함 —
//  el이 아직 보이지 않는 컨테이너(예: 닫힌 <details>) 안에 있으면 크기 계산이 틀어질 수 있으니
//  항상 화면에 보이는 상태의 el에만 마운트한다)
function renderMarkdownInto(el, md) {
  if (!el) return;
  el.innerHTML = '';
  if (!md || !md.trim()) return;
  try {
    if (window.toastui && window.toastui.Editor && typeof window.toastui.Editor.factory === 'function') {
      window.toastui.Editor.factory({ el, viewer: true, initialValue: md, language: 'ko-KR' });
      return;
    }
  } catch {}
  el.innerHTML = `<p>${escapeCmsHtml(md).replace(/\n/g, '<br>')}</p>`;
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

  // data-cms-image가 {url, ratio} 객체를 다루는 것과 달리, 이건 URL 문자열 하나를 img.src에 그대로 넣는다
  document.querySelectorAll('[data-cms-src]').forEach(el => {
    const value = resolveCmsPath(data, el.dataset.cmsSrc);
    if (typeof value === 'string' && value) el.src = value;
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
  const kakaoLinks = document.querySelectorAll('.kakao-float, [data-kakao-link]');
  if (kakaoLinks.length && settings.kakaoUrl) {
    kakaoLinks.forEach(kakao => {
      kakao.href = settings.kakaoUrl;
      kakao.target = settings.kakaoUrl.startsWith('http') ? '_blank' : '_self';
    });
  }
  document.querySelectorAll('.phone').forEach(el => { if (settings.phone) el.textContent = settings.phone; });
  document.querySelectorAll('.hours').forEach(el => { if (settings.hours) el.textContent = settings.hours; });
  if (Array.isArray(settings.footerLines) && settings.footerLines.length) {
    document.querySelectorAll('.footer-brand p, .footer-desc').forEach(el => {
      el.innerHTML = settings.footerLines.map(escapeCmsHtml).join('<br>\n');
    });
  }
  document.querySelectorAll('.copyright').forEach(el => { if (settings.copyright) el.textContent = settings.copyright; });
}

// ── VOD 강좌(vod_courses) 공용 하이드레이션: vod.html 그리드 / curriculum.html 행 / 홈 미리보기 ──
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

// ── VOD 강좌 상세보기(classDetail.html) — ?id= 쿼리로 넘어온 강좌를 하이드레이션 ──
async function hydrateClassDetail() {
  const courseId = new URLSearchParams(location.search).get('id');
  const main = document.querySelector('.cd-body .cd-layout');
  if (!courseId) {
    if (main) main.innerHTML = '<p class="faq-footnote">강좌 정보를 찾을 수 없습니다.</p>';
    return;
  }

  const [courseRes, lectures] = await Promise.all([
    fetch(`/api/vod-courses/${courseId}`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`/api/vod-courses/${courseId}/lectures`).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  if (!courseRes) {
    if (main) main.innerHTML = '<p class="faq-footnote">강좌 정보를 찾을 수 없습니다.</p>';
    return;
  }
  const course = courseRes;

  document.title = `${course.title} · 독편사 DOCK PASS`;

  const breadcrumb = document.getElementById('cdBreadcrumb');
  if (breadcrumb) breadcrumb.textContent = `HOME / VOD 강좌 / ${course.category_label || course.title}`;

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
  renderMarkdownInto(document.getElementById('cdIntroParagraph'), course.intro_paragraph);
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
    curriculumList.innerHTML = lectures.map((step, i) => {
      const hasContent = !!(step.content_markdown && step.content_markdown.trim());
      const numTitle = `<span class="num">${String(i + 1).padStart(2, '0')}</span><span class="step-title">${escapeCmsHtml(step.title)}</span>`;
      return `
        <li id="cdStep-${i}">
          ${step.has_video ? `<a class="curriculum-step-link" href="lecturePlayer.html?id=${courseId}&lecture=${step.lecture_number}">${numTitle}</a>` : numTitle}
          ${hasContent ? `
            <button type="button" class="curriculum-detail-btn" data-step-toggle="${i}">
              <span class="detail-label">상세보기</span><span class="detail-icon">+</span>
            </button>
            <div class="cd-markdown curriculum-step-content" id="cdStepContent-${i}"></div>
          ` : ''}
        </li>
      `;
    }).join('');

    // 상세보기 토글 — TOAST UI 뷰어는 숨겨진 컨테이너에 마운트하면 크기 계산이 틀어질 수 있어
    // 처음 펼칠 때만 지연 마운트한다 (관리자 클래스소개 에디터와 동일한 지연 마운트 패턴)
    curriculumList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-step-toggle]');
      if (!btn) return;
      const idx = btn.dataset.stepToggle;
      const li = document.getElementById(`cdStep-${idx}`);
      const isOpen = li.classList.toggle('open');
      const label = btn.querySelector('.detail-label');
      if (label) label.textContent = isOpen ? '접기' : '상세보기';
      if (isOpen) {
        const contentEl = document.getElementById(`cdStepContent-${idx}`);
        if (contentEl && !contentEl.dataset.rendered) {
          renderMarkdownInto(contentEl, lectures[idx].content_markdown);
          contentEl.dataset.rendered = '1';
        }
      }
    });
  }

  const panelTitle = document.getElementById('cdPanelTitle'); if (panelTitle) panelTitle.textContent = course.title || '';
  const oldPriceEl = document.getElementById('cdOldPrice');
  if (oldPriceEl) { if (course.old_price) oldPriceEl.textContent = course.old_price; else oldPriceEl.remove(); }
  const newPriceEl = document.getElementById('cdNewPrice'); if (newPriceEl) newPriceEl.textContent = course.new_price || '';

  wireVodCoursePayment(courseId, 'cdBuyBtn', course);
}

// ── VOD 수강기간(access_days) / 강좌 종료일(ends_at) 공용 계산 ──
// 서버가 내려주는 두 값으로 "지금 구매하면 언제까지 볼 수 있는지"를 프론트에서 한 번만 계산해
// 구매카드·경고문구·확인모달이 같은 숫자를 쓰게 한다.
function parseVodDateOnly(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// 표기 형식: 2026. 08. 18 (일 뒤에는 마침표를 찍지 않는다)
function formatVodDate(date) {
  if (!date) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}. ${pad(date.getMonth() + 1)}. ${pad(date.getDate())}`;
}

// 종료일 "당일까지" 시청 가능하므로 남은 일수에 오늘을 포함해서 센다 (종료일이 오늘이면 1일).
function vodDaysRemaining(date) {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((date - today) / 86400000) + 1;
}

// { accessDays, endsAt, untilDate, effectiveDays, cutByEnd, isEnded }
// cutByEnd: 강좌 종료일이 수강기간보다 먼저 와서 수강기간을 다 못 쓰는 경우 → 구매 전 고지 대상.
function computeVodAccessWindow(course) {
  const accessDays = course && course.access_days > 0 ? Number(course.access_days) : null;
  const endsAt = parseVodDateOnly(course && course.ends_at);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isEnded = !!(endsAt && endsAt < today);

  let periodEnd = null;
  if (accessDays) {
    periodEnd = new Date(today);
    periodEnd.setDate(periodEnd.getDate() + accessDays - 1);
  }
  const cutByEnd = !!(endsAt && !isEnded && (!periodEnd || endsAt < periodEnd));
  const untilDate = cutByEnd ? endsAt : periodEnd;
  return { accessDays, endsAt, untilDate, effectiveDays: vodDaysRemaining(untilDate), cutByEnd, isEnded };
}

// 수강기간을 다 쓰기 전에 강좌가 종료되는 경우, 결제창을 띄우기 전에 확인을 받는다.
// (전자상거래 거래조건 고지 측면에서도 "몰랐다"는 분쟁을 줄이는 목적)
function confirmVodPurchasePeriod(course) {
  const window_ = computeVodAccessWindow(course);
  if (!window_.cutByEnd) return Promise.resolve(true);

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'auth-modal-overlay open';
    overlay.innerHTML = `
      <div class="auth-modal-box" role="dialog" aria-modal="true" aria-labelledby="vodPeriodConfirmTitle" style="width:440px;">
        <h2 id="vodPeriodConfirmTitle" style="margin:0 0 14px;font-size:19px;">수강 기간을 확인해주세요</h2>
        <div style="background:#fdf5e9;border:1px solid var(--beige-500);border-radius:12px;padding:16px 18px;font-size:13.5px;line-height:1.7;color:var(--navy-900);">
          이 강좌는 <b>${formatVodDate(window_.endsAt)}</b>에 종료됩니다.<br>
          ${window_.accessDays ? `수강 기간 <b>${window_.accessDays}일</b>과 관계없이 종료일 이후에는 시청할 수 없습니다.<br>` : ''}
          지금 결제하시면 실제 시청 가능 기간은 <b>${window_.effectiveDays}일</b>입니다.
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:16px 0 18px;font-size:13px;line-height:1.6;cursor:pointer;">
          <input type="checkbox" id="vodPeriodConfirmCheck" style="margin-top:3px;flex:none;">
          <span>위 내용을 확인했으며, 이에 동의하고 결제를 진행합니다.</span>
        </label>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn btn--outline" id="vodPeriodConfirmCancel" style="flex:1;">취소</button>
          <button type="button" class="btn btn--primary" id="vodPeriodConfirmOk" style="flex:1;opacity:.5;pointer-events:none;">결제 진행</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('#vodPeriodConfirmOk');
    const close = result => { overlay.remove(); resolve(result); };
    overlay.querySelector('#vodPeriodConfirmCheck').addEventListener('change', e => {
      okBtn.style.opacity = e.target.checked ? '' : '.5';
      okBtn.style.pointerEvents = e.target.checked ? '' : 'none';
    });
    okBtn.addEventListener('click', () => close(true));
    overlay.querySelector('#vodPeriodConfirmCancel').addEventListener('click', () => close(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  });
}

// ── PayUp 표준결제 (VOD 강좌 구매) — classDetail.html(#cdBuyBtn)/vodDetail.html(#pcBuyBtn) 공용, 결제 완료/실패 결과는 paymentComplete.html에서 보여준다 ──
// course를 넘기면 결제창 직전에 수강기간/종료일 확인 모달을 띄운다 (필요한 경우에만).
function wireVodCoursePayment(vodCourseId, buttonId = 'cdBuyBtn', course = null) {
  const buyBtn = document.getElementById(buttonId);
  if (!buyBtn) return;
  // 페이지 로드 직후(비동기 fetch로 courseId를 확정하기 전) 버튼이 눌려도
  // 리스너가 아직 없어 "눌러도 반응 없음"으로 보이는 구간을 없애기 위해
  // 마크업에서 비활성 표시(aria-disabled+pointer-events:none)해두고 여기서 해제한다.
  buyBtn.removeAttribute('aria-disabled');
  buyBtn.style.opacity = '';
  buyBtn.style.pointerEvents = '';
  buyBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const trigger = document.getElementById('loginTrigger');
    if (trigger && trigger.dataset.loggedIn !== 'true') { openLoginModal(); return; }
    if (typeof goPayupPay !== 'function') { alert('결제 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.'); return; }
    if (course && !(await confirmVodPurchasePeriod(course))) return;
    buyBtn.style.pointerEvents = 'none';
    try {
      const res = await fetch('/api/payments/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vodCourseId })
      });
      const payData = await res.json();
      if (!res.ok) { alert(payData.error || '결제 준비 중 오류가 발생했습니다.'); return; }
      goPayupPay(payData);
    } catch {
      alert('서버와 통신 중 오류가 발생했습니다.');
    } finally {
      buyBtn.style.pointerEvents = '';
    }
  });
}

// 페이업 SDK가 결제 인증 완료 시 호출하는 콜백 — 함수명 고정(변경 금지).
// SDK가 자동 생성한 PayupPaymentStandardForm을 우리 승인 요청 URL로 그대로 제출한다.
function payupPaymentSubmit(payForm) {
  const form = typeof payForm === 'string' ? document.getElementById(payForm) : payForm;
  if (!form) return;
  form.action = '/api/payments/approve';
  form.submit();
}

// 결제창을 닫았을 때(결제 취소) 호출되는 콜백 — 함수명 고정(변경 금지).
function payupPaymentClose() {
  ['cdBuyBtn', 'pcBuyBtn'].forEach(id => {
    const buyBtn = document.getElementById(id);
    if (buyBtn) buyBtn.style.pointerEvents = '';
  });
}

// ── 강의 플레이어(lecturePlayer.html) — ?id=강좌ID&lecture=강의번호 ──
// 실제로 수강 등록된 회원인지 서버가 확인한 뒤 내려주는 응답으로만 렌더링한다.
// 비로그인/미등록이면 아무것도 그리지 않고 바로 홈으로 리디렉션한다.
async function hydrateLecturePlayer() {
  const params = new URLSearchParams(location.search);
  const courseId = params.get('id');
  if (!courseId) {
    window.location.href = 'index.html';
    return;
  }

  const res = await fetch(`/api/members/my-vod-lectures/${courseId}`).catch(() => null);
  if (!res || !res.ok) {
    // 미등록이면 조용히 홈으로 보내지만, 기간 만료/강좌 종료는 왜 못 보는지 알려줘야 재구매로 이어진다.
    const reason = res ? await res.json().then(d => d.reason).catch(() => null) : null;
    if (reason === 'expired') {
      alert('수강 기간이 만료되었습니다. 다시 수강하시려면 재구매가 필요합니다.');
      window.location.href = `vodDetail.html?id=${courseId}`;
      return;
    }
    if (reason === 'course_ended') {
      alert('종료된 강좌입니다. 더 이상 시청할 수 없습니다.');
      window.location.href = 'mypage.html';
      return;
    }
    window.location.href = 'index.html';
    return;
  }
  const data = await res.json();
  const course = data.course;
  const lectures = data.lectures;
  if (!course || !lectures.length) {
    window.location.href = 'index.html';
    return;
  }

  document.title = `${course.title} · 독편사 DOCK PASS`;

  const backBtn = document.getElementById('lpBackBtn');
  if (backBtn) {
    const referrer = document.referrer;
    if (referrer && referrer.startsWith(location.origin)) {
      // 마이페이지 '내 강좌' → 수강하기, 커리큘럼 목록 등 어디서 들어왔든 그 페이지로 그대로 되돌아간다.
      backBtn.href = referrer;
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        history.back();
      });
    } else {
      backBtn.href = `classDetail.html?id=${course.id}`;
    }
  }
  const topbarCourse = document.getElementById('lpTopbarCourse'); if (topbarCourse) topbarCourse.textContent = course.title || '';

  // 진도(이어보기 지점 + 목록 배지). 실패해도 재생 자체엔 영향이 없도록 조용히 넘어간다.
  const progressByLecture = {};
  try {
    const progressRes = await fetch(`/api/v1/courses/${courseId}/progress`);
    if (progressRes.ok) {
      const progressData = await progressRes.json();
      (progressData.lectures || []).forEach(p => { progressByLecture[p.lectureId] = p; });
    }
  } catch { /* 진도 없이 진행 */ }

  const videoEl = document.getElementById('lpVideo');
  const progressTracker = videoEl ? createProgressTracker(videoEl, saved => {
    saved.forEach(p => { progressByLecture[p.lectureId] = p; });
    renderList(); // 25초마다 목록 배지를 최신 진도로 갱신
  }) : null;

  const listEl = document.getElementById('lpCurriculumList');
  const nextBtn = document.getElementById('lpNextBtn');
  let currentIndex = 0;
  const requestedNum = params.get('lecture');
  if (requestedNum !== null) {
    const idx = lectures.findIndex(l => String(l.lecture_number) === requestedNum);
    if (idx >= 0) currentIndex = idx;
  }

  function progressBadgeHtml(lectureId) {
    const p = progressByLecture[lectureId];
    if (!p) return '';
    if (p.completed) return '<span class="lp-progress lp-progress--done">완료</span>';
    if (!p.percent) return '';
    return `<span class="lp-progress">${p.percent}%</span>`;
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = lectures.map((l, i) => `
      <li class="${i === currentIndex ? 'active' : ''}" data-lecture-idx="${i}">
        <span class="num">${String(i + 1).padStart(2, '0')}</span><span class="step-title">${escapeCmsHtml(l.title)}</span>${progressBadgeHtml(l.id)}
      </li>
    `).join('');
  }

  function renderMaterials(lecture) {
    const materialsEl = document.getElementById('lpMaterialsList');
    if (!materialsEl) return;
    const materials = lecture.materials || [];
    if (!materials.length) {
      materialsEl.innerHTML = '<p class="lp2-empty">등록된 자료가 없습니다.</p>';
      return;
    }
    materialsEl.innerHTML = materials.map((m, i) => `
      <a class="lp2-material-item" href="${m.url}" target="_blank" rel="noopener">
        <span class="lp2-material-icon">${i + 1}</span>
        <span class="lp2-material-name">${escapeCmsHtml(m.title)}</span>
      </a>
    `).join('');
  }

  function switchTab(tab) {
    document.querySelectorAll('#lpTabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const contentEl = document.getElementById('lpTabContent'); if (contentEl) contentEl.style.display = tab === 'lpTabContent' ? '' : 'none';
    const curriculumEl = document.getElementById('lpTabCurriculum'); if (curriculumEl) curriculumEl.style.display = tab === 'lpTabCurriculum' ? '' : 'none';
  }

  const tabsEl = document.getElementById('lpTabs');
  if (tabsEl) {
    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn || btn.style.display === 'none') return;
      switchTab(btn.dataset.tab);
    });
  }

  function playLecture(idx, { autoplay } = { autoplay: false }) {
    currentIndex = idx;
    const lecture = lectures[idx];

    if (videoEl) {
      // src를 갈기 전에 호출해야 이전 강의의 마지막 구간이 이전 강의 앞으로 기록된다.
      if (progressTracker) progressTracker.setLecture(lecture.id);
      attachVideoSource(videoEl, lecture.video_url || '');
      // 이어보기 — 거의 다 본 강의는 끝에서 시작하면 의미가 없으니 처음부터 튼다.
      const saved = progressByLecture[lecture.id];
      const resumeAt = saved && !saved.completed && saved.position > 5 ? saved.position : 0;
      if (resumeAt) {
        // hls.js가 매니페스트를 파싱하기 전엔 currentTime을 못 잡으므로 메타데이터를 기다린다.
        videoEl.addEventListener('loadedmetadata', () => { videoEl.currentTime = resumeAt; }, { once: true });
      }
      if (autoplay) videoEl.play().catch(() => {});
    }

    const titleEl = document.getElementById('lpLectureTitle'); if (titleEl) titleEl.textContent = lecture.title || '';
    const topbarLecture = document.getElementById('lpTopbarLecture'); if (topbarLecture) topbarLecture.textContent = lecture.title || '';

    const hasContent = !!(lecture.content_markdown && lecture.content_markdown.trim());
    const contentTabBtn = document.querySelector('#lpTabs [data-tab="lpTabContent"]');
    if (contentTabBtn) contentTabBtn.style.display = hasContent ? '' : 'none';
    if (hasContent) renderMarkdownInto(document.getElementById('lpLectureContent'), lecture.content_markdown);
    switchTab(hasContent ? 'lpTabContent' : 'lpTabCurriculum');

    renderMaterials(lecture);
    if (nextBtn) nextBtn.disabled = currentIndex >= lectures.length - 1;

    renderList();
    const url = new URL(location.href);
    url.searchParams.set('lecture', lecture.lecture_number);
    history.replaceState(null, '', url);
  }

  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('[data-lecture-idx]');
      if (!li) return;
      playLecture(Number(li.dataset.lectureIdx), { autoplay: true });
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (currentIndex < lectures.length - 1) playLecture(currentIndex + 1, { autoplay: true });
    });
  }

  playLecture(currentIndex);
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
    <div class="class-card">
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

async function hydrateFaqList(limit) {
  const wrap = document.querySelector('[data-cms-faq-list]');
  if (!wrap) return;
  const rows = await fetchFaqItems();
  if (!rows) return;
  const template = wrap.querySelector('template');
  if (!template) return;
  [...wrap.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
  (limit ? rows.slice(0, limit) : rows).forEach((item, i) => {
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

// ── 수강후기(reviews) ──
async function fetchReviews() {
  try {
    const res = await fetch('/api/reviews');
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function starsFromRating(rating) {
  const n = Number(rating) || 0;
  const full = Math.max(0, Math.min(5, Math.floor(n)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

async function hydrateReviewList() {
  const wrap = document.querySelector('[data-cms-review-list]');
  if (!wrap) return;
  const rows = await fetchReviews();
  if (!rows || !rows.length) return;
  const template = wrap.querySelector('template');
  if (!template) return;
  [...wrap.children].filter(c => c.tagName !== 'TEMPLATE').forEach(c => c.remove());
  rows.forEach((item) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.course = item.course_name || '';
    node.querySelector('.stars').textContent = starsFromRating(item.rating);
    node.querySelector('h3').textContent = item.student_name || '';
    node.querySelector('.rc-date').textContent = item.review_date || '';
    node.querySelector('.rc-course').textContent = item.course_name || '';
    node.querySelector('p').textContent = item.review_text || '';
    wrap.appendChild(node);
  });
  window.dispatchEvent(new CustomEvent('reviews:hydrated'));
}

document.addEventListener('DOMContentLoaded', async () => {
  const page = document.body.dataset.page;

  if (page === 'vod') hydrateVodGrid();
  if (page === 'curriculum') hydrateVodCurriculum();
  if (page === 'home') { hydrateHomeVodPreview(); hydrateHomeGalleryPreview(); hydrateFaqList(3); }
  if (page === 'cert') hydrateCertGallery();
  if (page === 'faq') { hydrateFaqList(); hydrateNoticeList(); }
  if (page === 'notice') { hydrateFaqList(); hydrateNoticeList(); }
  if (page === 'reviews') hydrateReviewList();
  if (page === 'classDetail') hydrateClassDetail();
  if (page === 'lecturePlayer') hydrateLecturePlayer();

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
