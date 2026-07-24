// ── 타이틀 ──
async function initReviewsHero() {
  const data = await loadHomeSectionDataFor('reviews', 'hero');
  document.getElementById('reviews-hero-title').value = data.title || '';
  document.getElementById('reviews-hero-body').value = data.body || '';
  document.getElementById('reviews-hero-save').addEventListener('click', async () => {
    const status = document.getElementById('reviews-hero-status');
    try {
      await apiFetch('/admin/api/site/reviews/hero', {
        method: 'PUT',
        body: JSON.stringify({
          title: document.getElementById('reviews-hero-title').value.trim(),
          body: document.getElementById('reviews-hero-body').value.trim()
        })
      });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 수강후기 항목 관리 ──
function reviewRowHtml(item) {
  return `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <div class="field-row">
          <label class="field-label">작성자</label>
          <input type="text" class="review-name-input" value="${escapeHtml(item.student_name)}">
        </div>
        <div class="field-row">
          <label class="field-label">작성일</label>
          <input type="date" class="review-date-input" value="${escapeHtml(String(item.review_date).slice(0, 10))}">
        </div>
        <div class="field-row">
          <label class="field-label">강의명</label>
          <input type="text" class="review-course-input" value="${escapeHtml(item.course_name)}">
        </div>
        <div class="field-row">
          <label class="field-label">평점</label>
          <input type="number" class="review-rating-input" min="1" max="5" step="0.5" value="${escapeHtml(item.rating)}">
        </div>
        <div class="field-row">
          <label class="field-label">후기 내용</label>
          <textarea class="review-text-input" rows="3">${escapeHtml(item.review_text)}</textarea>
        </div>
      </div>
      <button type="button" class="row-btn danger drag-item-remove" data-remove-review="${item.id}">삭제</button>
    </li>
  `;
}

async function loadReviews() {
  const rows = await apiFetch('/admin/api/reviews');
  const listEl = document.getElementById('review-item-list');
  listEl.innerHTML = rows.map(reviewRowHtml).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/reviews/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
  });
}

function openReviewModal() {
  document.getElementById('rfName').value = '';
  document.getElementById('rfDate').value = '';
  document.getElementById('rfCourse').value = '';
  document.getElementById('rfRating').value = '5';
  document.getElementById('rfText').value = '';
  setStatus(document.getElementById('reviewModalStatus'), '');
  document.getElementById('reviewModalOverlay').classList.add('open');
  document.getElementById('rfName').focus();
}

function closeReviewModal() {
  document.getElementById('reviewModalOverlay').classList.remove('open');
}

function initReviewItems() {
  const listEl = document.getElementById('review-item-list');
  const status = document.getElementById('review-item-status');

  document.getElementById('review-item-add').addEventListener('click', openReviewModal);
  document.getElementById('reviewModalCloseBtn').addEventListener('click', closeReviewModal);
  document.getElementById('reviewModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'reviewModalOverlay') closeReviewModal();
  });

  document.getElementById('reviewModalSaveBtn').addEventListener('click', async () => {
    const modalStatus = document.getElementById('reviewModalStatus');
    const student_name = document.getElementById('rfName').value.trim();
    const review_date = document.getElementById('rfDate').value;
    const course_name = document.getElementById('rfCourse').value.trim();
    const rating = document.getElementById('rfRating').value;
    const review_text = document.getElementById('rfText').value.trim();
    if (!student_name || !review_date || !course_name || !review_text) {
      setStatus(modalStatus, '작성자, 작성일, 강의명, 후기 내용을 모두 입력해주세요.', 'error');
      return;
    }
    try {
      await apiFetch('/admin/api/reviews', {
        method: 'POST',
        body: JSON.stringify({ student_name, review_date, course_name, rating, review_text, sort_order: listEl.children.length })
      });
      await loadReviews();
      closeReviewModal();
    } catch (err) {
      setStatus(modalStatus, err.message, 'error');
    }
  });

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.removeReview;
    if (!id) return;
    if (!confirm('이 후기를 삭제할까요?')) return;
    try {
      await apiFetch(`/admin/api/reviews/${id}`, { method: 'DELETE' });
      await loadReviews();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  listEl.addEventListener('change', async (e) => {
    const row = e.target.closest('.drag-item');
    if (!row) return;
    const id = row.dataset.id;
    const payload = {};
    if (e.target.classList.contains('review-name-input')) payload.student_name = e.target.value.trim();
    if (e.target.classList.contains('review-date-input')) payload.review_date = e.target.value;
    if (e.target.classList.contains('review-course-input')) payload.course_name = e.target.value.trim();
    if (e.target.classList.contains('review-rating-input')) payload.rating = e.target.value;
    if (e.target.classList.contains('review-text-input')) payload.review_text = e.target.value.trim();
    if (Object.keys(payload).length === 0) return;
    try {
      await apiFetch(`/admin/api/reviews/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initReviewsHero();
  initReviewItems();
  loadReviews();
});
