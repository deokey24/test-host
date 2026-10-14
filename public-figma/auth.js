// ── 로그인 모달 ──

function getOrCreateDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('deviceId', id);
  }
  return id;
}

function openLoginModal() {
  const form = document.getElementById('loginForm');
  if (form) form.reset();
  const err = document.getElementById('loginErrorMsg');
  if (err) err.style.display = 'none';
  document.getElementById('loginModalOverlay').classList.add('open');
}

function closeLoginModal() {
  document.getElementById('loginModalOverlay').classList.remove('open');
}

function applyLoggedInUI(name) {
  const trigger = document.getElementById('loginTrigger');
  if (trigger) {
    trigger.dataset.loggedIn = 'true';
    trigger.style.display = 'none';
  }
  const myInfoBtn = document.getElementById('myInfoBtn');
  if (myInfoBtn) myInfoBtn.style.display = '';
}

// GA4 user_id(dataLayer 'dt_user') — 회원 숫자 id만 보낸다. analytics.js가 없으면 no-op.
function setAnalyticsUserId(memberId) {
  if (typeof window.dtSetUserId === 'function') window.dtSetUserId(memberId == null ? null : memberId);
}

function applyLoggedOutUI() {
  const trigger = document.getElementById('loginTrigger');
  if (trigger) {
    trigger.textContent = '로그인';
    delete trigger.dataset.loggedIn;
    trigger.classList.add('btn', 'btn--ghost-dark');
    trigger.style.cssText = '';
  }
  const myInfoBtn = document.getElementById('myInfoBtn');
  if (myInfoBtn) myInfoBtn.style.display = 'none';
}

async function doLogout() {
  try { await fetch('/api/members/logout', { method: 'POST' }); } catch { /* 네트워크 오류는 무시 */ }
  setAnalyticsUserId(null);
  applyLoggedOutUI();
}

async function checkLoginState() {
  try {
    const res = await fetch('/api/members/me');
    const data = await res.json();
    if (data.loggedIn) {
      if (data.memberId) setAnalyticsUserId(data.memberId);
      applyLoggedInUI(data.name);
    } else {
      setAnalyticsUserId(null);
    }
  } catch { /* 비로그인 상태로 둔다 */ }
}

async function submitLoginForm(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const keepLoggedIn = document.getElementById('loginKeepLoggedIn').checked;
  const errEl = document.getElementById('loginErrorMsg');
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/members/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password, deviceId: getOrCreateDeviceId(), keepLoggedIn })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || '로그인에 실패했습니다.';
      errEl.style.display = 'block';
      return;
    }
    if (data.memberId) setAnalyticsUserId(data.memberId);
    if (typeof window.dtTrack === 'function') window.dtTrack('login', { method: 'email' });
    closeLoginModal();
    applyLoggedInUI(data.name);
  } catch {
    errEl.textContent = '서버와 통신 중 오류가 발생했습니다.';
    errEl.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const trigger = document.getElementById('loginTrigger');
  if (trigger) {
    trigger.addEventListener('click', () => {
      if (trigger.dataset.loggedIn === 'true') return;
      openLoginModal();
    });
  }

  const closeBtn = document.getElementById('loginModalCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeLoginModal);

  const overlay = document.getElementById('loginModalOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeLoginModal();
    });
  }

  const form = document.getElementById('loginForm');
  if (form) form.addEventListener('submit', submitLoginForm);

  checkLoginState();
});
