// ── 홈 진입 팝업 배너 (dock-pass 팝업배너 기능 이식) ──

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/^]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function isPopupDismissedToday(id) {
  return getCookie(`popup-dismissed-${id}`) === '1';
}

// 자정에 만료되는 쿠키 — "오늘 하루 보지 않기"는 당일 안에서만 유효해야 하므로 세션이 아니라
// 날짜 경계에 걸어야 한다(다음날 방문 시 다시 노출).
function dismissPopupForToday(id) {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  document.cookie = `popup-dismissed-${id}=1; expires=${midnight.toUTCString()}; path=/`;
}

function renderPopupBanner(banner) {
  const el = document.createElement('div');
  el.className = 'popup-banner';
  el.dataset.position = banner.position || 'center';

  const img = document.createElement('img');
  img.src = banner.image_url;
  img.alt = '팝업 배너';

  if (banner.link_url) {
    const link = document.createElement('a');
    link.className = 'popup-banner__link';
    link.href = banner.link_url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.appendChild(img);
    el.appendChild(link);
  } else {
    el.appendChild(img);
  }

  const actions = document.createElement('div');
  actions.className = 'popup-banner__actions';
  actions.innerHTML = `
    <button type="button" class="popup-banner__dismiss">오늘 하루 보지 않기</button>
    <button type="button" class="popup-banner__close" aria-label="닫기">✕</button>
  `;
  actions.querySelector('.popup-banner__dismiss').addEventListener('click', () => {
    dismissPopupForToday(banner.id);
    el.remove();
  });
  actions.querySelector('.popup-banner__close').addEventListener('click', () => el.remove());
  el.appendChild(actions);

  return el;
}

async function loadPopupBanners() {
  const layer = document.getElementById('popupBannerLayer');
  if (!layer) return;
  let banners;
  try {
    const res = await fetch('/api/popup-banners');
    banners = await res.json();
  } catch {
    return; // 네트워크 오류 시 팝업 없이 조용히 넘어간다
  }
  if (!Array.isArray(banners)) return;
  banners
    .filter(b => !isPopupDismissedToday(b.id))
    .forEach(b => layer.appendChild(renderPopupBanner(b)));
}

document.addEventListener('DOMContentLoaded', loadPopupBanners);
