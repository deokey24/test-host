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
      window.gtag('config', ga4Id);
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
