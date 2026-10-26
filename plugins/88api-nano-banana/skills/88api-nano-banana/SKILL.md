---
name: 88api-nano-banana
description: DISCONTINUED — no longer updated; 88API-Image-Gen now covers these Gemini models and every other 88API image model. Still works for existing users. Generate or edit raster images through 88api.ai with Gemini 3.1 Flash Image or Gemini 3 Pro Image over the OpenAI Chat Completions API. Use for Nano Banana generation, complex or high-detail image work, reference-image editing, sequential multi-prompt batches, very long Base64/Data-URI image responses, checking interrupted paid runs, or troubleshooting Agent-client sandbox, timeout, and network-approval failures before an 88API request starts. Works in Codex, Claude Code, ZCode, DeepSeek Harness, and other Agent clients that can run local Node.js commands.
---

# 88API-Nano-Banana

> **This plugin is no longer updated.** Gemini image generation moved to **88API-Image-Gen** (`https://github.com/blackdm666/88API-image-gen`), which also covers Nano Banana 2.1, GPT Image, Grok, Seedream and Midjourney and reads model limits from the live 88API catalog. Its Key is migrated automatically from `~/.88api/nano-banana.json`.
>
> If 88API-Image-Gen is installed, prefer it. Otherwise keep using this plugin as below, and mention once per conversation (in the user's language) that it is no longer updated and 88API-Image-Gen replaces it. Do not refuse or delay the user's request because of this.

Use the bundled `scripts/generate.mjs`, which sits beside this `SKILL.md`. `<SKILL_DIR>` below means the absolute directory this `SKILL.md` was loaded from; never assume a fixed marketplace or skills cache path, and do not copy the script elsewhere. It runs in any Agent client that can execute a local `node` command.

## First use

1. Confirm Node.js 18 or newer with `node --version`.
2. Run `node "<SKILL_DIR>/scripts/generate.mjs" --get-config` before generation.
3. If `已配置Key` is `false`, stop before any paid request, but **do not tell the user to run PowerShell or copy a setup command**. Say: `还差一个 88API Key，我可以帮你一键配置。请到 https://88api.ai/ 的“API 密钥”页面创建一个 auto 分组 Key，然后把完整 Key 直接发给我；收到后我会保存到本机并做脱敏验证，你不需要运行任何命令。` Link to `https://github.com/blackdm666/88api-Nano-Banana#创建并配置-88api-key` only when the user needs the illustrated Key-creation tutorial.
4. Wait for the user to supply the Key. Then run `node "<SKILL_DIR>/scripts/generate.mjs" --set-key "<KEY>"` yourself, followed by `--get-config`, `--list-models`, and `--self-test`. These checks do not submit a paid image request.
5. Treat the Key as sensitive: never repeat it in replies, progress updates, or command-result summaries; never write it to source, project files, or logs. Report only the masked configuration state and config path. If validation fails, explain the error category and ask for a working Key without echoing the old one.
6. After successful setup, automatically continue the user's original generation or editing request. Do not ask them to restate it.

The plugin stores the Key in `~/.88api/nano-banana.json`, shared by every Agent client on the machine. A Key saved by an older Codex-only version (`~/.codex/88api-nano-banana-config.json`) is copied there automatically on first use and the old file is kept in sync. `API88_KEY`, when set, takes precedence and is never written to disk; `--get-config` shows which source is active. The user should supply the Key only in a trusted Agent conversation, never in a GitHub Issue, public chat, repository file, or screenshot. A Key sent in chat can remain in the client's conversation history; users who prefer not to send it can set `API88_KEY` instead.

## API contract

OpenAI Chat Completions is the plugin's only protocol. There is no protocol selector or automatic fallback.

- Endpoint: `POST https://88api.ai/v1/chat/completions` with JSON for generation and reference-image editing.
- Authentication: `Authorization: Bearer <KEY>`.
- Request: `messages`, `modalities: ["text", "image"]`, and `extra_body.google.image_config`.
- Image settings: send the selected ratio as `aspect_ratio` and `1K|2K|4K` as `image_size`.
- Reference images: include ordered `image_url` content parts as local Data URIs in the user message.
- Transport: use a direct HTTPS request with a 10-minute timeout, `Accept-Encoding: identity`, and local 15-second progress heartbeats. Do not set `stream: true`; the Gemini image channel may reject streamed Chat Completions even though other 88API chat channels support SSE.
- Response: parse images from Chat Completions message content, image fields, Markdown, HTTP URLs, or Data URIs with bounded memory.

Never silently switch endpoints, models, or automatically resend an accepted/unknown paid request.

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

Convert the request into a complete image prompt yourself. Do not call a separate text model for prompt optimization.

```bash
node "<SKILL_DIR>/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9 --resolution 1K
```

Optional flags:

- `--model gemini-3-pro-image|gemini-3.1-flash-image`
- `--aspect 1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9`
- `--resolution 1K|2K|4K`
- `--count 1..4` (each count is a separate paid request)
- `--batch-inline "<PROMPT_1>" "<PROMPT_2>" ...` (up to 20 different prompts, sequential paid requests in one process)
- `--batch "<PROMPTS.json>"` where the file is a JSON string array or `{ "prompts": [...] }`
- `--output-dir "<ABSOLUTE_DIRECTORY>"`

Start with one request unless the user explicitly asks for multiple outputs. Warn before multiple requests: a local memory failure, crash, or lost connection does not cancel a cloud request already accepted by 88api.ai, and it may still be billed.

For two or more outputs, prepare the complete task list first and invoke `generate.mjs` exactly once. Use `--count` for one repeated prompt and `--batch-inline` or `--batch` for different prompts. The batch runs sequentially and stops on the first failure; never launch one Node process per image, because repeated shell launches can trigger repeated client command or network approvals (for example Codex Auto mode) before later tasks reach 88API.

Aspect and resolution are requested targets. Verify the saved file when exact dimensions matter; 88API or the upstream model may return a different size.

## Edit with reference images

Pass local PNG, JPEG, WebP, or GIF paths in input order. The script sends them as ordered `image_url` Data URI content parts in the Chat Completions user message.

```bash
node "<SKILL_DIR>/scripts/generate.mjs" --image "<REFERENCE_1>" --image "<REFERENCE_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16 --resolution 1K
```

Keep total reference data under 20 MB. Do not combine or alter reference images before upload unless the user asks.

## Safe verification

These checks do not call the paid API:

```bash
node --check "<SKILL_DIR>/scripts/generate.mjs"
node "<SKILL_DIR>/scripts/generate.mjs" --self-test
node "<SKILL_DIR>/scripts/generate.mjs" --prompt "测试" --dry-run
node "<SKILL_DIR>/scripts/generate.mjs" --image "<REFERENCE>" --prompt "测试编辑" --dry-run
```

Dry runs hide the Key and never include reference-image bytes or Base64.

A dry-run does not grant network access to the later paid command. Run at most one dry-run for the complete batch, then start the paid batch with one `generate.mjs` invocation. Do not dry-run each image separately.

## Long image responses

Long-running Pro generations use a direct HTTPS/1.1 request instead of Node's high-level `fetch` path. The response requests identity encoding to avoid fragile compression/decoding of large Base64 JSON bodies, waits up to 10 minutes, and prints a local heartbeat every 15 seconds. Do not enable Chat Completions streaming for these image models: the selected Gemini image channel can return HTTP 500 for `stream: true`. Base64 is removed from summaries, standard and URL-safe Base64 are accepted, and the last text-embedded image is selected as the final result.

## Long runs and client command timeouts

One paid request can take up to 10 minutes (Pro and 4K are slower), and a batch longer. Many Agent clients stop a shell command much sooner, and a stopped process may already have had its request accepted and billed without printing `[NO-AUTO-RETRY]`. Therefore:

- **Claude Code:** the Bash tool stops commands after 2 minutes by default and 10 minutes at most. Run every paid `generate.mjs` command with `run_in_background: true` and wait for its completion notification before reporting. Never run a paid command in the foreground with the default timeout. No-charge commands (`--get-config`, `--dry-run`, `--self-test`, `--job-status`) may run in the foreground.
- **DeepSeek Harness:** its bash tool moves a command to the background after its timeout (120 seconds by default) instead of killing it. Wait for that background task to finish; do not start the same request again.
- **ZCode, Cursor, Cline, Windsurf, VS Code, Gemini CLI, and other clients:** if the client offers background or long-running commands, use them for paid commands. Otherwise run the paid command once and wait.
- **Any client:** each paid run first prints `提交记录：<path>` with a job id. If the command was cut off, timed out, lost its output, or its result is unclear, do not resubmit. Run `node "<SKILL_DIR>/scripts/generate.mjs" --job-status <job id>` (or `--job-status` alone for recent runs). It sends no request and costs nothing, and reports each request as saved, not sent, rejected by 88API, running, or `[NO-AUTO-RETRY]` unknown / interrupted (may be billed). Report the saved images it lists and follow the result rules below for the rest.
- `--json` prints one machine-readable summary line at the end of a paid run (the same shape as `--job-status`).

## Codex Auto-mode network approval

Codex Auto mode can require approval before a shell command reaches the network. This approval happens outside the plugin and may fail before Node or the 88API request starts.

When the tool layer explicitly reports an external-network execution authorization error, sandbox network denial, approval-service failure, or approval-service `429 Too Many Requests`:

1. Do not call it an 88API, Key, channel, or model rate limit. An 88API response is reported by the plugin as `HTTP <status>`, not as a Codex authorization-service error.
2. Check the per-task output. A line such as `[1/6] 正在向 88API 提交图片请求` proves that task started; tasks blocked before that line were not submitted to 88API and have no corresponding 88API usage log or charge. Report earlier accepted or completed tasks separately because those may be billed.
3. Explain the cause with this wording, adapted to the actual task counts:

   > 这不是 88API 返回的 429，而是 Codex Auto 模式的外部网络执行审批在请求发出前被限流。本次被拦截的任务尚未发送到 88API，因此 88API 没有对应日志，也不会产生这部分费用；此前已经受理的任务仍按实际结果计费。

4. Tell the user how to continue:
   - Open Codex desktop settings with `Ctrl+,` on Windows.
   - Go to **General（通用）→ Permissions（权限）** and enable **Full access（完全访问）**.
   - Return to the task, open the permission control below the composer, and select **Full access（完全访问）**.
   - Resubmit all remaining images in one `--batch-inline` or `--batch` invocation.
5. Warn that Full access（完全访问） removes the local sandbox and approval boundary for that task. Let the user choose it; never edit their global Codex permission configuration silently. If Full access is unavailable or disabled, explain that an organization policy may control it and fall back to one batch command with a single approval.

Do not use `[NO-AUTO-RETRY]` for a command that was clearly blocked before any request reached 88API. It is safe to resubmit only the confirmed-unstarted tasks after the user changes permissions. If submission state is unclear, preserve the unknown-state cost warning.

## Results and errors

- After success, show every saved image with an absolute-path Markdown image tag.
- Treat `[NO-AUTO-RETRY]` as an accepted or unknown cloud state. Do not automatically retry, fall back, switch models, or silently submit a replacement in the same run.
- `[NO-AUTO-RETRY]` is not a permanent ban on future requests. Warn that the previous request may still be billed. If the user explicitly says to retry, regenerate, resubmit, or try once more, that message authorizes exactly one new paid request; run it without requiring the user to inspect 88API logs first.
- If the user has not explicitly authorized another paid request, ask whether they want to check the usage log or submit one new request. Never infer retry authorization only from the original request.
- Treat legacy `[NO-RETRY]` output from an older installed version with the same rules.
- Failures name the stage they reached:
  - `request was not sent` (请求未发出): the connection to 88API never opened. Nothing was submitted or billed; the same request may be run again directly.
  - `[NO-AUTO-RETRY] ... (stage: submit)`: the request was sent and its state is unknown. Keep the unknown-state cost warning.
  - `[NO-AUTO-RETRY] ... (stage: read-result)`: the request completed and was billed; only reading the response failed.
  - `[NO-AUTO-RETRY] ... (stage: download)`: the image was generated and billed, but downloading the returned link failed after free retries. The error names a `*.pending-download.json` file; offer `node "<SKILL_DIR>/scripts/generate.mjs" --retry-download "<that file>"` first. It sends no paid request. Suggest a new paid request only if that download also fails (links can expire within about an hour).
  - `--job-status` state `interrupted` or `unknown`: treat exactly like `stage: submit`.
- In a batch, a failure stops the remaining prompts; those were never sent and cost nothing. The CLI lists images already saved in the run.
- On `401`/`403`, ask for a Key that can call the selected model through OpenAI Chat Completions.
- If a successful response contains no saveable image, report only the sanitized text summary; never expose embedded Base64.
- A response body is capped at 128 MB and a single text-embedded Base64 image at 96 MB to prevent local memory exhaustion.
