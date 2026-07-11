#!/usr/bin/env node

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
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const API_ROOT = "https://88api.ai";
const MESSAGES_URL = `${API_ROOT}/v1/messages`;
const ANTHROPIC_VERSION = "2023-06-01";
const CONFIG_PATH = join(homedir(), ".codex", "88api-nano-banana-config.json");
const DEFAULT_OUTPUT_DIR = join(homedir(), "Pictures", "88api-nano-banana");
const DEFAULT_MODEL = "gemini-3.1-flash-image";
const MODELS = new Set(["gemini-3-pro-image", "gemini-3.1-flash-image"]);
const ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const RESOLUTIONS = new Set(["512", "1K", "2K", "4K"]);
const MAX_IMAGES = 4;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function defaultConfig() {
  return {
    apiKey: "",
    baseURL: API_ROOT,
    model: DEFAULT_MODEL,
    maxTokens: 8192,
    outputDir: "",
  };
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const model = MODELS.has(source.model) ? source.model : DEFAULT_MODEL;
  const maxTokens = Number.isInteger(source.maxTokens) && source.maxTokens >= 1024 && source.maxTokens <= 32768
    ? source.maxTokens
    : 8192;
  return {
    apiKey: typeof source.apiKey === "string" ? source.apiKey.trim() : "",
    baseURL: API_ROOT,
    model,
    maxTokens,
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
    协议: "Anthropic Messages",
    模型: config.model,
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
  if (resolution === "512" && model !== "gemini-3.1-flash-image") {
    throw new Error("512 分辨率仅允许 gemini-3.1-flash-image");
  }
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
    return {
      path,
      name: basename(path),
      mimeType: mimeFromPath(path),
      data: data.toString("base64"),
      bytes: data.length,
    };
  });
}

function enhancedPrompt(prompt, aspect, resolution, hasReferences) {
  const lines = [prompt.trim()];
  lines.push(hasReferences
    ? "Use the supplied reference image(s) as visual input and perform the requested edit."
    : "Generate the requested image directly.");
  lines.push(`Target aspect ratio: ${aspect}. Target image resolution: ${resolution}.`);
  lines.push("Return the final image as an image content block. Do not return only a textual description.");
  return lines.join("\n\n");
}

function buildRequest({ model, prompt, aspect, resolution, references, maxTokens }) {
  const content = references.map((reference) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: reference.mimeType,
      data: reference.data,
    },
  }));
  content.push({
    type: "text",
    text: enhancedPrompt(prompt, aspect, resolution, references.length > 0),
  });
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
}

function sanitizedRequest(body, references) {
  const clone = structuredClone(body);
  const items = clone.messages?.[0]?.content || [];
  let imageIndex = 0;
  for (const item of items) {
    if (item?.type === "image" && item?.source?.data) {
      const reference = references[imageIndex++];
      item.source.data = `<省略 ${reference?.bytes || 0} 字节 Base64：${reference?.name || "image"}>`;
    }
  }
  return clone;
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

function addImage(result, candidate) {
  if (!candidate) return;
  if (candidate.data && typeof candidate.data === "string") {
    result.images.push({ type: "base64", data: candidate.data, mimeType: normalizeMime(candidate.mimeType) });
  } else if (candidate.url && typeof candidate.url === "string") {
    result.images.push({ type: "url", url: candidate.url });
  }
}

function parseTextImages(text, result) {
  if (typeof text !== "string" || !text.trim()) return;
  const dataUrlPattern = /data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)/gi;
  for (const match of text.matchAll(dataUrlPattern)) {
    addImage(result, { data: match[2].replace(/\s+/g, ""), mimeType: match[1] });
  }
  const markdownPattern = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  for (const match of text.matchAll(markdownPattern)) addImage(result, { url: match[1] });
  const safeText = text
    .replace(/data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+/gi, "[图片 Base64 已省略]")
    .trim();
  if (safeText) result.text.push(safeText.slice(0, 4000));
}

function walkResponse(value, result, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkResponse(item, result, seen);
    return;
  }

  if (value.type === "text" && typeof value.text === "string") parseTextImages(value.text, result);
  if (value.type === "image") {
    const source = value.source || value;
    if (source.type === "base64" || source.data) {
      addImage(result, { data: source.data, mimeType: source.media_type || source.mime_type || value.media_type });
    } else if (source.type === "url" || source.url) {
      addImage(result, { url: source.url });
    }
  }
  if (typeof value.b64_json === "string") addImage(result, { data: value.b64_json, mimeType: value.mime_type });
  if (typeof value.base64 === "string") addImage(result, { data: value.base64, mimeType: value.mime_type });
  if (value.inlineData?.data) addImage(result, { data: value.inlineData.data, mimeType: value.inlineData.mimeType });
  if (value.inline_data?.data) addImage(result, { data: value.inline_data.data, mimeType: value.inline_data.mime_type });
  if (value.output_image?.data) addImage(result, { data: value.output_image.data, mimeType: value.output_image.mime_type });

  for (const child of Object.values(value)) walkResponse(child, result, seen);
}

function parseResponse(body) {
  const result = { images: [], text: [] };
  walkResponse(body, result);
  const unique = [];
  const fingerprints = new Set();
  for (const image of result.images) {
    const fingerprint = image.type === "url" ? `url:${image.url}` : `b64:${image.data.slice(0, 80)}:${image.data.length}`;
    if (!fingerprints.has(fingerprint)) {
      fingerprints.add(fingerprint);
      unique.push(image);
    }
  }
  result.images = unique;
  result.text = [...new Set(result.text)];
  return result;
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

async function downloadImage(url, apiKey) {
  const headers = {};
  try {
    if (new URL(url).origin === new URL(API_ROOT).origin) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    }
  } catch {
    throw new Error(`返回了无效图片地址：${url}`);
  }
  const response = await fetchWithTimeout(url, { headers }, 2 * 60 * 1000);
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: normalizeMime(response.headers.get("content-type")),
  };
}

function timestamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function detectMime(buffer, fallback = "image/png") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return normalizeMime(fallback);
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
  for (let index = 0; index < parsed.images.length; index += 1) {
    const image = parsed.images[index];
    if (image.type === "url") {
      const downloaded = await downloadImage(image.url, apiKey);
      saved.push(saveBuffer(downloaded.buffer, downloaded.mimeType, outputDir, index + 1, requestIndex));
    } else {
      const buffer = Buffer.from(image.data.replace(/\s+/g, ""), "base64");
      if (!buffer.length) throw new Error("接口返回了空的 Base64 图片");
      saved.push(saveBuffer(buffer, image.mimeType, outputDir, index + 1, requestIndex));
    }
  }
  return saved;
}

function parseApiError(status, body) {
  const message = body?.error?.message || body?.message || (typeof body === "string" ? body : JSON.stringify(body));
  if (status === 401 || status === 403) {
    return `鉴权失败（HTTP ${status}）：请使用能够调用 Gemini 图片模型的 Anthropic 协议分组 Key。${message ? ` ${message}` : ""}`;
  }
  return `88API 请求失败（HTTP ${status}）：${message || "未知错误"}`;
}

async function callMessages({ apiKey, body }) {
  let response;
  try {
    response = await fetchWithTimeout(MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`[NO-RETRY] 请求状态未知：${error?.name === "AbortError" ? "请求超时" : error?.message || String(error)}`);
  }

  const raw = await response.text();
  let parsedBody;
  try {
    parsedBody = raw ? JSON.parse(raw) : {};
  } catch {
    parsedBody = raw;
  }
  if (!response.ok) throw new Error(parseApiError(response.status, parsedBody));
  return parsedBody;
}

function printHelp() {
  console.log(`88api-Nano-Banana 0.1.0\n\n配置：\n  --get-config\n  --config-path\n  --set-key <KEY>\n  --set-model <MODEL>\n  --list-models\n\n生图：\n  --prompt <TEXT> [--model MODEL] [--image PATH ...] [--aspect RATIO] [--resolution 1K] [--count 1..${MAX_IMAGES}] [--output-dir DIR]\n\n验证：\n  --dry-run\n  --self-test\n\n协议：Anthropic Messages\n端点：${MESSAGES_URL}`);
}

function runSelfTest() {
  const fakePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZkAAAAASUVORK5CYII=";
  const references = [{ name: "test.png", mimeType: "image/png", data: fakePng, bytes: 68 }];
  const body = buildRequest({
    model: DEFAULT_MODEL,
    prompt: "测试",
    aspect: "1:1",
    resolution: "1K",
    references,
    maxTokens: 8192,
  });
  const anthropic = parseResponse({ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: fakePng } }] });
  const gateway = parseResponse({ content: [{ type: "text", text: `![result](data:image/png;base64,${fakePng})` }] });
  const google = parseResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: fakePng } }] } }] });
  const tempConfig = join(tmpdir(), `88api-nano-banana-self-test-${process.pid}-${Date.now()}.json`);
  try {
    saveConfig({ ...defaultConfig(), model: "gemini-3-pro-image" }, tempConfig);
    const roundTrip = loadConfig(tempConfig);
    const ok = body.messages[0].content[0].type === "image"
      && anthropic.images.length === 1
      && gateway.images.length === 1
      && google.images.length === 1
      && roundTrip.model === "gemini-3-pro-image"
      && MESSAGES_URL === "https://88api.ai/v1/messages";
    if (!ok) throw new Error("自测断言失败");
  } finally {
    rmSync(tempConfig, { force: true });
  }
  console.log(JSON.stringify({
    语法与配置: "通过",
    Anthropic请求体: "通过",
    Anthropic图片块解析: "通过",
    网关DataURL解析: "通过",
    GeminiInlineData解析: "通过",
    付费API调用: "未执行",
  }, null, 2));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || process.argv.length === 2) return printHelp();
  if (flags.selfTest) return runSelfTest();
  if (flags.configPath) return console.log(CONFIG_PATH);
  if (flags.listModels) return console.log([...MODELS].join("\n"));

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
  const body = buildRequest({ model, prompt: flags.prompt, aspect, resolution, references, maxTokens: config.maxTokens });

  if (flags.dryRun) {
    console.log(JSON.stringify({
      method: "POST",
      url: MESSAGES_URL,
      headers: { "content-type": "application/json", "x-api-key": "<已隐藏>", "anthropic-version": ANTHROPIC_VERSION },
      body: sanitizedRequest(body, references),
      paidRequests: count,
    }, null, 2));
    return;
  }

  const apiKey = config.apiKey || process.env.NANO_BANANA_API_KEY || "";
  if (!apiKey) {
    throw new Error(`尚未配置 Key。请先运行 --set-key <KEY>。配置文件：${CONFIG_PATH}`);
  }
  const outputDir = flags.outputDir || config.outputDir || DEFAULT_OUTPUT_DIR;
  const allSaved = [];
  for (let requestIndex = 1; requestIndex <= count; requestIndex += 1) {
    const responseBody = await callMessages({ apiKey, body });
    const parsed = parseResponse(responseBody);
    if (!parsed.images.length) {
      const text = parsed.text.join("\n").slice(0, 2000);
      throw new Error(`[NO-RETRY] 请求已成功完成，但响应中没有可保存的图片。${text ? ` 返回文本：${text}` : ""}`);
    }
    const saved = await saveParsedImages(parsed, outputDir, apiKey, requestIndex);
    allSaved.push(...saved);
    for (const path of saved) console.log(`图片已保存：${path}`);
  }
  console.log(JSON.stringify({ model, protocol: "Anthropic Messages", count: allSaved.length, files: allSaved }, null, 2));
}

main().catch((error) => {
  console.error(`ERROR: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
