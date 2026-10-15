// ── 마케팅 (기간별 조회 + 분석 도구 설정 + 서버 전환 전송 상태) ──
// API 계약: docs/plans/admin-marketing-page.md "API 계약" 절.
// cms.js의 apiFetch / setStatus / escapeHtml 을 그대로 쓴다.
(function () {
  const section = document.getElementById('marketingSection');
  if (!section) return;

  const $ = (id) => document.getElementById(id);
  const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
  const num = (n) => Number(n || 0).toLocaleString('ko-KR');
  const pct = (part, whole) => (Number(whole) > 0 ? `${((Number(part) / Number(whole)) * 100).toFixed(1)}%` : '-');
  // 서버 비율 값(approvalRate, emailConsentRate, smsConsentRate)은 항상 0~1 소수.
  const rate = (v) => {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '-';
    return `${(Number(v) * 100).toFixed(1)}%`;
  };
  const dateTime = (v) => (v ? new Date(v).toLocaleString('ko-KR') : '-');

  function ymd(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function parseYmd(s) {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function emptyRow(cols, msg) {
    return `<tr><td colspan="${cols}" class="field-hint">${escapeHtml(msg)}</td></tr>`;
  }

  // ── 1. 기간 선택 ──
  function setRangeDays(days) {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - (days - 1));
    $('mkFrom').value = ymd(from);
    $('mkTo').value = ymd(to);
    section.querySelectorAll('[data-mk-days]').forEach(b => b.classList.toggle('active', Number(b.dataset.mkDays) === days));
  }

  section.querySelectorAll('[data-mk-days]').forEach(btn => {
    btn.addEventListener('click', () => { setRangeDays(Number(btn.dataset.mkDays)); loadSummary(); });
  });
  $('mkRangeApply').addEventListener('click', () => {
    section.querySelectorAll('[data-mk-days]').forEach(b => b.classList.remove('active'));
    loadSummary();
  });
  ['mkFrom', 'mkTo'].forEach(id => $(id).addEventListener('change', () => {
    section.querySelectorAll('[data-mk-days]').forEach(b => b.classList.remove('active'));
  }));

  // ── 2~5. summary ──
  const SUMMARY_TARGETS = [
    ['mkChannelTable', 5], ['mkKeywordTable', 5], ['mkReferrerTable', 4],
    ['mkCourseTable', 3], ['mkCouponTable', 4], ['mkFunnelTable', 2]
  ];

  let summarySeq = 0;
  async function loadSummary() {
    const from = $('mkFrom').value;
    const to = $('mkTo').value;
    const status = $('mkSummaryStatus');
    if (from && to && from > to) { setStatus(status, '시작일이 종료일보다 늦습니다.', 'error'); return; }
    const seq = ++summarySeq;
    loadAttribution(from, to); // 같은 기간으로 유입·전환 분석 카드도 갱신
    loadGa4(from, to); // GA4 방문 통계도 같은 기간으로
    setStatus(status, '불러오는 중...');
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await apiFetch(`/admin/api/marketing/summary?${params}`);
      if (seq !== summarySeq) return; // 더 최근 요청이 있으면 버린다
      renderSummary(data || {});
      const r = data.range || {};
      setStatus(status, `${r.from || from} ~ ${r.to || to} 기준`, 'ok');
    } catch (err) {
      if (seq !== summarySeq) return;
      setStatus(status, `통계를 불러오지 못했습니다: ${err.message}`, 'error');
      $('mkKpiGrid').innerHTML = `<p class="mk-error">${escapeHtml(err.message)}</p>`;
      $('mkDailyCounts').innerHTML = `<p class="mk-error">일별 추이를 불러오지 못했습니다.</p>`;
      $('mkDailyRevenue').innerHTML = '';
      $('mkDailyCalendar').innerHTML = '<div class="mk-tip" hidden></div><p class="mk-error">불러오지 못했습니다.</p>';
      SUMMARY_TARGETS.forEach(([id, cols]) => { $(id).innerHTML = emptyRow(cols, '불러오지 못했습니다.'); });
    }
  }

  function renderSummary(data) {
    renderKpi(data.kpi || {});
    const days = fillDaily(data.daily || [], (data.range && data.range.from) || $('mkFrom').value, (data.range && data.range.to) || $('mkTo').value);
    renderDaily(days);

    const groupRow = (label, r, withRevenue) => `
      <tr>
        <td>${escapeHtml(label || '(미입력)')}</td>
        <td class="mk-num">${num(r.signups)}</td>
        <td class="mk-num">${num(r.buyers)}</td>
        ${withRevenue ? `<td class="mk-num">${won(r.revenue)}</td>` : ''}
        <td class="mk-num">${pct(r.buyers, r.signups)}</td>
      </tr>`;
    const channels = data.channels || [];
    $('mkChannelTable').innerHTML = channels.length ? channels.map(r => groupRow(r.channel, r, true)).join('') : emptyRow(5, '기간 내 가입이 없습니다.');
    const keywords = data.keywords || [];
    $('mkKeywordTable').innerHTML = keywords.length ? keywords.map(r => groupRow(r.keyword, r, true)).join('') : emptyRow(5, '검색키워드 입력이 없습니다.');
    const referrers = data.referrers || [];
    $('mkReferrerTable').innerHTML = referrers.length ? referrers.map(r => groupRow(r.code, r, false)).join('') : emptyRow(4, '추천인코드 입력이 없습니다.');

    const courses = data.courses || [];
    $('mkCourseTable').innerHTML = courses.length ? courses.map(c => `
      <tr><td>${escapeHtml(c.title || `#${c.vodCourseId}`)}</td><td class="mk-num">${num(c.approvedCount)}</td><td class="mk-num">${won(c.revenue)}</td></tr>`).join('')
      : emptyRow(3, '기간 내 승인 결제가 없습니다.');

    const coupons = data.coupons || [];
    $('mkCouponTable').innerHTML = coupons.length ? coupons.map(c => `
      <tr><td>${escapeHtml(c.label || '-')}</td><td>${c.code ? `<code>${escapeHtml(c.code)}</code>` : `코드 ${num(c.codeCount)}개`}</td><td class="mk-num">${num(c.usedCount)}</td><td class="mk-num">${won(c.discountTotal)}</td></tr>`).join('')
      : emptyRow(4, '기간 내 쿠폰 사용 결제가 없습니다.');

    const f = data.funnel || {};
    const FUNNEL = [['approved', '승인', 'badge-done'], ['pending', '대기중', 'badge-uploading'], ['expired', '만료(미결제)', 'badge-off'], ['failed', '실패', 'badge-failed'], ['canceled', '취소됨', 'badge-off']];
    const funnelTotal = FUNNEL.reduce((s, [k]) => s + Number(f[k] || 0), 0);
    $('mkFunnelTable').innerHTML = FUNNEL.map(([k, label, badge]) => `
      <tr><td><span class="badge ${badge}">${label}</span></td><td class="mk-num">${num(f[k])} <span class="field-hint">(${pct(f[k], funnelTotal)})</span></td></tr>`).join('');
  }

  function renderKpi(k) {
    // 승인(approved_at 기준)과 시도(created_at 기준)의 기간 기준이 달라 화면에서 나누지 않고 서버 값을 그대로 쓴다.
    const approval = rate(k.approvalRate);
    const tiles = [
      ['가입', `${num(k.signups)}명`],
      ['결제 시도', `${num(k.paymentAttempts)}건`],
      ['승인', `${num(k.approvedCount)}건`],
      ['매출', won(k.revenue)],
      ['승인 전환율', approval],
      ['쿠폰 사용 결제', `${num(k.couponPayments)}건`],
      ['이메일 수신 동의율', rate(k.emailConsentRate)],
      ['SMS 수신 동의율', rate(k.smsConsentRate)]
    ];
    $('mkKpiGrid').innerHTML = tiles.map(([label, value]) => `
      <div class="mk-kpi"><div class="mk-kpi-label">${label}</div><div class="mk-kpi-value">${escapeHtml(value)}</div></div>`).join('');
  }

  // 값 없는 날은 0으로 채워 기간 전체를 연속된 날짜로 만든다.
  function fillDaily(rows, from, to) {
    const byDate = new Map(rows.map(r => [String(r.date).slice(0, 10), r]));
    const out = [];
    if (!from || !to) return rows.map(r => ({ date: String(r.date).slice(0, 10), signups: +r.signups || 0, approved: +r.approved || 0, revenue: +r.revenue || 0 }));
    const end = parseYmd(to);
    for (let d = parseYmd(from); d <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
      const key = ymd(d);
      const r = byDate.get(key) || {};
      out.push({ date: key, signups: +r.signups || 0, approved: +r.approved || 0, revenue: +r.revenue || 0 });
    }
    return out;
  }

  // ── 4-2. 유입·전환 분석 (GET /admin/api/marketing/attribution) ──
  // 비율(conversionRate = 결제자 ÷ 가입, 가입 코호트 기준)은 0~1 소수, 가입 0이면 null.
  const ATTR_TARGETS = [['mkAttrChannelTable', 6], ['mkAttrKeywordTable', 6], ['mkAttrLandingTable', 6], ['mkAttrPrePurchaseTable', 4]];
  // 경로 → 한글 페이지명(journey.js 공유). journey.js가 없으면 경로만.
  const pageLabel = (path) => {
    try { if (Journey && Journey.pageLabelHtml) return Journey.pageLabelHtml(path); } catch (e) { /* journey.js 미로드 */ }
    return `<span class="mk-path">${escapeHtml(path || '')}</span>`;
  };
  const dwell = (s) => (s === null || s === undefined ? '-' : s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`);
  let attrSeq = 0;
  let attrRange = { from: '', to: '' };

  function attrParams(extra) {
    const params = new URLSearchParams();
    if (attrRange.from) params.set('from', attrRange.from);
    if (attrRange.to) params.set('to', attrRange.to);
    Object.entries(extra || {}).forEach(([k, v]) => params.set(k, v));
    return params;
  }

  async function loadAttribution(from, to) {
    attrRange = { from, to };
    const seq = ++attrSeq;
    const status = $('mkAttrStatus');
    setStatus(status, '불러오는 중...');
    try {
      const data = await apiFetch(`/admin/api/marketing/attribution?${attrParams()}`);
      if (seq !== attrSeq) return;
      renderAttribution(data || {});
      setStatus(status, '');
    } catch (err) {
      if (seq !== attrSeq) return;
      setStatus(status, `불러오지 못했습니다: ${err.message}`, 'error');
      $('mkAttrCoverage').textContent = '';
      $('mkAttrDemo').hidden = true;
      ATTR_TARGETS.forEach(([id, cols]) => { $(id).innerHTML = emptyRow(cols, '불러오지 못했습니다.'); });
    }
  }

  // 표마다 처음엔 상위 N행만 보여주고 나머지는 "더 보기"로 펼친다(키워드는 최대 50행이라 한눈에 안 들어옴).
  const ATTR_VISIBLE_ROWS = 8;

  // 숫자 셀: 0은 흐리게, 값은 tabular-nums. bar가 주어지면 셀 배경에 비율 막대(표 내 최대값 대비).
  const numCell = (v, { bar, title, cls } = {}) => {
    const n = Number(v || 0);
    const classes = ['mk-num', n === 0 ? 'mk-zero' : '', bar !== undefined ? 'mk-barcell' : '', cls || ''].filter(Boolean).join(' ');
    const barHtml = bar !== undefined ? `<i class="mk-bar" style="width:${Math.max(0, Math.min(100, bar)).toFixed(1)}%"></i>` : '';
    return `<td class="${classes}"${title ? ` title="${escapeHtml(title)}"` : ''}>${barHtml}<span>${num(n)}</span></td>`;
  };
  const rateCell = (v) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '<td class="mk-num mk-zero">-</td>';
    const r = Number(v);
    const tone = r >= 0.3 ? 'hi' : r > 0 ? '' : 'mk-zero';
    return `<td class="mk-num mk-rate ${tone}">${rate(r)}</td>`;
  };
  const wonCell = (v) => `<td class="mk-num mk-col-period ${Number(v || 0) === 0 ? 'mk-zero' : ''}">${won(v)}</td>`;
  // 출처 라벨 — "추적"(유입 쿠키) / "가입폼"(회원 입력) / "미수집"
  const srcPill = (kind) => {
    if (kind === 'tracked') return '<span class="mk-src mk-src-tracked" title="유입 쿠키로 자동 수집">추적</span>';
    if (kind === 'form') return '<span class="mk-src mk-src-form" title="회원이 가입폼에서 고른 값(유입 추적 전)">가입폼</span>';
    return '<span class="mk-src" title="유입 정보 없음">미수집</span>';
  };
  // "가입폼/학원 재원생" → 출처 알약 + 이름, 추적 채널 "naver/cpc" → "naver / cpc"
  const channelLabel = (r) => {
    const raw = String(r.channel || '');
    if (r.kind === 'form') return `${srcPill('form')}<span class="mk-label">${escapeHtml(raw.replace(/^가입폼\//, ''))}</span>`;
    if (r.kind === 'tracked') return `${srcPill('tracked')}<span class="mk-label">${escapeHtml(raw.replace('/', ' / '))}</span>`;
    return `${srcPill('none')}<span class="mk-label mk-label-muted">${escapeHtml(raw)}</span>`;
  };
  const maxOf = (rows, key) => rows.reduce((m, r) => Math.max(m, Number(r[key] || 0)), 0);
  const barPct = (v, max) => (max > 0 ? (Number(v || 0) / max) * 100 : 0);

  // 상위 N행 이후는 숨기고 "더 보기 (n)" 버튼을 켠다.
  function fillAttrTable(id, rows, rowHtml, cols, emptyMsg) {
    const tbody = $(id);
    const moreBtn = document.querySelector(`[data-mk-more="${id}"]`);
    if (!rows.length) {
      tbody.innerHTML = emptyRow(cols, emptyMsg);
      if (moreBtn) moreBtn.hidden = true;
      return;
    }
    tbody.innerHTML = rows.map((r, i) => rowHtml(r, i >= ATTR_VISIBLE_ROWS ? ' class="mk-more-row" hidden' : '')).join('');
    if (!moreBtn) return;
    const hiddenCount = Math.max(0, rows.length - ATTR_VISIBLE_ROWS);
    moreBtn.hidden = hiddenCount === 0;
    moreBtn.dataset.open = '0';
    moreBtn.textContent = `더 보기 (${hiddenCount})`;
  }

  // 시안 모드(서버가 빈 표에만 표본을 채움) — 표본 행 경로 뒤 알약, 리드 아래 안내줄
  const demoPill = (r) => (r && r.demo ? '<span class="mk-src mk-src-demo" title="시연용 표본 데이터(실데이터 아님)">시안</span>' : '');
  const kstHm = (iso) => {
    const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
    return Number.isNaN(d.getTime()) ? '' : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };

  function renderAttribution(data) {
    const t = data.totals || {};
    const demoBox = $('mkAttrDemo');
    if (data.demo && data.demo.active) {
      demoBox.innerHTML = `<span class="mk-attr-warn">시안 데이터 표시 중 — ${escapeHtml(kstHm(data.demo.until))}까지 (실데이터 없는 표에만, 자동 해제)</span>`;
      demoBox.hidden = false;
    } else {
      demoBox.innerHTML = '';
      demoBox.hidden = true;
    }
    const covChip = (label, part, whole, hint) => `
      <span class="mk-ga4-chip" title="${escapeHtml(hint)}">${escapeHtml(label)} <b>${num(part)}<span class="mk-chip-of">/ ${num(whole)}</span></b> <em>${escapeHtml(Number(whole) > 0 ? pct(part, whole) : '-')}</em></span>`;
    $('mkAttrCoverage').innerHTML = `
      ${covChip('가입 중 유입 추적', t.signupsTracked, t.signups, '기간 내 가입 회원 중 유입 쿠키가 함께 저장된 수')}
      ${covChip('결제 중 유입 추적', t.paymentsTracked, t.payments, '기간 내 승인 결제 중 유입 정보가 함께 저장된 수')}
      ${covChip('결제 중 페이지 경로', t.paymentsWithJourney, t.payments, '기간 내 승인 결제 중 결제 직전 페이지 경로가 저장된 수')}
      ${data.signupContextAvailable === false ? '<span class="mk-attr-warn">회원 가입 유입 컬럼(signup_context) 미적용 — 가입은 가입폼 값으로만 집계</span>' : ''}`;

    const metricCells = (r, maxSignups) => `
        ${numCell(r.signups, { bar: barPct(r.signups, maxSignups) })}
        ${numCell(r.buyers)}
        ${rateCell(r.conversionRate)}
        ${numCell(r.payments, { cls: 'mk-col-period mk-col-period-first' })}
        ${wonCell(r.revenue)}`;

    const channels = data.channels || [];
    const chMax = maxOf(channels, 'signups');
    fillAttrTable('mkAttrChannelTable', channels, (r, attrs) => `
      <tr${attrs}><td class="mk-labelcell">${channelLabel(r)}</td>${metricCells(r, chMax)}</tr>`,
      6, '기간 내 가입·결제가 없습니다.');

    const keywords = data.keywords || [];
    const kwMax = maxOf(keywords, 'signups');
    fillAttrTable('mkAttrKeywordTable', keywords, (r, attrs) => `
      <tr${attrs}><td class="mk-labelcell"><span class="mk-label mk-label-strong">${escapeHtml(r.keyword)}</span>${(r.sources || []).map(s => `<span class="mk-src ${s === '가입폼' ? 'mk-src-form' : 'mk-src-tracked'}">${escapeHtml(s)}</span>`).join('')}</td>${metricCells(r, kwMax)}</tr>`,
      6, '키워드가 수집된 가입·결제가 없습니다.');

    const landings = data.landings || [];
    const ldMax = maxOf(landings, 'signups');
    fillAttrTable('mkAttrLandingTable', landings, (r, attrs) => `
      <tr${attrs}><td class="mk-labelcell">${pageLabel(r.landing)}${demoPill(r)}</td>${metricCells(r, ldMax)}</tr>`,
      6, '랜딩 페이지가 수집된 가입·결제가 없습니다.');

    const pages = data.prePurchasePages || [];
    const pgMax = maxOf(pages, 'count');
    fillAttrTable('mkAttrPrePurchaseTable', pages, (r, attrs) => `
      <tr${attrs}>
        <td class="mk-labelcell">${pageLabel(r.path)}${demoPill(r)}</td>
        ${numCell(r.count, { bar: barPct(r.count, pgMax) })}
        ${numCell(r.lastPageCount)}
        <td class="mk-num${r.avgDwellSec === null || r.avgDwellSec === undefined ? ' mk-zero' : ''}" title="체류초 표본 ${num(r.dwellSamples)}건">${dwell(r.avgDwellSec)}</td>
      </tr>`,
      4, '페이지 경로가 수집된 승인 결제가 없습니다.');
  }

  // CSV: 세션 쿠키로 인증되는 GET이라 링크 이동만으로 내려받는다(UTF-8 BOM, 엑셀 호환).
  $('mkAttributionCard').addEventListener('click', (e) => {
    const more = e.target.closest('[data-mk-more]');
    if (more) {
      const open = more.dataset.open !== '1';
      more.dataset.open = open ? '1' : '0';
      const rows = $(more.dataset.mkMore).querySelectorAll('tr.mk-more-row');
      rows.forEach(tr => { tr.hidden = !open; });
      more.textContent = open ? '접기' : `더 보기 (${rows.length})`;
      return;
    }
    const btn = e.target.closest('[data-mk-csv]');
    if (!btn) return;
    const a = document.createElement('a');
    a.href = `/admin/api/marketing/attribution.csv?${attrParams({ table: btn.dataset.mkCsv })}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ── 4-3. 추적 링크 만들기 (UTM) — GET/POST/DELETE /admin/api/marketing/links (lib/attribution-report.js) ──
  // ① 채널 → ② 페이지(특정 강의 상세 포함) → ③ 이름(캠페인) 순서의 세로 폼.
  // 미리보기는 서버(validateLinkInput·buildTrackedUrl)와 같은 규칙으로 조립한다. 저장 시 url은 서버가 다시 만든다.
  const LINK_ORIGIN = 'https://dockteacher.co.kr';
  const LINK_TOKEN_RE = /^[a-z0-9_\-가-힣.]{1,60}$/;
  const LINK_PATH_RE = /^\/(?!\/)[^\s?#\u0000-\u001f]*(\?[^\s#\u0000-\u001f]*)?$/;
  const LINK_CHANNELS = [
    { key: 'instagram', name: '인스타그램', desc: '프로필 링크·스토리', icon: 'IG', source: 'instagram', medium: 'social' },
    { key: 'youtube', name: '유튜브', desc: '영상 설명·고정 댓글', icon: 'YT', source: 'youtube', medium: 'social' },
    { key: 'naver_blog', name: '네이버 블로그', desc: '글 본문·하단 링크', icon: 'B', source: 'naver_blog', medium: 'social' },
    { key: 'naver_cafe', name: '네이버 카페', desc: '카페 게시글·댓글', icon: 'C', source: 'naver_cafe', medium: 'social' },
    { key: 'kakao', name: '카카오톡 채널', desc: '채널 메시지·소식', icon: 'K', source: 'kakao', medium: 'message' },
    { key: 'facebook', name: '페이스북', desc: '게시물·페이지', icon: 'f', source: 'facebook', medium: 'social' },
    { key: 'sms', name: '문자(SMS)', desc: '단체 문자·알림톡', icon: 'SMS', source: 'sms', medium: 'message' },
    { key: 'custom', name: '기타', desc: '출처·매체 직접 입력', icon: '+' }
  ];
  // 홍보용 페이지만(결제 완료·결제 처리 중·강의 수강·마이페이지·약관·개인정보 제외)
  const LINK_PAGES = [
    { key: 'home', name: '홈', path: '/' },
    { key: 'vod', name: 'VOD 강좌 목록', path: '/vod.html' },
    { key: 'reviews', name: '수강후기', path: '/reviews.html' },
    { key: 'curriculum', name: '커리큘럼', path: '/curriculum.html' },
    { key: 'cert', name: '합격 인증', path: '/cert.html' },
    { key: 'intro', name: '학습소개', path: '/intro.html' },
    { key: 'join', name: '회원가입', path: '/join.html' },
    { key: 'course', name: '특정 강의 상세' },
    { key: 'custom', name: '직접 입력' }
  ];
  const COURSE_KINDS = {
    vod: { name: 'VOD 강좌 상세', label: 'VOD 강좌', path: id => `/vodDetail.html?id=${encodeURIComponent(id)}` },
    class: { name: '클래스 상세', label: '클래스', path: id => `/classDetail.html?id=${encodeURIComponent(id)}` }
  };
  const linkToken = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, '_');
  let linkChannel = null;          // 아직 고르지 않음
  let linkPage = LINK_PAGES[0];
  let courseKind = 'vod';
  // 강의 목록: null=아직, 'loading', 'error', 또는 [{id, title, hidden, ended}]
  const linkCourses = { vod: null, class: null };
  let campaignEdited = false;      // 한 번 직접 고치면 자동 제안 중단
  let linkRows = [];

  const journeyPageName = (p) => {
    try { if (typeof Journey !== 'undefined' && Journey.pageName) return Journey.pageName(p); } catch (e) { /* journey.js 미로드 */ }
    return '';
  };
  // 오늘(KST) YYMMDD
  const kstYmd = () => {
    const d = new Date(Date.now() + 9 * 3600000);
    return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  function renderLinkChannels() {
    $('mkLinkChannel').innerHTML = LINK_CHANNELS.map(c => `
      <button class="mk-link-channel${c === linkChannel ? ' active' : ''}" type="button" data-mk-channel="${c.key}" aria-pressed="${c === linkChannel}">
        <span class="mk-link-ch-icon mk-ch-${c.key}">${escapeHtml(c.icon)}</span>
        <span class="mk-link-ch-text"><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.desc)}</small></span>
      </button>`).join('');
  }
  function renderLinkPages() {
    $('mkLinkPages').innerHTML = LINK_PAGES.map(p => `
      <button class="mk-link-chip${p === linkPage ? ' active' : ''}${p.key === 'course' ? ' mk-link-chip-course' : ''}" type="button" data-mk-page="${p.key}" aria-pressed="${p === linkPage}">${escapeHtml(p.name)}</button>`).join('');
  }

  // ── 특정 강의 상세: GET /admin/api/vod-courses, /admin/api/classes (마케팅 섹션 첫 로드 시 1회) ──
  const truthy = v => v === true || v === 1 || v === '1';
  async function loadLinkCourses() {
    const load = async (kind, url, map) => {
      linkCourses[kind] = 'loading';
      try {
        const rows = await apiFetch(url);
        linkCourses[kind] = (Array.isArray(rows) ? rows : []).map(map).filter(c => c.id && c.title);
      } catch (e) {
        linkCourses[kind] = 'error';
      }
      if (linkPage.key === 'course') { renderCourseSelect(); updateLinkForm(); }
    };
    await Promise.all([
      load('vod', '/admin/api/vod-courses', r => ({
        id: String(r.id), title: String(r.title || '').replace(/\s+/g, ' ').trim(),
        hidden: r.is_active !== undefined && !truthy(r.is_active), ended: truthy(r.is_ended)
      })),
      load('class', '/admin/api/classes', r => ({
        id: String(r.id), title: String(r.name || r.thumb_title || '').replace(/\s+/g, ' ').trim(),
        hidden: r.is_active !== undefined && !truthy(r.is_active), ended: false
      }))
    ]);
  }
  function renderCourseSelect() {
    document.querySelectorAll('#mkLinkCourseTabs [data-mk-course-kind]').forEach(b => b.classList.toggle('active', b.dataset.mkCourseKind === courseKind));
    const sel = $('mkLinkCourse');
    const hint = $('mkLinkCourseHint');
    const list = linkCourses[courseKind];
    const prev = sel.value;
    const kindName = COURSE_KINDS[courseKind].label;
    if (!Array.isArray(list)) {
      sel.innerHTML = `<option value="">${list === 'error' ? '목록을 불러오지 못했습니다' : '불러오는 중…'}</option>`;
      sel.disabled = true;
      hint.textContent = list === 'error' ? `${kindName} 목록을 불러오지 못했습니다. '직접 입력'으로 경로를 넣어도 됩니다.` : '';
      return;
    }
    const q = $('mkLinkCourseSearch').value.trim().toLowerCase();
    const shown = q ? list.filter(c => c.title.toLowerCase().includes(q) || c.id === q) : list;
    sel.disabled = false;
    sel.innerHTML = `<option value="">${shown.length ? `${kindName}를 고르세요 (${shown.length}개)` : '검색 결과가 없습니다'}</option>`
      + shown.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}${c.hidden ? ' (비공개)' : c.ended ? ' (종료)' : ''}</option>`).join('');
    if (prev && shown.some(c => c.id === prev)) sel.value = prev;
    const cur = selectedCourse();
    hint.textContent = cur && (cur.hidden || cur.ended)
      ? `이 강의는 현재 ${cur.hidden ? '비공개' : '판매 종료'} 상태라 방문자에게 안 보이거나 구매할 수 없습니다.`
      : '';
  }
  function selectedCourse() {
    const list = linkCourses[courseKind];
    const id = $('mkLinkCourse').value;
    return Array.isArray(list) && id ? list.find(c => c.id === id) || null : null;
  }

  // 현재 대상 페이지 → { path, pageTitle, pageName }
  function linkTarget() {
    if (linkPage.key === 'course') {
      const c = selectedCourse();
      return c
        ? { path: COURSE_KINDS[courseKind].path(c.id), pageTitle: c.title, pageName: c.title }
        : { path: '', pageTitle: '', pageName: '' };
    }
    if (linkPage.key === 'custom') {
      const p = $('mkLinkPathCustom').value.trim();
      return { path: p, pageTitle: '', pageName: journeyPageName(p) || p };
    }
    return { path: linkPage.path, pageTitle: '', pageName: linkPage.name };
  }
  function channelSource() {
    if (!linkChannel) return '';
    return linkChannel.key === 'custom' ? linkToken($('mkLinkSource').value) : linkChannel.source;
  }
  function channelDisplayName() {
    if (!linkChannel) return '';
    if (linkChannel.key !== 'custom') return linkChannel.name;
    return $('mkLinkSource').value.trim() || '기타';
  }
  function suggestCampaign() {
    if (campaignEdited || !linkChannel) return;
    const s = `${kstYmd()}_${channelSource() || 'etc'}`;
    $('mkLinkCampaign').value = LINK_TOKEN_RE.test(s) ? s : `${kstYmd()}_etc`;
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const autoLabel = (v, t) => clip([channelDisplayName(), v.campaign, t.pageName].filter(Boolean).join(' · '), 60);

  function readLinkForm() {
    const custom = !!linkChannel && linkChannel.key === 'custom';
    const t = linkTarget();
    const v = {
      path: t.path,
      source: channelSource(),
      medium: !linkChannel ? '' : custom ? linkToken($('mkLinkMedium').value) : linkChannel.medium,
      campaign: linkToken($('mkLinkCampaign').value),
      content: linkToken($('mkLinkContent').value),
      term: $('mkLinkTerm').value.trim().replace(/\s+/g, ' '),
      channelLabel: clip(channelDisplayName(), 60)
    };
    if (t.pageTitle) v.pageTitle = clip(t.pageTitle, 120);
    v.label = $('mkLinkLabel').value.trim() || autoLabel(v, t);
    return v;
  }
  // 받침 유무로 을/를, 과/와
  const hasBatchim = (w) => {
    const c = w.charCodeAt(w.length - 1);
    return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 > 0;
  };
  const objJosa = (w) => (hasBatchim(w) ? '을' : '를');
  // 빠진 단계 안내 → 형식 오류 순으로 첫 문제를 돌려준다(없으면 '')
  function linkUrlError(v) {
    const missing = [];
    if (!linkChannel) missing.push('① 채널');
    else if (linkChannel.key === 'custom' && (!v.source || !v.medium)) missing.push('① 출처·매체');
    if (linkPage.key === 'course' && !v.path) missing.push('② 강의');
    else if (linkPage.key === 'custom' && !v.path) missing.push('② 페이지 경로');
    if (!v.campaign) missing.push('③ 이름');
    if (missing.length) {
      const last = missing[missing.length - 1];
      const prev = missing[missing.length - 2] || '';
      const head = prev ? `${missing.slice(0, -1).join(', ')}${hasBatchim(prev) ? '과' : '와'} ` : '';
      return `${head}${last}${objJosa(last)} 정하면 링크가 만들어집니다.`;
    }
    if (v.path.length > 200 || !LINK_PATH_RE.test(v.path)) return '② 페이지 경로는 /로 시작해야 합니다 (예: /notice.html).';
    if (!LINK_TOKEN_RE.test(v.source)) return '① 출처 이름(utm_source)은 영문 소문자·숫자·한글·_ - . 만 쓸 수 있습니다.';
    if (!LINK_TOKEN_RE.test(v.medium)) return '① 매체(utm_medium)는 영문 소문자·숫자·한글·_ - . 만 쓸 수 있습니다.';
    if (!LINK_TOKEN_RE.test(v.campaign)) return '③ 이름은 60자 이내의 영문 소문자·숫자·한글·_ - . 만 쓸 수 있습니다.';
    if (v.content && !LINK_TOKEN_RE.test(v.content)) return '세부(고급 옵션)는 60자 이내의 영문 소문자·숫자·한글·_ - . 만 쓸 수 있습니다.';
    if (v.term.length > 60) return '검색어(고급 옵션)는 60자 이내로 입력하세요.';
    return '';
  }
  function buildLinkUrl(v) {
    const qi = v.path.indexOf('?');
    const base = qi >= 0 ? v.path.slice(0, qi) : v.path;
    const params = new URLSearchParams(qi >= 0 ? v.path.slice(qi + 1) : '');
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => params.delete(k));
    params.set('utm_source', v.source);
    params.set('utm_medium', v.medium);
    params.set('utm_campaign', v.campaign);
    if (v.content) params.set('utm_content', v.content);
    if (v.term) params.set('utm_term', v.term);
    return `${LINK_ORIGIN}${base}?${params}`;
  }
  let linkPreviewUrl = '';
  function updateLinkForm() {
    const custom = !!linkChannel && linkChannel.key === 'custom';
    $('mkLinkCustomRow').hidden = !custom;
    $('mkLinkCourseBox').hidden = linkPage.key !== 'course';
    $('mkLinkPathCustomRow').hidden = linkPage.key !== 'custom';
    const v = readLinkForm();
    $('mkLinkLabel').placeholder = !$('mkLinkLabel').value.trim() && linkChannel && v.campaign
      ? `자동: ${v.label}` : '비우면 채널 · 이름 · 페이지로 자동';
    const err = linkUrlError(v);
    linkPreviewUrl = err ? '' : buildLinkUrl(v);
    const preview = $('mkLinkPreview');
    preview.textContent = err || linkPreviewUrl;
    preview.classList.toggle('empty', !!err);
    $('mkLinkCopy').disabled = !!err;
    $('mkLinkSave').disabled = !!err;
  }

  // 클립보드: navigator.clipboard(HTTPS·권한 필요) 실패 시 임시 입력칸 select + execCommand('copy')
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* 폴백 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  async function copyWithStatus(text, okMsg) {
    const status = $('mkLinkStatus');
    if (await copyText(text)) setStatus(status, okMsg || '복사했습니다', 'ok');
    else setStatus(status, '자동 복사에 실패했습니다. 위 링크를 직접 선택해 복사하세요.', 'error');
  }

  // 페이지 열: 강의 상세는 "VOD 강좌 상세 · 제목"(pageTitle), 그 외 한글 페이지명
  const linkPageText = (l) => {
    const [base, q] = String(l.path || '').split('?');
    const name = journeyPageName(base);
    if (l.pageTitle) {
      return `<span class="mk-pagename">${escapeHtml(name || base)} · ${escapeHtml(l.pageTitle)}</span>`;
    }
    const qText = q ? ` ?${q}` : '';
    return name
      ? `<span class="mk-pagename">${escapeHtml(name)}${qText ? ` <small>${escapeHtml(qText)}</small>` : ''}</span>`
      : `<span class="mk-path">${escapeHtml(l.path || '')}</span>`;
  };
  const linkChannelCell = (l) => {
    const known = LINK_CHANNELS.find(c => c.source && c.source === l.source && c.medium === l.medium);
    return `<span class="mk-src mk-src-tracked">${escapeHtml(known ? known.name : '직접')}</span><span class="mk-label">${escapeHtml(`${l.source} / ${l.medium}`)}</span>`;
  };
  const shortDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
  };

  function renderLinks() {
    const tbody = $('mkLinkTable');
    if (!linkRows.length) { tbody.innerHTML = emptyRow(10, '아직 만든 링크가 없습니다.'); return; }
    const STAT_TIP = '이 링크로 들어와 가입/결제한 수(추적 쿠키 기준, 설치 이후)';
    tbody.innerHTML = linkRows.map(l => {
      const s = l.stats || {};
      const shortUrl = `${l.path || '/'} · ${l.campaign}`; // 경로 + 캠페인만. 전체 주소는 툴팁·복사 버튼
      return `
      <tr>
        <td><span class="mk-label mk-label-strong">${escapeHtml(l.label || '-')}</span></td>
        <td><div class="mk-labelcell">${linkChannelCell(l)}</div></td>
        <td>${escapeHtml(l.campaign)}${l.content ? `<div class="field-hint" style="margin:2px 0 0;">${escapeHtml(l.content)}</div>` : ''}</td>
        <td class="mk-link-pagecell">${linkPageText(l)}</td>
        <td><div class="mk-link-urlcell"><span class="mk-link-url" title="${escapeHtml(l.url)}">${escapeHtml(shortUrl)}</span>
          <button class="row-btn" type="button" data-mk-link-copy="${escapeHtml(l.id)}">복사</button></div></td>
        ${numCell(s.signups, { title: STAT_TIP })}
        ${numCell(s.payments, { title: STAT_TIP })}
        <td class="mk-num${Number(s.revenue || 0) === 0 ? ' mk-zero' : ''}">${won(s.revenue)}</td>
        <td class="mk-link-date">${escapeHtml(shortDate(l.createdAt))}${s.lastSeen ? `<div class="field-hint" style="margin:2px 0 0;" title="이 링크로 들어온 마지막 가입·결제">최근 ${escapeHtml(shortDate(s.lastSeen))}</div>` : ''}</td>
        <td><button class="row-btn danger" type="button" data-mk-link-del="${escapeHtml(l.id)}">삭제</button></td>
      </tr>`;
    }).join('');
  }

  async function loadLinks() {
    const status = $('mkLinkListStatus');
    try {
      const data = await apiFetch('/admin/api/marketing/links');
      linkRows = Array.isArray(data.links) ? data.links : [];
      renderLinks();
      setStatus(status, '');
    } catch (err) {
      $('mkLinkTable').innerHTML = emptyRow(10, '불러오지 못했습니다.');
      setStatus(status, `링크 목록을 불러오지 못했습니다: ${err.message}`, 'error');
    }
  }

  $('mkLinkChannel').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mk-channel]');
    if (!btn) return;
    linkChannel = LINK_CHANNELS.find(c => c.key === btn.dataset.mkChannel) || null;
    renderLinkChannels();
    suggestCampaign();
    updateLinkForm();
    if (linkChannel && linkChannel.key === 'custom') $('mkLinkSource').focus();
  });
  $('mkLinkPages').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mk-page]');
    if (!btn) return;
    linkPage = LINK_PAGES.find(p => p.key === btn.dataset.mkPage) || LINK_PAGES[0];
    renderLinkPages();
    if (linkPage.key === 'course') renderCourseSelect();
    updateLinkForm();
    if (linkPage.key === 'custom') $('mkLinkPathCustom').focus();
  });
  $('mkLinkCourseTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mk-course-kind]');
    if (!btn || btn.dataset.mkCourseKind === courseKind) return;
    courseKind = btn.dataset.mkCourseKind;
    $('mkLinkCourse').value = '';
    renderCourseSelect();
    updateLinkForm();
  });
  $('mkLinkCourseSearch').addEventListener('input', () => { renderCourseSelect(); updateLinkForm(); });
  $('mkLinkCourse').addEventListener('change', () => { renderCourseSelect(); updateLinkForm(); });
  $('mkLinkSource').addEventListener('input', () => { suggestCampaign(); updateLinkForm(); });
  $('mkLinkCampaign').addEventListener('input', () => { campaignEdited = true; updateLinkForm(); });
  ['mkLinkPathCustom', 'mkLinkMedium', 'mkLinkContent', 'mkLinkTerm', 'mkLinkLabel'].forEach(id => {
    $(id).addEventListener('input', updateLinkForm);
  });
  $('mkLinkCopy').addEventListener('click', () => {
    updateLinkForm();
    if (linkPreviewUrl) copyWithStatus(linkPreviewUrl, '복사했습니다 (목록에는 저장하지 않았습니다)');
  });
  $('mkLinkSave').addEventListener('click', async () => {
    updateLinkForm();
    const status = $('mkLinkStatus');
    const v = readLinkForm();
    if (!linkPreviewUrl) return;
    const btn = $('mkLinkSave');
    btn.disabled = true;
    try {
      const res = await apiFetch('/admin/api/marketing/links', { method: 'POST', body: JSON.stringify(v) });
      await loadLinks();
      await copyWithStatus(res.link.url, '저장하고 복사했습니다 — 아래 목록 맨 위에 추가됐습니다');
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      btn.disabled = false;
      updateLinkForm();
    }
  });
  $('mkLinkTable').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-mk-link-copy]');
    if (copyBtn) {
      const l = linkRows.find(r => r.id === copyBtn.dataset.mkLinkCopy);
      if (l) copyWithStatus(l.url, `복사했습니다 — ${l.label}`);
      return;
    }
    const delBtn = e.target.closest('[data-mk-link-del]');
    if (!delBtn) return;
    const l = linkRows.find(r => r.id === delBtn.dataset.mkLinkDel);
    if (!l) return;
    if (!confirm(`'${l.label}' 링크를 목록에서 삭제할까요?\n이미 올린 링크는 그대로 동작하고 유입·전환 분석에도 계속 집계됩니다.`)) return;
    delBtn.disabled = true;
    try {
      await apiFetch(`/admin/api/marketing/links/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
      await loadLinks();
      setStatus($('mkLinkStatus'), '삭제했습니다', 'ok');
    } catch (err) {
      delBtn.disabled = false;
      setStatus($('mkLinkStatus'), err.message, 'error');
    }
  });
  renderLinkChannels();
  renderLinkPages();
  updateLinkForm();

  // ── 3-2. GA4 방문 통계 (GET /admin/api/marketing/ga4, /ga4/realtime) ──
  // 서버가 GA4 Data API 응답을 1시간(realtime 30초) 캐시한다. 비율(engagementRate)은 0~1.
  // 502 응답의 hint까지 보여줘야 해서 apiFetch 대신 상태코드·본문을 그대로 받는다.
  async function fetchJson(url, options) {
    const res = await fetch(url, { ...(options || {}), headers: { 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  const GA4_SITE = 'https://dockteacher.co.kr';
  const GA4_FUNNEL = [
    ['page_view', '페이지 조회'], ['view_item', '강좌 상세 조회'], ['begin_checkout', '결제 시작'], ['purchase', '구매']
  ];
  const GA4_OTHER_EVENTS = [['sign_up', '회원가입'], ['login', '로그인']];
  const GA4_REFRESH_COOLDOWN = 60;
  let ga4Seq = 0;
  let ga4State = ''; // '' | 'ok' | 'unconfigured' | 'error'
  let ga4Range = { from: '', to: '' };
  let realtimeTimer = null;
  let realtimeLoadedOnce = false;

  function showGa4(state) {
    ga4State = state;
    $('mkGa4Body').hidden = state !== 'ok';
    $('mkGa4Unconfigured').hidden = state !== 'unconfigured';
    $('mkGa4Error').hidden = state !== 'error';
  }

  // GA4 date 차원은 'YYYYMMDD'로 온다. 서버가 정규화했더라도 둘 다 받는다.
  const ga4Date = (v) => {
    const s = String(v || '');
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
  };
  const pathCell = (p) => {
    const path = String(p || '');
    if (!path.startsWith('/')) return `<code>${escapeHtml(path || '(not set)')}</code>`;
    return `<a class="mk-pagelink" href="${escapeHtml(GA4_SITE + path)}" target="_blank" rel="noopener noreferrer" title="새 창에서 열기">${pageLabel(path)}</a>`;
  };

  async function loadGa4(from, to, opts) {
    ga4Range = { from, to };
    const seq = ++ga4Seq;
    const status = $('mkGa4Status');
    setStatus(status, '불러오는 중...');
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (opts && opts.refresh) params.set('refresh', '1');
    let res;
    try {
      res = await fetchJson(`/admin/api/marketing/ga4?${params}`);
    } catch (err) {
      res = { ok: false, status: 0, data: { error: `서버에 연결하지 못했습니다: ${err.message}` } };
    }
    if (seq !== ga4Seq) return; // 더 최근 요청이 있으면 버린다
    const d = res.data;
    setStatus(status, '');
    if (res.ok && d.configured === false) {
      showGa4('unconfigured');
      return;
    }
    if (!res.ok) {
      showGa4('error');
      $('mkGa4Error').innerHTML = `
        <p><b>GA4 통계를 불러오지 못했습니다.</b> ${escapeHtml(d.error || `요청에 실패했습니다 (HTTP ${res.status}).`)}</p>
        ${d.hint ? `<p class="mk-ga4-hint">${escapeHtml(d.hint)}</p>` : ''}`;
      return;
    }
    showGa4('ok');
    renderGa4(d);
    if (!realtimeLoadedOnce) loadGa4Realtime();
  }

  function renderGa4(d) {
    const t = d.totals || {};
    $('mkGa4Totals').innerHTML = [['세션', t.sessions], ['사용자', t.totalUsers], ['신규', t.newUsers], ['페이지뷰', t.screenPageViews]]
      .map(([label, v]) => `<span class="mk-ga4-chip">${label} <b>${num(v)}</b></span>`).join('');

    const fetched = d.fetchedAt ? new Date(d.fetchedAt) : null;
    let meta = '';
    if (fetched && !Number.isNaN(fetched.getTime())) {
      const mins = Math.max(0, Math.round((Date.now() - fetched.getTime()) / 60000));
      const time = fetched.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      meta = d.cached ? `${mins ? `${mins}분 전` : '방금'} 조회 (${time}, 1시간 캐시)` : `${time} 조회`;
    }
    $('mkGa4Meta').textContent = meta;

    // 값 없는 날은 0으로 채워 기간 전체를 보여주고, 최근 날짜가 위로 오게 한다.
    const range = d.range || ga4Range;
    const byDate = new Map((d.daily || []).map(r => [ga4Date(r.date), r]));
    let days = [];
    if (range.from && range.to) {
      const end = parseYmd(range.to);
      for (let x = parseYmd(range.from); x <= end && days.length < 400; x.setDate(x.getDate() + 1)) {
        const key = ymd(x);
        days.push({ ...(byDate.get(key) || {}), date: key });
      }
    } else {
      days = (d.daily || []).map(r => ({ ...r, date: ga4Date(r.date) }));
    }
    const maxSessions = Math.max(0, ...days.map(r => Number(r.sessions) || 0));
    $('mkGa4DailyTable').innerHTML = days.length ? days.slice().reverse().map(r => {
      const w = maxSessions > 0 ? Math.round(((Number(r.sessions) || 0) / maxSessions) * 100) : 0;
      return `
      <tr>
        <td>${escapeHtml(r.date)}</td>
        <td class="mk-num">${num(r.sessions)}</td>
        <td class="mk-ga4-barcell"><span class="mk-ga4-bar" style="width:${w}%"></span></td>
        <td class="mk-num">${num(r.totalUsers)}</td>
        <td class="mk-num">${num(r.newUsers)}</td>
        <td class="mk-num">${num(r.screenPageViews)}</td>
        <td class="mk-num">${num(r.keyEvents)}</td>
      </tr>`;
    }).join('') : emptyRow(7, '데이터 없음');

    const pages = d.pages || [];
    $('mkGa4PagesTable').innerHTML = pages.length ? pages.map(r => `
      <tr>
        <td>${pathCell(r.pagePath)}</td>
        <td class="mk-num">${num(r.screenPageViews)}</td>
        <td class="mk-num">${num(r.totalUsers)}</td>
        <td class="mk-num">${r.avgEngagementSec === null || r.avgEngagementSec === undefined ? '-' : dwell(Math.round(Number(r.avgEngagementSec) || 0))}</td>
        <td class="mk-num">${rate(r.engagementRate)}</td>
      </tr>`).join('') : emptyRow(5, '데이터 없음');

    const sources = d.sources || [];
    $('mkGa4SourcesTable').innerHTML = sources.length ? sources.map(r => `
      <tr>
        <td><code>${escapeHtml(`${r.source || '(not set)'} / ${r.medium || '(not set)'}`)}</code></td>
        <td class="mk-num">${num(r.sessions)}</td>
        <td class="mk-num">${num(r.totalUsers)}</td>
        <td class="mk-num">${num(r.engagedSessions)}</td>
        <td class="mk-num">${num(r.keyEvents)}</td>
      </tr>`).join('') : emptyRow(5, '데이터 없음');

    const landings = d.landings || [];
    $('mkGa4LandingsTable').innerHTML = landings.length ? landings.map(r => `
      <tr>
        <td>${pathCell(r.landingPage)}</td>
        <td class="mk-num">${num(r.sessions)}</td>
        <td class="mk-num">${num(r.totalUsers)}</td>
        <td class="mk-num">${num(r.keyEvents)}</td>
      </tr>`).join('') : emptyRow(4, '데이터 없음');

    // 퍼널: page_view → view_item → begin_checkout → purchase, 이전 단계 사용자 대비 비율.
    const events = new Map((d.events || []).map(r => [r.eventName, r]));
    if (!events.size) {
      $('mkGa4EventsTable').innerHTML = emptyRow(4, '데이터 없음');
      return;
    }
    let prevUsers = 0;
    const funnelRows = GA4_FUNNEL.map(([name, label], i) => {
      const r = events.get(name) || {};
      const users = Number(r.totalUsers) || 0;
      const ratio = i === 0 ? '<span class="field-hint">기준</span>' : `<span class="mk-ga4-ratio">${pct(users, prevUsers)}</span>`;
      prevUsers = users;
      return `
      <tr>
        <td><span class="mk-ga4-step">${i + 1}</span><code>${name}</code> <span class="field-hint">${label}</span></td>
        <td class="mk-num">${num(r.eventCount)}</td>
        <td class="mk-num">${num(r.totalUsers)}</td>
        <td class="mk-num">${ratio}</td>
      </tr>`;
    }).join('');
    const otherRows = GA4_OTHER_EVENTS.map(([name, label], i) => {
      const r = events.get(name) || {};
      return `
      <tr class="${i === 0 ? 'mk-ga4-sep' : ''}">
        <td><code>${name}</code> <span class="field-hint">${label}</span></td>
        <td class="mk-num">${num(r.eventCount)}</td>
        <td class="mk-num">${num(r.totalUsers)}</td>
        <td class="mk-num">-</td>
      </tr>`;
    }).join('');
    $('mkGa4EventsTable').innerHTML = funnelRows + otherRows;
  }

  // "새로 조회": 서버 캐시를 무시하므로 GA4 쿼터 보호를 위해 클라이언트에서 60초에 1회만.
  let refreshTimer = null;
  $('mkGa4Refresh').addEventListener('click', () => {
    if (refreshTimer) return;
    const btn = $('mkGa4Refresh');
    let left = GA4_REFRESH_COOLDOWN;
    btn.disabled = true;
    btn.textContent = `새로 조회 (${left}초)`;
    refreshTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { btn.textContent = `새로 조회 (${left}초)`; return; }
      clearInterval(refreshTimer);
      refreshTimer = null;
      btn.disabled = false;
      btn.textContent = '새로 조회';
    }, 1000);
    loadGa4(ga4Range.from, ga4Range.to, { refresh: true });
    loadGa4Realtime();
  });

  $('mkGa4GuideOpen').addEventListener('click', () => {
    const details = section.querySelector('#mkGuideCard details');
    if (details) details.open = true;
    ($('mkGuideGa4') || $('mkGuideCard')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 현재 접속자: 마케팅 섹션이 보이는(섹션 active + 브라우저 탭 표시) 동안만 60초 간격.
  async function loadGa4Realtime() {
    if (ga4State !== 'ok') return; // 미설정·오류 상태면 호출하지 않는다
    const el = $('mkGa4Realtime');
    const off = (title) => { el.innerHTML = '<i></i>현재 접속 -'; el.title = title; el.classList.add('off'); };
    try {
      const res = await fetchJson('/admin/api/marketing/ga4/realtime');
      if (!res.ok) return off(res.data.error || '실시간 조회 실패');
      if (!res.data.configured) return off('GA4 미연결');
      realtimeLoadedOnce = true;
      el.innerHTML = `<i></i>현재 접속 <b>${num(res.data.activeUsers)}</b>명`;
      el.title = `최근 30분 활성 사용자 · ${dateTime(res.data.fetchedAt)} 기준`;
      el.classList.remove('off');
    } catch (err) {
      off(err.message);
    }
  }
  function syncRealtimeTimer() {
    const visible = section.classList.contains('active') && document.visibilityState !== 'hidden';
    if (visible && !realtimeTimer) {
      if (realtimeLoadedOnce) loadGa4Realtime();
      realtimeTimer = setInterval(loadGa4Realtime, 60000);
    } else if (!visible && realtimeTimer) {
      clearInterval(realtimeTimer);
      realtimeTimer = null;
    }
  }
  document.addEventListener('visibilitychange', syncRealtimeTimer);

  // ── 3. 일별 추이 (인라인 SVG) ──
  // dataviz 규칙: 이중 축 금지 → 건수(가입·승인)와 매출(원)을 별도 차트로.
  // 색은 검증된 범주 팔레트 고정 순서(1 파랑=가입, 2 주황=승인, 3 청록=매출). 청록은 대비 3:1 미만이라
  // 매출 달력(칸마다 금액 텍스트)을 함께 제공(relief rule). 텍스트는 시리즈 색이 아니라 텍스트 토큰.
  const SERIES = {
    signups: { label: '가입', color: '#2a78d6' },
    approved: { label: '승인', color: '#eb6834' },
    revenue: { label: '매출', color: '#1baf7a' }
  };

  function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * pow;
  }
  function shortNum(v) {
    if (v >= 100000000) return `${+(v / 100000000).toFixed(1)}억`;
    if (v >= 10000) return `${+(v / 10000).toFixed(1)}만`;
    return num(v);
  }
  // 위쪽 모서리만 둥근 막대(기준선에 붙은 쪽은 각지게)
  function barPath(x, y, w, h) {
    if (h <= 0) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function barChart({ title, unitFmt, keys, days }) {
    const W = 1000, H = 220, padL = 56, padR = 12, padT = 12, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = niceMax(Math.max(0, ...days.flatMap(d => keys.map(k => d[k]))));
    const y = (v) => padT + plotH - (v / max) * plotH;
    const band = plotW / Math.max(1, days.length);
    const groupW = band * 0.8;
    const gap = keys.length > 1 && groupW > 8 ? 2 : 0; // 인접 막대 사이 2px 표면 간격
    const barW = Math.max(1, (groupW - gap * (keys.length - 1)) / keys.length);

    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const gy = y(v);
      grid += `<line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" class="mk-grid${i === 0 ? ' mk-baseline' : ''}"/>`;
      grid += `<text x="${padL - 8}" y="${gy + 4}" text-anchor="end" class="mk-axis">${escapeHtml(shortNum(v))}</text>`;
    }

    const labelEvery = Math.ceil(days.length / 10);
    let bars = '', xLabels = '', hits = '';
    days.forEach((d, i) => {
      const gx = padL + band * i + (band - groupW) / 2;
      keys.forEach((k, j) => {
        const bx = gx + j * (barW + gap);
        const v = d[k];
        if (v > 0) bars += `<path d="${barPath(bx, y(v), barW, y(0) - y(v))}" fill="${SERIES[k].color}"/>`;
      });
      if (i % labelEvery === 0) {
        xLabels += `<text x="${padL + band * i + band / 2}" y="${H - 8}" text-anchor="middle" class="mk-axis">${d.date.slice(5).replace('-', '/')}</text>`;
      }
      const tip = `${d.date}\n` + keys.map(k => `${SERIES[k].label}: ${unitFmt(d[k])}`).join('\n');
      hits += `<rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" class="mk-hit" data-tip="${escapeHtml(tip)}"></rect>`;
    });

    const legend = keys.length > 1
      ? `<div class="mk-legend">${keys.map(k => `<span><i style="background:${SERIES[k].color}"></i>${SERIES[k].label}</span>`).join('')}</div>`
      : '';
    const total = keys.map(k => `${SERIES[k].label} 합계 ${unitFmt(days.reduce((s, d) => s + d[k], 0))}`).join(' · ');
    return `
      <div class="mk-chart-head"><h3 class="mk-h3">${escapeHtml(title)}</h3>${legend}</div>
      <div class="mk-chart-box">
        <svg viewBox="0 0 ${W} ${H}" class="mk-svg" role="img" aria-label="${escapeHtml(`${title} — ${total}`)}">
          ${grid}${bars}${xLabels}${hits}
        </svg>
        <div class="mk-tip" hidden></div>
      </div>
      <div class="field-hint">${escapeHtml(total)} · 막대에 마우스를 올리면 날짜별 값이 보입니다.</div>`;
  }

  // 차트 툴팁: SVG <title>은 브라우저마다 지연·미표시가 있어 HTML 툴팁을 마우스 위치에 띄운다(터치는 탭으로).
  (function wireChartTips() {
    const section = $('marketingSection');
    if (!section) return;
    const hideAll = () => section.querySelectorAll('.mk-tip').forEach(t => { t.hidden = true; });
    const show = (e) => {
      const hit = e.target.closest && e.target.closest('.mk-hit');
      const box = hit && hit.closest('.mk-chart-box');
      if (!hit || !box) return hideAll();
      const tip = box.querySelector('.mk-tip');
      if (!tip) return;
      tip.textContent = hit.dataset.tip || '';
      tip.hidden = false;
      const rect = box.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const flip = x > rect.width * 0.6;
      tip.style.left = flip ? 'auto' : `${x + 14}px`;
      tip.style.right = flip ? `${rect.width - x + 14}px` : 'auto';
      tip.style.top = `${Math.max(0, y - 12)}px`;
    };
    section.addEventListener('mousemove', show);
    section.addEventListener('mouseleave', hideAll);
    section.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.mk-hit')) show(e); });
  })();

  function renderDaily(days) {
    if (!days.length) {
      $('mkDailyCounts').innerHTML = '<p class="field-hint">표시할 데이터가 없습니다.</p>';
      $('mkDailyRevenue').innerHTML = '';
      renderCalendar([]);
      return;
    }
    $('mkDailyCounts').innerHTML = barChart({ title: '가입 · 승인 (건)', unitFmt: (v) => num(v), keys: ['signups', 'approved'], days });
    $('mkDailyRevenue').innerHTML = barChart({ title: '매출 (원)', unitFmt: won, keys: ['revenue'], days });
    renderCalendar(days);
  }

  // 일별 매출 달력. days = fillDaily() 결과(기간 내 모든 날짜, 오름차순, 키는 ymd() 로컬 날짜).
  function renderCalendar(days) {
    const wrap = $('mkDailyCalendar');
    if (!wrap) return;
    const tip = '<div class="mk-tip" hidden></div>';
    if (!days.length) { wrap.innerHTML = tip + '<p class="field-hint">데이터가 없습니다.</p>'; return; }
    const byDate = new Map(days.map(d => [d.date, d]));
    const maxRev = Math.max(0, ...days.map(d => d.revenue));
    const first = parseYmd(days[0].date), last = parseYmd(days[days.length - 1].date);
    const today = ymd(new Date());
    const months = [];
    for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m <= last; m.setMonth(m.getMonth() + 1)) {
      months.push(new Date(m));
    }
    const DOW = ['일', '월', '화', '수', '목', '금', '토'];
    const dowCls = (i) => (i === 0 ? ' mk-cal-sun' : i === 6 ? ' mk-cal-sat' : '');
    const html = months.map(m => {
      const y = m.getFullYear(), mo = m.getMonth();
      const daysInMonth = new Date(y, mo + 1, 0).getDate();
      const lead = new Date(y, mo, 1).getDay();
      let cells = '';
      for (let i = 0; i < lead; i++) cells += '<div class="mk-cal-cell mk-cal-empty"></div>';
      for (let d = 1; d <= daysInMonth; d++) {
        const key = ymd(new Date(y, mo, d));
        const row = byDate.get(key);
        const dow = (lead + d - 1) % 7;
        if (!row) { cells += `<div class="mk-cal-cell mk-cal-out${dowCls(dow)}"><span class="mk-cal-day">${d}</span></div>`; continue; }
        const level = row.revenue <= 0 || maxRev <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((row.revenue / maxRev) * 4))); // 0~4 단계
        const tipText = `${key}\n매출 ${won(row.revenue)}\n승인 ${num(row.approved)}건 · 가입 ${num(row.signups)}명`;
        cells += `<div class="mk-cal-cell mk-hit mk-cal-l${level}${key === today ? ' mk-cal-today' : ''}${dowCls(dow)}" data-tip="${escapeHtml(tipText)}">
          <span class="mk-cal-day">${d}</span>
          <span class="mk-cal-rev">${row.revenue > 0 ? wonShort(row.revenue) : ''}</span>
          ${row.approved > 0 ? `<span class="mk-cal-cnt">${num(row.approved)}건</span>` : ''}
        </div>`;
      }
      const prefix = `${y}-${String(mo + 1).padStart(2, '0')}-`;
      const monthTotal = days.filter(x => x.date.startsWith(prefix)).reduce((s, x) => s + x.revenue, 0);
      return `<section class="mk-cal-month">
        <div class="mk-cal-month-head"><b>${y}년 ${mo + 1}월</b><span class="mk-cal-month-total">월 매출 ${won(monthTotal)}</span></div>
        <div class="mk-cal-grid">${DOW.map((n, i) => `<div class="mk-cal-dow${dowCls(i)}">${n}</div>`).join('')}${cells}</div>
      </section>`;
    }).join('');
    wrap.innerHTML = tip + `<div class="mk-cal-months">${html}</div>`;
  }

  // 칸 안에 들어갈 짧은 금액: 1,250,000 → "125만", 3,200 → "3.2천", 12,000,000 → "1,200만"
  function wonShort(v) {
    v = Number(v) || 0;
    if (v >= 10000) {
      const man = v / 10000;
      return (man >= 100 ? Math.round(man).toLocaleString('ko-KR') : (Math.round(man * 10) / 10).toLocaleString('ko-KR')) + '만';
    }
    if (v >= 1000) return (Math.round(v / 100) / 10) + '천';
    return v.toLocaleString('ko-KR');
  }

  // ── 6. 전환 전송 상태 ──
  let lastSettings = null;

  function renderConversionBadges() {
    const el = $('mkConversionBadges');
    if (!lastSettings) { el.innerHTML = '<span class="badge badge-off">설정 확인 불가</span>'; return; }
    const s = lastSettings;
    const env = s.envFallback || {};
    const ga4 = (s.ga4MeasurementId && s.ga4ApiSecretSet) ? 'db' : env.ga4 ? 'env' : '';
    const meta = (s.metaPixelId && s.metaCapiAccessTokenSet) ? 'db' : env.meta ? 'env' : '';
    const badge = (name, src) => src
      ? `<span class="badge badge-done">${name} 설정됨${src === 'env' ? ' (환경변수)' : ''}</span>`
      : `<span class="badge badge-off">${name} 미설정</span>`;
    el.innerHTML = badge('GA4', ga4) + badge('Meta', meta);
  }

  // 재전송 응답 {ok, result:{ga4, meta}} — 각 값은 'sent' | 'skipped' | 'failed'
  const SEND_RESULT_LABEL = { sent: '전송됨', skipped: '건너뜀(미설정)', failed: '실패' };
  const fmtSendResult = (v) => SEND_RESULT_LABEL[v] || String(v ?? '-');

  async function loadConversions() {
    const tbody = $('mkConversionTable');
    try {
      const data = await apiFetch('/admin/api/marketing/conversions?limit=30');
      const rows = Array.isArray(data) ? data : (data.rows || []);
      tbody.innerHTML = rows.length ? rows.map(r => `
        <tr>
          <td>${escapeHtml(r.orderNumber)}</td>
          <td>${escapeHtml(r.memberName || '-')}</td>
          <td class="mk-num">${won(r.amount)}</td>
          <td>${dateTime(r.approvedAt)}</td>
          <td>${r.conversionSentAt ? dateTime(r.conversionSentAt) : '<span class="badge badge-off">미전송</span>'}</td>
          <td>${r.hasGaClientId ? '<span class="badge badge-on">있음</span>' : '<span class="badge badge-off">없음</span>'}</td>
          <td>${r.hasFbp ? '<span class="badge badge-on">있음</span>' : '<span class="badge badge-off">없음</span>'}</td>
          <td><button class="row-btn" type="button" data-mk-journey="${escapeHtml(String(r.paymentId))}">여정</button>
              <button class="row-btn" type="button" data-mk-resend="${escapeHtml(String(r.paymentId))}">재전송</button>
              <div class="mk-resend-result" data-mk-result="${escapeHtml(String(r.paymentId))}"></div></td>
        </tr>`).join('') : emptyRow(8, '최근 승인 결제가 없습니다.');
      setStatus($('mkConversionStatus'), '');
    } catch (err) {
      tbody.innerHTML = emptyRow(8, '불러오지 못했습니다.');
      setStatus($('mkConversionStatus'), `전환 전송 상태를 불러오지 못했습니다: ${err.message}`, 'error');
    }
  }

  $('mkConversionTable').addEventListener('click', async (e) => {
    const journeyBtn = e.target.closest('[data-mk-journey]');
    if (journeyBtn) { Journey.openPayment(journeyBtn.dataset.mkJourney); return; }
    const btn = e.target.closest('[data-mk-resend]');
    if (!btn) return;
    const id = btn.dataset.mkResend;
    if (!confirm('이 결제의 구매 전환을 GA4/Meta로 다시 전송할까요?\n이미 전송된 건이면 광고 플랫폼에 중복 집계될 수 있습니다.')) return;
    const out = section.querySelector(`[data-mk-result="${CSS.escape(id)}"]`);
    btn.disabled = true;
    if (out) { out.className = 'mk-resend-result'; out.textContent = '전송 중...'; }
    try {
      const res = await apiFetch(`/admin/api/marketing/conversions/${encodeURIComponent(id)}/resend`, { method: 'POST', body: '{}' });
      const r = res.result || {};
      // 한 곳이라도 전송됐으면 전송시각 열을 갱신하려고 표를 다시 그린 뒤, 새 행에 결과를 붙인다.
      if (r.ga4 === 'sent' || r.meta === 'sent') await loadConversions();
      const target = section.querySelector(`[data-mk-result="${CSS.escape(id)}"]`);
      if (target) {
        target.className = `mk-resend-result ${r.ga4 === 'failed' || r.meta === 'failed' ? 'error' : 'ok'}`;
        target.textContent = `GA4: ${fmtSendResult(r.ga4)} · Meta: ${fmtSendResult(r.meta)}`;
      }
    } catch (err) {
      // 400(설정 없음)·409(다른 요청이 전송 중) 등은 서버 메시지를 그대로 보여준다.
      if (out) { out.classList.add('error'); out.textContent = err.message; }
    } finally {
      btn.disabled = false;
    }
  });

  // ── 7. 분석 도구 설정 ──
  const TEXT_FIELDS = [
    ['mkGtmId', 'gtmContainerId'],
    ['mkGa4Id', 'ga4MeasurementId'],
    ['mkGa4PropertyId', 'ga4PropertyId'],
    ['mkMetaPixelId', 'metaPixelId'],
    ['mkNaverId', 'naverWcsId'],
    ['mkClarityId', 'clarityProjectId']
  ];
  // 서비스 계정 JSON은 GET 응답 모양이 다르다: ga4ServiceAccountJson('••••' | ''), ga4ServiceAccountEmail.
  // → isSet/badgeHtml/placeholder를 필드별로 덮어쓴다. PUT 규칙(''=유지, null=삭제)은 같다.
  const SECRET_FIELDS = [
    { input: 'mkGa4Secret', clear: 'mkGa4SecretClear', badge: 'mkGa4SecretBadge', key: 'ga4ApiSecret', masked: 'ga4ApiSecretMasked', set: 'ga4ApiSecretSet' },
    { input: 'mkMetaToken', clear: 'mkMetaTokenClear', badge: 'mkMetaTokenBadge', key: 'metaCapiAccessToken', masked: 'metaCapiAccessTokenMasked', set: 'metaCapiAccessTokenSet' },
    {
      input: 'mkGa4SaJson', clear: 'mkGa4SaClear', badge: 'mkGa4SaBadge', key: 'ga4ServiceAccountJson',
      isSet: (s) => !!s.ga4ServiceAccountJson,
      placeholder: (s, isSet) => (isSet ? '저장됨 — 교체하려면 새 JSON 전체를 붙여넣으세요' : '{"type": "service_account", ...}'),
      badgeHtml: (s, isSet) => (isSet
        ? `<span class="badge badge-done mk-ga4-sa">연결된 계정: ${escapeHtml(s.ga4ServiceAccountEmail || '(이메일 확인 불가)')}</span>`
        : ((s.envFallback || {}).ga4Data
          ? '<span class="badge badge-done">환경변수(.env) 설정 사용 중</span>'
          : '<span class="badge badge-off">미설정</span>'))
    }
  ];

  function applySettings(s) {
    TEXT_FIELDS.forEach(([id, key]) => { $(id).value = s[key] || ''; });
    SECRET_FIELDS.forEach(f => {
      const isSet = f.isSet ? f.isSet(s) : !!s[f.set];
      $(f.input).value = '';
      $(f.input).placeholder = f.placeholder ? f.placeholder(s, isSet) : (isSet ? (s[f.masked] || '••••') : '미설정');
      $(f.clear).checked = false;
      $(f.clear).closest('label').style.display = isSet ? '' : 'none';
      $(f.badge).innerHTML = f.badgeHtml
        ? f.badgeHtml(s, isSet)
        : (isSet ? '<span class="badge badge-done">설정됨</span>' : '<span class="badge badge-off">미설정</span>');
    });
    const env = s.envFallback || {};
    const envNames = [env.ga4 && 'GA4', env.meta && 'Meta'].filter(Boolean);
    const notes = [];
    if (envNames.length) notes.push(`서버 환경변수에 ${envNames.join('·')} 전환 설정이 있습니다. 여기 값이 비어 있으면 환경변수 값이 대신 쓰입니다.`);
    if (env.ga4Data) notes.push('서버 환경변수에 GA4 Data API(속성 ID·서비스 계정) 설정이 있습니다. 여기 값이 비어 있으면 환경변수 값으로 조회합니다.');
    $('mkEnvFallbackNote').textContent = notes.join(' ');
  }

  async function loadSettings() {
    try {
      lastSettings = await apiFetch('/admin/api/marketing/settings');
      applySettings(lastSettings);
      setStatus($('mkSettingsStatus'), '');
    } catch (err) {
      lastSettings = null;
      setStatus($('mkSettingsStatus'), `설정을 불러오지 못했습니다: ${err.message}`, 'error');
    }
    renderConversionBadges();
  }

  SECRET_FIELDS.forEach(f => {
    $(f.clear).addEventListener('change', () => {
      $(f.input).disabled = $(f.clear).checked;
      if ($(f.clear).checked) $(f.input).value = '';
    });
  });

  $('mkSettingsSave').addEventListener('click', async () => {
    const status = $('mkSettingsStatus');
    const payload = {};
    TEXT_FIELDS.forEach(([id, key]) => { payload[key] = $(id).value.trim(); });
    SECRET_FIELDS.forEach(f => {
      payload[f.key] = $(f.clear).checked ? null : $(f.input).value.trim(); // '' = 기존 값 유지
    });
    // GA4 Data API 설정이 바뀌면 방문 통계 카드를 새 설정으로 다시 불러온다(서버가 저장 시 캐시를 비움).
    const prevPropertyId = (lastSettings && lastSettings.ga4PropertyId) || '';
    const ga4Changed = payload.ga4PropertyId !== prevPropertyId || payload.ga4ServiceAccountJson !== '';
    const btn = $('mkSettingsSave');
    btn.disabled = true;
    try {
      await apiFetch('/admin/api/marketing/settings', { method: 'PUT', body: JSON.stringify(payload) });
      SECRET_FIELDS.forEach(f => { $(f.input).disabled = false; });
      await loadSettings();
      setStatus(status, '저장되었습니다. 사이트에는 최대 약 6분(서버 캐시 1분 + 브라우저 캐시 5분) 뒤 반영됩니다.', 'ok');
      if (ga4Changed && loaded) { realtimeLoadedOnce = false; loadGa4($('mkFrom').value, $('mkTo').value); }
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 연결 테스트: 저장된 설정으로 최근 7일 세션을 조회한다(입력칸의 미저장 값은 쓰지 않음).
  $('mkGa4Test').addEventListener('click', async () => {
    const status = $('mkSettingsStatus');
    const btn = $('mkGa4Test');
    btn.disabled = true;
    setStatus(status, 'GA4 연결 테스트 중... (저장된 설정 기준)');
    try {
      const res = await fetchJson('/admin/api/marketing/ga4/test', { method: 'POST', body: '{}' });
      const d = res.data;
      if (res.ok && d.ok) {
        setStatus(status, `연결 성공 — 최근 7일 세션 ${num(d.sessions7d)}`, 'ok');
        if (ga4State !== 'ok') { realtimeLoadedOnce = false; loadGa4($('mkFrom').value, $('mkTo').value); }
      } else {
        const msg = d.error || `요청에 실패했습니다 (HTTP ${res.status}).`;
        setStatus(status, `연결 실패 — ${msg}${d.hint ? ` (${d.hint})` : ''}`, 'error');
      }
    } catch (err) {
      setStatus(status, `연결 실패 — ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ── 최초 노출 시 1회 로드 ──
  let loaded = false;
  function loadAll() {
    if (loaded) return;
    loaded = true;
    setRangeDays(30);
    loadSummary(); // GA4 방문 통계(loadGa4)도 여기서 같은 기간으로 호출된다
    loadSettings();
    loadConversions();
    loadLinks();
    loadLinkCourses(); // 특정 강의 상세용 목록. 실패해도 다른 기능은 동작(강의 선택칸만 안내)
  }
  function onVisibilityChange() {
    if (section.classList.contains('active')) loadAll();
    syncRealtimeTimer(); // 섹션이 보일 때만 현재 접속자 60초 폴링
  }
  onVisibilityChange();
  new MutationObserver(onVisibilityChange).observe(section, { attributes: true, attributeFilter: ['class'] });
})();
