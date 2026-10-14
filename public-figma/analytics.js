/*
 * 독편사 DOCK PASS — 웹 분석 공용 스크립트 (모든 HTML <head>의 <meta charset> 바로 뒤에서 로드)
 *
 * - 분석 도구 ID는 코드에 두지 않는다. 관리자 페이지 "마케팅 → 분석 도구 설정"에서 저장하면
 *   서버(server.js의 GET /analytics.js)가 아래 `var DT_ANALYTICS_CONFIG = {};` 한 줄을
 *   {gtmId, ga4MeasurementId, naverWcsId, clarityId} 로 치환해서 내려준다(설정이 비면 env 폴백, 그것도 없으면 {}).
 *   ※ 이 줄의 모양(정확히 `var DT_ANALYTICS_CONFIG = {};`)을 바꾸면 치환이 안 된다 — 서버가 기동 시 확인해 에러 로그를 남긴다.
 * - gtmId 가 있으면 GTM 을 로드한다(GA4·Meta 픽셀 등은 GTM 태그로).
 *   gtmId 가 없고 ga4MeasurementId 만 있으면 gtag.js 를 직접 로드하고 dtTrack 이 gtag('event', ...)도 호출한다.
 *   naverWcsId·clarityId 는 GTM 유무와 무관하게 여기서 직접 주입한다(GTM 에도 같은 태그를 넣으면 중복 집계).
 *   아무 값도 없으면 window.dataLayer 초기화와 window.dtTrack() 만 동작(no-op).
 * - 페이지 코드는 퍼널 이벤트를 window.dtTrack(name, params) 로 보낸다
 *   (sign_up / login / view_item / begin_checkout / purchase — GA4 권장 전자상거래 스키마).
 *   호출부는 항상 `typeof window.dtTrack === 'function'` 가드를 둔다. 설정 가이드: docs/analytics-setup.md
 * - GA4 user_id: 로그인·가입 성공 시 페이지 코드가 window.dtSetUserId(회원 숫자 id)를 부르면
 *   dataLayer.push({event:'dt_user', user_id}) 하고 localStorage 'dt_uid'에 기억한다. 다음 페이지부터는 이 스크립트가
 *   GTM/gtag 로드 전에 같은 push를 먼저 해서 GA4 구성 태그가 첫 page_view부터 user_id를 싣게 한다. 로그아웃 시 dtSetUserId(null).
 * - 유입·세션 경로 수집(아래 두 번째 IIFE): 쿠키 dt_attr {first,last}(90일) + sessionStorage dt_journey(최근 20 페이지·체류초).
 *   window.dtGetAttribution() / window.dtGetJourney() 로 꺼내 /api/payments/init·/api/members/signup 바디에 싣는다.
 */
var DT_ANALYTICS_CONFIG = {};
(function () {
  var cfg = (typeof DT_ANALYTICS_CONFIG === 'object' && DT_ANALYTICS_CONFIG) || {};
  window.DT_ANALYTICS_CONFIG = cfg;
  var gtmId = cfg.gtmId || '';
  var ga4Id = cfg.ga4MeasurementId || '';
  var naverId = cfg.naverWcsId || '';
  var clarityId = cfg.clarityId || '';
  var useGtagDirect = !gtmId && !!ga4Id;

  window.dataLayer = window.dataLayer || [];

  function loadScript(src, onload) {
    var d = document, j = d.createElement('script'), f = d.getElementsByTagName('script')[0];
    j.async = true;
    j.src = src;
    if (onload) j.onload = onload;
    if (f && f.parentNode) f.parentNode.insertBefore(j, f);
    else (d.head || d.documentElement).appendChild(j);
  }

  if (useGtagDirect) {
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  }

  // ── GA4 user_id(회원 숫자 id 문자열) ──
  var storedUid = null;
  try { storedUid = window.localStorage.getItem('dt_uid'); } catch (e) { /* 저장소 차단 */ }
  if (storedUid && !/^\d{1,20}$/.test(storedUid)) storedUid = null;
  if (storedUid) window.dataLayer.push({ event: 'dt_user', user_id: storedUid });

  window.dtSetUserId = function (id) {
    try {
      var uid = id === null || id === undefined || id === '' ? null : String(id);
      if (uid && !/^\d{1,20}$/.test(uid)) return; // 숫자 id만(이메일 등 개인정보가 user_id로 나가지 않게)
      var prev = null;
      try { prev = window.localStorage.getItem('dt_uid'); } catch (e) { /* noop */ }
      try {
        if (uid) window.localStorage.setItem('dt_uid', uid);
        else window.localStorage.removeItem('dt_uid');
      } catch (e) { /* noop */ }
      if (!uid) {
        if (prev) window.dataLayer.push({ event: 'dt_user', user_id: undefined });
        return;
      }
      if (uid === prev && storedUid === uid) return; // 이미 이 페이지 로드 시 push함
      window.dataLayer.push({ event: 'dt_user', user_id: uid });
      if (useGtagDirect && typeof window.gtag === 'function') window.gtag('set', { user_id: uid });
    } catch (e) { /* noop */ }
  };

  // GA4 전자상거래 이벤트는 직전 ecommerce 객체가 다음 이벤트에 병합되지 않도록 먼저 비운다(GTM 권장).
  window.dtTrack = function (name, params) {
    try {
      if (!name) return;
      var p = params || {};
      var hasEcommerce = Object.prototype.hasOwnProperty.call(p, 'items');
      if (hasEcommerce) window.dataLayer.push({ ecommerce: null });
      var evt = { event: name };
      var gtagParams = {};
      for (var k in p) {
        if (Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined) {
          evt[k] = p[k];
          gtagParams[k] = p[k];
        }
      }
      if (hasEcommerce) {
        // GTM GA4 이벤트 태그의 "Send Ecommerce data" 옵션이 읽는 위치에도 같은 값을 둔다.
        var ecommerce = {};
        for (var key in evt) {
          if (key !== 'event' && Object.prototype.hasOwnProperty.call(evt, key)) ecommerce[key] = evt[key];
        }
        evt.ecommerce = ecommerce;
      }
      window.dataLayer.push(evt);
      // GTM 없이 GA4만 쓰는 경우: gtag 이벤트로도 보낸다(전자상거래 파라미터는 최상위 그대로 — GA4 gtag 스키마).
      if (useGtagDirect && typeof window.gtag === 'function') window.gtag('event', name, gtagParams);
    } catch (e) { /* 분석 실패가 페이지 동작을 막지 않게 한다 */ }
  };

  try {
    if (gtmId) {
      // Google Tag Manager 표준 스니펫(<head>용)
      (function (w, d, s, l, i) {
        w[l] = w[l] || [];
        w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
        var f = d.getElementsByTagName(s)[0], j = d.createElement(s), dl = l != 'dataLayer' ? '&l=' + l : '';
        j.async = true;
        j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dl;
        if (f && f.parentNode) f.parentNode.insertBefore(j, f);
        else (d.head || d.documentElement).appendChild(j);
      })(window, document, 'script', 'dataLayer', gtmId);
    } else if (useGtagDirect) {
      // GA4 gtag.js 표준 스니펫
      loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga4Id));
      window.gtag('js', new Date());
      if (storedUid) window.gtag('config', ga4Id, { user_id: storedUid });
      else window.gtag('config', ga4Id);
    }
  } catch (e) { /* noop */ }

  try {
    if (naverId) {
      // 네이버 애널리틱스 공통 스크립트(wcslog.js) — 비동기 로드 후 wcs_do()
      window.wcs_add = window.wcs_add || {};
      window.wcs_add['wa'] = naverId;
      loadScript('https://wcs.pstatic.net/wcslog.js', function () {
        try { if (window.wcs) window.wcs_do(); } catch (e) { /* noop */ }
      });
    }
  } catch (e) { /* noop */ }

  try {
    if (clarityId) {
      // Microsoft Clarity 공식 스니펫
      (function (c, l, a, r, i, t, y) {
        c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
        y = l.getElementsByTagName(r)[0];
        if (y && y.parentNode) y.parentNode.insertBefore(t, y);
        else (l.head || l.documentElement).appendChild(t);
      })(window, document, 'clarity', 'script', clarityId);
    }
  } catch (e) { /* noop */ }
})();

// ── 유입(dt_attr 쿠키)·세션 경로(dt_journey) 수집 — 데이터 계약은 docs/analytics-setup.md "유입·여정 수집" ──
// dt_attr: JSON {first, last} (encodeURIComponent, 90일, SameSite=Lax, https면 Secure, path=/)
//   first = 쿠키가 없던 첫 방문, last = 이후 광고/UTM 파라미터나 외부 referrer를 달고 들어온 가장 최근 방문.
//   각 터치: {ts, landing(200), referrer(300), utm_*/gclid/n_*(각 100, 없으면 키 생략)}
// dt_journey(sessionStorage): [{path, q, t(진입 epoch ms), d(보이는 동안 머문 초, 누적)}] 최근 20개
(function () {
  var ATTR_COOKIE = 'dt_attr';
  var ATTR_MAX_AGE = 90 * 24 * 60 * 60;
  var ATTR_MAX_COOKIE_LEN = 3072;
  var ATTR_PARAM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'gclid', 'n_query', 'n_keyword', 'n_ad_group', 'n_media', 'n_rank'];
  var JOURNEY_KEY = 'dt_journey';
  var JOURNEY_MAX = 20;
  // 경로 분석에 필요한 식별 파라미터만 남긴다(결제 결과·금액 등은 제외).
  var JOURNEY_Q_KEYS = ['id', 'courseId', 'lecture', 'orderNumber', 'page', 'post'];
  // 결제창(PG·카드사 인증)에서 돌아올 때의 referrer는 유입이 아니다.
  var IGNORE_REFERRER_RE = /(^|\.)(testpayup|payup|inicis|kcp|nicepay|danal|kakaopay|tosspayments|payco|kgmobilians|mobilians|settlebank|ksnet|kicc|easypay)\./i;
  var IGNORE_LANDING_RE = /^\/(paymentComplete|payupReturn)\.html/i;

  function safeDecode(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); }
  }

  function parseQuery(search) {
    var out = {};
    var qs = String(search || '').replace(/^\?/, '');
    if (!qs) return out;
    var parts = qs.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var idx = parts[i].indexOf('=');
      var k = safeDecode(idx < 0 ? parts[i] : parts[i].slice(0, idx));
      var v = idx < 0 ? '' : safeDecode(parts[i].slice(idx + 1));
      if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    }
    return out;
  }

  function bareHost(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }

  function referrerHost(ref) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#:]+)/i.exec(String(ref || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function isExternalReferrer(ref) {
    var host = referrerHost(ref);
    if (!host) return false;
    if (bareHost(host) === bareHost(location.hostname)) return false;
    if (IGNORE_REFERRER_RE.test(host + '.')) return false;
    return true;
  }

  function readAttr() {
    try {
      var all = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < all.length; i++) {
        var c = all[i].replace(/^\s+/, '');
        if (c.indexOf(ATTR_COOKIE + '=') !== 0) continue;
        var obj = JSON.parse(decodeURIComponent(c.slice(ATTR_COOKIE.length + 1)));
        if (!obj || typeof obj !== 'object' || !obj.first || typeof obj.first !== 'object') return null;
        return { first: obj.first, last: obj.last && typeof obj.last === 'object' ? obj.last : null };
      }
    } catch (e) { /* 깨진 쿠키는 없는 것으로 */ }
    return null;
  }

  function encodeAttr(attr) {
    var o = { first: attr.first };
    if (attr.last) o.last = attr.last;
    return encodeURIComponent(JSON.stringify(o));
  }

  function shortenParams(t, max) {
    for (var i = 0; i < ATTR_PARAM_KEYS.length; i++) {
      var k = ATTR_PARAM_KEYS[i];
      if (t && typeof t[k] === 'string') t[k] = t[k].slice(0, max);
    }
  }

  // 3KB를 넘으면 referrer부터(last → first 순) 줄이고, 그래도 넘으면 landing → 파라미터 값(30자) 순으로 줄이며,
  // 최후에는 last를 버린다(한글 파라미터는 인코딩 후 9배로 늘어나므로 극단적인 경우 대비).
  function fitAttr(attr) {
    var steps = [
      function () { if (attr.last && attr.last.referrer) attr.last.referrer = attr.last.referrer.slice(0, 100); },
      function () { if (attr.first.referrer) attr.first.referrer = attr.first.referrer.slice(0, 100); },
      function () { if (attr.last) delete attr.last.referrer; },
      function () { delete attr.first.referrer; },
      function () { if (attr.last && attr.last.landing) attr.last.landing = attr.last.landing.slice(0, 60); },
      function () { if (attr.first.landing) attr.first.landing = attr.first.landing.slice(0, 60); },
      function () { shortenParams(attr.first, 30); },
      function () { if (attr.last) shortenParams(attr.last, 30); },
      function () { attr.last = null; }
    ];
    var val = encodeAttr(attr);
    for (var i = 0; i < steps.length && val.length > ATTR_MAX_COOKIE_LEN; i++) {
      steps[i]();
      val = encodeAttr(attr);
    }
    return val.length > ATTR_MAX_COOKIE_LEN ? null : val;
  }

  function writeAttr(attr) {
    var val = fitAttr(attr);
    if (!val) return;
    var cookie = ATTR_COOKIE + '=' + val + '; Max-Age=' + ATTR_MAX_AGE + '; Path=/; SameSite=Lax';
    if (location.protocol === 'https:') cookie += '; Secure';
    document.cookie = cookie;
  }

  function hasValue(v) { return v !== undefined && v !== null && String(v).replace(/\s+/g, '') !== ''; }

  function buildTouch(params, ref) {
    var t = {
      ts: new Date().toISOString(),
      landing: String(location.pathname + location.search).slice(0, 200),
      referrer: String(ref || '').slice(0, 300)
    };
    for (var i = 0; i < ATTR_PARAM_KEYS.length; i++) {
      var k = ATTR_PARAM_KEYS[i];
      if (hasValue(params[k])) t[k] = String(params[k]).slice(0, 100);
    }
    return t;
  }

  function hasCampaignParams(params) {
    for (var i = 0; i < ATTR_PARAM_KEYS.length; i++) {
      if (hasValue(params[ATTR_PARAM_KEYS[i]])) return true;
    }
    return false;
  }

  try {
    var params = parseQuery(location.search);
    var ref = document.referrer || '';
    var attr = readAttr();
    if (!attr) {
      writeAttr({ first: buildTouch(params, ref), last: null });
    } else if (!IGNORE_LANDING_RE.test(location.pathname) && (hasCampaignParams(params) || isExternalReferrer(ref))) {
      attr.last = buildTouch(params, ref);
      writeAttr(attr);
    }
  } catch (e) { /* 쿠키 차단 등 — 분석 실패가 페이지를 막지 않게 */ }

  window.dtGetAttribution = function () {
    var a = readAttr();
    return a ? { first: a.first, last: a.last || null } : null;
  };

  // ── 세션 경로 ──
  function readJourney() {
    try {
      var arr = JSON.parse(window.sessionStorage.getItem(JOURNEY_KEY) || '[]');
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) { return []; }
  }

  function writeJourney(arr) {
    try { window.sessionStorage.setItem(JOURNEY_KEY, JSON.stringify(arr.slice(-JOURNEY_MAX))); } catch (e) { /* noop */ }
  }

  function buildQ() {
    var params = parseQuery(location.search);
    var parts = [];
    for (var i = 0; i < JOURNEY_Q_KEYS.length; i++) {
      var k = JOURNEY_Q_KEYS[i];
      if (hasValue(params[k])) parts.push(k + '=' + encodeURIComponent(params[k]));
    }
    return parts.join('&').slice(0, 80);
  }

  var currentT = null;      // 이 페이지 항목의 t(식별자)
  var visibleMs = 0;        // 지금까지 보인 시간 누적
  var visibleSince = null;  // 현재 보이는 구간 시작 시각

  function isHidden() { return document.visibilityState === 'hidden'; }

  function enterPage() {
    var arr = readJourney();
    var now = Date.now();
    // 직전 항목과 같은 ms 진입이면(드묾) 1ms 밀어 식별자 충돌을 피한다.
    var lastItem = arr.length ? arr[arr.length - 1] : null;
    if (lastItem && typeof lastItem.t === 'number' && lastItem.t >= now) now = lastItem.t + 1;
    var entry = { path: String(location.pathname || '/').slice(0, 200), t: now, d: 0 };
    var q = buildQ();
    if (q) entry.q = q;
    arr.push(entry);
    writeJourney(arr);
    currentT = now;
    visibleMs = 0;
    visibleSince = isHidden() ? null : Date.now();
  }

  function currentSeconds() {
    var ms = visibleMs + (visibleSince !== null ? Date.now() - visibleSince : 0);
    return Math.max(0, Math.round(ms / 1000));
  }

  function saveDuration() {
    if (currentT === null) return;
    var arr = readJourney();
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].t === currentT) { arr[i].d = currentSeconds(); writeJourney(arr); return; }
    }
  }

  function pauseTimer() {
    if (visibleSince !== null) { visibleMs += Date.now() - visibleSince; visibleSince = null; }
    saveDuration();
  }

  try {
    enterPage();
    document.addEventListener('visibilitychange', function () {
      if (isHidden()) pauseTimer();
      else if (visibleSince === null) visibleSince = Date.now();
    });
    window.addEventListener('pagehide', pauseTimer);
    // 뒤로가기 캐시(bfcache)로 돌아온 경우는 새 진입으로 기록
    window.addEventListener('pageshow', function (e) { if (e && e.persisted) enterPage(); });
  } catch (e) { /* noop */ }

  // 현재 페이지의 체류초까지 반영한 배열을 돌려준다(결제·가입 요청 직전에 호출).
  window.dtGetJourney = function () {
    try { saveDuration(); } catch (e) { /* noop */ }
    return readJourney();
  };
})();
