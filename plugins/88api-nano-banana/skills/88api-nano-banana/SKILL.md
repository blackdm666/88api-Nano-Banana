---
name: 88api-nano-banana
description: Generate or edit raster images through 88api.ai using the Anthropic Messages protocol and the gemini-3-pro-image or gemini-3.1-flash-image models. Use when the user asks Nano Banana, Gemini image generation, Gemini image editing, reference-image transformation, or explicitly asks to use 88api.ai with Anthropic protocol for an image task.
---

# 88API Nano Banana

Use the bundled `scripts/generate.mjs`. Resolve the plugin root from this installed `SKILL.md` location (two directories above the skill directory); never assume the plugin lives under `$HOME/plugins`.

## First use

1. Confirm Node.js 18 or newer with `node --version`.
2. Run `node "<PLUGIN_ROOT>/scripts/generate.mjs" --get-config`.
3. If `已配置Key` is `false`, stop before generation. Tell the user to register or sign in at `https://88api.ai/`, open **API 密钥**, and create one Key in a group that can call the selected Gemini image model through the Anthropic protocol. Point the user to `https://github.com/blackdm666/88api-Nano-Banana#创建并配置-88api-key` for the illustrated tutorial. An Image2-only Key is not sufficient.
4. Save the Key only after the user supplies or directly enters it:

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --set-key "<YOUR_88API_GEMINI_IMAGE_KEY>"
```

Never reuse `~/.codex/88api-image-gen-config.json`; this plugin uses the independent file `~/.codex/88api-nano-banana-config.json`. Never print, log, commit, or place a real Key in repository files.

## Model selection

- Default to `gemini-3.1-flash-image` for normal generation, iteration, and lower latency.
- Use `gemini-3-pro-image` when the user prioritizes composition, typography, complex editing, or maximum quality.
- Never route through GPT-5.5, OpenAI Images, OpenAI Chat Completions, or Google native protocol.
- Never switch models or resend an accepted/unknown paid request automatically.

Persist a preferred model when requested:

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --set-model gemini-3-pro-image
```

## Generate an image

Convert the user's request into a complete image prompt locally in Codex. Do not call a separate text model for prompt optimization.

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9 --resolution 1K
```

Optional flags:

- `--model gemini-3-pro-image|gemini-3.1-flash-image`
- `--aspect 1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9`
- `--resolution 512|1K|2K|4K` (`512` is allowed only for Flash)
- `--count 1..4` (each image is a separate paid request)
- `--output-dir "<ABSOLUTE_DIRECTORY>"`

Start with `--count 1`. Warn before multiple images: local memory failure or a Codex crash does not cancel a request already accepted by 88api.ai, and accepted/completed cloud tasks may still be billed even when the local image was not saved.

## Edit with reference images

Pass one or more local PNG, JPEG, WebP, or GIF paths. The script embeds each input as an Anthropic base64 image content block in argument order.

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --image "<REFERENCE_1>" --image "<REFERENCE_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16 --resolution 1K
```

Keep total inline reference data under 20 MB. Do not combine or alter reference images before upload unless the user asks.

## Safe verification

Use these checks without calling the paid API:

```bash
node --check "<PLUGIN_ROOT>/scripts/generate.mjs"
node "<PLUGIN_ROOT>/scripts/generate.mjs" --self-test
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "测试提示词" --dry-run
```

`--dry-run` prints a sanitized Anthropic request preview and never includes the Key or reference-image Base64.

## Results and errors

- After success, show each saved image in Codex using an absolute-path Markdown image tag.
- Treat `[NO-RETRY]` as accepted or unknown cloud state. Do not retry or fall back.
- On `401`/`403`, ask for an Anthropic-protocol Gemini image Key; an Image2-only Key is not sufficient.
- If a successful response contains only text and no image, report the returned text and preserve the sanitized response summary for diagnosis; do not repeat the paid request automatically.
- The API endpoint is fixed to `https://88api.ai/v1/messages` and the header version is `2023-06-01`.
