# ComfyUI Pixiv Browser Node

在 ComfyUI 中直接浏览 Pixiv，选图后输出为 IMAGE 张量，接入任意下游节点。

---

## 功能

| 功能 | 说明 |
|------|------|
| 📌 推荐作品 | 浏览 Pixiv 为你推荐的插画 |
| 🏆 排行榜 | 日榜/周榜/月榜等多种排行 |
| ⭐ 收藏作品 | 查看你收藏的所有插画 |
| 👥 收藏画师 | 左栏列出收藏画师，点击右栏展示其全部作品 |
| 🖼 多选输出 | 可框选多张图片，批量输出 IMAGE batch |
| ♾ 无限滚动 | 所有页面均支持滚动到底部自动加载下一页 |
| 🔒 OAuth 登录 | 使用 pixivpy3 官方 PKCE 流程，token 本地保存，重启免登录 |

---

## 安装

### 1. 克隆到 ComfyUI custom_nodes

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/wrt122311/comfyui-pixiv-node.git
```

### 2. 安装依赖

在 ComfyUI 的 Python 环境中执行：

```bash
pip install pixivpy3 Pillow
```

> 如果使用 ComfyUI 便携版，请用便携版自带的 `python_embeded\python.exe -m pip install pixivpy3 Pillow`

### 3. 重启 ComfyUI

控制台出现以下提示说明加载成功：

```
[PixivBrowser] Loaded successfully
```

---

## 首次登录

节点首次使用时需要完成 Pixiv OAuth 授权，之后 token 自动保存，重启无需重新登录。

1. 在 ComfyUI 画布中添加 **Pixiv Browser** 节点（Add Node → image/pixiv → Pixiv Browser）
2. 点击节点上的 **🖼 浏览 Pixiv** 按钮，弹出浏览器弹窗
3. 弹窗显示登录页，点击 **"用浏览器登录 Pixiv"**
4. 新标签页打开 Pixiv 授权页，完成登录
5. 授权完成后浏览器会跳转到类似下面的地址（可能显示错误页，属正常现象）：
   ```
   pixiv://account/login?code=XXXXXXXXXXXXXXXX&via=login
   ```
6. 将地址栏中的完整 URL 复制，粘贴到弹窗的输入框中，点击 **"确认登录"**
7. 弹窗自动切换到图片浏览界面，登录完成

> Token 保存在节点目录下的 `config.json`，请勿将此文件提交到 git（已自动加入 `.gitignore`）

---

## 使用方法

### 浏览与选图

弹窗顶部有四个 Tab：

- **推荐** — Pixiv 为你推荐的最新插画
- **排行榜** — 每日排行榜（日榜）
- **收藏** — 你收藏的插画
- **画师** — 左侧列出你收藏的画师，点击画师名在右侧显示其全部作品

点击图片卡片即可选中（紫色边框 + 右上角序号角标），再次点击取消选中。  
支持跨 Tab 多选，底部显示已选张数。

### 输出图片

选好图片后点击 **✓ 确认选择**，关闭弹窗。  
点击 ComfyUI 的 **Queue Prompt**，节点将下载所选图片的原图并以 IMAGE batch 形式输出。

---

## 节点参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `artwork_ids` | STRING（隐藏） | 由弹窗写入的 artwork ID 列表，逗号分隔，通常无需手动填写 |

| 输出 | 类型 | 说明 |
|------|------|------|
| `images` | IMAGE | 形状 `[B, H, W, 3]`，float32，范围 `[0, 1]`，B 为选中图片数量 |

---

## 示例工作流

### 示例 1：预览 Pixiv 图片

最简单的工作流，浏览 Pixiv 后直接在 ComfyUI 中预览。

```
[Pixiv Browser] ──images──▶ [Preview Image]
```

**步骤：**
1. 添加 **Pixiv Browser** 节点
2. 添加 **PreviewImage** 节点
3. 将 Pixiv Browser 的 `images` 输出连接到 PreviewImage 的 `images` 输入
4. 点击节点上的按钮选好图片
5. Queue Prompt

---

### 示例 2：以 Pixiv 图为参考做图生图（img2img）

用 Pixiv 收藏的插画作为参考图，通过 img2img 生成新的图像。

```
[Pixiv Browser] ──images──▶ [VAE Encode] ──latent──▶ [KSampler] ──latent──▶ [VAE Decode] ──▶ [Preview Image]
                                                           ▲
                                           [CLIP Text Encode (prompt)]
                                           [Load Checkpoint] ──model / clip / vae──▶ 各节点
```

**步骤：**
1. 加载模型：**Load Checkpoint** → model、clip、vae
2. 添加 **Pixiv Browser** 节点，选好参考图
3. 添加 **VAE Encode**，将 Pixiv Browser 的 `images` 连接到 `pixels`，vae 连接到 `vae`
4. 添加 **CLIP Text Encode**，填写提示词
5. 添加 **KSampler**，连接 model、positive prompt、latent_image（来自 VAE Encode）
   - 建议 `denoise` 设为 `0.6~0.8`（值越低越接近原图）
6. 添加 **VAE Decode** 和 **Preview Image**
7. Queue Prompt

---

### 示例 3：批量保存 Pixiv 图片到本地

```
[Pixiv Browser] ──images──▶ [Save Image]
```

**步骤：**
1. 添加 **Pixiv Browser** 节点，选多张图
2. 添加 **Save Image** 节点，设置保存路径前缀
3. Queue Prompt，所有选中的图片会按序号保存到 `ComfyUI/output/` 目录

---

## 工作流 JSON（示例 1）

将以下 JSON 保存为 `.json` 文件，在 ComfyUI 中通过 **Load** 导入即可：

```json
{
  "last_node_id": 3,
  "last_link_id": 2,
  "nodes": [
    {
      "id": 1,
      "type": "PixivBrowser",
      "pos": [100, 200],
      "size": [210, 80],
      "flags": {},
      "order": 0,
      "mode": 0,
      "inputs": [],
      "outputs": [
        {"name": "images", "type": "IMAGE", "links": [1], "slot_index": 0}
      ],
      "properties": {},
      "widgets_values": [""]
    },
    {
      "id": 2,
      "type": "PreviewImage",
      "pos": [380, 200],
      "size": [210, 246],
      "flags": {},
      "order": 1,
      "mode": 0,
      "inputs": [
        {"name": "images", "type": "IMAGE", "link": 1}
      ],
      "outputs": [],
      "properties": {}
    }
  ],
  "links": [
    [1, 1, 0, 2, 0, "IMAGE"]
  ],
  "groups": [],
  "config": {},
  "extra": {},
  "version": 0.4
}
```

---

## 常见问题

**Q: 登录后弹窗没有自动刷新？**  
A: 检查粘贴的 URL 是否完整，必须以 `pixiv://account/login?code=` 开头。

**Q: 图片加载不出来？**  
A: Pixiv 图片需要通过代理加载以绕过防盗链限制，代理由节点自动处理。若仍失败，检查网络是否能访问 Pixiv（可能需要代理工具）。

**Q: 选好图片后 Queue Prompt 报错"所有图片下载失败"？**  
A: 原图下载需要网络能访问 `i.pximg.net`。请确认网络环境。

**Q: 重启 ComfyUI 需要重新登录吗？**  
A: 不需要。token 保存在 `config.json`，重启后自动使用。

---

## 依赖

- [pixivpy3](https://github.com/upbit/pixivpy) — Pixiv App API Python 客户端
- Pillow — 图像处理
- aiohttp — 已包含在 ComfyUI 中
- torch — 已包含在 ComfyUI 中

---

## License

MIT
