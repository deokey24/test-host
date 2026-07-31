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

  function buildHeader() {
    const activeHref = ACTIVE_NAV_BY_PAGE[document.body.dataset.page || ''] || '';
    const navHtml = NAV_LINKS
      .map(([href, label]) => `<a href="${href}"${href === activeHref ? ' class="active"' : ''}>${label}</a>`)
      .join('');

    const header = document.createElement('header');
    header.className = 'header';
    header.innerHTML = `<div class="header__brand"><a href="index.html"><img src="assets/home/footer-logo.png" alt="DOCK PASS" class="header__brand-logo"></a></div><div class="header__nav-row"><div class="container header__inner"><nav class="nav" aria-label="주요 메뉴">${navHtml}</nav><div class="header__actions"><a class="btn btn--ghost-dark" id="loginTrigger" href="javascript:void(0)">로그인</a><a class="btn btn--ghost-dark my-info-link" id="myInfoBtn" href="mypage.html" style="display:none;">마이페이지</a><button class="mobile-toggle" type="button" aria-label="메뉴 열기">☰</button></div></div></div>`;
    return header;
  }

  function injectStyleOnce() {
    if (document.getElementById('site-header-style')) return;
    const style = document.createElement('style');
    style.id = 'site-header-style';
    style.textContent = '.header{width:100%;max-width:1280px;margin:0 auto;background:transparent;backdrop-filter:none;border-bottom:none}'
      + '.header__brand{display:flex;justify-content:center;align-items:center;padding:14px 0;background:rgba(3,18,40,.96);backdrop-filter:blur(16px)}.header__brand-logo{height:40px;width:auto;display:block}'
      + '.header__inner{display:grid;grid-template-columns:1fr auto 1fr}.header__inner>.nav{grid-column:2}.header__inner>.header__actions{grid-column:3;justify-self:end}'
      + '.header__nav-row{background:var(--warm-white,#fbfaf9);position:relative}'
      + '.header__nav-row .header__actions .btn--ghost-dark{background:transparent;color:var(--text);border:1px solid rgba(23,32,51,.22);padding:9px 14px}'
      + '.header__nav-row .mobile-toggle{color:var(--text);border-color:rgba(23,32,51,.22)}'
      + '@media(min-width:761px){.header__nav-row .nav{color:var(--text)}.header__nav-row .nav a.active:after,.header__nav-row .nav a:hover:after{background:var(--beige-700)}}'
      // 모바일: 햄버거를 좌측 끝으로 이동(header__actions 플렉스 흐름에서 절대배치로 빼냄) + 드롭다운을 헤더 전체가 아니라
      // header__nav-row(버튼 줄) 바로 아래(top:100%)에 붙여서, 페이지마다 다른 헤더 높이(76px/64px 등)에 안전하게 대응.
      + '@media(max-width:760px){.header__nav-row .mobile-toggle{position:absolute;left:16px;top:50%;transform:translateY(-50%);z-index:1}.header__nav-row .nav{top:calc(100% + 6px) !important}}';
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
})();
