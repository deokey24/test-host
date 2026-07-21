// ── 영상 업로드 (대용량 멀티파트 → R2 직접 업로드 → 압축 대기열 발행) ──
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

async function loadVideos() {
  const videos = await apiFetch('/admin/api/videos');
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
      <td>${v.status === 'done' && v.final_url ? `<button class="row-btn" data-copy-url="${escapeHtml(v.final_url)}" type="button">복사</button>` : ''}<button class="row-btn danger" data-delete-video="${v.id}" type="button"
        ${v.status === 'processing' ? 'disabled title="인코딩이 진행 중인 영상은 삭제할 수 없습니다"' : ''}>삭제</button></td>
    </tr>
  `).join('');
}

document.getElementById('videoList').addEventListener('click', async (e) => {
  const copyUrl = e.target.dataset.copyUrl;
  if (copyUrl) {
    try {
      await navigator.clipboard.writeText(copyUrl);
      const prevLabel = e.target.textContent;
      e.target.textContent = '복사됨';
      setTimeout(() => { e.target.textContent = prevLabel; }, 1200);
    } catch (err) {
      alert('복사에 실패했습니다. 링크: ' + copyUrl);
    }
    return;
  }

  const deleteId = e.target.dataset.deleteVideo;
  if (!deleteId) return;
  const video = videoCache.find(v => String(v.id) === deleteId);
  if (!video || !confirm(`"${video.title}" 영상을 삭제할까요?\nR2에 저장된 원본과 압축본도 함께 삭제되며 되돌릴 수 없습니다.`)) return;
  try {
    await apiFetch(`/admin/api/videos/${deleteId}`, { method: 'DELETE' });
    await loadVideos();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('videoUploadBtn').addEventListener('click', async () => {
  const title = document.getElementById('videoTitleInput').value.trim();
  const fileInput = document.getElementById('videoFileInput');
  const file = fileInput.files[0];
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
      body: JSON.stringify({ title, fileSize: file.size })
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
    await loadVideos();
  } catch (err) {
    setStatus(statusText, `오류: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    progress.style.display = 'none';
    progressBar.style.width = '0%';
  }
});

document.addEventListener('DOMContentLoaded', () => {
  loadVideos();
  setInterval(loadVideos, 10000);
});
