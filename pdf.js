/*
 * Full Page Capture - PDF 생성 (팝업에서 실행)
 * 기본: A4 세로형 여러 페이지 자동 분할. 가로가 더 긴 이미지(현재 화면 캡처 등)는 A4 가로형.
 * 이미지 비율을 유지하며 페이지 폭에 맞추고, 페이지 경계에서 정확히 분할한다(왜곡 없음).
 * jsPDF(확장 프로그램 내부 vendor 포함, MIT) 사용 - 외부 CDN 사용 없음(MV3 CSP 준수).
 */
(function (global) {
  'use strict';

  async function buildPdf(dataUrl, opts) {
    opts = opts || {};
    const img = await FPC.loadImage(dataUrl);
    const jsPDFCtor = global.jspdf && global.jspdf.jsPDF;
    if (!jsPDFCtor) throw new Error('PDF 엔진을 불러오지 못했습니다.');

    const landscape = img.width > img.height;
    const pdf = new jsPDFCtor({
      orientation: landscape ? 'landscape' : 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 0; /* 여백 0: 콘텐츠 최대 활용 */
    const contentW = pageW - margin * 2;
    const contentH = pageH - margin * 2;

    /* 이미지 폭을 페이지 폭에 맞춤(비율 유지) → 한 페이지에 들어가는 원본 px 계산 */
    const mmPerPx = contentW / img.width;
    const pxPerPage = Math.max(1, Math.floor(contentH / mmPerPx));
    const pages = Math.max(1, Math.ceil(img.height / pxPerPage));

    const cnv = document.createElement('canvas');
    cnv.width = img.width;
    const c = cnv.getContext('2d');

    for (let p = 0; p < pages; p++) {
      const sy = p * pxPerPage;
      const sh = Math.min(pxPerPage, img.height - sy);
      cnv.height = sh;
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, cnv.width, sh);
      c.drawImage(img, 0, sy, img.width, sh, 0, 0, img.width, sh);
      const sliceUrl = cnv.toDataURL('image/png');
      if (p > 0) pdf.addPage('a4', landscape ? 'landscape' : 'portrait');
      pdf.addImage(sliceUrl, 'PNG', margin, margin, contentW, sh * mmPerPx);
    }

    return pdf.output('blob');
  }

  global.FPC_BuildPdf = buildPdf;
})(typeof self !== 'undefined' ? self : globalThis);
