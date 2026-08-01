// ── 공용 헤더: 모든 페이지가 <div id="site-header"></div> + <script src="header.js"> 만 두면
//    이 파일 하나가 실제 <header> 마크업을 생성해 넣는다. 헤더 구조/스타일을 바꿀 때는 이 파일만 고치면 된다.
(function () {
  const NAV_LINKS = [
    ['vod.html', 'VOD 강좌'],
    ['intro.html', '학습소개'],
    ['notice.html', '공지사항'],
    ['cert.html', '합격인증']
  ];

  // data-page(각 페이지 <body data-page="...">) → 활성화할 nav 링크. 매핑에 없는 페이지는 활성 표시 없음.
  const ACTIVE_NAV_BY_PAGE = {
    vod: 'vod.html', vodDetail: 'vod.html', vodDetail_v2: 'vod.html', classDetail: 'vod.html',
    intro: 'intro.html',
    notice: 'notice.html',
    cert: 'cert.html'
  };

  // ── 로고 줄 좌/우 끝 배너(각 230x80). 좌우가 같은 인덱스로 동시에 넘어가고,
  //    전환 속도(.6s ease)와 주기(4초)는 홈 상단/중간 배너와 동일하게 맞춘다.
  //    index.html이 노출하는 마스터 클럭(window.bannerTicker)이 있으면 거기에 올라타서 박자까지 공유한다.
  //    방향은 항상 우→좌 고정 — 다음 장을 오른쪽(100%)에 대기시켰다가 한 칸 밀어넣는다(index.html의 DOCK NEWS와 같은 방식).
  const BANNER_W = 230;
  const BANNER_INTERVAL = 4000;
  const BANNERS = {
    left: [
      ['assets/home/header-banner-l1.webp', '연고대 논술 대비 8월 신규반 안내 · 마지막 충원 기간'],
      ['assets/home/header-banner-l2.webp', 'dockpass 홈페이지 신설']
    ],
    right: [
      ['assets/home/header-banner-r1.webp', '연세대 대관 모의논술 11월 초 시행 예정'],
      ['assets/home/header-banner-r2.webp', '고려대 대관 모의논술 11월 초 시행 예정']
    ]
  };

  const ARROW_SVG = {
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>'
  };

  function bannerHtml(side) {
    const items = BANNERS[side];
    if (!items || !items.length) return '';
    // 첫 장만 제자리, 나머지는 오른쪽 밖에 대기시켜 둔다.
    const imgs = items.map(([src, alt], i) =>
      `<img src="${src}" alt="${alt}" width="230" height="80"${i ? ' style="transform:translateX(100%)"' : ''}>`).join('');
    return `<div class="hbanner-group hbanner-group--${side}">`
      + `<button class="hbanner__arrow" type="button" data-dir="-1" aria-label="이전 배너">${ARROW_SVG.prev}</button>`
      + `<div class="hbanner">${imgs}</div>`
      + `<button class="hbanner__arrow" type="button" data-dir="1" aria-label="다음 배너">${ARROW_SVG.next}</button>`
      + '</div>';
  }

  function buildHeader() {
    const activeHref = ACTIVE_NAV_BY_PAGE[document.body.dataset.page || ''] || '';
    const navHtml = NAV_LINKS
      .map(([href, label]) => `<a href="${href}"${href === activeHref ? ' class="active"' : ''}>${label}</a>`)
      .join('');

    const header = document.createElement('header');
    header.className = 'header';
    header.innerHTML =
      '<div class="header__brand"><div class="container header__brand-inner">'
        + bannerHtml('left')
        + '<a class="header__brand-link" href="index.html"><img src="assets/home/header-logo.png" alt="DOCK PASS" class="header__brand-logo"></a>'
        + bannerHtml('right')
      + '</div></div>'
      + '<div class="header__nav-row"><div class="container header__inner">'
        + '<a class="header__mini-logo" href="index.html" tabindex="-1"><img src="assets/home/header-logo.png" alt="DOCK PASS"></a>'
        + `<nav class="nav" aria-label="주요 메뉴">${navHtml}</nav>`
        + '<div class="header__actions"><a class="btn btn--ghost-dark" id="loginTrigger" href="javascript:void(0)">로그인</a><a class="btn btn--ghost-dark my-info-link" id="myInfoBtn" href="mypage.html" style="display:none;">마이페이지</a><button class="mobile-toggle" type="button" aria-label="메뉴 열기">☰</button></div>'
      + '</div></div>';
    return header;
  }

  function injectStyleOnce() {
    if (document.getElementById('site-header-style')) return;
    const style = document.createElement('style');
    style.id = 'site-header-style';
    style.textContent =
      // 헤더 자체는 문서 흐름 맨 위에 그냥 놓인다(페이지 CSS의 position:sticky 무효화).
      // 스크롤하면 통째로 화면 밖으로 밀려나가고, 그 다음부터는 아래 .header--stuck 규칙이 nav 줄만 상단에 고정한다.
      // (static이 아니라 relative — 페이지 CSS의 z-index:50이 먹으려면 positioned여야 히어로 섹션에 안 가린다)
      '.header{position:relative;top:auto;z-index:50;width:100%;max-width:1280px;margin:0 auto;background:transparent;backdrop-filter:none;border-bottom:none}'
      // ── 로고 줄: [좌 배너 230] [로고] [우 배너 230], 높이는 80px 배너에 맞춰 늘어난다
      + '.header__brand{background:var(--warm-white,#fbfaf9);padding:12px 0 8px}'
      + '.header__brand-inner{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:20px}'
      + '.header__brand-link{grid-column:2;justify-self:center;display:block}'
      + '.header__brand-logo{height:40px;width:auto;display:block}'
      + '.hbanner-group{display:flex;align-items:center;gap:4px}'
      + '.hbanner-group--left{grid-column:1;justify-self:start}.hbanner-group--right{grid-column:3;justify-self:end}'
      // 배너 이미지가 자체 라운드 코너를 갖고 있어서 wrapper에는 radius를 주지 않는다(모서리가 이중으로 깎임).
      + '.hbanner{position:relative;width:' + BANNER_W + 'px;height:80px;overflow:hidden;flex:0 0 auto}'
      // 슬라이드를 겹쳐 놓고 각자 translate — 나가는 장은 -100%, 들어오는 장은 100%→0 (항상 우→좌)
      + '.hbanner img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:transform .6s ease;will-change:transform}'
      // 배너 양옆 화살표: 배경/테두리 없이 얇은 셰브론만
      + '.hbanner__arrow{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--muted,#73737a);cursor:pointer;transition:color .2s,background .2s}'
      + '.hbanner__arrow:hover{color:var(--text,#172033);background:rgba(23,32,51,.06)}'
      + '.hbanner__arrow svg{width:14px;height:14px;display:block}'
      + '.hbanner-group--static .hbanner__arrow{display:none}' // 슬라이드가 1장뿐이면 화살표를 숨긴다
      // ── nav 줄 + 상단 고정(한 줄 헤더) 상태
      + '.header__nav-row{background:var(--warm-white,#fbfaf9);position:relative;transition:transform .4s cubic-bezier(.22,.61,.36,1);will-change:transform}'
      + '.header--stuck .header__nav-row{position:fixed;top:0;left:0;right:0;z-index:60;border-bottom:1px solid var(--line,#e1e1df);box-shadow:0 4px 18px rgba(2,9,24,.07)}'
      + '.header--stuck.header--hidden .header__nav-row{transform:translateY(-100%)}'
      + '.header--no-anim .header__nav-row{transition:none}'
      // 한 줄 헤더일 때만 나타나는 좌측 끝 로고(자리는 항상 차지 → 나타날 때 레이아웃이 밀리지 않음)
      + '.header__mini-logo{grid-column:1;justify-self:start;align-self:center;display:flex;align-items:center;opacity:0;pointer-events:none;transition:opacity .25s}'
      + '.header--stuck .header__mini-logo{opacity:1;pointer-events:auto}'
      // 한 줄 헤더 높이(nav 링크 padding 14+27 + line-height 24.8 ≈ 66px) 안에서 위아래 여백만 남기고 최대로 키운다.
      // nav보다 낮게 유지해야 로고 때문에 줄 높이가 늘어나지 않는다.
      + '.header__mini-logo img{height:52px;width:auto;display:block}'
      + '.header__inner{display:grid;grid-template-columns:1fr auto 1fr}.header__inner>.nav{grid-column:2}.header__inner>.header__actions{grid-column:3;justify-self:end}'
      + '.header__nav-row .header__actions .btn--ghost-dark{background:transparent;color:var(--text);border:1px solid rgba(23,32,51,.22);padding:9px 14px}'
      + '.header__nav-row .mobile-toggle{color:var(--text);border-color:rgba(23,32,51,.22)}'
      + '@media(min-width:761px){.header__nav-row .nav{color:var(--text)}.header__nav-row .nav a.active:after,.header__nav-row .nav a:hover:after{background:var(--beige-700)}'
      // 로고↔메뉴 여백 축소: 페이지 CSS의 .header__inner{height:76px}는 nav를 세로 중앙정렬해서 링크 padding을 줄여도
      // 남는 높이가 그대로 위쪽 여백으로 되돌아온다. height를 콘텐츠에 맡긴 뒤 링크 상단 padding만 줄여야 실제로 붙는다.
      + '.header__nav-row .header__inner{height:auto}.header__nav-row .nav a{padding:14px 0 27px}'
      // 한 줄 헤더로 떨어져 나오면 위 여백 축소가 필요 없어진다 — 같은 총 높이(41px)를 위아래로 나눠 메뉴를 세로 중앙에 둔다.
      + '.header--stuck .header__nav-row .nav a{padding:20.5px 0}'
      + '.header--stuck .header__nav-row .nav a.active:after,.header--stuck .header__nav-row .nav a:hover:after{bottom:9px}}'
      // 배너 2개(230*2) + 로고가 한 줄에 들어가지 않는 폭에서는 배너를 숨기고 로고만 가운데 남긴다.
      + '@media(max-width:900px){.hbanner-group{display:none}.header__brand-inner{grid-template-columns:1fr}.header__brand-link{grid-column:1}}'
      // 모바일: 햄버거를 좌측 끝으로 이동(header__actions 플렉스 흐름에서 절대배치로 빼냄) + 드롭다운을 헤더 전체가 아니라
      // header__nav-row(버튼 줄) 바로 아래(top:100%)에 붙여서, 페이지마다 다른 헤더 높이(76px/64px 등)에 안전하게 대응.
      // 좌측 끝은 햄버거가 쓰므로 한 줄 헤더의 로고는 가운데로 보낸다.
      + '@media(max-width:760px){.header__nav-row .mobile-toggle{position:absolute;left:16px;top:50%;transform:translateY(-50%);z-index:1}.header__nav-row .nav{top:calc(100% + 6px) !important}'
      + '.header__mini-logo{grid-column:2;justify-self:center}.header__mini-logo img{height:40px}}';
    document.head.appendChild(style);
  }

  const root = document.getElementById('site-header');
  if (!root) return;

  injectStyleOnce();
  const header = buildHeader();
  root.replaceWith(header);

  header.querySelector('.mobile-toggle')?.addEventListener('click', () => {
    header.querySelector('.nav')?.classList.toggle('open');
  });

  // ── 좌/우 배너 동시 슬라이드 (홈 index.html의 initBannerSlider와 같은 방식) ──
  (function startBannerSlides() {
    const groups = Array.from(header.querySelectorAll('.hbanner-group'));
    const panelSets = groups.map(g => Array.from(g.querySelectorAll('.hbanner img'))).filter(p => p.length);
    const count = Math.max(BANNERS.left.length, BANNERS.right.length);
    if (!panelSets.length) return;
    if (count < 2) { groups.forEach(g => g.classList.add('hbanner-group--static')); return; }

    let current = 0;
    let paused = false;
    let ownTimer = null;

    // 자동재생이든 화살표든 항상 같은 방향(우→좌)으로만 넘어간다.
    // 되돌아가는 ‹ 버튼도 "이전 장이 오른쪽에서 들어오는" 모습으로 보인다.
    function goTo(i) {
      const next = (i + count) % count;
      if (next === current) return;
      panelSets.forEach(panels => {
        const cur = panels[current % panels.length];
        const nxt = panels[next % panels.length];
        if (!cur || !nxt || cur === nxt) return;
        nxt.style.transition = 'none';
        nxt.style.transform = 'translateX(100%)'; // 들어올 장을 오른쪽 밖에 세워두고
        nxt.offsetHeight; // 강제 리플로우 — transition:none이 실제로 적용된 뒤에 되돌리기 위함
        nxt.style.transition = '';
        cur.style.transform = 'translateX(-100%)'; // 한 칸씩 왼쪽으로
        nxt.style.transform = 'translateX(0)';
      });
      current = next;
    }

    const tick = () => { if (!paused) goTo(current + 1); };
    // 홈에는 상단·중간 배너를 함께 굴리는 마스터 클럭이 있다. 그게 있으면 올라타서 박자를 공유하고,
    // 다른 페이지(클럭 없음)에서는 같은 주기로 자체 타이머를 돌린다.
    const resetClock = () => {
      if (window.bannerTicker) window.bannerTicker.reset();
      else if (ownTimer) { clearInterval(ownTimer); ownTimer = setInterval(tick, BANNER_INTERVAL); }
    };
    // header.js는 index.html 하단 스크립트보다 먼저 실행되므로 bannerTicker가 정의될 때까지 기다렸다 붙는다.
    const attachClock = () => {
      if (window.bannerTicker) window.bannerTicker.add(tick);
      else ownTimer = setInterval(tick, BANNER_INTERVAL);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachClock, { once: true });
    else attachClock();

    groups.forEach(group => {
      group.addEventListener('mouseenter', () => { paused = true; });
      group.addEventListener('mouseleave', () => { paused = false; });
      group.querySelectorAll('.hbanner__arrow').forEach(btn => btn.addEventListener('click', () => {
        goTo(current + Number(btn.dataset.dir));
        resetClock(); // 수동 조작 → 홈 배너들과 함께 이 순간부터 다시 4초
      }));
    });
  })();

  // ── 로고 줄이 화면 밖으로 나가면 nav 줄만 상단 고정(한 줄 헤더).
  //    고정 상태에서는 스크롤 내리면 숨고 올리면 다시 나타난다.
  const brand = header.querySelector('.header__brand');
  const navRow = header.querySelector('.header__nav-row');
  let lastY = window.scrollY;
  let ticking = false;

  function stick() {
    if (header.classList.contains('header--stuck')) return;
    // nav 줄이 흐름에서 빠지면 그만큼 페이지가 위로 튀므로 같은 높이를 헤더 패딩으로 채워둔다.
    header.style.paddingBottom = navRow.offsetHeight + 'px';
    // 처음 붙는 순간은 화면 밖(숨김)에서 시작해야 아래→위로 순간이동하는 게 안 보인다.
    header.classList.add('header--no-anim', 'header--stuck', 'header--hidden');
    void header.offsetHeight;
    header.classList.remove('header--no-anim');
  }

  function unstick() {
    if (!header.classList.contains('header--stuck')) return;
    header.classList.add('header--no-anim');
    header.classList.remove('header--stuck', 'header--hidden');
    header.style.paddingBottom = '';
    void header.offsetHeight;
    header.classList.remove('header--no-anim');
  }

  function onScroll() {
    const y = window.scrollY;
    const delta = y - lastY;
    if (y > brand.offsetHeight) {
      stick();
      // 미세한 흔들림(5px 이하)은 무시. 모바일 메뉴가 열려 있으면 숨기지 않음.
      if (Math.abs(delta) > 5) {
        const menuOpen = header.querySelector('.nav')?.classList.contains('open');
        if (delta > 0 && !menuOpen) header.classList.add('header--hidden');
        else if (delta < 0) header.classList.remove('header--hidden');
      }
    } else {
      unstick();
    }
    if (Math.abs(delta) > 5) lastY = y;
  }

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { onScroll(); ticking = false; });
  }, { passive: true });

  onScroll(); // 새로고침 시 이미 스크롤된 상태 대응
})();
