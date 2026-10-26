#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const API_ROOT = "https://88api.ai";
const CHAT_COMPLETIONS_URL = `${API_ROOT}/v1/chat/completions`;
const PLUGIN_VERSION = "1.5.0";
// 本插件已停止更新：Gemini 生图并入 88API-Image-Gen（同一个 Key，自动迁移）。
const DISCONTINUED_NOTICE = "提示：88API-Nano-Banana 已停止更新，Gemini 生图已并入 88API-Image-Gen（https://github.com/blackdm666/88API-image-gen），Key 会自动迁移。本插件仍可继续使用，但不再增加新模型。";
// 客户端无关的配置位置。API88_CONFIG_DIR 可改目录；API88_KEY 只在本次进程中覆盖 Key、不写盘。
const CONFIG_DIR_OVERRIDDEN = Boolean(String(process.env.API88_CONFIG_DIR || "").trim());
const CONFIG_DIR = CONFIG_DIR_OVERRIDDEN ? resolve(String(process.env.API88_CONFIG_DIR).trim()) : join(homedir(), ".88api");
const CONFIG_PATH = join(CONFIG_DIR, "nano-banana.json");
const JOBS_DIR = join(CONFIG_DIR, "nano-banana-jobs");
const ENV_API_KEY = String(process.env.API88_KEY || "").trim();
// 旧版（仅 Codex）配置：首次使用时复制到 CONFIG_PATH，不删除；旧文件存在期间每次保存同步更新，未升级的旧版插件仍可使用。
const LEGACY_CONFIG_PATH = join(homedir(), ".codex", "88api-nano-banana-config.json");
const JOB_LIST_LIMIT = 5;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [2_000, 5_000];
const DEFAULT_OUTPUT_DIR = join(homedir(), "Pictures", "88api-nano-banana");
const DEFAULT_MODEL = "gemini-3.1-flash-image";
const MODEL_INFO = [
  {
    id: "gemini-3.1-flash-image",
    default: true,
    profile: "速度与效率优先",
    recommendedFor: ["日常文生图", "快速迭代", "常规参考图编辑"],
  },
  {
    id: "gemini-3-pro-image",
    default: false,
    profile: "细节与复杂任务优先",
    recommendedFor: ["高细节画面", "复杂构图", "精细文字排版", "复杂参考图编辑"],
  },
];
const MODELS = new Set(MODEL_INFO.map(({ id }) => id));
const ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const MAX_IMAGES = 4;
const MAX_BATCH_PROMPTS = 20;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 96 * 1024 * 1024;
const MAX_TEXT_SUMMARY_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_HEARTBEAT_MS = 15 * 1000;
const HTTPS_AGENT = new HttpsAgent({ keepAlive: true, maxSockets: MAX_IMAGES });

function defaultConfig() {
  return { apiKey: "", baseURL: API_ROOT, model: DEFAULT_MODEL, outputDir: "" };
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    apiKey: typeof source.apiKey === "string" ? source.apiKey.trim() : "",
    baseURL: API_ROOT,
    model: MODELS.has(source.model) ? source.model : DEFAULT_MODEL,
    outputDir: typeof source.outputDir === "string" ? source.outputDir.trim() : "",
  };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows profile ACLs remain authoritative when POSIX bits are unavailable.
    }
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

let loadedConfigSource = null;

function defaultLegacyPaths(path) {
  return path === CONFIG_PATH && !CONFIG_DIR_OVERRIDDEN ? [LEGACY_CONFIG_PATH] : [];
}

function legacyMirrorPaths(path) {
  return path === CONFIG_PATH && !CONFIG_DIR_OVERRIDDEN && existsSync(LEGACY_CONFIG_PATH) ? [LEGACY_CONFIG_PATH] : [];
}

function saveConfig(config, path = CONFIG_PATH, mirrorPaths = legacyMirrorPaths(path)) {
  const normalized = normalizeConfig(config);
  atomicWriteJson(path, normalized);
  for (const mirrorPath of mirrorPaths) {
    try {
      atomicWriteJson(mirrorPath, normalized);
    } catch (error) {
      console.warn(`WARNING: 已保存 ${path}，但旧版配置 ${mirrorPath} 未能同步：${error?.message || String(error)}`);
    }
  }
}

function loadConfig(path = CONFIG_PATH, { create = false, legacyPaths = defaultLegacyPaths(path) } = {}) {
  const sourcePath = existsSync(path) ? path : (legacyPaths.find((legacyPath) => existsSync(legacyPath)) || null);
  loadedConfigSource = sourcePath;
  if (!sourcePath) {
    const config = defaultConfig();
    if (create) saveConfig(config, path);
    return config;
  }
  let config;
  try {
    config = normalizeConfig(JSON.parse(readFileSync(sourcePath, "utf8")));
  } catch (error) {
    throw new Error(`配置文件无法读取：${sourcePath} (${error?.message || String(error)})`);
  }
  if (sourcePath !== path) {
    saveConfig(config, path, legacyMirrorPaths(path).filter((mirrorPath) => mirrorPath !== sourcePath));
    console.warn(`NOTICE: 已把 88API 配置从 ${sourcePath} 复制到 ${path}，旧文件保留。`);
  }
  return config;
}

// Key 优先级：API88_KEY > 配置文件 > 旧环境变量 NANO_BANANA_API_KEY。
function resolveApiKey(config, envKey = ENV_API_KEY) {
  if (envKey) return { key: envKey, source: "环境变量 API88_KEY（优先于配置文件，不写入磁盘）" };
  if (config.apiKey) return { key: config.apiKey, source: loadedConfigSource || CONFIG_PATH };
  const legacyEnvKey = String(process.env.NANO_BANANA_API_KEY || "").trim();
  if (legacyEnvKey) return { key: legacyEnvKey, source: "环境变量 NANO_BANANA_API_KEY" };
  return { key: "", source: "未配置" };
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function configSummary(config, { envKey = ENV_API_KEY } = {}) {
  const { key, source } = resolveApiKey(config, envKey);
  const mirrors = legacyMirrorPaths(CONFIG_PATH);
  return {
    配置文件: CONFIG_PATH,
    Key来源: source,
    旧版配置同步: mirrors.length > 0 ? `${mirrors.join(", ")}（保存时同步更新，供旧版插件使用）` : "无",
    已配置Key: Boolean(key),
    Key预览: maskKey(key),
    BaseURL: API_ROOT,
    协议: "OpenAI Chat Completions",
    请求端点: CHAT_COMPLETIONS_URL,
    当前保存模型: config.model,
    出厂默认模型: DEFAULT_MODEL,
    可用模型: MODEL_INFO.map(({ id }) => id),
    输出目录: config.outputDir || DEFAULT_OUTPUT_DIR,
  };
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}

function parseArgs(argv) {
  const flags = { images: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--get-config") flags.getConfig = true;
    else if (arg === "--config-path") flags.configPath = true;
    else if (arg === "--list-models") flags.listModels = true;
    else if (arg === "--self-test") flags.selfTest = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--set-key") flags.setKey = valueAfter(argv, index++, arg);
    else if (arg === "--set-model") flags.setModel = valueAfter(argv, index++, arg);
    else if (arg === "--prompt") flags.prompt = valueAfter(argv, index++, arg);
    else if (arg === "--batch") flags.batchFile = valueAfter(argv, index++, arg);
    else if (arg === "--batch-inline") {
      const prompts = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) prompts.push(argv[++index]);
      if (prompts.length === 0) throw new Error("--batch-inline 至少需要一个提示词");
      flags.batchInline = prompts;
    }
    else if (arg === "--model") flags.model = valueAfter(argv, index++, arg);
    else if (arg === "--aspect" || arg === "--ratio") flags.aspect = valueAfter(argv, index++, arg);
    else if (arg === "--resolution") flags.resolution = valueAfter(argv, index++, arg).toUpperCase();
    else if (arg === "--count") flags.count = Number(valueAfter(argv, index++, arg));
    else if (arg === "--output-dir") flags.outputDir = valueAfter(argv, index++, arg);
    else if (arg === "--image") flags.images.push(valueAfter(argv, index++, arg));
    else if (arg === "--retry-download") flags.retryDownload = valueAfter(argv, index++, arg);
    else if (arg === "--job-status") {
      flags.jobStatus = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
    } else if (arg === "--json") flags.json = true;
    else throw new Error(`不支持的参数：${arg}`);
  }
  return flags;
}

function validatePromptList(prompts, source) {
  if (!Array.isArray(prompts) || prompts.length === 0) throw new Error(`${source} 必须包含至少一个提示词`);
  if (prompts.length > MAX_BATCH_PROMPTS) throw new Error(`${source} 最多支持 ${MAX_BATCH_PROMPTS} 个提示词`);
  return prompts.map((prompt, index) => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`${source} 第 ${index + 1} 个提示词为空或不是字符串`);
    return prompt.trim();
  });
}

function resolvePromptList(flags) {
  const modes = [Boolean(flags.prompt?.trim()), Boolean(flags.batchFile), Boolean(flags.batchInline)].filter(Boolean).length;
  if (modes === 0) throw new Error("缺少 --prompt、--batch 或 --batch-inline");
  if (modes > 1) throw new Error("--prompt、--batch 和 --batch-inline 只能选择一种");

  if (flags.batchInline) {
    if (flags.count != null) throw new Error("--count 不能与 --batch-inline 同时使用");
    return validatePromptList(flags.batchInline, "--batch-inline");
  }
  if (flags.batchFile) {
    if (flags.count != null) throw new Error("--count 不能与 --batch 同时使用");
    const parsed = JSON.parse(readFileSync(resolve(flags.batchFile), "utf8"));
    return validatePromptList(Array.isArray(parsed) ? parsed : parsed?.prompts, "--batch");
  }

  const count = flags.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) throw new Error(`--count 必须是 1..${MAX_IMAGES} 的整数`);
  return Array.from({ length: count }, () => flags.prompt.trim());
}

function validateModel(model) {
  if (!MODELS.has(model)) throw new Error(`不支持的模型：${model}`);
  return model;
}

function validateAspect(aspect) {
  if (!ASPECTS.has(aspect)) throw new Error(`不支持的比例：${aspect}`);
  return aspect;
}

function validateResolution(resolution, model) {
  if (!RESOLUTIONS.has(resolution)) throw new Error(`不支持的分辨率：${resolution}`);
  return resolution;
}

function mimeFromPath(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  throw new Error(`参考图格式不支持：${path}`);
}

function loadReferenceImages(paths) {
  let totalBytes = 0;
  return paths.map((inputPath) => {
    const path = resolve(inputPath);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`参考图不存在：${path}`);
    const data = readFileSync(path);
    totalBytes += data.length;
    if (totalBytes > MAX_REFERENCE_BYTES) throw new Error("参考图总大小超过 20 MB，请减少图片或压缩后重试");
    return { path, name: basename(path), mimeType: mimeFromPath(path), data, bytes: data.length };
  });
}

function referenceImagePart(reference, redactImageData = false) {
  const encoded = redactImageData
    ? `<已省略 ${reference.bytes} 字节参考图>`
    : reference.data.toString("base64");
  return {
    type: "image_url",
    image_url: { url: `data:${reference.mimeType};base64,${encoded}` },
  };
}

function buildChatCompletionsBody({ model, prompt, aspect, resolution }, references, { redactImageData = false } = {}) {
  const text = prompt.trim();
  const content = references.length === 0
    ? text
    : [
      { type: "text", text },
      ...references.map((reference) => referenceImagePart(reference, redactImageData)),
    ];
  return {
    model,
    messages: [{ role: "user", content }],
    modalities: ["text", "image"],
    extra_body: {
      google: {
        image_config: {
          aspect_ratio: aspect,
          image_size: resolution,
        },
      },
    },
  };
}

function normalizeMime(mimeType) {
  const value = String(mimeType || "image/png").toLowerCase();
  if (value.includes("jpeg") || value.includes("jpg")) return "image/jpeg";
  if (value.includes("webp")) return "image/webp";
  if (value.includes("gif")) return "image/gif";
  return "image/png";
}

function extensionForMime(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function isBase64Character(code) {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 43 || code === 47 || code === 61 || code === 45 || code === 95;
}

function isBase64Whitespace(code) {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function scanDataUrls(text) {
  const ranges = [];
  const pattern = /data:(image\/(?:png|jpe?g|webp|gif))(?:;[a-z0-9._-]+=[^;,\s]+)*;base64,/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const dataStart = pattern.lastIndex;
    let end = dataStart;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (!isBase64Character(code) && !isBase64Whitespace(code)) break;
      end += 1;
    }
    const length = end - dataStart;
    if (length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error(`[NO-AUTO-RETRY] 响应中的单张文本图片超过 ${MAX_IMAGE_BASE64_CHARS} 字符安全上限`);
    }
    if (length > 0) ranges.push({ start: match.index, dataStart, end, mimeType: match[1], data: text.slice(dataStart, end) });
    pattern.lastIndex = Math.max(end, pattern.lastIndex);
  }
  return ranges;
}

function summarizeText(text, ranges, limit = MAX_TEXT_SUMMARY_CHARS) {
  const chunks = [];
  let used = 0;
  let cursor = 0;
  const append = (value) => {
    if (used >= limit) return;
    const fragment = value.slice(0, limit - used);
    chunks.push(fragment);
    used += fragment.length;
  };
  for (const range of ranges) {
    append(text.slice(cursor, range.start));
    append(`[图片 Base64 已省略：${range.end - range.dataStart} 字符]`);
    cursor = range.end;
    if (used >= limit) break;
  }
  if (used < limit) append(text.slice(cursor));
  return chunks.join("").trim();
}

function collectTextFallback(value, result, seen = new Set(), context = { image: false, key: "" }) {
  if (typeof value === "string") {
    const ranges = scanDataUrls(value);
    for (const range of ranges) {
      result.images.push({ type: "base64", data: range.data, mimeType: normalizeMime(range.mimeType), source: "text-data-url" });
    }
    for (const match of value.matchAll(/!\[[^\]\r\n]{0,512}\]\((https?:\/\/[^)\s]+)\)/gi)) {
      result.images.push({ type: "url", url: match[1], source: "text-url" });
    }
    if (context.image && (context.key === "url" || context.key === "content") && /^https?:\/\/\S+$/i.test(value)) {
      result.images.push({ type: "url", url: value, source: "chat-image-url" });
    }
    const summary = summarizeText(value, ranges);
    if (summary) result.text.push(summary);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const mimeHint = String(value.mime_type || value.mimeType || "");
  const imageContext = context.image
    || /image/i.test(String(value.type || ""))
    || /^image\//i.test(mimeHint)
    || Object.keys(value).some((key) => /image/i.test(key));
  for (const [key, child] of Object.entries(value)) {
    if ((key === "b64_json" || key === "base64" || key === "data") && imageContext && typeof child === "string") {
      if (child.length > MAX_IMAGE_BASE64_CHARS) {
        throw new Error(`[NO-AUTO-RETRY] 响应中的单张 Base64 图片超过 ${MAX_IMAGE_BASE64_CHARS} 字符安全上限`);
      }
      result.images.push({
        type: "base64",
        data: child,
        mimeType: normalizeMime(mimeHint),
        source: "chat-image-base64",
      });
    } else if (key !== "b64_json" && key !== "base64") {
      collectTextFallback(child, result, seen, { image: imageContext || /image/i.test(key), key: key.toLowerCase() });
    }
  }
}

function addStructuredImage(images, candidate) {
  if (!candidate || typeof candidate !== "object") return;
  const base64 = candidate.b64_json || candidate.base64 || candidate.image?.b64_json || candidate.image?.base64;
  const url = typeof candidate.url === "string" ? candidate.url : candidate.image?.url;
  const mimeType = candidate.mime_type || candidate.mimeType || candidate.image?.mime_type || candidate.image?.mimeType;
  if (typeof base64 === "string" && base64.length > 0) {
    if (base64.length > MAX_IMAGE_BASE64_CHARS) throw new Error(`[NO-AUTO-RETRY] 响应中的单张 Base64 图片超过 ${MAX_IMAGE_BASE64_CHARS} 字符安全上限`);
    images.push({ type: "base64", data: base64, mimeType: normalizeMime(mimeType), source: "images-b64_json" });
  } else if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    images.push({ type: "url", url, source: "images-url" });
  }
}

function imageFingerprint(image) {
  if (image.type === "url") return `url:${image.url}`;
  return `b64:${image.mimeType}:${image.data.length}:${image.data.slice(0, 96)}:${image.data.slice(-96)}`;
}

function uniqueImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    const fingerprint = imageFingerprint(image);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function parseChatCompletionsResponse(body) {
  const structured = [];
  const entries = Array.isArray(body?.data) ? body.data : [];
  for (const entry of entries) addStructuredImage(structured, entry);
  const structuredUnique = uniqueImages(structured);
  if (structuredUnique.length > 0) {
    return { images: structuredUnique, text: [], candidateCount: structuredUnique.length, discardedCount: 0 };
  }

  const fallback = { images: [], text: [] };
  const topLevelChoices = Array.isArray(body?.choices) ? body.choices : [];
  const listedChoices = Array.isArray(body?.data)
    ? body.data.flatMap((entry) => (Array.isArray(entry?.choices) ? entry.choices : []))
    : [];
  const seen = new Set();
  for (const choice of [...topLevelChoices, ...listedChoices]) {
    if (choice?.message) collectTextFallback(choice.message, fallback, seen, { image: true, key: "message" });
  }
  collectTextFallback(body, fallback, seen);
  const candidates = uniqueImages(fallback.images);
  const selected = candidates.length > 0 ? [candidates.at(-1)] : [];
  return {
    images: selected,
    text: [...new Set(fallback.text)],
    candidateCount: candidates.length,
    discardedCount: Math.max(0, candidates.length - selected.length),
  };
}

async function fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBuffer(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`[NO-AUTO-RETRY] 响应体 ${declared} 字节，超过 ${maxBytes} 字节安全上限`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`[NO-AUTO-RETRY] 响应体超过 ${maxBytes} 字节安全上限`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`[NO-AUTO-RETRY] 响应体超过 ${maxBytes} 字节安全上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function safeErrorMessage(body) {
  const direct = body?.error?.message || body?.message;
  const value = typeof direct === "string" ? direct : typeof body === "string" ? body : JSON.stringify(body || {});
  return summarizeText(value, scanDataUrls(value), 2000);
}

function parseApiError(status, body) {
  const message = safeErrorMessage(body);
  if (status === 401 || status === 403) {
    return `OpenAI Chat Completions 鉴权失败（HTTP ${status}）：请确认 Key 能调用所选 Gemini 图片模型。${message ? ` ${message}` : ""}`;
  }
  return `88API Chat Completions 请求失败（HTTP ${status}）：${message || "未知错误"}`;
}

function isNoAutoRetryError(error) {
  const message = String(error?.message || error || "");
  return message.startsWith("[NO-AUTO-RETRY]") || message.startsWith("[NO-RETRY]");
}

function networkErrorDetails(error) {
  const parts = [error?.message || String(error)];
  if (error?.code) parts.push(error.code);
  if (error?.cause?.code) parts.push(error.cause.code);
  if (error?.cause?.message) parts.push(error.cause.message);
  return [...new Set(parts.filter(Boolean))].join(" | ");
}

// 失败时在 error.stage 上标出请求走到了哪一步：not-sent（连接没建立，请求没发出）、
// submit（已发出但没收到响应，状态未知）、read-result（已收到响应头，读取响应体时失败）。
function postJsonOverHttps(url, body, apiKey, { timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, onResponse = null } = {}) {
  const payload = JSON.stringify(body);
  let connected = false;
  let httpStatus = 0;
  return new Promise((resolvePromise, rawReject) => {
    const rejectPromise = (error) => {
      const tagged = error instanceof Error ? error : new Error(String(error));
      tagged.stage ||= !connected ? "not-sent" : (httpStatus ? "read-result" : "submit");
      tagged.httpStatus ||= httpStatus || null;
      rawReject(tagged);
    };
    const request = httpsRequest(new URL(url), {
      method: "POST",
      agent: HTTPS_AGENT,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        accept: "application/json",
        "accept-encoding": "identity",
        connection: "keep-alive",
        "user-agent": `88api-nano-banana/${PLUGIN_VERSION}`,
      },
    }, (response) => {
      httpStatus = response.statusCode || 0;
      onResponse?.(httpStatus);
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error(`[NO-AUTO-RETRY] 响应体超过 ${maxBytes} 字节安全上限`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolvePromise({
        status: response.statusCode || 0,
        raw: Buffer.concat(chunks, total).toString("utf8"),
      }));
      response.on("aborted", () => rejectPromise(new Error("响应在完成前被服务器中断")));
      response.on("error", rejectPromise);
    });
    request.on("socket", (socket) => {
      // 复用的 keep-alive 连接已经握手完成；新连接要等 TLS 握手结束才算发得出去。
      if (!socket.connecting) connected = true;
      else socket.once("secureConnect", () => { connected = true; });
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      error.name = "AbortError";
      request.destroy(error);
    });
    request.on("error", rejectPromise);
    request.end(payload);
  });
}

function stageError(message, stage, cause, httpStatus = null) {
  const error = new Error(message, { cause });
  error.stage = stage;
  error.httpStatus = httpStatus;
  return error;
}

// 按请求走到的阶段报错：未发出（没有扣费）、提交后状态未知、已计费但读取失败。
function chatRequestStageError(error) {
  if (isNoAutoRetryError(error)) return error;
  const detail = networkErrorDetails(error);
  const status = error?.httpStatus || null;
  if (error?.stage === "not-sent") {
    return stageError(`88API 请求未发出（request was not sent）：连接不上 88API（${detail}），没有扣费，可以直接重新提交`, "not-sent", error);
  }
  if (error?.stage === "read-result" && status >= 200 && status < 300) {
    return stageError(`[NO-AUTO-RETRY] 请求已完成并计费，但读取结果失败（stage: read-result）：${detail}`, "read-result", error, status);
  }
  if (error?.stage === "read-result" && status) {
    return stageError(`88API Chat Completions 请求失败（HTTP ${status}），读取错误响应时中断：${detail}`, "rejected", error, status);
  }
  return stageError(`[NO-AUTO-RETRY] 请求已发出，状态未知（stage: submit）：${detail}`, "submit", error);
}

async function callChatCompletionsApi({ apiKey, body, onResponse = null }) {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    console.log(`[等待] 88API 正在处理，已用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒…`);
  }, REQUEST_HEARTBEAT_MS);
  heartbeat.unref();
  let response;
  try {
    response = await postJsonOverHttps(CHAT_COMPLETIONS_URL, body, apiKey, { onResponse });
  } catch (error) {
    throw chatRequestStageError(error);
  } finally {
    clearInterval(heartbeat);
  }

  const raw = response.raw;
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = raw;
  }
  if (response.status < 200 || response.status >= 300) throw stageError(parseApiError(response.status, parsed), "rejected", null, response.status);
  return parsed;
}

async function requestImage({ apiKey, options, references, onResponse = null }) {
  return callChatCompletionsApi({
    apiKey,
    body: buildChatCompletionsBody(options, references),
    onResponse,
  });
}

async function downloadImageOnce(url, apiKey) {
  const headers = {};
  if (new URL(url).origin === new URL(API_ROOT).origin) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchWithTimeout(url, { headers }, 2 * 60 * 1000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await readResponseBuffer(response);
  return { buffer, mimeType: normalizeMime(response.headers.get("content-type")) };
}

function saveResultLink(url, { outputDir, requestIndex }) {
  const resolvedDir = isAbsolute(outputDir) ? outputDir : resolve(outputDir);
  mkdirSync(resolvedDir, { recursive: true });
  const linkFile = join(resolvedDir, `nano-banana_${timestamp()}_${requestIndex}.pending-download.json`);
  writeFileSync(linkFile, `${JSON.stringify({ url, outputDir: resolvedDir, requestIndex, createdAt: new Date().toISOString() }, null, 2)}\n`);
  return linkFile;
}

// 结果是链接时：先把链接写到输出目录的 *.pending-download.json，再免费重试下载；
// 仍失败时保留该文件，图已生成并计费，可用 --retry-download 只下载、不发新的付费请求。
async function downloadImage(url, apiKey, linkContext = null) {
  try {
    new URL(url);
  } catch {
    throw new Error(`[NO-AUTO-RETRY] 返回了无效图片地址：${url}`);
  }
  const linkFile = linkContext ? saveResultLink(url, linkContext) : null;
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const downloaded = await downloadImageOnce(url, apiKey);
      if (linkFile) rmSync(linkFile, { force: true });
      return downloaded;
    } catch (error) {
      if (isNoAutoRetryError(error)) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        const waitMs = DOWNLOAD_BACKOFF_MS[attempt - 1];
        console.log(`[下载] 结果图下载失败（第 ${attempt} 次），${waitMs / 1000} 秒后免费重试：${networkErrorDetails(error)}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      }
    }
  }
  const saved = linkFile ? ` 结果链接已保存到 ${linkFile}，运行 --retry-download "${linkFile}" 可免费再下载一次（链接可能约 1 小时后失效）。` : "";
  throw stageError(`[NO-AUTO-RETRY] 图片已生成并计费，但下载失败（stage: download，已免费重试 ${DOWNLOAD_ATTEMPTS} 次）：${networkErrorDetails(lastError)}。${saved}`, "download", lastError);
}

async function retrySavedDownload(linkFile, apiKey) {
  if (!existsSync(linkFile)) throw new Error(`链接文件不存在：${linkFile}`);
  const link = JSON.parse(readFileSync(linkFile, "utf8"));
  if (!/^https?:/i.test(link?.url || "")) throw new Error(`链接文件里没有结果地址：${linkFile}`);
  const { buffer, mimeType } = await downloadImage(link.url, apiKey);
  if (!buffer.length) throw new Error("下载到的图片为空");
  const path = saveBuffer(buffer, mimeType, link.outputDir || DEFAULT_OUTPUT_DIR, 1, link.requestIndex || 1);
  rmSync(linkFile, { force: true });
  return path;
}

function timestamp() {
  const d = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

function detectMime(buffer, fallback = "image/png") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return normalizeMime(fallback);
}

function decodeBase64(data) {
  const normalized = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error("[NO-AUTO-RETRY] 接口返回了无效的 Base64 图片数据");
  return Buffer.from(normalized, "base64");
}

function saveBuffer(buffer, mimeType, outputDir, index, requestIndex) {
  const resolvedDir = isAbsolute(outputDir) ? outputDir : resolve(outputDir);
  mkdirSync(resolvedDir, { recursive: true });
  const detectedMime = detectMime(buffer, mimeType);
  const path = join(resolvedDir, `nano-banana_${timestamp()}_${requestIndex}-${index}.${extensionForMime(detectedMime)}`);
  writeFileSync(path, buffer);
  return path;
}

async function saveParsedImages(parsed, outputDir, apiKey, requestIndex) {
  const saved = [];
  const hashes = new Set();
  for (const image of parsed.images) {
    const downloaded = image.type === "url" ? await downloadImage(image.url, apiKey, { outputDir, requestIndex }) : null;
    const buffer = downloaded?.buffer || decodeBase64(image.data);
    const mimeType = downloaded?.mimeType || image.mimeType;
    if (!buffer.length) throw new Error("[NO-AUTO-RETRY] 接口返回了空的 Base64 图片");
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    saved.push(saveBuffer(buffer, mimeType, outputDir, saved.length + 1, requestIndex));
  }
  return saved;
}

// 提交记录：每次付费运行在 JOBS_DIR 下写一个 JSON 文件，每个请求发出前先记为 submitting。
// Agent 客户端因超时强行结束进程后，--job-status 仍能看出哪些请求可能已被受理并计费。
let activeJobRecord = null;

function writeJobRecord(record) {
  record.updatedAt = new Date().toISOString();
  try {
    atomicWriteJson(record.path, record);
  } catch (error) {
    if (!record.writeWarned) console.warn(`WARNING: 提交记录无法写入 ${record.path}：${error?.message || String(error)}`);
    record.writeWarned = true;
  }
}

function startJobRecord({ mode, model = null, outputDir = null }, jobsDir = JOBS_DIR) {
  const id = `${timestamp()}_${process.pid}`;
  const record = {
    id,
    path: join(jobsDir, `${id}.json`),
    version: PLUGIN_VERSION,
    pid: process.pid,
    mode,
    model,
    outputDir,
    startedAt: new Date().toISOString(),
    finished: false,
    exitCode: null,
    requests: [],
  };
  writeJobRecord(record);
  return record;
}

function jobRequestStart(fields) {
  const record = activeJobRecord;
  if (!record) return null;
  const prompt = String(fields.prompt || "");
  const entry = {
    index: record.requests.length + 1,
    state: "submitting",
    ...fields,
    prompt: prompt.length > 200 ? `${prompt.slice(0, 200)}...` : prompt,
    startedAt: new Date().toISOString(),
  };
  record.requests.push(entry);
  writeJobRecord(record);
  return entry;
}

function jobRequestResponded(entry, status) {
  if (!entry || !activeJobRecord) return;
  entry.state = "responded";
  entry.httpStatus = status;
  writeJobRecord(activeJobRecord);
}

// 按失败阶段判断计费：没发出、88API 返回错误不收费；发出后状态不明或已出图没保存下来，按可能已计费处理。
function jobRequestEnd(entry, { paths = null, error = null } = {}) {
  if (!entry || !activeJobRecord) return;
  if (paths) {
    entry.state = "saved";
    entry.path = paths[0] || null;
    entry.paths = paths;
  } else if (error?.stage === "not-sent") {
    entry.state = "not-sent";
  } else if (error?.stage === "submit" || entry.state === "submitting") {
    entry.state = "unknown";
  } else if (error?.stage === "rejected" || entry.httpStatus >= 400) {
    entry.state = "rejected";
  } else if (isNoAutoRetryError(error)) {
    entry.state = "billed-not-saved";
  } else {
    entry.state = "empty-result";
  }
  if (error) {
    entry.error = String(error?.message || error);
    entry.noAutoRetry = isNoAutoRetryError(error);
  }
  entry.endedAt = new Date().toISOString();
  writeJobRecord(activeJobRecord);
}

function finishJobRecord(exitCode) {
  const record = activeJobRecord;
  if (!record || record.finished) return;
  record.finished = true;
  record.exitCode = exitCode;
  record.endedAt = new Date().toISOString();
  if (record.requests.length === 0) {
    rmSync(record.path, { force: true });
    return;
  }
  writeJobRecord(record);
}

function processIsAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const JOB_STATE_MEANING = {
  saved: "已出图并保存（已计费）",
  "not-sent": "未发出，没有费用",
  rejected: "88API 返回错误，未出图",
  unknown: "[NO-AUTO-RETRY] 已发出、状态未知，可能已计费",
  "billed-not-saved": "[NO-AUTO-RETRY] 已出图并计费，但结果没保存下来",
  "empty-result": "88API 返回成功但没有可保存的图片，是否计费以 88API 使用日志为准",
  interrupted: "[NO-AUTO-RETRY] 发出后进程被中断，状态未知，可能已计费",
  running: "仍在进行中，请等待，不要重发",
};

// 记录里停在 submitting / responded 的请求：进程还活着就是仍在进行，进程已不在就是发出后被中断。
function summarizeJobRecord(record, { alive = processIsAlive(record?.pid) } = {}) {
  const running = !record.finished && alive;
  const requests = (record.requests || []).map((entry) => {
    let state = entry.state;
    if (state === "submitting" || state === "responded") state = running ? "running" : "interrupted";
    return { ...entry, state, meaning: JOB_STATE_MEANING[state] || state, mayBeBilled: ["saved", "unknown", "billed-not-saved", "empty-result", "interrupted", "running"].includes(state) };
  });
  const count = (state) => requests.filter((entry) => entry.state === state).length;
  return {
    type: "88api-image-job",
    id: record.id,
    path: record.path,
    status: running ? "running" : (record.finished ? "finished" : "interrupted"),
    mode: record.mode,
    model: record.model,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    exitCode: record.exitCode,
    requestsSent: requests.filter((entry) => entry.state !== "not-sent").length,
    saved: count("saved"),
    notSent: count("not-sent"),
    rejected: count("rejected"),
    emptyResult: count("empty-result"),
    unknown: count("unknown") + count("interrupted"),
    billedNotSaved: count("billed-not-saved"),
    running: count("running"),
    noAutoRetry: requests.some((entry) => ["unknown", "interrupted", "billed-not-saved"].includes(entry.state)),
    images: requests.filter((entry) => entry.state === "saved").flatMap((entry) => (entry.paths || [entry.path]).map((path) => ({ path, dimensions: null }))),
    requests,
  };
}

function readJobRecord(path) {
  return { ...JSON.parse(readFileSync(path, "utf8")), path };
}

function listJobRecordPaths(jobsDir = JOBS_DIR) {
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()
    .map((name) => join(jobsDir, name));
}

function resolveJobRecordPath(value, jobsDir = JOBS_DIR) {
  if (existsSync(value)) return value;
  const byId = join(jobsDir, `${value.replace(/\.json$/i, "")}.json`);
  if (existsSync(byId)) return byId;
  throw new Error(`找不到提交记录：${value}`);
}

function printHelp() {
  console.log(`88API-Nano-Banana ${PLUGIN_VERSION}\n\n协议：OpenAI Chat Completions（唯一协议）\n请求：POST ${CHAT_COMPLETIONS_URL}\n默认模型：${DEFAULT_MODEL}\n\n配置：\n  --get-config\n  --config-path\n  --set-key <KEY>\n  --set-model <MODEL>\n  --list-models\n\n生图或编辑：\n  --prompt <TEXT> [--model MODEL] [--image PATH ...] [--aspect RATIO] [--resolution 1K|2K|4K] [--count 1..${MAX_IMAGES}] [--output-dir DIR]\n  --batch <PROMPTS.json> [--model MODEL] [--image PATH ...] [--aspect RATIO] [--resolution 1K|2K|4K]\n  --batch-inline <PROMPT_1> <PROMPT_2> ... (最多 ${MAX_BATCH_PROMPTS} 条，顺序执行)\n\n验证：\n  --dry-run\n  --self-test\n\n工具（不发付费请求）：\n  --job-status [任务号|记录文件]   查看付费运行里每个请求的实际状态；不带参数列出最近几次\n  --retry-download <链接文件>      免费重新下载已生成并计费的结果图\n  --json                          付费运行结束时输出一行机器可读结果\n\n配置文件：${CONFIG_PATH}（API88_CONFIG_DIR 可改目录；API88_KEY 优先于已保存的 Key）\n提交记录：${JOBS_DIR}`);
}

// 旧配置迁移与同步、Key 优先级、分阶段报错、提交记录各状态和进程中断识别；全部在临时目录里进行。
function runConfigJobChecks() {
  const root = join(tmpdir(), `88api-nano-banana-config-job-test-${process.pid}-${Date.now()}`);
  const newPath = join(root, "new", "nano-banana.json");
  const legacyPath = join(root, "legacy", "88api-nano-banana-config.json");
  const jobsDir = join(root, "jobs");
  const checks = {};
  const previousRecord = activeJobRecord;
  try {
    atomicWriteJson(legacyPath, { apiKey: "sk-test-legacy-key", model: "gemini-3-pro-image" });
    const migrated = loadConfig(newPath, { legacyPaths: [legacyPath] });
    checks.migratedFromLegacy = existsSync(newPath) && existsSync(legacyPath)
      && migrated.apiKey === "sk-test-legacy-key" && migrated.model === "gemini-3-pro-image"
      && loadedConfigSource === legacyPath;
    saveConfig({ ...migrated, apiKey: "sk-test-new-key" }, newPath, [legacyPath]);
    checks.legacyMirrored = JSON.parse(readFileSync(legacyPath, "utf8")).apiKey === "sk-test-new-key"
      && loadConfig(newPath, { legacyPaths: [legacyPath] }).apiKey === "sk-test-new-key"
      && loadedConfigSource === newPath;
    checks.keyPriority = resolveApiKey({ apiKey: "sk-test-config" }, "sk-test-environment").key === "sk-test-environment"
      && resolveApiKey({ apiKey: "sk-test-config" }, "").key === "sk-test-config"
      && !JSON.stringify(configSummary({ apiKey: "" }, { envKey: "sk-test-environment-key" })).includes("sk-test-environment-key");

    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", stage: "not-sent" });
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET", stage: "submit" });
    const cut = Object.assign(new Error("响应在完成前被服务器中断"), { stage: "read-result", httpStatus: 200 });
    const notSent = chatRequestStageError(refused);
    const unknown = chatRequestStageError(reset);
    const billed = chatRequestStageError(cut);
    checks.stageMessages = !isNoAutoRetryError(notSent) && notSent.message.includes("request was not sent") && notSent.stage === "not-sent"
      && isNoAutoRetryError(unknown) && unknown.message.includes("stage: submit")
      && isNoAutoRetryError(billed) && billed.message.includes("stage: read-result");

    activeJobRecord = startJobRecord({ mode: "self-test", model: DEFAULT_MODEL }, jobsDir);
    const saved = jobRequestStart({ kind: "generation", prompt: "a" });
    jobRequestResponded(saved, 200);
    jobRequestEnd(saved, { paths: [join(root, "a.png"), join(root, "b.png")] });
    jobRequestEnd(jobRequestStart({ kind: "generation", prompt: "b" }), { error: notSent });
    const rejected = jobRequestStart({ kind: "generation", prompt: "c" });
    jobRequestResponded(rejected, 401);
    jobRequestEnd(rejected, { error: stageError("88API Chat Completions 请求失败（HTTP 401）", "rejected", null, 401) });
    jobRequestEnd(jobRequestStart({ kind: "edit", prompt: "d" }), { error: unknown });
    const lost = jobRequestStart({ kind: "generation", prompt: "e" });
    jobRequestResponded(lost, 200);
    jobRequestEnd(lost, { error: billed });
    jobRequestStart({ kind: "generation", prompt: "f" });
    const killed = summarizeJobRecord(readJobRecord(activeJobRecord.path), { alive: false });
    checks.interruptedStates = killed.status === "interrupted"
      && killed.requests.map((entry) => entry.state).join(",") === "saved,not-sent,rejected,unknown,billed-not-saved,interrupted"
      && killed.saved === 1 && killed.images.length === 2 && killed.notSent === 1 && killed.rejected === 1
      && killed.unknown === 2 && killed.billedNotSaved === 1 && killed.noAutoRetry === true
      && killed.requests[1].mayBeBilled === false && killed.requests[5].mayBeBilled === true;
    checks.runningWhileAlive = summarizeJobRecord(readJobRecord(activeJobRecord.path), { alive: true }).requests[5].state === "running";
    checks.resolveById = resolveJobRecordPath(activeJobRecord.id, jobsDir) === activeJobRecord.path
      && listJobRecordPaths(jobsDir)[0] === activeJobRecord.path;
    finishJobRecord(0);
    activeJobRecord = startJobRecord({ mode: "self-test-empty" }, jobsDir);
    const emptyPath = activeJobRecord.path;
    finishJobRecord(1);
    checks.emptyRecordRemoved = !existsSync(emptyPath);
  } finally {
    activeJobRecord = previousRecord;
    rmSync(root, { recursive: true, force: true });
  }
  if (!Object.values(checks).every(Boolean) || Object.keys(checks).length !== 8) {
    throw new Error(`配置 / 提交记录自测失败：${JSON.stringify(checks)}`);
  }
}

// 真实套接字：连接被拒绝时请求根本没发出，必须报 not-sent（不扣费），而不是状态未知。
async function runRefusedConnectionCheck() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  let error = null;
  try {
    await postJsonOverHttps(`https://127.0.0.1:${port}/v1/chat/completions`, {}, "sk-test", { timeoutMs: 5_000 });
  } catch (caught) {
    error = chatRequestStageError(caught);
  }
  if (error?.stage !== "not-sent" || isNoAutoRetryError(error)) {
    throw new Error(`连接被拒绝的自测失败：${error?.stage} ${error?.message}`);
  }
}

async function runSelfTest() {
  runConfigJobChecks();
  await runRefusedConnectionCheck();
  const fakePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZkAAAAASUVORK5CYII=";
  const fakeGif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const options = { model: DEFAULT_MODEL, prompt: "测试", aspect: "16:9", resolution: "4K" };
  const generation = buildChatCompletionsBody(options, []);
  const reference = {
    name: "reference.png",
    mimeType: "image/png",
    data: Buffer.from(fakePng, "base64"),
    bytes: Buffer.from(fakePng, "base64").length,
  };
  const edit = buildChatCompletionsBody(options, [reference]);
  const structured = parseChatCompletionsResponse({ data: [{ b64_json: fakePng }] });
  const chatImage = parseChatCompletionsResponse({
    choices: [{ message: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${fakePng}` } }] } }],
  });
  const inlineImage = parseChatCompletionsResponse({
    choices: [{ message: { content: [{ inline_data: { mime_type: "image/png", data: fakePng } }] } }],
  });
  const directUrlImage = parseChatCompletionsResponse({
    choices: [{ message: { content: "https://example.com/final.png" } }],
  });
  const fallback = parseChatCompletionsResponse({ choices: [{ message: { content: `![draft](data:image/png;base64,${fakePng})\n![final](data:image/gif;base64,${fakeGif})` } }] });
  const longBase64 = "A".repeat(1_250_000);
  const longText = parseChatCompletionsResponse({ choices: [{ message: { content: `data:image/jpeg;base64,${longBase64}` } }] });
  const retryPolicyOk = isNoAutoRetryError("[NO-AUTO-RETRY] 当前请求状态未知")
    && isNoAutoRetryError("[NO-RETRY] 旧版请求状态未知")
    && !isNoAutoRetryError("fetch failed");
  const inlineBatch = parseArgs(["--batch-inline", "第一张", "第二张", "--aspect", "16:9"]);
  const batchModeOk = inlineBatch.batchInline?.join(",") === "第一张,第二张"
    && inlineBatch.aspect === "16:9"
    && resolvePromptList({ prompt: "重复", count: 2 }).join(",") === "重复,重复";
  const tempConfig = join(tmpdir(), `88api-nano-banana-self-test-${process.pid}-${Date.now()}.json`);
  const tempBatch = join(tmpdir(), `88api-nano-banana-batch-self-test-${process.pid}-${Date.now()}.json`);
  try {
    atomicWriteJson(tempBatch, ["文件第一张", "文件第二张"]);
    atomicWriteJson(tempConfig, {
      apiKey: "", baseURL: API_ROOT, protocol: "legacy", model: "gemini-3-pro-image", maxTokens: 8192, outputDir: "",
    });
    const legacyConfig = loadConfig(tempConfig);
    saveConfig(legacyConfig, tempConfig);
    const persisted = JSON.parse(readFileSync(tempConfig, "utf8"));
    const imageConfig = generation.extra_body?.google?.image_config;
    const editContent = edit.messages?.[0]?.content;
    const ok = generation.messages?.[0]?.role === "user"
      && typeof generation.messages?.[0]?.content === "string"
      && generation.modalities?.join(",") === "text,image"
      && imageConfig?.aspect_ratio === "16:9"
      && imageConfig?.image_size === "4K"
      && Array.isArray(editContent)
      && editContent[0]?.type === "text"
      && editContent[1]?.type === "image_url"
      && editContent[1]?.image_url?.url.startsWith("data:image/png;base64,")
      && !Object.hasOwn(generation, "size")
      && !Object.hasOwn(generation, "n")
      && structured.images.length === 1
      && structured.images[0].source === "images-b64_json"
      && chatImage.images.length === 1
      && chatImage.images[0].mimeType === "image/png"
      && inlineImage.images.length === 1
      && inlineImage.images[0].source === "chat-image-base64"
      && directUrlImage.images.length === 1
      && retryPolicyOk
      && directUrlImage.images[0].source === "chat-image-url"
      && batchModeOk
      && resolvePromptList({ batchFile: tempBatch }).join(",") === "文件第一张,文件第二张"
      && fallback.images.length === 1
      && fallback.images[0].mimeType === "image/gif"
      && fallback.discardedCount === 1
      && longText.images.length === 1
      && longText.images[0].data.length === longBase64.length
      && longText.text.every((text) => text.length <= MAX_TEXT_SUMMARY_CHARS)
      && !Object.hasOwn(persisted, "protocol")
      && !Object.hasOwn(persisted, "maxTokens")
      && persisted.model === "gemini-3-pro-image"
      && MODEL_INFO.length === 2
      && MODEL_INFO.find(({ default: isDefault }) => isDefault)?.id === DEFAULT_MODEL
      && MODELS.has("gemini-3.1-flash-image")
      && MODELS.has("gemini-3-pro-image")
      && CHAT_COMPLETIONS_URL === "https://88api.ai/v1/chat/completions";
    if (!ok) throw new Error("自测断言失败");
  } finally {
    rmSync(tempConfig, { force: true });
    rmSync(tempBatch, { force: true });
  }
  console.log(JSON.stringify({
    ChatCompletions生成请求: "通过",
    ChatCompletions参考图请求: "通过",
    图像参数映射: "通过（aspect_ratio / image_size）",
    双模型目录: "通过（默认 Flash，可选 Pro）",
    Chat图片字段解析: "通过",
    长任务传输策略: "通过（原始 HTTPS / identity 编码 / 15 秒心跳）",
    用户明确授权后可重新提交: "通过（仅禁止自动重试）",
    单进程批量提示词: "通过（batch / batch-inline 顺序调度）",
    GeminiInlineData解析: "通过",
    标准b64_json解析: "通过",
    超长文本图片解析: "通过（1,250,000 Base64 字符）",
    旧配置迁移: "通过（已删除旧协议字段）",
    客户端无关配置: "通过（~/.88api 新路径、旧 ~/.codex 配置复制与同步、API88_KEY 优先）",
    分阶段报错: "通过（未发出 / stage: submit / stage: read-result；真实拒绝连接判为未发出）",
    提交记录: "通过（各请求状态、进程中断识别、--job-status 查询）",
    付费API调用: "未执行",
  }, null, 2));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  // 写到 stderr，不影响 --json 等机器可读输出。
  console.error(DISCONTINUED_NOTICE);
  if (flags.help || process.argv.length === 2) return printHelp();
  if (flags.selfTest) return runSelfTest();
  if (flags.configPath) return console.log(CONFIG_PATH);
  if (flags.listModels) return console.log(JSON.stringify(MODEL_INFO, null, 2));
  if (flags.jobStatus) {
    if (flags.jobStatus === true) {
      const recent = listJobRecordPaths().slice(0, JOB_LIST_LIMIT).map((path) => {
        const { requests, ...summary } = summarizeJobRecord(readJobRecord(path));
        return summary;
      });
      return console.log(JSON.stringify({ jobsDir: JOBS_DIR, recent }, null, 2));
    }
    return console.log(JSON.stringify(summarizeJobRecord(readJobRecord(resolveJobRecordPath(flags.jobStatus))), null, 2));
  }

  const config = loadConfig(CONFIG_PATH, { create: flags.getConfig === true });
  if (flags.getConfig) return console.log(JSON.stringify(configSummary(config), null, 2));

  if (flags.retryDownload) {
    const path = await retrySavedDownload(flags.retryDownload, resolveApiKey(config).key);
    return console.log(`图片已保存：${path}`);
  }

  if (flags.setKey) {
    const key = flags.setKey.trim();
    if (key.length < 10) throw new Error("Key 格式异常：长度过短");
    saveConfig({ ...config, apiKey: key });
    console.log(`88API Gemini 图片 Key 已保存：${maskKey(key)}`);
    console.log(`配置文件：${CONFIG_PATH}`);
    return;
  }

  if (flags.setModel) {
    const model = validateModel(flags.setModel);
    saveConfig({ ...config, model });
    console.log(`默认模型已保存：${model}`);
    console.log(`配置文件：${CONFIG_PATH}`);
    return;
  }

  const prompts = resolvePromptList(flags);
  const model = validateModel(flags.model || config.model || DEFAULT_MODEL);
  const aspect = validateAspect(flags.aspect || "1:1");
  const resolution = validateResolution(flags.resolution || "1K", model);
  const references = loadReferenceImages(flags.images);
  const endpoint = CHAT_COMPLETIONS_URL;

  if (flags.dryRun) {
    console.log(JSON.stringify({
      method: "POST",
      protocol: "OpenAI Chat Completions",
      url: endpoint,
      headers: { authorization: "Bearer <已隐藏>", "content-type": "application/json" },
      tasks: prompts.map((prompt, index) => ({
        index: index + 1,
        body: buildChatCompletionsBody({ model, prompt, aspect, resolution }, references, { redactImageData: true }),
      })),
      referenceImages: references.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
      paidRequests: prompts.length,
    }, null, 2));
    return;
  }

  const apiKey = resolveApiKey(config).key;
  if (!apiKey) throw new Error(`尚未配置 Key。请把 88API Key 发给 Agent，由 Agent 为你一键保存和验证（不需要自己运行命令），或设置环境变量 API88_KEY。配置文件：${CONFIG_PATH}`);
  const outputDir = flags.outputDir || config.outputDir || DEFAULT_OUTPUT_DIR;
  activeJobRecord = startJobRecord({ mode: prompts.length > 1 ? "batch" : (references.length ? "edit" : "generation"), model, outputDir });
  console.log(`提交记录：${activeJobRecord.path}（如果本次运行被中断，用 --job-status ${activeJobRecord.id} 查看状态，不要直接重发）`);
  process.on("exit", (code) => {
    finishJobRecord(code);
    if (flags.json) {
      try {
        writeSync(1, `${JSON.stringify(summarizeJobRecord(activeJobRecord, { alive: false }))}\n`);
      } catch {
        // stdout 已关闭时，结果仍在磁盘上的提交记录里。
      }
    }
  });
  const allSaved = [];
  let discardedImages = 0;
  for (let requestIndex = 1; requestIndex <= prompts.length; requestIndex += 1) {
    const options = { model, prompt: prompts[requestIndex - 1], aspect, resolution };
    console.log(`[${requestIndex}/${prompts.length}] 正在向 88API 提交图片请求`);
    const job = jobRequestStart({ kind: references.length ? "edit" : "generation", model, aspect, resolution, prompt: options.prompt, references: references.map(({ path }) => path) });
    let saved;
    try {
      const responseBody = await requestImage({ apiKey, options, references, onResponse: (status) => jobRequestResponded(job, status) });
      const parsed = parseChatCompletionsResponse(responseBody);
      discardedImages += parsed.discardedCount;
      if (!parsed.images.length) {
        const responseText = parsed.text.join("\n").slice(0, 2000);
        throw new Error(`[NO-AUTO-RETRY] 请求已成功完成，但响应中没有可保存的图片。${responseText ? ` 返回文本：${responseText}` : ""}`);
      }
      saved = await saveParsedImages(parsed, outputDir, apiKey, requestIndex);
      if (!saved.length) throw new Error("[NO-AUTO-RETRY] 请求已成功完成，但所有返回图片均为空或重复");
    } catch (error) {
      jobRequestEnd(job, { error });
      if (allSaved.length) console.error(`本次运行中已保存的图片：\n${allSaved.join("\n")}`);
      if (requestIndex < prompts.length) console.error(`剩余 ${prompts.length - requestIndex} 个提示词未提交，没有费用。`);
      throw error;
    }
    jobRequestEnd(job, { paths: saved });
    allSaved.push(...saved);
    for (const path of saved) console.log(`图片已保存：${path}`);
    console.log(`[${requestIndex}/${prompts.length}] 已完成`);
  }
  console.log(JSON.stringify({
    model,
    protocol: "OpenAI Chat Completions",
    endpoint,
    requestedAspect: aspect,
    requestedResolution: resolution,
    requests: prompts.length,
    count: allSaved.length,
    discardedImages,
    files: allSaved,
  }, null, 2));
}

main().catch((error) => {
  const message = error?.message || String(error);
  console.error(`ERROR: ${message}`);
  if (isNoAutoRetryError(error)) {
    console.error("提示：本次执行不会自动重发。上一次请求可能仍会计费；用户明确要求“重试/重新生成/再试一次”后，可作为一次新的付费请求提交。");
  }
  process.exitCode = 1;
});
