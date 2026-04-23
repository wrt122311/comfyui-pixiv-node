# ComfyUI Pixiv Browser Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ComfyUI custom node that browses Pixiv via pixivpy3, shows a popup image browser (recommended/ranking/bookmarks/artists), supports multi-select, and outputs selected images as a batch IMAGE tensor.

**Architecture:** Python backend registers REST API routes on ComfyUI's built-in aiohttp server (`PromptServer.instance.routes`). A vanilla-JS ComfyUI extension adds a button widget to the node and opens a modal dialog that calls those routes. No extra processes or ports required.

**Tech Stack:** Python 3.10+, pixivpy3, Pillow, torch, aiohttp (bundled with ComfyUI), pytest, vanilla JS (ES2020)

---

## File Map

| File | Responsibility |
|------|---------------|
| `requirements.txt` | Package dependencies |
| `config.py` | Read/write `config.json` (refresh_token) |
| `pixiv_client.py` | pixivpy3 wrapper: auth, fetch illusts/artists, download bytes |
| `pixiv_node.py` | ComfyUI `PixivBrowser` node class — `execute()` downloads + returns IMAGE tensor |
| `__init__.py` | ComfyUI entry: create singletons, register API routes, register node |
| `web/pixiv_dialog.css` | Modal styles (dark theme, image grid, tabs, artist panel) |
| `web/pixiv_extension.js` | ComfyUI JS extension: node button, modal, login flow, browser UI |
| `tests/__init__.py` | Empty (makes tests a package) |
| `tests/test_config.py` | Unit tests for Config |
| `tests/test_pixiv_client.py` | Unit tests for PixivClient (mocked pixivpy3) |
| `tests/test_pixiv_node.py` | Unit tests for PixivBrowser.execute() (mocked client) |

---

## Task 1: Project Scaffold

**Files:**
- Create: `requirements.txt`
- Create: `tests/__init__.py`
- Create: `web/.gitkeep`

- [ ] **Step 1: Create requirements.txt**

```
pixivpy3>=3.7.0
Pillow>=9.0.0
pytest>=7.0.0
pytest-asyncio>=0.21.0
```

- [ ] **Step 2: Create empty test package**

```bash
touch tests/__init__.py web/.gitkeep
```

- [ ] **Step 3: Install dependencies**

Run inside ComfyUI's Python environment:
```bash
pip install pixivpy3 Pillow pytest pytest-asyncio
```

Expected: All packages install without error. `python -c "import pixivpy3; print(pixivpy3.__version__)"` prints a version ≥ 3.7.0.

- [ ] **Step 4: Commit**

```bash
git add requirements.txt tests/__init__.py web/.gitkeep
git commit -m "feat: project scaffold"
```

---

## Task 2: config.py

**Files:**
- Create: `tests/test_config.py`
- Create: `config.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_config.py`:

```python
import json
import pytest
from pathlib import Path
from config import Config


def test_get_refresh_token_returns_none_when_no_file(tmp_path):
    c = Config(tmp_path / "config.json")
    assert c.get_refresh_token() is None


def test_save_and_get_refresh_token(tmp_path):
    c = Config(tmp_path / "config.json")
    c.save_refresh_token("my_token_123")
    assert c.get_refresh_token() == "my_token_123"


def test_persists_across_instances(tmp_path):
    path = tmp_path / "config.json"
    Config(path).save_refresh_token("abc123")
    assert Config(path).get_refresh_token() == "abc123"


def test_save_preserves_existing_keys(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"other_key": "value"}))
    Config(path).save_refresh_token("tok")
    data = json.loads(path.read_text())
    assert data["other_key"] == "value"
    assert data["refresh_token"] == "tok"
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /path/to/comfyui-pixiv-node
pytest tests/test_config.py -v
```

Expected: `ModuleNotFoundError: No module named 'config'`

- [ ] **Step 3: Implement config.py**

```python
import json
from pathlib import Path


class Config:
    def __init__(self, path=None):
        self.path = Path(path) if path else Path(__file__).parent / "config.json"

    def get_refresh_token(self):
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text()).get("refresh_token")

    def save_refresh_token(self, token: str):
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        data["refresh_token"] = token
        self.path.write_text(json.dumps(data))
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/test_config.py -v
```

Expected: 4 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add config.py tests/test_config.py
git commit -m "feat: config token persistence"
```

---

## Task 3: pixiv_client.py — Auth Methods

**Files:**
- Create: `tests/test_pixiv_client.py`
- Create: `pixiv_client.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_pixiv_client.py`:

```python
import re
import pytest
from unittest.mock import MagicMock, patch
from pixiv_client import PixivClient


def make_client(token=None):
    mock_config = MagicMock()
    mock_config.get_refresh_token.return_value = token
    return PixivClient(mock_config)


def test_generate_pkce_returns_different_values_each_call():
    client = make_client()
    v1, c1 = client.generate_pkce()
    v2, c2 = client.generate_pkce()
    assert v1 != v2 and c1 != c2


def test_challenge_is_base64url():
    client = make_client()
    _, challenge = client.generate_pkce()
    assert re.match(r'^[A-Za-z0-9_-]+$', challenge)


def test_get_login_url_contains_challenge():
    client = make_client()
    _, challenge = client.generate_pkce()
    url = client.get_login_url(challenge)
    assert challenge in url
    assert "app-api.pixiv.net" in url


def test_extract_code_from_pixiv_url():
    client = make_client()
    assert client.extract_code("pixiv://account/login?code=abc123&via=login") == "abc123"


def test_extract_code_raises_on_missing_code():
    client = make_client()
    with pytest.raises(ValueError):
        client.extract_code("http://example.com/nope")


def test_login_with_code_saves_token_and_returns_it():
    client = make_client()
    mock_api = MagicMock()
    mock_api.refresh_token = "saved_token_456"
    client.api = mock_api

    result = client.login_with_code("mycode", "myverifier")

    mock_api.auth.assert_called_once_with(code="mycode", code_verifier="myverifier")
    client.config.save_refresh_token.assert_called_once_with("saved_token_456")
    assert result == "saved_token_456"
    assert client._logged_in is True


def test_ensure_logged_in_uses_stored_token():
    client = make_client(token="stored_token")
    mock_api = MagicMock()
    client.api = mock_api

    client.ensure_logged_in()

    mock_api.auth.assert_called_once_with(refresh_token="stored_token")
    assert client._logged_in is True


def test_ensure_logged_in_raises_when_no_token():
    client = make_client(token=None)
    with pytest.raises(RuntimeError, match="未登录"):
        client.ensure_logged_in()


def test_ensure_logged_in_skips_if_already_logged_in():
    client = make_client(token="tok")
    client._logged_in = True
    mock_api = MagicMock()
    client.api = mock_api

    client.ensure_logged_in()

    mock_api.auth.assert_not_called()
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/test_pixiv_client.py -v
```

Expected: `ModuleNotFoundError: No module named 'pixiv_client'`

- [ ] **Step 3: Implement pixiv_client.py (auth methods only)**

```python
import hashlib
import secrets
import base64
import re
from pixivpy3 import AppPixivAPI


class PixivClient:
    def __init__(self, config):
        self.config = config
        self.api = AppPixivAPI()
        self._logged_in = False

    def generate_pkce(self):
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()
        ).rstrip(b'=').decode()
        return verifier, challenge

    def get_login_url(self, code_challenge: str) -> str:
        return (
            "https://app-api.pixiv.net/web/v1/login?"
            f"code_challenge={code_challenge}&"
            "code_challenge_method=S256&"
            "client=pixiv-android"
        )

    def extract_code(self, redirect_url: str) -> str:
        match = re.search(r'code=([^&]+)', redirect_url)
        if not match:
            raise ValueError(f"No code found in: {redirect_url}")
        return match.group(1)

    def login_with_code(self, code: str, code_verifier: str) -> str:
        self.api.auth(code=code, code_verifier=code_verifier)
        token = self.api.refresh_token
        self.config.save_refresh_token(token)
        self._logged_in = True
        return token

    def ensure_logged_in(self):
        if self._logged_in:
            return
        token = self.config.get_refresh_token()
        if not token:
            raise RuntimeError("未登录，请先在弹窗中登录 Pixiv")
        self.api.auth(refresh_token=token)
        self._logged_in = True
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/test_pixiv_client.py -v
```

Expected: 9 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add pixiv_client.py tests/test_pixiv_client.py
git commit -m "feat: pixiv_client auth methods"
```

---

## Task 4: pixiv_client.py — Data Fetch Methods

**Files:**
- Modify: `pixiv_client.py`
- Modify: `tests/test_pixiv_client.py`

- [ ] **Step 1: Add failing tests to test_pixiv_client.py**

Append to `tests/test_pixiv_client.py`:

```python
def _mock_illust():
    i = MagicMock()
    i.id = 12345
    i.title = "Test Art"
    i.image_urls.medium = "https://i.pximg.net/medium/img.jpg"
    i.image_urls.large = "https://i.pximg.net/large/img.jpg"
    i.user.id = 999
    i.user.name = "TestArtist"
    i.user.profile_image_urls.medium = "https://i.pximg.net/avatar.jpg"
    return i


def _mock_result(illusts=None, next_url=None):
    r = MagicMock()
    r.illusts = illusts or []
    r.next_url = next_url
    return r


def test_get_recommended_returns_formatted_illusts():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.illust_recommended.return_value = _mock_result([_mock_illust()])

    result = client.get_recommended()

    assert len(result["illusts"]) == 1
    assert result["illusts"][0]["id"] == 12345
    assert result["illusts"][0]["title"] == "Test Art"
    assert result["illusts"][0]["user"]["name"] == "TestArtist"
    assert result["next_url"] is None


def test_get_recommended_next_page_calls_next_qs():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.next_qs.return_value = {"offset": "30"}
    client.api.illust_recommended.return_value = _mock_result()

    client.get_recommended(next_url="https://app-api.pixiv.net/v1/illust/recommended?offset=30")

    client.api.next_qs.assert_called_once()
    client.api.illust_recommended.assert_called_once_with(offset="30")


def test_get_ranking_passes_mode():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.illust_ranking.return_value = _mock_result()

    client.get_ranking(mode="week")

    client.api.illust_ranking.assert_called_once_with(mode="week")


def test_get_bookmarks_uses_user_id():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.user_id = "42"
    client.api.user_bookmarks_illust.return_value = _mock_result()

    client.get_bookmarks()

    client.api.user_bookmarks_illust.assert_called_once_with("42")


def test_get_bookmarked_artists_returns_formatted():
    client = make_client(token="tok")
    client._logged_in = True
    preview = MagicMock()
    preview.user.id = 777
    preview.user.name = "Artist1"
    preview.user.profile_image_urls.medium = "https://i.pximg.net/avatar.jpg"
    client.api = MagicMock()
    client.api.user_id = "42"
    client.api.user_following.return_value = MagicMock(
        user_previews=[preview], next_url=None
    )

    result = client.get_bookmarked_artists()

    assert result["artists"][0]["id"] == 777
    assert result["artists"][0]["name"] == "Artist1"


def test_get_artist_works_passes_artist_id():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.user_illusts.return_value = _mock_result()

    client.get_artist_works(artist_id=777)

    client.api.user_illusts.assert_called_once_with(777)
```

- [ ] **Step 2: Run tests to confirm new ones fail**

```bash
pytest tests/test_pixiv_client.py -v
```

Expected: 6 new tests FAIL with `AttributeError`.

- [ ] **Step 3: Add fetch methods to pixiv_client.py**

Append to the `PixivClient` class in `pixiv_client.py`:

```python
    def get_recommended(self, next_url=None):
        self.ensure_logged_in()
        kwargs = self.api.next_qs(next_url) if next_url else {}
        return self._fmt_illusts(self.api.illust_recommended(**kwargs))

    def get_ranking(self, mode='day', next_url=None):
        self.ensure_logged_in()
        kwargs = self.api.next_qs(next_url) if next_url else {"mode": mode}
        return self._fmt_illusts(self.api.illust_ranking(**kwargs))

    def get_bookmarks(self, next_url=None):
        self.ensure_logged_in()
        kwargs = self.api.next_qs(next_url) if next_url else {"user_id": self.api.user_id}
        return self._fmt_illusts(self.api.user_bookmarks_illust(**kwargs))

    def get_bookmarked_artists(self, next_url=None):
        self.ensure_logged_in()
        kwargs = self.api.next_qs(next_url) if next_url else {"user_id": self.api.user_id}
        result = self.api.user_following(**kwargs)
        artists = [
            {
                "id": p.user.id,
                "name": p.user.name,
                "profile_image_urls": {"medium": p.user.profile_image_urls.medium},
            }
            for p in result.user_previews
        ]
        return {"artists": artists, "next_url": result.next_url}

    def get_artist_works(self, artist_id, next_url=None):
        self.ensure_logged_in()
        kwargs = self.api.next_qs(next_url) if next_url else {"user_id": artist_id}
        return self._fmt_illusts(self.api.user_illusts(**kwargs))

    def _fmt_illusts(self, result):
        return {
            "illusts": [
                {
                    "id": i.id,
                    "title": i.title,
                    "image_urls": {
                        "medium": i.image_urls.medium,
                        "large": i.image_urls.large,
                    },
                    "user": {
                        "id": i.user.id,
                        "name": i.user.name,
                        "profile_image_urls": {"medium": i.user.profile_image_urls.medium},
                    },
                }
                for i in result.illusts
            ],
            "next_url": result.next_url,
        }
```

- [ ] **Step 4: Run all tests**

```bash
pytest tests/test_pixiv_client.py -v
```

Expected: All 15 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add pixiv_client.py tests/test_pixiv_client.py
git commit -m "feat: pixiv_client data fetch methods"
```

---

## Task 5: pixiv_client.py — Image Download

**Files:**
- Modify: `pixiv_client.py`
- Modify: `tests/test_pixiv_client.py`

- [ ] **Step 1: Add failing tests**

Append to `tests/test_pixiv_client.py`:

```python
def test_download_image_bytes_sets_referer_header():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()

    fake_response = MagicMock()
    fake_response.content = b"\xff\xd8\xff"  # JPEG magic bytes
    fake_response.raise_for_status = MagicMock()

    with patch("pixiv_client.requests.get", return_value=fake_response) as mock_get:
        result = client.download_image_bytes("https://i.pximg.net/img/test.jpg")

    mock_get.assert_called_once_with(
        "https://i.pximg.net/img/test.jpg",
        headers={"Referer": "https://www.pixiv.net/"},
        timeout=30,
    )
    assert result == b"\xff\xd8\xff"


def test_get_original_url_single_page():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.illust_detail.return_value.illust.meta_single_page = {
        "original_image_url": "https://i.pximg.net/orig/img.jpg"
    }
    client.api.illust_detail.return_value.illust.meta_pages = []

    url = client.get_original_url(12345)

    assert url == "https://i.pximg.net/orig/img.jpg"
    client.api.illust_detail.assert_called_once_with(12345)


def test_get_original_url_multi_page_uses_first_page():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()
    client.api.illust_detail.return_value.illust.meta_single_page = {}
    page = MagicMock()
    page.image_urls.original = "https://i.pximg.net/orig/p0.jpg"
    client.api.illust_detail.return_value.illust.meta_pages = [page]

    url = client.get_original_url(99999)

    assert url == "https://i.pximg.net/orig/p0.jpg"
```

- [ ] **Step 2: Run to confirm they fail**

```bash
pytest tests/test_pixiv_client.py::test_download_image_bytes_sets_referer_header -v
```

Expected: FAIL with `AttributeError`.

- [ ] **Step 3: Add download methods to pixiv_client.py**

Add `import requests` at the top of `pixiv_client.py`, then append to the class:

```python
    def download_image_bytes(self, url: str) -> bytes:
        response = requests.get(
            url,
            headers={"Referer": "https://www.pixiv.net/"},
            timeout=30,
        )
        response.raise_for_status()
        return response.content

    def get_original_url(self, illust_id: int) -> str:
        self.ensure_logged_in()
        detail = self.api.illust_detail(illust_id).illust
        single = detail.meta_single_page.get("original_image_url")
        if single:
            return single
        return detail.meta_pages[0].image_urls.original
```

- [ ] **Step 4: Run all tests**

```bash
pytest tests/test_pixiv_client.py -v
```

Expected: All 18 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add pixiv_client.py tests/test_pixiv_client.py
git commit -m "feat: pixiv_client image download"
```

---

## Task 6: pixiv_node.py

**Files:**
- Create: `tests/test_pixiv_node.py`
- Create: `pixiv_node.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_pixiv_node.py`:

```python
import pytest
import torch
import numpy as np
from unittest.mock import MagicMock, patch
from PIL import Image
from pixiv_node import PixivBrowser


def _make_mock_client(image_bytes=None):
    client = MagicMock()
    if image_bytes is None:
        img = Image.new("RGB", (64, 64), color=(128, 64, 200))
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()
    client.download_image_bytes.return_value = image_bytes
    client.get_original_url.return_value = "https://i.pximg.net/orig/img.jpg"
    return client


def test_execute_returns_image_tensor(monkeypatch):
    mock_client = _make_mock_client()
    monkeypatch.setattr("pixiv_node._get_client", lambda: mock_client)

    node = PixivBrowser()
    result = node.execute(artwork_ids="12345")

    assert isinstance(result, tuple)
    tensor = result[0]
    assert isinstance(tensor, torch.Tensor)
    assert tensor.ndim == 4  # [B, H, W, 3]
    assert tensor.shape[0] == 1  # one image
    assert tensor.shape[3] == 3  # RGB
    assert tensor.dtype == torch.float32
    assert tensor.min() >= 0.0 and tensor.max() <= 1.0


def test_execute_multiple_ids_returns_batch(monkeypatch):
    mock_client = _make_mock_client()
    monkeypatch.setattr("pixiv_node._get_client", lambda: mock_client)

    node = PixivBrowser()
    result = node.execute(artwork_ids="111,222,333")

    tensor = result[0]
    assert tensor.shape[0] == 3


def test_execute_skips_failed_downloads(monkeypatch):
    mock_client = MagicMock()
    mock_client.get_original_url.return_value = "https://i.pximg.net/img.jpg"

    import io
    img = Image.new("RGB", (32, 32), color=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    good_bytes = buf.getvalue()

    mock_client.download_image_bytes.side_effect = [
        Exception("timeout"),
        good_bytes,
    ]
    monkeypatch.setattr("pixiv_node._get_client", lambda: mock_client)

    node = PixivBrowser()
    result = node.execute(artwork_ids="bad_id,good_id")

    assert result[0].shape[0] == 1  # only 1 of 2 succeeded


def test_execute_raises_on_empty_ids(monkeypatch):
    mock_client = MagicMock()
    monkeypatch.setattr("pixiv_node._get_client", lambda: mock_client)

    node = PixivBrowser()
    with pytest.raises(ValueError, match="请先在弹窗中选择图片"):
        node.execute(artwork_ids="")


def test_input_types_has_artwork_ids():
    types = PixivBrowser.INPUT_TYPES()
    assert "artwork_ids" in types["required"]


def test_return_types_is_image():
    assert PixivBrowser.RETURN_TYPES == ("IMAGE",)
```

- [ ] **Step 2: Run to confirm they fail**

```bash
pytest tests/test_pixiv_node.py -v
```

Expected: `ModuleNotFoundError: No module named 'pixiv_node'`

- [ ] **Step 3: Implement pixiv_node.py**

```python
import io
import numpy as np
import torch
from PIL import Image


_client = None  # injected by __init__.py after package load


def _get_client():
    if _client is None:
        raise RuntimeError("Plugin not initialized — is this running outside ComfyUI?")
    return _client


class PixivBrowser:
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "execute"
    CATEGORY = "image/pixiv"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "artwork_ids": ("STRING", {"default": "", "multiline": False}),
            }
        }

    def execute(self, artwork_ids: str):
        if not artwork_ids.strip():
            raise ValueError("请先在弹窗中选择图片")

        client = _get_client()
        ids = [x.strip() for x in artwork_ids.split(",") if x.strip()]
        tensors = []

        for artwork_id in ids:
            try:
                url = client.get_original_url(int(artwork_id))
                raw = client.download_image_bytes(url)
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                arr = np.array(img, dtype=np.float32) / 255.0
                tensors.append(torch.from_numpy(arr))
            except Exception as e:
                print(f"[PixivBrowser] Skipping {artwork_id}: {e}")

        if not tensors:
            raise ValueError("所有图片下载失败，请检查网络或重新选择")

        batch = torch.stack(tensors)  # [B, H, W, 3]
        return (batch,)
```

- [ ] **Step 4: Run all tests**

```bash
pytest tests/test_pixiv_node.py -v
```

Expected: All 6 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add pixiv_node.py tests/test_pixiv_node.py
git commit -m "feat: PixivBrowser node execute()"
```

---

## Task 7: __init__.py — Routes & Node Registration

**Files:**
- Create: `__init__.py`

- [ ] **Step 1: Write __init__.py**

```python
import os
import traceback

try:
    from .config import Config
    from .pixiv_client import PixivClient

    _config = Config()
    _client_instance = PixivClient(_config)

    from server import PromptServer
    from aiohttp import web
    import aiohttp

    routes = PromptServer.instance.routes

    # ── Auth ──────────────────────────────────────────────────────────────────

    @routes.get("/pixiv/status")
    async def pixiv_status(request):
        logged_in = _client_instance._logged_in
        username = ""
        if logged_in:
            try:
                username = str(_client_instance.api.user_id)
            except Exception:
                pass
        return web.json_response({"logged_in": logged_in, "username": username})

    # Temporary store for PKCE verifier during auth flow (single-user assumption)
    _pending_verifier = {}

    @routes.post("/pixiv/auth/login")
    async def pixiv_auth_login(request):
        verifier, challenge = _client_instance.generate_pkce()
        auth_url = _client_instance.get_login_url(challenge)
        _pending_verifier["current"] = verifier
        return web.json_response({"auth_url": auth_url})

    @routes.post("/pixiv/auth/callback")
    async def pixiv_auth_callback(request):
        data = await request.json()
        redirect_url = data.get("redirect_url", "")
        verifier = _pending_verifier.pop("current", None)
        if not verifier:
            return web.json_response({"error": "No pending auth"}, status=400)
        try:
            code = _client_instance.extract_code(redirect_url)
            _client_instance.login_with_code(code, verifier)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    # ── Content ───────────────────────────────────────────────────────────────

    @routes.get("/pixiv/recommended")
    async def pixiv_recommended(request):
        next_url = request.query.get("next_url")
        try:
            return web.json_response(_client_instance.get_recommended(next_url=next_url))
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=401)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/pixiv/ranking")
    async def pixiv_ranking(request):
        mode = request.query.get("mode", "day")
        next_url = request.query.get("next_url")
        try:
            return web.json_response(_client_instance.get_ranking(mode=mode, next_url=next_url))
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=401)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/pixiv/bookmarks")
    async def pixiv_bookmarks(request):
        next_url = request.query.get("next_url")
        try:
            return web.json_response(_client_instance.get_bookmarks(next_url=next_url))
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=401)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/pixiv/bookmarked_artists")
    async def pixiv_bookmarked_artists(request):
        next_url = request.query.get("next_url")
        try:
            return web.json_response(_client_instance.get_bookmarked_artists(next_url=next_url))
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=401)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.get("/pixiv/artist/{artist_id}/works")
    async def pixiv_artist_works(request):
        artist_id = int(request.match_info["artist_id"])
        next_url = request.query.get("next_url")
        try:
            return web.json_response(
                _client_instance.get_artist_works(artist_id=artist_id, next_url=next_url)
            )
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=401)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    # ── Image Proxy ───────────────────────────────────────────────────────────

    @routes.get("/pixiv/image_proxy")
    async def pixiv_image_proxy(request):
        url = request.query.get("url", "")
        if "pximg.net" not in url:
            return web.Response(status=403, text="Only pximg.net URLs allowed")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers={"Referer": "https://www.pixiv.net/"},
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    data = await resp.read()
                    ct = resp.headers.get("Content-Type", "image/jpeg")
                    return web.Response(body=data, content_type=ct)
        except Exception as e:
            return web.Response(status=502, text=str(e))

    from .pixiv_node import PixivBrowser
    from . import pixiv_node as _pn_mod
    _pn_mod._client = _client_instance  # inject client — avoids circular import

    NODE_CLASS_MAPPINGS = {"PixivBrowser": PixivBrowser}
    NODE_DISPLAY_NAME_MAPPINGS = {"PixivBrowser": "Pixiv Browser"}
    WEB_DIRECTORY = "./web"

    print("[PixivBrowser] Loaded successfully")

except ImportError as e:
    print(f"[PixivBrowser] ERROR: Missing dependency — {e}")
    print("[PixivBrowser] Run: pip install pixivpy3 Pillow")
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
except Exception as e:
    print(f"[PixivBrowser] ERROR during load: {e}")
    traceback.print_exc()
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
```

- [ ] **Step 2: Run full test suite to confirm nothing broke**

```bash
pytest tests/ -v
```

Expected: All existing tests still PASSED. (Routes are not unit-tested here — manual testing in Task 12.)

- [ ] **Step 3: Commit**

```bash
git add __init__.py
git commit -m "feat: API routes and node registration"
```

---

## Task 8: web/pixiv_dialog.css

**Files:**
- Create: `web/pixiv_dialog.css`

- [ ] **Step 1: Write the CSS**

```css
/* Modal overlay */
#pixiv-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Modal container */
#pixiv-modal {
  background: #1e1e2e;
  border: 1px solid #3a3a5c;
  border-radius: 8px;
  width: 90vw;
  max-width: 1100px;
  height: 85vh;
  display: flex;
  flex-direction: column;
  color: #cdd6f4;
  font-family: sans-serif;
  font-size: 14px;
  overflow: hidden;
}

/* Header */
#pixiv-modal-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #3a3a5c;
  gap: 12px;
  flex-shrink: 0;
}

#pixiv-modal-header h2 {
  margin: 0;
  font-size: 16px;
  flex: 1;
  color: #cba6f7;
}

#pixiv-selected-count {
  color: #a6e3a1;
  font-size: 13px;
}

#pixiv-close-btn {
  background: none;
  border: none;
  color: #cdd6f4;
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
#pixiv-close-btn:hover { color: #f38ba8; }

/* Tabs */
#pixiv-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 16px 0;
  border-bottom: 1px solid #3a3a5c;
  flex-shrink: 0;
}

.pixiv-tab {
  padding: 6px 16px;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  color: #7f849c;
  transition: color 0.15s, background 0.15s;
}

.pixiv-tab:hover { color: #cdd6f4; background: #2a2a3e; }

.pixiv-tab.active {
  color: #cba6f7;
  background: #2a2a3e;
  border-color: #3a3a5c;
}

/* Content area */
#pixiv-content {
  flex: 1;
  overflow: hidden;
  display: flex;
}

/* Login page */
#pixiv-login-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 32px;
}

#pixiv-login-page p { color: #7f849c; text-align: center; max-width: 400px; }

#pixiv-login-btn {
  padding: 10px 24px;
  background: #cba6f7;
  color: #1e1e2e;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: bold;
}
#pixiv-login-btn:hover { background: #d0b4f5; }

#pixiv-redirect-input {
  width: 100%;
  max-width: 500px;
  padding: 8px 12px;
  background: #181825;
  border: 1px solid #3a3a5c;
  border-radius: 4px;
  color: #cdd6f4;
  font-size: 13px;
}

#pixiv-submit-code-btn {
  padding: 8px 20px;
  background: #a6e3a1;
  color: #1e1e2e;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}

/* Image grid pane */
#pixiv-grid-pane {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.pixiv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}

.pixiv-card {
  position: relative;
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
  border: 2px solid transparent;
  background: #181825;
  transition: border-color 0.15s;
}

.pixiv-card:hover { border-color: #7f849c; }
.pixiv-card.selected { border-color: #cba6f7; }

.pixiv-card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
}

.pixiv-card-title {
  padding: 4px 6px;
  font-size: 11px;
  color: #7f849c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pixiv-seq-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: #cba6f7;
  color: #1e1e2e;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: bold;
}

/* Artist tab split layout */
#pixiv-artist-pane {
  display: flex;
  flex: 1;
  overflow: hidden;
}

#pixiv-artist-list {
  width: 200px;
  overflow-y: auto;
  border-right: 1px solid #3a3a5c;
  padding: 8px;
  flex-shrink: 0;
}

.pixiv-artist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: #cdd6f4;
}
.pixiv-artist-item:hover { background: #2a2a3e; }
.pixiv-artist-item.active { background: #313244; }

.pixiv-artist-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.pixiv-artist-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#pixiv-artist-works-pane {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

/* Footer */
#pixiv-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #3a3a5c;
  flex-shrink: 0;
}

#pixiv-cancel-btn {
  padding: 7px 16px;
  background: transparent;
  border: 1px solid #3a3a5c;
  color: #cdd6f4;
  border-radius: 4px;
  cursor: pointer;
}
#pixiv-cancel-btn:hover { background: #2a2a3e; }

#pixiv-confirm-btn {
  padding: 7px 16px;
  background: #cba6f7;
  color: #1e1e2e;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}
#pixiv-confirm-btn:hover { background: #d0b4f5; }

/* Loading spinner */
.pixiv-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: #7f849c;
}

/* Sentinel for infinite scroll */
#pixiv-scroll-sentinel {
  height: 1px;
  margin-top: 8px;
}

/* Error message */
.pixiv-error {
  color: #f38ba8;
  padding: 12px;
  text-align: center;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/pixiv_dialog.css
git commit -m "feat: modal dialog CSS"
```

---

## Task 9: web/pixiv_extension.js — Part 1: Extension Registration & Login Flow

**Files:**
- Create: `web/pixiv_extension.js`

- [ ] **Step 1: Write the extension scaffold and login flow**

Create `web/pixiv_extension.js`:

```javascript
import { app } from "../../scripts/app.js";

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  selectedIds: [],       // Array of artwork ID strings, in selection order
  activeTab: "recommended",
  nextUrls: {},          // { tabName: nextUrl | null }
  loading: false,
  activeArtistId: null,
  artistNextUrl: null,
};

// ── CSS injection ─────────────────────────────────────────────────────────────

function injectCSS() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("pixiv_dialog.css", import.meta.url).href;
  document.head.appendChild(link);
}

// ── Modal DOM builders ────────────────────────────────────────────────────────

function buildModal() {
  const overlay = document.createElement("div");
  overlay.id = "pixiv-modal-overlay";

  overlay.innerHTML = `
    <div id="pixiv-modal">
      <div id="pixiv-modal-header">
        <h2>📷 Pixiv Browser</h2>
        <span id="pixiv-selected-count">已选 0 张</span>
        <button id="pixiv-close-btn">✕</button>
      </div>
      <div id="pixiv-tabs">
        <button class="pixiv-tab active" data-tab="recommended">推荐</button>
        <button class="pixiv-tab" data-tab="ranking">排行榜</button>
        <button class="pixiv-tab" data-tab="bookmarks">收藏</button>
        <button class="pixiv-tab" data-tab="artists">画师</button>
      </div>
      <div id="pixiv-content">
        <!-- filled dynamically -->
      </div>
      <div id="pixiv-modal-footer">
        <button id="pixiv-cancel-btn">取消</button>
        <button id="pixiv-confirm-btn">✓ 确认选择</button>
      </div>
    </div>
  `;
  return overlay;
}

// ── Login page ────────────────────────────────────────────────────────────────

function renderLoginPage(contentEl) {
  contentEl.innerHTML = `
    <div id="pixiv-login-page">
      <h3 style="color:#cba6f7">登录 Pixiv</h3>
      <p>点击下方按钮，在浏览器中完成 Pixiv 授权。<br>
         授权后浏览器会跳转到一个以 <code>pixiv://</code> 开头的地址（可能显示错误页面），<br>
         请将该地址完整复制后粘贴到下方输入框中。</p>
      <button id="pixiv-login-btn">用浏览器登录 Pixiv</button>
      <div id="pixiv-callback-section" style="display:none; width:100%; max-width:500px; display:flex; flex-direction:column; gap:8px; align-items:center">
        <input id="pixiv-redirect-input" type="text" placeholder="粘贴 pixiv://account/login?code=... 到此处" />
        <button id="pixiv-submit-code-btn">确认登录</button>
        <p id="pixiv-login-error" style="color:#f38ba8; display:none"></p>
      </div>
    </div>
  `;

  document.getElementById("pixiv-login-btn").addEventListener("click", async () => {
    try {
      const resp = await fetch("/pixiv/auth/login", { method: "POST" });
      const data = await resp.json();
      // code_verifier is stored server-side in _pending_verifier
      window.open(data.auth_url, "_blank");
      // Show the callback input section
      document.getElementById("pixiv-callback-section").style.display = "flex";
    } catch (e) {
      console.error("[PixivBrowser] Login init failed:", e);
    }
  });

  document.getElementById("pixiv-submit-code-btn").addEventListener("click", async () => {
    const redirectUrl = document.getElementById("pixiv-redirect-input").value.trim();
    const errEl = document.getElementById("pixiv-login-error");
    if (!redirectUrl) return;

    try {
      const resp = await fetch("/pixiv/auth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_url: redirectUrl }),
      });
      const data = await resp.json();
      if (data.ok) {
        // Login successful — reload the main browser
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

// ── Open modal ────────────────────────────────────────────────────────────────

async function openModal(node, idsWidget) {
  // Reset state
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

  injectCSS();

  const overlay = buildModal();
  document.body.appendChild(overlay);

  const contentEl = document.getElementById("pixiv-content");
  updateSelectedCount();

  // Wire header buttons
  document.getElementById("pixiv-close-btn").addEventListener("click", () => closeModal(null));
  document.getElementById("pixiv-cancel-btn").addEventListener("click", () => closeModal(null));
  document.getElementById("pixiv-confirm-btn").addEventListener("click", () => {
    if (idsWidget) {
      idsWidget.value = state.selectedIds.join(",");
    }
    closeModal(state.selectedIds.join(","));
  });

  // Wire tab buttons
  document.querySelectorAll(".pixiv-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab, contentEl));
  });

  // Check login status, then render
  const statusResp = await fetch("/pixiv/status");
  const status = await statusResp.json();

  if (!status.logged_in) {
    renderLoginPage(contentEl);
  } else {
    openMainBrowser(contentEl);
  }

  // Close on overlay click
  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeModal(null);
  });
}

function closeModal(result) {
  const overlay = document.getElementById("pixiv-modal-overlay");
  if (overlay) overlay.remove();
}

function updateSelectedCount() {
  const el = document.getElementById("pixiv-selected-count");
  if (el) el.textContent = `已选 ${state.selectedIds.length} 张`;
}
```

- [ ] **Step 2: Commit the scaffold**

```bash
git add web/pixiv_extension.js
git commit -m "feat: JS extension scaffold + login flow"
```

---

## Task 10: web/pixiv_extension.js — Part 2: Browser Tabs & Image Grid

**Files:**
- Modify: `web/pixiv_extension.js`

- [ ] **Step 1: Append tab switching and image grid logic to pixiv_extension.js**

```javascript
// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabName, contentEl) {
  state.activeTab = tabName;
  document.querySelectorAll(".pixiv-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  openMainBrowser(contentEl);
}

async function openMainBrowser(contentEl) {
  const tab = state.activeTab;

  if (tab === "artists") {
    renderArtistPane(contentEl);
    return;
  }

  contentEl.innerHTML = `
    <div id="pixiv-grid-pane">
      <div class="pixiv-grid" id="pixiv-image-grid"></div>
      <div class="pixiv-loading" id="pixiv-load-more">加载中...</div>
      <div id="pixiv-scroll-sentinel"></div>
    </div>
  `;

  state.nextUrls[tab] = undefined;  // reset pagination for this tab
  await loadMoreImages(tab);
  setupInfiniteScroll(tab);
}

// ── API fetchers ──────────────────────────────────────────────────────────────

async function fetchImages(tab, nextUrl) {
  let url;
  const params = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";

  switch (tab) {
    case "recommended": url = `/pixiv/recommended${params}`; break;
    case "ranking":     url = `/pixiv/ranking${params}`; break;
    case "bookmarks":   url = `/pixiv/bookmarks${params}`; break;
    default: return { illusts: [], next_url: null };
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ── Image grid rendering ──────────────────────────────────────────────────────

async function loadMoreImages(tab) {
  if (state.loading) return;
  const nextUrl = state.nextUrls[tab];
  if (nextUrl === null) return;  // no more pages

  state.loading = true;
  const loadMoreEl = document.getElementById("pixiv-load-more");
  if (loadMoreEl) loadMoreEl.style.display = "flex";

  try {
    const data = await fetchImages(tab, nextUrl);
    state.nextUrls[tab] = data.next_url ?? null;
    appendIllusts(data.illusts, document.getElementById("pixiv-image-grid"));
  } catch (e) {
    const grid = document.getElementById("pixiv-image-grid");
    if (grid) grid.insertAdjacentHTML("beforeend", `<div class="pixiv-error">加载失败: ${e.message}</div>`);
  } finally {
    state.loading = false;
    if (loadMoreEl) loadMoreEl.style.display = "none";
  }
}

function appendIllusts(illusts, gridEl) {
  if (!gridEl) return;
  for (const illust of illusts) {
    const card = createCard(illust);
    gridEl.appendChild(card);
  }
}

function createCard(illust) {
  const card = document.createElement("div");
  card.className = "pixiv-card";
  card.dataset.id = String(illust.id);

  const thumbUrl = `/pixiv/image_proxy?url=${encodeURIComponent(illust.image_urls.medium)}`;

  card.innerHTML = `
    <img src="${thumbUrl}" alt="${escapeHtml(illust.title)}" loading="lazy" />
    <div class="pixiv-card-title">${escapeHtml(illust.title)}</div>
  `;

  // Apply selected state if already in selection
  const existingIdx = state.selectedIds.indexOf(String(illust.id));
  if (existingIdx !== -1) {
    card.classList.add("selected");
    card.insertAdjacentHTML("beforeend", `<div class="pixiv-seq-badge">${existingIdx + 1}</div>`);
  }

  card.addEventListener("click", () => toggleCardSelection(card, String(illust.id)));
  return card;
}

function toggleCardSelection(card, id) {
  const idx = state.selectedIds.indexOf(id);
  if (idx === -1) {
    // Select
    state.selectedIds.push(id);
    card.classList.add("selected");
    card.insertAdjacentHTML("beforeend", `<div class="pixiv-seq-badge">${state.selectedIds.length}</div>`);
  } else {
    // Deselect
    state.selectedIds.splice(idx, 1);
    card.classList.remove("selected");
    card.querySelector(".pixiv-seq-badge")?.remove();
    // Re-number remaining selected cards
    rebadgeAll();
  }
  updateSelectedCount();
}

function rebadgeAll() {
  document.querySelectorAll(".pixiv-card.selected").forEach(card => {
    const id = card.dataset.id;
    const idx = state.selectedIds.indexOf(id);
    const badge = card.querySelector(".pixiv-seq-badge");
    if (badge) badge.textContent = idx + 1;
  });
}

function setupInfiniteScroll(tab) {
  const sentinel = document.getElementById("pixiv-scroll-sentinel");
  if (!sentinel) return;
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMoreImages(tab);
  }, { rootMargin: "200px" });
  observer.observe(sentinel);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

- [ ] **Step 2: Commit**

```bash
git add web/pixiv_extension.js
git commit -m "feat: JS browser tabs and image grid"
```

---

## Task 11: web/pixiv_extension.js — Part 3: Artist Tab & Extension Registration

**Files:**
- Modify: `web/pixiv_extension.js`

- [ ] **Step 1: Append artist panel and ComfyUI extension registration to pixiv_extension.js**

```javascript
// ── Artist Tab ────────────────────────────────────────────────────────────────

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

    const avatarUrl = `/pixiv/image_proxy?url=${encodeURIComponent(artist.profile_image_urls.medium)}`;
    item.innerHTML = `
      <img class="pixiv-artist-avatar" src="${avatarUrl}" alt="" />
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
  const loadMoreEl = document.getElementById("pixiv-artist-load-more");
  if (loadMoreEl) loadMoreEl.style.display = "flex";

  try {
    const params = nextUrl ? `?next_url=${encodeURIComponent(nextUrl)}` : "";
    const resp = await fetch(`/pixiv/artist/${artistId}/works${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.artistNextUrl = data.next_url ?? null;
    appendIllusts(data.illusts, document.getElementById("pixiv-artist-grid"));
  } catch (e) {
    const grid = document.getElementById("pixiv-artist-grid");
    if (grid) grid.insertAdjacentHTML("beforeend", `<div class="pixiv-error">加载失败: ${e.message}</div>`);
  } finally {
    state.loading = false;
    if (loadMoreEl) loadMoreEl.style.display = "none";
  }
}

function setupArtistInfiniteScroll(artistId) {
  const sentinel = document.getElementById("pixiv-artist-scroll-sentinel");
  if (!sentinel) return;
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMoreArtistWorks(artistId);
  }, { rootMargin: "200px" });
  observer.observe(sentinel);
}

// ── ComfyUI Extension Registration ───────────────────────────────────────────

app.registerExtension({
  name: "pixiv.browser",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PixivBrowser") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);

      // Find the artwork_ids widget and make it invisible (height=0)
      const idsWidget = this.widgets?.find(w => w.name === "artwork_ids");
      if (idsWidget) {
        idsWidget.computeSize = () => [0, -4];
        // Ensure it's still serialized
        const origSerialize = idsWidget.serializeValue;
        idsWidget.serializeValue = origSerialize ?? (() => idsWidget.value);
      }

      // Add the browse button
      this.addWidget("button", "🖼 浏览 Pixiv", null, () => {
        openModal(this, idsWidget);
      });

      return result;
    };
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add web/pixiv_extension.js
git commit -m "feat: artist tab and ComfyUI extension registration"
```

---

## Task 12: Manual Integration Test

**Prerequisite:** ComfyUI installed with this node in `custom_nodes/comfyui-pixiv-node/`. Run `pip install pixivpy3 Pillow` in ComfyUI's Python environment. Start ComfyUI.

- [ ] **Step 1: Verify node loads**

Open ComfyUI in browser. Check the browser console for:
```
[PixivBrowser] Loaded successfully
```
No red error messages.

- [ ] **Step 2: Verify node appears in Add Node menu**

Right-click canvas → Add Node → image/pixiv → PixivBrowser node should appear.

- [ ] **Step 3: Test login flow**

1. Add PixivBrowser node to canvas
2. Click "🖼 浏览 Pixiv" button on the node
3. Modal opens, shows login page
4. Click "用浏览器登录 Pixiv"
5. Auth URL opens in new browser tab
6. Complete Pixiv login in the new tab
7. Browser redirects to a `pixiv://` URL (may show error page — this is expected)
8. Copy the full URL from the address bar
9. Paste into the input field in the modal
10. Click "确认登录"
11. Expected: Modal transitions to the main browser view showing recommended images

- [ ] **Step 4: Test image browsing**

1. Switch between tabs: 推荐 / 排行榜 / 收藏
2. Each tab should load a grid of thumbnail images
3. Scroll to bottom — more images should load automatically (infinite scroll)
4. Click images — they should show a purple border + numbered badge
5. Click again — they should deselect
6. Select 3 images → footer shows "已选 3 张"

- [ ] **Step 5: Test artist tab**

1. Click "画师" tab
2. Left panel shows bookmarked artists (avatar + name)
3. Click an artist — right panel loads their works
4. Scroll to bottom of works — infinite scroll loads more
5. Select works from the artist panel — selected count updates

- [ ] **Step 6: Test image output**

1. Select 2 images in the modal, click "✓ 确认选择"
2. Modal closes
3. Connect PixivBrowser's IMAGE output to a PreviewImage node
4. Click "Queue Prompt"
5. Expected: Both selected images appear in the PreviewImage node
6. Check Console: no download errors

- [ ] **Step 7: Test error cases**

1. Click "Queue Prompt" without selecting any images
2. Expected: ComfyUI shows error: "请先在弹窗中选择图片"

- [ ] **Step 8: Final commit**

```bash
git add .
git commit -m "feat: complete ComfyUI Pixiv Browser node"
```

---

## Summary

Total tasks: 12  
Python files: `config.py`, `pixiv_client.py`, `pixiv_node.py`, `__init__.py`  
JS/CSS files: `web/pixiv_extension.js`, `web/pixiv_dialog.css`  
Test files: `tests/test_config.py`, `tests/test_pixiv_client.py`, `tests/test_pixiv_node.py`  
Test count: ~27 unit tests covering all Python logic
