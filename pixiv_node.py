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

        errors = []
        for artwork_id in ids:
            try:
                url = client.get_original_url(int(artwork_id))
                raw = client.download_image_bytes(url)
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                arr = np.array(img, dtype=np.float32) / 255.0
                tensors.append(torch.from_numpy(arr))
            except Exception as e:
                msg = f"{artwork_id}: {e}"
                print(f"[PixivBrowser] Skipping {msg}")
                errors.append(msg)

        if not tensors:
            detail = "\n".join(errors[:5])
            raise ValueError(f"所有图片下载失败:\n{detail}")

        return (torch.stack(tensors),)
