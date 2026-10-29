// 扩展和本机服务共用：只看文件头，判断图片类型和像素尺寸。

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes, start, end) {
  let out = "";
  const stop = Math.min(end, bytes.length);
  for (let i = start; i < stop; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function indexOfBytes(bytes, pattern, from = 0) {
  outer: for (let i = from; i <= bytes.length - pattern.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function sniffImage(bytes) {
  if (!bytes || bytes.length < 2) return null;
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") {
    return { mime: "image/png", ext: ".png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return { mime: "image/gif", ext: ".gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: ".webp" };
  }
  if (ascii(bytes, 0, 2) === "BM") return { mime: "image/bmp", ext: ".bmp" };
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, Math.min(bytes.length, 64));
    if (brand.includes("avif") || brand.includes("avis")) return { mime: "image/avif", ext: ".avif" };
  }
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const head = ascii(bytes, start, start + 256).trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return { mime: "image/svg+xml", ext: ".svg" };
  }
  return null;
}

export function readImageSize(bytes) {
  const kind = sniffImage(bytes);
  if (!kind) return null;
  if (kind.mime === "image/png") return readPng(bytes);
  if (kind.mime === "image/gif") return readGif(bytes);
  if (kind.mime === "image/bmp") return readBmp(bytes);
  if (kind.mime === "image/jpeg") return readJpeg(bytes);
  if (kind.mime === "image/webp") return readWebp(bytes);
  return null;
}

function finiteSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0 || width > 200000 || height > 200000) return null;
  return { width, height };
}

function readPng(bytes) {
  if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return null;
  const view = viewOf(bytes);
  return finiteSize(view.getUint32(16), view.getUint32(20));
}

function readGif(bytes) {
  if (bytes.length < 10) return null;
  const view = viewOf(bytes);
  return finiteSize(view.getUint16(6, true), view.getUint16(8, true));
}

function readBmp(bytes) {
  if (bytes.length < 26) return null;
  const view = viewOf(bytes);
  return finiteSize(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
}

function readJpeg(bytes) {
  const view = viewOf(bytes);
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) return null;
    const len = view.getUint16(i + 2);
    if (len < 2 || i + 2 + len > bytes.length) return null;
    const isSizeMarker = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSizeMarker) return finiteSize(view.getUint16(i + 7), view.getUint16(i + 5));
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

function readWebp(bytes) {
  const view = viewOf(bytes);
  let offset = 12;
  let fallback = null;
  while (offset + 8 <= bytes.length) {
    const tag = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (dataStart + size > bytes.length) break;
    if (tag === "VP8X" && size >= 10) {
      const width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
      const height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
      return finiteSize(width, height);
    }
    if ((tag === "VP8 " || tag === "VP8L") && !fallback) fallback = { tag, dataStart, size };
    offset = dataStart + size + (size % 2);
  }
  if (!fallback) return null;
  if (fallback.tag === "VP8L") {
    if (fallback.size < 5 || bytes[fallback.dataStart] !== 0x2f) return null;
    const bits = view.getUint32(fallback.dataStart + 1, true);
    return finiteSize((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  const data = bytes.subarray(fallback.dataStart, fallback.dataStart + fallback.size);
  const sig = indexOfBytes(data, [0x9d, 0x01, 0x2a]);
  if (sig < 0 || sig + 7 > data.length) return null;
  const dataView = viewOf(data);
  return finiteSize(dataView.getUint16(sig + 3, true) & 0x3fff, dataView.getUint16(sig + 5, true) & 0x3fff);
}
