import re
import pytest
from unittest.mock import MagicMock, patch
from pixiv_client import PixivClient


def make_client(token=None):
    mock_config = MagicMock()
    mock_config.get_refresh_token.return_value = token
    return PixivClient(mock_config)


# ── Auth tests ────────────────────────────────────────────────────────────────

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


# ── Fetch tests ───────────────────────────────────────────────────────────────

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


# ── Download tests ────────────────────────────────────────────────────────────

def test_download_image_bytes_sets_referer_header():
    client = make_client(token="tok")
    client._logged_in = True
    client.api = MagicMock()

    fake_response = MagicMock()
    fake_response.content = b"\xff\xd8\xff"
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
