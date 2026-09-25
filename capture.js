/*
 * Full Page Capture - 캡처 실행 모듈
 * background.js가 importScripts('capture.js')로 로드한다.
 * 실제 캡처 절차(주입 → 세그먼트별 캡처 → 합성 → 저장)를 담당한다.
 */
(function (global) {
  'use strict';

  let ctx = null; /* { getJob, snapshot, post, storeResult } */

  function init(env) { ctx = env || {}; }

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* Chrome captureVisibleTab 쿼터: 초당 2회(MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).
   * 안전 마진을 두고 호출 간 최소 600ms 간격을 유지하고,
     그래도 쿼터 오류가 나면 1.1초 대기 후 1회 재시도한다. */
  const CAPTURE_MIN_INTERVAL_MS = 600;
  let lastCaptureAt = 0;

  async function captureNow(windowId) {
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    for (let attempt = 0; ; attempt++) {
      try {
        const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        lastCaptureAt = Date.now();
        return url;
      } catch (e) {
        const msg = String((e && e.message) || '');
        if (attempt === 0 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(msg)) {
          await sleep(1100);
          continue;
        }
        throw e;
      }
    }
  }

  function tsend(tabId, msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.sendMessage(tabId, msg, function (res) {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res);
        });
      } catch (e) { reject(e); }
    });
  }

  async function injectContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
    } catch (e) {
      throw new Error('INJECT_FAILED:' + ((e && e.message) || ''));
    }
    /* 주입 직후 리스너 등록 타이밍 보장 */
    for (let i = 0; i < 10; i++) {
      try {
        const r = await tsend(tabId, { type: 'FPC_PING' });
        if (r && r.ok) return;
      } catch (e) { /* 재시도 */ }
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    throw new Error('INJECT_FAILED:콘텐츠 스크립트 응답 없음');
  }

  function isRestrictedUrl(url) {
    const u = String(url || '');
    if (!/^(https?|file):/i.test(u)) return true; /* chrome://, about:, devtools:// 등 */
    if (/chromewebstore\.google\.com|clients2?\.google\.com\/service\/update2\/crx|chrome\.google\.com\/webstore/i.test(u)) return true;
    return false;
  }

  function friendlyError(err, tab) {
    const m = String((err && err.message) || err || '');
    if (m.indexOf('SECURITY') === 0) return 'Chrome 보안 정책으로 인해 이 페이지는 캡처할 수 없습니다.';
    if (m.indexOf('INJECT_FAILED') === 0) {
      if (tab && /^file:/i.test(tab.url || '')) {
        return '이 페이지에는 접근할 수 없습니다. chrome://extensions → Full Page Capture → 세부정보에서 "파일 URL에 대한 액세스 허용"을 켜주세요.';
      }
      return 'Chrome 보안 정책으로 인해 이 페이지는 캡처할 수 없습니다.';
    }
    if (/이미 캡처가 진행 중/.test(m)) return m;
    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(m)) {
      return 'Chrome의 캡처 속도 제한(초당 2회)에 걸렸습니다. 몇 초 뒤 다시 시도해 주세요.';
    }
    if (/captureVisibleTab|No image data|cannot access|Missing host permission/i.test(m)) {
      return 'Chrome 보안 정책으로 인해 이 페이지는 캡처할 수 없습니다.';
    }
    if (/activeTab|permission/i.test(m)) return '캡처 권한이 없습니다. 페이지를 한 번 클릭한 뒤 다시 시도해 주세요.';
    /* 원시 오류는 그대로 전달(팝업이 '캡처에 실패했습니다.' 접두사를 한 번만 붙임) */
    return m.slice(0, 160) || '알 수 없는 오류입니다.';
  }

  async function captureVisibleOnly(tab) {
    const job = ctx.getJob();
    job.phase = '캡처 중'; job.total = 1; job.index = 0;
    ctx.post({ type: 'FPC_PROGRESS', job: ctx.snapshot() });

    const dataUrl = await captureNow(tab.windowId);
    const blob = FPC.dataUrlToBlob(dataUrl);
    const bmp = await createImageBitmap(blob);
    const width = bmp.width, height = bmp.height;
    if (bmp.close) bmp.close();
    await ctx.storeResult(tab, 'visible', { dataUrl: dataUrl, width: width, height: height, bytes: blob.size });
  }

  async function captureFullPage(tab) {
    await injectContentScript(tab.id);

    const job = ctx.getJob();
    job.phase = '페이지 분석 중';
    ctx.post({ type: 'FPC_PROGRESS', job: ctx.snapshot() });
    const r = await tsend(tab.id, { type: 'FPC_INIT' });
    if (!r || !r.ok) throw new Error((r && r.error) || '페이지 분석에 실패했습니다.');
    const meta = r.data;

    /* 캔버스 한도 내에서 캡처 가능한 최대 문서 높이 계산 */
    const pxScale = Math.max(1, meta.dpr || 1);
    const estW = meta.viewportW * pxScale;
    const maxDocH = Math.floor((FPC.MAX_CANVAS_AREA / estW) / pxScale);
    const plan = FPC.computeSegments(meta.docHeight, meta.viewportH, maxDocH);

    job.total = plan.segments.length;
    job.index = 0;
    job.phase = '캡처 중';
    ctx.post({ type: 'FPC_PROGRESS', job: ctx.snapshot() });

    const shots = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const seg = plan.segments[i];
      const pr = await tsend(tab.id, { type: 'FPC_PREP', index: i, y: seg.y });
      if (!pr || !pr.ok) throw new Error((pr && pr.error) || '스크롤 이동에 실패했습니다.');
      const dataUrl = await captureNow(tab.windowId);
      shots.push({ dataUrl: dataUrl, actualY: pr.data.actualY });
      job.index = i + 1;
      ctx.post({ type: 'FPC_PROGRESS', job: ctx.snapshot() });
    }

    /* 원래 스크롤 위치 복원(실패해도 캡처 결과에는 영향 없음) */
    try { await tsend(tab.id, { type: 'FPC_RESTORE' }); } catch (e) { /* 무시 */ }

    job.phase = '이미지 합성 중';
    ctx.post({ type: 'FPC_PROGRESS', job: ctx.snapshot() });

    const stitched = await FPC.stitchSegments(shots, { viewportW: meta.viewportW, docHeight: plan.plannedHeight });
    const dataUrl = await FPC.blobToDataUrl(stitched.blob);
    await ctx.storeResult(tab, 'full', {
      dataUrl: dataUrl,
      width: stitched.width,
      height: stitched.height,
      bytes: stitched.blob.size,
      partial: plan.truncated,
      scaledDown: stitched.scaledDown,
    });
  }

  global.FPCapture = {
    init: init,
    tsend: tsend,
    isRestrictedUrl: isRestrictedUrl,
    friendlyError: friendlyError,
    captureVisibleOnly: captureVisibleOnly,
    captureFullPage: captureFullPage,
  };
})(typeof self !== 'undefined' ? self : globalThis);
