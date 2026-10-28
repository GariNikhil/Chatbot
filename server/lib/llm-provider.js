// LLM Provider abstraction - supports LM Studio and Ollama (OpenAI-compatible APIs)
import { getConfig } from "./config.js";

export class LlmProviderOfflineError extends Error {
  constructor(provider, baseUrl, cause) {
    const hints = provider === "ollama"
      ? `Start Ollama with "ollama serve" and pull a model with "ollama pull <model>" (e.g., "ollama pull qwen3:4b").`
      : `Start it with "lms server start" and load a model with "lms load <model>".`;
    
    super(`${provider === "ollama" ? "Ollama" : "LM Studio"} is not reachable at ${baseUrl}. ${hints}`);
    this.name = "LlmProviderOfflineError";
    this.code = "LLM_PROVIDER_OFFLINE";
    this.provider = provider;
    this.cause = cause;
  }
}

// Backwards compatibility alias
export const LmStudioOfflineError = LlmProviderOfflineError;

export function getProvider() {
  const config = getConfig();
  return config.provider;
}

export function getBaseUrl() {
  const config = getConfig();
  return config.baseUrl || config.lmStudioBaseUrl || "http://127.0.0.1:1234/v1";
}

// Backwards compatibility alias
export const lmStudioBaseUrl = getBaseUrl;

// Network-level fetch failures show up as "TypeError: fetch failed" with a cause code
function translateOffline(err, baseUrl, provider) {
  if (err instanceof LlmProviderOfflineError) return err;
  const code = err?.cause?.code ?? err?.code;
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EPROTO", "UND_ERR_CONNECT_TIMEOUT"].includes(code) || /fetch failed/i.test(err?.message ?? "")) {
    return new LlmProviderOfflineError(provider, baseUrl, err);
  }
  return err;
}

export async function listModels({ baseUrl = getBaseUrl(), timeout = 5000, provider = getProvider() } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw translateOffline(err, baseUrl, provider);
  }
  if (!response.ok) {
    throw new Error(`${provider === "ollama" ? "Ollama" : "LM Studio"} returned ${response.status} for /models`);
  }
  const data = await response.json();
  return (data.data ?? []).map((model) => model.id);
}

export async function streamChatCompletion({ model, messages, onDelta, signal, baseUrl = getBaseUrl(), provider = getProvider() }) {
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw translateOffline(err, baseUrl, provider);
  }
  if (!response.ok || !response.body) {
    const detail = response.body ? await response.text() : response.statusText;
    throw new Error(`${provider === "ollama" ? "Ollama" : "LM Studio"} returned ${response.status}: ${detail.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let fullText = "";

  function processLine(rawLine) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) {
      fullText += text;
      onDelta(text);
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
    }
  }
  const trailing = decoder.decode();
  if (trailing) buffer += trailing;
  if (buffer.trim()) processLine(buffer);
  return fullText;
}

// Keep the old module name for backwards compat
export { streamChatCompletion as streamLmStudioChatCompletion };
export { listModels as listLmStudioModels };
export { getBaseUrl as lmstudioBaseUrl };
