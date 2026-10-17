/**
 * PDF Wizard: X Video Downloader.
 *
 * Adds a "Download" button to the action bar of every post on X that has a
 * video or GIF. Clicking it opens PDF Wizard's X downloader with the post's
 * link filled in; the site does the rest. The extension reads nothing except
 * the post's own link, stores nothing and sends nothing anywhere: it only
 * opens a tab, and only when you click.
 */
(() => {
  "use strict";

  const SITE = "https://pdfwizard.xyz";
  const MARK = "data-pdfwizard-dl";
  const STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})(?:\/(video|photo)\/(\d))?/;

  /** The canonical post link for a status href, or null. Exposed for tests. */
  function statusUrl(href) {
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (!/(^|\.)(x|twitter)\.com$/.test(url.hostname)) return null;
    const m = url.pathname.match(STATUS_PATH);
    if (!m) return null;
    // Keep /video/N (which video of a multi-video post); a photo index isn't a video.
    return `https://x.com/i/status/${m[1]}${m[2] === "video" ? `/video/${m[3]}` : ""}`;
  }

  /** Where the button sends the user. Exposed for tests. */
  function toolUrl(post, kind) {
    const slug = kind === "mp3" ? "x-to-mp3" : "x-to-mp4";
    return `${SITE}/tools/${slug}?url=${encodeURIComponent(post)}&utm_source=extension`;
  }

  // For tests/extension.test.mts. Content scripts run in an isolated world,
  // so pages on x.com can't see or call this.
  globalThis.__pdfWizardX = { statusUrl, toolUrl };

  const hasMedia = (article) =>
    !!article.querySelector(
      'video, [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="tweetGif"]'
    );

  /** A post's own link: the timestamp anchor, which every post has. */
  function postLink(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const anchor = time ? time.closest("a") : article.querySelector('a[href*="/status/"]');
    return anchor ? statusUrl(anchor.getAttribute("href")) : null;
  }

  /** X has its own Light / Dim / Lights out setting, separate from the OS. */
  function xIsDark() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!m) return matchMedia("(prefers-color-scheme: dark)").matches;
    const [r, g, b] = m.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }

  function closeMenus(except) {
    document.querySelectorAll(".pdfwizard-menu").forEach((menu) => {
      if (menu !== except) {
        menu.hidden = true;
        menu.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
    });
  }

  function makeButton(link) {
    const wrap = document.createElement("div");
    wrap.className = "pdfwizard-wrap";
    wrap.setAttribute(MARK, "1");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdfwizard-btn";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Download this video with PDF Wizard");
    button.title = "Download with PDF Wizard";
    // Arrow-into-tray icon; inherits the action bar's colour.
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Zm-8 14a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/></svg><span>Download</span>';

    const menu = document.createElement("div");
    menu.className = "pdfwizard-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    for (const [kind, label] of [["mp4", "Video (MP4)"], ["mp3", "Audio (MP3)"]]) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.className = "pdfwizard-item";
      item.textContent = label;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.open(toolUrl(link, kind), "_blank", "noopener");
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
        button.focus();
      });
      menu.appendChild(item);
    }

    button.addEventListener("click", (event) => {
      // X opens the post when a click bubbles up to the article.
      event.preventDefault();
      event.stopPropagation();
      const open = menu.hidden;
      closeMenus(menu);
      menu.classList.toggle("pdfwizard-dark", xIsDark());
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button")?.focus();
    });
    menu.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
        button.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      }
    });

    wrap.append(button, menu);
    return wrap;
  }

  function enhance(article) {
    if (article.querySelector(`[${MARK}]`) || !hasMedia(article)) return;
    const link = postLink(article);
    // The action bar (reply / repost / like / views / share) is the last role=group.
    const groups = article.querySelectorAll('[role="group"]');
    const bar = groups[groups.length - 1];
    if (!link || !bar) return;
    bar.appendChild(makeButton(link));
  }

  function scan(root) {
    root.querySelectorAll?.('article[data-testid="tweet"], article[role="article"]').forEach(enhance);
  }

  scan(document);
  // X renders posts as you scroll; video players often mount after the post.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan(document);
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".pdfwizard-wrap")) closeMenus(null);
  });
})();
