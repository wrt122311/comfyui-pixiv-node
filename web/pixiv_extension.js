import { app } from "../../scripts/app.js";

// ── Global illust cache (shared across all node instances) ────────────────────
const illustCache = new Map();

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
    },
  };

  container.className = "px-browser";
  container.innerHTML = `
    <div class="px-tabs">
      <button class="px-tab active" data-tab="recommended">推荐</button>
      <button class="px-tab" data-tab="ranking">排行榜</button>
      <button class="px-tab" data-tab="bookmarks">收藏</button>
      <button class="px-tab" data-tab="artists">画师</button>
      <button class="px-tab px-sel-tab" data-tab="selected">已选</button>
    </div>
    <div class="px-content"></div>
    <div class="px-footer">
      <span class="px-count">已选 0 张</span>
      <button class="px-clear-btn">清除全部</button>
      <button class="px-confirm-btn">✓ 确认选择</button>
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

  // Clear all
  container.querySelector(".px-clear-btn").addEventListener("click", () => {
    ctx.S.selectedIds.length = 0;
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

  // Confirm → write ids to hidden widget so node can execute
  container.querySelector(".px-confirm-btn").addEventListener("click", () => {
    if (ctx.idsWidget) {
      ctx.idsWidget.value = ctx.S.selectedIds.map(id => {
        const url = illustCache.get(id)?.original_url || "";
        return url ? `${id}|${url}` : id;
      }).join(",");
    }
  });

  updateCount(ctx);
  checkLoginAndRender(ctx);
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
    delete S.cachedPanes["recommended"];
    S.nextUrls["recommended"] = undefined;
    renderRecommendedPane(ctx);
  });
  S.nextUrls["recommended"] = undefined;
  loadMoreImages(ctx, "recommended");
  setupInfiniteScroll(ctx, "recommended");
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
    delete S.cachedPanes["bookmarks"];
    S.nextUrls["bookmarks"] = undefined;
    renderBookmarksPane(ctx);
  });
  S.nextUrls["bookmarks"] = undefined;
  loadMoreImages(ctx, "bookmarks");
  setupInfiniteScroll(ctx, "bookmarks");
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
  contentEl.querySelectorAll(".px-rank-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (S.rankingMode === btn.dataset.mode) return;
      S.rankingMode = btn.dataset.mode;
      S.nextUrls["ranking"] = undefined;
      contentEl.querySelectorAll(".px-rank-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const grid = contentEl.querySelector(".px-grid");
      if (grid) grid.innerHTML = "";
      loadMoreImages(ctx, "ranking");
    });
  });
  contentEl.querySelector(".px-refresh-btn").addEventListener("click", () => {
    delete S.cachedPanes["ranking"];
    S.nextUrls["ranking"] = undefined;
    renderRankingPane(ctx);
  });
  S.nextUrls["ranking"] = undefined;
  loadMoreImages(ctx, "ranking");
  setupInfiniteScroll(ctx, "ranking");
}

// ── Main image browser ────────────────────────────────────────────────────────
async function openMainBrowser(ctx) {
  const { contentEl, S } = ctx;
  contentEl.innerHTML = `
    <div class="px-grid-pane">
      <div class="px-grid"></div>
      <div class="px-loading" style="display:none">加载中...</div>
    </div>
  `;
  const tab = S.activeTab;
  S.nextUrls[tab] = undefined;
  await loadMoreImages(ctx, tab);
  setupInfiniteScroll(ctx, tab);
}

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
  if (S.activeTab !== tab) return;   // tab switched while async, abort
  const nextUrl = S.nextUrls[tab];
  if (nextUrl === null) return;

  S.loading = true;
  const pane   = contentEl.querySelector(".px-grid-pane");
  const loadEl = contentEl.querySelector(".px-loading");
  if (loadEl) loadEl.style.display = "flex";

  try {
    const data = await fetchImages(tab, nextUrl, S);
    if (S.activeTab !== tab) return;  // switched while awaiting
    S.nextUrls[tab] = data.next_url ?? null;
    const gridEl = contentEl.querySelector(".px-grid");
    for (const illust of data.illusts) {
      gridEl.appendChild(createCard(ctx, illust));
    }
    // If content still doesn't fill the pane, load next page automatically
    if (pane && pane.scrollHeight <= pane.clientHeight + 50 && S.nextUrls[tab] !== null) {
      setTimeout(() => loadMoreImages(ctx, tab), 0);
    }
  } catch (e) {
    contentEl.querySelector(".px-grid")
      ?.insertAdjacentHTML("beforeend", `<div class="px-error">加载失败: ${esc(e.message)}</div>`);
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
  card.innerHTML = `
    <img src="${thumb}" alt="${esc(illust.title)}" loading="lazy" />
    <div class="px-card-title">${esc(illust.title)}</div>
  `;

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
  updateCount(ctx);
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
  contentEl.innerHTML = `<div class="px-grid-pane"><div class="px-grid"></div></div>`;
  const grid = contentEl.querySelector(".px-grid");

  if (S.selectedIds.length === 0) {
    grid.innerHTML = `<div class="px-empty">尚未选择任何图片</div>`;
    return;
  }

  for (const id of [...S.selectedIds]) {
    const illust = illustCache.get(id);
    const card   = document.createElement("div");
    card.className = "px-card selected";
    card.dataset.id = id;

    if (illust) {
      const thumb = `/pixiv/image_proxy?url=${encodeURIComponent(illust.image_urls.medium)}`;
      card.innerHTML = `
        <img src="${thumb}" alt="${esc(illust.title)}" loading="lazy" />
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
        card.remove();
        updateCount(ctx);
        if (S.selectedIds.length === 0) {
          grid.innerHTML = `<div class="px-empty">尚未选择任何图片</div>`;
        } else {
          grid.querySelectorAll(".px-card").forEach(c => {
            const b = c.querySelector(".px-seq-badge");
            if (b) b.textContent = S.selectedIds.indexOf(c.dataset.id) + 1;
          });
        }
      }
    });

    grid.appendChild(card);
  }
}

// ── Artist tab ────────────────────────────────────────────────────────────────
async function renderArtistPane(ctx) {
  const { contentEl, S } = ctx;
  contentEl.innerHTML = `
    <div class="px-artist-container">
      <div class="px-rank-bar">
        <span style="flex:1;color:#7f849c;font-size:11px">关注的画师</span>
        <button class="px-refresh-btn">↻ 刷新</button>
      </div>
      <div class="px-artist-pane">
        <div class="px-artist-list"><div class="px-loading">加载中...</div></div>
        <div class="px-artist-works-pane">
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#7f849c;font-size:12px">请从左侧选择画师</div>
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
      loadArtistWorks(ctx, artist.id);
    });
    listEl.appendChild(item);
  }
}

async function loadArtistWorks(ctx, artistId) {
  const { contentEl, S } = ctx;
  S.activeArtistId = artistId;
  S.artistNextUrl  = undefined;

  const worksPane = contentEl.querySelector(".px-artist-works-pane");
  worksPane.innerHTML = `
    <div class="px-grid"></div>
    <div class="px-loading" style="display:none">加载中...</div>
  `;
  await loadMoreArtistWorks(ctx, artistId);
  setupArtistInfiniteScroll(ctx, artistId);
}

async function loadMoreArtistWorks(ctx, artistId) {
  const { contentEl, S } = ctx;
  if (S.loading) return;
  if (S.activeArtistId !== artistId) return;  // artist switched, abort
  const nextUrl = S.artistNextUrl;
  if (nextUrl === null) return;

  S.loading = true;
  const worksPane = contentEl.querySelector(".px-artist-works-pane");
  const loadEl    = worksPane?.querySelector(".px-loading");
  if (loadEl) loadEl.style.display = "flex";

  try {
    const params = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";
    const resp   = await fetch(`/pixiv/artist/${artistId}/works${params}`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (S.activeArtistId !== artistId) return;  // switched while awaiting
    S.artistNextUrl = data.next_url ?? null;
    const gridEl = worksPane?.querySelector(".px-grid");
    for (const illust of data.illusts) {
      gridEl?.appendChild(createCard(ctx, illust));
    }
    // Auto-fill if pane not yet scrollable
    if (worksPane && worksPane.scrollHeight <= worksPane.clientHeight + 50 && S.artistNextUrl !== null) {
      setTimeout(() => loadMoreArtistWorks(ctx, artistId), 0);
    }
  } catch (e) {
    worksPane?.querySelector(".px-grid")
      ?.insertAdjacentHTML("beforeend", `<div class="px-error">加载失败: ${esc(e.message)}</div>`);
  } finally {
    S.loading = false;
    if (loadEl) loadEl.style.display = "none";
  }
}

function setupArtistInfiniteScroll(ctx, artistId) {
  const { contentEl } = ctx;
  const worksPane = contentEl.querySelector(".px-artist-works-pane");
  if (!worksPane) return;
  worksPane.addEventListener("scroll", () => {
    if (worksPane.scrollHeight - worksPane.scrollTop - worksPane.clientHeight < 400) {
      loadMoreArtistWorks(ctx, artistId);
    }
  }, { passive: true });
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
