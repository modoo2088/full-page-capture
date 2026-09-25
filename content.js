/*
 * Full Page Capture - 콘텐츠 스크립트
 * background.js가 캡처 시점에 chrome.scripting 으로만 주입한다(상시 주입 아님 → 사이트 접근 권한 불필요).
 *
 * 역할
 *  1. 원래 스크롤 위치 저장 / 복원
 *  2. 스크롤바 숨김(합성 틈 방지) + smooth 스크롤 무효화
 *  3. lazy 이미지/콘텐츠 사전 로딩(빠른 예비 스크롤)
 *  4. fixed / sticky 요소 중복 합성 방지
 *     - fixed(상단/하단 고정 메뉴, 플로팅 버튼): 첫 세그먼트에만 표시
 *     - sticky: 자연 위치(stuck 아닌 원래 자리)가 보이는 세그먼트에만 표시
 *  5. 세그먼트별 스크롤 이동 + 페인트 대기
 */
(function () {
  'use strict';

  if (self.__FPC_CONTENT_ACTIVE) return;
  self.__FPC_CONTENT_ACTIVE = true;

  const MAX_PREPASS_STEPS = 60;

  let ctx = null;

  /* ---------- 기본 도구 ---------- */
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const raf = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };

  function viewportH() { return Math.max(1, window.innerHeight); }
  function viewportW() { return Math.max(1, window.innerWidth); }

  function currentY() {
    if (ctx && ctx.scrollerEl) return ctx.scrollerEl.scrollTop;
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  function totalHeight() {
    if (ctx && ctx.scrollerEl) return ctx.scrollerEl.scrollHeight;
    const d = document.documentElement, b = document.body;
    return Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
  }

  function setScrollY(y) {
    if (ctx && ctx.scrollerEl) { ctx.scrollerEl.scrollTop = y; }
    else { window.scrollTo(0, y); }
  }

  async function waitScrollSettle(target, timeoutMs) {
    const t0 = Date.now();
    timeoutMs = timeoutMs || 700;
    for (;;) {
      await raf();
      if (Math.abs(currentY() - target) <= 1) break;
      if (Date.now() - t0 > timeoutMs) break;
    }
    await raf();
  }

  /* ---------- 내부 스크롤 컨테이너 탐색 (관리자/대시보드 페이지 대응) ---------- */
  function findInnerScroller() {
    const d = document.documentElement, b = document.body;
    const docOver = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0) - window.innerHeight;
    if (docOver > 40) return null; /* 문서 자체가 스크롤되면 window 사용 */
    let best = null, bestOver = 0;
    const vh = window.innerHeight, vw = window.innerWidth;
    const walk = function (root) {
      const list = root.querySelectorAll('*');
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        let cs;
        try { cs = getComputedStyle(el); } catch (e) { continue; }
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const oy = cs.overflowY;
        if (oy !== 'auto' && oy !== 'scroll') continue;
        const over = el.scrollHeight - el.clientHeight;
        if (over < vh * 1.2 || el.clientHeight < vh * 0.5) continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.5) continue;
        if (over > bestOver) { best = el; bestOver = over; }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    if (b) walk(b);
    return best;
  }

  /* ---------- fixed / sticky 수집 ---------- */
  function collectFixedSticky() {
    const fixed = [], sticky = [];
    /* 세그먼트 y 좌표 기준이 되는 컨테이너의 콘텐츠 좌표 보정값 */
    let base;
    if (ctx && ctx.scrollerEl) {
      const sr = ctx.scrollerEl.getBoundingClientRect();
      base = ctx.scrollerEl.scrollTop - sr.top;
    } else {
      base = window.pageYOffset || document.documentElement.scrollTop || 0;
    }
    const vh = window.innerHeight, vw = window.innerWidth;

    const walk = function (root) {
      const list = root.querySelectorAll('*');
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'LINK' || tag === 'META') continue;
        let cs;
        try { cs = getComputedStyle(el); } catch (e) { continue; }
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const pos = cs.position;
        if (pos !== 'fixed' && pos !== 'sticky') { if (el.shadowRoot && el.shadowRoot.mode !== 'closed') walk(el.shadowRoot); continue; }
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (pos === 'fixed') {
          /* 화면 밖의 fixed 요소는 캡처에 등장하지 않으므로 관리 불필요 */
          if (r.bottom < -8 || r.top > vh + 8 || r.right < -8 || r.left > vw + 8) continue;
          fixed.push({ el: el, baseStyle: el.getAttribute('style') });
        } else {
          sticky.push({ el: el, baseStyle: el.getAttribute('style'), naturalTop: 0, naturalBottom: 0 });
        }
        if (el.shadowRoot && el.shadowRoot.mode !== 'closed') walk(el.shadowRoot);
      }
    };
    walk(document.documentElement);

    /* sticky 자연 위치 측정: 한 태스크 안에서 동기 처리되므로 화면에 그려지지 않음(깜빡임 없음) */
    for (let k = 0; k < sticky.length; k++) {
      const s = sticky[k];
      try {
        const el = s.el;
        const saved = el.getAttribute('style');
        el.setAttribute('style', (saved || '') + ';position:static!important;top:auto!important;bottom:auto!important;');
        const r = el.getBoundingClientRect();
        s.naturalTop = r.top + base;
        s.naturalBottom = s.naturalTop + r.height;
        el.setAttribute('style', saved || '');
      } catch (e) { /* 무시 */ }
    }
    return { fixed: fixed, sticky: sticky };
  }

  /* ---------- lazy 사전 로딩 ---------- */
  function waitImg(img) {
    return new Promise(function (res) {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', res, { once: true });
    });
  }

  async function lazyPrepass(total) {
    const vh = viewportH();
    const step = Math.max(Math.round(vh * 1.5), 600);
    let steps = 0;
    for (let y = vh; y < total && steps < MAX_PREPASS_STEPS; y += step, steps++) {
      setScrollY(y);
      await raf();
      await sleep(40);
    }
    setScrollY(Math.max(0, total - vh)); /* 끝에서 한 번 더(무한 스크롤 트리거용) */
    await raf();
    await sleep(80);
    try {
      const pend = Array.prototype.slice.call(document.images || []).filter(function (i) { return !i.complete; });
      if (pend.length) await Promise.race([Promise.all(pend.map(waitImg)), sleep(2500)]);
      if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(1200)]);
    } catch (e) { /* 무시 */ }
    setScrollY(0);
    await raf();
  }

  /* ---------- 스타일 오버라이드 ---------- */
  function applyHidden(entry, hide) {
    try {
      if (hide) entry.el.setAttribute('style', (entry.baseStyle || '') + ';visibility:hidden!important');
      else entry.el.setAttribute('style', entry.baseStyle || '');
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 공개 API ---------- */
  async function init() {
    if (ctx) { try { await restore(); } catch (e) { /* 무시 */ } }
    const doc = document.documentElement;
    ctx = {
      origX: window.pageXOffset || 0,
      origY: 0,
      scrollerEl: null,
      scrollerHadClass: false,
      fixed: [],
      sticky: [],
      htmlStyleAttr: doc.getAttribute('style'),
      styleEl: null,
    };
    ctx.origY = currentY();

    /* smooth 스크롤 무효화(정확한 좌표 이동 보장) */
    doc.setAttribute('style', (ctx.htmlStyleAttr || '') + ';scroll-behavior:auto!important;');

    /* 뷰포트 스크롤바 숨김(폭 일정 유지 + 반복 스크롤바 제거) */
    ctx.styleEl = document.createElement('style');
    ctx.styleEl.setAttribute('data-fpc', '1');
    ctx.styleEl.textContent =
      'html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
      'html{scrollbar-width:none!important}' +
      '.fpc-nosb::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
      '.fpc-nosb{scrollbar-width:none!important}';
    (doc.head || doc).appendChild(ctx.styleEl);
    await raf();

    /* 내부 스크롤 컨테이너 판별 */
    ctx.scrollerEl = findInnerScroller();
    if (ctx.scrollerEl && !ctx.scrollerEl.classList.contains('fpc-nosb')) {
      ctx.scrollerEl.classList.add('fpc-nosb');
      ctx.scrollerHadClass = true;
    }

    let total = totalHeight();
    /* 긴 페이지는 빠른 예비 스크롤로 lazy 콘텐츠 사전 로딩 */
    if (Math.ceil(total / viewportH()) > 3) await lazyPrepass(total);
    total = totalHeight();

    const collected = collectFixedSticky();
    ctx.fixed = collected.fixed;
    ctx.sticky = collected.sticky;

    return {
      viewportW: viewportW(),
      viewportH: viewportH(),
      docHeight: total,
      docWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0, viewportW()),
      dpr: window.devicePixelRatio || 1,
      innerScroller: !!ctx.scrollerEl,
    };
  }

  async function prepSegment(index, y) {
    if (!ctx) throw new Error('init이 호출되지 않았습니다.');
    const vh = viewportH();
    const maxY = Math.max(0, totalHeight() - vh);
    const target = Math.max(0, Math.min(y, maxY));

    /* fixed: 첫 세그먼트(페이지 최상단)에만 표시 → 중복 합성 방지 */
    for (let i = 0; i < ctx.fixed.length; i++) applyHidden(ctx.fixed[i], index > 0);

    /* sticky: 자연 위치가 이 세그먼트 뷰포트 범위와 겹칠 때만 표시 */
    for (let i = 0; i < ctx.sticky.length; i++) {
      const s = ctx.sticky[i];
      const inter = s.naturalBottom > target + 4 && s.naturalTop < target + vh - 4;
      applyHidden(s, !inter);
    }

    setScrollY(target);
    await waitScrollSettle(target);
    await sleep(70); /* 페인트/이미지 안정화 */
    return { actualY: currentY() };
  }

  async function restore() {
    if (!ctx) return { restored: true };
    const c = ctx;
    try {
      if (c.scrollerEl) c.scrollerEl.scrollTop = c.origY;
      else window.scrollTo(c.origX, c.origY);
      await waitScrollSettle(c.origY, 400);
    } catch (e) { /* 무시 */ }
    for (let i = 0; i < c.fixed.length; i++) applyHidden(c.fixed[i], false);
    for (let i = 0; i < c.sticky.length; i++) applyHidden(c.sticky[i], false);
    if (c.scrollerEl && c.scrollerHadClass) {
      try { c.scrollerEl.classList.remove('fpc-nosb'); } catch (e) { /* 무시 */ }
    }
    if (c.styleEl && c.styleEl.parentNode) c.styleEl.parentNode.removeChild(c.styleEl);
    const doc = document.documentElement;
    if (c.htmlStyleAttr === null) doc.removeAttribute('style');
    else doc.setAttribute('style', c.htmlStyleAttr);
    ctx = null;
    await raf();
    return { restored: true };
  }

  /* 테스트 훅(확장 환경 밖 실제 브라우저에서도 로직 검증 가능) */
  self.__FPC_TEST = { init: init, prepSegment: prepSegment, restore: restore, _ctx: function () { return ctx; } };

  /* 확장 런타임 메시지 수신 */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      (async function () {
        try {
          switch (msg && msg.type) {
            case 'FPC_PING': sendResponse({ ok: true, data: { pong: true } }); break;
            case 'FPC_INIT': sendResponse({ ok: true, data: await init() }); break;
            case 'FPC_PREP': sendResponse({ ok: true, data: await prepSegment(msg.index, msg.y) }); break;
            case 'FPC_RESTORE': sendResponse({ ok: true, data: await restore() }); break;
            default: sendResponse({ ok: false, error: '알 수 없는 메시지입니다.' });
          }
        } catch (e) {
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        }
      })();
      return true; /* 비동기 sendResponse */
    });
  }
})();
