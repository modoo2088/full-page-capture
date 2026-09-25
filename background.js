/*
 * Full Page Capture - 백그라운드 서비스 워커 (Manifest V3)
 *
 * 역할:
 *  - 팝업 ↔ 캡처 모듈(capture.js) 연결 및 작업(job) 상태 관리
 *  - 진행률을 팝업에 포트로 푸시(팝업이 닫겨도 캡처는 계속 진행)
 *  - 결과를 storage.local 에 저장(최근 설정만 보관, 외부 전송 없음)
 */
importScripts('utils.js', 'capture.js');

const ports = new Set();
let job = null;

function post(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch (e) { /* 수신부 사라짐 - 무시 */ }
  }
}

function jobSnapshot() {
  if (!job) return null;
  const pct = job.total ? Math.round((job.index / job.total) * 100) : 0;
  return { mode: job.mode, phase: job.phase, index: job.index, total: job.total, percent: pct, tabId: job.tabId };
}

/* 캡처 모듈 초기화(상태 공유) */
FPCapture.init({
  getJob: function () { return job; },
  snapshot: jobSnapshot,
  post: post,
  storeResult: storeResult,
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'fpc') return;
  ports.add(port);
  port.onDisconnect.addListener(function () { ports.delete(port); });
  if (job) { try { port.postMessage({ type: 'FPC_PROGRESS', job: jobSnapshot() }); } catch (e) { /* 무시 */ } }
});

async function persistSettings(patch) {
  let s = {};
  try { const d = await chrome.storage.local.get('settings'); s = d.settings || {}; } catch (e) { /* 무시 */ }
  Object.assign(s, patch);
  try { await chrome.storage.local.set({ settings: s }); } catch (e) { /* 무시 */ }
}

async function storeResult(tab, mode, out) {
  const baseFilename = FPC.buildBaseFilename({ url: tab.url, title: tab.title, date: new Date() });
  const rec = {
    dataUrl: out.dataUrl,
    width: out.width,
    height: out.height,
    bytes: out.bytes,
    mode: mode,
    baseFilename: baseFilename,
    title: tab.title || '',
    url: tab.url || '',
    partial: !!out.partial,
    scaledDown: !!out.scaledDown,
    ts: Date.now(),
  };
  await chrome.storage.local.set({ lastCapture: rec });
  await persistSettings({ lastMode: mode });
  post({
    type: 'FPC_DONE',
    capture: {
      width: rec.width, height: rec.height, bytes: rec.bytes,
      baseFilename: baseFilename, mode: mode, partial: rec.partial,
      scaledDown: rec.scaledDown, ts: rec.ts,
    },
  });
}

async function startCapture(msg) {
  if (job) throw new Error('이미 캡처가 진행 중입니다. 잠시만 기다려 주세요.');
  let tab = null;
  try { tab = await chrome.tabs.get(msg.tabId); } catch (e) { /* 무시 */ }
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (FPCapture.isRestrictedUrl(tab.url)) throw new Error('SECURITY');

  job = { mode: msg.mode, tabId: tab.id, windowId: tab.windowId, phase: '준비 중', index: 0, total: 0, startedAt: Date.now() };
  post({ type: 'FPC_PROGRESS', job: jobSnapshot() });
  try {
    if (msg.mode === 'visible') await FPCapture.captureVisibleOnly(tab);
    else await FPCapture.captureFullPage(tab);
  } catch (e) {
    if (job && job.tabId) {
      try { await FPCapture.tsend(job.tabId, { type: 'FPC_RESTORE' }); } catch (e2) { /* 이미 이동한 페이지 등 */ }
    }
    post({ type: 'FPC_ERROR', message: FPCapture.friendlyError(e, tab) });
    throw e;
  } finally {
    job = null;
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    try {
      if (msg.type === 'FPC_STATUS') {
        sendResponse({ ok: true, job: jobSnapshot() });
      } else if (msg.type === 'FPC_START') {
        await startCapture(msg);
        try { sendResponse({ ok: true }); } catch (e) { /* 팝업이 닫힌 경우 */ }
      } else {
        sendResponse({ ok: false, error: '알 수 없는 메시지입니다.' });
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: FPCapture.friendlyError(e, null) }); } catch (e2) { /* 무시 */ }
    }
  })();
  return true;
});
