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
    ['mkCourseTable', 3], ['mkCouponTable', 4], ['mkFunnelTable', 2], ['mkDailyTable', 4]
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
  const CHANNEL_KIND_HINT = { form: '가입폼 입력(유입 추적 전)', none: '유입 정보 없음', tracked: '유입 추적' };
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
      ATTR_TARGETS.forEach(([id, cols]) => { $(id).innerHTML = emptyRow(cols, '불러오지 못했습니다.'); });
    }
  }

  function renderAttribution(data) {
    const t = data.totals || {};
    const cov = (part, whole) => (Number(whole) > 0 ? `${num(part)}/${num(whole)} (${pct(part, whole)})` : '0');
    $('mkAttrCoverage').innerHTML = `
      <span>가입 중 유입 추적됨 <b>${escapeHtml(cov(t.signupsTracked, t.signups))}</b></span>
      <span>결제 중 유입 추적됨 <b>${escapeHtml(cov(t.paymentsTracked, t.payments))}</b></span>
      <span>결제 중 페이지 경로 있음 <b>${escapeHtml(cov(t.paymentsWithJourney, t.payments))}</b></span>
      ${data.signupContextAvailable === false ? '<span class="mk-attr-warn">회원 가입 유입 컬럼(signup_context) 미적용 — 가입은 가입폼 값으로만 집계</span>' : ''}`;

    const metricCells = (r) => `
        <td class="mk-num">${num(r.signups)}</td>
        <td class="mk-num">${num(r.buyers)}</td>
        <td class="mk-num">${num(r.payments)}</td>
        <td class="mk-num">${won(r.revenue)}</td>
        <td class="mk-num">${rate(r.conversionRate)}</td>`;

    const channels = data.channels || [];
    $('mkAttrChannelTable').innerHTML = channels.length ? channels.map(r => `
      <tr class="${r.kind === 'tracked' ? '' : 'mk-row-muted'}">
        <td title="${escapeHtml(CHANNEL_KIND_HINT[r.kind] || '')}"><code>${escapeHtml(r.channel)}</code></td>${metricCells(r)}
      </tr>`).join('') : emptyRow(6, '기간 내 가입·결제가 없습니다.');

    const keywords = data.keywords || [];
    $('mkAttrKeywordTable').innerHTML = keywords.length ? keywords.map(r => `
      <tr>
        <td>${escapeHtml(r.keyword)} <span class="field-hint">${escapeHtml((r.sources || []).join('·'))}</span></td>${metricCells(r)}
      </tr>`).join('') : emptyRow(6, '키워드가 수집된 가입·결제가 없습니다.');

    const landings = data.landings || [];
    $('mkAttrLandingTable').innerHTML = landings.length ? landings.map(r => `
      <tr><td><code>${escapeHtml(r.landing)}</code></td>${metricCells(r)}</tr>`).join('')
      : emptyRow(6, '랜딩 페이지가 수집된 가입·결제가 없습니다.');

    const pages = data.prePurchasePages || [];
    $('mkAttrPrePurchaseTable').innerHTML = pages.length ? pages.map(r => `
      <tr>
        <td><code>${escapeHtml(r.path)}</code></td>
        <td class="mk-num">${num(r.count)}</td>
        <td class="mk-num">${num(r.lastPageCount)}</td>
        <td class="mk-num" title="체류초 표본 ${num(r.dwellSamples)}건">${dwell(r.avgDwellSec)}</td>
      </tr>`).join('') : emptyRow(4, '페이지 경로가 수집된 승인 결제가 없습니다.');
  }

  // CSV: 세션 쿠키로 인증되는 GET이라 링크 이동만으로 내려받는다(UTF-8 BOM, 엑셀 호환).
  $('mkAttributionCard').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mk-csv]');
    if (!btn) return;
    const a = document.createElement('a');
    a.href = `/admin/api/marketing/attribution.csv?${attrParams({ table: btn.dataset.mkCsv })}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

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
    return `<a href="${escapeHtml(GA4_SITE + path)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(path)}</code></a>`;
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
  // "표로 보기" 테이블을 함께 제공(relief rule). 텍스트는 시리즈 색이 아니라 텍스트 토큰.
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
      hits += `<rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" class="mk-hit"><title>${escapeHtml(tip)}</title></rect>`;
    });

    const legend = keys.length > 1
      ? `<div class="mk-legend">${keys.map(k => `<span><i style="background:${SERIES[k].color}"></i>${SERIES[k].label}</span>`).join('')}</div>`
      : '';
    const total = keys.map(k => `${SERIES[k].label} 합계 ${unitFmt(days.reduce((s, d) => s + d[k], 0))}`).join(' · ');
    return `
      <div class="mk-chart-head"><h3 class="mk-h3">${escapeHtml(title)}</h3>${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="mk-svg" role="img" aria-label="${escapeHtml(`${title} — ${total}`)}">
        ${grid}${bars}${xLabels}${hits}
      </svg>
      <div class="field-hint">${escapeHtml(total)} · 막대에 마우스를 올리면 날짜별 값이 보입니다.</div>`;
  }

  function renderDaily(days) {
    if (!days.length) {
      $('mkDailyCounts').innerHTML = '<p class="field-hint">표시할 데이터가 없습니다.</p>';
      $('mkDailyRevenue').innerHTML = '';
      $('mkDailyTable').innerHTML = emptyRow(4, '데이터가 없습니다.');
      return;
    }
    $('mkDailyCounts').innerHTML = barChart({ title: '가입 · 승인 (건)', unitFmt: (v) => num(v), keys: ['signups', 'approved'], days });
    $('mkDailyRevenue').innerHTML = barChart({ title: '매출 (원)', unitFmt: won, keys: ['revenue'], days });
    $('mkDailyTable').innerHTML = days.slice().reverse().map(d => `
      <tr><td>${d.date}</td><td class="mk-num">${num(d.signups)}</td><td class="mk-num">${num(d.approved)}</td><td class="mk-num">${won(d.revenue)}</td></tr>`).join('');
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
  }
  function onVisibilityChange() {
    if (section.classList.contains('active')) loadAll();
    syncRealtimeTimer(); // 섹션이 보일 때만 현재 접속자 60초 폴링
  }
  onVisibilityChange();
  new MutationObserver(onVisibilityChange).observe(section, { attributes: true, attributeFilter: ['class'] });
})();
