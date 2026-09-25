/*
 * Full Page Capture - 공용 유틸리티
 * 백그라운드 서비스 워커, 팝업, 미리보기 페이지, 테스트 페이지 모두에서 사용.
 * 외부 네트워크 접근 없음. 모든 처리는 로컬.
 */
(function (global) {
  'use strict';

  const FPC = {};

  /* ---------------- 파일명 ---------------- */
  const SECOND_TLDS = ['co', 'or', 'ne', 'go', 'ac', 'com', 'net', 'org', 'gov', 'edu', 're', 'pe'];

  FPC.sanitizeFilePart = function (s, maxLen) {
    maxLen = maxLen || 60;
    s = String(s == null ? '' : s)
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=?^~[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (s.length > maxLen) s = s.slice(0, maxLen).trim().replace(/[.\s]+$/, '');
    return s;
  };

  FPC.siteNameFromHost = function (host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!host) return 'capture';
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return host;
    if (/^\d+$/.test(parts[parts.length - 1])) return host;
    if (parts.length >= 3 && SECOND_TLDS.indexOf(parts[parts.length - 2]) !== -1) {
      return parts.slice(0, -2).join('.');
    }
    return parts.slice(0, -1).join('.');
  };

  FPC.siteNameFromUrl = function (url) {
    let host = '';
    try { host = new URL(url).hostname || ''; } catch (e) { host = ''; }
    return FPC.siteNameFromHost(host);
  };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  FPC.formatStamp = function (date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes());
  };

  /* 기본 형식: 사이트명_페이지제목_YYYY-MM-DD_HHmm */
  FPC.buildBaseFilename = function (opt) {
    opt = opt || {};
    const site = FPC.sanitizeFilePart(FPC.siteNameFromUrl(opt.url), 24) || 'capture';
    const title = FPC.sanitizeFilePart(opt.title, 30);
    const stamp = FPC.formatStamp(opt.date);
    let base = title ? (site + '_' + title + '_' + stamp) : (site + '_' + stamp);
    if (base.length > 90) base = base.slice(0, 90);
    return base;
  };

  /* ---------------- 세그먼트 계산 ---------------- */
  FPC.computeSegments = function (docHeight, viewportH, maxDocHeight) {
    const limit = (typeof maxDocHeight === 'number' && maxDocHeight > 0) ? maxDocHeight : Infinity;
    const eff = Math.max(1, Math.min(docHeight, limit));
    const vh = Math.max(1, viewportH);
    const count = Math.max(1, Math.ceil((eff - 0.01) / vh));
    const segments = [];
    for (let i = 0; i < count; i++) {
      const y = i * vh;
      segments.push({ index: i, y: y, h: Math.min(vh, eff - y) });
    }
    return { segments: segments, plannedHeight: eff, truncated: docHeight > limit + 0.5, pageCount: count };
  };

  /* ---------------- 캔버스 한도 ---------------- */
  FPC.MAX_CANVAS_AREA = 160e6; /* 안전 상한(픽셀 수) */
  FPC.MAX_CANVAS_SIDE = 60000; /* 한 변 최대(픽셀) */

  FPC.capScale = function (w, h, maxArea, maxSide) {
    maxArea = maxArea || FPC.MAX_CANVAS_AREA;
    maxSide = maxSide || FPC.MAX_CANVAS_SIDE;
    w = Math.max(1, w); h = Math.max(1, h);
    return Math.min(1, Math.sqrt(maxArea / (w * h)), maxSide / h, maxSide / w);
  };

  /* ---------------- dataURL / Blob ---------------- */
  FPC.bytesToBase64 = function (u8) {
    let out = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + CH)));
    }
    return btoa(out);
  };

  FPC.dataUrlToBlob = function (dataUrl) {
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    if (s.indexOf('data:') !== 0 || comma < 0) throw new Error('잘못된 이미지 데이터입니다.');
    const header = s.slice(5, comma);
    const payload = s.slice(comma + 1);
    const isB64 = /;base64/i.test(header);
    const mime = header.split(';')[0] || 'image/png';
    if (isB64) {
      const bin = atob(payload);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  };

  FPC.blobToDataUrl = async function (blob) {
    const buf = await blob.arrayBuffer();
    return 'data:' + (blob.type || 'image/png') + ';base64,' + FPC.bytesToBase64(new Uint8Array(buf));
  };

  /* ---------------- 표시용 ---------------- */
  FPC.formatBytes = function (n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024) return '약 ' + (n / (1024 * 1024)).toFixed(1) + 'MB';
    if (n >= 1024) return '약 ' + Math.round(n / 1024) + 'KB';
    return n + 'B';
  };

  /* ---------------- 세그먼트 합성 (서비스 워커 / 페이지 공용) ----------------
   * shots: [{ dataUrl, actualY }]  opts: { viewportW, docHeight, maxArea }
   * 각 캡처는 viewport 크기이며, 실제 스크롤 위치(actualY)에 정확히 배치하여
   * 1~2px 틈 / 중복 / 텍스트 잘림이 없도록 한다. 마지막 영역은 캔버스 경계로 자동 crop.
   */
  FPC.stitchSegments = async function (shots, opts) {
    if (!shots || !shots.length) throw new Error('캡처된 이미지가 없습니다.');
    const docHeight = opts.docHeight;
    const viewportW = Math.max(1, opts.viewportW);
    let scale = 1, s2 = 1, canvas = null, ctx = null;
    for (let i = 0; i < shots.length; i++) {
      const blob = FPC.dataUrlToBlob(shots[i].dataUrl);
      const bmp = await createImageBitmap(blob);
      if (i === 0) {
        scale = bmp.width / viewportW; /* 실제 캡처 배율(devicePixelRatio/zoom 반영) */
        const outW = bmp.width;
        const outH = Math.round(docHeight * scale);
        s2 = FPC.capScale(outW, outH, opts.maxArea);
        canvas = FPC.createCanvas(Math.max(1, Math.round(outW * s2)), Math.max(1, Math.round(outH * s2)));
        ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
      }
      const dy = Math.round(shots[i].actualY * scale * s2);
      /* +1px 여유로 반올림 틈 방지(캔버스 경계 밖은 자동으로 잘림) */
      const dh = Math.round(bmp.height * s2) + 1;
      const dw = Math.round(bmp.width * s2);
      ctx.drawImage(bmp, 0, dy, dw, dh);
      if (bmp.close) bmp.close();
    }
    const outBlob = await FPC.canvasToBlob(canvas);
    return { blob: outBlob, width: canvas.width, height: canvas.height, scaledDown: s2 < 1 };
  };

  FPC.createCanvas = function (w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  FPC.canvasToBlob = function (canvas) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('이미지 변환에 실패했습니다.')); }, 'image/png');
    });
  };

  FPC.loadImage = function (src) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('이미지를 불러올 수 없습니다.')); };
      img.src = src;
    });
  };

  global.FPC = FPC;
})(typeof self !== 'undefined' ? self : globalThis);
