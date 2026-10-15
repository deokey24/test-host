// 관리자 "유입·전환 분석" — 결제/가입에 붙어 저장된 퍼스트파티 어트리뷰션·페이지 경로를 집계한다.
// 계획: docs/plans/attribution-and-journey.md 2-C.
//
// 데이터 원천
//   payments.client_context (TEXT JSON): {..., attribution:{first,last}, journey:[{path,q,t,d}]}
//   members.signup_context  (TEXT JSON, NULL 허용): {attribution:{first,last}, journey:[...], ua}
//   members.signup_channel / search_keyword (가입폼 입력, 수집 전 데이터의 폴백)
//
// MySQL/MariaDB JSON 함수에 의존하지 않고 Node에서 파싱한다(행 수가 월 수백 건 수준, 깨진 JSON은 무시).
// 집계는 순수 함수 aggregateAttribution()으로 분리해 DB 없이 단위 테스트할 수 있다.
//
// 마운트(server.js, 세션 미들웨어 이후 아무 곳):
//   require('./lib/attribution-report')(app, { getPool, requireAdmin: requireAdminApi });

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const DEFAULT_WITHDRAWN_GROUP = 'withdrawn';
const PRE_PURCHASE_TAIL = 3;
const TOP_KEYWORDS = 50;
const TOP_LANDINGS = 50;
const TOP_PRE_PURCHASE = 20;

// join.html 가입경로 체크박스 값 — 단일 출처. server.js(/admin/api/marketing/summary)도 여기서 require 한다.
const KNOWN_SIGNUP_CHANNELS = [
  '학원 재원생', '지인 등 소개', '독편사 카페', '제휴 거래처', '인터넷 검색', '언론 기사', '광고 홍보물',
  '인스타그램', '유튜브', '네이버 블로그', '카카오톡 채널', '기타'
];

// 가입경로는 체크박스 복수선택을 ', '로 이어 저장한다. 구 데이터 일부는 구분자 없이 붙어 있어
// ('학원 재원생독편사 카페') 알려진 경로명으로 다시 쪼갠다. 끝까지 못 쪼개면 원문 그대로 한 경로로 센다.
function splitSignupChannels(raw) {
  const out = new Set();
  for (const piece of String(raw || '').split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (KNOWN_SIGNUP_CHANNELS.includes(trimmed)) { out.add(trimmed); continue; }
    let rest = trimmed;
    const tokens = [];
    while (rest) {
      const hit = KNOWN_SIGNUP_CHANNELS.find(c => rest.startsWith(c));
      if (!hit) break;
      tokens.push(hit);
      rest = rest.slice(hit.length).trim();
    }
    if (!rest && tokens.length) tokens.forEach(t => out.add(t));
    else out.add(trimmed);
  }
  return [...out];
}

// ── 기간: server.js parseMarketingRange 복제(KST 달력일, 최대 400일, DB DATETIME은 UTC) ──
function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}
const ymdOf = t => new Date(t).toISOString().slice(0, 10);
const utcSqlOf = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

function parseRange(query, now = Date.now()) {
  const todayKst = Date.parse(ymdOf(now + KST_OFFSET_MS));
  let toT = todayKst, fromT;
  if (query.to !== undefined && query.to !== '') {
    toT = parseYmd(query.to);
    if (toT === null) return { error: 'to는 YYYY-MM-DD 형식이어야 합니다.' };
  }
  if (query.from !== undefined && query.from !== '') {
    fromT = parseYmd(query.from);
    if (fromT === null) return { error: 'from은 YYYY-MM-DD 형식이어야 합니다.' };
  } else {
    fromT = toT - 29 * DAY_MS;
  }
  if (fromT > toT) return { error: 'from은 to보다 늦을 수 없습니다.' };
  const days = Math.round((toT - fromT) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `조회 기간은 최대 ${MAX_RANGE_DAYS}일입니다.` };
  return {
    from: ymdOf(fromT), to: ymdOf(toT), days,
    startUtc: utcSqlOf(fromT - KST_OFFSET_MS),
    endUtc: utcSqlOf(toT + DAY_MS - KST_OFFSET_MS)
  };
}

// ── 파싱 헬퍼 (모두 예외를 삼킨다) ──
function parseJsonObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const str = v => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''));

function cleanTouch(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const keys = ['ts', 'landing', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'gclid', 'n_query', 'n_keyword', 'n_ad_group', 'n_media', 'n_rank'];
  const out = {};
  for (const k of keys) {
    if (k === 'ts') {
      const n = Number(t.ts);
      if (Number.isFinite(n) && n > 0) out.ts = n;
      else if (typeof t.ts === 'string' && t.ts) out.ts = t.ts;
      continue;
    }
    const v = str(t[k]);
    if (v) out[k] = v.slice(0, 500);
  }
  return Object.keys(out).length ? out : null;
}

function getAttribution(ctx) {
  const a = ctx && ctx.attribution;
  if (!a || typeof a !== 'object') return null;
  const first = cleanTouch(a.first);
  const last = cleanTouch(a.last);
  if (!first && !last) return null;
  return { first, last };
}

function getJourney(ctx) {
  const j = ctx && ctx.journey;
  if (!Array.isArray(j)) return [];
  const out = [];
  for (const e of j) {
    if (!e || typeof e !== 'object') continue;
    const path = normalizePath(e.path);
    if (!path) continue;
    const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const t = num(e.t);
    const d = num(e.d);
    out.push({
      path,
      q: str(e.q).slice(0, 300) || null,
      t: Number.isFinite(t) && t > 0 ? t : null,
      d: Number.isFinite(d) && d >= 0 ? Math.round(d) : null
    });
  }
  return out;
}

// 랜딩/경로: 전체 URL이든 경로든 pathname만 남긴다(쿼리·해시 제거).
function normalizePath(raw) {
  const s = str(raw);
  if (!s) return '';
  let p = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { p = new URL(s).pathname; } catch { return ''; }
  }
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, 200) || '/';
}

const SEARCH_ENGINES = { naver: true, google: true, daum: true };

function classifyReferrer(referrer) {
  const s = str(referrer);
  if (!s) return 'direct';
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch { return 'other'; }
  const has = (...names) => names.some(n => host === n || host.endsWith(`.${n}`));
  if (has('dockteacher.co.kr')) return 'direct'; // 내부 이동이 첫 리퍼러로 잡힌 경우
  if (has('naver.com', 'naver.me', 'naver.net')) return 'naver';
  if (/(^|\.)google\.[a-z.]+$/.test(host) || has('googleadservices.com', 'googlesyndication.com')) return 'google';
  if (has('instagram.com')) return 'instagram';
  if (has('youtube.com', 'youtu.be')) return 'youtube';
  if (has('kakao.com', 'kakao.co.kr', 'kakaocdn.net')) return 'kakao';
  if (has('facebook.com', 'fb.com', 'fb.me')) return 'facebook';
  if (has('daum.net')) return 'daum';
  return 'other';
}

// 채널 라벨(GA "소스/매체" 관례): utm → 광고 파라미터 → 리퍼러 분류 순.
function channelFromTouch(t) {
  if (!t) return null;
  const src = str(t.utm_source).toLowerCase();
  if (src) return `${src}/${str(t.utm_medium).toLowerCase() || '(none)'}`;
  if (t.n_query || t.n_keyword || t.n_media || t.n_ad_group) return 'naver/cpc';
  if (t.gclid) return 'google/cpc';
  const cls = classifyReferrer(t.referrer);
  if (cls === 'direct') return 'direct/(none)';
  return `${cls}/${SEARCH_ENGINES[cls] ? 'organic' : 'referral'}`;
}

function keywordFromAttribution(attr) {
  if (!attr) return null;
  for (const t of [attr.first, attr.last]) {
    if (!t) continue;
    if (t.n_query) return { keyword: t.n_query, source: '광고 검색어' };
    if (t.n_keyword) return { keyword: t.n_keyword, source: '광고 키워드' };
    if (t.utm_term) return { keyword: t.utm_term, source: 'utm_term' };
  }
  return null;
}

function landingFromAttribution(attr) {
  if (!attr) return null;
  const t = attr.first || attr.last;
  return t && t.landing ? normalizePath(t.landing) || null : null;
}

const normKeyword = k => str(k).toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
const toInt = v => Math.round(Number(v) || 0);
const isTruthyFlag = v => v === true || Number(v) === 1;
const ratio = (num, den) => (den ? Math.round((num / den) * 10000) / 10000 : null);

// 회원(가입 컨텍스트)·결제(결제 컨텍스트)에서 집계 차원 3개를 뽑는다.
// 결제: client_context.attribution → 결제 회원의 signup_context.attribution → 가입폼 값 순으로 폴백.
function dimensionsFor({ attr, signupChannel, searchKeyword }) {
  let channels;
  let channelKind;
  if (attr) {
    channels = [channelFromTouch(attr.first || attr.last)];
    channelKind = 'tracked';
  } else {
    const form = splitSignupChannels(signupChannel);
    channels = form.length ? form.map(c => `가입폼/${c}`) : ['(미수집)'];
    channelKind = form.length ? 'form' : 'none';
  }
  let kw = keywordFromAttribution(attr);
  if (!kw && str(searchKeyword)) kw = { keyword: searchKeyword, source: '가입폼' };
  const keyword = kw ? { keyword: normKeyword(kw.keyword), source: kw.source } : null;
  return { channels, channelKind, keyword: keyword && keyword.keyword ? keyword : null, landing: landingFromAttribution(attr) };
}

/**
 * 순수 집계 함수.
 * @param {Array} members  기간 내 가입 코호트(탈퇴 제외): {id, signup_channel, search_keyword, signup_context, is_buyer}
 *                         is_buyer: 승인 결제가 1건 이상 있는 회원(결제 시점은 기간 무관) — 결제자(buyers)·전환율 분자
 * @param {Array} payments 기간 내 승인 결제(탈퇴 제외): {id, member_id, amount, client_context,
 *                         member_signup_context, member_signup_channel, member_search_keyword}
 * @returns {{channels, keywords, landings, prePurchasePages, totals}}
 */
function aggregateAttribution(members, payments) {
  const channelMap = new Map(), keywordMap = new Map(), landingMap = new Map();
  const row = (map, key, init) => {
    if (!map.has(key)) map.set(key, { ...init, signups: 0, buyers: 0, payments: 0, revenue: 0 });
    return map.get(key);
  };
  const totals = { signups: 0, signupsTracked: 0, buyers: 0, payments: 0, paymentsTracked: 0, paymentsWithJourney: 0, revenue: 0 };

  for (const m of members || []) {
    const ctx = parseJsonObject(m.signup_context);
    const attr = getAttribution(ctx);
    const dim = dimensionsFor({ attr, signupChannel: m.signup_channel, searchKeyword: m.search_keyword });
    const buyer = isTruthyFlag(m.is_buyer) ? 1 : 0;
    totals.signups++;
    totals.buyers += buyer;
    if (attr) totals.signupsTracked++;
    // 가입폼 복수선택은 각 경로에 1명씩(기존 summary와 같은 규칙)
    for (const ch of dim.channels) {
      const g = row(channelMap, ch, { channel: ch, kind: dim.channelKind });
      g.signups++; g.buyers += buyer;
    }
    if (dim.keyword) {
      const g = row(keywordMap, dim.keyword.keyword, { keyword: dim.keyword.keyword, sources: new Set() });
      g.signups++; g.buyers += buyer; g.sources.add(dim.keyword.source);
    }
    if (dim.landing) {
      const g = row(landingMap, dim.landing, { landing: dim.landing });
      g.signups++; g.buyers += buyer;
    }
  }

  const prePurchase = new Map();
  for (const p of payments || []) {
    const ctx = parseJsonObject(p.client_context);
    const amount = toInt(p.amount);
    let attr = getAttribution(ctx);
    if (attr) totals.paymentsTracked++;
    else attr = getAttribution(parseJsonObject(p.member_signup_context));
    const dim = dimensionsFor({ attr, signupChannel: p.member_signup_channel, searchKeyword: p.member_search_keyword });
    totals.payments++;
    totals.revenue += amount;
    // 가입폼 복수선택은 각 경로에 1건씩(기존 summary와 같은 규칙)
    for (const ch of dim.channels) {
      const g = row(channelMap, ch, { channel: ch, kind: dim.channelKind });
      g.payments++; g.revenue += amount;
    }
    if (dim.keyword) {
      const g = row(keywordMap, dim.keyword.keyword, { keyword: dim.keyword.keyword, sources: new Set() });
      g.payments++; g.revenue += amount; g.sources.add(dim.keyword.source);
    }
    if (dim.landing) {
      const g = row(landingMap, dim.landing, { landing: dim.landing });
      g.payments++; g.revenue += amount;
    }

    const journey = getJourney(ctx);
    if (journey.length) {
      totals.paymentsWithJourney++;
      const tail = journey.slice(-PRE_PURCHASE_TAIL);
      const seenInThisPayment = new Set();
      tail.forEach((e, i) => {
        if (!prePurchase.has(e.path)) prePurchase.set(e.path, { path: e.path, count: 0, payments: 0, lastPageCount: 0, dwellSum: 0, dwellSamples: 0 });
        const g = prePurchase.get(e.path);
        g.count++;
        if (!seenInThisPayment.has(e.path)) { g.payments++; seenInThisPayment.add(e.path); }
        if (i === tail.length - 1) g.lastPageCount++;
        if (e.d !== null) { g.dwellSum += e.d; g.dwellSamples++; }
      });
    }
  }

  // 전환율 = 가입 코호트 중 결제자 ÷ 가입(summary의 buyers/signups와 같은 정의, 0~1, 가입 0이면 null)
  const finish = g => ({ ...g, conversionRate: ratio(g.buyers, g.signups) });
  const byVolume = (a, b) => b.payments - a.payments || b.signups - a.signups || b.revenue - a.revenue;
  const nameOrder = k => (a, b) => String(a[k]).localeCompare(String(b[k]));

  return {
    channels: [...channelMap.values()].map(finish).sort((a, b) => byVolume(a, b) || nameOrder('channel')(a, b)),
    keywords: [...keywordMap.values()]
      .map(g => finish({ ...g, sources: [...g.sources] }))
      .sort((a, b) => byVolume(a, b) || nameOrder('keyword')(a, b)).slice(0, TOP_KEYWORDS),
    landings: [...landingMap.values()].map(finish).sort((a, b) => byVolume(a, b) || nameOrder('landing')(a, b)).slice(0, TOP_LANDINGS),
    prePurchasePages: [...prePurchase.values()]
      .map(({ dwellSum, dwellSamples, ...g }) => ({ ...g, avgDwellSec: dwellSamples ? Math.round(dwellSum / dwellSamples) : null, dwellSamples }))
      .sort((a, b) => b.count - a.count || b.payments - a.payments || a.path.localeCompare(b.path))
      .slice(0, TOP_PRE_PURCHASE),
    totals
  };
}

// ── 시안 모드 ──
// 시연용: site_sections(page='marketing', section_key='demo') content {"until":"<ISO 8601>"}가 미래 시각이면,
// 실데이터가 빈 "랜딩페이지별"·"결제 직전 페이지" 표에만 아래 표본을 넣는다(만료 시 자동 해제, CSV 미포함).
// 행은 관리자가 DB에서 직접 넣고 지운다. page=marketing은 공개/범용 site 라우트에서 차단돼 있다.
const DEMO_LANDINGS = [
  { landing: '/', signups: 11, buyers: 4, payments: 5, revenue: 3900000 },
  { landing: '/classDetail.html', signups: 6, buyers: 3, payments: 3, revenue: 2700000 },
  { landing: '/vod.html', signups: 3, buyers: 1, payments: 1, revenue: 300000 }
];
const DEMO_PRE_PURCHASE = [
  { path: '/orderConfirm.html', count: 7, payments: 7, lastPageCount: 7, avgDwellSec: 41, dwellSamples: 7 },
  { path: '/classDetail.html', count: 6, payments: 6, lastPageCount: 0, avgDwellSec: 95, dwellSamples: 6 },
  { path: '/vodDetail.html', count: 3, payments: 3, lastPageCount: 0, avgDwellSec: 128, dwellSamples: 3 }
];

// content 문자열 → 활성이면 until(ISO), 아니면 null. now 주입은 테스트용.
function parseDemoUntil(content, now = Date.now()) {
  const obj = parseJsonObject(content);
  if (!obj || typeof obj.until !== 'string') return null;
  const t = Date.parse(obj.until);
  if (!Number.isFinite(t) || t <= now) return null;
  return new Date(t).toISOString();
}

// 빈 표에만 표본을 채운 새 report와 demo 정보를 돌려준다. 표본이 하나도 안 들어가면 demo는 null.
function applyDemoSamples(report, until) {
  if (!until) return { report, demo: null };
  const out = { ...report };
  let used = false;
  if (!(report.landings || []).length) {
    out.landings = DEMO_LANDINGS.map(r => ({ ...r, conversionRate: ratio(r.buyers, r.signups), demo: true }));
    used = true;
  }
  if (!(report.prePurchasePages || []).length) {
    out.prePurchasePages = DEMO_PRE_PURCHASE.map(r => ({ ...r, demo: true }));
    used = true;
  }
  return used ? { report: out, demo: { active: true, until } } : { report, demo: null };
}

// ── CSV ──
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 스프레드시트 수식 주입 방지
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const pctText = r => (r === null || r === undefined ? '' : `${(r * 100).toFixed(1)}%`);

function attributionCsv(table, report) {
  if (table === 'keywords') {
    return toCsv(['키워드', '출처', '가입', '결제자', '결제', '매출(원)', '전환율(가입자 중 결제자)'],
      report.keywords.map(r => [r.keyword, r.sources.join('/'), r.signups, r.buyers, r.payments, r.revenue, pctText(r.conversionRate)]));
  }
  return toCsv(['채널(소스/매체)', '구분', '가입', '결제자', '결제', '매출(원)', '전환율(가입자 중 결제자)'],
    report.channels.map(r => [r.channel, { tracked: '추적', form: '가입폼', none: '미수집' }[r.kind] || '', r.signups, r.buyers, r.payments, r.revenue, pctText(r.conversionRate)]));
}

// ── 추적 링크(UTM) ──
// 관리자가 SNS·메신저·블로그에 올릴 링크에 utm 꼬리표를 붙여 만들고 저장한다.
// 저장: site_sections(page='marketing', section_key='links') content {"links":[{id, createdAt, label, path, source,
// medium, campaign, content, term, url, pageTitle?}]} — 최대 LINKS_MAX개, 넘치면 오래된 것부터 버린다.
// pageTitle: 특정 강의 상세(/vodDetail.html?id=…, /classDetail.html?id=…)로 보낼 때 강의 제목(목록 표시용, 선택, 120자).
// label을 비우면 "채널 · 캠페인 · 페이지명"으로 자동(채널은 클라이언트가 보내는 channelLabel, 없으면 source).
// 성과: 가입(members.signup_context)·승인 결제(payments.client_context)의 attribution.first 또는 .last가
// utm_source/medium/campaign(+링크에 content가 있으면 utm_content까지)과 소문자·trim 기준으로 같으면 센다(기간 무관).
const LINKS_MAX = 300;
const LINK_SITE_ORIGIN = 'https://dockteacher.co.kr';
const LINK_TOKEN_RE = /^[a-z0-9_\-가-힣.]{1,60}$/;
// 경로 + 선택적 쿼리(상세 페이지 ?id=12 등). 해시·공백·제어문자 금지, '//'로 시작 금지.
const LINK_PATH_RE = /^\/(?!\/)[^\s?#\u0000-\u001f]*(\?[^\s#\u0000-\u001f]*)?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// source/medium/campaign/content: 소문자, 연속 공백 → '_'
const normLinkToken = v => str(v).toLowerCase().replace(/\s+/g, '_');
const utmKey = v => str(v).toLowerCase();

function buildTrackedUrl({ path, source, medium, campaign, content, term }) {
  const qi = path.indexOf('?');
  const base = qi >= 0 ? path.slice(0, qi) : path;
  const params = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => params.delete(k));
  params.set('utm_source', source);
  params.set('utm_medium', medium);
  params.set('utm_campaign', campaign);
  if (content) params.set('utm_content', content);
  if (term) params.set('utm_term', term);
  return `${LINK_SITE_ORIGIN}${base}?${params}`;
}

// label 자동: "채널 · 캠페인 · 페이지명", 60자 넘으면 말줄임
function autoLinkLabel(channel, campaign, page) {
  const s = [channel, campaign, page].filter(Boolean).join(' · ');
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

// POST body 검증·정규화 → { error } 또는 { value }
function validateLinkInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rawLabel = str(b.label);
  if (rawLabel.length > 60 || CONTROL_RE.test(rawLabel)) return { error: '목록 이름은 60자 이내로 입력하세요.' };
  const pageTitle = str(b.pageTitle).replace(/\s+/g, ' ');
  if (pageTitle.length > 120 || CONTROL_RE.test(pageTitle)) return { error: '페이지 제목(pageTitle)은 120자 이내로 입력하세요.' };
  const channelLabel = str(b.channelLabel).replace(/\s+/g, ' ');
  if (channelLabel.length > 60 || CONTROL_RE.test(channelLabel)) return { error: '채널 이름(channelLabel)은 60자 이내로 입력하세요.' };
  const path = str(b.path);
  if (!path || path.length > 200 || !LINK_PATH_RE.test(path)) {
    return { error: '대상 페이지는 /로 시작하는 사이트 경로여야 합니다(쿼리 ?id=12 허용, 200자 이내).' };
  }
  const names = { source: '채널(utm_source)', medium: '매체(utm_medium)', campaign: '캠페인(utm_campaign)' };
  const out = { path };
  for (const k of ['source', 'medium', 'campaign']) {
    const v = normLinkToken(b[k]);
    if (!LINK_TOKEN_RE.test(v)) return { error: `${names[k]}은 1~60자의 영문 소문자·숫자·한글·_ - . 만 쓸 수 있습니다.` };
    out[k] = v;
  }
  const content = normLinkToken(b.content);
  if (content && !LINK_TOKEN_RE.test(content)) return { error: '세부(utm_content)는 60자 이내의 영문 소문자·숫자·한글·_ - . 만 쓸 수 있습니다.' };
  out.content = content;
  const term = str(b.term).replace(/\s+/g, ' ');
  if (term.length > 60 || CONTROL_RE.test(term)) return { error: '검색어(utm_term)는 60자 이내로 입력하세요.' };
  out.term = term;
  out.pageTitle = pageTitle;
  out.label = rawLabel || autoLinkLabel(channelLabel || out.source, out.campaign, pageTitle || path.split('?')[0]);
  out.url = buildTrackedUrl(out);
  return { value: out };
}

const linkMatchKey = (source, medium, campaign, content) =>
  [utmKey(source), utmKey(medium), utmKey(campaign), utmKey(content)].join('\u0001');

// 터치 1개가 맞을 수 있는 링크 키: content 없는 링크용(3개 값) + content 있는 링크용(4개 값)
function touchMatchKeys(t, into) {
  if (!t || !t.utm_source) return;
  into.add(linkMatchKey(t.utm_source, t.utm_medium, t.utm_campaign, ''));
  if (t.utm_content) into.add(linkMatchKey(t.utm_source, t.utm_medium, t.utm_campaign, t.utm_content));
}

// DB DATETIME(UTC, 'YYYY-MM-DD HH:MM:SS' 또는 Date) → ISO
const toIso = v => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2} \d/.test(String(v)) ? `${String(v).replace(' ', 'T')}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * 순수 함수: 링크별 성과.
 * @param links    저장된 링크 배열
 * @param members  {id, joined_at, signup_context} (탈퇴 제외, context NOT NULL)
 * @param payments {id, amount, approved_at, client_context} (승인·탈퇴 제외, context NOT NULL)
 * @returns links에 stats {signups, payments, revenue, lastSeen}를 붙인 새 배열
 *          (가입·결제 1건은 first·last가 둘 다 맞아도 링크당 1번만 센다)
 */
function linkStats(links, members, payments) {
  const list = links || [];
  const byKey = new Map();
  const stats = list.map(() => ({ signups: 0, payments: 0, revenue: 0, lastSeen: null }));
  list.forEach((l, i) => {
    const k = linkMatchKey(l.source, l.medium, l.campaign, l.content || '');
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const seen = (s, at) => { if (at && (!s.lastSeen || at > s.lastSeen)) s.lastSeen = at; };
  const hitsOf = (raw) => {
    const attr = getAttribution(parseJsonObject(raw));
    if (!attr) return [];
    const keys = new Set();
    touchMatchKeys(attr.first, keys);
    touchMatchKeys(attr.last, keys);
    const idx = new Set();
    keys.forEach(k => (byKey.get(k) || []).forEach(i => idx.add(i)));
    return [...idx];
  };
  if (byKey.size) {
    for (const m of members || []) {
      const at = toIso(m.joined_at);
      for (const i of hitsOf(m.signup_context)) { stats[i].signups++; seen(stats[i], at); }
    }
    for (const p of payments || []) {
      const at = toIso(p.approved_at);
      const amount = toInt(p.amount);
      for (const i of hitsOf(p.client_context)) { stats[i].payments++; stats[i].revenue += amount; seen(stats[i], at); }
    }
  }
  return list.map((l, i) => ({ ...l, stats: stats[i] }));
}

// 저장된 JSON에서 모양이 맞는 링크만 남긴다.
function parseLinksContent(raw) {
  const obj = parseJsonObject(raw);
  const list = obj && Array.isArray(obj.links) ? obj.links : [];
  return list.filter(l => l && typeof l === 'object' && typeof l.id === 'string' && l.id && typeof l.url === 'string'
    && typeof l.source === 'string' && typeof l.medium === 'string' && typeof l.campaign === 'string');
}

const newLinkId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0');

// ── 라우트 ──
module.exports = function registerAttributionRoutes(app, opts = {}) {
  const getPool = opts.getPool || (() => opts.pool);
  const requireAdmin = opts.requireAdmin;
  const W = opts.withdrawnGroup || DEFAULT_WITHDRAWN_GROUP;
  if (typeof requireAdmin !== 'function') throw new Error('registerAttributionRoutes: requireAdmin 미들웨어가 필요합니다.');
  if (!opts.getPool && !opts.pool) throw new Error('registerAttributionRoutes: pool 또는 getPool이 필요합니다.');

  const wrap = handler => (req, res) => {
    handler(req, res).catch(err => {
      console.error('[attribution-report]', err);
      if (!res.headersSent) res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    });
  };

  // members.signup_context 컬럼은 별도 마이그레이션으로 추가된다 — 없으면 NULL로 대신 조회.
  // 있음은 영구 캐시, 없음은 60초 뒤 재확인.
  let signupCtxCol = { ok: false, checkedAt: 0 };
  async function hasSignupContext() {
    if (signupCtxCol.ok) return true;
    if (Date.now() - signupCtxCol.checkedAt < 60 * 1000) return false;
    try {
      const [[r]] = await getPool().query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = 'signup_context'`);
      signupCtxCol = { ok: Number(r.n) > 0, checkedAt: Date.now() };
    } catch {
      signupCtxCol = { ok: false, checkedAt: Date.now() };
    }
    return signupCtxCol.ok;
  }

  async function loadReport(range) {
    const pool = getPool();
    const sc = (await hasSignupContext()) ? 'm.signup_context' : 'NULL';
    const notWithdrawn = "COALESCE(m.member_group, '') <> ?";
    const [[memberRows], [paymentRows]] = await Promise.all([
      pool.query(
        `SELECT m.id, m.signup_channel, m.search_keyword, ${sc} AS signup_context,
                EXISTS(SELECT 1 FROM payments bp WHERE bp.member_id = m.id AND bp.status = 'approved') AS is_buyer
           FROM members m
          WHERE m.joined_at >= ? AND m.joined_at < ? AND ${notWithdrawn}`,
        [range.startUtc, range.endUtc, W]),
      pool.query(
        `SELECT p.id, p.member_id, p.amount, p.client_context,
                ${sc} AS member_signup_context, m.signup_channel AS member_signup_channel,
                m.search_keyword AS member_search_keyword
           FROM payments p JOIN members m ON m.id = p.member_id
          WHERE p.status = 'approved' AND p.approved_at >= ? AND p.approved_at < ? AND ${notWithdrawn}`,
        [range.startUtc, range.endUtc, W])
    ]);
    return aggregateAttribution(memberRows, paymentRows);
  }

  // 시안 모드 플래그 — 조회 실패·없음·파싱 오류·만료는 모두 비활성.
  async function loadDemoUntil() {
    try {
      const [rows] = await getPool().query(
        "SELECT content FROM site_sections WHERE page = 'marketing' AND section_key = 'demo' LIMIT 1");
      return rows && rows[0] ? parseDemoUntil(rows[0].content) : null;
    } catch {
      return null;
    }
  }

  app.get('/admin/api/marketing/attribution', requireAdmin, wrap(async (req, res) => {
    const range = parseRange(req.query);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const { report, demo } = applyDemoSamples(await loadReport(range), await loadDemoUntil());
    res.json({
      range: { from: range.from, to: range.to },
      signupContextAvailable: signupCtxCol.ok,
      ...report,
      ...(demo ? { demo } : {})
    });
  }));

  app.get('/admin/api/marketing/attribution.csv', requireAdmin, wrap(async (req, res) => {
    const table = req.query.table === 'keywords' ? 'keywords' : req.query.table === 'channels' || !req.query.table ? 'channels' : null;
    if (!table) { res.status(400).json({ error: 'table은 channels 또는 keywords여야 합니다.' }); return; }
    const range = parseRange(req.query);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const report = await loadReport(range);
    const filename = `attribution-${table}-${range.from}_${range.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(attributionCsv(table, report));
  }));

  app.get('/admin/api/marketing/journey/payment/:paymentId', requireAdmin, wrap(async (req, res) => {
    const id = parseInt(req.params.paymentId, 10);
    if (!id) { res.status(400).json({ error: '잘못된 결제 ID입니다.' }); return; }
    const [[p]] = await getPool().query(
      `SELECT p.id, p.order_number, p.item_name, p.amount, p.status, p.created_at, p.approved_at, p.client_context,
              m.id AS member_id, m.name AS member_name, m.username AS member_username
         FROM payments p LEFT JOIN members m ON m.id = p.member_id
        WHERE p.id = ?`,
      [id]);
    if (!p) { res.status(404).json({ error: '결제를 찾을 수 없습니다.' }); return; }
    const ctx = parseJsonObject(p.client_context);
    const attribution = getAttribution(ctx);
    const journey = getJourney(ctx);
    res.json({
      paymentId: p.id,
      order_number: p.order_number,
      item_name: p.item_name,
      member: p.member_id ? { id: p.member_id, name: p.member_name, username: p.member_username } : null,
      amount: toInt(p.amount),
      status: p.status,
      created_at: p.created_at,
      approved_at: p.approved_at,
      attribution,
      journey: journey.length ? journey : null,
      channel: attribution ? channelFromTouch(attribution.first || attribution.last) : null,
      collected: !!(attribution || journey.length)
    });
  }));

  app.get('/admin/api/marketing/journey/member/:memberId', requireAdmin, wrap(async (req, res) => {
    const id = parseInt(req.params.memberId, 10);
    if (!id) { res.status(400).json({ error: '잘못된 회원 ID입니다.' }); return; }
    const available = await hasSignupContext();
    const [[m]] = await getPool().query(
      `SELECT id, joined_at, signup_channel, search_keyword, referrer_code,
              ${available ? 'signup_context' : 'NULL AS signup_context'}
         FROM members WHERE id = ?`,
      [id]);
    if (!m) { res.status(404).json({ error: '회원을 찾을 수 없습니다.' }); return; }
    const ctx = parseJsonObject(m.signup_context);
    const attribution = getAttribution(ctx);
    const journey = getJourney(ctx);
    res.json({
      memberId: m.id,
      joined_at: m.joined_at,
      signup_channel: m.signup_channel || null,
      search_keyword: m.search_keyword || null,
      referrer_code: m.referrer_code || null,
      attribution,
      journey: journey.length ? journey : null,
      ua: ctx && typeof ctx.ua === 'string' ? ctx.ua.slice(0, 300) : null,
      channel: attribution ? channelFromTouch(attribution.first || attribution.last) : null,
      collected: !!(attribution || journey.length),
      signupContextAvailable: available
    });
  }));

  // ── 추적 링크(UTM) ──
  async function readLinks() {
    const [rows] = await getPool().query(
      "SELECT content FROM site_sections WHERE page = 'marketing' AND section_key = 'links' LIMIT 1");
    return rows && rows[0] ? parseLinksContent(rows[0].content) : [];
  }
  async function writeLinks(links) {
    await getPool().query(
      `INSERT INTO site_sections (page, section_key, content) VALUES ('marketing', 'links', ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [JSON.stringify({ links })]);
  }
  // 같은 프로세스 안의 동시 POST/DELETE가 서로 덮어쓰지 않도록 읽기-수정-쓰기를 줄 세운다.
  let linksChain = Promise.resolve();
  const withLinksLock = fn => {
    const run = linksChain.then(fn, fn);
    linksChain = run.catch(() => {});
    return run;
  };

  app.get('/admin/api/marketing/links', requireAdmin, wrap(async (req, res) => {
    const links = await readLinks();
    let memberRows = [];
    let paymentRows = [];
    if (links.length) {
      const pool = getPool();
      const available = await hasSignupContext();
      const notWithdrawn = "COALESCE(m.member_group, '') <> ?";
      [[memberRows], [paymentRows]] = await Promise.all([
        available
          ? pool.query(
            `SELECT m.id, m.joined_at, m.signup_context
               FROM members m
              WHERE m.signup_context IS NOT NULL AND ${notWithdrawn}`,
            [W])
          : Promise.resolve([[]]),
        pool.query(
          `SELECT p.id, p.amount, p.approved_at, p.client_context
             FROM payments p JOIN members m ON m.id = p.member_id
            WHERE p.status = 'approved' AND p.client_context IS NOT NULL AND ${notWithdrawn}`,
          [W])
      ]);
    }
    const withStats = linkStats(links, memberRows, paymentRows)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ links: withStats });
  }));

  app.post('/admin/api/marketing/links', requireAdmin, wrap(async (req, res) => {
    const { error, value } = validateLinkInput(req.body);
    if (error) { res.status(400).json({ error }); return; }
    const result = await withLinksLock(async () => {
      const links = await readLinks();
      const dupKey = l => [l.path, l.source, l.medium, l.campaign, l.content || ''].join('\u0001');
      const dup = links.find(l => dupKey(l) === dupKey(value));
      if (dup) return { status: 409, body: { error: '같은 링크가 이미 있습니다.', id: dup.id } };
      const link = {
        id: newLinkId(), createdAt: new Date().toISOString(), label: value.label, path: value.path,
        source: value.source, medium: value.medium, campaign: value.campaign,
        content: value.content, term: value.term, url: value.url
      };
      if (value.pageTitle) link.pageTitle = value.pageTitle;
      links.push(link);
      await writeLinks(links.slice(-LINKS_MAX)); // 넘치면 오래된(앞쪽) 것부터 버린다
      return { status: 200, body: { ok: true, link } };
    });
    res.status(result.status).json(result.body);
  }));

  app.delete('/admin/api/marketing/links/:id', requireAdmin, wrap(async (req, res) => {
    const id = String(req.params.id || '');
    const result = await withLinksLock(async () => {
      const links = await readLinks();
      const next = links.filter(l => l.id !== id);
      if (next.length === links.length) return { status: 404, body: { error: '링크를 찾을 수 없습니다.' } };
      await writeLinks(next);
      return { status: 200, body: { ok: true } };
    });
    res.status(result.status).json(result.body);
  }));
};

// 테스트용 순수 함수 노출
Object.assign(module.exports, {
  aggregateAttribution, attributionCsv, parseRange, parseDemoUntil, applyDemoSamples, classifyReferrer, channelFromTouch,
  normalizePath, getAttribution, getJourney, splitSignupChannels, KNOWN_SIGNUP_CHANNELS,
  validateLinkInput, buildTrackedUrl, linkStats, parseLinksContent, LINKS_MAX
});
