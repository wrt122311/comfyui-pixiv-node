import { app } from "../../scripts/app.js";

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  selectedIds: [],
  activeTab: "recommended",
  nextUrls: {},
  loading: false,
  activeArtistId: null,
  artistNextUrl: null,
};

// Persists across modal opens so the "已选" panel can show thumbnails
const illustCache = new Map();

// ── CSS injection ─────────────────────────────────────────────────────────────

function injectCSS() {
  if (document.getElementById("pixiv-dialog-css")) return;
  const link = document.createElement("link");
  link.id = "pixiv-dialog-css";
  link.rel = "stylesheet";
  link.href = new URL("pixiv_dialog.css", import.meta.url).href;
  document.head.appendChild(link);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateSelectedCount() {
  const el = document.getElementById("pixiv-selected-count");
  if (el) el.textContent = `已选 ${state.selectedIds.length} 张`;
  const tabEl = document.getElementById("pixiv-selected-tab");
  if (tabEl) tabEl.textContent = state.selectedIds.length > 0
    ? `已选 (${state.selectedIds.length})` : "已选";
}

// ── Modal DOM ─────────────────────────────────────────────────────────────────

function buildModal() {
  const overlay = document.createElement("div");
  overlay.id = "pixiv-modal-overlay";
  overlay.innerHTML = `
    <div id="pixiv-modal">
      <div id="pixiv-modal-header">
        <h2>📷 Pixiv Browser</h2>
        <span id="pixiv-selected-count">已选 0 张</span>
        <button id="pixiv-clear-all-btn" title="清除全部选择">清除全部</button>
        <button id="pixiv-close-btn" title="关闭">✕</button>
      </div>
      <div id="pixiv-tabs">
        <button class="pixiv-tab active" data-tab="recommended">推荐</button>
        <button class="pixiv-tab" data-tab="ranking">排行榜</button>
        <button class="pixiv-tab" data-tab="bookmarks">收藏</button>
        <button class="pixiv-tab" data-tab="artists">画师</button>
        <button class="pixiv-tab" data-tab="selected" id="pixiv-selected-tab">已选</button>
      </div>
      <div id="pixiv-content"></div>
      <div id="pixiv-modal-footer">
        <button id="pixiv-cancel-btn">取消</button>
        <button id="pixiv-confirm-btn">✓ 确认选择</button>
      </div>
    </div>
  `;
  return overlay;
}

function closeModal() {
  document.getElementById("pixiv-modal-overlay")?.remove();
}

// ── Open modal ────────────────────────────────────────────────────────────────

async function openModal(node, idsWidget) {
  injectCSS();

  // Restore previously selected ids from widget
  Object.assign(state, {
    selectedIds: idsWidget?.value
      ? idsWidget.value.split(",").map(s => s.trim()).filter(Boolean)
      : [],
    activeTab: "recommended",
    nextUrls: {},
    loading: false,
    activeArtistId: null,
    artistNextUrl: null,
  });

  const overlay = buildModal();
  document.body.appendChild(overlay);
  updateSelectedCount();

  const contentEl = document.getElementById("pixiv-content");

  // Header buttons
  document.getElementById("pixiv-close-btn").addEventListener("click", closeModal);
  document.getElementById("pixiv-cancel-btn").addEventListener("click", closeModal);
  document.getElementById("pixiv-confirm-btn").addEventListener("click", () => {
    if (idsWidget) {
      // Format: "id|originalUrl,id|originalUrl,..." so the node can skip illust_detail calls
      idsWidget.value = state.selectedIds.map(id => {
        const url = illustCache.get(id)?.original_url || "";
        return url ? `${id}|${url}` : id;
      }).join(",");
    }
    closeModal();
  });

  document.getElementById("pixiv-clear-all-btn").addEventListener("click", () => {
    state.selectedIds.length = 0;
    updateSelectedCount();
    if (state.activeTab === "selected") {
      renderSelectedPane(contentEl);
    } else {
      document.querySelectorAll(".pixiv-card.selected").forEach(card => {
        card.classList.remove("selected");
        card.querySelector(".pixiv-seq-badge")?.remove();
      });
    }
  });

  // Tab buttons
  document.querySelectorAll(".pixiv-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab, contentEl));
  });

  // Close on overlay click
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  // Check login status
  try {
    const resp = await fetch("/pixiv/status");
    const status = await resp.json();
    if (!status.logged_in) {
      renderLoginPage(contentEl);
    } else {
      openMainBrowser(contentEl);
    }
  } catch (e) {
    contentEl.innerHTML = `<div class="pixiv-error">无法连接到 ComfyUI 后端: ${e.message}</div>`;
  }
}

// ── Login page ────────────────────────────────────────────────────────────────

function renderLoginPage(contentEl) {
  contentEl.innerHTML = `
    <div id="pixiv-login-page">
      <h3 style="color:#cba6f7;margin:0">登录 Pixiv</h3>

      <div style="display:flex;gap:0;border:1px solid #3a3a5c;border-radius:6px;overflow:hidden;max-width:480px;width:100%">
        <button class="pixiv-login-tab active" data-login-tab="token"
          style="flex:1;padding:8px;background:#2a2a3e;border:none;color:#cba6f7;cursor:pointer;font-size:13px">
          🔑 Refresh Token（推荐）
        </button>
        <button class="pixiv-login-tab" data-login-tab="oauth"
          style="flex:1;padding:8px;background:transparent;border:none;color:#7f849c;cursor:pointer;font-size:13px">
          🌐 OAuth 授权
        </button>
      </div>

      <!-- Token 直接输入面板 -->
      <div id="pixiv-panel-token" style="width:100%;max-width:480px;display:flex;flex-direction:column;gap:10px">
        <div style="background:#181825;border:1px solid #3a3a5c;border-radius:6px;padding:12px 16px;font-size:13px;line-height:1.8">
          <b style="color:#cba6f7">获取 Refresh Token 方法（推荐）：</b>
          <ol style="margin:6px 0 0 16px;padding:0;color:#cdd6f4">
            <li>在 ComfyUI Python 环境中安装工具：<br>
                <code style="background:#0d1117;padding:2px 6px;border-radius:3px;color:#a6e3a1">pip install gppt</code></li>
            <li>运行登录命令：<br>
                <code style="background:#0d1117;padding:2px 6px;border-radius:3px;color:#a6e3a1">gppt login-headless -u 邮箱 -p 密码</code></li>
            <li>复制输出中的 <code style="color:#a6e3a1">refresh_token</code> 值，粘贴到下方</li>
          </ol>
        </div>
        <input id="pixiv-token-input" type="password" placeholder="粘贴 refresh_token 到此处"
          style="width:100%;box-sizing:border-box;padding:8px 12px;background:#181825;border:1px solid #3a3a5c;border-radius:4px;color:#cdd6f4;font-size:13px" />
        <button id="pixiv-save-token-btn"
          style="padding:9px 20px;background:#cba6f7;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:14px">
          保存并登录
        </button>
        <p id="pixiv-token-error" style="color:#f38ba8;display:none;margin:0;font-size:13px"></p>
      </div>

      <!-- OAuth 面板 -->
      <div id="pixiv-panel-oauth" style="width:100%;max-width:480px;display:none;flex-direction:column;gap:10px">
        <div style="background:#181825;border:1px solid #3a3a5c;border-radius:6px;padding:12px 16px;font-size:13px;line-height:1.8">
          <b style="color:#cba6f7">操作步骤：</b>
          <ol style="margin:6px 0 0 16px;padding:0;color:#cdd6f4">
            <li>点击按钮，在新标签页完成 Pixiv 账号登录</li>
            <li>登录后浏览器可能白屏，查看<b>地址栏</b>是否出现
                <code style="color:#a6e3a1">pixiv://account/login?code=</code> 开头的 URL</li>
            <li>若地址栏有此 URL，复制并粘贴到下方输入框</li>
            <li>若地址栏无此 URL，请改用上方"Refresh Token"方式</li>
          </ol>
        </div>
        <button id="pixiv-login-btn"
          style="padding:9px 20px;background:#cba6f7;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:14px">
          ① 用浏览器登录 Pixiv
        </button>
        <div id="pixiv-callback-section" style="display:none;width:100%;flex-direction:column;gap:8px">
          <p style="color:#a6e3a1;margin:0;font-size:13px">✓ 已打开授权页，完成登录后将地址栏 URL 粘贴到下方</p>
          <input id="pixiv-redirect-input" type="text" placeholder="pixiv://account/login?code=..."
            style="width:100%;box-sizing:border-box;padding:8px 12px;background:#181825;border:1px solid #3a3a5c;border-radius:4px;color:#cdd6f4;font-size:13px" />
          <button id="pixiv-submit-code-btn"
            style="padding:8px 20px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-weight:bold">
            ② 确认登录
          </button>
        </div>
        <p id="pixiv-oauth-error" style="color:#f38ba8;display:none;margin:0;font-size:13px"></p>
      </div>
    </div>
  `;

  // Login tab switching
  document.querySelectorAll(".pixiv-login-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pixiv-login-tab").forEach(b => {
        b.style.background = "transparent";
        b.style.color = "#7f849c";
        b.classList.remove("active");
      });
      btn.style.background = "#2a2a3e";
      btn.style.color = "#cba6f7";
      btn.classList.add("active");
      const tab = btn.dataset.loginTab;
      document.getElementById("pixiv-panel-token").style.display = tab === "token" ? "flex" : "none";
      document.getElementById("pixiv-panel-oauth").style.display = tab === "oauth" ? "flex" : "none";
    });
  });

  // ── Token direct input ────────────────────────────────────────────────────
  document.getElementById("pixiv-save-token-btn").addEventListener("click", async () => {
    const token = document.getElementById("pixiv-token-input").value.trim();
    const errEl = document.getElementById("pixiv-token-error");
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
        openMainBrowser(contentEl);
      } else {
        errEl.textContent = data.error || "Token 无效，请检查后重试";
        errEl.style.display = "block";
      }
    } catch (e) {
      errEl.textContent = "网络错误：" + e.message;
      errEl.style.display = "block";
    }
  });

  // ── OAuth flow ────────────────────────────────────────────────────────────
  document.getElementById("pixiv-login-btn").addEventListener("click", async () => {
    try {
      const resp = await fetch("/pixiv/auth/login", { method: "POST" });
      const data = await resp.json();
      window.open(data.auth_url, "_blank");
      document.getElementById("pixiv-callback-section").style.display = "flex";
    } catch (e) {
      console.error("[PixivBrowser] Login init failed:", e);
    }
  });

  document.getElementById("pixiv-submit-code-btn").addEventListener("click", async () => {
    const redirectUrl = document.getElementById("pixiv-redirect-input").value.trim();
    const errEl = document.getElementById("pixiv-oauth-error");
    if (!redirectUrl) return;
    if (!redirectUrl.startsWith("pixiv://")) {
      errEl.textContent = "请粘贴以 pixiv:// 开头的地址，当前粘贴的是登录前的跳转地址";
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
        openMainBrowser(contentEl);
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

function switchTab(tabName, contentEl) {
  state.activeTab = tabName;
  document.querySelectorAll(".pixiv-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  openMainBrowser(contentEl);
}

async function openMainBrowser(contentEl) {
  if (state.activeTab === "artists") {
    renderArtistPane(contentEl);
    return;
  }
  if (state.activeTab === "selected") {
    renderSelectedPane(contentEl);
    return;
  }
  contentEl.innerHTML = `
    <div id="pixiv-grid-pane">
      <div class="pixiv-grid" id="pixiv-image-grid"></div>
      <div class="pixiv-loading" id="pixiv-load-more" style="display:none">加载中...</div>
      <div id="pixiv-scroll-sentinel"></div>
    </div>
  `;
  const tab = state.activeTab;
  state.nextUrls[tab] = undefined;
  await loadMoreImages(tab);
  setupInfiniteScroll(tab);
}

// ── Image grid ────────────────────────────────────────────────────────────────

async function fetchImages(tab, nextUrl) {
  const params = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";
  const urlMap = {
    recommended: `/pixiv/recommended${params}`,
    ranking:     `/pixiv/ranking${params}`,
    bookmarks:   `/pixiv/bookmarks${params}`,
  };
  const resp = await fetch(urlMap[tab]);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function loadMoreImages(tab) {
  if (state.loading) return;
  const nextUrl = state.nextUrls[tab];
  if (nextUrl === null) return;

  state.loading = true;
  const loadEl = document.getElementById("pixiv-load-more");
  if (loadEl) loadEl.style.display = "flex";

  try {
    const data = await fetchImages(tab, nextUrl);
    state.nextUrls[tab] = data.next_url ?? null;
    appendIllusts(data.illusts, document.getElementById("pixiv-image-grid"));
  } catch (e) {
    document.getElementById("pixiv-image-grid")
      ?.insertAdjacentHTML("beforeend", `<div class="pixiv-error">加载失败: ${e.message}</div>`);
  } finally {
    state.loading = false;
    if (loadEl) loadEl.style.display = "none";
  }
}

function appendIllusts(illusts, gridEl) {
  if (!gridEl) return;
  for (const illust of illusts) gridEl.appendChild(createCard(illust));
}

function createCard(illust) {
  illustCache.set(String(illust.id), illust);
  const card = document.createElement("div");
  card.className = "pixiv-card";
  card.dataset.id = String(illust.id);

  const thumb = `/pixiv/image_proxy?url=${encodeURIComponent(illust.image_urls.medium)}`;
  card.innerHTML = `
    <img src="${thumb}" alt="${escapeHtml(illust.title)}" loading="lazy" />
    <div class="pixiv-card-title">${escapeHtml(illust.title)}</div>
  `;

  const idx = state.selectedIds.indexOf(String(illust.id));
  if (idx !== -1) {
    card.classList.add("selected");
    card.insertAdjacentHTML("beforeend",
      `<div class="pixiv-seq-badge">${idx + 1}</div>`);
  }

  card.addEventListener("click", () => toggleCard(card, String(illust.id)));
  return card;
}

function toggleCard(card, id) {
  const idx = state.selectedIds.indexOf(id);
  if (idx === -1) {
    state.selectedIds.push(id);
    card.classList.add("selected");
    card.insertAdjacentHTML("beforeend",
      `<div class="pixiv-seq-badge">${state.selectedIds.length}</div>`);
  } else {
    state.selectedIds.splice(idx, 1);
    card.classList.remove("selected");
    card.querySelector(".pixiv-seq-badge")?.remove();
    rebadgeAll();
  }
  updateSelectedCount();
}

function rebadgeAll() {
  document.querySelectorAll(".pixiv-card.selected").forEach(card => {
    const badge = card.querySelector(".pixiv-seq-badge");
    if (badge) badge.textContent = state.selectedIds.indexOf(card.dataset.id) + 1;
  });
}

function setupInfiniteScroll(tab) {
  const sentinel = document.getElementById("pixiv-scroll-sentinel");
  if (!sentinel) return;
  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMoreImages(tab);
  }, { rootMargin: "200px" }).observe(sentinel);
}

// ── Selected pane ─────────────────────────────────────────────────────────────

function renderSelectedPane(contentEl) {
  contentEl.innerHTML = `
    <div id="pixiv-grid-pane">
      <div class="pixiv-grid" id="pixiv-selected-grid"></div>
    </div>
  `;
  const grid = document.getElementById("pixiv-selected-grid");

  if (state.selectedIds.length === 0) {
    grid.innerHTML = `<div style="color:#7f849c;padding:40px;text-align:center;grid-column:1/-1">尚未选择任何图片</div>`;
    return;
  }

  for (const id of [...state.selectedIds]) {
    const illust = illustCache.get(id);
    const card = document.createElement("div");
    card.className = "pixiv-card selected";
    card.dataset.id = id;

    if (illust) {
      const thumb = `/pixiv/image_proxy?url=${encodeURIComponent(illust.image_urls.medium)}`;
      card.innerHTML = `
        <img src="${thumb}" alt="${escapeHtml(illust.title)}" loading="lazy" />
        <div class="pixiv-card-title">${escapeHtml(illust.title)}</div>
        <div class="pixiv-seq-badge">${state.selectedIds.indexOf(id) + 1}</div>
        <button class="pixiv-card-remove-btn" title="取消选择">✕</button>
      `;
    } else {
      card.innerHTML = `
        <div style="width:100%;aspect-ratio:1;background:#313244;display:flex;align-items:center;justify-content:center;color:#7f849c;font-size:12px">${id}</div>
        <div class="pixiv-card-title">ID: ${escapeHtml(id)}</div>
        <button class="pixiv-card-remove-btn" title="取消选择">✕</button>
      `;
    }

    card.querySelector(".pixiv-card-remove-btn").addEventListener("click", () => {
      const idx = state.selectedIds.indexOf(id);
      if (idx !== -1) {
        state.selectedIds.splice(idx, 1);
        card.remove();
        updateSelectedCount();
        if (state.selectedIds.length === 0) {
          grid.innerHTML = `<div style="color:#7f849c;padding:40px;text-align:center;grid-column:1/-1">尚未选择任何图片</div>`;
        } else {
          // Update remaining badge numbers
          grid.querySelectorAll(".pixiv-card").forEach(c => {
            const badge = c.querySelector(".pixiv-seq-badge");
            if (badge) badge.textContent = state.selectedIds.indexOf(c.dataset.id) + 1;
          });
        }
      }
    });

    grid.appendChild(card);
  }
}

// ── Artist tab ────────────────────────────────────────────────────────────────

async function renderArtistPane(contentEl) {
  contentEl.innerHTML = `
    <div id="pixiv-artist-pane">
      <div id="pixiv-artist-list"><div class="pixiv-loading">加载中...</div></div>
      <div id="pixiv-artist-works-pane">
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#7f849c">
          请从左侧选择一位画师
        </div>
      </div>
    </div>
  `;
  try {
    const resp = await fetch("/pixiv/bookmarked_artists");
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    renderArtistList(data.artists, document.getElementById("pixiv-artist-list"));
  } catch (e) {
    document.getElementById("pixiv-artist-list").innerHTML =
      `<div class="pixiv-error">加载失败: ${e.message}</div>`;
  }
}

function renderArtistList(artists, listEl) {
  listEl.innerHTML = "";
  for (const artist of artists) {
    const item = document.createElement("div");
    item.className = "pixiv-artist-item";
    item.dataset.id = String(artist.id);
    const avatar = `/pixiv/image_proxy?url=${encodeURIComponent(artist.profile_image_urls.medium)}`;
    item.innerHTML = `
      <img class="pixiv-artist-avatar" src="${avatar}" alt="" />
      <span class="pixiv-artist-name">${escapeHtml(artist.name)}</span>
    `;
    item.addEventListener("click", () => {
      document.querySelectorAll(".pixiv-artist-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      loadArtistWorks(artist.id);
    });
    listEl.appendChild(item);
  }
}

async function loadArtistWorks(artistId) {
  state.activeArtistId = artistId;
  state.artistNextUrl = undefined;

  const worksPane = document.getElementById("pixiv-artist-works-pane");
  worksPane.innerHTML = `
    <div class="pixiv-grid" id="pixiv-artist-grid"></div>
    <div class="pixiv-loading" id="pixiv-artist-load-more" style="display:none">加载中...</div>
    <div id="pixiv-artist-scroll-sentinel"></div>
  `;
  await loadMoreArtistWorks(artistId);
  setupArtistInfiniteScroll(artistId);
}

async function loadMoreArtistWorks(artistId) {
  if (state.loading) return;
  const nextUrl = state.artistNextUrl;
  if (nextUrl === null) return;

  state.loading = true;
  const loadEl = document.getElementById("pixiv-artist-load-more");
  if (loadEl) loadEl.style.display = "flex";

  try {
    const params = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";
    const resp = await fetch(`/pixiv/artist/${artistId}/works${params}`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    state.artistNextUrl = data.next_url ?? null;
    appendIllusts(data.illusts, document.getElementById("pixiv-artist-grid"));
  } catch (e) {
    document.getElementById("pixiv-artist-grid")
      ?.insertAdjacentHTML("beforeend", `<div class="pixiv-error">加载失败: ${e.message}</div>`);
  } finally {
    state.loading = false;
    if (loadEl) loadEl.style.display = "none";
  }
}

function setupArtistInfiniteScroll(artistId) {
  const sentinel = document.getElementById("pixiv-artist-scroll-sentinel");
  if (!sentinel) return;
  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMoreArtistWorks(artistId);
  }, { rootMargin: "200px" }).observe(sentinel);
}

// ── ComfyUI Extension Registration ───────────────────────────────────────────

app.registerExtension({
  name: "pixiv.browser",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PixivBrowser") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);

      // Hide the artwork_ids text widget (still serialized, just invisible)
      const idsWidget = this.widgets?.find(w => w.name === "artwork_ids");
      if (idsWidget) {
        idsWidget.computeSize = () => [0, -4];
      }

      // Add browse button
      this.addWidget("button", "🖼 浏览 Pixiv", null, () => {
        openModal(this, idsWidget);
      });

      return result;
    };
  },
});
