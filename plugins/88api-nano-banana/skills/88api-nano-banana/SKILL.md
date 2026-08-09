---
name: 88api-nano-banana
description: Generate or edit raster images through 88api.ai with Gemini 3.1 Flash Image or Gemini 3 Pro Image over the OpenAI Chat Completions API. Use for Nano Banana generation, complex or high-detail image work, reference-image editing, or very long Base64/Data-URI image responses.
---

# 88API Nano Banana

Use the bundled `scripts/generate.mjs`. Resolve the plugin root from this installed `SKILL.md` location (two directories above the skill directory); never assume the plugin lives under `$HOME/plugins`.

## First use

1. Confirm Node.js 18 or newer with `node --version`.
2. Run `node "<PLUGIN_ROOT>/scripts/generate.mjs" --get-config` before generation.
3. If `已配置Key` is `false`, stop before generation. Tell the user to sign in at `https://88api.ai/`, open **API 密钥**, and create one Key that can call the selected Gemini image model through OpenAI Chat Completions. Point to `https://github.com/blackdm666/88api-Nano-Banana#创建并配置-88api-key` for the illustrated tutorial.
4. Save the Key only after the user supplies or directly enters it:

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --set-key "<YOUR_88API_GEMINI_IMAGE_KEY>"
```

The plugin uses `~/.codex/88api-nano-banana-config.json`. Never print, log, commit, or place a real Key in repository files.

## API contract

OpenAI Chat Completions is the plugin's only protocol. There is no protocol selector or automatic fallback.

- Endpoint: `POST https://88api.ai/v1/chat/completions` with JSON for generation and reference-image editing.
- Authentication: `Authorization: Bearer <KEY>`.
- Request: `messages`, `modalities: ["text", "image"]`, and `extra_body.google.image_config`.
- Image settings: send the selected ratio as `aspect_ratio` and `1K|2K|4K` as `image_size`.
- Reference images: include ordered `image_url` content parts as local Data URIs in the user message.
- Response: parse images from Chat Completions message content, image fields, Markdown, HTTP URLs, or Data URIs with bounded memory.

Never silently switch endpoints, models, or resend an accepted/unknown paid request.

## Model selection

The plugin supports exactly two image models:

- `gemini-3.1-flash-image` is the factory and initial saved default. Use it without asking for ordinary generation, quick iteration, and routine reference-image editing.
- `gemini-3-pro-image` prioritizes fine detail and complex work. It is suited to dense scenes, many subjects or constraints, precise typography or layout, identity-sensitive multi-reference edits, and requests for maximum quality.

Before any paid request, apply this selection flow:

1. Read the current saved model from `--get-config`. A model deliberately persisted with `--set-model` is the user's selected default and should be respected.
2. If the user explicitly selected Flash or Pro for the current task, use that model and do not ask again.
3. If the task is ordinary and neither the task nor saved configuration overrides the factory default, use `gemini-3.1-flash-image` directly.
4. If the current effective default is Flash and the user asks for high detail, maximum quality, a complex composition, precise text/layout, or complex reference editing without selecting a model, pause before calling the API and ask: `这个任务对细节或复杂度要求较高。是否切换到 gemini-3-pro-image？Pro 更适合复杂画面，但通常更慢、成本更高；不切换则继续使用默认 Flash。`
5. Wait for the answer. Use Pro only after confirmation; otherwise continue with Flash. Do not send a paid request while waiting.

A one-time model choice must use `--model` and must not change future defaults. Persist a model with `--set-model` only when the user explicitly asks to change the plugin's saved default.

Run `--list-models` when a user wants the machine-readable model capability list.

## Generate an image

Convert the request into a complete image prompt locally in Codex. Do not call a separate text model for prompt optimization.

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9 --resolution 1K
```

Optional flags:

- `--model gemini-3-pro-image|gemini-3.1-flash-image`
- `--aspect 1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9`
- `--resolution 1K|2K|4K`
- `--count 1..4` (each count is a separate paid request)
- `--output-dir "<ABSOLUTE_DIRECTORY>"`

Start with `--count 1`. Warn before multiple requests: a local memory failure, crash, or lost connection does not cancel a cloud request already accepted by 88api.ai, and it may still be billed.

Aspect and resolution are requested targets. Verify the saved file when exact dimensions matter; 88API or the upstream model may return a different size.

## Edit with reference images

Pass local PNG, JPEG, WebP, or GIF paths in input order. The script sends them as ordered `image_url` Data URI content parts in the Chat Completions user message.

```bash
node "<PLUGIN_ROOT>/scripts/generate.mjs" --image "<REFERENCE_1>" --image "<REFERENCE_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16 --resolution 1K
```

Keep total reference data under 20 MB. Do not combine or alter reference images before upload unless the user asks.

## Safe verification

These checks do not call the paid API:

```bash
node --check "<PLUGIN_ROOT>/scripts/generate.mjs"
node "<PLUGIN_ROOT>/scripts/generate.mjs" --self-test
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "测试" --dry-run
node "<PLUGIN_ROOT>/scripts/generate.mjs" --image "<REFERENCE>" --prompt "测试编辑" --dry-run
```

Dry runs hide the Key and never include reference-image bytes or Base64.

## Long image responses

The normal response is a Chat Completions message containing image data or links. If 88API wraps an image in a very long Markdown/Data URI string, the script scans it with bounded memory, removes Base64 from summaries, accepts standard and URL-safe Base64, and selects the last text-embedded image as the final result.

## Results and errors

- After success, show every saved image with an absolute-path Markdown image tag.
- Treat `[NO-RETRY]` as an accepted or unknown cloud state. Do not retry or fall back.
- On `401`/`403`, ask for a Key that can call the selected model through OpenAI Chat Completions.
- If a successful response contains no saveable image, report only the sanitized text summary; never expose embedded Base64.
- A response body is capped at 128 MB and a single text-embedded Base64 image at 96 MB to prevent local memory exhaustion.
