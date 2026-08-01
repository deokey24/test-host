// ── 배너 관리 (상단/중간/콘텐츠/사이드/하단 5종 공용 로직, 추가/수정은 공용 모달로 처리) ──
const BANNER_TYPES = ['top', 'middle', 'content', 'side', 'bottom'];
// mobileImage: 모바일 전용 이미지 슬롯을 쓰는 타입(상단/중간). 원본이 1280×180처럼 납작해서
// 모바일 폭에 맞추면 글자가 너무 작아지기 때문에, 세로가 긴 모바일용 이미지를 따로 받는다.
const BANNER_TYPE_META = {
  top:     { title: '상단배너',   sizeHint: '(권장 1280×180px)', thumbWidth: '220px', ratio: '1280/180',
             mobileImage: true, mobileSizeHint: '(권장 1080×720px — 2:1보다 세로가 긴 비율)', mobileThumbWidth: '120px', mobileRatio: '1080/720' },
  middle:  { title: '중간배너',   sizeHint: '(권장 1280×100px)', thumbWidth: '220px', ratio: '1280/100',
             mobileImage: true, mobileSizeHint: '(권장 1080×400px — 3:1보다 세로가 긴 비율)', mobileThumbWidth: '150px', mobileRatio: '1080/400' },
  content: { title: '콘텐츠배너', sizeHint: '(권장 600×325px)',  thumbWidth: '150px', ratio: '600/325', labelRequired: true, labelHint: '(DOCK NEWS 탭 이름으로 표시됩니다)' },
  side:    { title: '사이드배너', sizeHint: '(권장 320×325px)',  thumbWidth: '130px', ratio: '320/325' },
  // 하단배너는 PC/모바일 비율이 2.16:1 ↔ 1.2:1로 크게 달라 모바일 전용 이미지를 반드시 따로 받는 편이 좋다.
  bottom:  { title: '하단배너',   sizeHint: '(권장 1080×500px)', thumbWidth: '200px', ratio: '1080/500',
             mobileImage: true, mobileSizeHint: '(권장 720×600px — 세로가 긴 비율)', mobileThumbWidth: '120px', mobileRatio: '720/600' }
};

let allBanners = [];
let modalState = { type: null, currentId: null, imageUrl: '', mobileImageUrl: '' };

function bannerRowHtml(item) {
  return `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <img class="popup-list-thumb" src="${escapeHtml(item.image_url)}" alt="">
      <div class="drag-item-body">
        <div style="font-weight:700;">${escapeHtml(item.label || '(라벨 없음)')}</div>
        <div style="color:var(--text-soft); font-size:12px;">${item.link_url ? escapeHtml(item.link_url) : '링크 없음'}</div>
      </div>
      <button type="button" class="row-btn${item.visible ? '' : ' danger'}" data-toggle-visible="${item.id}">${item.visible ? '노출중' : '숨김'}</button>
      <button type="button" class="row-btn" data-edit-id="${item.id}">수정</button>
      <button type="button" class="row-btn danger" data-remove-id="${item.id}">삭제</button>
    </li>
  `;
}

async function loadAllBanners() {
  allBanners = await apiFetch('/admin/api/content-banners');
  BANNER_TYPES.forEach(renderBannerList);
}

function renderBannerList(type) {
  const items = allBanners.filter(b => b.banner_type === type);
  document.getElementById(`bannerTotal-${type}`).textContent = items.length;
  const listEl = document.getElementById(`banner-${type}-list`);
  listEl.innerHTML = items.length
    ? items.map(bannerRowHtml).join('')
    : '<li class="instr-empty">등록된 배너가 없습니다.</li>';
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/content-banners/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    await loadAllBanners();
  });
}

// 모바일 이미지 미리보기/폴백 안내 토글 — 이미지가 있으면 크롭 위치 선택은 의미가 없어 숨긴다.
function renderBannerMobilePreview() {
  const preview = document.getElementById('bannerModalMobilePreview');
  const previewEmpty = document.getElementById('bannerModalMobilePreviewEmpty');
  const has = !!modalState.mobileImageUrl;
  preview.src = has ? modalState.mobileImageUrl : '';
  preview.classList.toggle('on', has);
  previewEmpty.classList.toggle('off', has);
  document.getElementById('bannerModalMobileClearBtn').style.display = has ? '' : 'none';
  document.getElementById('bannerModalFocusWrap').style.display = has ? 'none' : '';
}

function openBannerModal(type, item) {
  const meta = BANNER_TYPE_META[type];
  modalState = { type, currentId: item ? item.id : null, imageUrl: item ? item.image_url : '', mobileImageUrl: item?.mobile_image_url || '' };

  const mobileRow = document.getElementById('bannerModalMobileRow');
  mobileRow.style.display = meta.mobileImage ? '' : 'none';
  if (meta.mobileImage) {
    document.getElementById('bannerModalMobileSizeHint').textContent = meta.mobileSizeHint;
    const mobileThumb = document.getElementById('bannerModalMobileThumbLabel');
    mobileThumb.style.width = meta.mobileThumbWidth;
    mobileThumb.style.aspectRatio = meta.mobileRatio;
    mobileThumb.style.borderRadius = '8px';
    document.getElementById('bannerModalMobileFocus').value = item?.mobile_focus || 'center';
    document.getElementById('bannerModalMobileFile').value = '';
    renderBannerMobilePreview();
  }

  document.getElementById('bannerModalTitle').textContent = `${meta.title} ${item ? '수정' : '추가'}`;
  document.getElementById('bannerModalSizeHint').textContent = meta.sizeHint;
  document.getElementById('bannerModalLabelLabel').textContent = meta.labelRequired ? `라벨 * ${meta.labelHint || ''}` : '라벨(관리용)';

  const thumbLabel = document.getElementById('bannerModalThumbLabel');
  thumbLabel.style.width = meta.thumbWidth;
  thumbLabel.style.aspectRatio = meta.ratio;
  thumbLabel.style.borderRadius = '8px';

  document.getElementById('bannerModalLabel').value = item?.label || '';
  document.getElementById('bannerModalLink').value = item?.link_url || '';
  document.getElementById('bannerModalVisible').checked = item ? !!item.visible : true;

  const preview = document.getElementById('bannerModalPreview');
  const previewEmpty = document.getElementById('bannerModalPreviewEmpty');
  if (item) {
    preview.src = item.image_url;
    preview.classList.add('on');
    previewEmpty.classList.add('off');
  } else {
    preview.src = '';
    preview.classList.remove('on');
    previewEmpty.classList.remove('off');
  }
  document.getElementById('bannerModalFile').value = '';
  document.getElementById('bannerModalSaveBtn').textContent = item ? '저장' : '추가';
  setStatus(document.getElementById('bannerModalStatus'), '');
  document.getElementById('bannerModalOverlay').classList.add('open');
}

function closeBannerModal() {
  document.getElementById('bannerModalOverlay').classList.remove('open');
}

function initBannerModal() {
  document.getElementById('bannerModalCloseBtn').addEventListener('click', closeBannerModal);
  document.getElementById('bannerModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'bannerModalOverlay') closeBannerModal();
  });

  document.getElementById('bannerModalFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('bannerModalStatus');
    setStatus(status, '이미지 업로드 중...');
    try {
      const { url } = await uploadImage(file, 'content-banner', modalState.type);
      modalState.imageUrl = url;
      const preview = document.getElementById('bannerModalPreview');
      preview.src = url;
      preview.classList.add('on');
      document.getElementById('bannerModalPreviewEmpty').classList.add('off');
      setStatus(status, '이미지가 준비되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('bannerModalMobileFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('bannerModalStatus');
    setStatus(status, '모바일 이미지 업로드 중...');
    try {
      const { url } = await uploadImage(file, 'content-banner', `${modalState.type}-mobile`);
      modalState.mobileImageUrl = url;
      renderBannerMobilePreview();
      setStatus(status, '모바일 이미지가 준비되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('bannerModalMobileClearBtn').addEventListener('click', () => {
    modalState.mobileImageUrl = '';
    renderBannerMobilePreview();
    setStatus(document.getElementById('bannerModalStatus'), '모바일에서는 위 이미지를 확대 크롭해서 노출합니다.');
  });

  document.getElementById('bannerModalSaveBtn').addEventListener('click', async () => {
    const status = document.getElementById('bannerModalStatus');
    const type = modalState.type;
    const meta = BANNER_TYPE_META[type];
    const body = {
      banner_type: type,
      label: document.getElementById('bannerModalLabel').value.trim(),
      image_url: modalState.imageUrl,
      link_url: document.getElementById('bannerModalLink').value.trim(),
      visible: document.getElementById('bannerModalVisible').checked
    };
    if (meta.mobileImage) {
      body.mobile_image_url = modalState.mobileImageUrl || null;
      body.mobile_focus = document.getElementById('bannerModalMobileFocus').value;
    }
    if (!body.image_url) { setStatus(status, '이미지를 업로드해주세요.', 'error'); return; }
    if (meta.labelRequired && !body.label) { setStatus(status, '라벨을 입력해주세요.', 'error'); return; }
    try {
      if (modalState.currentId) {
        await apiFetch(`/admin/api/content-banners/${modalState.currentId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        const existingCount = allBanners.filter(b => b.banner_type === type).length;
        await apiFetch('/admin/api/content-banners', {
          method: 'POST', body: JSON.stringify({ ...body, sort_order: existingCount })
        });
      }
      await loadAllBanners();
      closeBannerModal();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

function initBannerType(type) {
  document.querySelector(`[data-banner-add="${type}"]`).addEventListener('click', () => openBannerModal(type, null));

  document.getElementById(`banner-${type}-list`).addEventListener('click', async (e) => {
    const status = document.getElementById(`banner-${type}-list-status`);
    const editId = e.target.dataset.editId;
    const removeId = e.target.dataset.removeId;
    const toggleId = e.target.dataset.toggleVisible;
    const items = allBanners.filter(b => b.banner_type === type);

    if (editId) {
      const item = items.find(b => String(b.id) === editId);
      if (item) openBannerModal(type, item);
      return;
    }

    if (toggleId) {
      const item = items.find(b => String(b.id) === toggleId);
      if (!item) return;
      try {
        await apiFetch(`/admin/api/content-banners/${toggleId}`, {
          method: 'PUT', body: JSON.stringify({ visible: !item.visible })
        });
        await loadAllBanners();
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
      return;
    }

    if (removeId) {
      if (!confirm('이 배너를 삭제할까요?')) return;
      try {
        await apiFetch(`/admin/api/content-banners/${removeId}`, { method: 'DELETE' });
        await loadAllBanners();
        setStatus(status, '삭제되었습니다.', 'ok');
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initBannerModal();
  BANNER_TYPES.forEach(initBannerType);
  await loadAllBanners();
});
