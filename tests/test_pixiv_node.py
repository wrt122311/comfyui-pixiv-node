import io
import pytest
import torch
from unittest.mock import MagicMock
from PIL import Image
import pixiv_node
from pixiv_node import PixivBrowser


def _make_mock_client(w=64, h=64):
    client = MagicMock()
    img = Image.new("RGB", (w, h), color=(128, 64, 200))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    client.download_image_bytes.return_value = buf.getvalue()
    client.get_original_url.return_value = "https://i.pximg.net/orig/img.jpg"
    return client


def test_execute_returns_image_tensor(monkeypatch):
    monkeypatch.setattr(pixiv_node, "_get_client", lambda: _make_mock_client())
    result = PixivBrowser().execute(artwork_ids="12345")
    tensor = result[0]
    assert isinstance(tensor, torch.Tensor)
    assert tensor.ndim == 4
    assert tensor.shape[0] == 1
    assert tensor.shape[3] == 3
    assert tensor.dtype == torch.float32
    assert tensor.min() >= 0.0 and tensor.max() <= 1.0


def test_execute_multiple_ids_returns_batch(monkeypatch):
    monkeypatch.setattr(pixiv_node, "_get_client", lambda: _make_mock_client())
    result = PixivBrowser().execute(artwork_ids="111,222,333")
    assert result[0].shape[0] == 3


def test_execute_skips_failed_downloads(monkeypatch):
    client = MagicMock()
    client.get_original_url.return_value = "https://i.pximg.net/img.jpg"
    img = Image.new("RGB", (32, 32))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    client.download_image_bytes.side_effect = [Exception("timeout"), buf.getvalue()]
    monkeypatch.setattr(pixiv_node, "_get_client", lambda: client)
    result = PixivBrowser().execute(artwork_ids="bad_id,good_id")
    assert result[0].shape[0] == 1


def test_execute_raises_on_empty_ids(monkeypatch):
    monkeypatch.setattr(pixiv_node, "_get_client", lambda: MagicMock())
    with pytest.raises(ValueError, match="请先在弹窗中选择图片"):
        PixivBrowser().execute(artwork_ids="")


def test_input_types_has_artwork_ids():
    assert "artwork_ids" in PixivBrowser.INPUT_TYPES()["required"]


def test_return_types_is_image():
    assert PixivBrowser.RETURN_TYPES == ("IMAGE",)
