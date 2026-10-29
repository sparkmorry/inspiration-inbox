import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readImageSize, sniffImage } from "../extension/image-size.js";

const HOST = "127.0.0.1";
const PORT = 3921;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_BODY = 36 * 1024 * 1024;
const RECENT_LIMIT = 8;
const THUMB_EDGE = 480;

const COLLECTOR_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(COLLECTOR_DIR, "..");
const INBOX = path.join(ROOT, "inbox");
const INDEX_PATH = path.join(INBOX, ".index.json");
const GALLERY_PATH = path.join(COLLECTOR_DIR, "gallery.html");
const MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

let chain = Promise.resolve();

function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function pad(value, width = 2) {
  return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

function localParts(date) {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

function formatLocalIso(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${localParts(date).date}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function asString(value, max) {
  if (typeof value !== "string") return "";
  return value.replaceAll("\0", "").slice(0, max);
}

async function writeNote(relDir, note) {
  const metaPath = path.resolve(INBOX, relDir, "meta.json");
  const root = path.resolve(INBOX);
  if (!metaPath.startsWith(`${root}${path.sep}`)) return false;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.note = note.trim();
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeIndex(index) {
  await fs.mkdir(INBOX, { recursive: true });
  const tmp = `${INDEX_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`);
  await fs.rename(tmp, INDEX_PATH);
}

async function rebuildIndex() {
  const index = { byHash: {} };
  let dates = [];
  try {
    dates = await fs.readdir(INBOX, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const date of dates) {
    if (!date.isDirectory() || date.name.startsWith(".")) continue;
    const folders = await fs.readdir(path.join(INBOX, date.name), { withFileTypes: true });
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(INBOX, date.name, folder.name, "meta.json"), "utf8"));
        if (!meta?.contentHash) continue;
        index.byHash[meta.contentHash] = {
          id: meta.id,
          dir: `${date.name}/${folder.name}`,
          savedAt: meta.savedAt,
          pageTitle: meta.source?.pageTitle || "",
          likelyThumbnail: Boolean(meta.source?.likelyThumbnail),
        };
      } catch {
        // 跳过写坏的目录，不影响新的保存。
      }
    }
  }
  await writeIndex(index);
  return index;
}

async function loadIndex() {
  try {
    const data = JSON.parse(await fs.readFile(INDEX_PATH, "utf8"));
    if (!data || typeof data.byHash !== "object" || data.byHash === null) return rebuildIndex();
    return data;
  } catch {
    return rebuildIndex();
  }
}

function inboxFile(requestPath) {
  if (!requestPath.startsWith("/media/")) return null;
  const full = path.resolve(INBOX, requestPath.slice("/media/".length));
  const root = path.resolve(INBOX);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
  if (path.basename(full).startsWith(".")) return null;
  return full;
}

async function listItems() {
  await fs.mkdir(INBOX, { recursive: true });
  const index = await loadIndex();
  const items = [];
  for (const entry of Object.values(index.byHash)) {
    if (!entry?.dir || entry.dir.includes("..")) continue;
    try {
      const metaPath = path.resolve(INBOX, entry.dir, "meta.json");
      const root = path.resolve(INBOX);
      if (!metaPath.startsWith(`${root}${path.sep}`)) continue;
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      const image = meta.files?.image;
      if (typeof image !== "string" || !/^source\.[a-z0-9]+$/i.test(image)) continue;
      const parts = entry.dir.split("/").filter(Boolean).map(encodeURIComponent);
      items.push({
        id: meta.id,
        savedAt: meta.savedAt,
        pageTitle: meta.source?.pageTitle || "",
        pageUrl: meta.source?.pageUrl || "",
        alt: meta.source?.alt || "",
        width: meta.source?.width ?? null,
        height: meta.source?.height ?? null,
        likelyThumbnail: Boolean(meta.source?.likelyThumbnail),
        note: typeof meta.note === "string" ? meta.note : "",
        imageUrl: `/media/${parts.join("/")}/${encodeURIComponent(image)}`,
      });
    } catch {
      // 跳过读不到的条目。
    }
  }
  items.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return items;
}

function recentItems(index) {
  return Object.values(index.byHash)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .slice(0, RECENT_LIMIT)
    .map((item) => ({
      id: item.id,
      dir: item.dir,
      savedAt: item.savedAt,
      pageTitle: item.pageTitle || "",
      likelyThumbnail: Boolean(item.likelyThumbnail),
    }));
}

export async function saveImage(payload) {
  return exclusive(() => saveImageLocked(payload));
}

async function saveImageLocked(payload) {
  if (!payload || typeof payload !== "object") {
    return { status: 400, body: { ok: false, error: "请求不是 JSON" } };
  }
  const imageBase64 = typeof payload.imageBase64 === "string" ? payload.imageBase64.replace(/\s/g, "") : "";
  if (!imageBase64) return { status: 400, body: { ok: false, error: "缺少图片数据" } };
  if (imageBase64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) {
    return { status: 413, body: { ok: false, error: "图片超过 25MB" } };
  }

  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length) return { status: 400, body: { ok: false, error: "图片数据是空的" } };
  if (bytes.length > MAX_BYTES) return { status: 413, body: { ok: false, error: "图片超过 25MB" } };

  const sniffed = sniffImage(bytes);
  if (!sniffed) return { status: 415, body: { ok: false, error: "不是支持的图片" } };

  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  await fs.mkdir(INBOX, { recursive: true });
  const index = await loadIndex();
  const note = asString(payload.note, 1000).trim();
  const existing = index.byHash[contentHash];
  if (existing) {
    let noteUpdated = false;
    if (note) noteUpdated = await writeNote(existing.dir, note);
    console.log(`已在库里 ${existing.dir}`);
    return {
      status: 200,
      body: {
        ok: true,
        duplicate: true,
        noteUpdated,
        id: existing.id,
        dir: existing.dir,
        likelyThumbnail: Boolean(existing.likelyThumbnail),
      },
    };
  }

  const now = new Date();
  const { date, time } = localParts(now);
  let folder = "";
  let dir = "";
  do {
    folder = `${time}_${crypto.randomBytes(3).toString("hex")}`;
    dir = path.join(INBOX, date, folder);
  } while (await exists(dir));

  const size = readImageSize(bytes);
  const width = size?.width ?? null;
  const height = size?.height ?? null;
  const likelyThumbnail = (width != null && width < THUMB_EDGE) || (height != null && height < THUMB_EDGE);
  const imageName = `source${sniffed.ext}`;
  const relDir = `${date}/${folder}`;
  const meta = {
    id: `${date}_${folder}`,
    savedAt: formatLocalIso(now),
    status: "inbox",
    source: {
      clickedUrl: asString(payload.clickedUrl, 2000),
      savedUrl: asString(payload.savedUrl, 2000),
      pageUrl: asString(payload.pageUrl, 2000),
      pageTitle: asString(payload.pageTitle, 500),
      alt: asString(payload.alt, 500),
      mime: sniffed.mime,
      width,
      height,
      likelyThumbnail,
    },
    files: { image: imageName },
    contentHash,
    note,
    analysis: null,
  };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, imageName), bytes);
  await fs.writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  index.byHash[contentHash] = {
    id: meta.id,
    dir: relDir,
    savedAt: meta.savedAt,
    pageTitle: meta.source.pageTitle,
    likelyThumbnail,
  };
  await writeIndex(index);
  console.log(`已保存 ${relDir}`);
  return {
    status: 200,
    body: { ok: true, duplicate: false, id: meta.id, dir: relDir, likelyThumbnail, width, height },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooBig ? { error: 413 } : { raw: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => {
      if (tooBig) resolve({ error: 413 });
      else reject(new Error("请求中断"));
    });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Private-Network": "true",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }

      const pathname = new URL(req.url || "/", `http://${HOST}`).pathname;
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = await fs.readFile(GALLERY_PATH);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && pathname === "/api/items") {
        const items = await exclusive(() => listItems());
        sendJson(res, 200, { ok: true, items });
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/media/")) {
        const filePath = inboxFile(pathname);
        if (!filePath) {
          sendJson(res, 404, { ok: false, error: "没有这张图" });
          return;
        }
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          sendJson(res, 404, { ok: false, error: "没有这张图" });
          return;
        }
        if (!stat.isFile()) {
          sendJson(res, 404, { ok: false, error: "没有这张图" });
          return;
        }
        const type = MEDIA_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": stat.size,
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
        });
        const stream = createReadStream(filePath);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
        return;
      }
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "inspiration-inbox" });
        return;
      }
      if (req.method === "GET" && pathname === "/recent") {
        const items = await exclusive(async () => {
          await fs.mkdir(INBOX, { recursive: true });
          return recentItems(await loadIndex());
        });
        sendJson(res, 200, { ok: true, items });
        return;
      }
      if (req.method === "POST" && pathname === "/save") {
        const body = await readBody(req);
        if (body.error) {
          sendJson(res, body.error, { ok: false, error: "图片超过 25MB" });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(body.raw || "");
        } catch {
          sendJson(res, 400, { ok: false, error: "请求不是 JSON" });
          return;
        }
        const saved = await saveImage(payload);
        sendJson(res, saved.status, saved.body);
        return;
      }
      sendJson(res, 404, { ok: false, error: "没有这个接口" });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "保存失败" });
    }
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const server = createServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error("端口 3921 已被占用。如果收集服务已在运行，直接用插件即可。");
    } else {
      console.error(error);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`灵感库收集服务已启动 http://${HOST}:${PORT}`);
    console.log(`采集页 http://${HOST}:${PORT}/`);
    console.log(`图片会写入 ${INBOX}`);
  });
}
