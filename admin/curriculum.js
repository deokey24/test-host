// ── 타이틀 (히어로만 편집 — 강좌 목록/스텝은 VOD강의 메뉴에서 관리) ──
async function initCurriculumHero() {
  const data = await loadHomeSectionDataFor('curriculum', 'hero');
  document.getElementById('curriculum-hero-title').value = data.title || '';
  document.getElementById('curriculum-hero-body').value = data.body || '';
  document.getElementById('curriculum-hero-save').addEventListener('click', async () => {
    const status = document.getElementById('curriculum-hero-status');
    try {
      await apiFetch('/admin/api/site/curriculum/hero', {
        method: 'PUT',
        body: JSON.stringify({
          title: document.getElementById('curriculum-hero-title').value.trim(),
          body: document.getElementById('curriculum-hero-body').value.trim()
        })
      });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initCurriculumHero();
});
