// LM Studio client (T-1.4): OpenAI-compatible chat completions with streaming.
export function lmStudioBaseUrl(baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1") {
  return baseUrl;
}

// Raised when LM Studio cannot be reached at all (server not running).
export class LmStudioOfflineError extends Error {
  constructor(baseUrl, cause) {
    super(
      `LM Studio is not reachable at ${baseUrl}. ` +
      `Start it with "lms server start" and load a model with "lms load <model>".`,
    );
    this.name = "LmStudioOfflineError";
    this.code = "LM_STUDIO_OFFLINE";
    this.cause = cause;
  }
}

// Network-level fetch failures (ECONNREFUSED etc.) show up as
// "TypeError: fetch failed" with a cause code — surface them as
// LmStudioOfflineError so callers can give useful feedback.
function translateOffline(err, baseUrl) {
  if (err instanceof LmStudioOfflineError) return err;
  const code = err?.cause?.code ?? err?.code;
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EPROTO", "UND_ERR_CONNECT_TIMEOUT"].includes(code) || /fetch failed/i.test(err?.message ?? "")) {
    return new LmStudioOfflineError(baseUrl, err);
  }
  return err;
}

export async function listModels({ baseUrl = lmStudioBaseUrl(), timeout = 5000 } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw translateOffline(err, baseUrl);
  }
  if (!response.ok) {
    throw new Error(`LM Studio returned ${response.status} for /models`);
  }
  const data = await response.json();
  return (data.data ?? []).map((model) => model.id);
}

// Streams delta text chunks as they arrive; resolves with the full reply text.
export async function streamChatCompletion({ model, messages, onDelta, signal, baseUrl = lmStudioBaseUrl() }) {
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw translateOffline(err, baseUrl);
  }
  if (!response.ok || !response.body) {
    const detail = response.body ? await response.text() : response.statusText;
    throw new Error(`LM Studio returned ${response.status}: ${detail.slice(0, 300)}`);
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
