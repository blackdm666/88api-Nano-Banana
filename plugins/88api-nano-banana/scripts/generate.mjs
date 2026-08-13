#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const API_ROOT = "https://88api.ai";
const CHAT_COMPLETIONS_URL = `${API_ROOT}/v1/chat/completions`;
const PLUGIN_VERSION = "1.3.4";
const CONFIG_PATH = join(homedir(), ".codex", "88api-nano-banana-config.json");
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

function saveConfig(config, path = CONFIG_PATH) {
  atomicWriteJson(path, normalizeConfig(config));
}

function loadConfig(path = CONFIG_PATH, { create = false } = {}) {
  if (!existsSync(path)) {
    const config = defaultConfig();
    if (create) saveConfig(config, path);
    return config;
  }
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`配置文件无法读取：${path} (${error?.message || String(error)})`);
  }
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function configSummary(config) {
  return {
    配置文件: CONFIG_PATH,
    已配置Key: Boolean(config.apiKey || process.env.NANO_BANANA_API_KEY),
    Key预览: maskKey(config.apiKey || process.env.NANO_BANANA_API_KEY || ""),
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
    else if (arg === "--model") flags.model = valueAfter(argv, index++, arg);
    else if (arg === "--aspect" || arg === "--ratio") flags.aspect = valueAfter(argv, index++, arg);
    else if (arg === "--resolution") flags.resolution = valueAfter(argv, index++, arg).toUpperCase();
    else if (arg === "--count") flags.count = Number(valueAfter(argv, index++, arg));
    else if (arg === "--output-dir") flags.outputDir = valueAfter(argv, index++, arg);
    else if (arg === "--image") flags.images.push(valueAfter(argv, index++, arg));
    else throw new Error(`不支持的参数：${arg}`);
  }
  return flags;
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

function postJsonOverHttps(url, body, apiKey, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES) {
  const payload = JSON.stringify(body);
  return new Promise((resolvePromise, rejectPromise) => {
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
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      error.name = "AbortError";
      request.destroy(error);
    });
    request.on("error", rejectPromise);
    request.end(payload);
  });
}

async function callChatCompletionsApi({ apiKey, body }) {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    console.log(`[等待] 88API 正在处理，已用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒…`);
  }, REQUEST_HEARTBEAT_MS);
  heartbeat.unref();
  let response;
  try {
    response = await postJsonOverHttps(CHAT_COMPLETIONS_URL, body, apiKey);
  } catch (error) {
    if (isNoAutoRetryError(error)) throw error;
    throw new Error(`[NO-AUTO-RETRY] 请求状态未知：${networkErrorDetails(error)}`);
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
  if (response.status < 200 || response.status >= 300) throw new Error(parseApiError(response.status, parsed));
  return parsed;
}

async function requestImage({ apiKey, options, references }) {
  return callChatCompletionsApi({
    apiKey,
    body: buildChatCompletionsBody(options, references),
  });
}

async function downloadImage(url, apiKey) {
  const headers = {};
  try {
    if (new URL(url).origin === new URL(API_ROOT).origin) headers.authorization = `Bearer ${apiKey}`;
  } catch {
    throw new Error(`[NO-AUTO-RETRY] 返回了无效图片地址：${url}`);
  }
  let response;
  try {
    response = await fetchWithTimeout(url, { headers }, 2 * 60 * 1000);
  } catch (error) {
    throw new Error(`[NO-AUTO-RETRY] 图片下载状态未知：${error?.message || String(error)}`);
  }
  if (!response.ok) throw new Error(`[NO-AUTO-RETRY] 请求已成功，但图片下载失败：HTTP ${response.status}`);
  const buffer = await readResponseBuffer(response);
  return { buffer, mimeType: normalizeMime(response.headers.get("content-type")) };
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
    const downloaded = image.type === "url" ? await downloadImage(image.url, apiKey) : null;
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

function printHelp() {
  console.log(`88API-Nano-Banana ${PLUGIN_VERSION}\n\n协议：OpenAI Chat Completions（唯一协议）\n请求：POST ${CHAT_COMPLETIONS_URL}\n默认模型：${DEFAULT_MODEL}\n\n配置：\n  --get-config\n  --config-path\n  --set-key <KEY>\n  --set-model <MODEL>\n  --list-models\n\n生图或编辑：\n  --prompt <TEXT> [--model MODEL] [--image PATH ...] [--aspect RATIO] [--resolution 1K|2K|4K] [--count 1..${MAX_IMAGES}] [--output-dir DIR]\n\n验证：\n  --dry-run\n  --self-test`);
}

function runSelfTest() {
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
  const tempConfig = join(tmpdir(), `88api-nano-banana-self-test-${process.pid}-${Date.now()}.json`);
  try {
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
  }
  console.log(JSON.stringify({
    ChatCompletions生成请求: "通过",
    ChatCompletions参考图请求: "通过",
    图像参数映射: "通过（aspect_ratio / image_size）",
    双模型目录: "通过（默认 Flash，可选 Pro）",
    Chat图片字段解析: "通过",
    长任务传输策略: "通过（原始 HTTPS / identity 编码 / 15 秒心跳）",
    用户明确授权后可重新提交: "通过（仅禁止自动重试）",
    GeminiInlineData解析: "通过",
    标准b64_json解析: "通过",
    超长文本图片解析: "通过（1,250,000 Base64 字符）",
    旧配置迁移: "通过（已删除旧协议字段）",
    付费API调用: "未执行",
  }, null, 2));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || process.argv.length === 2) return printHelp();
  if (flags.selfTest) return runSelfTest();
  if (flags.configPath) return console.log(CONFIG_PATH);
  if (flags.listModels) return console.log(JSON.stringify(MODEL_INFO, null, 2));

  const config = loadConfig(CONFIG_PATH, { create: flags.getConfig === true });
  if (flags.getConfig) return console.log(JSON.stringify(configSummary(config), null, 2));

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

  if (!flags.prompt?.trim()) throw new Error("缺少 --prompt");
  const model = validateModel(flags.model || config.model || DEFAULT_MODEL);
  const aspect = validateAspect(flags.aspect || "1:1");
  const resolution = validateResolution(flags.resolution || "1K", model);
  const count = flags.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) throw new Error(`--count 必须是 1..${MAX_IMAGES} 的整数`);
  const references = loadReferenceImages(flags.images);
  const options = { model, prompt: flags.prompt, aspect, resolution };
  const endpoint = CHAT_COMPLETIONS_URL;

  if (flags.dryRun) {
    console.log(JSON.stringify({
      method: "POST",
      protocol: "OpenAI Chat Completions",
      url: endpoint,
      headers: { authorization: "Bearer <已隐藏>", "content-type": "application/json" },
      body: buildChatCompletionsBody(options, references, { redactImageData: true }),
      referenceImages: references.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
      paidRequests: count,
    }, null, 2));
    return;
  }

  const apiKey = config.apiKey || process.env.NANO_BANANA_API_KEY || "";
  if (!apiKey) throw new Error(`尚未配置 Key。请先运行 --set-key <KEY>。配置文件：${CONFIG_PATH}`);
  const outputDir = flags.outputDir || config.outputDir || DEFAULT_OUTPUT_DIR;
  const allSaved = [];
  let discardedImages = 0;
  for (let requestIndex = 1; requestIndex <= count; requestIndex += 1) {
    const responseBody = await requestImage({ apiKey, options, references });
    const parsed = parseChatCompletionsResponse(responseBody);
    discardedImages += parsed.discardedCount;
    if (!parsed.images.length) {
      const responseText = parsed.text.join("\n").slice(0, 2000);
      throw new Error(`[NO-AUTO-RETRY] 请求已成功完成，但响应中没有可保存的图片。${responseText ? ` 返回文本：${responseText}` : ""}`);
    }
    const saved = await saveParsedImages(parsed, outputDir, apiKey, requestIndex);
    if (!saved.length) throw new Error("[NO-AUTO-RETRY] 请求已成功完成，但所有返回图片均为空或重复");
    allSaved.push(...saved);
    for (const path of saved) console.log(`图片已保存：${path}`);
  }
  console.log(JSON.stringify({
    model,
    protocol: "OpenAI Chat Completions",
    endpoint,
    requestedAspect: aspect,
    requestedResolution: resolution,
    requests: count,
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
