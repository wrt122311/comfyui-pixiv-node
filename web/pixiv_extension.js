import { app } from "../../scripts/app.js";

// ── Global illust cache (shared across all node instances) ────────────────────
const illustCache = new Map();

// ── Persistent tab data cache (survives node recreation on workflow switch) ───
// key: "recommended" | "bookmarks" | "ranking:day" | "ranking:week" | …
// value: { illusts: IllustObject[], nextUrl: string|null }
const persistedTabData = new Map();

// ── CSS injection ─────────────────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById("pixiv-node-css")) return;
  const link = document.createElement("link");
  link.id = "pixiv-node-css";
  link.rel = "stylesheet";
  link.href = new URL("pixiv_dialog.css", import.meta.url).href;
  document.head.appendChild(link);
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Masonry helpers ───────────────────────────────────────────────────────────
function setupMasonry(gridEl) {
  if (!gridEl) return [];
  const w = gridEl.parentElement?.clientWidth || 600;
  const n = Math.max(2, Math.floor(w / 130));
  gridEl.innerHTML = "";
  const cols = [];
  for (let i = 0; i < n; i++) {
    const col = document.createElement("div");
    col.className = "px-masonry-col";
    gridEl.appendChild(col);
    cols.push(col);
  }
  return cols;
}

function masonryAdd(cols, el) {
  if (!cols?.length) return;
  let minH = Infinity, idx = 0;
  for (let i = 0; i < cols.length; i++) {
    const h = cols[i].offsetHeight;
    if (h < minH) { minH = h; idx = i; }
  }
  cols[idx].appendChild(el);
}

// ── Custom scrollbar ──────────────────────────────────────────────────────────
function attachCustomScrollbar(scrollEl) {
  if (!scrollEl || !scrollEl.parentNode) return;

  const wrap = document.createElement("div");
  wrap.className = "px-scroll-wrap";
  scrollEl.parentNode.insertBefore(wrap, scrollEl);
  wrap.appendChild(scrollEl);

  const bar = document.createElement("div");
  bar.className = "px-scrollbar";
  const thumb = document.createElement("div");
  thumb.className = "px-scrollbar-thumb";
  bar.appendChild(thumb);
  wrap.appendChild(bar);

  function updateThumb() {
    const viewH = scrollEl.clientHeight;
    const totalH = scrollEl.scrollHeight;
    if (totalH <= viewH + 1) { bar.style.visibility = "hidden"; return; }
    bar.style.visibility = "";
    const barH = bar.clientHeight;
    const thumbH = Math.max(24, barH * viewH / totalH);
    const top = (scrollEl.scrollTop / (totalH - viewH)) * (barH - thumbH);
    thumb.style.height = thumbH + "px";
    thumb.style.top = top + "px";
  }

  scrollEl.addEventListener("scroll", updateThumb, { passive: true });
  new ResizeObserver(updateThumb).observe(scrollEl);

  bar.addEventListener("click", (e) => {
    if (e.target === thumb) return;
    const rect = bar.getBoundingClientRect();
    scrollEl.scrollTop = ((e.clientY - rect.top) / bar.clientHeight) * (scrollEl.scrollHeight - scrollEl.clientHeight);
  });

  thumb.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startTop = scrollEl.scrollTop;
    const barH = bar.clientHeight;
    const thumbH = thumb.offsetHeight;
    thumb.classList.add("dragging");
    const onMove = (ev) => {
      const scrollRange = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = startTop + (ev.clientY - startY) * scrollRange / (barH - thumbH);
    };
    const onUp = () => {
      thumb.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  updateThumb();
}

// ── Per-node browser init ─────────────────────────────────────────────────────
// ctx = { container, contentEl, idsWidget, S }

function initNodeBrowser(container, idsWidget) {
  const existingIds = (idsWidget?.value || "")
    .split(",").map(s => s.trim()).filter(Boolean).map(s => s.split("|")[0]);

  const ctx = {
    container,
    idsWidget,
    contentEl: null,
    S: {
      selectedIds: existingIds,
      activeTab: "recommended",
      nextUrls: {},
      loading: false,
      activeArtistId: null,
      artistNextUrl: null,
      rankingMode: "day",
      cachedPanes: {},
      pendingArtistId: null,
      masonryCols: {},
      artistMasonryCols: null,
      searchQuery: "",
      searchType: "illusts",
      searchNextUrl: null,
      searchMasonryCols: null,
      searchLoading: false,
      multiSelect: false,
    },
  };

  container.className = "px-browser";
  container.innerHTML = `
    <div class="px-tabs">
      <button class="px-tab active" data-tab="recommended">推荐</button>
      <button class="px-tab" data-tab="ranking">排行榜</button>
      <button class="px-tab" data-tab="bookmarks">收藏</button>
      <button class="px-tab" data-tab="artists">画师</button>
      <button class="px-tab" data-tab="search">搜索</button>
      <button class="px-tab px-sel-tab" data-tab="selected">已选</button>
    </div>
    <div class="px-content"></div>
    <div class="px-footer">
      <span class="px-count">已选 0 张</span>
      <button class="px-multisel-btn">多选</button>
      <button class="px-clear-btn">清除全部</button>
    </div>
  `;

  ctx.contentEl = container.querySelector(".px-content");

  // Prevent canvas from stealing mouse/wheel events inside the node
  container.addEventListener("mousedown", e => e.stopPropagation());
  container.addEventListener("pointerdown", e => e.stopPropagation());
  container.addEventListener("wheel", e => e.stopPropagation(), { passive: false });

  // Tab buttons
  container.querySelectorAll(".px-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(ctx, btn.dataset.tab));
  });

  // Multi-select toggle
  container.querySelector(".px-multisel-btn").addEventListener("click", () => {
    ctx.S.multiSelect = !ctx.S.multiSelect;
    const btn = container.querySelector(".px-multisel-btn");
    btn.classList.toggle("active", ctx.S.multiSelect);
    btn.textContent = ctx.S.multiSelect ? "多选 ✓" : "多选";
  });

  // Clear all
  container.querySelector(".px-clear-btn").addEventListener("click", () => {
    ctx.S.selectedIds.length = 0;
    commitSelection(ctx);
    updateCount(ctx);
    if (ctx.S.activeTab === "selected") {
      renderSelectedPane(ctx);
    } else {
      ctx.contentEl.querySelectorAll(".px-card.selected").forEach(card => {
        card.classList.remove("selected");
        card.querySelector(".px-seq-badge")?.remove();
      });
    }
  });

  updateCount(ctx);
  checkLoginAndRender(ctx);
}

function commitSelection(ctx) {
  if (!ctx.idsWidget) return;
  ctx.idsWidget.value = ctx.S.selectedIds.map(id => {
    const url = illustCache.get(id)?.original_url || "";
    return url ? `${id}|${url}` : id;
  }).join(",");
}

function updateCount(ctx) {
  const el = ctx.container.querySelector(".px-count");
  if (el) el.textContent = `已选 ${ctx.S.selectedIds.length} 张`;
  const tabEl = ctx.container.querySelector(".px-sel-tab");
  if (tabEl) tabEl.textContent = ctx.S.selectedIds.length > 0
    ? `已选 (${ctx.S.selectedIds.length})` : "已选";
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function checkLoginAndRender(ctx) {
  try {
    const resp = await fetch("/pixiv/status");
    const status = await resp.json();
    if (!status.logged_in) {
      renderLoginPage(ctx);
    } else {
      renderRecommendedPane(ctx);
    }
  } catch (e) {
    ctx.contentEl.innerHTML =
      `<div class="px-error">无法连接到后端: ${esc(e.message)}</div>`;
  }
}

function renderLoginPage(ctx) {
  const { contentEl } = ctx;
  contentEl.innerHTML = `
    <div class="px-login-page">
      <h3 style="color:#cba6f7;margin:0;font-size:14px">登录 Pixiv</h3>

      <div style="display:flex;gap:0;border:1px solid #3a3a5c;border-radius:6px;overflow:hidden;width:100%;max-width:440px">
        <button class="px-login-tab active" data-login-tab="token">🔑 Refresh Token（推荐）</button>
        <button class="px-login-tab" data-login-tab="oauth">🌐 OAuth 授权</button>
      </div>

      <div class="px-panel-token" style="width:100%;max-width:440px;display:flex;flex-direction:column;gap:10px">
        <div style="background:#181825;border:1px solid #3a3a5c;border-radius:6px;padding:10px 14px;font-size:12px;line-height:1.7;color:#cdd6f4">
          <b style="color:#cba6f7">获取 Refresh Token：</b>
          <ol style="margin:4px 0 0 14px;padding:0">
            <li>安装工具：<code style="background:#0d1117;padding:1px 5px;border-radius:3px;color:#a6e3a1">pip install gppt</code></li>
            <li>运行：<code style="background:#0d1117;padding:1px 5px;border-radius:3px;color:#a6e3a1">gppt login-headless -u 邮箱 -p 密码</code></li>
            <li>复制输出的 <code style="color:#a6e3a1">refresh_token</code>，粘贴到下方</li>
          </ol>
        </div>
        <input class="px-token-input" type="password" placeholder="粘贴 refresh_token 到此处"
          style="width:100%;box-sizing:border-box;padding:7px 10px;background:#181825;border:1px solid #3a3a5c;border-radius:4px;color:#cdd6f4;font-size:12px" />
        <button class="px-save-token-btn"
          style="padding:7px 16px;background:#cba6f7;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px">保存并登录</button>
        <p class="px-token-error" style="color:#f38ba8;display:none;margin:0;font-size:12px"></p>
      </div>

      <div class="px-panel-oauth" style="width:100%;max-width:440px;display:none;flex-direction:column;gap:10px">
        <div style="background:#181825;border:1px solid #3a3a5c;border-radius:6px;padding:10px 14px;font-size:12px;line-height:1.7;color:#cdd6f4">
          <b style="color:#cba6f7">操作步骤：</b>
          <ol style="margin:4px 0 0 14px;padding:0">
            <li>点击按钮，在新标签页完成 Pixiv 账号登录</li>
            <li>查看地址栏，若出现 <code style="color:#a6e3a1">pixiv://account/login?code=</code> 开头的 URL，复制到下方</li>
            <li>若地址栏无此 URL，请改用 Refresh Token 方式</li>
          </ol>
        </div>
        <button class="px-login-btn"
          style="padding:7px 16px;background:#cba6f7;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px">① 用浏览器登录 Pixiv</button>
        <div class="px-callback-section" style="display:none;flex-direction:column;gap:6px">
          <p style="color:#a6e3a1;margin:0;font-size:12px">✓ 已打开授权页，粘贴地址栏 URL 到下方</p>
          <input class="px-redirect-input" type="text" placeholder="pixiv://account/login?code=..."
            style="width:100%;box-sizing:border-box;padding:7px 10px;background:#181825;border:1px solid #3a3a5c;border-radius:4px;color:#cdd6f4;font-size:12px" />
          <button class="px-submit-code-btn"
            style="padding:7px 16px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">② 确认登录</button>
        </div>
        <p class="px-oauth-error" style="color:#f38ba8;display:none;margin:0;font-size:12px"></p>
      </div>
    </div>
  `;

  // Login tab switching
  contentEl.querySelectorAll(".px-login-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      contentEl.querySelectorAll(".px-login-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.loginTab;
      contentEl.querySelector(".px-panel-token").style.display = tab === "token" ? "flex" : "none";
      contentEl.querySelector(".px-panel-oauth").style.display  = tab === "oauth"  ? "flex" : "none";
    });
  });

  // Token login
  contentEl.querySelector(".px-save-token-btn").addEventListener("click", async () => {
    const token = contentEl.querySelector(".px-token-input").value.trim();
    const errEl = contentEl.querySelector(".px-token-error");
    if (!token) return;
    errEl.style.display = "none";
    try {
      const resp = await fetch("/pixiv/auth/set_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
      });
      const data = await resp.json();
      if (data.ok) {
        renderRecommendedPane(ctx);
      } else {
        errEl.textContent = data.error || "Token 无效，请检查后重试";
        errEl.style.display = "block";
      }
    } catch (e) {
      errEl.textContent = "网络错误：" + e.message;
      errEl.style.display = "block";
    }
  });

  // OAuth login
  contentEl.querySelector(".px-login-btn").addEventListener("click", async () => {
    try {
      const resp = await fetch("/pixiv/auth/login", { method: "POST" });
      const data = await resp.json();
      window.open(data.auth_url, "_blank");
      contentEl.querySelector(".px-callback-section").style.display = "flex";
    } catch (e) { console.error("[PixivBrowser] Login init failed:", e); }
  });

  contentEl.querySelector(".px-submit-code-btn").addEventListener("click", async () => {
    const redirectUrl = contentEl.querySelector(".px-redirect-input").value.trim();
    const errEl = contentEl.querySelector(".px-oauth-error");
    if (!redirectUrl) return;
    if (!redirectUrl.startsWith("pixiv://")) {
      errEl.textContent = "请粘贴以 pixiv:// 开头的地址";
      errEl.style.display = "block";
      return;
    }
    errEl.style.display = "none";
    try {
      const resp = await fetch("/pixiv/auth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_url: redirectUrl }),
      });
      const data = await resp.json();
      if (data.ok) {
        renderRecommendedPane(ctx);
      } else {
        errEl.textContent = data.error || "登录失败，请重试";
        errEl.style.display = "block";
      }
    } catch (e) {
      errEl.textContent = "网络错误：" + e.message;
      errEl.style.display = "block";
    }
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(ctx, tabName) {
  // Save current pane DOM before switching (preserves scroll + loaded content)
  const cur = ctx.S.activeTab;
  if (cur !== tabName && cur !== "selected") {
    const el = ctx.contentEl.firstElementChild;
    if (el) ctx.S.cachedPanes[cur] = el;
  }
  ctx.S.activeTab = tabName;
  ctx.container.querySelectorAll(".px-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  if (tabName === "selected") {
    renderSelectedPane(ctx);
  } else {
    const cached = ctx.S.cachedPanes[tabName];
    if (cached) {
      ctx.contentEl.innerHTML = "";
      ctx.contentEl.appendChild(cached);
    } else {
      renderTabPane(ctx, tabName);
    }
  }
}

function renderTabPane(ctx, tabName) {
  if (tabName === "recommended")  renderRecommendedPane(ctx);
  else if (tabName === "ranking") renderRankingPane(ctx);
  else if (tabName === "bookmarks") renderBookmarksPane(ctx);
  else if (tabName === "artists") renderArtistPane(ctx);
  else if (tabName === "search")  renderSearchPane(ctx);
}

// ── Recommended pane (cached) ─────────────────────────────────────────────────
function renderRecommendedPane(ctx) {
  const { contentEl, S } = ctx;
  contentEl.innerHTML = `
    <div class="px-recommended-pane">
      <div class="px-rank-bar">
        <span style="flex:1;color:#7f849c;font-size:11px">为你推荐</span>
        <button class="px-refresh-btn">↻ 刷新</button>
      </div>
      <div class="px-rank-grid-wrap">
        <div class="px-grid-pane">
          <div class="px-grid"></div>
          <div class="px-loading" style="display:none">加载中...</div>
        </div>
      </div>
    </div>
  `;
  contentEl.querySelector(".px-refresh-btn").addEventListener("click", () => {
    persistedTabData.delete("recommended");
    delete S.cachedPanes["recommended"];
    S.nextUrls["recommended"] = undefined;
    renderRecommendedPane(ctx);
  });
  S.masonryCols["recommended"] = setupMasonry(contentEl.querySelector(".px-grid"));
  const recCached = persistedTabData.get("recommended");
  if (recCached?.illusts.length) {
    S.nextUrls["recommended"] = recCached.nextUrl;
    for (const illust of recCached.illusts) masonryAdd(S.masonryCols["recommended"], createCard(ctx, illust));
  } else {
    S.nextUrls["recommended"] = undefined;
    loadMoreImages(ctx, "recommended");
  }
  setupInfiniteScroll(ctx, "recommended");
  attachCustomScrollbar(contentEl.querySelector(".px-grid-pane"));
}

// ── Bookmarks pane ────────────────────────────────────────────────────────────
function renderBookmarksPane(ctx) {
  const { contentEl, S } = ctx;
  contentEl.innerHTML = `
    <div class="px-recommended-pane">
      <div class="px-rank-bar">
        <span style="flex:1;color:#7f849c;font-size:11px">我的收藏</span>
        <button class="px-refresh-btn">↻ 刷新</button>
      </div>
      <div class="px-rank-grid-wrap">
        <div class="px-grid-pane">
          <div class="px-grid"></div>
          <div class="px-loading" style="display:none">加载中...</div>
        </div>
      </div>
    </div>
  `;
  contentEl.querySelector(".px-refresh-btn").addEventListener("click", () => {
    persistedTabData.delete("bookmarks");
    delete S.cachedPanes["bookmarks"];
    S.nextUrls["bookmarks"] = undefined;
    renderBookmarksPane(ctx);
  });
  S.masonryCols["bookmarks"] = setupMasonry(contentEl.querySelector(".px-grid"));
  const bmCached = persistedTabData.get("bookmarks");
  if (bmCached?.illusts.length) {
    S.nextUrls["bookmarks"] = bmCached.nextUrl;
    for (const illust of bmCached.illusts) masonryAdd(S.masonryCols["bookmarks"], createCard(ctx, illust));
  } else {
    S.nextUrls["bookmarks"] = undefined;
    loadMoreImages(ctx, "bookmarks");
  }
  setupInfiniteScroll(ctx, "bookmarks");
  attachCustomScrollbar(contentEl.querySelector(".px-grid-pane"));
}

// ── Ranking pane ──────────────────────────────────────────────────────────────
const RANKING_MODES = [
  { id: "day",           label: "日榜" },
  { id: "week",          label: "周榜" },
  { id: "month",         label: "月榜" },
  { id: "day_male",      label: "男性向" },
  { id: "day_female",    label: "女性向" },
  { id: "week_original", label: "原创" },
  { id: "week_rookie",   label: "新人" },
];

function renderRankingPane(ctx) {
  const { contentEl, S } = ctx;
  contentEl.innerHTML = `
    <div class="px-ranking-pane">
      <div class="px-rank-bar">
        ${RANKING_MODES.map(m =>
          `<button class="px-rank-btn${S.rankingMode === m.id ? " active" : ""}" data-mode="${m.id}">${m.label}</button>`
        ).join("")}
        <span style="flex:1"></span>
        <button class="px-refresh-btn">↻ 刷新</button>
      </div>
      <div class="px-rank-grid-wrap">
        <div class="px-grid-pane">
          <div class="px-grid"></div>
          <div class="px-loading" style="display:none">加载中...</div>
        </div>
      </div>
    </div>
  `;
  const restoreRanking = (mode) => {
    const grid = contentEl.querySelector(".px-grid");
    if (grid) S.masonryCols["ranking"] = setupMasonry(grid);
    const rkCached = persistedTabData.get(`ranking:${mode}`);
    if (rkCached?.illusts.length) {
      S.nextUrls["ranking"] = rkCached.nextUrl;
      for (const illust of rkCached.illusts) masonryAdd(S.masonryCols["ranking"], createCard(ctx, illust));
    } else {
      S.nextUrls["ranking"] = undefined;
      loadMoreImages(ctx, "ranking");
    }
  };

  contentEl.querySelectorAll(".px-rank-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (S.rankingMode === btn.dataset.mode) return;
      S.rankingMode = btn.dataset.mode;
      contentEl.querySelectorAll(".px-rank-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      restoreRanking(S.rankingMode);
    });
  });
  contentEl.querySelector(".px-refresh-btn").addEventListener("click", () => {
    persistedTabData.delete(`ranking:${S.rankingMode}`);
    delete S.cachedPanes["ranking"];
    S.nextUrls["ranking"] = undefined;
    renderRankingPane(ctx);
  });
  restoreRanking(S.rankingMode);
  setupInfiniteScroll(ctx, "ranking");
  attachCustomScrollbar(contentEl.querySelector(".px-grid-pane"));
}

// ── Image fetch + load ────────────────────────────────────────────────────────
async function fetchImages(tab, nextUrl, S) {
  const np = nextUrl ? `&next_url=${encodeURIComponent(nextUrl)}` : "";
  const q  = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";
  const urls = {
    recommended: `/pixiv/recommended${q}`,
    ranking:     `/pixiv/ranking?mode=${encodeURIComponent(S?.rankingMode || "day")}${np}`,
    bookmarks:   `/pixiv/bookmarks${q}`,
  };
  const resp = await fetch(urls[tab]);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function loadMoreImages(ctx, tab) {
  const { contentEl, S } = ctx;
  if (S.loading) return;
  if (S.activeTab !== tab) return;
  const nextUrl = S.nextUrls[tab];
  if (nextUrl === null) return;

  S.loading = true;
  const pane   = contentEl.querySelector(".px-grid-pane");
  const loadEl = contentEl.querySelector(".px-loading");
  if (loadEl) loadEl.style.display = "flex";

  try {
    const data = await fetchImages(tab, nextUrl, S);
    if (S.activeTab !== tab) return;
    S.nextUrls[tab] = data.next_url ?? null;

    // Persist first page only — keeps restoration cost low (~30 cards)
    const cacheKey = tab === "ranking" ? `ranking:${S.rankingMode}` : tab;
    if (!persistedTabData.has(cacheKey)) {
      persistedTabData.set(cacheKey, { illusts: data.illusts, nextUrl: S.nextUrls[tab] });
    }

    const cols   = S.masonryCols[tab];
    const gridEl = contentEl.querySelector(".px-grid");
    for (const illust of data.illusts) {
      const card = createCard(ctx, illust);
      if (cols?.length) masonryAdd(cols, card);
      else gridEl?.appendChild(card);
    }
    if (pane && pane.scrollHeight <= pane.clientHeight + 50 && S.nextUrls[tab] !== null) {
      setTimeout(() => loadMoreImages(ctx, tab), 0);
    }
  } catch (e) {
    pane?.insertAdjacentHTML("beforeend",
      `<div class="px-error">加载失败: ${esc(e.message)}</div>`);
  } finally {
    S.loading = false;
    if (loadEl) loadEl.style.display = "none";
  }
}

function setupInfiniteScroll(ctx, tab) {
  const { contentEl } = ctx;
  const pane = contentEl.querySelector(".px-grid-pane");
  if (!pane) return;
  pane.addEventListener("scroll", () => {
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 400) {
      loadMoreImages(ctx, tab);
    }
  }, { passive: true });
}

// ── Cards ─────────────────────────────────────────────────────────────────────
function createCard(ctx, illust) {
  illustCache.set(String(illust.id), illust);
  const id = String(illust.id);
  const { S } = ctx;

  const card = document.createElement("div");
  card.className = "px-card";
  card.dataset.id = id;

  const thumb = `/pixiv/image_proxy?url=${encodeURIComponent(illust.image_urls.medium)}`;
  const ratio = (illust.width && illust.height) ? `aspect-ratio:${illust.width}/${illust.height};` : "";
  card.innerHTML = `
    <img src="${thumb}" alt="${esc(illust.title)}" loading="lazy" style="${ratio}width:100%;height:auto;display:block" />
    <div class="px-card-title">${esc(illust.title)}</div>
  `;

  // Bookmark button (toggle)
  const bmBtn = document.createElement("button");
  bmBtn.className = "px-bookmark-btn" + (illust.is_bookmarked ? " bookmarked" : "");
  bmBtn.textContent = illust.is_bookmarked ? "♥" : "♡";
  bmBtn.title = illust.is_bookmarked ? "已收藏（点击取消）" : "收藏到 Pixiv";
  bmBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const isBookmarked = bmBtn.classList.contains("bookmarked");
    const endpoint = isBookmarked ? "/pixiv/bookmark_delete" : "/pixiv/bookmark";
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ illust_id: illust.id }),
      });
      const data = await resp.json();
      if (data.ok) {
        const nowBookmarked = !isBookmarked;
        bmBtn.classList.toggle("bookmarked", nowBookmarked);
        bmBtn.textContent = nowBookmarked ? "♥" : "♡";
        bmBtn.title = nowBookmarked ? "已收藏（点击取消）" : "收藏到 Pixiv";
        const cached = illustCache.get(id);
        if (cached) cached.is_bookmarked = nowBookmarked;
      }
    } catch (_) {}
  });
  card.appendChild(bmBtn);

  // Artist button
  const artistBtn = document.createElement("button");
  artistBtn.className = "px-artist-btn";
  artistBtn.textContent = "↗";
  artistBtn.title = `查看 ${illust.user.name} 的作品`;
  artistBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    viewArtistFromCard(ctx, illust.user);
  });
  card.appendChild(artistBtn);

  // Pixiv link button
  const pixivBtn = document.createElement("a");
  pixivBtn.className = "px-pixiv-btn";
  pixivBtn.textContent = "P";
  pixivBtn.title = "在 Pixiv 上查看";
  pixivBtn.href = `https://www.pixiv.net/artworks/${id}`;
  pixivBtn.target = "_blank";
  pixivBtn.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  card.appendChild(pixivBtn);

  const idx = S.selectedIds.indexOf(id);
  if (idx !== -1) {
    card.classList.add("selected");
    card.insertAdjacentHTML("beforeend", `<div class="px-seq-badge">${idx + 1}</div>`);
  }

  card.addEventListener("click", () => toggleCard(ctx, card, id));
  return card;
}

function toggleCard(ctx, card, id) {
  const { S } = ctx;
  if (!S.multiSelect) {
    // Single-select: clicking a selected card deselects it; otherwise replace selection
    const wasSelected = S.selectedIds.includes(id);
    ctx.contentEl.querySelectorAll(".px-card.selected").forEach(c => {
      c.classList.remove("selected");
      c.querySelector(".px-seq-badge")?.remove();
    });
    S.selectedIds.length = 0;
    if (!wasSelected) {
      S.selectedIds.push(id);
      card.classList.add("selected");
      card.insertAdjacentHTML("beforeend", `<div class="px-seq-badge">1</div>`);
    }
  } else {
    const idx = S.selectedIds.indexOf(id);
    if (idx === -1) {
      S.selectedIds.push(id);
      card.classList.add("selected");
      card.insertAdjacentHTML("beforeend",
        `<div class="px-seq-badge">${S.selectedIds.length}</div>`);
    } else {
      S.selectedIds.splice(idx, 1);
      card.classList.remove("selected");
      card.querySelector(".px-seq-badge")?.remove();
      rebadgeAll(ctx);
    }
  }
  updateCount(ctx);
  commitSelection(ctx);
}

function rebadgeAll(ctx) {
  ctx.contentEl.querySelectorAll(".px-card.selected").forEach(card => {
    const badge = card.querySelector(".px-seq-badge");
    if (badge) badge.textContent = ctx.S.selectedIds.indexOf(card.dataset.id) + 1;
  });
}

// ── Selected pane ─────────────────────────────────────────────────────────────
function renderSelectedPane(ctx) {
  const { contentEl, S } = ctx;

  if (S.selectedIds.length === 0) {
    contentEl.innerHTML = `
      <div class="px-grid-pane" style="display:flex;align-items:center;justify-content:center">
        <div class="px-empty">尚未选择任何图片</div>
      </div>`;
    return;
  }

  contentEl.innerHTML = `<div class="px-grid-pane"><div class="px-grid"></div></div>`;
  const gridEl = contentEl.querySelector(".px-grid");
  const cols   = setupMasonry(gridEl);

  for (const id of [...S.selectedIds]) {
    const illust = illustCache.get(id);
    const card   = document.createElement("div");
    card.className = "px-card selected";
    card.dataset.id = id;

    if (illust) {
      const thumb = `/pixiv/image_proxy?url=${encodeURIComponent(illust.image_urls.medium)}`;
      const ratio = (illust.width && illust.height) ? `aspect-ratio:${illust.width}/${illust.height};` : "";
      card.innerHTML = `
        <img src="${thumb}" alt="${esc(illust.title)}" loading="lazy" style="${ratio}width:100%;height:auto;display:block" />
        <div class="px-card-title">${esc(illust.title)}</div>
        <div class="px-seq-badge">${S.selectedIds.indexOf(id) + 1}</div>
        <button class="px-remove-btn" title="取消选择">✕</button>
      `;
    } else {
      card.innerHTML = `
        <div style="width:100%;aspect-ratio:1;background:#313244;display:flex;align-items:center;justify-content:center;color:#7f849c;font-size:11px">${esc(id)}</div>
        <div class="px-card-title">ID: ${esc(id)}</div>
        <button class="px-remove-btn" title="取消选择">✕</button>
      `;
    }

    card.querySelector(".px-remove-btn").addEventListener("click", () => {
      const i = S.selectedIds.indexOf(id);
      if (i !== -1) {
        S.selectedIds.splice(i, 1);
        updateCount(ctx);
        commitSelection(ctx);
        renderSelectedPane(ctx);
      }
    });

    masonryAdd(cols, card);
  }
}

function viewArtistFromCard(ctx, user) {
  ctx.S.pendingArtistId = { id: user.id, name: user.name, isFollowed: !!user.is_followed };
  delete ctx.S.cachedPanes["artists"];
  switchTab(ctx, "artists");
}

// ── Artist tab ────────────────────────────────────────────────────────────────
async function renderArtistPane(ctx) {
  const { contentEl, S } = ctx;
  const pending = S.pendingArtistId;
  S.pendingArtistId = null;

  contentEl.innerHTML = `
    <div class="px-artist-container">
      <div class="px-rank-bar">
        <span style="flex:1;color:#7f849c;font-size:11px">关注的画师</span>
        <button class="px-refresh-btn">↻ 刷新</button>
      </div>
      <div class="px-artist-pane">
        <div class="px-artist-list"><div class="px-loading">加载中...</div></div>
        <div class="px-artist-works-pane">
          <div class="px-artist-works-placeholder">请从左侧选择画师</div>
        </div>
      </div>
    </div>
  `;
  contentEl.querySelector(".px-refresh-btn").addEventListener("click", () => {
    delete S.cachedPanes["artists"];
    S.activeArtistId = null;
    renderArtistPane(ctx);
  });
  try {
    const resp = await fetch("/pixiv/bookmarked_artists");
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    renderArtistList(ctx, data.artists, contentEl.querySelector(".px-artist-list"));
    if (pending) loadArtistWorks(ctx, pending.id, pending);
  } catch (e) {
    contentEl.querySelector(".px-artist-list").innerHTML =
      `<div class="px-error">加载失败: ${esc(e.message)}</div>`;
  }
}

function renderArtistList(ctx, artists, listEl) {
  listEl.innerHTML = "";
  for (const artist of artists) {
    const item   = document.createElement("div");
    item.className = "px-artist-item";
    const avatar = `/pixiv/image_proxy?url=${encodeURIComponent(artist.profile_image_urls.medium)}`;
    item.innerHTML = `
      <img class="px-artist-avatar" src="${avatar}" alt="" />
      <span class="px-artist-name">${esc(artist.name)}</span>
    `;
    item.addEventListener("click", () => {
      listEl.querySelectorAll(".px-artist-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      loadArtistWorks(ctx, artist.id, { id: artist.id, name: artist.name, isFollowed: true });
    });
    listEl.appendChild(item);
  }
}

async function loadArtistWorks(ctx, artistId, artistInfo = null) {
  const { contentEl, S } = ctx;
  S.activeArtistId = artistId;
  S.artistNextUrl  = undefined;

  const worksPane = contentEl.querySelector(".px-artist-works-pane");
  const headerHTML = artistInfo ? `
    <div class="px-artist-works-header">
      <span class="px-artist-works-name">${esc(artistInfo.name)}</span>
      ${artistInfo.isFollowed
        ? `<span class="px-followed-badge">已关注</span>`
        : `<button class="px-follow-btn" data-uid="${artistInfo.id}">+ 关注</button>`}
    </div>
  ` : "";
  worksPane.innerHTML = `
    ${headerHTML}
    <div class="px-artist-grid-scroll">
      <div class="px-grid"></div>
      <div class="px-loading" style="display:none">加载中...</div>
    </div>
  `;
  S.artistMasonryCols = setupMasonry(worksPane.querySelector(".px-grid"));
  if (artistInfo && !artistInfo.isFollowed) {
    worksPane.querySelector(".px-follow-btn")?.addEventListener("click", async () => {
      try {
        const resp = await fetch("/pixiv/follow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: artistInfo.id }),
        });
        if ((await resp.json()).ok) {
          const btn = worksPane.querySelector(".px-follow-btn");
          if (btn) {
            const badge = document.createElement("span");
            badge.className = "px-followed-badge";
            badge.textContent = "已关注";
            btn.replaceWith(badge);
          }
        }
      } catch (_) {}
    });
  }
  await loadMoreArtistWorks(ctx, artistId);
  setupArtistInfiniteScroll(ctx, artistId);
  attachCustomScrollbar(worksPane.querySelector(".px-artist-grid-scroll"));
}

async function loadMoreArtistWorks(ctx, artistId) {
  const { contentEl, S } = ctx;
  if (S.loading) return;
  if (S.activeArtistId !== artistId) return;
  const nextUrl = S.artistNextUrl;
  if (nextUrl === null) return;

  S.loading = true;
  const scrollEl = contentEl.querySelector(".px-artist-grid-scroll");
  const loadEl   = scrollEl?.querySelector(".px-loading");
  if (loadEl) loadEl.style.display = "flex";

  try {
    const params = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";
    const resp   = await fetch(`/pixiv/artist/${artistId}/works${params}`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (S.activeArtistId !== artistId) return;
    S.artistNextUrl = data.next_url ?? null;
    const cols   = S.artistMasonryCols;
    const gridEl = scrollEl?.querySelector(".px-grid");
    for (const illust of data.illusts) {
      const card = createCard(ctx, illust);
      if (cols?.length) masonryAdd(cols, card);
      else gridEl?.appendChild(card);
    }
    if (scrollEl && scrollEl.scrollHeight <= scrollEl.clientHeight + 50 && S.artistNextUrl !== null) {
      setTimeout(() => loadMoreArtistWorks(ctx, artistId), 0);
    }
  } catch (e) {
    scrollEl?.querySelector(".px-grid")
      ?.insertAdjacentHTML("beforeend", `<div class="px-error">加载失败: ${esc(e.message)}</div>`);
  } finally {
    S.loading = false;
    if (loadEl) loadEl.style.display = "none";
  }
}

function setupArtistInfiniteScroll(ctx, artistId) {
  const scrollEl = ctx.contentEl.querySelector(".px-artist-grid-scroll");
  if (!scrollEl) return;
  scrollEl.addEventListener("scroll", () => {
    if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 400) {
      loadMoreArtistWorks(ctx, artistId);
    }
  }, { passive: true });
}

// ── Search pane ───────────────────────────────────────────────────────────────
function renderSearchPane(ctx) {
  const { contentEl, S } = ctx;
  contentEl.innerHTML = `
    <div class="px-recommended-pane">
      <div class="px-rank-bar" style="gap:6px">
        <input class="px-search-input" type="text" value="${esc(S.searchQuery)}"
          placeholder="搜索作品、标签或画师..."
          style="flex:1;padding:4px 8px;background:#313244;border:1px solid #45475a;
                 border-radius:4px;color:#cdd6f4;font-size:12px;min-width:0;outline:none" />
        <button class="px-search-btn px-rank-btn" style="white-space:nowrap">搜索</button>
      </div>
      <div class="px-rank-bar" style="padding-top:0;border-bottom:1px solid #3a3a5c">
        <button class="px-rank-btn${S.searchType === "illusts" ? " active" : ""}" data-search-type="illusts">作品/标签</button>
        <button class="px-rank-btn${S.searchType === "users" ? " active" : ""}" data-search-type="users">画师</button>
        <span style="flex:1"></span>
      </div>
      <div class="px-rank-grid-wrap">
        <div class="px-grid-pane">
          <div class="px-grid"></div>
          <div class="px-loading" style="display:none">加载中...</div>
        </div>
      </div>
    </div>
  `;

  const input  = contentEl.querySelector(".px-search-input");
  const gridEl = contentEl.querySelector(".px-grid");

  const initGrid = () => {
    if (S.searchType === "illusts") {
      gridEl.removeAttribute("style");
      S.searchMasonryCols = setupMasonry(gridEl);
    } else {
      gridEl.innerHTML = "";
      gridEl.removeAttribute("style");
      Object.assign(gridEl.style, {
        display: "flex", flexDirection: "column", padding: "6px", gap: "2px",
      });
      S.searchMasonryCols = null;
    }
  };

  const doSearch = () => {
    const word = input.value.trim();
    if (!word) return;
    S.searchQuery = word;
    S.searchNextUrl = undefined;
    initGrid();
    loadSearchResults(ctx);
  };

  contentEl.querySelector(".px-search-btn").addEventListener("click", doSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

  contentEl.querySelectorAll("[data-search-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (S.searchType === btn.dataset.searchType) return;
      S.searchType = btn.dataset.searchType;
      contentEl.querySelectorAll("[data-search-type]").forEach(b => {
        b.classList.toggle("active", b.dataset.searchType === S.searchType);
      });
      if (S.searchQuery) {
        S.searchNextUrl = undefined;
        initGrid();
        loadSearchResults(ctx);
      }
    });
  });

  // Infinite scroll for both illusts and users
  const pane = contentEl.querySelector(".px-grid-pane");
  if (pane) {
    pane.addEventListener("scroll", () => {
      if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 400) {
        loadSearchResults(ctx);
      }
    }, { passive: true });
    attachCustomScrollbar(pane);
  }
}

async function loadSearchResults(ctx) {
  const { contentEl, S } = ctx;
  if (S.searchLoading) return;
  if (S.activeTab !== "search") return;
  if (!S.searchQuery) return;
  const nextUrl = S.searchNextUrl;
  if (nextUrl === null) return;

  S.searchLoading = true;
  const pane   = contentEl.querySelector(".px-grid-pane");
  const loadEl = contentEl.querySelector(".px-loading");
  if (loadEl) loadEl.style.display = "flex";

  try {
    if (S.searchType === "illusts") {
      const params = nextUrl
        ? `?next_url=${encodeURIComponent(nextUrl)}`
        : `?word=${encodeURIComponent(S.searchQuery)}`;
      const resp = await fetch(`/pixiv/search/illusts${params}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (S.activeTab !== "search") return;
      S.searchNextUrl = data.next_url ?? null;
      for (const illust of data.illusts) {
        if (S.searchMasonryCols?.length) masonryAdd(S.searchMasonryCols, createCard(ctx, illust));
      }
      if (pane && pane.scrollHeight <= pane.clientHeight + 50 && S.searchNextUrl !== null) {
        setTimeout(() => loadSearchResults(ctx), 0);
      }
    } else {
      // User/artist search
      const params = nextUrl
        ? `?next_url=${encodeURIComponent(nextUrl)}`
        : `?word=${encodeURIComponent(S.searchQuery)}`;
      const resp = await fetch(`/pixiv/search/users${params}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (S.activeTab !== "search") return;
      S.searchNextUrl = data.next_url ?? null;
      const gridEl = contentEl.querySelector(".px-grid");
      for (const artist of data.artists) {
        const item = document.createElement("div");
        item.className = "px-artist-item";
        const avatar = `/pixiv/image_proxy?url=${encodeURIComponent(artist.profile_image_urls.medium)}`;
        item.innerHTML = `
          <img class="px-artist-avatar" src="${avatar}" alt="" />
          <span class="px-artist-name">${esc(artist.name)}</span>
        `;
        item.addEventListener("click", () => {
          viewArtistFromCard(ctx, { id: artist.id, name: artist.name, is_followed: false });
        });
        gridEl?.appendChild(item);
      }
      if (pane && pane.scrollHeight <= pane.clientHeight + 50 && S.searchNextUrl !== null) {
        setTimeout(() => loadSearchResults(ctx), 0);
      }
    }
  } catch (e) {
    pane?.insertAdjacentHTML("beforeend",
      `<div class="px-error">搜索失败: ${esc(e.message)}</div>`);
  } finally {
    S.searchLoading = false;
    if (loadEl) loadEl.style.display = "none";
  }
}

// ── ComfyUI Extension Registration ───────────────────────────────────────────
app.registerExtension({
  name: "pixiv.browser",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PixivBrowser") return;

    nodeType.prototype.onNodeCreated = function () {
      injectCSS();

      // Keep artwork_ids widget for serialization but hide it visually
      const idsWidget = this.widgets?.find(w => w.name === "artwork_ids");
      if (idsWidget) {
        idsWidget.computeSize = () => [0, -4];
      }

      // Create the embedded browser container
      const container = document.createElement("div");

      this.addDOMWidget("pixiv_browser", "div", container, {
        serialize: false,
        getValue:  () => "",
        setValue:  () => {},
      });

      // Default node size — user can resize freely
      this.size = [700, 500];

      initNodeBrowser(container, idsWidget);
    };
  },
});
