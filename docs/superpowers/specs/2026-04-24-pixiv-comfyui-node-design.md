# ComfyUI Pixiv Browser Node — Design Spec

**Date:** 2026-04-24  
**Status:** Approved

---

## Overview

A ComfyUI custom node that lets users browse Pixiv (recommended works, rankings, bookmarks, artists) inside a popup dialog, select multiple images, and output them as an `IMAGE` batch tensor to downstream nodes.

---

## Architecture

### Approach
ComfyUI native extension pattern:
- **Python backend** registers REST API routes on `PromptServer.instance.routes` (aiohttp)
- **JS frontend** loaded as a ComfyUI extension (`web/pixiv_extension.js`), adds a button widget to the node and opens a modal dialog
- No extra ports or processes required

### Directory Structure

```
comfyui-pixiv-node/
├── __init__.py              # Node registration + API route registration
├── pixiv_node.py            # ComfyUI node class (PixivBrowser)
├── pixiv_client.py          # pixivpy3 wrapper (auth, fetch, download)
├── config.py                # Token persistence (read/write config.json)
├── config.json              # refresh_token storage (gitignored)
├── web/
│   ├── pixiv_extension.js   # ComfyUI JS extension (node UI + modal)
│   └── pixiv_dialog.css     # Modal styles
└── requirements.txt         # pixivpy3, aiohttp, Pillow
```

---

## Components

### `pixiv_client.py`
Wraps pixivpy3. Responsibilities:
- OAuth PKCE login flow (generate code_verifier/challenge, exchange code for tokens)
- Auto-refresh access_token using stored refresh_token
- Fetch: recommended illusts, ranking, bookmarks, bookmarked artists, artist works
- Download original image bytes given artwork ID

### `config.py`
- Reads/writes `config.json` next to the module
- Stores: `refresh_token`, optional cache settings
- `config.json` is gitignored

### `pixiv_node.py`
```python
class PixivBrowser:
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    CATEGORY = "image/pixiv"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {"artwork_ids": "STRING"}  # set by JS after selection
        }

    def execute(self, artwork_ids):
        # Download selected images via pixiv_client
        # Convert to torch.Tensor [B, H, W, 3]
        # Skip failed downloads, output remaining batch
```

### `__init__.py`
- Registers `PixivBrowser` node in `NODE_CLASS_MAPPINGS`
- Registers all `/pixiv/...` API routes on ComfyUI's aiohttp server
- Catches `ImportError` for pixivpy3 and prints install instructions

### `web/pixiv_extension.js`
- Registers a ComfyUI extension for the `PixivBrowser` node type
- Adds a "浏览 Pixiv" button widget to the node
- On click: opens a full-screen modal dialog
- Modal contains: Tab nav → image grid with multi-select → confirm button
- On confirm: writes selected `artwork_ids` (comma-separated) to the hidden widget
- Pure vanilla JS, no framework dependencies

---

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/pixiv/status` | GET | Login status (`{logged_in: bool, username: str}`) |
| `/pixiv/auth/login` | POST | Generate OAuth PKCE URL, return auth URL |
| `/pixiv/auth/callback` | POST | Receive `{redirect_url, code_verifier}`, extract code, exchange for tokens, save to config |
| `/pixiv/recommended` | GET | Recommended illusts (`?page=1`) |
| `/pixiv/ranking` | GET | Ranking (`?mode=day&page=1`) |
| `/pixiv/bookmarks` | GET | Bookmarked illusts |
| `/pixiv/bookmarked_artists` | GET | Bookmarked artist list |
| `/pixiv/artist/:id/works` | GET | Works by a specific artist |
| `/pixiv/image_proxy` | GET | Proxy Pixiv thumbnail/image (`?url=...`) to bypass referer restriction |

All list endpoints return paginated JSON: `{illusts: [...], next_url: str|null}`.  
Each illust object includes: `id`, `title`, `image_urls.medium`, `image_urls.large`, `user.id`, `user.name`, `user.profile_image_urls.medium`.

---

## Modal UI Structure

```
┌─────────────────────────────────────────────┐
│  Pixiv Browser          [已选 3 张] [✕ 关闭] │
├─────────────────────────────────────────────┤
│  [ 推荐 | 排行榜 | 收藏 | 画师 ]             │
├─────────────────────────────────────────────┤
│                                             │
│  [ 图片网格，无限滚动，多选高亮+序号 ]        │
│                                             │
│  （画师 Tab：左栏画师列表 | 右栏作品网格）    │
│                                             │
├─────────────────────────────────────────────┤
│  已选 3 张           [ 取消 ] [ ✓ 确认选择 ] │
└─────────────────────────────────────────────┘
```

**Image grid card behavior:**
- Click → toggle selected (blue border + sequence number badge)
- Thumbnails loaded via `/pixiv/image_proxy`
- IntersectionObserver triggers next page load at bottom

**Artist Tab:**
- Left panel: bookmarked artists (avatar + name), click to load works
- Right panel: that artist's work grid (same multi-select behavior)

---

## Login Flow

pixivpy3 uses OAuth PKCE. After the user authorizes, Pixiv redirects to `pixiv://account/login?code=XXX` (a custom URI scheme, not HTTP). The browser cannot deliver this to a local server automatically, so the user pastes the redirect URL manually.

```
Open modal (not logged in)
  → Show login screen
  → User clicks "用浏览器登录 Pixiv"
  → POST /pixiv/auth/login → returns {auth_url, code_verifier}
  → JS opens auth_url in new tab
  → User completes login in browser
  → Browser shows redirect to pixiv://account/login?code=XXX (may show error page)
  → Modal shows a text input: "请将浏览器地址栏中的完整 URL 粘贴到此处"
  → User copies the pixiv:// URL and pastes it into the input
  → POST /pixiv/auth/callback {redirect_url, code_verifier}
  → Python extracts code from URL, exchanges for tokens via pixivpy3
  → refresh_token saved to config.json
  → Modal auto-refreshes to main browsing view
```

Subsequent startups: `pixiv_client.py` reads refresh_token from config.json and calls `auth.login(refresh_token=...)` automatically.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Access token expired | `pixiv_client` auto-refreshes via refresh_token before retrying |
| Network timeout | API route returns `{error: "timeout"}`, modal shows retry button |
| Image download fails in execute() | Skip failed IDs, output remaining batch; log warning |
| `artwork_ids` widget empty on execute | Raise `ValueError`: "请先在弹窗中选择图片" |
| pixivpy3 not installed | `__init__.py` catches ImportError, prints: `pip install pixivpy3` |

---

## Node Output Spec

```python
RETURN_TYPES = ("IMAGE",)
# torch.Tensor shape: [B, H, W, 3], dtype=float32, range [0.0, 1.0]
# B = number of selected images
# H, W = original image dimensions (no forced resize)
```

---

## Dependencies

```
pixivpy3>=3.7.0
Pillow>=9.0.0
aiohttp  # already bundled with ComfyUI
torch    # already bundled with ComfyUI
```

---

## Security Notes

- `config.json` must be in `.gitignore` (contains OAuth refresh token)
- `/pixiv/image_proxy` only proxies URLs matching `*.pximg.net` to prevent open proxy abuse
- OAuth PKCE code_verifier stored in server memory only for the duration of the auth flow
