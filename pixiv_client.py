import hashlib
import secrets
import base64
import re
import time
import requests
from urllib.parse import urlparse, parse_qs
from pixivpy3 import AppPixivAPI


class PixivClient:
    def __init__(self, config):
        self.config = config
        self.api = AppPixivAPI()
        self._logged_in = False
        self._auth_time = 0.0

    # ── Auth ──────────────────────────────────────────────────────────────────

    def generate_pkce(self):
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()
        ).rstrip(b'=').decode()
        return verifier, challenge

    def _next_qs(self, next_url: str) -> dict:
        parsed = urlparse(next_url)
        # Filter out array-style keys like "viewed[]" — invalid as Python kwargs
        return {k: v[0] for k, v in parse_qs(parsed.query).items() if k.isidentifier()}

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
        self._auth_time = time.time()
        return token

    def ensure_logged_in(self):
        token = self.api.refresh_token or self.config.get_refresh_token()
        if not token:
            raise RuntimeError("未登录，请先在弹窗中登录 Pixiv")
        # Access token expires after 3600s; refresh with a 5-min buffer
        if not self._logged_in or time.time() - self._auth_time > 3300:
            self.api.auth(refresh_token=token)
            self._logged_in = True
            self._auth_time = time.time()

    # ── Data fetch ────────────────────────────────────────────────────────────

    def get_recommended(self, next_url=None):
        self.ensure_logged_in()
        kwargs = self._next_qs(next_url) if next_url else {}
        return self._fmt_illusts(self.api.illust_recommended(**kwargs))

    def get_ranking(self, mode='day', next_url=None):
        self.ensure_logged_in()
        kwargs = self._next_qs(next_url) if next_url else {"mode": mode}
        return self._fmt_illusts(self.api.illust_ranking(**kwargs))

    def get_bookmarks(self, next_url=None):
        self.ensure_logged_in()
        kwargs = self._next_qs(next_url) if next_url else {"user_id": self.api.user_id}
        return self._fmt_illusts(self.api.user_bookmarks_illust(**kwargs))

    def get_bookmarked_artists(self, next_url=None):
        self.ensure_logged_in()
        kwargs = self._next_qs(next_url) if next_url else {"user_id": self.api.user_id}
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
        kwargs = self._next_qs(next_url) if next_url else {"user_id": artist_id}
        return self._fmt_illusts(self.api.user_illusts(**kwargs))

    def _fmt_illusts(self, result):
        illusts = []
        for i in result.illusts:
            # Extract original URL from browse data to avoid extra illust_detail calls later
            try:
                orig = (dict(i.meta_single_page) or {}).get("original_image_url") or ""
                if not orig and i.meta_pages:
                    orig = i.meta_pages[0].image_urls.original or ""
            except Exception:
                orig = ""
            illusts.append({
                "id": i.id,
                "title": i.title,
                "image_urls": {
                    "medium": i.image_urls.medium,
                    "large": i.image_urls.large,
                },
                "original_url": orig,
                "user": {
                    "id": i.user.id,
                    "name": i.user.name,
                    "profile_image_urls": {"medium": i.user.profile_image_urls.medium},
                },
            })
        return {"illusts": illusts, "next_url": result.next_url}

    # ── Image download ────────────────────────────────────────────────────────

    def download_image_bytes(self, url: str) -> bytes:
        headers = {
            "Referer": "https://www.pixiv.net/",
            "User-Agent": "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)",
        }
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        return response.content

    def get_original_url(self, illust_id: int) -> str:
        self.ensure_logged_in()
        detail = self.api.illust_detail(illust_id).illust
        single = detail.meta_single_page.get("original_image_url")
        if single:
            return single
        return detail.meta_pages[0].image_urls.original
