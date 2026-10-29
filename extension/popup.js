import { INSPIRATION_ORIGIN } from "./config.js";

const statusEl = document.querySelector("#status");
const hintEl = document.querySelector("#hint");
const recentEl = document.querySelector("#recent");
const openEl = document.querySelector("#open");

document.querySelector("#open-link").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: `${INSPIRATION_ORIGIN}/` });
});

function setOffline() {
  statusEl.textContent = "服务没开";
  statusEl.className = "status offline";
  hintEl.hidden = false;
  hintEl.textContent = "在终端进入灵感库/collector，运行 npm start。";
  openEl.hidden = true;
  recentEl.replaceChildren();
}

function renderItem(item) {
  const li = document.createElement("li");
  const title = document.createElement("p");
  title.className = "title";
  title.textContent = item.pageTitle || "未命名页面";
  const meta = document.createElement("p");
  meta.className = "meta";
  const when = item.savedAt ? new Date(item.savedAt).toLocaleString("zh-CN", { hour12: false }) : "";
  meta.textContent = item.likelyThumbnail ? `${when} · 偏小` : when;
  li.append(title, meta);
  return li;
}

async function load() {
  try {
    const health = await fetch(`${INSPIRATION_ORIGIN}/health`);
    if (!health.ok) throw new Error("offline");
    const recent = await (await fetch(`${INSPIRATION_ORIGIN}/recent`)).json();
    statusEl.textContent = "服务在线";
    statusEl.className = "status online";
    hintEl.hidden = true;
    openEl.hidden = false;
    const items = Array.isArray(recent.items) ? recent.items : [];
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "还没有保存过图片。在网页图片上右键，选「保存到灵感库」。";
      recentEl.replaceChildren(li);
      return;
    }
    recentEl.replaceChildren(...items.map(renderItem));
  } catch {
    setOffline();
  }
}

load();
