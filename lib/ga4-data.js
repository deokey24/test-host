// GA4 Data API(analyticsdata.googleapis.com/v1beta) 조회 — 관리자 "마케팅 → GA4 방문 통계"용.
// 계획: docs/plans/admin-ga4-report.md 1장. 설정법: docs/analytics-setup.md 10장.
//
// 인증: 서비스 계정 키(JSON)로 JWT(RS256)를 직접 서명해 OAuth 토큰을 받는다(외부 패키지 없음, Node 20 전역 fetch).
// 설정 원천: server.js getMarketingSettings()의 ga4PropertyId / ga4ServiceAccountJson (관리자 설정 > env 폴백).
// 캐시(프로세스 메모리): 액세스 토큰(client_email별, 만료 60초 전 갱신), 보고서 묶음 1시간(최대 50개),
// 실시간 30초. 설정 저장 시 server.js invalidateMarketingSettings()가 clearGa4Cache()를 호출한다.
//
// 마운트(server.js 마케팅 블록 끝):
//   require('./lib/ga4-data').registerGa4Routes(app, { getMarketingSettings, parseMarketingRange, requireAdmin, wrapAsync });

const crypto = require('crypto');

const DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TIMEOUT_MS = 10 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const OVERVIEW_TTL_MS = 60 * 60 * 1000;
const OVERVIEW_MAX_ENTRIES = 50;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // refresh=1이어도 같은 키는 분당 1회만 실제 조회
const REALTIME_TTL_MS = 30 * 1000;
const SA_JSON_MAX_LENGTH = 10000;
const PROPERTY_ID_RE = /^\d{5,15}$/;
// 토큰 요청에는 서명된 assertion이 실리므로 구글 도메인으로만 보낸다.
const TOKEN_URI_RE = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|google\.com)\//i;
const FUNNEL_EVENTS = ['page_view', 'view_item', 'sign_up', 'login', 'begin_checkout', 'purchase'];
const TOTAL_METRICS = ['sessions', 'totalUsers', 'newUsers', 'screenPageViews', 'keyEvents'];

const HINTS = {
  permission: '서비스 계정 이메일을 GA4 속성 액세스 관리에 뷰어로 추가했는지, 속성 ID가 맞는지 확인하세요.',
  notFound: 'GA4 속성 ID가 맞는지 확인하세요(GA4 관리 → 속성 설정의 숫자 속성 ID).',
  badKey: '서비스 계정 키가 유효하지 않습니다(Google Cloud에서 키 재발급 후 다시 저장).',
  apiDisabled: 'Google Cloud 프로젝트에서 "Google Analytics Data API"를 사용 설정했는지 확인하세요.',
  quota: 'GA4 Data API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.',
  timeout: '구글 API 응답이 10초 안에 오지 않았습니다. 잠시 후 다시 시도하세요.',
  network: '구글 API에 연결하지 못했습니다. 서버 네트워크 상태를 확인하세요.'
};

// ── 서비스 계정 JSON ──
// 성공 시 { client_email, private_key, token_uri }, 형식이 틀리면 null.
function parseServiceAccount(jsonText) {
  if (typeof jsonText !== 'string') return null;
  const text = jsonText.trim();
  if (!text || text.length > SA_JSON_MAX_LENGTH) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.type !== 'service_account') return null;
  const email = obj.client_email;
  const key = obj.private_key;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (typeof key !== 'string' || !key.includes('-----BEGIN PRIVATE KEY-----')) return null;
  let tokenUri = DEFAULT_TOKEN_URI;
  if (obj.token_uri !== undefined && obj.token_uri !== null && obj.token_uri !== '') {
    if (typeof obj.token_uri !== 'string' || !TOKEN_URI_RE.test(obj.token_uri)) return null;
    tokenUri = obj.token_uri;
  }
  try { crypto.createPrivateKey(key); } catch { return null; }
  return { client_email: email, private_key: key, token_uri: tokenUri };
}

function isValidPropertyId(v) {
  return typeof v === 'string' && PROPERTY_ID_RE.test(v);
}

// ── HTTP ──
function ga4Error(message, { status = 0, code = '', hint = '' } = {}) {
  const err = new Error(message || 'GA4 API 오류');
  err.ga4 = true;
  err.status = status;
  err.code = code;
  err.hint = hint;
  return err;
}

function hintFor(status, code, message) {
  const m = String(message || '');
  if (code === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(m)) return HINTS.apiDisabled;
  if (status === 403 || code === 'PERMISSION_DENIED') return HINTS.permission;
  if (status === 404 || code === 'NOT_FOUND') return HINTS.notFound;
  if (status === 401 || code === 'UNAUTHENTICATED' || code === 'invalid_grant' || code === 'invalid_client') return HINTS.badKey;
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return HINTS.quota;
  return '';
}

// 10초 타임아웃 + 비 2xx 정규화. opts.fetch로 구현 주입(테스트), opts.timeoutMs로 시간 조정.
async function requestJson(url, init, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || (err && err.name === 'AbortError')) {
      throw ga4Error(`구글 API 응답 시간 초과(${Math.ceil(timeoutMs / 1000)}초)`, { status: 504, code: 'TIMEOUT', hint: HINTS.timeout });
    }
    throw ga4Error(`구글 API 연결 실패: ${err && err.message}`, { code: 'NETWORK', hint: HINTS.network });
  } finally {
    clearTimeout(timer);
  }
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    // Data API: {error:{code,message,status}} / OAuth 토큰: {error:'invalid_grant', error_description}
    let message = '', code = '';
    if (data && data.error && typeof data.error === 'object') {
      message = data.error.message || '';
      code = data.error.status || '';
    } else if (data && typeof data.error === 'string') {
      code = data.error;
      message = data.error_description || data.error;
    }
    if (!message) message = `HTTP ${res.status}`;
    throw ga4Error(message, { status: res.status, code, hint: hintFor(res.status, code, message) });
  }
  return data || {};
}

// ── 액세스 토큰 (client_email별 캐시) ──
const tokenCache = new Map(); // client_email → { token, expiresAt }

function base64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function buildAssertion(sa, nowSec) {
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64urlJson({
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || DEFAULT_TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600
  });
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function getAccessToken(sa, opts = {}) {
  const now = Date.now();
  const hit = tokenCache.get(sa.client_email);
  if (hit && now < hit.expiresAt - TOKEN_REFRESH_MARGIN_MS) return hit.token;
  const assertion = buildAssertion(sa, Math.floor(now / 1000));
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  }).toString();
  const data = await requestJson(sa.token_uri || DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }, opts);
  if (!data.access_token) throw ga4Error('구글 토큰 응답에 access_token이 없습니다.', { hint: HINTS.badKey });
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokenCache.set(sa.client_email, { token: data.access_token, expiresAt: now + expiresIn * 1000 });
  return data.access_token;
}

async function callDataApi(sa, propertyId, method, body, opts = {}) {
  if (!isValidPropertyId(String(propertyId))) throw ga4Error('GA4 속성 ID 형식이 올바르지 않습니다.', { hint: HINTS.notFound });
  const token = await getAccessToken(sa, opts);
  return requestJson(`${DATA_API_BASE}/properties/${propertyId}:${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  }, opts);
}

const runReport = (sa, propertyId, body, opts) => callDataApi(sa, propertyId, 'runReport', body, opts);
const batchRunReports = (sa, propertyId, requests, opts) => callDataApi(sa, propertyId, 'batchRunReports', { requests }, opts);
const runRealtimeReport = (sa, propertyId, body, opts) => callDataApi(sa, propertyId, 'runRealtimeReport', body, opts);

// ── 정규화 ──
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round4 = v => Math.round(num(v) * 10000) / 10000;

// report.rows → [{ <dimName>: string, <metricName>: number }]
function reportRows(report) {
  if (!report) return [];
  const dims = (report.dimensionHeaders || []).map(h => h.name);
  const mets = (report.metricHeaders || []).map(h => h.name);
  return (report.rows || []).map(row => {
    const o = {};
    dims.forEach((name, i) => { o[name] = String(((row.dimensionValues || [])[i] || {}).value ?? ''); });
    mets.forEach((name, i) => { o[name] = num(((row.metricValues || [])[i] || {}).value); });
    return o;
  });
}

function reportTotals(report) {
  const t = report && Array.isArray(report.totals) && report.totals[0];
  if (!t || !Array.isArray(t.metricValues)) return null;
  const mets = (report.metricHeaders || []).map(h => h.name);
  const o = {};
  mets.forEach((name, i) => { o[name] = num((t.metricValues[i] || {}).value); });
  return o;
}

const ymdFromGa = s => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);

function eachDay(from, to) {
  const out = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end)) return out;
  for (let i = 0; t <= end && i < 1000; i++, t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function overviewRequests({ from, to }) {
  const dateRanges = [{ startDate: from, endDate: to }];
  const m = names => names.map(name => ({ name }));
  const d = names => names.map(name => ({ name }));
  return [
    { dateRanges, dimensions: d(['date']), metrics: m(TOTAL_METRICS),
      orderBys: [{ dimension: { dimensionName: 'date' } }], metricAggregations: ['TOTAL'], limit: 1000 },
    { dateRanges, dimensions: d(['pagePath']), metrics: m(['screenPageViews', 'totalUsers', 'userEngagementDuration', 'engagementRate']),
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 50 },
    { dateRanges, dimensions: d(['sessionSource', 'sessionMedium']), metrics: m(['sessions', 'totalUsers', 'engagedSessions', 'keyEvents']),
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 30 },
    { dateRanges, dimensions: d(['landingPage']), metrics: m(['sessions', 'totalUsers', 'keyEvents']),
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 30 },
    { dateRanges, dimensions: d(['eventName']), metrics: m(['eventCount', 'totalUsers']),
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_EVENTS } } },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 20 }
  ];
}

// batchRunReports 응답 → 화면용 모양. 순수 함수(테스트 대상).
function normalizeOverview(batch, { from, to }) {
  const reports = (batch && batch.reports) || [];
  const [dailyR, pagesR, sourcesR, landingsR, eventsR] = reports;

  // 일별: GA4는 데이터 없는 날을 생략하므로 기간 전체를 0으로 채운다.
  const byDate = new Map();
  for (const r of reportRows(dailyR)) byDate.set(ymdFromGa(r.date), r);
  const daily = eachDay(from, to).map(date => {
    const r = byDate.get(date) || {};
    const o = { date };
    for (const k of TOTAL_METRICS) o[k] = num(r[k]);
    return o;
  });

  // 합계: GA4 TOTAL 집계(사용자 수 중복 제거) 우선, 없으면 일별 합.
  const gaTotals = reportTotals(dailyR);
  const totals = {};
  for (const k of TOTAL_METRICS) {
    totals[k] = gaTotals && k in gaTotals ? gaTotals[k] : daily.reduce((s, r) => s + r[k], 0);
  }

  const pages = reportRows(pagesR).map(r => ({
    pagePath: r.pagePath,
    screenPageViews: r.screenPageViews,
    totalUsers: r.totalUsers,
    avgEngagementSec: r.screenPageViews ? Math.round(r.userEngagementDuration / r.screenPageViews) : 0,
    engagementRate: round4(r.engagementRate)
  })).sort((a, b) => b.screenPageViews - a.screenPageViews);

  const sources = reportRows(sourcesR).map(r => ({
    source: r.sessionSource,
    medium: r.sessionMedium,
    sessions: r.sessions,
    totalUsers: r.totalUsers,
    engagedSessions: r.engagedSessions,
    keyEvents: r.keyEvents
  })).sort((a, b) => b.sessions - a.sessions);

  const landings = reportRows(landingsR).map(r => ({
    landingPage: r.landingPage,
    sessions: r.sessions,
    totalUsers: r.totalUsers,
    keyEvents: r.keyEvents
  })).sort((a, b) => b.sessions - a.sessions);

  // 퍼널 이벤트: 고정 순서, 발생 없는 이벤트도 0으로 포함.
  const byEvent = new Map(reportRows(eventsR).map(r => [r.eventName, r]));
  const events = FUNNEL_EVENTS.map(eventName => {
    const r = byEvent.get(eventName) || {};
    return { eventName, eventCount: num(r.eventCount), totalUsers: num(r.totalUsers) };
  });

  return { daily, pages, sources, landings, events, totals };
}

async function fetchOverview(sa, propertyId, range, opts = {}) {
  const batch = await batchRunReports(sa, propertyId, overviewRequests(range), opts);
  return normalizeOverview(batch, range);
}

async function fetchRealtime(sa, propertyId, opts = {}) {
  const report = await runRealtimeReport(sa, propertyId, { metrics: [{ name: 'activeUsers' }] }, opts);
  const totals = reportTotals(report);
  const row = reportRows(report)[0];
  return { activeUsers: num((row && row.activeUsers) ?? (totals && totals.activeUsers)) };
}

// ── 캐시 ──
const overviewCache = new Map(); // key → { at, data }  (Map 삽입 순서 = 오래된 순, 조회 시 맨 뒤로)
const overviewInflight = new Map(); // key → Promise
const realtimeCache = new Map(); // key → { at, data }

function clearGa4Cache() {
  tokenCache.clear();
  overviewCache.clear();
  overviewInflight.clear();
  realtimeCache.clear();
}

// 반환: { data, fetchedAt(ms), cached }
async function getOverviewCached(sa, propertyId, range, opts = {}) {
  const key = `${sa.client_email}|${propertyId}|${range.from}|${range.to}`;
  const now = Date.now();
  const hit = overviewCache.get(key);
  if (hit) {
    const age = now - hit.at;
    const usable = opts.refresh ? age < REFRESH_MIN_INTERVAL_MS : age < OVERVIEW_TTL_MS;
    if (usable) {
      overviewCache.delete(key); overviewCache.set(key, hit);
      return { data: hit.data, fetchedAt: hit.at, cached: true };
    }
  }
  if (overviewInflight.has(key)) return overviewInflight.get(key);
  const p = (async () => {
    const data = await fetchOverview(sa, propertyId, range, opts);
    const at = Date.now();
    overviewCache.delete(key);
    overviewCache.set(key, { at, data });
    while (overviewCache.size > OVERVIEW_MAX_ENTRIES) overviewCache.delete(overviewCache.keys().next().value);
    return { data, fetchedAt: at, cached: false };
  })();
  overviewInflight.set(key, p);
  try { return await p; } finally { overviewInflight.delete(key); }
}

async function getRealtimeCached(sa, propertyId, opts = {}) {
  const key = `${sa.client_email}|${propertyId}`;
  const hit = realtimeCache.get(key);
  if (hit && Date.now() - hit.at < REALTIME_TTL_MS) return { data: hit.data, fetchedAt: hit.at, cached: true };
  const data = await fetchRealtime(sa, propertyId, opts);
  const at = Date.now();
  realtimeCache.set(key, { at, data });
  return { data, fetchedAt: at, cached: false };
}

// 설정에서 GA4 Data API 접속 정보 추출. 둘 중 하나라도 없거나 틀리면 null.
function resolveGa4Config(settings) {
  const s = settings || {};
  const propertyId = typeof s.ga4PropertyId === 'string' ? s.ga4PropertyId.trim() : '';
  if (!isValidPropertyId(propertyId)) return null;
  const sa = parseServiceAccount(s.ga4ServiceAccountJson);
  if (!sa) return null;
  return { propertyId, sa };
}

// ── 라우트 ──
// deps: { getMarketingSettings, parseMarketingRange, requireAdmin, wrapAsync, fetch? }
function registerGa4Routes(app, deps) {
  const { getMarketingSettings, parseMarketingRange, requireAdmin, wrapAsync } = deps;
  const fetchOpts = deps.fetch ? { fetch: deps.fetch } : {};
  const sendGoogleError = (res, err) => {
    res.status(502).json({ error: err.message, hint: err.hint || '' });
  };

  app.get('/admin/api/marketing/ga4', requireAdmin, wrapAsync(async (req, res) => {
    const range = parseMarketingRange(req.query);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const cfg = resolveGa4Config(await getMarketingSettings());
    if (!cfg) { res.json({ configured: false }); return; }
    let result;
    try {
      result = await getOverviewCached(cfg.sa, cfg.propertyId, { from: range.from, to: range.to },
        { ...fetchOpts, refresh: req.query.refresh === '1' });
    } catch (err) {
      if (!err.ga4) throw err;
      console.error('[ga4] 보고서 조회 실패:', err.status, err.message);
      sendGoogleError(res, err); return;
    }
    res.json({
      configured: true,
      propertyId: cfg.propertyId,
      range: { from: range.from, to: range.to },
      fetchedAt: new Date(result.fetchedAt).toISOString(),
      cached: result.cached,
      ...result.data
    });
  }));

  app.get('/admin/api/marketing/ga4/realtime', requireAdmin, wrapAsync(async (req, res) => {
    const cfg = resolveGa4Config(await getMarketingSettings());
    if (!cfg) { res.json({ configured: false }); return; }
    let result;
    try {
      result = await getRealtimeCached(cfg.sa, cfg.propertyId, fetchOpts);
    } catch (err) {
      if (!err.ga4) throw err;
      console.error('[ga4] 실시간 조회 실패:', err.status, err.message);
      sendGoogleError(res, err); return;
    }
    res.json({ configured: true, activeUsers: result.data.activeUsers, fetchedAt: new Date(result.fetchedAt).toISOString() });
  }));

  // 저장된 설정으로 최근 7일 세션 수를 조회(캐시 없음). 결과는 항상 200 — 화면이 메시지를 표시.
  app.post('/admin/api/marketing/ga4/test', requireAdmin, wrapAsync(async (req, res) => {
    const cfg = resolveGa4Config(await getMarketingSettings());
    if (!cfg) { res.json({ ok: false, error: 'GA4 속성 ID와 서비스 계정 JSON을 먼저 저장하세요.' }); return; }
    try {
      const report = await runReport(cfg.sa, cfg.propertyId, {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'sessions' }]
      }, fetchOpts);
      const row = reportRows(report)[0];
      res.json({ ok: true, sessions7d: row ? row.sessions : 0 });
    } catch (err) {
      if (!err.ga4) throw err;
      res.json({ ok: false, error: err.message, hint: err.hint || '' });
    }
  }));
}

module.exports = {
  parseServiceAccount,
  isValidPropertyId,
  getAccessToken,
  runReport,
  batchRunReports,
  runRealtimeReport,
  overviewRequests,
  normalizeOverview,
  fetchOverview,
  fetchRealtime,
  getOverviewCached,
  getRealtimeCached,
  resolveGa4Config,
  clearGa4Cache,
  registerGa4Routes,
  FUNNEL_EVENTS,
  SA_JSON_MAX_LENGTH
};
