# 88api-Nano-Banana

来自 [88api.ai](https://88api.ai/) Token 聚合站的 Codex 专用 Gemini 生图插件。它通过 **OpenAI Images** 协议生成和编辑图片，并将结果直接保存到本地。

可调用：

- `gemini-3.1-flash-image`（默认）
- `gemini-3-pro-image`

插件独立于 `88API-image-gen`，不共享 Key 或配置文件。

## 选择适合你的方式

| 方式 | 适合场景 | 入口 |
| --- | --- | --- |
| Codex 插件（本项目） | 在 Codex 中用自然语言生成或编辑图片，适合参考图、重复任务、自动化和本地落盘 | 按下方步骤安装 |
| 简单生图工具 | 无需安装，在浏览器中填写提示词、调整参数、上传参考图并复用历史任务 | [打开简单生图工具](https://img.88api.ai/) |
| 专业画布工具 | 适合复杂创作流程、图像与视频项目、提示词库、资产管理和 Agent 辅助任务 | [打开专业画布工具](https://img-pro.88api.ai/) |

只想快速出一张图时使用简单生图工具；需要可视化管理素材和多步骤创作时使用专业画布；希望让 Codex 理解需求并自动执行、保存文件时使用本插件。

## API 协议

从 `v1.2.0` 开始，插件仅使用 OpenAI Images 协议：

| 场景 | 端点 | 请求格式 |
| --- | --- | --- |
| 文生图 | `https://88api.ai/v1/images/generations` | JSON |
| 参考图编辑 | `https://88api.ai/v1/images/edits` | multipart，参考图字段为 `image[]` |

两个端点都使用 `Authorization: Bearer <KEY>`。旧版的 Anthropic Messages、Gemini 原生协议和 OpenAI Chat 兼容逻辑已移除；插件没有协议选择器，也不会在协议之间自动路由。

## 环境

- Codex 插件功能
- Node.js 18 或更高版本
- 能通过 OpenAI Images 调用上述 Gemini 图片模型的 88api.ai Key

## 创建并配置 88API Key

### 1. 注册账号

打开 [88api.ai](https://88api.ai/) 注册账号并登录。

### 2. 创建 API Key

进入“API 密钥”，点击“创建 API 密钥”。名称可以自定义（例如“生图”），分组选择 `auto`（自动分组）；如需在当前分组渠道失败时继续尝试下一分组，可开启“跨分组重试”。

![创建 API Key](docs/assets/88api-create-image-key.png)

### 3. 复制并配置 Key

复制创建好的 Key，然后直接交给 Codex 配置到插件中，或者执行下方命令：

![复制 API Key](docs/assets/88api-copy-key.png)

```powershell
node "<PLUGIN_ROOT>\scripts\generate.mjs" --set-key "<YOUR_88API_GEMINI_IMAGE_KEY>"
node "<PLUGIN_ROOT>\scripts\generate.mjs" --get-config
```

配置保存在 `~/.codex/88api-nano-banana-config.json`。旧版本留下的协议字段会在下次保存配置时清除。不要把真实 Key 写入仓库、文档、日志或公开聊天内容。

## 安装

把 GitHub 仓库地址交给 Codex：

```text
https://github.com/blackdm666/88api-Nano-Banana
```

也可以手动安装：

```powershell
codex plugin marketplace add blackdm666/88api-Nano-Banana
codex plugin add 88api-nano-banana@88api-nano-banana
```

安装或升级后新建 Codex 任务，使技能列表重新加载。

## 使用

文生图：

```powershell
node "<PLUGIN_ROOT>\scripts\generate.mjs" --prompt "在太空中挥手的布偶猫，背景是地球" --aspect 16:9 --resolution 1K
```

参考图编辑：

```powershell
node "<PLUGIN_ROOT>\scripts\generate.mjs" --model gemini-3-pro-image --image "<参考图.png>" --prompt "保持主体身份，改成电影海报" --aspect 9:16 --resolution 2K
```

比例和分辨率是请求目标，不是本地强制缩放。对尺寸有硬性要求时应检查最终文件；88API 或上游模型可能调整输出尺寸。

## 超长文本图片解析

正常响应使用 OpenAI Images 的 `data[].b64_json` 或 `data[].url`。如果 88API 把图片包装在百万字符级 Markdown/Data URI 文本中，插件仍会在 128 MB 响应上限内：

- 解析 Markdown/Data URI 和 URL-safe Base64；
- 从摘要和错误中移除 Base64；
- 多个文本候选仅保留最后一张成品图；
- 对最终图片进行内容哈希去重。

## 安全测试

以下命令不会请求付费 API：

```powershell
node --check "<PLUGIN_ROOT>\scripts\generate.mjs"
node "<PLUGIN_ROOT>\scripts\generate.mjs" --self-test
node "<PLUGIN_ROOT>\scripts\generate.mjs" --prompt "测试" --dry-run
node "<PLUGIN_ROOT>\scripts\generate.mjs" --image "<参考图.png>" --prompt "测试编辑" --dry-run
```

每个 `--count` 都是独立云端请求。本地卡死、Codex 崩溃、断网或图片未保存，不代表云端任务取消；已经受理或完成的请求仍可能计费。`[NO-RETRY]` 任务禁止自动重发。
