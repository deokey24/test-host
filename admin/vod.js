// ── VOD 카테고리 (기본 접힘 — notice_categories와 동일 패턴) ──
let vodCategoriesCache = [];

function vodCatRowHtml(cat) {
  return `
    <li class="drag-item" data-id="${cat.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <input type="text" class="vod-cat-name-input" value="${escapeHtml(cat.name)}">
      </div>
      <button type="button" class="row-btn danger" data-remove-vod-cat="${cat.id}">삭제</button>
    </li>
  `;
}

function renderVodCategoryOptions() {
  [document.getElementById('qaCategoryLabel'), document.getElementById('vfCategoryLabel')].forEach(sel => {
    const current = sel.value;
    sel.innerHTML = '<option value="">없음</option>' +
      vodCategoriesCache.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    if (current && vodCategoriesCache.some(c => c.name === current)) sel.value = current;
  });
}

// ── 강사 선택 (instructors 관리 메뉴에 등록된 강사를 VOD 강좌에 연결) ──
let vodInstructorsCache = [];

async function loadVodInstructorOptions() {
  const sel = document.getElementById('vfInstructor');
  try {
    vodInstructorsCache = await apiFetch('/admin/api/instructors');
    const current = sel.value;
    sel.innerHTML = '<option value="">선택 안 함</option>' +
      vodInstructorsCache.map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
    if (current && vodInstructorsCache.some(i => String(i.id) === current)) sel.value = current;
  } catch {
    sel.innerHTML = '<option value="">선택 안 함</option>';
  }
}

async function loadVodCategories() {
  const rows = await apiFetch('/admin/api/vod-categories');
  vodCategoriesCache = rows;
  const listEl = document.getElementById('vod-cat-list');
  listEl.innerHTML = rows.map(vodCatRowHtml).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/vod-categories/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    vodCategoriesCache = ids.map(id => vodCategoriesCache.find(c => String(c.id) === String(id)));
  });
  renderVodCategoryOptions();
}

function initVodCategoryToggle() {
  const toggleBtn = document.getElementById('vod-cat-toggle');
  const body = document.getElementById('vod-cat-body');
  toggleBtn.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    toggleBtn.textContent = isOpen ? '펼치기' : '접기';
  });
}

function initVodCategories() {
  const listEl = document.getElementById('vod-cat-list');
  const status = document.getElementById('vod-cat-status');
  const newInput = document.getElementById('vod-cat-new');

  document.getElementById('vod-cat-add').addEventListener('click', async () => {
    const name = newInput.value.trim();
    if (!name) return;
    try {
      await apiFetch('/admin/api/vod-categories', {
        method: 'POST', body: JSON.stringify({ name, sort_order: listEl.children.length })
      });
      newInput.value = '';
      await loadVodCategories();
      setStatus(status, '추가되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('vod-cat-add').click(); }
  });

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.removeVodCat;
    if (!id) return;
    if (!confirm('이 카테고리를 삭제할까요?')) return;
    try {
      await apiFetch(`/admin/api/vod-categories/${id}`, { method: 'DELETE' });
      await loadVodCategories();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });

  listEl.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('vod-cat-name-input')) return;
    const row = e.target.closest('.drag-item');
    const id = row.dataset.id;
    try {
      await apiFetch(`/admin/api/vod-categories/${id}`, {
        method: 'PUT', body: JSON.stringify({ name: e.target.value.trim() })
      });
      await loadVodCategories();
      await loadVodCourses();
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// ── VOD 강좌 목록 ──
let vodCache = [];
let currentVodId = null;
let vodLecturesCache = [];
let vodChecklistCache = [];
let vodTagsCache = [];
let vodSectionsCache = [];
let vodPurchaseHighlightCache = [];
let vodThumbnailUrl = '';

async function loadVodCourses() {
  vodCache = await apiFetch('/admin/api/vod-courses');
  document.getElementById('vodTotal').textContent = vodCache.length;
  const listEl = document.getElementById('vodList');
  // 순서 칸은 raw sort_order 대신 화면상 순번(1부터)을 보여준다 — 삭제로 순번에 구멍이 나 있어도
  // 관리자가 보는 숫자와 실제 노출 순서가 어긋나지 않는다.
  listEl.innerHTML = vodCache.map((c, idx) => `
    <tr class="drag-item" data-id="${c.id}">
      <td><span class="drag-cell"><span class="drag-handle">☰</span>${idx + 1}</span></td>
      <td>${escapeHtml(c.title)}</td>
      <td>${escapeHtml(c.category_label || '')}</td>
      <td>${escapeHtml(c.new_price)}</td>
      <td>${c.is_ended
        ? `<span class="badge badge-off">종료됨</span>`
        : `<span class="badge ${c.is_active ? 'badge-on' : 'badge-off'}">${c.is_active ? '노출' : '숨김'}</span>`}</td>
      <td>
        <button class="row-btn" data-edit-vod="${c.id}">수정</button>
        <button class="row-btn danger" data-delete-vod="${c.id}">삭제</button>
      </td>
    </tr>
  `).join('');
  // 하위 항목들처럼 PUT을 항목당 한 번씩 보내지 않고 일괄 라우트를 쓴다 — 강좌 PUT은 전체 필드를 덮어쓰기 때문.
  attachDragReorder(listEl, async (ids) => {
    const status = document.getElementById('vodListStatus');
    try {
      await apiFetch('/admin/api/vod-courses/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
      await loadVodCourses();   // 서버가 확정한 순서로 다시 그려 순번 표시까지 맞춘다
      setStatus(status, '순서가 저장되었습니다.', 'ok');
    } catch (err) {
      await loadVodCourses();   // 실패 시 화면만 바뀐 상태로 두지 않고 저장된 순서로 되돌린다
      setStatus(status, err.message, 'error');
    }
  });
}

// ── 빠른 추가 모달 ──
function openQuickAddModal() {
  document.getElementById('qaTitle').value = '';
  renderVodCategoryOptions();
  document.getElementById('qaCategoryLabel').value = '';
  document.getElementById('qaHasDiscount').checked = false;
  document.getElementById('qaOldPrice').value = '';
  document.getElementById('qaNewPrice').value = '';
  document.getElementById('qaIsActive').checked = true;
  toggleDiscountRow('qaHasDiscount', 'qaOldPriceRow', 'qaNewPriceLabel');
  setStatus(document.getElementById('qaStatus'), '');
  document.getElementById('vodQuickAddModal').classList.add('open');
}
function closeQuickAddModal() { document.getElementById('vodQuickAddModal').classList.remove('open'); }

function toggleDiscountRow(checkboxId, oldPriceRowId, newPriceLabelId) {
  const checked = document.getElementById(checkboxId).checked;
  document.getElementById(oldPriceRowId).style.display = checked ? '' : 'none';
  document.getElementById(newPriceLabelId).textContent = checked ? '할인 후 가격 *' : '가격 *';
}

document.getElementById('vodAddBtn').addEventListener('click', openQuickAddModal);
document.getElementById('vodQuickAddCloseBtn').addEventListener('click', closeQuickAddModal);
document.getElementById('vodQuickAddModal').addEventListener('click', (e) => {
  if (e.target.id === 'vodQuickAddModal') closeQuickAddModal();
});
document.getElementById('qaHasDiscount').addEventListener('change', () => toggleDiscountRow('qaHasDiscount', 'qaOldPriceRow', 'qaNewPriceLabel'));

document.getElementById('qaSaveBtn').addEventListener('click', async () => {
  const status = document.getElementById('qaStatus');
  const title = document.getElementById('qaTitle').value.trim();
  const newPrice = document.getElementById('qaNewPrice').value.trim();
  if (!title || !newPrice) {
    setStatus(status, '강좌명과 가격은 필수입니다.', 'error');
    return;
  }
  const hasDiscount = document.getElementById('qaHasDiscount').checked;
  const body = {
    title,
    category_label: document.getElementById('qaCategoryLabel').value,
    old_price: hasDiscount ? document.getElementById('qaOldPrice').value.trim() : '',
    new_price: newPrice,
    is_active: document.getElementById('qaIsActive').checked
  };
  try {
    const result = await apiFetch('/admin/api/vod-courses', { method: 'POST', body: JSON.stringify(body) });
    closeQuickAddModal();
    await loadVodCourses();
    const course = vodCache.find(c => c.id === result.id) || { id: result.id };
    await openEditModal(course);
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

// ── 전체 수정 모달 ──
function initVodTabs() {
  document.querySelectorAll('#vodTabBtns button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#vodTabBtns button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.vodTab;
      document.getElementById('vodTabTitle').style.display = tab === 'title' ? '' : 'none';
      document.getElementById('vodTabIntro').style.display = tab === 'intro' ? '' : 'none';
      document.getElementById('vodTabCurriculum').style.display = tab === 'curriculum' ? '' : 'none';
      document.getElementById('vodTabPurchase').style.display = tab === 'purchase' ? '' : 'none';
      if (tab === 'intro') ensureIntroEditor();
    });
  });
}

function selectVodTab(tab) {
  document.querySelector(`#vodTabBtns button[data-vod-tab="${tab}"]`).click();
}

function showVodEditPage() {
  document.querySelectorAll('.side-link').forEach(l => l.classList.remove('active'));
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.getElementById('vodEditSection').classList.add('active');
  document.getElementById('sectionTitle').textContent = 'VOD 강좌 수정';
}
function closeVodEditPage() {
  collapseLectureContent();
  document.getElementById('vodEditSection').classList.remove('active');
  document.querySelector('.side-link[data-target="vodSection"]').classList.add('active');
  document.getElementById('vodSection').classList.add('active');
  document.getElementById('sectionTitle').textContent = 'VOD 강좌';
}

function renderVodThumbnailPreview() {
  const picker = document.getElementById('vfThumbnailPicker');
  const img = picker.querySelector('.preview-img');
  const emptyNote = picker.querySelector('.empty-note');
  if (vodThumbnailUrl) {
    img.src = vodThumbnailUrl;
    img.style.display = 'block';
    emptyNote.style.display = 'none';
  } else {
    img.style.display = 'none';
    emptyNote.style.display = 'block';
  }
}

function fillVodForm(course) {
  vodThumbnailUrl = course?.thumbnail_url || '';
  renderVodThumbnailPreview();
  renderVodCategoryOptions();
  document.getElementById('vfCategoryLabel').value = course?.category_label || '';
  document.getElementById('vfTags').value = course?.tags_text || '';
  document.getElementById('vfInstructor').value = course?.instructor_id || '';
  document.getElementById('vfTitle').value = course?.title || '';
  document.getElementById('vfDescription').value = course?.description || '';
  document.getElementById('vfTotalDurationText').value = course?.total_duration_text || '';
  document.getElementById('vfDifficulty').value = course?.difficulty || '';
  document.getElementById('vfDifficultyVisible').checked = course ? !!course.difficulty_visible : true;
  document.getElementById('vfHasFeedback').value = course?.has_feedback || '';
  document.getElementById('vfAccessDays').value = course?.access_days || '';
  // ends_at은 DATE 컬럼이지만 JSON 직렬화 과정에서 ISO 문자열로 오므로 앞 10자리만 잘라 <input type="date">에 넣는다.
  document.getElementById('vfEndsAt').value = course?.ends_at ? String(course.ends_at).slice(0, 10) : '';
  document.getElementById('vfHasDiscount').checked = !!course?.old_price;
  document.getElementById('vfOldPrice').value = course?.old_price || '';
  document.getElementById('vfNewPrice').value = course?.new_price || '';
  document.getElementById('vfIsActive').checked = course ? !!course.is_active : true;
  toggleDiscountRow('vfHasDiscount', 'vfOldPriceRow', 'vfNewPriceLabel');

  document.getElementById('vfIntroHeading').value = course?.intro_heading || '클래스에서 배울 수 있는 내용이에요';
  document.getElementById('vfRecommendedHeading').value = course?.recommended_heading || '이런 분들께 추천해요';
}

// ── 클래스소개 내용: 커리큘럼 스텝 콘텐츠와 동일한 TOAST UI 마크다운 에디터 사용 ──
// "클래스소개" 탭이 열려 있지 않을 때 생성하면(display:none) 에디터 크기가 0으로 잡히므로
// 탭을 처음 클릭하는 시점에 지연 생성한다 (커리큘럼 스텝 콘텐츠 에디터와 동일한 패턴).
let introEditorInstance = null;
let introMarkdownCache = '';

function ensureIntroEditor() {
  if (introEditorInstance) return;
  introEditorInstance = new toastui.Editor({
    el: document.getElementById('vfIntroParagraphMount'),
    height: '260px',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    language: 'ko-KR',
    initialValue: introMarkdownCache
  });
}

function readVodForm() {
  const hasDiscount = document.getElementById('vfHasDiscount').checked;
  return {
    thumbnail_url: vodThumbnailUrl,
    category_label: document.getElementById('vfCategoryLabel').value,
    tags_text: document.getElementById('vfTags').value.trim(),
    title: document.getElementById('vfTitle').value.trim(),
    description: document.getElementById('vfDescription').value.trim(),
    total_duration_text: document.getElementById('vfTotalDurationText').value.trim(),
    difficulty: document.getElementById('vfDifficulty').value.trim(),
    difficulty_visible: document.getElementById('vfDifficultyVisible').checked,
    has_feedback: document.getElementById('vfHasFeedback').value,
    access_days: document.getElementById('vfAccessDays').value.trim(),
    ends_at: document.getElementById('vfEndsAt').value,
    instructor_id: document.getElementById('vfInstructor').value,
    old_price: hasDiscount ? document.getElementById('vfOldPrice').value.trim() : '',
    new_price: document.getElementById('vfNewPrice').value.trim(),
    is_active: document.getElementById('vfIsActive').checked,
    intro_heading: document.getElementById('vfIntroHeading').value.trim(),
    intro_paragraph: (introEditorInstance ? introEditorInstance.getMarkdown() : introMarkdownCache).trim(),
    recommended_heading: document.getElementById('vfRecommendedHeading').value.trim()
  };
}

async function openEditModal(courseStub) {
  currentVodId = courseStub.id;
  document.getElementById('vodFormTitle').textContent = 'VOD 강좌 수정';
  setStatus(document.getElementById('vodFormStatus'), '');
  showVodEditPage();
  selectVodTab('title');
  const course = await apiFetch(`/admin/api/vod-courses/${currentVodId}`);
  fillVodForm(course);
  introMarkdownCache = course?.intro_paragraph || '';
  if (introEditorInstance) introEditorInstance.setMarkdown(introMarkdownCache);
  vodChecklistCache = course.checklistItems || [];
  vodTagsCache = course.tags || [];
  vodSectionsCache = course.sections || [];
  vodPurchaseHighlightCache = course.purchaseHighlights || [];
  renderVodChecklist();
  renderVodTags();
  renderVodSections();
  renderVodPurchaseHighlights();
  await loadVodLectures();
}

document.getElementById('vodList').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editVod;
  const deleteId = e.target.dataset.deleteVod;
  if (editId) {
    const course = vodCache.find(c => String(c.id) === editId);
    if (!course) return;
    await openEditModal(course);
  } else if (deleteId) {
    const course = vodCache.find(c => String(c.id) === deleteId);
    if (!course || !confirm(`"${course.title}"을(를) 삭제할까요? 연결된 강의 목록도 함께 삭제됩니다.`)) return;
    try {
      await apiFetch(`/admin/api/vod-courses/${deleteId}`, { method: 'DELETE' });
      await loadVodCourses();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('vodEditBackBtn').addEventListener('click', closeVodEditPage);
document.getElementById('vfHasDiscount').addEventListener('change', () => toggleDiscountRow('vfHasDiscount', 'vfOldPriceRow', 'vfNewPriceLabel'));

document.querySelector('#vfThumbnailPicker input[type="file"]').addEventListener('change', async (e) => {
  const fileInput = e.target;
  const file = fileInput.files[0];
  if (!file) return;
  const statusEl = document.querySelector('#vfThumbnailPicker .status-text');
  setStatus(statusEl, '업로드 중...');
  try {
    const { url } = await uploadImage(file, 'vod-course', String(currentVodId));
    vodThumbnailUrl = url;
    renderVodThumbnailPreview();
    setStatus(statusEl, '업로드 완료', 'ok');
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  } finally {
    fileInput.value = '';
  }
});

// 타이틀영역/클래스소개 탭 모두 같은 강좌 레코드(vod_courses) 하나를 통째로 저장한다 —
// 어느 탭에서 눌러도 두 탭의 필드가 전부 함께 반영된다.
async function saveVodCourse(statusEl) {
  const body = readVodForm();
  if (!body.title || !body.new_price) {
    setStatus(statusEl, '강좌명과 가격은 필수입니다.', 'error');
    return;
  }
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}`, { method: 'PUT', body: JSON.stringify(body) });
    setStatus(statusEl, '저장되었습니다.', 'ok');
    await loadVodCourses();
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  }
}

document.getElementById('vodSaveBtn').addEventListener('click', () => saveVodCourse(document.getElementById('vodFormStatus')));
document.getElementById('vodIntroSaveBtn').addEventListener('click', () => saveVodCourse(document.getElementById('vodIntroFormStatus')));

// ── 클래스소개: 체크리스트 ──
function renderVodChecklist() {
  const listEl = document.getElementById('vodChecklistList');
  listEl.innerHTML = vodChecklistCache.map(item => `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <input type="text" class="vod-checklist-input" value="${escapeHtml(item.content)}">
      </div>
      <button type="button" class="row-btn danger" data-remove-checklist="${item.id}">삭제</button>
    </li>
  `).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/vod-courses/${currentVodId}/checklist-items/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    vodChecklistCache = ids.map(id => vodChecklistCache.find(c => String(c.id) === String(id)));
  });
}

document.getElementById('vodChecklistAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('vodChecklistNewInput');
  const content = input.value.trim();
  if (!content || !currentVodId) return;
  const status = document.getElementById('vodChecklistStatus');
  try {
    const result = await apiFetch(`/admin/api/vod-courses/${currentVodId}/checklist-items`, {
      method: 'POST', body: JSON.stringify({ content, sort_order: vodChecklistCache.length })
    });
    vodChecklistCache.push({ id: result.id, content, sort_order: vodChecklistCache.length });
    input.value = '';
    renderVodChecklist();
    setStatus(status, '추가되었습니다.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('vodChecklistList').addEventListener('click', async (e) => {
  const id = e.target.dataset.removeChecklist;
  if (!id) return;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/checklist-items/${id}`, { method: 'DELETE' });
    vodChecklistCache = vodChecklistCache.filter(c => String(c.id) !== id);
    renderVodChecklist();
  } catch (err) {
    setStatus(document.getElementById('vodChecklistStatus'), err.message, 'error');
  }
});

document.getElementById('vodChecklistList').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('vod-checklist-input')) return;
  const id = e.target.closest('.drag-item').dataset.id;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/checklist-items/${id}`, {
      method: 'PUT', body: JSON.stringify({ content: e.target.value.trim() })
    });
    setStatus(document.getElementById('vodChecklistStatus'), '저장되었습니다.', 'ok');
  } catch (err) {
    setStatus(document.getElementById('vodChecklistStatus'), err.message, 'error');
  }
});

// ── 커리큘럼 탭: 결제창에 간단한 혜택/구성 안내 (vodDetail.html 결제카드 .pc-list) ──
function renderVodPurchaseHighlights() {
  const listEl = document.getElementById('vodPurchaseHighlightList');
  listEl.innerHTML = vodPurchaseHighlightCache.map(item => `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <input type="text" class="vod-purchase-highlight-input" value="${escapeHtml(item.content)}">
      </div>
      <button type="button" class="row-btn danger" data-remove-purchase-highlight="${item.id}">삭제</button>
    </li>
  `).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/vod-courses/${currentVodId}/purchase-highlights/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    vodPurchaseHighlightCache = ids.map(id => vodPurchaseHighlightCache.find(c => String(c.id) === String(id)));
  });
}

document.getElementById('vodPurchaseHighlightAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('vodPurchaseHighlightNewInput');
  const content = input.value.trim();
  if (!content || !currentVodId) return;
  const status = document.getElementById('vodPurchaseHighlightStatus');
  try {
    const result = await apiFetch(`/admin/api/vod-courses/${currentVodId}/purchase-highlights`, {
      method: 'POST', body: JSON.stringify({ content, sort_order: vodPurchaseHighlightCache.length })
    });
    vodPurchaseHighlightCache.push({ id: result.id, content, sort_order: vodPurchaseHighlightCache.length });
    input.value = '';
    renderVodPurchaseHighlights();
    setStatus(status, '추가되었습니다.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('vodPurchaseHighlightList').addEventListener('click', async (e) => {
  const id = e.target.dataset.removePurchaseHighlight;
  if (!id) return;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/purchase-highlights/${id}`, { method: 'DELETE' });
    vodPurchaseHighlightCache = vodPurchaseHighlightCache.filter(c => String(c.id) !== id);
    renderVodPurchaseHighlights();
  } catch (err) {
    setStatus(document.getElementById('vodPurchaseHighlightStatus'), err.message, 'error');
  }
});

document.getElementById('vodPurchaseHighlightList').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('vod-purchase-highlight-input')) return;
  const id = e.target.closest('.drag-item').dataset.id;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/purchase-highlights/${id}`, {
      method: 'PUT', body: JSON.stringify({ content: e.target.value.trim() })
    });
    setStatus(document.getElementById('vodPurchaseHighlightStatus'), '저장되었습니다.', 'ok');
  } catch (err) {
    setStatus(document.getElementById('vodPurchaseHighlightStatus'), err.message, 'error');
  }
});

// ── 클래스소개: 추천 태그 ──
function renderVodTags() {
  const listEl = document.getElementById('vodTagList');
  listEl.innerHTML = vodTagsCache.map(item => `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <input type="text" class="vod-tag-input" value="${escapeHtml(item.label)}">
      </div>
      <button type="button" class="row-btn danger" data-remove-tag="${item.id}">삭제</button>
    </li>
  `).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/vod-courses/${currentVodId}/tags/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    vodTagsCache = ids.map(id => vodTagsCache.find(c => String(c.id) === String(id)));
  });
}

document.getElementById('vodTagAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('vodTagNewInput');
  const label = input.value.trim();
  if (!label || !currentVodId) return;
  const status = document.getElementById('vodTagStatus');
  try {
    const result = await apiFetch(`/admin/api/vod-courses/${currentVodId}/tags`, {
      method: 'POST', body: JSON.stringify({ label, sort_order: vodTagsCache.length })
    });
    vodTagsCache.push({ id: result.id, label, sort_order: vodTagsCache.length });
    input.value = '';
    renderVodTags();
    setStatus(status, '추가되었습니다.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('vodTagList').addEventListener('click', async (e) => {
  const id = e.target.dataset.removeTag;
  if (!id) return;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/tags/${id}`, { method: 'DELETE' });
    vodTagsCache = vodTagsCache.filter(c => String(c.id) !== id);
    renderVodTags();
  } catch (err) {
    setStatus(document.getElementById('vodTagStatus'), err.message, 'error');
  }
});

document.getElementById('vodTagList').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('vod-tag-input')) return;
  const id = e.target.closest('.drag-item').dataset.id;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/tags/${id}`, {
      method: 'PUT', body: JSON.stringify({ label: e.target.value.trim() })
    });
    setStatus(document.getElementById('vodTagStatus'), '저장되었습니다.', 'ok');
  } catch (err) {
    setStatus(document.getElementById('vodTagStatus'), err.message, 'error');
  }
});

// ── 클래스소개: 추가 섹션 (제목+내용) ──
function renderVodSections() {
  const listEl = document.getElementById('vodSectionList');
  listEl.innerHTML = vodSectionsCache.map(item => `
    <li class="drag-item" data-id="${item.id}">
      <span class="drag-handle">☰</span>
      <div class="drag-item-body">
        <input type="text" class="vod-section-heading-input" value="${escapeHtml(item.heading)}" placeholder="섹션 제목">
        <textarea class="vod-section-content-input" rows="2" placeholder="섹션 내용">${escapeHtml(item.content)}</textarea>
      </div>
      <button type="button" class="row-btn danger" data-remove-section="${item.id}">삭제</button>
    </li>
  `).join('');
  attachDragReorder(listEl, async (ids) => {
    await Promise.all(ids.map((id, idx) => apiFetch(`/admin/api/vod-courses/${currentVodId}/sections/${id}`, {
      method: 'PUT', body: JSON.stringify({ sort_order: idx })
    })));
    vodSectionsCache = ids.map(id => vodSectionsCache.find(c => String(c.id) === String(id)));
  });
}

document.getElementById('vodSectionAddBtn').addEventListener('click', async () => {
  if (!currentVodId) return;
  const status = document.getElementById('vodSectionStatus');
  try {
    const heading = '새 섹션';
    const content = '';
    const result = await apiFetch(`/admin/api/vod-courses/${currentVodId}/sections`, {
      method: 'POST', body: JSON.stringify({ heading, content: '내용을 입력하세요', sort_order: vodSectionsCache.length })
    });
    vodSectionsCache.push({ id: result.id, heading, content: '내용을 입력하세요', sort_order: vodSectionsCache.length });
    renderVodSections();
    setStatus(status, '섹션이 추가되었습니다. 제목/내용을 입력해주세요.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('vodSectionList').addEventListener('click', async (e) => {
  const id = e.target.dataset.removeSection;
  if (!id) return;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/sections/${id}`, { method: 'DELETE' });
    vodSectionsCache = vodSectionsCache.filter(c => String(c.id) !== id);
    renderVodSections();
  } catch (err) {
    setStatus(document.getElementById('vodSectionStatus'), err.message, 'error');
  }
});

document.getElementById('vodSectionList').addEventListener('change', async (e) => {
  const isHeading = e.target.classList.contains('vod-section-heading-input');
  const isContent = e.target.classList.contains('vod-section-content-input');
  if (!isHeading && !isContent) return;
  const id = e.target.closest('.drag-item').dataset.id;
  const body = isHeading ? { heading: e.target.value.trim() } : { content: e.target.value.trim() };
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/sections/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    setStatus(document.getElementById('vodSectionStatus'), '저장되었습니다.', 'ok');
  } catch (err) {
    setStatus(document.getElementById('vodSectionStatus'), err.message, 'error');
  }
});

// ── 커리큘럼 스텝 / 영상 연결 / 자료 첨부 ──
let vodMaterialsCache = [];

function lectureMaterialsFor(lectureId) {
  return vodMaterialsCache.filter(m => String(m.vod_course_lecture_id) === String(lectureId));
}

function formatLectureDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function lectureRowHtml(l) {
  const materials = lectureMaterialsFor(l.id);
  const hasContent = !!(l.content_markdown && l.content_markdown.trim());
  const durationText = formatLectureDuration(l.duration_seconds);
  return `
    <tr>
      <td>${l.lecture_number}</td>
      <td><input type="text" data-lec-title="${l.id}" value="${escapeHtml(l.title)}" style="margin-bottom:0;"></td>
      <td>
        <div class="searchable-select" data-video-select="${l.id}">
          <input type="text" class="ss-input" autocomplete="off">
          <div class="ss-dropdown"></div>
        </div>
        ${durationText ? `<span class="status-text" style="margin-top:4px;">재생시간 ${durationText}</span>` : ''}
      </td>
      <td>
        <div class="material-chip-list" data-material-list="${l.id}">
          ${materials.map(m => `<span class="material-chip">${escapeHtml(m.title)}<button type="button" data-remove-material="${m.id}" title="삭제">×</button></span>`).join('')}
        </div>
        <div class="material-add-row">
          <input type="file" data-material-input="${l.id}">
          <button type="button" class="row-btn" data-material-add="${l.id}">자료 추가</button>
        </div>
      </td>
      <td>
        <button type="button" class="row-btn${hasContent ? ' has-content' : ''}" data-content-toggle="${l.id}">내용</button>
        <button class="row-btn danger" data-unlink-lec="${l.id}">삭제</button>
      </td>
    </tr>
    <tr class="lecture-content-row" data-content-row="${l.id}" style="display:none;">
      <td colspan="5">
        <div class="lecture-content-editor">
          <div id="lectureContentMount-${l.id}"></div>
          <div style="display:flex; align-items:center; gap:8px; margin-top:10px;">
            <button type="button" class="btn-outline" data-content-save="${l.id}">콘텐츠 저장</button>
            <span class="status-text" data-content-status="${l.id}" style="margin:0;"></span>
          </div>
        </div>
      </td>
    </tr>
  `;
}

// ── 커리큘럼 스텝별 콘텐츠 에디터 (기본 접힘, 한 번에 하나만 펼쳐서 스크롤을 최소화) ──
let activeContentLectureId = null;
let contentEditorInstance = null;

function collapseLectureContent() {
  if (activeContentLectureId == null) return;
  const row = document.querySelector(`[data-content-row="${activeContentLectureId}"]`);
  if (row) row.style.display = 'none';
  const toggleBtn = document.querySelector(`[data-content-toggle="${activeContentLectureId}"]`);
  if (toggleBtn) toggleBtn.classList.remove('active');
  if (contentEditorInstance) {
    contentEditorInstance.destroy();
    contentEditorInstance = null;
  }
  activeContentLectureId = null;
}

function expandLectureContent(lectureId) {
  const lecture = vodLecturesCache.find(l => String(l.id) === String(lectureId));
  if (!lecture) return;
  collapseLectureContent();
  const row = document.querySelector(`[data-content-row="${lectureId}"]`);
  const toggleBtn = document.querySelector(`[data-content-toggle="${lectureId}"]`);
  row.style.display = '';
  toggleBtn.classList.add('active');
  contentEditorInstance = new toastui.Editor({
    el: document.getElementById(`lectureContentMount-${lectureId}`),
    height: '360px',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    language: 'ko-KR',
    initialValue: lecture.content_markdown || ''
  });
  activeContentLectureId = lectureId;
}

// ── VOD 페이지 인트로 (vod.html 상단 이미지 + 공개 소개 영상) ──
// site_sections(page='vod', section_key='intro')에 {heroImage, thumbnail, playButtonEnabled, playButtonColor, lectureVideoId}로 저장한다.
// 소개 영상은 로그인 없이 열리는 유일한 영상이라 서버가 이 값으로만 스트리밍 대상을 정한다.
// thumbnail은 영상 재생 전 플레이스홀더에 표시되는 이미지, playButtonEnabled/playButtonColor는 그 위에 뜨는
// 재생 버튼(링+삼각형)의 표시 여부·색상이다 (문구를 직접 입력하던 옛 caption 필드를 대체함).
//
// 아직 저장된 값이 없을 때는 지금 사이트에 실제로 나가고 있는 값(vod.html의 하드코딩 기본값과
// server.js의 PUBLIC_VOD_INTRO_LECTURE_ID)을 그대로 채워 넣는다 — 관리자 화면이 빈 칸으로 보이면
// "인트로가 비어 있다"고 오해하게 되고, 한 항목만 고쳐 저장했을 때 나머지가 날아간 것처럼 보인다.
const VOD_INTRO_DEFAULTS = {
  heroImage: '/assets/vod/hero.jpg',
  thumbnail: '/assets/vod/hero.jpg',
  playButtonEnabled: true,
  playButtonColor: '#a98254', // vod.html .vod-intro__play 기본값(--vod-play-color)과 동일
  lectureVideoId: 24 // 0강 연고대 편입논술 OT
};

// 재생 버튼 색상 팔레트 — 브랜드 골드 계열 + 무채색 몇 가지를 프리셋으로 제공, input[type=color]로 임의 색상도 가능
const VOD_INTRO_PLAY_COLOR_PRESETS = ['#a98254', '#e3cdaf', '#0e1c30', '#ffffff', '#d64545'];

// VOD 카테고리 카드와 같은 방식의 접기/펼치기 (기본 접힘)
function initVodIntroToggle() {
  const toggleBtn = document.getElementById('vod-intro-toggle');
  const body = document.getElementById('vod-intro-body');
  if (!toggleBtn || !body) return;
  toggleBtn.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    toggleBtn.textContent = isOpen ? '펼치기' : '접기';
  });
}

async function initVodIntroCard() {
  const saveBtn = document.getElementById('vod-intro-save');
  if (!saveBtn) return;

  const thumbPreviewEl = document.getElementById('vod-intro-thumb-preview');
  const thumbFileEl = document.getElementById('vod-intro-thumb-file');
  const previewEl = document.getElementById('vod-intro-hero-preview');
  const fileEl = document.getElementById('vod-intro-hero-file');
  const colorFieldEl = document.getElementById('vod-intro-play-color-field');
  const colorInputEl = document.getElementById('vod-intro-play-color-input');
  const colorHexEl = document.getElementById('vod-intro-play-color-hex');
  const playToggleEl = document.getElementById('vod-intro-play-toggle');
  let heroImage = '';
  let thumbnail = '';
  let playButtonColor = VOD_INTRO_DEFAULTS.playButtonColor;
  let lectureVideoId = '';

  function renderHero() {
    const img = previewEl.querySelector('.preview-img');
    const note = previewEl.querySelector('.empty-note');
    img.src = heroImage || '';
    img.style.display = heroImage ? '' : 'none';
    note.style.display = heroImage ? 'none' : '';
  }

  function renderThumb() {
    const img = thumbPreviewEl.querySelector('.preview-img');
    const note = thumbPreviewEl.querySelector('.empty-note');
    img.src = thumbnail || '';
    img.style.display = thumbnail ? '' : 'none';
    note.style.display = thumbnail ? 'none' : '';
  }

  function setPlayColor(color) {
    playButtonColor = color;
    colorInputEl.value = color;
    colorHexEl.textContent = color;
    colorFieldEl.querySelectorAll('.color-swatch').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.color.toLowerCase() === color.toLowerCase());
    });
  }

  VOD_INTRO_PLAY_COLOR_PRESETS.forEach(color => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.style.background = color;
    btn.dataset.color = color;
    btn.title = color;
    btn.addEventListener('click', () => setPlayColor(color));
    colorFieldEl.insertBefore(btn, colorInputEl);
  });
  colorInputEl.addEventListener('input', () => setPlayColor(colorInputEl.value));

  const [data, videos, folders] = await Promise.all([
    apiFetch('/admin/api/site/vod/intro').catch(() => ({})),
    apiFetch('/admin/api/videos?all=1').catch(() => []),
    apiFetch('/admin/api/video-folders').catch(() => [])
  ]);
  heroImage = data.heroImage || VOD_INTRO_DEFAULTS.heroImage;
  lectureVideoId = data.lectureVideoId || VOD_INTRO_DEFAULTS.lectureVideoId;
  thumbnail = data.thumbnail || VOD_INTRO_DEFAULTS.thumbnail;
  renderHero();
  renderThumb();
  setPlayColor(data.playButtonColor || VOD_INTRO_DEFAULTS.playButtonColor);
  playToggleEl.checked = data.playButtonEnabled !== undefined ? data.playButtonEnabled : VOD_INTRO_DEFAULTS.playButtonEnabled;

  const videoOptions = videos
    .filter(v => v.status === 'done' && v.final_r2_key)
    .map(v => ({ id: v.id, label: v.title, group: videoFolderPath(v.folder_id, folders) || '루트' }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ko') || a.label.localeCompare(b.label, 'ko'));
  initSearchableSelect(document.getElementById('vod-intro-video-select'), videoOptions, {
    value: lectureVideoId,
    placeholder: '영상 선택',
    emptyLabel: '(영상 없음)',
    onSelect: (id) => { lectureVideoId = id || ''; }
  });

  fileEl.addEventListener('change', async () => {
    const file = fileEl.files[0];
    if (!file) return;
    const status = document.getElementById('vod-intro-hero-status');
    setStatus(status, '업로드 중...');
    try {
      const { url } = await uploadImage(file, 'vod-course', 'intro');
      heroImage = url;
      renderHero();
      setStatus(status, '업로드되었습니다. 저장을 눌러 반영하세요.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      fileEl.value = '';
    }
  });

  thumbFileEl.addEventListener('change', async () => {
    const file = thumbFileEl.files[0];
    if (!file) return;
    const status = document.getElementById('vod-intro-thumb-status');
    setStatus(status, '업로드 중...');
    try {
      const { url } = await uploadImage(file, 'vod-course', 'intro-thumb');
      thumbnail = url;
      renderThumb();
      setStatus(status, '업로드되었습니다. 저장을 눌러 반영하세요.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      thumbFileEl.value = '';
    }
  });

  saveBtn.addEventListener('click', async () => {
    const status = document.getElementById('vod-intro-status');
    try {
      await apiFetch('/admin/api/site/vod/intro', {
        method: 'PUT',
        body: JSON.stringify({ heroImage, thumbnail, playButtonEnabled: playToggleEl.checked, playButtonColor, lectureVideoId: lectureVideoId || '' })
      });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

// 영상의 folder_id를 타고 올라가며 "상위폴더 / 하위폴더" 경로 문자열을 만든다 (루트면 빈 문자열)
function videoFolderPath(folderId, folders) {
  const parts = [];
  let cursor = folderId;
  while (cursor != null) {
    const folder = folders.find(f => String(f.id) === String(cursor));
    if (!folder) break;
    parts.unshift(folder.name);
    cursor = folder.parent_id;
  }
  return parts.join(' / ');
}

async function loadVodLectures() {
  if (!currentVodId) return;
  collapseLectureContent();
  const [lectures, videos, materials, folders] = await Promise.all([
    apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures`),
    apiFetch('/admin/api/videos?all=1'),
    apiFetch(`/admin/api/vod-courses/${currentVodId}/lecture-materials`).catch(() => []),
    apiFetch('/admin/api/video-folders').catch(() => [])
  ]);
  vodLecturesCache = lectures;
  vodMaterialsCache = materials;
  const doneVideos = videos.filter(v => v.status === 'done' && v.final_r2_key);
  const videoOptions = doneVideos
    .map(v => ({ id: v.id, label: v.title, group: videoFolderPath(v.folder_id, folders) || '루트' }))
    .sort((a, b) => a.group.localeCompare(b.group, 'ko') || a.label.localeCompare(b.label, 'ko'));

  const videoGroups = new Map();
  videoOptions.forEach(o => {
    if (!videoGroups.has(o.group)) videoGroups.set(o.group, []);
    videoGroups.get(o.group).push(o);
  });
  const addSelect = document.getElementById('vodLectureVideoSelect');
  addSelect.innerHTML = '<option value="">강의 영상 선택</option>' +
    [...videoGroups.entries()].map(([group, opts]) =>
      `<optgroup label="${escapeHtml(group)}">${opts.map(o => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join('')}</optgroup>`
    ).join('');

  document.getElementById('vodLectureNumberInput').value = lectures.length
    ? String(Math.max(...lectures.map(l => l.lecture_number)) + 1)
    : '0';

  document.getElementById('vodLectureList').innerHTML = lectures.length
    ? lectures.map(lectureRowHtml).join('')
    : '<tr><td colspan="5" style="color:var(--text-soft);">등록된 커리큘럼 스텝이 없습니다.</td></tr>';

  lectures.forEach(l => {
    const container = document.querySelector(`[data-video-select="${l.id}"]`);
    initSearchableSelect(container, videoOptions, {
      value: l.video_id || '',
      placeholder: '강의 영상 선택',
      emptyLabel: '(영상 연결 안 함)',
      onSelect: (videoId) => updateLectureVideo(l.id, videoId)
    });
  });
}

async function updateLectureVideo(lectureId, videoId) {
  const status = document.getElementById('vodLectureStatus');
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${lectureId}`, {
      method: 'PUT', body: JSON.stringify({ videoId: videoId || null })
    });
    setStatus(status, '영상 연결이 저장되었습니다.', 'ok');
    await loadVodLectures();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
}

document.getElementById('vodLectureAddBtn').addEventListener('click', async () => {
  if (!currentVodId) return;
  const status = document.getElementById('vodLectureStatus');
  const videoId = document.getElementById('vodLectureVideoSelect').value;
  const lectureNumber = document.getElementById('vodLectureNumberInput').value;
  const title = document.getElementById('vodLectureTitleInput').value.trim();
  if (lectureNumber === '' || !title) { setStatus(status, '번호와 제목을 입력해주세요.', 'error'); return; }
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures`, {
      method: 'POST',
      body: JSON.stringify({ videoId: videoId || undefined, lectureNumber, title })
    });
    setStatus(status, '추가되었습니다.', 'ok');
    document.getElementById('vodLectureTitleInput').value = '';
    await loadVodLectures();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

document.getElementById('vodLectureList').addEventListener('change', async (e) => {
  const titleId = e.target.dataset.lecTitle;
  if (!titleId) return;
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${titleId}`, {
      method: 'PUT', body: JSON.stringify({ title: e.target.value })
    });
    setStatus(document.getElementById('vodLectureStatus'), '수정되었습니다.', 'ok');
    await loadVodLectures();
  } catch (err) {
    setStatus(document.getElementById('vodLectureStatus'), err.message, 'error');
  }
});

document.getElementById('vodLectureList').addEventListener('click', async (e) => {
  const unlinkId = e.target.dataset.unlinkLec;
  const addMaterialId = e.target.dataset.materialAdd;
  const removeMaterialId = e.target.dataset.removeMaterial;
  const toggleContentId = e.target.dataset.contentToggle;
  const saveContentId = e.target.dataset.contentSave;
  const status = document.getElementById('vodLectureStatus');

  if (toggleContentId) {
    if (String(activeContentLectureId) === String(toggleContentId)) collapseLectureContent();
    else expandLectureContent(toggleContentId);
    return;
  }

  if (saveContentId) {
    if (!contentEditorInstance) return;
    const statusEl = document.querySelector(`[data-content-status="${saveContentId}"]`);
    const markdown = contentEditorInstance.getMarkdown();
    try {
      await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${saveContentId}`, {
        method: 'PUT', body: JSON.stringify({ contentMarkdown: markdown })
      });
      const lecture = vodLecturesCache.find(l => String(l.id) === saveContentId);
      if (lecture) lecture.content_markdown = markdown;
      const toggleBtn = document.querySelector(`[data-content-toggle="${saveContentId}"]`);
      if (toggleBtn) toggleBtn.classList.toggle('has-content', !!markdown.trim());
      setStatus(statusEl, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(statusEl, err.message, 'error');
    }
    return;
  }

  if (unlinkId) {
    const lecture = vodLecturesCache.find(l => String(l.id) === unlinkId);
    if (!lecture || !confirm(`"${lecture.title}" 스텝을 삭제할까요?`)) return;
    try {
      await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${unlinkId}`, { method: 'DELETE' });
      await loadVodLectures();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
    return;
  }

  if (addMaterialId) {
    const fileInput = document.querySelector(`[data-material-input="${addMaterialId}"]`);
    const file = fileInput.files[0];
    if (!file) { setStatus(status, '첨부할 파일을 선택해주세요.', 'error'); return; }
    try {
      const { key, uploadUrl } = await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${addMaterialId}/materials/presign`, {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type || 'application/octet-stream', filename: file.name })
      });
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
      if (!putRes.ok) throw new Error('업로드에 실패했습니다.');
      await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${addMaterialId}/materials/confirm`, {
        method: 'POST',
        body: JSON.stringify({ key, title: file.name, contentType: file.type, fileSize: file.size })
      });
      setStatus(status, '자료가 추가되었습니다.', 'ok');
      await loadVodLectures();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
    return;
  }

  if (removeMaterialId) {
    if (!confirm('이 자료를 삭제할까요?')) return;
    const material = vodMaterialsCache.find(m => String(m.id) === removeMaterialId);
    if (!material) return;
    try {
      await apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures/${material.vod_course_lecture_id}/materials/${removeMaterialId}`, { method: 'DELETE' });
      await loadVodLectures();
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initVodIntroToggle();
  initVodIntroCard();
  initVodCategoryToggle();
  initVodCategories();
  initVodTabs();
  loadVodCategories();
  loadVodInstructorOptions();
  loadVodCourses();
});
