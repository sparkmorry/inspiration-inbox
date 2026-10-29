(function (root) {
  function estimateWidth(url) {
    const text = String(url || "");
    let best = 0;
    const patterns = [
      /imageView2\/\d+\/w\/(\d{2,5})/gi,
      /[/?&](?:w|width|maxwidth)=(\d{2,5})(?!\d)/gi,
      /\/w\/(\d{2,5})(?!\d)/gi,
      /(?:[_/-])(\d{3,5})x(\d{3,5})(?=[./_?-]|$)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        best = Math.max(best, Number.parseInt(match[1], 10) || 0, Number.parseInt(match[2] || "0", 10) || 0);
      }
    }
    return best || null;
  }

  function parseSrcset(srcset) {
    if (!srcset) return [];
    return String(srcset)
      .split(",")
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return null;
        const desc = bits[1] || "";
        if (/^\d+w$/i.test(desc)) return { url: bits[0], width: Number.parseInt(desc, 10), density: null };
        if (/^\d+(?:\.\d+)?x$/i.test(desc)) return { url: bits[0], width: null, density: Number.parseFloat(desc) };
        return { url: bits[0], width: null, density: null };
      })
      .filter(Boolean);
  }

  function looksLikeImage(url) {
    try {
      const parsed = new URL(url, "https://example.test");
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      const href = parsed.href.toLowerCase();
      if (/\.(?:jpe?g|png|gif|webp|avif|bmp|svg)(?:$|\?)/.test(parsed.pathname.toLowerCase())) return true;
      if (/(?:format|fm|type)=(?:jpe?g|png|webp|gif|avif)/.test(href)) return true;
      if (href.includes("imageview2/") || /\/format\/(?:jpe?g|png|webp|gif|avif)/.test(href)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function chooseAttemptUrls(candidates, clickedUrl) {
    const ranked = (Array.isArray(candidates) ? candidates : [])
      .filter((item) => item && /^https?:\/\//i.test(item.url || ""))
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    const chosen = [];
    for (const item of ranked) {
      if (!chosen.some((entry) => entry.url === item.url)) chosen.push({ url: item.url, width: item.width || 0 });
      if (chosen.length === 2) break;
    }
    if (/^https?:\/\//i.test(clickedUrl || "") && !chosen.some((entry) => entry.url === clickedUrl)) {
      const known = ranked.find((item) => item.url === clickedUrl);
      chosen.push({ url: clickedUrl, width: known?.width || estimateWidth(clickedUrl) || 1 });
    }
    return chosen;
  }

  root.InspirationPick = { estimateWidth, parseSrcset, looksLikeImage, chooseAttemptUrls };
})(globalThis);
