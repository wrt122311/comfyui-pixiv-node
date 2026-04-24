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

        # Parse "id|url,id|url,..." or legacy "id,id,..." format
        items = []
        for token in artwork_ids.split(","):
            token = token.strip()
            if not token:
                continue
            if "|" in token:
                artwork_id, url = token.split("|", 1)
                items.append((artwork_id.strip(), url.strip()))
            else:
                items.append((token, ""))

        print(f"[PixivBrowser] Downloading {len(items)} image(s)")
        tensors = []
        errors = []
        images = []
        for artwork_id, url in items:
            try:
                if not url:
                    url = client.get_original_url(int(artwork_id))
                raw = client.download_image_bytes(url)
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                images.append(img)
                print(f"[PixivBrowser] Downloaded {artwork_id}")
            except Exception as e:
                msg = f"{artwork_id}: {e}"
                print(f"[PixivBrowser] Skipping {msg}")
                errors.append(msg)

        if not images:
            detail = "\n".join(errors[:5])
            raise ValueError(f"所有图片下载失败:\n{detail}")

        # Resize all to the first image's dimensions so torch.stack works
        target_w, target_h = images[0].size
        for img in images:
            if img.size != (target_w, target_h):
                img = img.resize((target_w, target_h), Image.LANCZOS)
            arr = np.array(img, dtype=np.float32) / 255.0
            tensors.append(torch.from_numpy(arr))

        return (torch.stack(tensors),)
