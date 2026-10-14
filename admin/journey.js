// ── 유입·여정 공용 렌더러 ──
// 결제 1건의 "유입 → 페이지 경로 → 결제" 타임라인(모달)과 회원의 "가입 시 유입" 블록을 그린다.
// 사용처: marketing.js(전환 전송 표 "여정"), payments.js(결제 목록 "여정"), members.js(회원 상세).
// API: GET /admin/api/marketing/journey/payment/:id, GET /admin/api/marketing/journey/member/:id (lib/attribution-report.js)
// cms.js의 apiFetch / escapeHtml 을 그대로 쓴다.
const Journey = (() => {
  const TOUCH_FIELDS = [
    ['landing', '랜딩 페이지'],
    ['referrer', '리퍼러'],
    ['utm_source', 'utm_source'],
    ['utm_medium', 'utm_medium'],
    ['utm_campaign', 'utm_campaign'],
    ['utm_content', 'utm_content'],
    ['utm_term', 'utm_term'],
    ['n_query', '네이버 광고 검색어'],
    ['n_keyword', '네이버 광고 키워드'],
    ['n_ad_group', '네이버 광고그룹'],
    ['n_media', '네이버 매체'],
    ['n_rank', '네이버 노출순위']
  ];
  const STATUS_LABEL = { pending: '대기중', approved: '승인', failed: '실패', canceled: '취소됨', expired: '만료' };

  function fmtTime(v) {
    if (v === null || v === undefined || v === '') return '-';
    const d = new Date(typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('ko-KR');
  }
  function fmtDwell(sec) {
    if (sec === null || sec === undefined) return '체류 -';
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
  }

  function touchHtml(title, t) {
    if (!t) return '';
    const rows = TOUCH_FIELDS.filter(([k]) => t[k]).map(([k, label]) =>
      `<tr><th>${label}</th><td>${escapeHtml(t[k])}</td></tr>`);
    if (t.gclid) rows.push('<tr><th>gclid</th><td>있음 (구글 광고 클릭)</td></tr>');
    if (!t.referrer) rows.splice(1, 0, '<tr><th>리퍼러</th><td class="field-hint">없음 (직접 방문·앱·북마크)</td></tr>');
    return `
      <div class="jr-touch">
        <div class="jr-touch-head"><b>${title}</b><span class="field-hint">${escapeHtml(fmtTime(t.ts))}</span></div>
        <table class="jr-kv"><tbody>${rows.join('')}</tbody></table>
      </div>`;
  }

  function attributionHtml(attr, channel) {
    if (!attr) return '<p class="field-hint">유입 정보 없음</p>';
    const same = attr.first && attr.last && JSON.stringify(attr.first) === JSON.stringify(attr.last);
    return `
      ${channel ? `<div class="jr-channel">채널 <code>${escapeHtml(channel)}</code></div>` : ''}
      <div class="jr-touch-grid">
        ${touchHtml('첫 유입 (first)', attr.first)}
        ${same ? '' : touchHtml('마지막 광고·캠페인 유입 (last)', attr.last)}
      </div>`;
  }

  function journeyHtml(journey) {
    if (!journey || !journey.length) return '<p class="field-hint">페이지 경로 없음</p>';
    // t(진입 시각)가 있으면 시간순 정렬, 없으면 저장 순서 유지(stable sort)
    const list = journey.map((e, i) => ({ ...e, i }))
      .sort((a, b) => (a.t && b.t ? a.t - b.t : 0) || a.i - b.i);
    return `<ol class="jr-steps">${list.map(e => `
      <li>
        <span class="jr-time">${e.t ? escapeHtml(new Date(e.t).toLocaleTimeString('ko-KR')) : ''}</span>
        <span class="jr-path"><code>${escapeHtml(e.path)}</code>${e.q ? ` <span class="field-hint">?${escapeHtml(e.q)}</span>` : ''}</span>
        <span class="jr-dwell">${escapeHtml(fmtDwell(e.d))}</span>
      </li>`).join('')}</ol>`;
  }

  // ── 결제 여정 모달 ──
  const overlay = () => document.getElementById('journeyModalOverlay');
  let seq = 0;

  async function openPayment(paymentId) {
    const body = document.getElementById('journeyModalBody');
    const title = document.getElementById('journeyModalTitle');
    title.textContent = '결제 여정';
    body.innerHTML = '<p class="field-hint">불러오는 중...</p>';
    overlay().classList.add('open');
    const mySeq = ++seq;
    try {
      const d = await apiFetch(`/admin/api/marketing/journey/payment/${encodeURIComponent(paymentId)}`);
      if (mySeq !== seq) return;
      title.textContent = `결제 여정 — ${d.order_number || `#${d.paymentId}`}`;
      const member = d.member ? `${escapeHtml(d.member.name || '-')} <span class="field-hint">(${escapeHtml(d.member.username || '')})</span>` : '-';
      const payStep = `
        <div class="jr-pay">
          <div><b>${escapeHtml(d.item_name || '-')}</b> · ${Number(d.amount || 0).toLocaleString('ko-KR')}원
            <span class="badge ${d.status === 'approved' ? 'badge-done' : 'badge-off'}">${escapeHtml(STATUS_LABEL[d.status] || d.status || '-')}</span></div>
          <div class="field-hint">회원 ${member} · 결제 시작 ${escapeHtml(fmtTime(d.created_at))} · 승인 ${escapeHtml(fmtTime(d.approved_at))}</div>
        </div>`;
      if (!d.collected) {
        body.innerHTML = `
          <p class="mk-warn">수집 전 결제 — 유입·페이지 경로 수집 기능이 적용되기 전에 생성된 결제라 여정 정보가 없습니다.</p>
          <div class="jr-flow"><section><h3 class="mk-h3">3. 결제</h3>${payStep}</section></div>`;
        return;
      }
      body.innerHTML = `
        <div class="jr-flow">
          <section><h3 class="mk-h3">1. 유입</h3>${attributionHtml(d.attribution, d.channel)}</section>
          <section><h3 class="mk-h3">2. 페이지 경로 <span class="field-hint">(결제 직전 세션, 최근 20개)</span></h3>${journeyHtml(d.journey)}</section>
          <section><h3 class="mk-h3">3. 결제</h3>${payStep}</section>
        </div>`;
    } catch (err) {
      if (mySeq !== seq) return;
      body.innerHTML = `<p class="mk-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function close() { overlay().classList.remove('open'); seq++; }

  document.getElementById('journeyModalCloseBtn').addEventListener('click', close);
  overlay().addEventListener('click', (e) => { if (e.target === overlay()) close(); });

  // ── 회원 상세 "가입 시 유입" ──
  async function renderMemberSignup(el, memberId) {
    if (!el) return;
    el.dataset.memberId = String(memberId); // 빠르게 다른 회원을 열면 늦게 온 응답은 버린다
    el.innerHTML = '<p class="field-hint">불러오는 중...</p>';
    try {
      const d = await apiFetch(`/admin/api/marketing/journey/member/${encodeURIComponent(memberId)}`);
      if (el.dataset.memberId !== String(memberId)) return;
      if (!d.collected) {
        el.innerHTML = `<p class="field-hint">수집 전 가입 — 유입 추적 기능 적용 전에 가입했거나 수집된 정보가 없습니다. 가입폼의 가입 경로·검색 키워드는 위 표를 참고하세요.</p>`;
        return;
      }
      el.innerHTML = `
        ${attributionHtml(d.attribution, d.channel)}
        <details class="mk-details" style="margin-top:10px;">
          <summary>가입 직전 페이지 경로 (${(d.journey || []).length}개)</summary>
          ${journeyHtml(d.journey)}
        </details>`;
    } catch (err) {
      if (el.dataset.memberId !== String(memberId)) return;
      el.innerHTML = `<p class="field-hint">가입 시 유입 정보를 불러오지 못했습니다: ${escapeHtml(err.message)}</p>`;
    }
  }

  return { openPayment, renderMemberSignup, close };
})();
