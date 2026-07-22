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

// ── VOD 강의 목록 ──
let vodCache = [];
let currentVodId = null;
let vodLecturesCache = [];
let vodChecklistCache = [];
let vodTagsCache = [];
let vodSectionsCache = [];

async function loadVodCourses() {
  vodCache = await apiFetch('/admin/api/vod-courses');
  document.getElementById('vodTotal').textContent = vodCache.length;
  document.getElementById('vodList').innerHTML = vodCache.map(c => `
    <tr>
      <td>${c.sort_order}</td>
      <td>${escapeHtml(c.title)}</td>
      <td>${escapeHtml(c.category_label || '')}</td>
      <td>${escapeHtml(c.new_price)}</td>
      <td><span class="badge ${c.is_active ? 'badge-on' : 'badge-off'}">${c.is_active ? '노출' : '숨김'}</span></td>
      <td>
        <button class="row-btn" data-edit-vod="${c.id}">수정</button>
        <button class="row-btn danger" data-delete-vod="${c.id}">삭제</button>
      </td>
    </tr>
  `).join('');
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
  document.getElementById('sectionTitle').textContent = 'VOD 강의 수정';
}
function closeVodEditPage() {
  collapseLectureContent();
  document.getElementById('vodEditSection').classList.remove('active');
  document.querySelector('.side-link[data-target="vodSection"]').classList.add('active');
  document.getElementById('vodSection').classList.add('active');
  document.getElementById('sectionTitle').textContent = 'VOD 강의';
}

function fillVodForm(course) {
  document.getElementById('vfTag').value = course?.tag || '';
  renderVodCategoryOptions();
  document.getElementById('vfCategoryLabel').value = course?.category_label || '';
  document.getElementById('vfTitle').value = course?.title || '';
  document.getElementById('vfDescription').value = course?.description || '';
  document.getElementById('vfMetaText').value = course?.meta_text || '';
  document.getElementById('vfColorVariant').value = course?.color_variant || 'default';
  document.getElementById('vfCompletionCriteria').value = course?.completion_criteria || '';
  document.getElementById('vfTotalDurationText').value = course?.total_duration_text || '';
  document.getElementById('vfDifficulty').value = course?.difficulty || '';
  document.getElementById('vfDifficultyVisible').checked = course ? !!course.difficulty_visible : true;
  document.getElementById('vfHasDiscount').checked = !!course?.old_price;
  document.getElementById('vfOldPrice').value = course?.old_price || '';
  document.getElementById('vfNewPrice').value = course?.new_price || '';
  document.getElementById('vfSortOrder').value = course?.sort_order ?? 0;
  document.getElementById('vfIsBest').checked = !!course?.is_best;
  document.getElementById('vfIsActive').checked = course ? !!course.is_active : true;
  toggleDiscountRow('vfHasDiscount', 'vfOldPriceRow', 'vfNewPriceLabel');

  document.getElementById('vfIntroHeading').value = course?.intro_heading || '클래스에서 배울 수 있는 내용이에요';
  document.getElementById('vfIntroParagraph').value = course?.intro_paragraph || '';
  document.getElementById('vfRecommendedHeading').value = course?.recommended_heading || '이런 분들께 추천해요';
}

function readVodForm() {
  const hasDiscount = document.getElementById('vfHasDiscount').checked;
  return {
    tag: document.getElementById('vfTag').value.trim(),
    category_label: document.getElementById('vfCategoryLabel').value,
    title: document.getElementById('vfTitle').value.trim(),
    description: document.getElementById('vfDescription').value.trim(),
    meta_text: document.getElementById('vfMetaText').value.trim(),
    color_variant: document.getElementById('vfColorVariant').value,
    completion_criteria: document.getElementById('vfCompletionCriteria').value.trim(),
    total_duration_text: document.getElementById('vfTotalDurationText').value.trim(),
    difficulty: document.getElementById('vfDifficulty').value.trim(),
    difficulty_visible: document.getElementById('vfDifficultyVisible').checked,
    old_price: hasDiscount ? document.getElementById('vfOldPrice').value.trim() : '',
    new_price: document.getElementById('vfNewPrice').value.trim(),
    sort_order: parseInt(document.getElementById('vfSortOrder').value, 10) || 0,
    is_best: document.getElementById('vfIsBest').checked,
    is_active: document.getElementById('vfIsActive').checked,
    intro_heading: document.getElementById('vfIntroHeading').value.trim(),
    intro_paragraph: document.getElementById('vfIntroParagraph').value.trim(),
    recommended_heading: document.getElementById('vfRecommendedHeading').value.trim()
  };
}

async function openEditModal(courseStub) {
  currentVodId = courseStub.id;
  document.getElementById('vodFormTitle').textContent = 'VOD 강의 수정';
  setStatus(document.getElementById('vodFormStatus'), '');
  showVodEditPage();
  selectVodTab('title');
  const course = await apiFetch(`/admin/api/vod-courses/${currentVodId}`);
  fillVodForm(course);
  vodChecklistCache = course.checklistItems || [];
  vodTagsCache = course.tags || [];
  vodSectionsCache = course.sections || [];
  renderVodChecklist();
  renderVodTags();
  renderVodSections();
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

document.getElementById('vodSaveBtn').addEventListener('click', async () => {
  const status = document.getElementById('vodFormStatus');
  const body = readVodForm();
  if (!body.title || !body.new_price) {
    setStatus(status, '강좌명과 가격은 필수입니다.', 'error');
    return;
  }
  try {
    await apiFetch(`/admin/api/vod-courses/${currentVodId}`, { method: 'PUT', body: JSON.stringify(body) });
    setStatus(status, '저장되었습니다.', 'ok');
    await loadVodCourses();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

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

function lectureRowHtml(l) {
  const materials = lectureMaterialsFor(l.id);
  const hasContent = !!(l.content_markdown && l.content_markdown.trim());
  return `
    <tr>
      <td>${l.lecture_number}</td>
      <td><input type="text" data-lec-title="${l.id}" value="${escapeHtml(l.title)}" style="margin-bottom:0;"></td>
      <td>
        <div class="searchable-select" data-video-select="${l.id}">
          <input type="text" class="ss-input" autocomplete="off">
          <div class="ss-dropdown"></div>
        </div>
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

async function loadVodLectures() {
  if (!currentVodId) return;
  collapseLectureContent();
  const [lectures, videos, materials] = await Promise.all([
    apiFetch(`/admin/api/vod-courses/${currentVodId}/lectures`),
    apiFetch('/admin/api/videos'),
    apiFetch(`/admin/api/vod-courses/${currentVodId}/lecture-materials`).catch(() => [])
  ]);
  vodLecturesCache = lectures;
  vodMaterialsCache = materials;
  const doneVideos = videos.filter(v => v.status === 'done' && v.final_r2_key);
  const videoOptions = doneVideos.map(v => ({ id: v.id, label: v.title }));

  const addSelect = document.getElementById('vodLectureVideoSelect');
  addSelect.innerHTML = '<option value="">강의 영상 선택</option>' +
    doneVideos.map(v => `<option value="${v.id}">${escapeHtml(v.title)}</option>`).join('');

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
  initVodCategoryToggle();
  initVodCategories();
  initVodTabs();
  loadVodCategories();
  loadVodCourses();
});
