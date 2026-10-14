// 결제 승인 시점에 서버가 직접 보내는 purchase 전환(GA4 Measurement Protocol + Meta 전환 API).
// 브라우저 라운드트립 끊김·관리자 수동승인·광고차단으로 브라우저 픽셀이 못 잡는 구매를 보완한다.
// dedup: GA4는 transaction_id, Meta는 event_id를 둘 다 order_number로 맞춰 브라우저(GTM) 이벤트와 중복 제거.
// 설정(측정 ID·API Secret·픽셀 ID·토큰)은 호출부가 settings 객체로 주입한다 — server.js의 getMarketingSettings()가
// 관리자 "마케팅" 설정(site_sections marketing/analytics) > 환경변수 순으로 채운다. 이 파일은 env를 직접 읽지 않는다
// (CONVERSION_DEBUG만 예외). 값이 비어 있으면 해당 채널은 skip(no-op). 외부 의존성 없음(Node 20 fetch/crypto).
const crypto = require('crypto');

const TIMEOUT_MS = 5000;
const META_API_VERSION = 'v21.0';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key || key in out) continue;
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try { val = decodeURIComponent(val); } catch { /* 깨진 인코딩은 원문 유지 */ }
    out[key] = val;
  }
  return out;
}

// 순수 함수 — 쿠키 객체(또는 헤더 문자열)에서 GA client_id / session_id 추출.
// _ga        = GA1.1.<cid1>.<cid2>                → client_id "cid1.cid2"
// _ga_<ID>   = GS1.1.<sid>.<n>.<...>              (구형식)
//            = GS2.1.s<sid>$o<n>$g..$t..          (2025~ 신형식)  → session_id "sid"
// measurementId(예 'G-ABC123')가 주어지면 해당 속성의 _ga_ABC123 쿠키를 우선 사용하고, 없을 때만 첫 _ga_* 쿠키로 대체한다
// (같은 도메인에 GA4 속성이 여럿이면 다른 속성의 세션을 잘못 집는 것을 막기 위함).
function parseGaCookies(cookies, measurementId) {
  const c = typeof cookies === 'string' ? parseCookies(cookies) : (cookies || {});
  let gaClientId = null;
  if (c._ga) {
    const parts = String(c._ga).split('.');
    if (parts.length >= 4) gaClientId = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  }
  let gaSessionId = null;
  const preferredKey = measurementId ? `_ga_${String(measurementId).replace(/^G-/i, '')}` : null;
  const sessKey = (preferredKey && c[preferredKey] != null)
    ? preferredKey
    : Object.keys(c).find(k => k.startsWith('_ga_'));
  if (sessKey) {
    const v = String(c[sessKey]);
    let m = v.match(/^GS2\.\d+\.s(\d+)/);
    if (!m) m = v.match(/^GS1\.\d+\.(\d+)/);
    if (m) gaSessionId = m[1];
  }
  return { ga_client_id: gaClientId, ga_session_id: gaSessionId };
}

// /api/payments/init 시점(브라우저 요청)의 식별 정보를 스냅샷 — 승인은 PG 콜백·관리자 수동승인 등
// 브라우저 쿠키가 없는 요청에서 일어날 수 있어서 결제 행(client_context)에 미리 저장해 둔다.
// settings.ga4MeasurementId가 있으면 그 속성의 _ga_<ID> 쿠키에서 session_id를 우선 읽는다.
function captureClientContext(req, settings) {
  const cookies = parseCookies(req.headers?.cookie);
  const { ga_client_id, ga_session_id } = parseGaCookies(cookies, settings?.ga4MeasurementId);
  // server.js의 app.set('trust proxy', 1) 덕분에 req.ip가 nginx가 넘긴 실제 클라이언트 IP다.
  // X-Forwarded-For 첫 값은 클라이언트가 위조할 수 있으므로 직접 읽지 않는다.
  const ip = req.ip || null;
  const ua = req.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 255) : null;
  return {
    ga_client_id,
    ga_session_id,
    fbp: cookies._fbp || null,
    fbc: cookies._fbc || null,
    ip,
    ua
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && e.includes('@') ? e : null;
}

// 국내 번호 010-1234-5678 → 821012345678 (Meta 권장: 국가코드 포함 숫자만)
function normalizePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('82')) return d;
  if (d.startsWith('0')) d = d.slice(1);
  return `82${d}`;
}

async function postJson(url, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseContext(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

async function sendGa4({ payment, member, ctx, settings }) {
  const measurementId = settings?.ga4MeasurementId;
  const apiSecret = settings?.ga4ApiSecret;
  if (!measurementId || !apiSecret) return 'skipped';

  const debug = process.env.CONVERSION_DEBUG === '1';
  const base = debug ? 'https://www.google-analytics.com/debug/mp/collect' : 'https://www.google-analytics.com/mp/collect';
  const url = `${base}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  const value = Number(payment.amount) || 0;
  const params = {
    transaction_id: payment.order_number,
    value,
    currency: 'KRW',
    engagement_time_msec: 100,
    items: [{
      item_id: String(payment.vod_course_id),
      item_name: payment.item_name,
      price: value,
      quantity: 1
    }]
  };
  if (payment.coupon_code) params.coupon = payment.coupon_code;
  if (ctx.ga_session_id) params.session_id = ctx.ga_session_id;

  const body = {
    // client_id가 없으면(쿠키 차단·수집 전 결제) 회원 기반 대체값 — GA4 집계엔 잡히되 유입 귀속은 안 된다.
    client_id: ctx.ga_client_id || `srv.${member?.id ?? payment.member_id}`,
    events: [{ name: 'purchase', params }]
  };

  const res = await postJson(url, body);
  if (debug) {
    let msgs = res.text;
    try { msgs = JSON.parse(res.text).validationMessages; } catch { /* 원문 출력 */ }
    console.log('[conversion][ga4][debug] payload=', JSON.stringify(body), 'validationMessages=', JSON.stringify(msgs));
  }
  if (!res.ok) throw new Error(`GA4 MP HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  return 'sent';
}

async function sendMeta({ payment, member, ctx, settings }) {
  const pixelId = settings?.metaPixelId;
  const token = settings?.metaCapiAccessToken;
  if (!pixelId || !token) return 'skipped';

  const userData = {};
  const email = normalizeEmail(member?.email);
  if (email) userData.em = [sha256(email)];
  const phone = normalizePhone(member?.mobile || member?.phone);
  if (phone) userData.ph = [sha256(phone)];
  if (ctx.ip) userData.client_ip_address = ctx.ip;
  if (ctx.ua) userData.client_user_agent = ctx.ua;
  if (ctx.fbp) userData.fbp = ctx.fbp;
  if (ctx.fbc) userData.fbc = ctx.fbc;

  const approvedAt = payment.approved_at ? new Date(payment.approved_at).getTime() : Date.now();
  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor((Number.isFinite(approvedAt) ? approvedAt : Date.now()) / 1000),
      event_id: payment.order_number,
      action_source: 'website',
      user_data: userData,
      custom_data: {
        currency: 'KRW',
        value: Number(payment.amount) || 0,
        content_ids: [String(payment.vod_course_id)],
        content_type: 'product',
        order_id: payment.order_number
      }
    }]
  };
  const url = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  const res = await postJson(url, body);
  if (process.env.CONVERSION_DEBUG === '1') console.log('[conversion][meta][debug] status=', res.status, 'response=', res.text.slice(0, 500));
  if (!res.ok) throw new Error(`Meta CAPI HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  return 'sent';
}

// payment: payments 행(+ 선택적으로 coupon_code). member: members 행(id, email, mobile, phone).
// settings: { ga4MeasurementId, ga4ApiSecret, metaPixelId, metaCapiAccessToken } — 채널별로 둘 다 있어야 전송.
// 반환: { ga4: 'sent'|'skipped'|'failed', meta: 'sent'|'skipped'|'failed' } — 예외를 던지지 않는다.
async function sendPurchaseConversion({ payment, member, settings }) {
  const ctx = parseContext(payment?.client_context);
  const result = { ga4: 'skipped', meta: 'skipped' };
  const [ga4, meta] = await Promise.allSettled([
    sendGa4({ payment, member, ctx, settings }),
    sendMeta({ payment, member, ctx, settings })
  ]);
  if (ga4.status === 'fulfilled') result.ga4 = ga4.value;
  else { result.ga4 = 'failed'; console.error('[conversion][ga4] 전송 실패', payment?.order_number, ga4.reason?.message || ga4.reason); }
  if (meta.status === 'fulfilled') result.meta = meta.value;
  else { result.meta = 'failed'; console.error('[conversion][meta] 전송 실패', payment?.order_number, meta.reason?.message || meta.reason); }
  return result;
}

module.exports = { parseCookies, parseGaCookies, captureClientContext, sendPurchaseConversion };
