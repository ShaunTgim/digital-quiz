// 考卷 PDF 產生器：題目頁 + 答案頁。字型以 TrueType 子集嵌入（Identity-H）。
(function (root) {
  const PAPER = { B4: [728.5, 1031.8], A4: [595.3, 841.9] };

  function unesc(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  // 題庫的少量 HTML（<sub>、<sup>、行內圖）轉成片段 [{t, sc}] / [{img, w, h}]
  function toRuns(html) {
    const runs = [];
    const re = /<(sub|sup)>(.*?)<\/\1>|<img class="ico" src="([^"]+)" alt="" data-w="([\d.]+)" data-h="([\d.]+)"[^>]*>/g;
    let last = 0, m;
    const plain = t => unesc(t.replace(/<[^>]+>/g, ""));
    while ((m = re.exec(html))) {
      if (m.index > last) runs.push({ t: plain(html.slice(last, m.index)), sc: null });
      if (m[1]) runs.push({ t: plain(m[2]), sc: m[1] });
      else runs.push({ img: m[3], w: +m[4], h: +m[5] });
      last = re.lastIndex;
    }
    if (last < html.length) runs.push({ t: plain(html.slice(last)), sc: null });
    return runs.filter(r => r.img || r.t.length);
  }

  const NOBREAK_BEFORE = "，。、？！；：）」』,.;:)?!%";
  async function build(o) {
    const { PDFLib, fontBytes, font, items, chLabel, paper = "B4", title = "考卷" } = o;
    const { PDFDocument, PDFName, PDFString, PDFHexString, rgb } = PDFLib;
    const [PW, PH] = PAPER[paper] || PAPER.B4;
    const k = PW / PAPER.B4[0];                 // A4 時等比縮小版面
    const FS = 11 * Math.max(k, 0.9), LH = FS * 1.42, SUBK = 0.68;
    const ML = 43 * k, MR = PW - 43 * k, TOP = 64 * k, BOTTOM = PH - 44 * k;
    const NUMX = ML, TX = ML + 54 * k, TW = MR - TX;
    const map = font.map;

    const doc = await PDFDocument.create();
    doc.setTitle(title + " " + chLabel);
    const ctx = doc.context;
    // ---- 字型 ----
    const ff = ctx.flateStream(fontBytes, { Length1: fontBytes.length });
    const ffRef = ctx.register(ff);
    const desc = ctx.obj({
      Type: "FontDescriptor", FontName: "NotoSansTC", Flags: 4, FontBBox: font.meta.bbox,
      ItalicAngle: 0, Ascent: font.meta.ascent, Descent: font.meta.descent, CapHeight: font.meta.cap, StemV: 80, FontFile2: ffRef,
    });
    const used = new Map();
    const glyph = ch => {
      const g = map[ch] || map["?"];
      used.set(g[0], ch);
      return g;
    };
    const width = (t, size) => { let w = 0; for (const ch of t) w += ((map[ch] || map["?"])[1] / 1000) * size; return w; };
    const hex = t => { let h = ""; for (const ch of t) h += glyph(ch)[0].toString(16).padStart(4, "0"); return PDFHexString.of(h); };

    const pages = [];
    let page, y;
    const F1 = PDFName.of("F1");
    function header() {
      page = doc.addPage([PW, PH]);
      pages.push(page);
      const hy = 37 * k;
      text(page, "Name:", 48 * k, hy, 10.5 * k);
      text(page, "Ch:" + chLabel, 263 * k, hy, 10.5 * k);
      text(page, "S:", 481 * k, hy, 10.5 * k);
      y = TOP;
    }
    function text(pg, t, x, yTop, size) {
      // yTop：以頁面上緣為 0 的基線位置
      pg.pushOperators(
        PDFLib.beginText(), PDFLib.setFontAndSize(F1, size),
        PDFLib.moveText(x, PH - yTop), PDFLib.showText(hex(t)), PDFLib.endText()
      );
    }

    // ---- 斷行 ----
    const embedded = {};
    async function inlineImg(it, src) {
      if (!embedded[src]) embedded[src] = await doc.embedJpg(it.inl[src].bytes);
      return embedded[src];
    }
    function atoms(runs) {
      const out = [];
      for (const r of runs) {
        if (r.img) {
          const s0 = Math.min(k, TW / r.w);
          out.push({ img: r.img, w: r.w * s0, ih: r.h * s0, sp: false, nl: false, t: "" });
          continue;
        }
        const size = r.sc ? FS * SUBK : FS;
        if (r.keep) { out.push({ t: r.t, sc: null, size, w: width(r.t, size), nl: false, sp: false }); continue; }
        const parts = r.t.match(/\n|[A-Za-z0-9.+\-_'":=<>*/#%&@$^~`|\\]+|\s+|./gsu) || [];
        for (const p of parts) out.push({ t: p, sc: r.sc, size, w: p === "\n" ? 0 : width(p, size), nl: p === "\n", sp: /^\s+$/.test(p) && p !== "\n" });
      }
      return out;
    }
    function layout(runs, w0) {
      const lines = [[]]; let x = 0;
      for (const a of atoms(runs)) {
        let line = lines[lines.length - 1];
        if (a.nl) { lines.push([]); x = 0; continue; }
        if (a.sp && x === 0) continue;
        const fits = x + a.w <= w0 + 0.01 || (!a.img && NOBREAK_BEFORE.includes(a.t)) || x === 0;
        if (!fits) {
          if (a.sp) { lines.push([]); x = 0; continue; }
          if (!a.img && a.w > w0) { // 過長的英數串：拆字
            for (const ch of a.t) {
              const cw = width(ch, a.size);
              if (x + cw > w0) { lines.push([]); x = 0; }
              lines[lines.length - 1].push({ ...a, t: ch, w: cw, x }); x += cw;
            }
            continue;
          }
          lines.push([]); x = 0; line = lines[lines.length - 1];
        }
        line.push({ ...a, x }); x += a.w;
      }
      return lines.filter((l, i) => l.length || i === 0);
    }
    // 每行：上緣到基線的距離與行高（行內圖會撐高該行）
    const lineAsc = ln => Math.max(FS, ...ln.filter(a => a.img).map(a => a.ih - FS * 0.2 + 2));
    const lineAdv = ln => lineAsc(ln) + (LH - FS);
    const linesH = lines => lines.reduce((s, ln) => s + lineAdv(ln), 0);
    async function drawLines(it, lines, x0, top) {
      let firstBase = null;
      for (const ln of lines) {
        const base = top + lineAsc(ln);
        if (firstBase === null) firstBase = base;
        let buf = null;
        const flush = () => {
          if (buf && buf.t.trim()) text(page, buf.t, x0 + buf.x, base + (buf.sc === "sub" ? FS * 0.22 : buf.sc === "sup" ? -FS * 0.38 : 0), buf.size);
          buf = null;
        };
        for (const a of ln) {
          if (a.img) {
            flush();
            const im = await inlineImg(it, a.img);
            page.drawImage(im, { x: x0 + a.x, y: PH - (base + FS * 0.2) , width: a.w, height: a.ih });
            continue;
          }
          if (buf && buf.sc === a.sc) buf.t += a.t; else { flush(); buf = { t: a.t, x: a.x, sc: a.sc, size: a.size }; }
        }
        flush();
        top += lineAdv(ln);
      }
      return { top, firstBase };
    }

    // ---- 題目 ----
    header();
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const stemRuns = toRuns(it.stem).concat([{ t: " ", sc: null }, { t: "- " + it.ref, sc: null, keep: true }]);
      const stemL = layout(stemRuns, TW);
      let optL = [];
      if (!it.imgOpts) {
        const runs = [];
        it.opts.forEach((o, i) => {
          if (i) runs.push({ t: "   ", sc: null });
          runs.push({ t: "(" + "ABCDE"[i] + ")", sc: null });
          runs.push(...toRuns(o));
        });
        optL = layout(runs, TW);
      }
      const imgs = [];
      for (const im0 of it.imgs || []) imgs.push({ ...im0, pdf: await doc.embedJpg(im0.bytes) });
      imgs.forEach(im => {
        const s0 = Math.min(k, TW / im.w, (340 * k) / im.h);
        im.dw = im.w * s0; im.dh = im.h * s0;
      });
      const imgH = imgs.reduce((s, im) => s + im.dh + 6, 0);
      const blockH = linesH(stemL) + linesH(optL) + imgH + 4;
      if (y + blockH > BOTTOM && y > TOP) header();
      const r1 = await drawLines(it, stemL, TX, y);
      text(page, (n + 1) + ".(", NUMX, r1.firstBase, FS);
      text(page, ")", NUMX + 38 * k, r1.firstBase, FS);
      let cy = r1.top;
      for (const im of imgs) {
        page.drawImage(im.pdf, { x: TX, y: PH - (cy + 2) - im.dh, width: im.dw, height: im.dh });
        cy += im.dh + 6;
      }
      if (optL.length) cy = (await drawLines(it, optL, TX, cy)).top;
      y = cy + 3 * k;
    }

    // ---- 答案頁 ----
    const N = items.length;
    const rows = Math.min(25, Math.ceil(N / 2));
    const pairsTotal = Math.ceil(N / rows);
    const PER_PAGE = 4;
    const RH = 18.4 * k, green = rgb(0.851, 0.949, 0.816), black = rgb(0, 0, 0);
    for (let p0 = 0; p0 < pairsTotal; p0 += PER_PAGE) {
      header();
      const pairs = Math.min(PER_PAGE, pairsTotal - p0);
      const colW = Math.min(128.6 * k, (MR - ML) / (pairs * 2));
      const x0 = ML, t0 = TOP;
      const tableRows = rows + 1;
      // 底色
      for (let pi = 0; pi < pairs; pi++) for (let r = 0; r < rows; r++) {
        if (Math.floor(r / 5) % 2 === 0) page.drawRectangle({ x: x0 + pi * 2 * colW, y: PH - (t0 + (r + 2) * RH), width: colW, height: RH, color: green });
      }
      // 格線
      const W = pairs * 2 * colW;
      for (let r = 0; r <= tableRows; r++) page.drawLine({ start: { x: x0, y: PH - (t0 + r * RH) }, end: { x: x0 + W, y: PH - (t0 + r * RH) }, thickness: 0.6, color: black });
      for (let c = 0; c <= pairs * 2; c++) page.drawLine({ start: { x: x0 + c * colW, y: PH - t0 }, end: { x: x0 + c * colW, y: PH - (t0 + tableRows * RH) }, thickness: 0.6, color: black });
      for (let pi = 0; pi < pairs; pi++) {
        text(page, "NO", x0 + pi * 2 * colW + 4 * k, t0 + RH - 5 * k, 10.5 * k);
        text(page, "ANS", x0 + (pi * 2 + 1) * colW + 4 * k, t0 + RH - 5 * k, 10.5 * k);
        for (let r = 0; r < rows; r++) {
          const idx = (p0 + pi) * rows + r;
          if (idx >= N) break;
          const base = t0 + (r + 2) * RH - 5 * k;
          text(page, String(idx + 1), x0 + pi * 2 * colW + 4 * k, base, 9.5 * k);
          text(page, items[idx].ans, x0 + (pi * 2 + 1) * colW + 4 * k, base, 9.5 * k);
        }
      }
    }

    // ---- 字型物件（最後建立，W 與 ToUnicode 只列實際用到的字）----
    const gids = [...used.keys()].sort((a, b) => a - b);
    const W = [];
    for (const g of gids) { const ch = used.get(g); W.push(g, [Math.round((map[ch] || map["?"])[1])]); }
    let cm = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
    for (let i = 0; i < gids.length; i += 100) {
      const chunk = gids.slice(i, i + 100);
      cm += chunk.length + " beginbfchar\n";
      for (const g of chunk) {
        const cp = used.get(g).codePointAt(0);
        const u = cp > 0xffff ? (() => { const v = cp - 0x10000; return ((0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 1023)).toString(16)); })() : cp.toString(16).padStart(4, "0");
        cm += "<" + g.toString(16).padStart(4, "0") + "> <" + u + ">\n";
      }
      cm += "endbfchar\n";
    }
    cm += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
    const tuRef = ctx.register(ctx.flateStream(cm));
    const cidRef = ctx.register(ctx.obj({
      Type: "Font", Subtype: "CIDFontType2", BaseFont: "NotoSansTC",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
      FontDescriptor: ctx.register(desc), CIDToGIDMap: "Identity", DW: 1000, W,
    }));
    const t0Ref = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "NotoSansTC", Encoding: "Identity-H", DescendantFonts: [cidRef], ToUnicode: tuRef }));
    for (const pg of pages) pg.node.setFontDictionary(F1, t0Ref);
    return await doc.save();
  }

  const api = { build, toRuns, PAPER };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ExamPDF = api;
})(typeof window !== "undefined" ? window : globalThis);
