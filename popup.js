/*
 * Full Page Capture - 팝업 UI 로직
 * 흐름: 캡처 요청(runtime message) → 진행률(port) → 결과(storage.local) → 저장/복사
 */
'use strict';

const $ = function (id) { return document.getElementById(id); };

const state = {
  tab: null,
  capture: null,
  capturing: false,
  port: null,
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindUi();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = (tabs && tabs[0]) || null;
  const url = (state.tab && state.tab.url) || '';

  if (isRestrictedUrl(url)) {
    showNotice('Chrome 보안 정책으로 인해 이 페이지는 캡처할 수 없습니다.', true);
    $('btnFull').disabled = true;
    $('btnVisible').disabled = true;
  } else if (state.tab) {
    /* 파일명 미리 표시 */
    $('filenameInput').value = FPC.buildBaseFilename({ url: url, title: state.tab.title || '', date: new Date() });
  }

  connectPort();

  /* 백그라운드에서 진행 중인 캡처가 있는지 확인(팝업을 닫았다 다시 연 경우) */
  let st = null;
  try { st = await chrome.runtime.sendMessage({ type: 'FPC_STATUS' }); } catch (e) { /* 무시 */ }
  if (st && st.ok && st.job) { setCapturing(st.job); return; }

  const data = await chrome.storage.local.get(['lastCapture', 'settings']);
  if (data.settings) renderRecent(data.settings);
  if (data.lastCapture) renderResult(data.lastCapture, true);
}

function bindUi() {
  $('btnFull').addEventListener('click', function () { start('full'); });
  $('btnVisible').addEventListener('click', function () { start('visible'); });
  $('btnPng').addEventListener('click', savePng);
  $('btnPdf').addEventListener('click', savePdf);
  $('btnClip').addEventListener('click', copyClipboard);
  $('btnAgain').addEventListener('click', again);
  $('thumb').addEventListener('click', openPreview);
}

/* ---------- 백그라운드 연결 ---------- */
function connectPort() {
  try {
    state.port = chrome.runtime.connect({ name: 'fpc' });
    state.port.onMessage.addListener(onPortMessage);
    state.port.onDisconnect.addListener(function () { state.port = null; });
  } catch (e) { /* 무시 */ }
}

function onPortMessage(msg) {
  if (!msg) return;
  if (msg.type === 'FPC_PROGRESS' && msg.job) setCapturing(msg.job);
  else if (msg.type === 'FPC_DONE') onDone();
  else if (msg.type === 'FPC_ERROR') showError(msg.message || '');
}

async function onDone() {
  const data = await chrome.storage.local.get(['lastCapture', 'settings']);
  state.capturing = false;
  hideProgress();
  if (data.lastCapture) renderResult(data.lastCapture, false);
  if (data.settings) renderRecent(data.settings);
  setStatus('캡처 완료', 'ok');
}

/* ---------- 캡처 시작 ---------- */
async function start(mode) {
  if (state.capturing || !state.tab || !state.tab.id) return;
  hideNotice();
  hideResult();
  setCapturing({ mode: mode, phase: '준비 중', index: 0, total: 0, percent: 0 });

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'FPC_START', mode: mode, tabId: state.tab.id });
  } catch (e) {
    resp = { ok: false, error: (e && e.message) || '' };
  }
  if (resp && !resp.ok) showError(resp.error || '');
}

/* ---------- 진행 상태 표시 ---------- */
function setCapturing(job) {
  state.capturing = true;
  hideResult();
  $('progressWrap').classList.remove('hidden');
  $('btnFull').disabled = true;
  $('btnVisible').disabled = true;

  const isFull = job.mode !== 'visible';
  const busyBtn = isFull ? $('btnFull') : $('btnVisible');
  const otherBtn = isFull ? $('btnVisible') : $('btnFull');
  busyBtn.classList.add('busy');
  otherBtn.classList.remove('busy');

  $('progressLabel').textContent = isFull ? '전체 페이지 캡처 중...' : '현재 화면 캡처 중...';

  const bar = $('progressBar');
  const fill = $('progressFill');
  let meta = '';
  let pct = Math.max(0, Math.min(100, job.percent || 0));
  const phase = job.phase || '';

  if (phase.indexOf('합성') !== -1) {
    meta = '이미지 합성 중...';
    bar.classList.add('indeterminate');
    fill.style.width = '38%';
  } else if (phase.indexOf('준비') !== -1 || phase.indexOf('분석') !== -1) {
    meta = '페이지 준비 중...';
    bar.classList.add('indeterminate');
    fill.style.width = '38%';
  } else if (job.total) {
    meta = job.index + ' / ' + job.total + ' 영역 캡처 중 · ' + pct + '%';
    bar.classList.remove('indeterminate');
    fill.style.width = pct + '%';
  } else {
    meta = '준비 중...';
    bar.classList.add('indeterminate');
    fill.style.width = '38%';
  }
  $('progressMeta').textContent = meta;
}

function hideProgress() {
  $('progressWrap').classList.add('hidden');
  $('progressBar').classList.remove('indeterminate');
  $('btnFull').classList.remove('busy');
  $('btnVisible').classList.remove('busy');
  const restricted = isRestrictedUrl(state.tab && state.tab.url);
  $('btnFull').disabled = restricted;
  $('btnVisible').disabled = restricted;
}

function showError(msg) {
  state.capturing = false;
  hideProgress();
  const m = String(msg || '');
  /* 접두사 중복 방지: 이미 '캡처에 실패했습니다'로 시작하면 그대로 표시 */
  showNotice(m.indexOf('캡처에 실패했습니다') === 0 ? m : '캡처에 실패했습니다. ' + m, true);
}

/* ---------- 결과 표시 ---------- */
function renderResult(cap, stale) {
  state.capture = cap;
  $('resultCard').classList.remove('hidden');
  $('thumb').src = cap.dataUrl;
  $('dimText').textContent = cap.width + ' × ' + cap.height + ' px';
  $('sizeText').textContent = FPC.formatBytes(cap.bytes);
  $('filenameInput').value = cap.baseFilename;
  $('btnPng').disabled = false;
  $('btnPdf').disabled = false;
  $('btnClip').disabled = false;
  setStatus(stale ? '이전 캡처 결과입니다' : '캡처 결과 준비 완료', stale ? '' : 'ok');

  const chips = [];
  if (cap.partial) chips.push('페이지가 매우 길어 일부만 캡처되었습니다');
  if (cap.scaledDown) chips.push('브라우저 이미지 크기 한도로 축소 저장되었습니다');
  const chipEl = $('chips');
  chipEl.textContent = chips.join(' · ');
  chipEl.classList.toggle('hidden', chips.length === 0);
}

function hideResult() {
  $('resultCard').classList.add('hidden');
}

function setStatus(text, kind) {
  const el = $('statusText');
  el.textContent = text || '';
  el.className = 'status ' + (kind || '');
  const dot = $('statusDot');
  dot.className = 'status-dot ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '');
}

function showNotice(text, isErr) {
  const n = $('notice');
  n.textContent = text;
  n.classList.remove('hidden');
  n.classList.toggle('err', !!isErr);
}

function hideNotice() { $('notice').classList.add('hidden'); }

function renderRecent(settings) {
  const mode = settings.lastMode === 'visible' ? '현재 화면 캡처' : '전체 페이지 캡처';
  const map = { png: 'PNG', pdf: 'PDF', clipboard: '클립보드' };
  const fmt = map[settings.lastFormat];
  $('recentText').textContent = '최근 사용: ' + mode + (fmt ? ' · ' + fmt : '');
}

/* ---------- 저장 / 복사 ---------- */
function filenameValue() {
  const v = FPC.sanitizeFilePart($('filenameInput').value, 90);
  return v || ('capture_' + FPC.formatStamp(new Date()));
}

async function rememberFormat(fmt) {
  try {
    const data = await chrome.storage.local.get('settings');
    const s = data.settings || {};
    s.lastFormat = fmt;
    await chrome.storage.local.set({ settings: s });
    renderRecent(s);
  } catch (e) { /* 무시 */ }
}

function trackDownload(id, cb) {
  const handler = function (delta) {
    if (delta.id !== id) return;
    if (delta.state && delta.state.current === 'complete') {
      chrome.downloads.onChanged.removeListener(handler);
      cb();
    }
  };
  chrome.downloads.onChanged.addListener(handler);
}

async function savePng() {
  if (!state.capture) return;
  rememberFormat('png');
  const name = filenameValue() + '.png';
  setStatus('PNG 저장을 시작합니다...');
  try {
    const id = await chrome.downloads.download({
      url: state.capture.dataUrl,
      filename: name,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    trackDownload(id, function () { setStatus('PNG 저장 완료: ' + name, 'ok'); });
  } catch (e) {
    setStatus('저장 실패: ' + ((e && e.message) || e), 'err');
  }
}

async function savePdf() {
  if (!state.capture) return;
  rememberFormat('pdf');
  setStatus('PDF 생성 중... 페이지가 길면 몇 초 걸릴 수 있습니다.');
  try {
    const blob = await FPC_BuildPdf(state.capture.dataUrl);
    const dataUrl = await FPC.blobToDataUrl(blob);
    const name = filenameValue() + '.pdf';
    const id = await chrome.downloads.download({
      url: dataUrl,
      filename: name,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    trackDownload(id, function () {
      setStatus('PDF 저장 완료: ' + name + ' (' + FPC.formatBytes(blob.size) + ')', 'ok');
    });
  } catch (e) {
    setStatus('PDF 생성 실패: ' + ((e && e.message) || e), 'err');
  }
}

async function copyClipboard() {
  if (!state.capture) return;
  rememberFormat('clipboard');
  try {
    const blob = FPC.dataUrlToBlob(state.capture.dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('클립보드에 복사되었습니다.', 'ok');
  } catch (e) {
    setStatus(clipboardErrorText(e), 'err');
  }
}

function clipboardErrorText(e) {
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError') return '클립보드 복사 실패: 브라우저가 접근을 차단했습니다. 팝업을 다시 연 뒤 다시 시도해 주세요.';
  if (name === 'NotReadableError') return '클립보드 복사 실패: 이미지가 너무 큽니다. PNG 저장을 이용해 주세요.';
  if (name === 'SecurityError') return '클립보드 복사 실패: 보안 정책으로 차단되었습니다.';
  return '클립보드 복사 실패: ' + ((e && e.message) || name || '알 수 없는 오류');
}

/* ---------- 기타 ---------- */
function again() {
  const mode = (state.capture && state.capture.mode) || 'full';
  start(mode);
}

function openPreview() {
  chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') });
}

function isRestrictedUrl(url) {
  const u = String(url || '');
  if (!/^(https?|file):/i.test(u)) return true;
  if (/chromewebstore\.google\.com|clients2?\.google\.com\/service\/update2\/crx|chrome\.google\.com\/webstore/i.test(u)) return true;
  return false;
}
