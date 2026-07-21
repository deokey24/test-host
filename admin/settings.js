async function initSettings() {
  const data = await loadHomeSectionDataFor('settings', 'footer');
  document.getElementById('settings-kakao-url').value = data.kakaoUrl || '';
  document.getElementById('settings-phone').value = data.phone || '';
  document.getElementById('settings-hours').value = data.hours || '';
  document.getElementById('settings-footer-lines').value = Array.isArray(data.footerLines) ? data.footerLines.join('\n') : '';
  document.getElementById('settings-copyright').value = data.copyright || '';

  document.getElementById('settings-save').addEventListener('click', async () => {
    const status = document.getElementById('settings-status');
    const kakaoUrl = document.getElementById('settings-kakao-url').value.trim();
    if (!kakaoUrl) {
      setStatus(status, '카카오톡 상담 링크는 필수입니다.', 'error');
      return;
    }
    const payload = {
      kakaoUrl,
      phone: document.getElementById('settings-phone').value.trim(),
      hours: document.getElementById('settings-hours').value.trim(),
      footerLines: document.getElementById('settings-footer-lines').value.split('\n').map(s => s.trim()).filter(Boolean),
      copyright: document.getElementById('settings-copyright').value.trim()
    };
    try {
      await apiFetch('/admin/api/site/settings/footer', { method: 'PUT', body: JSON.stringify(payload) });
      setStatus(status, '저장되었습니다.', 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
});
