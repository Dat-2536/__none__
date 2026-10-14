"use strict";

const { PDFDocument } = PDFLib;
const A4 = [595.28, 841.89];
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|tiff?|avif)$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- helpers ----------

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

function safeName(name, fallback) {
  const s = (name || "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return s || fallback;
}

function isImage(file) {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Reads the EXIF orientation of a JPEG (1 = normal). */
function jpegOrientation(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little);
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error("Trình duyệt không đọc được ảnh này (HEIC chưa được hỗ trợ).");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function drawToCanvas(bmp, scale = 1, whiteBg = false) {
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (whiteBg) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Không mã hóa được ảnh."))), type, quality)
  );
}

/** Returns { bytes, kind: "jpg" | "png" } ready for pdf-lib. */
async function imageForPdf(file, compress) {
  const isJpeg = /jpe?g|jfif/i.test(file.type) || /\.(jpe?g|jfif)$/i.test(file.name);
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);

  if (!compress) {
    const buf = await file.arrayBuffer();
    if (isJpeg && jpegOrientation(buf) === 1) return { bytes: buf, kind: "jpg" };
    if (isPng) return { bytes: buf, kind: "png" };
  }

  const bmp = await loadBitmap(file);
  if (compress) {
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const blob = await canvasBlob(drawToCanvas(bmp, scale, true), "image/jpeg", 0.8);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  if (isJpeg) {
    const blob = await canvasBlob(drawToCanvas(bmp, 1, true), "image/jpeg", 0.92);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  const blob = await canvasBlob(drawToCanvas(bmp), "image/png");
  return { bytes: await blob.arrayBuffer(), kind: "png" };
}

async function addImagePage(doc, file, { pageMode = "image", compress = false } = {}) {
  const { bytes, kind } = await imageForPdf(file, compress);
  let img;
  try {
    img = kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch {
    // Some exotic PNG/JPEG variants trip pdf-lib; re-encode through canvas.
    const bmp = await loadBitmap(file);
    const blob = await canvasBlob(drawToCanvas(bmp), "image/png");
    img = await doc.embedPng(await blob.arrayBuffer());
  }

  if (pageMode === "a4") {
    const landscape = img.width > img.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  } else {
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
}

// ---------- file lists ----------

const lists = { img2pdf: [], merge: [], compress: [] };
const accepts = {
  img2pdf: isImage,
  merge: (f) => isPdf(f) || isImage(f),
  compress: isImage,
};
let uid = 0;

function addFiles(key, files) {
  const ok = [...files].filter(accepts[key]);
  const skipped = files.length - ok.length;
  for (const file of ok) {
    lists[key].push({
      id: ++uid,
      file,
      thumb: isImage(file) ? URL.createObjectURL(file) : null,
    });
  }
  if (skipped) toast(`Bỏ qua ${skipped} file không đúng định dạng.`);
  renderList(key);
}

function removeItem(key, id) {
  const i = lists[key].findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = lists[key].splice(i, 1);
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  renderList(key);
}

function moveItem(key, from, to) {
  const arr = lists[key];
  if (to < 0 || to >= arr.length) return;
  const [it] = arr.splice(from, 1);
  arr.splice(to, 0, it);
  renderList(key);
}

function renderList(key) {
  const box = $(`[data-list="${key}"]`);
  const arr = lists[key];
  box.innerHTML = "";
  arr.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "item";
    row.draggable = true;
    row.dataset.idx = idx;
    row.innerHTML = `
      <span class="grip" title="Kéo để đổi thứ tự">⋮⋮</span>
      ${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : `<span class="thumb">📄</span>`}
      <div class="meta">
        <div class="name"></div>
        <div class="size">${idx + 1}. ${fmtSize(it.file.size)}</div>
      </div>
      <div class="btns">
        <button data-act="up" title="Lên">↑</button>
        <button data-act="down" title="Xuống">↓</button>
        <button data-act="del" title="Xóa">✕</button>
      </div>`;
    $(".name", row).textContent = it.file.name;
    $(".name", row).title = it.file.name;
    row.addEventListener("click", (e) => {
      const act = e.target.dataset?.act;
      if (act === "up") moveItem(key, idx, idx - 1);
      if (act === "down") moveItem(key, idx, idx + 1);
      if (act === "del") removeItem(key, it.id);
    });
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-idx", String(idx));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/x-idx")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      const from = e.dataTransfer.getData("text/x-idx");
      if (from === "") return;
      e.preventDefault();
      e.stopPropagation();
      moveItem(key, Number(from), idx);
    });
    box.appendChild(row);
  });

  const runBtn = { img2pdf: "#i2p-run", merge: "#merge-run", compress: "#c-run" }[key];
  $(runBtn).disabled = arr.length === 0;
}

// ---------- results ----------

function resultsHeader(box, title, zipItems, zipName) {
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `<strong></strong>`;
  $("strong", head).textContent = title;
  if (zipItems && zipItems.length > 1) {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = `Tải tất cả (.zip)`;
    btn.onclick = async () => {
      btn.disabled = true;
      const zip = new JSZip();
      const used = new Set();
      for (const { blob, name } of zipItems) {
        let n = name;
        for (let k = 2; used.has(n); k++) n = `${baseName(name)} (${k})${name.slice(baseName(name).length)}`;
        used.add(n);
        zip.file(n, blob);
      }
      download(await zip.generateAsync({ type: "blob" }), zipName);
      btn.disabled = false;
    };
    head.appendChild(btn);
  }
  box.appendChild(head);
}

function resultRow(box, { name, blob, info, error }) {
  const row = document.createElement("div");
  row.className = "res" + (error ? " error" : "");
  row.innerHTML = `<div class="meta"><div class="name"></div><div class="size"></div></div>`;
  $(".name", row).textContent = name;
  const size = $(".size", row);
  if (error) {
    size.textContent = error;
  } else {
    size.innerHTML = info || fmtSize(blob.size);
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Tải về";
    btn.onclick = () => download(blob, name);
    row.appendChild(btn);
  }
  box.appendChild(row);
}

function progressBar(box) {
  box.innerHTML = `<div class="progress"><div></div></div>`;
  const bar = $(".progress > div", box);
  return (done, total) => (bar.style.width = `${(done / total) * 100}%`);
}

async function withBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang xử lý…";
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast("Lỗi: " + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- Ảnh → PDF ----------

async function runImg2Pdf() {
  const items = lists.img2pdf;
  const mode = $("#i2p-mode").value;
  const opts = { pageMode: $("#i2p-page").value, compress: $("#i2p-quality").value === "compress" };
  const box = $("#i2p-results");
  const setProgress = progressBar(box);

  if (mode === "one") {
    const doc = await PDFDocument.create();
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      try {
        await addImagePage(doc, items[i].file, opts);
      } catch (e) {
        errors.push({ name: items[i].file.name, error: e.message || String(e) });
      }
      setProgress(i + 1, items.length);
    }
    const name = safeName($("#i2p-name").value, "tong-hop") + ".pdf";
    resultsHeader(box, `Xong — ${doc.getPageCount()} trang`);
    if (doc.getPageCount()) {
      const blob = new Blob([await doc.save()], { type: "application/pdf" });
      resultRow(box, { name, blob, info: `${doc.getPageCount()} trang · ${fmtSize(blob.size)}` });
    }
    errors.forEach((e) => resultRow(box, e));
    return;
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    const name = baseName(f.name) + ".pdf";
    try {
      const doc = await PDFDocument.create();
      await addImagePage(doc, f, opts);
      results.push({ name, blob: new Blob([await doc.save()], { type: "application/pdf" }) });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong — ${ok.length}/${results.length} file`, ok, "anh-sang-pdf.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Gộp PDF ----------

async function runMerge() {
  const items = lists.merge;
  const box = $("#merge-results");
  const setProgress = progressBar(box);
  const out = await PDFDocument.create();
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      if (isPdf(f)) {
        const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else {
        await addImagePage(out, f);
      }
    } catch (e) {
      errors.push({ name: f.name, error: "Không đọc được: " + (e.message || e) });
    }
    setProgress(i + 1, items.length);
  }

  const name = safeName($("#merge-name").value, "da-gop") + ".pdf";
  resultsHeader(box, `Xong — ${out.getPageCount()} trang`);
  if (out.getPageCount()) {
    const blob = new Blob([await out.save()], { type: "application/pdf" });
    resultRow(box, { name, blob, info: `${out.getPageCount()} trang · ${fmtSize(blob.size)}` });
  }
  errors.forEach((e) => resultRow(box, e));
}

// ---------- Nén ảnh ----------

async function compressOne(file, { mode, targetKB, quality, maxDim, type }) {
  const bmp = await loadBitmap(file);
  const longEdge = Math.max(bmp.width, bmp.height);
  let scale = maxDim > 0 ? Math.min(1, maxDim / longEdge) : 1;
  const whiteBg = type === "image/jpeg";

  if (mode === "quality") {
    const blob = await canvasBlob(drawToCanvas(bmp, scale, whiteBg), type, quality);
    if (scale === 1 && blob.size >= file.size) return { blob: file, scale, kept: true };
    return { blob, scale };
  }

  const target = targetKB * 1024;
  if (file.size <= target && scale === 1) return { blob: file, scale, kept: true };

  let best = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const canvas = drawToCanvas(bmp, scale, whiteBg);
    let lo = 0.3, hi = 0.95, fit = null;
    for (let step = 0; step < 7; step++) {
      const q = (lo + hi) / 2;
      const blob = await canvasBlob(canvas, type, q);
      if (blob.size <= target) { fit = blob; lo = q; } else { hi = q; }
    }
    if (!fit) {
      const blob = await canvasBlob(canvas, type, lo);
      if (blob.size <= target) fit = blob;
      else if (!best || blob.size < best.size) best = blob;
    }
    if (fit) return { blob: fit, scale };
    scale *= 0.8;
  }
  return { blob: best, scale, missed: true };
}

async function runCompress() {
  const items = lists.compress;
  const type = $("#c-format").value;
  const ext = type === "image/webp" ? ".webp" : ".jpg";
  const opts = {
    mode: $("#c-mode").value,
    targetKB: Math.max(10, Number($("#c-target").value) || 500),
    quality: Number($("#c-quality").value) / 100,
    maxDim: Math.max(0, Number($("#c-maxdim").value) || 0),
    type,
  };
  const box = $("#c-results");
  const setProgress = progressBar(box);
  const results = [];
  let before = 0, after = 0;

  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      const r = await compressOne(f, opts);
      const name = r.kept ? f.name : baseName(f.name) + ext;
      const saved = Math.round((1 - r.blob.size / f.size) * 100);
      let info = `${fmtSize(f.size)} → <b>${fmtSize(r.blob.size)}</b>`;
      if (r.kept) info += ` · đã đủ nhỏ, giữ nguyên file gốc`;
      else if (saved > 0) info += ` · <span class="save">−${saved}%</span>`;
      if (r.scale < 1) info += ` · thu nhỏ ${Math.round(r.scale * 100)}%`;
      if (r.missed) info += ` · ⚠️ chưa đạt ${opts.targetKB} KB`;
      before += f.size;
      after += r.blob.size;
      results.push({ name, blob: r.blob, info });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }

  const ok = results.filter((r) => !r.error);
  const total = before ? ` · tổng ${fmtSize(before)} → ${fmtSize(after)}` : "";
  resultsHeader(box, `Xong — ${ok.length}/${results.length} ảnh${total}`, ok, "anh-da-nen.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- wiring ----------

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab.dataset.tab));
  })
);

$$(".drop").forEach((drop) => {
  const key = drop.dataset.target;
  const input = $("input", drop);
  input.addEventListener("change", () => {
    addFiles(key, input.files);
    input.value = "";
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("over");
    addFiles(key, e.dataTransfer.files);
  });
});

// Dropping files anywhere on the active panel also works.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.dataTransfer.files.length) return;
  const active = $(".panel.active .drop");
  if (active) addFiles(active.dataset.target, e.dataTransfer.files);
});

$$("[data-sort]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const key = btn.dataset.sort;
    lists[key].sort((a, b) =>
      a.file.name.localeCompare(b.file.name, "vi", { numeric: true, sensitivity: "base" })
    );
    renderList(key);
  })
);

$$("[data-clear]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const key = btn.dataset.clear;
    lists[key].forEach((it) => it.thumb && URL.revokeObjectURL(it.thumb));
    lists[key] = [];
    renderList(key);
  })
);

$("#i2p-mode").addEventListener("change", (e) => ($("#i2p-name-wrap").hidden = e.target.value !== "one"));
$("#c-mode").addEventListener("change", (e) => {
  $("#c-target-wrap").hidden = e.target.value !== "target";
  $("#c-quality-wrap").hidden = e.target.value !== "quality";
});
$("#c-quality").addEventListener("input", (e) => ($("#c-quality-val").textContent = e.target.value));

$("#i2p-run").addEventListener("click", (e) => withBusy(e.currentTarget, runImg2Pdf));
$("#merge-run").addEventListener("click", (e) => withBusy(e.currentTarget, runMerge));
$("#c-run").addEventListener("click", (e) => withBusy(e.currentTarget, runCompress));
