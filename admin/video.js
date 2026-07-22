// ── 영상 업로드 (대용량 멀티파트 → R2 직접 업로드 → 압축 대기열 발행) ──
// 폴더는 FTP 스타일 다중 계층(video_folders, 자기참조 parent_id)으로 구성되고,
// 현재 보고 있는 폴더(currentFolderId)를 기준으로 하위 폴더/영상만 조회한다.
const VIDEO_PART_CONCURRENCY = 4;
const VIDEO_PART_TIMEOUT_MS = 120000;
const VIDEO_PART_MAX_RETRIES = 3;

const VIDEO_STATUS_LABELS = {
  uploading: '업로드 중',
  queued: '압축 대기 중',
  processing: '압축 중',
  done: '완료',
  failed: '실패'
};

let videoCache = [];
let foldersCache = [];
let currentFolderId = null;
let moveContext = null; // { type: 'video' | 'folder', id }

function idEq(a, b) {
  const an = a === null || a === undefined || a === '' ? null : String(a);
  const bn = b === null || b === undefined || b === '' ? null : String(b);
  return an === bn;
}

async function uploadVideoPart(url, blob, partNumber, onProgress) {
  let lastErr;
  for (let attempt = 1; attempt <= VIDEO_PART_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_PART_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'PUT', body: blob, signal: controller.signal });
      if (!res.ok) throw new Error(`파트 ${partNumber} 업로드 실패 (HTTP ${res.status})`);
      onProgress(blob.size);
      return { PartNumber: partNumber, ETag: res.headers.get('ETag') };
    } catch (err) {
      lastErr = err.name === 'AbortError'
        ? new Error(`파트 ${partNumber} 응답 없음 (${VIDEO_PART_TIMEOUT_MS / 1000}초 초과)`)
        : err;
      if (attempt < VIDEO_PART_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function uploadVideoPartsInParallel(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    const i = cursor++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: concurrency }, runNext));
  return results;
}

// ── 폴더 트리 헬퍼 ──

function folderChildren(parentId) {
  return foldersCache
    .filter(f => idEq(f.parent_id, parentId))
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}

// excludeId(및 그 하위 전체)를 제외한 폴더 옵션 목록을 depth 들여쓰기로 생성
function buildFolderOptions(excludeId) {
  const excluded = new Set();
  function markExcluded(id) {
    excluded.add(String(id));
    folderChildren(id).forEach(f => markExcluded(f.id));
  }
  if (excludeId != null) markExcluded(excludeId);

  const options = [{ id: '', label: '(루트)' }];
  function walk(parentId, depth) {
    folderChildren(parentId)
      .filter(f => !excluded.has(String(f.id)))
      .forEach(f => {
        options.push({ id: f.id, label: '　'.repeat(depth) + f.name });
        walk(f.id, depth + 1);
      });
  }
  walk(null, 0);
  return options;
}

function renderFolderSelectEl(selectEl, { excludeId, selected } = {}) {
  const options = buildFolderOptions(excludeId);
  selectEl.innerHTML = options.map(o => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join('');
  selectEl.value = selected ?? '';
}

function renderBreadcrumb() {
  const path = [];
  let cursor = currentFolderId;
  while (cursor != null) {
    const folder = foldersCache.find(f => idEq(f.id, cursor));
    if (!folder) break;
    path.unshift(folder);
    cursor = folder.parent_id;
  }
  const parts = [`<button type="button" class="video-breadcrumb-item" data-crumb="">홈</button>`];
  path.forEach((f, i) => {
    parts.push(`<span class="video-breadcrumb-sep">/</span>`);
    parts.push(i === path.length - 1
      ? `<span class="video-breadcrumb-current">${escapeHtml(f.name)}</span>`
      : `<button type="button" class="video-breadcrumb-item" data-crumb="${f.id}">${escapeHtml(f.name)}</button>`);
  });
  document.getElementById('videoBreadcrumb').innerHTML = parts.join('');
}

function renderFolderList() {
  const children = folderChildren(currentFolderId);
  const listEl = document.getElementById('videoFolderList');
  if (children.length === 0) {
    listEl.innerHTML = '<li class="video-folder-empty">하위 폴더가 없습니다.</li>';
    return;
  }
  listEl.innerHTML = children.map(f => `
    <li class="video-folder-row" data-id="${f.id}">
      <button type="button" class="video-folder-open" data-open-folder="${f.id}">
        📁 ${escapeHtml(f.name)}
        <span class="field-hint">(하위 ${f.folder_count} · 영상 ${f.video_count})</span>
      </button>
      <div class="video-folder-actions">
        <button class="row-btn" data-rename-folder="${f.id}" type="button">이름변경</button>
        <button class="row-btn" data-move-folder="${f.id}" type="button">이동</button>
        <button class="row-btn danger" data-delete-folder="${f.id}" type="button">삭제</button>
      </div>
    </li>
  `).join('');
}

async function navigateToFolder(folderId) {
  currentFolderId = folderId || null;
  renderBreadcrumb();
  renderFolderList();
  renderFolderSelectEl(document.getElementById('videoFolderSelect'), { selected: currentFolderId ?? '' });
  await loadVideos();
}

async function loadFolders() {
  foldersCache = await apiFetch('/admin/api/video-folders');
  renderBreadcrumb();
  renderFolderList();
  renderFolderSelectEl(document.getElementById('videoFolderSelect'), { selected: currentFolderId ?? '' });
}

// ── 영상 목록 (현재 폴더 기준) ──

async function loadVideos() {
  const qs = currentFolderId ? `?folderId=${encodeURIComponent(currentFolderId)}` : '';
  const videos = await apiFetch(`/admin/api/videos${qs}`);
  videoCache = videos;
  document.getElementById('videoTotal').textContent = videos.length;
  document.getElementById('videoList').innerHTML = videos.map(v => `
    <tr>
      <td>${escapeHtml(v.title)}</td>
      <td><span class="badge badge-${v.status}"${v.status === 'failed' && v.error_message ? ` title="${escapeHtml(v.error_message)}"` : ''}>${VIDEO_STATUS_LABELS[v.status] || v.status}</span></td>
      <td>${new Date(v.created_at).toLocaleString('ko-KR')}</td>
      <td>${v.status === 'done' && v.final_url
        ? `<a href="${escapeHtml(v.final_url)}" target="_blank" rel="noopener" style="word-break:break-all; font-size:12px;">${escapeHtml(v.final_url)}</a>`
        : '<span class="field-hint">-</span>'}</td>
      <td>${v.status === 'done' && v.final_url ? `<button class="row-btn" data-copy-url="${escapeHtml(v.final_url)}" type="button">복사</button>` : ''}<button class="row-btn" data-move-video="${v.id}" type="button">이동</button><button class="row-btn danger" data-delete-video="${v.id}" type="button"
        ${v.status === 'processing' ? 'disabled title="인코딩이 진행 중인 영상은 삭제할 수 없습니다"' : ''}>삭제</button></td>
    </tr>
  `).join('');
}

document.getElementById('videoBreadcrumb').addEventListener('click', async (e) => {
  const crumbBtn = e.target.closest('[data-crumb]');
  if (!crumbBtn) return;
  await navigateToFolder(crumbBtn.dataset.crumb || null);
});

document.getElementById('videoFolderList').addEventListener('click', async (e) => {
  const openBtn = e.target.closest('[data-open-folder]');
  if (openBtn) {
    await navigateToFolder(openBtn.dataset.openFolder);
    return;
  }

  const renameBtn = e.target.closest('[data-rename-folder]');
  if (renameBtn) {
    const renameId = renameBtn.dataset.renameFolder;
    const folder = foldersCache.find(f => idEq(f.id, renameId));
    const name = window.prompt('새 폴더 이름', folder ? folder.name : '');
    if (!name || !name.trim()) return;
    try {
      await apiFetch(`/admin/api/video-folders/${renameId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: name.trim() })
      });
      await loadFolders();
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  const moveBtn = e.target.closest('[data-move-folder]');
  if (moveBtn) {
    openMoveModal('folder', moveBtn.dataset.moveFolder);
    return;
  }

  const deleteBtn = e.target.closest('[data-delete-folder]');
  if (deleteBtn) {
    const deleteId = deleteBtn.dataset.deleteFolder;
    if (!confirm('이 폴더를 삭제할까요?')) return;
    try {
      await apiFetch(`/admin/api/video-folders/${deleteId}`, { method: 'DELETE' });
      await loadFolders();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('videoFolderAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('videoFolderNewInput');
  const status = document.getElementById('videoFolderStatus');
  const name = input.value.trim();
  if (!name) {
    setStatus(status, '폴더 이름을 입력해주세요.', 'error');
    return;
  }
  try {
    await apiFetch('/admin/api/video-folders', {
      method: 'POST',
      body: JSON.stringify({ name, parent_id: currentFolderId })
    });
    input.value = '';
    setStatus(status, '폴더를 추가했습니다.', 'ok');
    await loadFolders();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('videoFolderNewInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('videoFolderAddBtn').click(); }
});

// ── 이동 모달 (영상/폴더 공용) ──

function openMoveModal(type, id) {
  moveContext = { type, id };
  document.getElementById('videoMoveModalTitle').textContent = type === 'folder' ? '폴더 이동' : '영상 이동';
  const selectEl = document.getElementById('videoMoveFolderSelect');
  renderFolderSelectEl(selectEl, {
    excludeId: type === 'folder' ? id : undefined,
    selected: type === 'folder'
      ? (foldersCache.find(f => idEq(f.id, id))?.parent_id ?? '')
      : (videoCache.find(v => idEq(v.id, id))?.folder_id ?? '')
  });
  setStatus(document.getElementById('videoMoveStatus'), '', null);
  document.getElementById('videoMoveModalOverlay').classList.add('open');
}

function closeMoveModal() {
  moveContext = null;
  document.getElementById('videoMoveModalOverlay').classList.remove('open');
}

document.getElementById('videoMoveModalCloseBtn').addEventListener('click', closeMoveModal);

document.getElementById('videoMoveConfirmBtn').addEventListener('click', async () => {
  if (!moveContext) return;
  const status = document.getElementById('videoMoveStatus');
  const targetFolderId = document.getElementById('videoMoveFolderSelect').value || null;
  try {
    if (moveContext.type === 'folder') {
      await apiFetch(`/admin/api/video-folders/${moveContext.id}`, {
        method: 'PUT',
        body: JSON.stringify({ parent_id: targetFolderId })
      });
      await loadFolders();
    } else {
      await apiFetch(`/admin/api/videos/${moveContext.id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ folderId: targetFolderId })
      });
      await loadFolders();
      await loadVideos();
    }
    closeMoveModal();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('videoList').addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy-url]');
  if (copyBtn) {
    const copyUrl = copyBtn.dataset.copyUrl;
    try {
      await navigator.clipboard.writeText(copyUrl);
      const prevLabel = copyBtn.textContent;
      copyBtn.textContent = '복사됨';
      setTimeout(() => { copyBtn.textContent = prevLabel; }, 1200);
    } catch (err) {
      alert('복사에 실패했습니다. 링크: ' + copyUrl);
    }
    return;
  }

  const moveBtn = e.target.closest('[data-move-video]');
  if (moveBtn) {
    openMoveModal('video', moveBtn.dataset.moveVideo);
    return;
  }

  const deleteBtn = e.target.closest('[data-delete-video]');
  if (!deleteBtn) return;
  const deleteId = deleteBtn.dataset.deleteVideo;
  const video = videoCache.find(v => String(v.id) === deleteId);
  if (!video || !confirm(`"${video.title}" 영상을 삭제할까요?\nR2에 저장된 원본과 압축본도 함께 삭제되며 되돌릴 수 없습니다.`)) return;
  try {
    await apiFetch(`/admin/api/videos/${deleteId}`, { method: 'DELETE' });
    await loadFolders();
    await loadVideos();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('videoUploadBtn').addEventListener('click', async () => {
  const title = document.getElementById('videoTitleInput').value.trim();
  const fileInput = document.getElementById('videoFileInput');
  const file = fileInput.files[0];
  const folderId = document.getElementById('videoFolderSelect').value || null;
  const btn = document.getElementById('videoUploadBtn');
  const progress = document.getElementById('videoProgress');
  const progressBar = document.getElementById('videoProgressBar');
  const statusText = document.getElementById('videoStatusText');

  if (!title || !file) {
    setStatus(statusText, '제목과 파일을 모두 선택해주세요.', 'error');
    return;
  }

  btn.disabled = true;
  progress.style.display = 'block';
  setStatus(statusText, '업로드 준비 중...');

  try {
    const { videoId, partSize, urls } = await apiFetch('/admin/api/videos/presign', {
      method: 'POST',
      body: JSON.stringify({ title, fileSize: file.size, folderId })
    });

    let uploadedBytes = 0;
    const onProgress = (bytes) => {
      uploadedBytes += bytes;
      progressBar.style.width = `${Math.min(100, (uploadedBytes / file.size) * 100)}%`;
      setStatus(statusText, `업로드 중... ${(uploadedBytes / 1e9).toFixed(2)}GB / ${(file.size / 1e9).toFixed(2)}GB`);
    };

    const parts = await uploadVideoPartsInParallel(urls, async ({ partNumber, url }) => {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(partNumber * partSize, file.size);
      const blob = file.slice(start, end);
      return uploadVideoPart(url, blob, partNumber, onProgress);
    }, VIDEO_PART_CONCURRENCY);

    setStatus(statusText, '업로드 완료 처리 중...');
    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    await apiFetch(`/admin/api/videos/${videoId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts })
    });

    setStatus(statusText, '압축 대기열에 등록되었습니다.', 'ok');
    document.getElementById('videoTitleInput').value = '';
    fileInput.value = '';
    await loadFolders();
    await loadVideos();
  } catch (err) {
    setStatus(statusText, `오류: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    progress.style.display = 'none';
    progressBar.style.width = '0%';
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadFolders();
  await loadVideos();
  setInterval(loadVideos, 10000);
});
