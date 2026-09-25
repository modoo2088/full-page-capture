/* Full Page Capture - 미리보기 페이지 */
'use strict';

const $ = function (id) { return document.getElementById(id); };

(async function () {
  const data = await chrome.storage.local.get('lastCapture');
  const cap = data && data.lastCapture;
  if (!cap) {
    document.querySelector('main').innerHTML = '<p class="empty">미리볼 캡처 이미지가 없습니다.<br>확장 프로그램에서 먼저 캡처를 진행해 주세요.</p>';
    return;
  }
  const img = $('view');
  img.src = cap.dataUrl;
  $('metaText').textContent = (cap.title || cap.url || '캡처 이미지') + ' · ' +
    cap.width + ' × ' + cap.height + ' px · ' + FPC.formatBytes(cap.bytes);
  document.title = (cap.title || '캡처 미리보기') + ' - Full Page Capture';

  const setZoom = function (cls) { img.className = cls; };
  $('btnFit').addEventListener('click', function () { setZoom('fit'); });
  $('btn100').addEventListener('click', function () { setZoom('z100'); });
  $('btn50').addEventListener('click', function () { setZoom('z50'); });

  $('btnPng').addEventListener('click', async function () {
    try {
      const name = (cap.baseFilename || 'capture') + '.png';
      await chrome.downloads.download({
        url: cap.dataUrl,
        filename: name,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      $('btnPng').textContent = '저장 완료';
      setTimeout(function () { $('btnPng').textContent = 'PNG 저장'; }, 2000);
    } catch (e) {
      $('btnPng').textContent = '저장 실패';
    }
  });
})();
