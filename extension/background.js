import { INSPIRATION_ORIGIN } from "./config.js";
import { readImageSize, sniffImage } from "./image-size.js";
import "./pick-url.js";

const MENU_ID = "save-inspiration";
const MAX_BYTES = 25 * 1024 * 1024;
const CLEAR_EDGE = 480;

function setupMenu() {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "保存到灵感库",
    contexts: ["image"],
  }, () => void chrome.runtime.lastError);
}

chrome.runtime.onInstalled.addListener(setupMenu);
chrome.runtime.onStartup.addListener(setupMenu);
setupMenu();

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title: "灵感库",
    message,
  }, () => void chrome.runtime.lastError);
}

async function report(tabId, message, ok, { system = true } = {}) {
  if (system) notify(message);
  if (!tabId) return;
  await sendToFrame(tabId, 0, { type: "toast", message, ok });
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    const options = frameId === undefined || frameId === null ? undefined : { frameId };
    chrome.tabs.sendMessage(tabId, message, options, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response || null);
    });
  });
}

function toBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes]));
  });
}

async function fetchImage(url, pageUrl) {
  if (!/^https?:\/\//i.test(url)) return null;
  for (const credentials of ["omit", "include"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        credentials,
        redirect: "follow",
        referrer: pageUrl || "",
        referrerPolicy: pageUrl ? "unsafe-url" : "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_BYTES) return { tooBig: true };
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (mime && !mime.startsWith("image/") && mime !== "application/octet-stream" && mime !== "binary/octet-stream") {
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) continue;
      if (bytes.length > MAX_BYTES) return { tooBig: true };
      if (!sniffImage(bytes)) continue;
      const size = readImageSize(bytes);
      const base64 = await toBase64(bytes);
      if (!base64) continue;
      return { base64, savedUrl: url, width: size?.width ?? null, height: size?.height ?? null };
    } catch {
      // 换一种凭证方式，或试下一张地址。
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function clipField(value, max = 2000) {
  if (typeof value !== "string") return "";
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    return (comma >= 0 ? value.slice(0, comma) : value).slice(0, max);
  }
  return value.slice(0, max);
}

function clearEnough(file) {
  return (file.width || 0) >= CLEAR_EDGE && (file.height || 0) >= CLEAR_EDGE;
}

function chooseFile(files) {
  let best = files[0];
  let bestArea = (best.width || 0) * (best.height || 0);
  for (const file of files.slice(1)) {
    const area = (file.width || 0) * (file.height || 0);
    if (area > bestArea) {
      best = file;
      bestArea = area;
    }
  }
  return best;
}

async function postSave(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${INSPIRATION_ORIGIN}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 413) return { tooBig: true };
    if (response.status === 415) return { notImage: true };
    if (!response.ok || !body?.ok) return { error: true };
    return { ok: true, body };
  } catch {
    return { offline: true };
  } finally {
    clearTimeout(timer);
  }
}

function savedMessage(body) {
  if (body.duplicate && body.noteUpdated) return "这张图已经在库里，备注已更新";
  if (body.duplicate) return "这张图已经在库里";
  if (body.likelyThumbnail) return "已保存到灵感库（这张偏小，可能是缩略图）";
  return "已保存到灵感库";
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  saveClickedImage(info, tab).catch(() => report(tab.id, "这张图存不下来", false));
});

async function saveClickedImage(info, tab) {
  const asked = await sendToFrame(tab.id, 0, { type: "ask-note" });
  if (!asked) {
    await report(tab.id, "保存失败：备注框没有打开", false);
    return;
  }
  if (!asked.confirmed) {
    if (!asked.alreadyOpen) await report(tab.id, "已取消", true, { system: false });
    return;
  }
  const note = clipField(asked.note || "", 1000);
  await report(tab.id, "正在保存…", true, { system: false });
  const clickedUrl = info.srcUrl || "";
  const clickedForPage = clickedUrl.startsWith("data:") ? "" : clickedUrl;
  const pageUrl = info.pageUrl || tab.url || "";
  const fromPage = await sendToFrame(tab.id, info.frameId, { type: "collect", srcUrl: clickedForPage });
  const pageTitle = fromPage?.pageTitle || tab.title || "";
  const alt = fromPage?.alt || "";
  const urls = globalThis.InspirationPick.chooseAttemptUrls(fromPage?.candidates, clickedForPage);
  const downloaded = [];
  let sawOffline = false;
  let sawTooBig = false;

  for (let i = 0; i < urls.length; i += 1) {
    const file = await fetchImage(urls[i].url, pageUrl);
    if (!file) continue;
    if (file.tooBig) {
      sawTooBig = true;
      continue;
    }
    downloaded.push(file);
    const measuredLong = Math.max(file.width || 0, file.height || 0);
    const laterCouldBeBigger = urls.slice(i + 1).some((item) => (item.width || 0) > measuredLong);
    if (clearEnough(file) && !laterCouldBeBigger) break;
  }

  if (downloaded.length) {
    const winner = chooseFile(downloaded);
    const result = await postSave({
      imageBase64: winner.base64,
      clickedUrl: clipField(clickedUrl),
      savedUrl: clipField(winner.savedUrl),
      pageUrl: clipField(pageUrl),
      pageTitle: clipField(pageTitle, 500),
      alt: clipField(alt, 500),
      note,
    });
    if (result.offline) sawOffline = true;
    else if (result.tooBig) sawTooBig = true;
    else if (result.ok) {
      await report(tab.id, savedMessage(result.body), true);
      return;
    }
  }

  if (!sawOffline) {
    const captured = await sendToFrame(tab.id, info.frameId, { type: "capture", srcUrl: clickedForPage });
    if (captured?.ok && captured.base64) {
      const result = await postSave({
        imageBase64: captured.base64,
        clickedUrl: clipField(clickedUrl),
        savedUrl: clipField(captured.savedUrl || clickedUrl),
        pageUrl: clipField(pageUrl),
        pageTitle: clipField(captured.pageTitle || pageTitle, 500),
        alt: clipField(captured.alt || alt, 500),
        note,
      });
      if (result.offline) sawOffline = true;
      else if (result.tooBig) sawTooBig = true;
      else if (result.ok) {
        await report(tab.id, savedMessage(result.body), true);
        return;
      }
    }
  }

  if (sawOffline) await report(tab.id, "保存失败：收集服务没开", false);
  else if (sawTooBig) await report(tab.id, "保存失败：图片超过 25MB", false);
  else await report(tab.id, "保存失败：这张图存不下来", false);
}
