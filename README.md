# 88api-Nano-Banana

来自 [88api.ai](https://88api.ai/) Token 聚合站的 Codex 专用 Gemini 生图插件，通过 Anthropic Messages 协议调用：

- `gemini-3.1-flash-image`（默认）
- `gemini-3-pro-image`

插件独立于 `88API-image-gen`，不共享 Key、配置文件或协议路由。

## 环境

- Codex 插件功能
- Node.js 18 或更高版本
- 能够通过 Anthropic 协议调用上述 Gemini 图片模型的 88api.ai 分组 Key

API 固定使用：

- Base URL：`https://88api.ai`
- Messages 端点：`https://88api.ai/v1/messages`
- Anthropic 版本头：`2023-06-01`

## 初次使用：注册并创建 88API Key

1. 打开 [88api.ai](https://88api.ai/)，注册账号并登录控制台。
2. 进入左侧的“API 密钥”，点击右上角“创建 API 密钥”。
3. 名称可以自定义；分组必须选择能够通过 **Anthropic 协议**调用 `gemini-3.1-flash-image` 和/或 `gemini-3-pro-image` 的 Gemini 生图分组。`88api-image-gen` 使用的 Image2 专用 Key 不能直接代替。
4. **数量填写 1。** Nano Banana 当前只保存一个 Key，不需要批量创建。下面截图来自批量创建演示，图中的数量 `10` 不适用于本插件，请不要照填。

![在 88api.ai 创建 API 密钥](docs/assets/88api-create-anthropic-gemini-key.png)

5. 保存后返回 API 密钥列表，复制刚创建的 Key。不要把完整 Key 发到公开聊天、Issue、日志或 GitHub 仓库。

![在 88api.ai 复制 API 密钥](docs/assets/88api-copy-key.png)

6. 把 Key 配置到插件。若把仓库地址交给 Codex，Codex 应先检查配置；发现没有 Key 时，应提醒完成以上步骤，而不是直接发起生图请求。

## 快速安装

把 GitHub 仓库地址交给 Codex，让 Codex 检查 Node.js、添加 Marketplace、安装插件并检查 Key：

```text
https://github.com/blackdm666/88api-Nano-Banana
```

也可以手动安装：

```powershell
codex plugin marketplace add blackdm666/88api-Nano-Banana
codex plugin add 88api-nano-banana@88api-nano-banana
```

安装后新建 Codex 任务，使技能列表重新加载。

## 配置 Key

让 Codex 根据已安装插件的实际目录执行脚本，不要假定插件位于 `$HOME/plugins`：

```powershell
node "<PLUGIN_ROOT>\scripts\generate.mjs" --set-key "<YOUR_88API_GEMINI_IMAGE_KEY>"
node "<PLUGIN_ROOT>\scripts\generate.mjs" --get-config
```

配置保存在：

```text
~/.codex/88api-nano-banana-config.json
```

此配置与 `88api-image-gen-config.json` 完全独立。不要把真实 Key 写入仓库、文档、日志或聊天内容。

## 安全测试

以下命令不请求付费 API：

```powershell
node "<PLUGIN_ROOT>\scripts\generate.mjs" --self-test
node "<PLUGIN_ROOT>\scripts\generate.mjs" --prompt "测试提示词" --dry-run
```

## 使用

```powershell
node "<PLUGIN_ROOT>\scripts\generate.mjs" --prompt "在太空中挥手的布偶猫，背景是地球" --aspect 16:9 --resolution 1K

node "<PLUGIN_ROOT>\scripts\generate.mjs" --model gemini-3-pro-image --image "<参考图.png>" --prompt "保持主体身份，改成电影海报" --aspect 9:16 --resolution 2K
```

每张图片都是独立的云端请求。低配置电脑先使用单张任务；本地内存卡死、Codex 崩溃、断网或图片未成功保存，并不代表云端任务取消，已经受理或完成的请求仍可能正常计费。`[NO-RETRY]` 任务禁止自动重发。
