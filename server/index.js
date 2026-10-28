// Chatbot core chat runtime.
// Entry point: `node index.js` (or `npm start`).
// Exposes a small HTTP backend for the chat UI:
//   GET  /agents        — list all available agents
//   GET  /scenes        — list all available scenes
//   POST /chat          — send a message, stream the agent's reply
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent, listAgents, loadScene, listScenes, listCards, createCharacter, updateCharacter, deleteCharacter, saveCardActive, createCard, updateCard, deleteCard, createScene, updateScene, deleteScene, listScenarios, loadScenario, createScenario, updateScenario, deleteScenario } from "./lib/loader.js";
import { assembleSystemPrompt } from "./lib/prompt.js";
import { listTagCategories } from "./lib/tags.js";
import { streamChatCompletion, getBaseUrl, listModels, LlmProviderOfflineError, LmStudioOfflineError, getProvider } from "./lib/llm-provider.js";
import { getConfig, loadEnvFile } from "./lib/config.js";
import { writeMemory, listMemories, deleteMemory } from "./lib/memory.js";

// ---- Configuration ----
loadEnvFile();
const CONFIG = getConfig();
const HOST = CONFIG.host;
const PORT = CONFIG.port;
const DEFAULT_MODEL = CONFIG.defaultModel;
const HOUSE_ROOT = path.resolve(
  process.env.AI_HOUSE_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "house"),
);
const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "ui",
);

// ---- LM Studio model discovery ----
// "local-model" is a placeholder; when the client does not name an explicit
// model, use the first model loaded in LM Studio (cached briefly).
const MODEL_PLACEHOLDER = "local-model";
let discoveredModels = null;
let discoveredAt = 0;

function preferModelPlaceholder(model) {
  return !model || model === DEFAULT_MODEL || model === MODEL_PLACEHOLDER;
}

async function resolveModelPlaceholder(model = DEFAULT_MODEL) {
  if (!preferModelPlaceholder(model)) return model;
  if (discoveredModels?.length && Date.now() - discoveredAt < 30_000) return discoveredModels[0];
  try {
    const ids = await listModels({ timeout: 5000 });
    discoveredModels = ids;
    discoveredAt = Date.now();
    if (ids.length) return ids[0];
  } catch (err) {
    if (!(err instanceof LmStudioOfflineError)) {
      console.error(`Model discovery failed: ${err.message}`);
    }
  }
  return model; // fall back to the placeholder; LM Studio may still route it
}

async function probeLlmProvider() {
  const provider = getProvider();
  const providerName = provider === "ollama" ? "Ollama" : "LM Studio";
  try {
    const ids = await listModels({ timeout: 5000 });
    console.log(`${providerName}: connected (${ids.length} model${ids.length === 1 ? "" : "s"}: ${ids.join(", ")})`);
  } catch (err) {
    if (err instanceof LlmProviderOfflineError || err instanceof LmStudioOfflineError) {
      const hint = provider === "ollama"
        ? `run "ollama serve" and "ollama pull <model>".`
        : `run "lms server start" and "lms load <model>".`;
      console.warn(`${providerName}: OFFLINE at ${getBaseUrl()} — ${hint}`);
    } else {
      console.warn(`${providerName} probe failed: ${err.message}`);
    }
  }
}

// ---- Helpers ----
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": CONFIG.corsOrigin,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large.");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req, maxBytes = CONFIG.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        // Drain the rest instead of destroying the socket so the 413 response
        // can still reach the client.
        req.resume();
      }
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}

function isJsonRequest(req) {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  return contentType === "application/json";
}

// Write endpoints only accept JSON: this blocks simple cross-origin form posts
// (a browser cannot send application/json without a CORS preflight).
function requireJson(req, res) {
  if (isJsonRequest(req)) return true;
  sendJson(res, 415, {
    error: "unsupported_media_type",
    message: "Content-Type must be application/json.",
  });
  return false;
}

// Reads and parses a JSON object body. Returns undefined after sending the
// appropriate error response, so handlers can simply `if (parsed === undefined) return`.
async function readJsonBody(req, res) {
  if (!requireJson(req, res)) return undefined;
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "payload_too_large", message: err.message });
    } else {
      badRequest(res, "Unable to read request body.");
    }
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    badRequest(res, "Invalid JSON body.");
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    badRequest(res, "JSON body must be an object.");
    return undefined;
  }
  return parsed;
}

function notFound(res, message) {
  sendJson(res, 404, { error: "not_found", message });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: "bad_request", message });
}

function serverError(res, message) {
  console.error(message);
  sendJson(res, 500, { error: "internal_error", message: "The server could not complete the request." });
}

// ---- Route handlers ----
async function handleAgents(req, res) {
  try {
    const agents = listAgents();
    sendJson(res, 200, { agents, count: agents.length });
  } catch (err) {
    serverError(res, err.message);
  }
}

async function handleScenes(req, res) {
  try {
    const scenes = listScenes();
    sendJson(res, 200, { scenes, count: scenes.length });
  } catch (err) {
    serverError(res, err.message);
  }
}

async function handleScenarios(req, res) {
  try {
    const scenarios = listScenarios();
    sendJson(res, 200, { scenarios, count: scenarios.length });
  } catch (err) {
    serverError(res, err.message);
  }
}

async function handleCards(req, res) {
  try {
    const cards = listCards();
    sendJson(res, 200, { cards, count: cards.length });
  } catch (err) {
    serverError(res, err.message);
  }
}

// Canonical tag catalog (house/tags.yaml). Optional
// ?target=character|scene|scenario|card filters categories by applicability.
async function handleTags(req, res) {
  try {
    // req.url keeps the query string; the router only passes the pathname.
    const target = new URL(req.url, "http://localhost").searchParams.get("target");
    if (target && !["character", "scene", "scenario", "card"].includes(target)) {
      return badRequest(res, `"target" must be one of character, scene, scenario, card`);
    }
    const categories = listTagCategories(target);
    sendJson(res, 200, { categories, count: categories.length });
  } catch (err) {
    serverError(res, err.message);
  }
}

async function handleHealth(req, res) {
  const provider = getProvider();
  let llm = { reachable: false, models: [] };
  try {
    const models = await listModels({ timeout: 2000 });
    llm = { reachable: true, models };
  } catch {
    // Server stays healthy even when provider is down; UI shows the banner.
  }
  sendJson(res, 200, {
    status: "ok",
    provider,
    baseUrl: getBaseUrl(),
    lmStudioBaseUrl: getBaseUrl(), // backwards compat
    llmBaseUrl: getBaseUrl(),
    model: DEFAULT_MODEL,
    llm,
    lmStudio: llm, // backwards compat
  });
}

async function handleModels(req, res) {
  try {
    const models = await listModels();
    discoveredModels = models;
    discoveredAt = Date.now();
    sendJson(res, 200, { models, defaultModel: models[0] ?? DEFAULT_MODEL });
  } catch (err) {
    if (err instanceof LlmProviderOfflineError || err instanceof LmStudioOfflineError) {
      const provider = getProvider();
      return sendJson(res, 503, { error: provider === "ollama" ? "ollama_offline" : "lm_studio_offline", message: err.message });
    }
    return serverError(res, err.message);
  }
}

async function handleChat(req, res) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;

  const { agentNickname, characterNicknames, roomId, sceneName, message, model = DEFAULT_MODEL, activeCards, history = [] } = parsed;

  // ---- Group chat mode: multiple AI characters share one room/history ----
  if (characterNicknames && Array.isArray(characterNicknames)) {
    return await handleGroupChat(req, res, { characterNicknames, roomId, sceneName, message, model, activeCards, history });
  }

  // ---- Single agent mode (existing behavior) ----
  if (!agentNickname || typeof agentNickname !== "string") {
    return badRequest(res, "Missing required field: agentNickname (or characterNicknames for group chat)");
  }
  if (!message || typeof message !== "string") {
    return badRequest(res, "Missing required field: message");
  }
  if (!Array.isArray(history) || history.length > 50 || history.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string")) {
    return badRequest(res, "history must contain up to 50 user/assistant messages.");
  }

  // When activeCards is omitted, fall back to the persisted card state (T-4.3).
  let cards = activeCards;
  if (cards === undefined) {
    cards = listCards().filter((card) => card.active).map((card) => card.key);
  }
  if (!Array.isArray(cards) || cards.some((card) => typeof card !== "string")) {
    return badRequest(res, "activeCards must be an array of card names.");
  }

  let agent;
  try {
    agent = loadAgent(agentNickname);
  } catch (err) {
    if (err.name === "ValidationError") {
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }

  let scene = null;
  if (sceneName) {
    try {
      scene = loadScene(sceneName);
    } catch (err) {
      if (err.name === "ValidationError") {
        return badRequest(res, err.message);
      }
      return serverError(res, err.message);
    }
    const participates = scene.participants.some(
      (participant) => participant.trim().toLowerCase() === agent.nickname.trim().toLowerCase(),
    );
    if (!participates) {
      return badRequest(
        res,
        `Agent "${agent.nickname}" is not a participant in scene "${sceneName}".`,
      );
    }
  }

  // A scene's world_card is part of the scene, so it is always in play even
  // when the client sends an explicit activeCards list.
  let scenario = null;
  if (scene?.scenario) {
    try {
      scenario = loadScenario(scene.scenario);
    } catch (err) {
      // A broken scenario link must not take the standalone scene down.
      console.warn(`Skipping scenario "${scene.scenario}" for scene "${scene.name}": ${err.message}`);
    }
  }
  const cardKeys = [...cards];
  if (scene?.world_card) cardKeys.push(scene.world_card);
  if (scenario?.world_card) cardKeys.push(scenario.world_card);
  const uniqueCards = [...new Set(cardKeys)];

  const requestedModel = model ?? DEFAULT_MODEL;
  const resolvedModel = await resolveModelPlaceholder(requestedModel);

  const systemPrompt = await assembleSystemPrompt(agent, scene, uniqueCards, {
    memoryRoot: CONFIG.memoryRoot,
    scenario,
  });

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Access-Control-Allow-Origin": CONFIG.corsOrigin,
    "X-Content-Type-Options": "nosniff",
  });

  try {
    const fullText = await streamChatCompletion({
      model: resolvedModel,
      messages,
      signal: controller.signal,
      onDelta: (text) => {
        const chunk = JSON.stringify({ type: "delta", text, agent: agent.nickname });
        res.write(`${chunk}\n`);
      },
    });
    if (agent.memory_enabled) {
      // Memory is best-effort: the reply already succeeded, so a vault write
      // failure must not turn the turn into an error or lose the stream.
      try {
        await writeMemory({
          root: CONFIG.memoryRoot,
          character: agent.nickname,
          scenario: scenario?.name ?? "",
          scenarioKey: scenario?.key ?? "",
          scene: scene?.name ?? "",
          sceneKey: scene?.key ?? "",
          userMessage: message,
          assistantMessage: fullText,
        });
      } catch (err) {
        console.warn(`Memory write failed for ${agent.nickname}: ${err.message}`);
      }
    }
    res.write(JSON.stringify({ type: "done", text: fullText, agent: agent.nickname }) + "\n");
    res.end();
  } catch (err) {
    if (res.writableEnded) return;
    try {
      const message = (err instanceof LlmProviderOfflineError || err instanceof LmStudioOfflineError)
        ? err.message
        : "The model request failed.";
      if (!(err instanceof LlmProviderOfflineError || err instanceof LmStudioOfflineError)) {
        console.error(`Chat stream failed: ${err.message}`);
      }
      res.write(JSON.stringify({ type: "error", error: message }) + "\n");
    } catch {
      // ignore — client may have disconnected
    }
    res.end();
  }
}

// ---- Group chat response controller (multi-character shared room) ----
// When characterNicknames is provided, listed AI characters respond in
// sequence to the same user message, sharing one conversation history and one
// scene. Characters respond to the user and to each other. Mentioned characters
// speak first, [PASS] replies are dropped, duplicate replies are suppressed,
// and a hard cap prevents runaway loops.
const GROUP_PASS_PATTERN = /^\s*(?:\[pass\]|pass)\s*$/i;

// Keep the user's requested order, but let characters named in the message
// speak before the rest so a direct question gets a direct answer.
function mentionedFirst(characters, message) {
  const text = String(message ?? "").toLowerCase();
  const mentioned = [];
  const rest = [];
  for (const character of characters) {
    const nickname = String(character.nickname ?? "").trim().toLowerCase();
    if (nickname && text.includes(nickname)) mentioned.push(character);
    else rest.push(character);
  }
  return [...mentioned, ...rest];
}

// Appended to each character's normal system prompt for group turns.
function groupSystemNote(agent, scene) {
  const self = String(agent.nickname ?? "").trim().toLowerCase();
  const others = (scene?.participants ?? []).filter(
    (participant) => String(participant).trim().toLowerCase() !== self,
  );
  return [
    "## Group Chat",
    `You are ${agent.nickname}, speaking in one shared group room${scene ? ` at ${scene.name}` : ""}.`,
    others.length
      ? `Other participants in the room: ${others.join(", ")}.`
      : "You are the only listed participant in this room.",
    "The conversation history is shared by everyone. Assistant messages are prefixed with the speaker's name.",
    `Write only ${agent.nickname}'s words and actions. Never speak, act, or decide for another character or for the user.`,
    "Respond naturally to the latest message and to any replies that came before yours. Keep it short (1-3 sentences).",
    "If your character would stay silent right now, reply with exactly [PASS] and nothing else.",
  ].join("\n");
}

// OpenAI-compatible history carries a single assistant role, so speaker names
// are folded into the content to keep the shared timeline legible to the model.
function historyForPrompt(items) {
  return items.map((item) => {
    if (item.role === "assistant") {
      const prefix = item.name ? `${item.name}: ` : "";
      return { role: "assistant", content: `${prefix}${item.content}` };
    }
    return { role: "user", content: item.content };
  });
}

async function handleGroupChat(req, res, { characterNicknames, roomId, sceneName, message, model, activeCards, history }) {
  const MAX_AI_RESPONSES = 8;

  if (!message || typeof message !== "string") {
    return badRequest(res, "Missing required field: message");
  }
  if (!Array.isArray(characterNicknames) || characterNicknames.length === 0 || characterNicknames.some((n) => typeof n !== "string" || !n.trim())) {
    return badRequest(res, "characterNicknames must be a non-empty array of strings.");
  }
  if (!Array.isArray(history) || history.length > 50 || history.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string")) {
    return badRequest(res, "history must contain up to 50 user/assistant messages.");
  }

  let cards = activeCards;
  if (cards === undefined) {
    cards = listCards().filter((card) => card.active).map((card) => card.key);
  }
  if (!Array.isArray(cards) || cards.some((card) => typeof card !== "string")) {
    return badRequest(res, "activeCards must be an array of card names.");
  }

  const seenNicknames = new Set();
  const aiCharacters = [];
  for (const nickname of characterNicknames) {
    const key = nickname.trim();
    if (seenNicknames.has(key)) continue;
    seenNicknames.add(key);
    let agent;
    try {
      agent = loadAgent(key);
    } catch (err) {
      return badRequest(res, `Unknown character: ${key}`);
    }
    if (String(agent?.role ?? "").trim().toLowerCase() === "user") continue;
    aiCharacters.push(agent);
  }

  if (aiCharacters.length === 0) {
    return badRequest(res, "No AI characters available to respond (all listed characters are user-role).");
  }

  let scene = null;
  if (sceneName) {
    try {
      scene = loadScene(sceneName);
    } catch (err) {
      if (err.name === "ValidationError") {
        return badRequest(res, err.message);
      }
      return serverError(res, err.message);
    }
    for (const agent of aiCharacters) {
      const participates = scene.participants.some(
        (participant) => participant.trim().toLowerCase() === agent.nickname.trim().toLowerCase(),
      );
      if (!participates) {
        return badRequest(res, `Agent "${agent.nickname}" is not a participant in scene "${sceneName}".`);
      }
    }
  }

  let scenario = null;
  if (scene?.scenario) {
    try {
      scenario = loadScenario(scene.scenario);
    } catch (err) {
      console.warn(`Skipping scenario "${scene.scenario}" for scene "${scene.name}": ${err.message}`);
    }
  }
  const cardKeys = [...cards];
  if (scene?.world_card) cardKeys.push(scene.world_card);
  if (scenario?.world_card) cardKeys.push(scenario.world_card);
  const uniqueCards = [...new Set(cardKeys)];

  const requestedModel = model ?? DEFAULT_MODEL;
  const resolvedModel = await resolveModelPlaceholder(requestedModel);

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Access-Control-Allow-Origin": CONFIG.corsOrigin,
    "X-Content-Type-Options": "nosniff",
  });

  const sharedHistory = [...history, { role: "user", content: message }];
  const orderedCharacters = mentionedFirst(aiCharacters, message);
  const seenReplies = new Set();

  try {
    let aiResponseCount = 0;
    for (const agent of orderedCharacters) {
      if (aiResponseCount >= MAX_AI_RESPONSES) break;

      const basePrompt = await assembleSystemPrompt(agent, scene, uniqueCards, {
        memoryRoot: CONFIG.memoryRoot,
        scenario,
      });
      const systemPrompt = `${basePrompt}\n\n${groupSystemNote(agent, scene)}`;

      const messages = [
        { role: "system", content: systemPrompt },
        ...historyForPrompt(sharedHistory),
      ];

      let fullText = "";
      try {
        fullText = await streamChatCompletion({
          model: resolvedModel,
          messages,
          signal: controller.signal,
          onDelta: (text) => {
            fullText += text;
            const chunk = JSON.stringify({ type: "delta", text, speaker: agent.nickname, turn: aiResponseCount + 1 });
            res.write(`${chunk}\n`);
          },
        });
      } catch (err) {
        if (err instanceof LlmProviderOfflineError || err instanceof LmStudioOfflineError) {
          if (!res.writableEnded) {
            res.write(JSON.stringify({ type: "error", error: err.message, speaker: agent.nickname }) + "\n");
          }
          break;
        }
        console.error(`Group chat stream failed for ${agent.nickname}: ${err.message}`);
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: "error", error: "The model request failed.", speaker: agent.nickname }) + "\n");
        }
        break;
      }

      const reply = fullText.trim();
      if (!reply) {
        res.write(JSON.stringify({ type: "skip", speaker: agent.nickname, reason: "empty" }) + "\n");
        continue;
      }
      if (GROUP_PASS_PATTERN.test(reply)) {
        res.write(JSON.stringify({ type: "skip", speaker: agent.nickname, reason: "pass" }) + "\n");
        continue;
      }
      const fingerprint = reply.replace(/\s+/g, " ").toLowerCase();
      if (seenReplies.has(fingerprint)) {
        res.write(JSON.stringify({ type: "skip", speaker: agent.nickname, reason: "duplicate" }) + "\n");
        continue;
      }
      seenReplies.add(fingerprint);

      sharedHistory.push({ role: "assistant", content: reply, name: agent.nickname });

      if (agent.memory_enabled) {
        try {
          await writeMemory({
            root: CONFIG.memoryRoot,
            character: agent.nickname,
            scenario: scenario?.name ?? "",
            scenarioKey: scenario?.key ?? "",
            scene: scene?.name ?? "",
            sceneKey: scene?.key ?? "",
            userMessage: message,
            assistantMessage: reply,
          });
        } catch (err) {
          console.warn(`Memory write failed for ${agent.nickname}: ${err.message}`);
        }
      }

      res.write(JSON.stringify({ type: "done", text: reply, speaker: agent.nickname, turn: aiResponseCount + 1 }) + "\n");
      aiResponseCount += 1;
    }

    res.end();
  } catch (err) {
    if (res.writableEnded) return;
    try {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: "error", error: "Group chat failed." }) + "\n");
      }
    } catch {
      // ignore — client may have disconnected
    }
    res.end();
  }
}

// ---- Character management handlers (T-5.3) ----
async function handleGetCharacter(req, res, nicknameKey) {
  try {
    const agent = loadAgent(nicknameKey);
    sendJson(res, 200, { agent });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown agent")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

async function handleCreateCharacter(req, res) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    const agent = createCharacter(parsed);
    sendJson(res, 201, { created: true, agent });
  } catch (err) {
    if (err.name === "ValidationError") {
      return sendJson(res, err.message.startsWith("A character with nickname") ? 409 : 400, { error: "validation_error", message: err.message });
    }
    return serverError(res, err.message);
  }
}

async function handleUpdateCharacter(req, res, nicknameKey) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    const agent = updateCharacter(nicknameKey, parsed);
    sendJson(res, 200, { updated: true, agent });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown character")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return sendJson(res, err.message.startsWith("A character with nickname") ? 409 : 400, { error: "validation_error", message: err.message });
    }
    return serverError(res, err.message);
  }
}

async function handleDeleteCharacter(req, res, nicknameKey) {
  try {
    const result = deleteCharacter(nicknameKey);
    sendJson(res, 200, {
      deleted: true,
      key: result.deleted,
      scenesUpdated: result.scenesUpdated,
      scenesDeleted: result.scenesDeleted,
    });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown character") || err.message.startsWith("Invalid agent identifier")) {
        return sendJson(res, err.message.startsWith("Unknown character") ? 404 : 400, { error: err.message.startsWith("Unknown character") ? "not_found" : "validation_error", message: err.message });
      }
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

// ---- Card creation handler (T-4.2) ----
async function handleCreateCard(req, res) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    const card = createCard(parsed);
    sendJson(res, 201, { created: true, card });
  } catch (err) {
    if (err.name === "ValidationError") {
      return sendJson(res, err.message.startsWith("A card named") ? 409 : 400, { error: "validation_error", message: err.message });
    }
    return serverError(res, err.message);
  }
}

// ---- Card activation handler (T-4.3) ----
async function handlePatchCard(req, res, cardKey) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    const card = saveCardActive(cardKey, parsed.active);
    sendJson(res, 200, { card });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown card")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

// Full card edit (name, description, type, active, tag_selections, extras).
async function handlePutCard(req, res, cardKey) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    const card = updateCard(cardKey, parsed);
    sendJson(res, 200, { updated: true, card });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown card")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return sendJson(res, err.message.startsWith("A card named") ? 409 : 400, { error: "validation_error", message: err.message });
    }
    return serverError(res, err.message);
  }
}

async function handleDeleteCard(req, res, cardKey) {
  try {
    const result = deleteCard(cardKey);
    sendJson(res, 200, { deleted: true, key: result.deleted });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown card")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

// ---- Scene / scenario management ----
async function handleCreateScene(req, res) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    sendJson(res, 201, { created: true, scene: createScene(parsed) });
  } catch (err) {
    if (err.name === "ValidationError") {
      return sendJson(res, err.message.startsWith("A scene named") ? 409 : 400, { error: "validation_error", message: err.message });
    }
    return serverError(res, err.message);
  }
}

async function handleUpdateScene(req, res, sceneKey) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    sendJson(res, 200, { updated: true, scene: updateScene(sceneKey, parsed) });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown scene")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return sendJson(res, err.message.startsWith("A scene named") ? 409 : 400, { error: "validation_error", message: err.message });
    }
    return serverError(res, err.message);
  }
}

async function handleDeleteScene(req, res, sceneKey) {
  try {
    const result = deleteScene(sceneKey);
    sendJson(res, 200, { deleted: true, key: result.deleted });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown scene")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

// ---- Scenario management (story foundation) ----
async function handleCreateScenario(req, res) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    sendJson(res, 201, { created: true, scenario: createScenario(parsed) });
  } catch (err) {
    if (err.name === "ValidationError") {
      return sendJson(res, err.message.startsWith("A scenario named") ? 409 : 400, {
        error: "validation_error",
        message: err.message,
      });
    }
    return serverError(res, err.message);
  }
}

async function handleUpdateScenario(req, res, scenarioKey) {
  const parsed = await readJsonBody(req, res);
  if (parsed === undefined) return;
  try {
    sendJson(res, 200, { updated: true, scenario: updateScenario(scenarioKey, parsed) });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown scenario")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return sendJson(res, err.message.startsWith("A scenario named") ? 409 : 400, {
        error: "validation_error",
        message: err.message,
      });
    }
    return serverError(res, err.message);
  }
}

async function handleDeleteScenario(req, res, scenarioKey) {
  try {
    const result = deleteScenario(scenarioKey);
    sendJson(res, 200, {
      deleted: true,
      key: result.deleted,
      scenesUpdated: result.scenesUpdated,
    });
  } catch (err) {
    if (err.name === "ValidationError") {
      if (err.message.startsWith("Unknown scenario")) {
        return sendJson(res, 404, { error: "not_found", message: err.message });
      }
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

// ---- Memories (dashboard) ----
async function handleMemories(req, res) {
  try {
    const scenarios = await listMemories({ root: CONFIG.memoryRoot });
    sendJson(res, 200, { scenarios });
  } catch (err) {
    serverError(res, err.message);
  }
}

async function handleDeleteMemory(req, res, memoryPath) {
  try {
    const result = await deleteMemory({ root: CONFIG.memoryRoot, path: memoryPath });
    sendJson(res, 200, { deleted: true, ...result });
  } catch (err) {
    if (err.message === "Memory not found.") {
      return sendJson(res, 404, { error: "not_found", message: err.message });
    }
    if (
      err.message === "Invalid memory identifier." ||
      err.message === "Invalid memory date." ||
      err.message === "Invalid memory path."
    ) {
      return badRequest(res, err.message);
    }
    return serverError(res, err.message);
  }
}

// ---- Static UI (T-1.5, T-6.1) ----
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return notFound(res, "Invalid path.");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(UI_DIR, relative));
  if (!filePath.startsWith(UI_DIR + path.sep) && filePath !== UI_DIR) {
    return notFound(res, `No static file ${decoded}`);
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return notFound(res, `No static file ${decoded}`);
  }
  if (stats.isDirectory()) {
    return notFound(res, `No static file ${decoded}`);
  }
  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) {
    return notFound(res, `No static file ${decoded}`);
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stats.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---- Shutdown ----
// "End session" in the UI stops the server without hunting for stop.bat.
// The POST requires JSON like the other write endpoints, so a cross-origin
// form cannot shut the server down.
let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Chatbot server stopping (${reason}) ...`);
  // Do not hang forever on a streaming chat that keeps a connection open.
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
  // Drop keep-alive/idle sockets so shutdown does not wait for the 2s fallback.
  server.closeIdleConnections?.();
}

function handleShutdown(req, res) {
  if (!requireJson(req, res)) return;
  // Let the acknowledgement reach the browser before the socket closes.
  res.setHeader("Connection", "close");
  res.once("finish", () => shutdown("End session"));
  sendJson(res, 200, { status: "stopping" });
}

// ---- Router ----
const routes = [
  { method: "GET", path: /^\/agents\/?$/, handler: handleAgents },
  { method: "GET", path: /^\/characters\/[a-z0-9_]+\/?$/, handler: handleGetCharacterRoute },
  { method: "GET", path: /^\/scenes\/?$/, handler: handleScenes },
  { method: "GET", path: /^\/scenarios\/?$/, handler: handleScenarios },
  { method: "GET", path: /^\/cards\/?$/, handler: handleCards },
  { method: "GET", path: /^\/tags\/?$/, handler: handleTags },
  { method: "GET", path: /^\/models\/?$/, handler: handleModels },
  { method: "GET", path: /^\/health\/?$/, handler: handleHealth },
  { method: "POST", path: /^\/shutdown\/?$/, handler: handleShutdown },
  { method: "POST", path: /^\/chat\/?$/, handler: handleChat },
  { method: "POST", path: /^\/characters\/?$/, handler: handleCreateCharacter },
  { method: "PUT", path: /^\/characters\/[a-z0-9_]+\/?$/, handler: handleUpdateCharacterRoute },
  { method: "DELETE", path: /^\/characters\/[a-z0-9_]+\/?$/, handler: handleDeleteCharacterRoute },
  { method: "POST", path: /^\/cards\/?$/, handler: handleCreateCard },
  { method: "PATCH", path: /^\/cards\/[a-z0-9_]+\/?$/, handler: handlePatchCardRoute },
  { method: "PUT", path: /^\/cards\/[a-z0-9_]+\/?$/, handler: handlePutCardRoute },
  { method: "DELETE", path: /^\/cards\/[a-z0-9_]+\/?$/, handler: handleDeleteCardRoute },
  { method: "POST", path: /^\/scenes\/?$/, handler: handleCreateScene },
  { method: "PUT", path: /^\/scenes\/[a-z0-9_]+\/?$/, handler: handleUpdateSceneRoute },
  { method: "DELETE", path: /^\/scenes\/[a-z0-9_]+\/?$/, handler: handleDeleteSceneRoute },
  { method: "POST", path: /^\/scenarios\/?$/, handler: handleCreateScenario },
  { method: "PUT", path: /^\/scenarios\/[a-z0-9_]+\/?$/, handler: handleUpdateScenarioRoute },
  { method: "DELETE", path: /^\/scenarios\/[a-z0-9_]+\/?$/, handler: handleDeleteScenarioRoute },
  { method: "GET", path: /^\/memories\/?$/, handler: handleMemories },
  { method: "DELETE", path: /^\/memories\/[^/]+\/[^/]+(?:\/[^/]+)*\/?$/, handler: handleDeleteMemoryRoute },
];

// Route handlers receive the identifier extracted from the URL.
function handleGetCharacterRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleGetCharacter(req, res, key);
}

function handleUpdateCharacterRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleUpdateCharacter(req, res, key);
}

function handleDeleteCharacterRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleDeleteCharacter(req, res, key);
}

function handlePatchCardRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handlePatchCard(req, res, key);
}

function handlePutCardRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handlePutCard(req, res, key);
}

function handleDeleteCardRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleDeleteCard(req, res, key);
}

function handleUpdateSceneRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleUpdateScene(req, res, key);
}

function handleDeleteSceneRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleDeleteScene(req, res, key);
}

function handleUpdateScenarioRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleUpdateScenario(req, res, key);
}

function handleDeleteScenarioRoute(req, res, url) {
  const key = new URL(url, "http://localhost").pathname.split("/").filter(Boolean).pop();
  return handleDeleteScenario(req, res, key);
}

function handleDeleteMemoryRoute(req, res, url) {
  const parts = new URL(url, "http://localhost").pathname.split("/").filter(Boolean);
  // parts[0] === "memories"; the rest is the vault-relative memory path.
  let memoryPath;
  try {
    memoryPath = parts.slice(1).map(decodeURIComponent).join("/");
  } catch {
    return badRequest(res, "Invalid memory path.");
  }
  return handleDeleteMemory(req, res, memoryPath);
}

function findRoute(method, urlPath) {
  return routes.find(
    (r) => r.method === method && r.path.test(urlPath),
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": CONFIG.corsOrigin, "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  const urlPath = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  const route = findRoute(req.method, urlPath);

  if (!route) {
    if (req.method === "GET") {
      return serveStatic(res, urlPath);
    }
    return notFound(res, `No route for ${req.method} ${urlPath}`);
  }

  try {
    await route.handler(req, res, urlPath);
  } catch (err) {
    if (res.writableEnded) return;
    serverError(res, err.message);
  }
});

server.listen(PORT, HOST, () => {
  const provider = getProvider();
  const providerName = provider === "ollama" ? "Ollama" : "LM Studio";
  console.log(`Chatbot server listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`${providerName} base URL: ${getBaseUrl()}`);
  console.log(`Provider: ${provider}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`House root: ${HOUSE_ROOT}`);
  probeLlmProvider();
});

// Ctrl+C in the server window should shut down the same way as End session.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(signal));
}

export default server;

