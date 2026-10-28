import fs from "node:fs";
import path from "node:path";

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadEnvFile(envFile = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = parseEnvValue(trimmed.slice(equals + 1));
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function getConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || env.PROVIDER || "lmstudio").toLowerCase();
  
  // Determine base URL with backwards compatibility
  let baseUrl;
  if (env.LLM_BASE_URL) {
    baseUrl = env.LLM_BASE_URL;
  } else if (provider === "ollama") {
    baseUrl = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";
  } else {
    // Default to LM Studio for backwards compat
    baseUrl = env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1";
  }
  
  // Determine default model with backwards compat
  const defaultModel = env.LLM_MODEL || env.OLLAMA_MODEL || env.LMSTUDIO_MODEL || "local-model";
  
  return {
    port: Number(env.PORT || 3001),
    // Loopback by default: this server writes files and talks to a local model.
    // Opt into LAN access explicitly with HOST=0.0.0.0.
    host: env.HOST || "127.0.0.1",
    provider,
    defaultModel,
    baseUrl,
    // Keep for backwards compat
    lmStudioBaseUrl: baseUrl,
    llmBaseUrl: baseUrl,
    corsOrigin: env.CORS_ORIGIN || "http://localhost:3001",
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 1024 * 1024),
    memoryRoot: path.resolve(env.OBSIDIAN_VAULT_PATH || path.resolve(process.cwd(), "workspace", "memory"), "Chatbot", "Memories"),
  };
}