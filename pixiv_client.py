import hashlib
import secrets
import base64
import re
import requests
from pixivpy3 import AppPixivAPI


class PixivClient:
    def __init__(self, config):
        self.config = config
        self.api = AppPixivAPI()
        self._logged_in = False

    # ── Auth ──────────────────────────────────────────────────────────────────

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

    # ── Data fetch ────────────────────────────────────────────────────────────

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

    # ── Image download ────────────────────────────────────────────────────────

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
