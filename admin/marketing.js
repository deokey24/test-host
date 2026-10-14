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
    ['mkMetaPixelId', 'metaPixelId'],
    ['mkNaverId', 'naverWcsId'],
    ['mkClarityId', 'clarityProjectId']
  ];
  const SECRET_FIELDS = [
    { input: 'mkGa4Secret', clear: 'mkGa4SecretClear', badge: 'mkGa4SecretBadge', key: 'ga4ApiSecret', masked: 'ga4ApiSecretMasked', set: 'ga4ApiSecretSet' },
    { input: 'mkMetaToken', clear: 'mkMetaTokenClear', badge: 'mkMetaTokenBadge', key: 'metaCapiAccessToken', masked: 'metaCapiAccessTokenMasked', set: 'metaCapiAccessTokenSet' }
  ];

  function applySettings(s) {
    TEXT_FIELDS.forEach(([id, key]) => { $(id).value = s[key] || ''; });
    SECRET_FIELDS.forEach(f => {
      const isSet = !!s[f.set];
      $(f.input).value = '';
      $(f.input).placeholder = isSet ? (s[f.masked] || '••••') : '미설정';
      $(f.clear).checked = false;
      $(f.clear).closest('label').style.display = isSet ? '' : 'none';
      $(f.badge).innerHTML = isSet ? '<span class="badge badge-done">설정됨</span>' : '<span class="badge badge-off">미설정</span>';
    });
    const env = s.envFallback || {};
    const envNames = [env.ga4 && 'GA4', env.meta && 'Meta'].filter(Boolean);
    $('mkEnvFallbackNote').textContent = envNames.length
      ? `서버 환경변수에 ${envNames.join('·')} 전환 설정이 있습니다. 여기 값이 비어 있으면 환경변수 값이 대신 쓰입니다.`
      : '';
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
    const btn = $('mkSettingsSave');
    btn.disabled = true;
    try {
      await apiFetch('/admin/api/marketing/settings', { method: 'PUT', body: JSON.stringify(payload) });
      SECRET_FIELDS.forEach(f => { $(f.input).disabled = false; });
      await loadSettings();
      setStatus(status, '저장되었습니다. 사이트에는 최대 약 6분(서버 캐시 1분 + 브라우저 캐시 5분) 뒤 반영됩니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
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
    loadSummary();
    loadSettings();
    loadConversions();
  }
  if (section.classList.contains('active')) loadAll();
  new MutationObserver(() => {
    if (section.classList.contains('active')) loadAll();
  }).observe(section, { attributes: true, attributeFilter: ['class'] });
})();
