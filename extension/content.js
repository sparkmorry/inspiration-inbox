if (!globalThis.__inspirationCollector) {
  globalThis.__inspirationCollector = true;

  const UNKNOWN_LARGE = 8192;
  const ORIGINAL_ATTRS = [
    "data-original",
    "data-original-src",
    "data-full",
    "data-full-src",
    "data-large",
    "data-large-src",
    "data-hires",
    "data-zoom-src",
    "data-actualsrc",
  ];
  const LAZY_ATTRS = ["data-src", "data-lazy-src"];
  let lastImage = null;

  document.addEventListener("contextmenu", (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const img = path.find((node) => node && node.tagName === "IMG");
    if (img) lastImage = img;
  }, true);

  function resolveUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  function pushCandidate(candidates, url, bonus, kind, bonusOnlyIfUnknown) {
    const abs = resolveUrl(url);
    if (!abs || abs.startsWith("javascript:") || abs.startsWith("data:")) return;
    const estimated = globalThis.InspirationPick.estimateWidth(abs);
    const width = bonusOnlyIfUnknown ? (estimated || bonus || 0) : Math.max(estimated || 0, bonus || 0);
    const found = candidates.find((item) => item.url === abs);
    if (found) {
      if (width > found.width) found.width = width;
      return;
    }
    candidates.push({ url: abs, width, kind });
  }

  function addSrcset(candidates, img, srcset) {
    const ratio = window.devicePixelRatio || 1;
    const base = img.naturalWidth ? img.naturalWidth / ratio : 0;
    for (const item of globalThis.InspirationPick.parseSrcset(srcset)) {
      let bonus = item.width || 0;
      if (!bonus && item.density) bonus = base ? Math.round(base * item.density) : Math.round(item.density * 100);
      pushCandidate(candidates, item.url, bonus, "srcset", false);
    }
  }

  function imageMatches(img, srcUrl) {
    if (!srcUrl) return false;
    if (img.currentSrc === srcUrl || img.src === srcUrl) return true;
    return (img.getAttribute("srcset") || "").includes(srcUrl);
  }

  function findImage(srcUrl) {
    if (lastImage && (!srcUrl || imageMatches(lastImage, srcUrl))) return lastImage;
    const images = document.images ? [...document.images] : [];
    return images.find((img) => imageMatches(img, srcUrl)) || null;
  }

  function collect(srcUrl) {
    const img = findImage(srcUrl);
    const candidates = [];
    if (img) {
      pushCandidate(candidates, img.currentSrc, img.naturalWidth || 1, "currentSrc", false);
      pushCandidate(candidates, img.src, img.src === img.currentSrc ? (img.naturalWidth || 1) : 1, "src", false);
      addSrcset(candidates, img, img.srcset || img.getAttribute("srcset") || "");
      const picture = img.closest("picture");
      if (picture) {
        for (const source of picture.querySelectorAll("source")) addSrcset(candidates, img, source.srcset || "");
      }
      for (const attr of ORIGINAL_ATTRS) pushCandidate(candidates, img.getAttribute(attr), UNKNOWN_LARGE, attr, true);
      for (const attr of LAZY_ATTRS) pushCandidate(candidates, img.getAttribute(attr), UNKNOWN_LARGE, attr, true);
      const link = img.closest("a");
      if (link && globalThis.InspirationPick.looksLikeImage(link.href)) {
        pushCandidate(candidates, link.href, UNKNOWN_LARGE, "parent", true);
      }
    }
    if (srcUrl) pushCandidate(candidates, srcUrl, 1, "clicked", false);
    candidates.sort((a, b) => b.width - a.width);
    return {
      candidates: candidates.slice(0, 12),
      alt: img?.alt || "",
      pageTitle: document.title || "",
      clickedUrl: srcUrl || "",
    };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const comma = text.indexOf(",");
        resolve(comma >= 0 ? text.slice(comma + 1) : "");
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function capture(srcUrl) {
    const img = findImage(srcUrl);
    if (!img) return { ok: false };
    const savedUrl = img.currentSrc || img.src || srcUrl || "";
    if (savedUrl.startsWith("blob:")) {
      try {
        const response = await fetch(savedUrl);
        if (response.ok) {
          const blob = await response.blob();
          if (blob.size > 0 && blob.size <= 25 * 1024 * 1024) {
            const base64 = await blobToBase64(blob);
            if (base64) {
              return { ok: true, base64, mime: blob.type || "", savedUrl, alt: img.alt || "", pageTitle: document.title || "" };
            }
          }
        }
      } catch {
        // 画布是下一种取法。
      }
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return { ok: false };
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      const comma = dataUrl.indexOf(",");
      return {
        ok: true,
        base64: dataUrl.slice(comma + 1),
        mime: "image/png",
        savedUrl,
        alt: img.alt || "",
        pageTitle: document.title || "",
      };
    } catch {
      return { ok: false };
    }
  }

  function askNote() {
    return new Promise((resolve) => {
      const parent = document.documentElement || document.body;
      if (!parent) {
        resolve({ confirmed: false });
        return;
      }
      const existing = document.getElementById("inspiration-collector-note");
      if (existing) {
        existing.shadowRoot?.querySelector("textarea")?.focus();
        resolve({ confirmed: false, alreadyOpen: true });
        return;
      }
      const host = document.createElement("div");
      host.id = "inspiration-collector-note";
      host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
      parent.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = [
        ":host{all:initial}",
        ".backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(28,36,31,.45);font:14px/1.45 PingFang SC,Hiragino Sans GB,sans-serif;color:#1c241f}",
        ".panel{width:min(420px,calc(100vw - 32px));margin:0;padding:16px;background:#f4f1ea;border:1px solid #e1dbd0;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18)}",
        "h2{margin:0 0 8px;font-size:16px;font-weight:600}",
        "p{margin:0 0 8px;color:#6d675e}",
        "textarea{box-sizing:border-box;width:100%;min-height:88px;resize:vertical;padding:8px 10px;border:1px solid #e1dbd0;border-radius:6px;background:#fffdf8;color:#1c241f;font:inherit}",
        ".actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}",
        "button{font:inherit;padding:6px 12px;border-radius:6px;cursor:pointer}",
        ".cancel{color:#1c241f;background:transparent;border:1px solid #e1dbd0}",
        ".save{color:#f4f1ea;background:#1f6f5b;border:1px solid #1f6f5b}",
      ].join("");
      const backdrop = document.createElement("div");
      backdrop.className = "backdrop";
      const panel = document.createElement("form");
      panel.className = "panel";
      const title = document.createElement("h2");
      title.textContent = "保存到灵感库";
      const hint = document.createElement("p");
      hint.textContent = "备注可以不填。";
      const textarea = document.createElement("textarea");
      textarea.maxLength = 1000;
      textarea.placeholder = "这张图想记住什么";
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cancel";
      cancel.textContent = "取消";
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "save";
      save.textContent = "保存";
      actions.append(cancel, save);
      panel.append(title, hint, textarea, actions);
      shadow.append(style, backdrop);
      backdrop.append(panel);

      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        const note = textarea.value.trim();
        host.remove();
        resolve({ confirmed, note: confirmed ? note : "" });
      };
      panel.addEventListener("submit", (event) => {
        event.preventDefault();
        finish(true);
      });
      cancel.addEventListener("click", () => finish(false));
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) finish(false);
      });
      panel.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          finish(true);
        }
      });
      textarea.focus();
    });
  }

  function showToast(message, ok) {
    const host = document.documentElement || document.body;
    if (!host) return;
    let el = document.getElementById("inspiration-collector-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "inspiration-collector-toast";
      el.setAttribute("role", "status");
      host.appendChild(el);
    }
    el.textContent = message;
    el.style.cssText = [
      "position:fixed",
      "top:16px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "max-width:min(440px,calc(100vw - 32px))",
      "padding:12px 16px",
      "border-radius:8px",
      "font:14px/1.4 PingFang SC,Hiragino Sans GB,sans-serif",
      "color:#1c241f",
      ok ? "background:#e7f2ec" : "background:#f8ebe4",
      ok ? "border:1px solid #1f6f5b" : "border:1px solid #8a4b32",
      "box-shadow:0 8px 24px rgba(0,0,0,.16)",
    ].join(";");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.remove(), ok ? 3200 : 5200);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ask-note") {
      askNote().then(sendResponse, () => sendResponse({ confirmed: false }));
      return true;
    }
    if (message?.type === "toast") {
      showToast(String(message.message || ""), Boolean(message.ok));
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "collect") {
      try {
        sendResponse(collect(message.srcUrl || ""));
      } catch {
        sendResponse({ candidates: [], alt: "", pageTitle: document.title || "", clickedUrl: message.srcUrl || "" });
      }
      return false;
    }
    if (message?.type === "capture") {
      capture(message.srcUrl || "").then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });
}
