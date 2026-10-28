// Agent and scene loaders (T-1.2).
// All characters/scenes come from YAML files under house/ — no hardcoded agents.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { normalizeTagSelections } from "./tags.js";

const HOUSE_DIR = path.resolve(
  process.env.AI_HOUSE_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "house"),
);
const CHARACTERS_DIR = path.join(HOUSE_DIR, "characters");
const SCENES_DIR = path.join(HOUSE_DIR, "scenes");
const SCENARIOS_DIR = path.join(HOUSE_DIR, "scenarios");
// Prefer the renamed folder; fall back to the original house/cards.
const CARDS_DIR = fs.existsSync(path.join(HOUSE_DIR, "world cards"))
  ? path.join(HOUSE_DIR, "world cards")
  : path.join(HOUSE_DIR, "cards");

const REQUIRED_CHARACTER_FIELDS = ["nickname", "gender", "age", "personality", "appearance"];
// Optional roleplay card fields (see docs template: character card format).
const OPTIONAL_CHARACTER_TEXT_FIELDS = [
  "background", "speech_style", "motivations", "relationship", "behavior_rules",
];
const CARD_TYPES = ["world", "location_shift", "genre"];
const YAML_EXTENSIONS = [".yaml", ".yml"];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

// Guards dynamic field copying against prototype pollution from JSON payloads.
function isSafeField(field) {
  return !["__proto__", "constructor", "prototype"].includes(field);
}

function readYamlFile(file) {
  let data;
  try {
    data = yaml.load(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ValidationError(`Invalid YAML in ${path.basename(file)}: ${err.message}`);
  }
  if (data === null || typeof data !== "object") {
    throw new ValidationError(`${path.basename(file)} must contain a YAML mapping`);
  }
  return data;
}

function validateCharacter(data, file) {
  const base = path.basename(file);
  for (const field of REQUIRED_CHARACTER_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new ValidationError(`${base}: missing required field "${field}"`);
    }
  }
  if (!Number.isInteger(data.age) || data.age < AGE_MIN || data.age > AGE_MAX) {
    throw new ValidationError(`${base}: "age" must be an integer between ${AGE_MIN} and ${AGE_MAX}`);
  }
  if (data.memory_enabled !== undefined && typeof data.memory_enabled !== "boolean") {
    throw new ValidationError(`${base}: "memory_enabled" must be true or false`);
  }
  for (const field of [...OPTIONAL_CHARACTER_TEXT_FIELDS, "role", "system_prompt"]) {
    const value = data[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new ValidationError(`${base}: "${field}" must be empty or a text value`);
    }
  }
}

function listYamlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => YAML_EXTENSIONS.includes(path.extname(file))).sort();
}

function fileForKey(dir, key) {
  for (const extension of YAML_EXTENSIONS) {
    const file = path.join(dir, `${key}${extension}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Finds a YAML file by file key first, then by its display `name`. The second
// pass keeps hand-authored scenes/cards usable when their filename and display
// name diverge (or when the name contains non-ASCII characters). The final
// comparison normalizes the filename too, so an older template such as
// "birthday party.yaml" resolves as `birthday_party` like every other record.
function findYamlFile(dir, reference, label) {
  let key = null;
  try {
    key = normalizeKey(reference, label);
  } catch {
    key = null;
  }
  if (key) {
    const file = fileForKey(dir, key);
    if (file) return { key, file };
  }
  const wanted = String(reference ?? "").trim().toLowerCase();
  if (wanted) {
    for (const name of listYamlFiles(dir)) {
      const fullPath = path.join(dir, name);
      try {
        const data = readYamlFile(fullPath);
        let fileKey = path.basename(name, path.extname(name));
        try {
          fileKey = normalizeKey(fileKey, label);
        } catch {
          // Keep an unnormalizable filename addressable by its display name.
        }
        const nameMatches = String(data.name ?? "").trim().toLowerCase() === wanted;
        if (nameMatches || (key && fileKey === key)) {
          return { key: fileKey, file: fullPath };
        }
      } catch {
        // Broken files are skipped here; the tolerant list endpoints report them.
      }
    }
  }
  return null;
}

// Maps participant spellings to the canonical nickname in house/characters/,
// de-duplicating case variants ("Priya" vs "priya").
function canonicalParticipants(participants) {
  const roster = new Map(listAgents().map((agent) => [agent.nickname.trim().toLowerCase(), agent.nickname]));
  const seen = new Set();
  const result = [];
  for (const participant of participants) {
    const raw = String(participant ?? "").trim();
    if (!raw) continue;
    const canonical = roster.get(raw.toLowerCase()) ?? raw;
    const marker = canonical.toLowerCase();
    if (seen.has(marker)) continue;
    seen.add(marker);
    result.push(canonical);
  }
  return result;
}

// Tolerant listing: a file that fails to load (mid-edit, malformed YAML) is
// skipped with a warning instead of breaking every list endpoint.
function tolerantMap(dir, transform, label) {
  const results = [];
  for (const file of listYamlFiles(dir)) {
    const fullPath = path.join(dir, file);
    try {
      const item = transform(fullPath, file);
      if (item) results.push(item);
    } catch (err) {
      console.warn(`Skipping broken ${label} file ${file}: ${err.message}`);
    }
  }
  return results;
}

function normalizeKey(value, label) {
  const input = String(value ?? "").trim();
  // Reject path separators and traversal attempts outright; everything else is
  // slugified so display names such as "The Corner Café" get a stable key.
  if (!input || input.includes("..") || /[\\/<>:"|?*\u0000-\u001f]/.test(input)) {
    throw new ValidationError(`Invalid ${label} identifier`);
  }
  const raw = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) throw new ValidationError(`Invalid ${label} identifier`);
  return raw;
}

function validateScene(data, file) {
  if (!data.name || !Array.isArray(data.participants) || data.participants.length === 0 || data.participants.some((participant) => typeof participant !== "string" || !participant.trim())) {
    throw new ValidationError(`${path.basename(file)}: "name" and a non-empty "participants" list are required`);
  }
}

function validateCard(data, file) {
  if (!data.name || !data.description) {
    throw new ValidationError(`${path.basename(file)}: "name" and "description" are required`);
  }
  if (data.type !== undefined && !CARD_TYPES.includes(data.type)) {
    throw new ValidationError(`${path.basename(file)}: "type" must be one of ${CARD_TYPES.join(", ")}`);
  }
  if (data.active !== undefined && typeof data.active !== "boolean") {
    throw new ValidationError(`${path.basename(file)}: "active" must be true or false`);
  }
}

// Stored selections are trusted for reading: a malformed object from a
// hand-edited file must not break listings or chat. Writes still validate.
function storedTagSelections(data) {
  try {
    return normalizeTagSelections(data?.tag_selections) ?? {};
  } catch {
    return {};
  }
}

// Picks up every meaningful non-core field on a card (genre, time_period,
// rules, geography, hand-written variants like "time periode", …) so new
// lore fields work without schema changes.
function cardExtras(data) {
  const core = new Set(["name", "type", "description", "active"]);
  const extras = {};
  for (const [field, value] of Object.entries(data)) {
    if (core.has(field) || value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || Array.isArray(value)) extras[field] = value;
  }
  return extras;
}

export function loadAgent(nickname) {
  const file = path.join(CHARACTERS_DIR, `${normalizeKey(nickname, "agent")}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown agent "${nickname}"`);
  }
  const agent = readYamlFile(file);
  validateCharacter(agent, file);
  if (!agent.system_prompt) {
    agent.system_prompt = `You are ${agent.nickname}, ${agent.personality}. Stay in character at all times.`;
  }
  if (agent.memory_enabled === undefined) {
    agent.memory_enabled = true;
  }
  agent.tag_selections = storedTagSelections(agent);
  return agent;
}

export function listAgents() {
  return tolerantMap(CHARACTERS_DIR, (fullPath) => {
    const agent = readYamlFile(fullPath);
    validateCharacter(agent, fullPath);
    return {
      nickname: agent.nickname,
      gender: agent.gender,
      age: agent.age,
      personality: agent.personality,
      appearance: agent.appearance,
      role: agent.role ?? "character",
      tag_selections: storedTagSelections(agent),
    };
  }, "character");
}

// Non-core scene fields (atmosphere, time_weather, …) ride along for the
// prompt assembler without schema changes.
function sceneExtras(data) {
  const core = new Set(["name", "description", "participants", "location", "world_card", "scenario"]);
  const extras = {};
  for (const [field, value] of Object.entries(data)) {
    if (core.has(field) || value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || Array.isArray(value)) extras[field] = value;
  }
  return extras;
}

export function loadScene(sceneName) {
  // Accept either the display name ("Living Room Evening") or the file key
  // ("living_room_evening"). Name lookup is a fallback so filename drift and
  // non-ASCII display names keep working.
  const found = findYamlFile(SCENES_DIR, sceneName, "scene");
  if (!found) {
    throw new ValidationError(`Unknown scene "${sceneName}"`);
  }
  const scene = readYamlFile(found.file);
  validateScene(scene, found.file);
  return {
    key: found.key,
    name: scene.name,
    description: scene.description ?? "",
    participants: canonicalParticipants(scene.participants),
    location: scene.location ?? "",
    world_card: scene.world_card ?? null,
    // null = standalone scene. References are resolved to the scenario key so
    // the UI can group scenes even when a hand-authored file used the name.
    scenario: scene.scenario ? resolveScenarioReference(scene.scenario) : null,
    tag_selections: storedTagSelections(scene),
    extras: sceneExtras(scene),
  };
}

export function listScenes() {
  return tolerantMap(SCENES_DIR, (fullPath, file) => {
    const scene = readYamlFile(fullPath);
    validateScene(scene, fullPath);
    return {
      key: path.basename(file, path.extname(file)),
      name: scene.name ?? path.basename(file, path.extname(file)),
      description: scene.description ?? "",
      participants: canonicalParticipants(scene.participants ?? []),
      location: scene.location ?? "",
      world_card: scene.world_card ?? null,
      scenario: scene.scenario ? resolveScenarioReference(scene.scenario) : null,
      tag_selections: storedTagSelections(scene),
    };
  }, "scene");
}

export function loadCard(cardName) {
  const found = findYamlFile(CARDS_DIR, cardName, "card");
  if (!found) throw new ValidationError(`Unknown card "${cardName}"`);
  const card = readYamlFile(found.file);
  validateCard(card, found.file);
  return {
    key: found.key,
    name: card.name,
    type: card.type ?? "world",
    description: card.description,
    active: card.active ?? false,
    tag_selections: storedTagSelections(card),
    extras: cardExtras(card),
  };
}

export function listCards() {
  return tolerantMap(CARDS_DIR, (fullPath, file) => {
    const card = readYamlFile(fullPath);
    validateCard(card, fullPath);
    return {
      key: path.basename(file, path.extname(file)),
      name: card.name,
      type: card.type ?? "world",
      description: card.description,
      active: card.active ?? false,
      tag_selections: storedTagSelections(card),
    };
  }, "card");
}

// ---- Scenario management ----
// A scenario is the whole story (premise, relationships, world), while scenes
// are chapters inside it. Scenarios are first-class records in
// house/scenarios/; a scene links to one with its optional `scenario` field.
// Scenes without that field remain standalone and behave exactly as before.

function resolveScenarioReference(reference) {
  const input = String(reference ?? "").trim();
  if (!input) return null;
  const found = findYamlFile(SCENARIOS_DIR, input, "scenario");
  if (found) return found.key;
  // Keep an unknown reference visible instead of silently detaching a scene.
  try {
    return normalizeKey(input, "scenario");
  } catch {
    return input;
  }
}

// Hand-authored templates can be sparse, so only the name is mandatory.
function validateScenario(data, file) {
  if (!data.name || typeof data.name !== "string" || !data.name.trim()) {
    throw new ValidationError(`${path.basename(file)}: "name" is required`);
  }
  if (data.participants !== undefined && data.participants !== null && !Array.isArray(data.participants)) {
    throw new ValidationError(`${path.basename(file)}: "participants" must be a list of character nicknames`);
  }
  if (data.world_card !== undefined && data.world_card !== null && typeof data.world_card !== "string") {
    throw new ValidationError(`${path.basename(file)}: "world_card" must be a card name or null`);
  }
}

function scenarioParticipants(value) {
  return Array.isArray(value) ? canonicalParticipants(value) : [];
}

// Story-wide fields (premise, theme, conflict, …) ride along for the prompt
// assembler without schema changes, mirroring scene/card extras.
function scenarioExtras(data) {
  const core = new Set(["name", "description", "participants", "world_card", "tag_selections"]);
  const extras = {};
  for (const [field, value] of Object.entries(data)) {
    if (core.has(field) || value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || Array.isArray(value)) extras[field] = value;
  }
  return extras;
}

export function loadScenario(reference) {
  const found = findYamlFile(SCENARIOS_DIR, reference, "scenario");
  if (!found) throw new ValidationError(`Unknown scenario "${reference}"`);
  const data = readYamlFile(found.file);
  validateScenario(data, found.file);
  return {
    key: found.key,
    name: data.name,
    description: data.description ?? "",
    participants: scenarioParticipants(data.participants),
    world_card: data.world_card ? String(data.world_card).trim() : null,
    tag_selections: storedTagSelections(data),
    extras: scenarioExtras(data),
  };
}

export function listScenarios() {
  return tolerantMap(SCENARIOS_DIR, (fullPath, file) => {
    const data = readYamlFile(fullPath);
    validateScenario(data, fullPath);
    // Older templates may not have slugified filenames; the API and UI always
    // use the normalized key so links survive edits.
    const rawKey = path.basename(file, path.extname(file));
    let key;
    try {
      key = normalizeKey(rawKey, "scenario");
    } catch {
      key = rawKey;
    }
    return {
      key,
      name: data.name,
      description: data.description ?? "",
      participants: scenarioParticipants(data.participants),
      world_card: data.world_card ? String(data.world_card).trim() : null,
      tag_selections: storedTagSelections(data),
      extras: scenarioExtras(data),
    };
  }, "scenario");
}

function validatedScenarioFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Scenario payload must be an object");
  }
  const fields = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError(`Missing required field "name"`);
    }
    fields.name = input.name.trim();
  }
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") throw new ValidationError(`"description" must be a string`);
    fields.description = input.description.trim();
  }
  if (input.participants !== undefined) {
    if (input.participants === null) {
      fields.participants = [];
    } else if (!Array.isArray(input.participants) || input.participants.some((p) => typeof p !== "string" || !p.trim())) {
      throw new ValidationError(`"participants" must be a list of agent nicknames`);
    } else {
      const roster = new Map(listAgents().map((agent) => [agent.nickname.trim().toLowerCase(), agent.nickname]));
      const participants = [];
      for (const participant of input.participants) {
        const canonical = roster.get(participant.trim().toLowerCase());
        if (!canonical) {
          throw new ValidationError(`Unknown agent "${participant}" — scenario participants must be existing characters`);
        }
        if (!participants.some((name) => name.toLowerCase() === canonical.toLowerCase())) {
          participants.push(canonical);
        }
      }
      fields.participants = participants;
    }
  }
  if (input.world_card !== undefined) {
    if (input.world_card === null || input.world_card === "") {
      fields.world_card = null;
    } else if (typeof input.world_card === "string") {
      const cardNames = new Set(listCards().flatMap((card) => [card.name, card.key]));
      if (!cardNames.has(input.world_card.trim())) {
        throw new ValidationError(`Unknown world card "${input.world_card}"`);
      }
      fields.world_card = input.world_card.trim();
    } else {
      throw new ValidationError(`"world_card" must be a card name or null`);
    }
  }
  if (input.tag_selections !== undefined) {
    fields.tag_selections = normalizeTagSelections(input.tag_selections);
  }
  // Preserve the authored story foundation (premise, themes, conflict, …).
  // Empty strings are kept so clearing a field in the UI removes it from the
  // prompt instead of leaving the previous value behind.
  for (const [field, value] of Object.entries(input)) {
    if (!isSafeField(field)) continue;
    if (["name", "description", "participants", "world_card", "tag_selections", "scenes"].includes(field)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string") fields[field] = value.trim();
    else if (Array.isArray(value)) fields[field] = value;
  }
  return fields;
}

// `scenes` is a convenience link list: the canonical membership lives on each
// scene's `scenario` field, so it is never stored in the scenario YAML. Passing
// it links the listed chapters and unlinks every other scene from this story.
function requestedScenarioSceneKeys(input) {
  if (input.scenes === undefined) return null;
  if (!Array.isArray(input.scenes) || input.scenes.some((scene) => typeof scene !== "string" || !scene.trim())) {
    throw new ValidationError(`"scenes" must be a list of scene keys or names`);
  }
  const keys = new Set();
  for (const reference of input.scenes) {
    const found = findYamlFile(SCENES_DIR, reference.trim(), "scene");
    if (!found) throw new ValidationError(`Unknown scene "${reference}"`);
    keys.add(found.key);
  }
  return [...keys];
}

function syncScenarioScenes(scenarioKey, sceneKeys, scenarioName = "") {
  const wanted = new Set(sceneKeys);
  const keyLower = scenarioKey.toLowerCase();
  const nameLower = String(scenarioName ?? "").toLowerCase();
  const updated = [];
  for (const sceneFile of listYamlFiles(SCENES_DIR)) {
    const fullPath = path.join(SCENES_DIR, sceneFile);
    try {
      const data = readYamlFile(fullPath);
      let key = path.basename(sceneFile, path.extname(sceneFile));
      try {
        key = normalizeKey(key, "scene");
      } catch {
        // Keep unnormalizable filenames addressable by their display name.
      }
      const reference = String(data.scenario ?? "").trim().toLowerCase();
      const linkedToThisScenario =
        reference === keyLower || (Boolean(nameLower) && reference === nameLower);
      const shouldLink = wanted.has(key);
      if (shouldLink === linkedToThisScenario) continue;
      if (shouldLink) data.scenario = scenarioKey;
      else delete data.scenario;
      validateScene(data, fullPath);
      fs.writeFileSync(fullPath, serializeScene(data), "utf8");
      updated.push(key);
    } catch (err) {
      console.warn(`Skipping scenario link update for ${sceneFile}: ${err.message}`);
    }
  }
  return updated;
}

function serializeScenario(scenario) {
  return serializeOrdered(scenario, ["name", "description", "participants", "world_card", "tag_selections"]);
}

export function createScenario(input) {
  const fields = validatedScenarioFields(input);
  if (!fields.name) throw new ValidationError(`Missing required field "name"`);
  const sceneKeys = requestedScenarioSceneKeys(input);
  const key = normalizeKey(fields.name, "scenario");
  // Match by display name too, so an older template file with a non-slug
  // filename cannot be duplicated by a new scenario of the same name.
  if (findYamlFile(SCENARIOS_DIR, fields.name, "scenario")) {
    throw new ValidationError(`A scenario named "${fields.name}" already exists`);
  }
  const file = path.join(SCENARIOS_DIR, `${key}.yaml`);
  if (fs.existsSync(file)) {
    throw new ValidationError(`A scenario named "${fields.name}" already exists`);
  }
  fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
  const record = {
    ...fields,
    description: fields.description ?? "",
    participants: fields.participants ?? [],
    world_card: fields.world_card ?? null,
  };
  // Do not write blank story fields for a new scenario; on update an explicit
  // empty string is kept so it can clear a previously authored value.
  for (const [field, value] of Object.entries(record)) {
    if (["name", "description", "participants", "world_card", "tag_selections"].includes(field)) continue;
    if (value === "") delete record[field];
  }
  fs.writeFileSync(file, serializeScenario(record), "utf8");
  if (sceneKeys) syncScenarioScenes(key, sceneKeys, record.name);
  return { key, ...loadScenario(key) };
}

// Repoints scenes when a scenario is renamed so membership survives the edit.
function repointSceneScenarios(previousKey, previousName, newKey) {
  const updated = [];
  for (const sceneFile of listYamlFiles(SCENES_DIR)) {
    const fullPath = path.join(SCENES_DIR, sceneFile);
    try {
      const data = readYamlFile(fullPath);
      const reference = String(data.scenario ?? "").trim();
      if (!reference) continue;
      const isOldReference =
        reference.toLowerCase() === String(previousName ?? "").toLowerCase() ||
        reference.toLowerCase() === previousKey.toLowerCase();
      if (!isOldReference) continue;
      data.scenario = newKey;
      validateScene(data, fullPath);
      fs.writeFileSync(fullPath, serializeScene(data), "utf8");
      updated.push(path.basename(sceneFile, path.extname(sceneFile)));
    } catch (err) {
      console.warn(`Skipping scenario link update for ${sceneFile}: ${err.message}`);
    }
  }
  return updated;
}

export function updateScenario(scenarioKey, input) {
  const found = findYamlFile(SCENARIOS_DIR, scenarioKey, "scenario");
  if (!found) {
    throw new ValidationError(`Unknown scenario "${scenarioKey}"`);
  }
  const key = found.key;
  const file = found.file;
  const existing = readYamlFile(file);
  const patch = validatedScenarioFields(input);
  const sceneKeys = requestedScenarioSceneKeys(input);
  const previousName = existing.name;
  const merged = { ...existing, ...patch };
  validateScenario(merged, file);

  const newKey = patch.name !== undefined && patch.name !== previousName
    ? normalizeKey(patch.name, "scenario")
    : key;
  const targetFile = newKey === key ? file : path.join(SCENARIOS_DIR, `${newKey}.yaml`);
  if (targetFile !== file && fs.existsSync(targetFile)) {
    throw new ValidationError(`A scenario named "${merged.name}" already exists`);
  }
  fs.writeFileSync(targetFile, serializeScenario(merged), "utf8");
  if (targetFile !== file && fs.existsSync(file)) fs.rmSync(file);
  repointSceneScenarios(key, previousName, newKey);
  if (sceneKeys) syncScenarioScenes(newKey, sceneKeys, merged.name);
  return { key: newKey, ...loadScenario(newKey) };
}

export function deleteScenario(scenarioKey) {
  const found = findYamlFile(SCENARIOS_DIR, scenarioKey, "scenario");
  if (!found) {
    throw new ValidationError(`Unknown scenario "${scenarioKey}"`);
  }
  const key = found.key;
  const file = found.file;
  const existing = readYamlFile(file);
  fs.rmSync(file);

  // Deleting a story must not delete its chapters: unlink the scenes so they
  // continue to work as standalone scenes.
  const scenesUpdated = [];
  for (const sceneFile of listYamlFiles(SCENES_DIR)) {
    const fullPath = path.join(SCENES_DIR, sceneFile);
    try {
      const data = readYamlFile(fullPath);
      const reference = String(data.scenario ?? "").trim();
      if (!reference) continue;
      const isOldReference =
        reference.toLowerCase() === key.toLowerCase() ||
        reference.toLowerCase() === String(existing.name ?? "").toLowerCase();
      if (!isOldReference) continue;
      delete data.scenario;
      validateScene(data, fullPath);
      fs.writeFileSync(fullPath, serializeScene(data), "utf8");
      scenesUpdated.push(path.basename(sceneFile, path.extname(sceneFile)));
    } catch (err) {
      console.warn(`Skipping scenario unlink for ${sceneFile}: ${err.message}`);
    }
  }
  return { deleted: key, scenesUpdated };
}

// ---- Scene management ----
function validatedSceneFields(input) {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Scene payload must be an object");
  }
  const fields = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError(`Missing required field "name"`);
    }
    fields.name = input.name.trim();
  }
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") throw new ValidationError(`"description" must be a string`);
    fields.description = input.description.trim();
  }
  if (input.location !== undefined && input.location !== null) {
    if (typeof input.location !== "string") throw new ValidationError(`"location" must be a string`);
    fields.location = input.location.trim();
  }
  if (input.participants !== undefined) {
    if (!Array.isArray(input.participants) || input.participants.length === 0 || input.participants.some((p) => typeof p !== "string" || !p.trim())) {
      throw new ValidationError(`"participants" must be a non-empty list of agent nicknames`);
    }
    const roster = new Map(listAgents().map((agent) => [agent.nickname.trim().toLowerCase(), agent.nickname]));
    const participants = [];
    for (const participant of input.participants) {
      const canonical = roster.get(participant.trim().toLowerCase());
      if (!canonical) {
        throw new ValidationError(`Unknown agent "${participant}" — participants must be existing characters`);
      }
      if (!participants.some((name) => name.toLowerCase() === canonical.toLowerCase())) {
        participants.push(canonical);
      }
    }
    fields.participants = participants;
  }
  if (input.world_card !== undefined) {
    if (input.world_card === null || input.world_card === "") {
      fields.world_card = null;
    } else if (typeof input.world_card === "string") {
      const cardNames = new Set(listCards().flatMap((card) => [card.name, card.key]));
      if (!cardNames.has(input.world_card.trim())) {
        throw new ValidationError(`Unknown world card "${input.world_card}"`);
      }
      fields.world_card = input.world_card.trim();
    } else {
      throw new ValidationError(`"world_card" must be a card name or null`);
    }
  }
  if (input.scenario !== undefined) {
    if (input.scenario === null || input.scenario === "") {
      fields.scenario = null;
    } else if (typeof input.scenario === "string") {
      const found = findYamlFile(SCENARIOS_DIR, input.scenario, "scenario");
      if (!found) {
        throw new ValidationError(`Unknown scenario "${input.scenario}"`);
      }
      fields.scenario = found.key;
    } else {
      throw new ValidationError(`"scenario" must be a scenario name or null`);
    }
  }
  if (input.tag_selections !== undefined) {
    fields.tag_selections = normalizeTagSelections(input.tag_selections);
  }
  // Preserve author-defined scene fields (tags, interactions, …) on create.
  for (const [field, value] of Object.entries(input)) {
    if (!isSafeField(field)) continue;
    if (["name", "description", "participants", "location", "world_card", "scenario", "tag_selections"].includes(field)) continue;
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || Array.isArray(value)) fields[field] = value;
  }
  return fields;
}

// Writes core fields first, then every other authored field in its original
// order. This makes API edits non-destructive.
function serializeOrdered(data, order) {
  const ordered = {};
  const written = new Set();
  for (const field of order) {
    if (data[field] !== undefined) {
      ordered[field] = data[field];
      written.add(field);
    }
  }
  for (const [field, value] of Object.entries(data)) {
    if (written.has(field) || value === undefined) continue;
    ordered[field] = value;
  }
  return yaml.dump(ordered, { lineWidth: 100 });
}

function serializeScene(scene) {
  return serializeOrdered(scene, ["name", "description", "participants", "location", "world_card", "scenario", "tag_selections"]);
}

export function createScene(input) {
  const fields = validatedSceneFields(input);
  if (!fields.name) throw new ValidationError(`Missing required field "name"`);
  if (!fields.participants) throw new ValidationError(`Missing required field "participants"`);
  const key = normalizeKey(fields.name, "scene");
  const file = path.join(SCENES_DIR, `${key}.yaml`);
  if (fs.existsSync(file)) {
    throw new ValidationError(`A scene named "${fields.name}" already exists`);
  }
  fs.mkdirSync(SCENES_DIR, { recursive: true });
  const record = {
    ...fields,
    description: fields.description ?? "",
    location: fields.location ?? "",
    world_card: fields.world_card ?? null,
  };
  // Omit the link for standalone scenes so their YAML stays unchanged.
  if (!record.scenario) delete record.scenario;
  fs.writeFileSync(file, serializeScene(record), "utf8");
  return { key, ...loadScene(key) };
}

export function updateScene(sceneKey, input) {
  const key = normalizeKey(sceneKey, "scene");
  const file = path.join(SCENES_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown scene "${sceneKey}"`);
  }
  const existing = readYamlFile(file);
  const patch = validatedSceneFields(input);
  const previousName = existing.name;
  const merged = { ...existing, ...patch, participants: patch.participants ?? existing.participants };
  if (patch.name !== undefined && patch.name !== previousName) {
    const newKey = normalizeKey(patch.name, "scene");
    const newFile = path.join(SCENES_DIR, `${newKey}.yaml`);
    if (newKey !== key && fs.existsSync(newFile)) {
      throw new ValidationError(`A scene named "${patch.name}" already exists`);
    }
  }
  validateScene(merged, file);
  merged.participants = patch.participants ?? existing.participants;
  const newKey = patch.name !== undefined && patch.name !== previousName
    ? normalizeKey(patch.name, "scene")
    : key;
  const targetFile = path.join(SCENES_DIR, `${newKey}.yaml`);
  fs.writeFileSync(targetFile, serializeScene(merged), "utf8");
  if (newKey !== key && fs.existsSync(file)) {
    fs.rmSync(file);
  }
  return { key: newKey, ...loadScene(newKey) };
}

export function deleteScene(sceneKey) {
  const key = normalizeKey(sceneKey, "scene");
  const file = path.join(SCENES_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown scene "${sceneKey}"`);
  }
  fs.rmSync(file);
  return { deleted: key };
}

// ---- Character management (T-5.2, T-5.3) ----
const AGE_MIN = 18;
const AGE_MAX = 120;
const EDITABLE_STRING_FIELDS = ["nickname", "gender", "personality", "appearance"];

function assertNonEmptyString(input, field) {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`Missing required field "${field}"`);
  }
}

// Validates a patch of character fields. Returns only the fields present.
function validatedFields(input) {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Character payload must be an object");
  }
  const fields = {};
  for (const field of [...EDITABLE_STRING_FIELDS, ...OPTIONAL_CHARACTER_TEXT_FIELDS]) {
    if (input[field] !== undefined) {
      assertNonEmptyString(input, field);
      fields[field] = input[field].trim();
    }
  }
  if (input.age !== undefined) {
    if (!Number.isInteger(input.age) || input.age < AGE_MIN || input.age > AGE_MAX) {
      throw new ValidationError(`"age" must be an integer between ${AGE_MIN} and ${AGE_MAX}`);
    }
    fields.age = input.age;
  }
  if (input.role !== undefined && input.role !== null) {
    if (typeof input.role !== "string") throw new ValidationError(`"role" must be a string`);
    fields.role = input.role.trim();
  }
  if (input.system_prompt !== undefined && input.system_prompt !== null) {
    if (typeof input.system_prompt !== "string") throw new ValidationError(`"system_prompt" must be a string`);
    fields.system_prompt = input.system_prompt.trim();
  }
  if (input.memory_enabled !== undefined) {
    if (typeof input.memory_enabled !== "boolean") {
      throw new ValidationError(`"memory_enabled" must be true or false`);
    }
    fields.memory_enabled = input.memory_enabled;
  }
  if (input.tag_selections !== undefined) {
    fields.tag_selections = normalizeTagSelections(input.tag_selections);
  }
  return fields;
}

// Ensures all required character fields are present after merging a patch.
function assertComplete(character, file) {
  for (const field of REQUIRED_CHARACTER_FIELDS) {
    const value = character[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new ValidationError(`${file}: missing required field "${field}"`);
    }
  }
}

function assertNicknameAvailable(nickname, key, ignoreKey = null) {
  if (fs.existsSync(path.join(CHARACTERS_DIR, `${key}.yaml`)) && key !== ignoreKey) {
    throw new ValidationError(`A character with nickname "${nickname}" already exists`);
  }
  for (const agent of listAgents()) {
    if (agent.nickname.toLowerCase() === nickname.toLowerCase() && agent.nickname !== nickname && normalizeKey(agent.nickname, "agent") !== key) {
      throw new ValidationError(`A character with nickname "${agent.nickname}" already exists`);
    }
  }
}

function serializeCharacter(character) {
  return serializeOrdered(character, ["nickname", "gender", "age", "personality", "appearance", "role", "system_prompt", "memory_enabled", "tag_selections"]);
}

export function createCharacter(input) {
  const fields = validatedFields({ memory_enabled: true, ...input });
  assertComplete(fields, "new character");
  const key = normalizeKey(fields.nickname, "nickname");
  assertNicknameAvailable(fields.nickname, key);
  validateCharacter(fields, "new character");
  fs.mkdirSync(CHARACTERS_DIR, { recursive: true });
  const file = path.join(CHARACTERS_DIR, `${key}.yaml`);
  fs.writeFileSync(file, serializeCharacter(fields), "utf8");
  return loadAgent(key);
}

export function updateCharacter(nicknameKey, input) {
  const key = normalizeKey(nicknameKey, "agent");
  const file = path.join(CHARACTERS_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown character "${nicknameKey}"`);
  }
  const existing = readYamlFile(file);
  const patch = validatedFields(input);
  const previousNickname = existing.nickname;
  const merged = { ...existing, ...patch };

  if (patch.nickname !== undefined && patch.nickname !== previousNickname) {
    const newKey = normalizeKey(patch.nickname, "nickname");
    assertNicknameAvailable(patch.nickname, newKey, key);
    merged.nickname = patch.nickname;
  }
  assertComplete(merged, path.basename(file));
  validateCharacter(merged, file);

  const newKey = patch.nickname !== undefined && patch.nickname !== previousNickname
    ? normalizeKey(patch.nickname, "nickname")
    : key;
  const targetFile = path.join(CHARACTERS_DIR, `${newKey}.yaml`);
  fs.writeFileSync(targetFile, serializeCharacter(merged), "utf8");
  if (newKey !== key && fs.existsSync(file)) {
    fs.rmSync(file);
  }
  // Keep scenes consistent: rename participants pointing at the character.
  if (previousNickname !== merged.nickname) {
    for (const scene of listScenes()) {
      const participates = scene.participants.some(
        (name) => name.trim().toLowerCase() === previousNickname.trim().toLowerCase(),
      );
      if (!participates) continue;
      const sceneFile = path.join(SCENES_DIR, `${scene.key}.yaml`);
      const data = readYamlFile(sceneFile);
      data.participants = data.participants.map((name) =>
        name.trim().toLowerCase() === previousNickname.trim().toLowerCase() ? merged.nickname : name,
      );
      validateScene(data, sceneFile);
      fs.writeFileSync(sceneFile, serializeScene(data), "utf8");
    }
    // Scenario casts are a reuse list, not a hard link; keep them readable.
    for (const scenario of listScenarios()) {
      const participates = scenario.participants.some(
        (name) => name.trim().toLowerCase() === previousNickname.trim().toLowerCase(),
      );
      if (!participates) continue;
      const scenarioFile = path.join(SCENARIOS_DIR, `${scenario.key}.yaml`);
      const data = readYamlFile(scenarioFile);
      data.participants = data.participants.map((name) =>
        name.trim().toLowerCase() === previousNickname.trim().toLowerCase() ? merged.nickname : name,
      );
      validateScenario(data, scenarioFile);
      fs.writeFileSync(scenarioFile, serializeScenario(data), "utf8");
    }
  }
  return loadAgent(newKey);
}

export function deleteCharacter(nicknameKey) {
  const key = normalizeKey(nicknameKey, "agent");
  const file = path.join(CHARACTERS_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown character "${nicknameKey}"`);
  }
  const character = readYamlFile(file);
  const nickname = String(character.nickname ?? nicknameKey).trim();
  fs.rmSync(file);

  // Remove dangling references. Scenes left with no participants are removed
  // because they cannot be used for chat.
  const scenesUpdated = [];
  const scenesDeleted = [];
  for (const sceneFile of listYamlFiles(SCENES_DIR)) {
    const fullPath = path.join(SCENES_DIR, sceneFile);
    try {
      const data = readYamlFile(fullPath);
      if (!Array.isArray(data.participants)) continue;
      const remaining = data.participants.filter(
        (name) => String(name).trim().toLowerCase() !== nickname.toLowerCase(),
      );
      if (remaining.length === data.participants.length) continue;
      const sceneKey = path.basename(sceneFile, path.extname(sceneFile));
      if (remaining.length === 0) {
        fs.rmSync(fullPath);
        scenesDeleted.push(sceneKey);
        continue;
      }
      data.participants = remaining;
      validateScene(data, fullPath);
      fs.writeFileSync(fullPath, serializeScene(data), "utf8");
      scenesUpdated.push(sceneKey);
    } catch (err) {
      console.warn(`Skipping scene cleanup for ${sceneFile}: ${err.message}`);
    }
  }

  // Scenario casts are advisory: drop the deleted character but keep the story.
  const scenariosUpdated = [];
  for (const scenarioFile of listYamlFiles(SCENARIOS_DIR)) {
    const fullPath = path.join(SCENARIOS_DIR, scenarioFile);
    try {
      const data = readYamlFile(fullPath);
      if (!Array.isArray(data.participants)) continue;
      const remaining = data.participants.filter(
        (name) => String(name).trim().toLowerCase() !== nickname.toLowerCase(),
      );
      if (remaining.length === data.participants.length) continue;
      data.participants = remaining;
      validateScenario(data, fullPath);
      fs.writeFileSync(fullPath, serializeScenario(data), "utf8");
      scenariosUpdated.push(path.basename(scenarioFile, path.extname(scenarioFile)));
    } catch (err) {
      console.warn(`Skipping scenario cleanup for ${scenarioFile}: ${err.message}`);
    }
  }
  return { deleted: key, scenesUpdated, scenesDeleted, scenariosUpdated };
}

// ---- Card creation (T-4.2) ----
function serializeCard(card) {
  return serializeOrdered(card, ["name", "type", "description", "active", "tag_selections"]);
}

export function createCard(input) {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Card payload must be an object");
  }
  const fields = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError(`Missing required field "name"`);
    }
    fields.name = input.name.trim();
  } else {
    throw new ValidationError(`Missing required field "name"`);
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || !input.description.trim()) {
      throw new ValidationError(`Missing required field "description"`);
    }
    fields.description = input.description.trim();
  } else {
    throw new ValidationError(`Missing required field "description"`);
  }
  fields.type = input.type === undefined ? "world" : input.type;
  if (!CARD_TYPES.includes(fields.type)) {
    throw new ValidationError(`"type" must be one of ${CARD_TYPES.join(", ")}`);
  }
  fields.active = input.active === undefined ? false : !!input.active;
  if (input.tag_selections !== undefined) {
    fields.tag_selections = normalizeTagSelections(input.tag_selections);
  }
  // Preserve lore fields supplied by API clients (genre, world_rules, …).
  for (const [field, value] of Object.entries(input)) {
    if (!isSafeField(field)) continue;
    if (["name", "type", "description", "active", "tag_selections"].includes(field)) continue;
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || Array.isArray(value)) fields[field] = value;
  }

  const key = normalizeKey(fields.name, "card");
  const file = path.join(CARDS_DIR, `${key}.yaml`);
  if (fs.existsSync(file)) {
    throw new ValidationError(`A card named "${fields.name}" already exists`);
  }
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  fs.writeFileSync(file, serializeCard({ ...fields }), "utf8");
  return { key, ...loadCard(key) };
}

export function updateCard(cardKey, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Card payload must be an object");
  }
  const key = normalizeKey(cardKey, "card");
  const file = path.join(CARDS_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown card "${cardKey}"`);
  }
  const existing = readYamlFile(file);
  const patch = {};

  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError(`Missing required field "name"`);
    }
    patch.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || !input.description.trim()) {
      throw new ValidationError(`Missing required field "description"`);
    }
    patch.description = input.description.trim();
  }
  if (input.type !== undefined) {
    if (!CARD_TYPES.includes(input.type)) {
      throw new ValidationError(`"type" must be one of ${CARD_TYPES.join(", ")}`);
    }
    patch.type = input.type;
  }
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") {
      throw new ValidationError(`"active" must be true or false`);
    }
    patch.active = input.active;
  }
  if (input.tag_selections !== undefined) {
    patch.tag_selections = normalizeTagSelections(input.tag_selections);
  }
  for (const [field, value] of Object.entries(input)) {
    if (!isSafeField(field)) continue;
    if (["name", "description", "type", "active", "tag_selections"].includes(field)) continue;
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || Array.isArray(value)) patch[field] = value;
  }

  const merged = { ...existing, ...patch };
  validateCard(merged, file);
  const newKey = patch.name !== undefined && patch.name !== existing.name
    ? normalizeKey(patch.name, "card")
    : key;
  const targetFile = path.join(CARDS_DIR, `${newKey}.yaml`);
  if (newKey !== key && fs.existsSync(targetFile)) {
    throw new ValidationError(`A card named "${merged.name}" already exists`);
  }
  fs.writeFileSync(targetFile, serializeCard(merged), "utf8");
  if (newKey !== key && fs.existsSync(file)) fs.rmSync(file);
  return { key: newKey, ...loadCard(newKey) };
}

// ---- Card activation state (T-4.3) ----
export function saveCardActive(cardKey, active) {
  if (typeof active !== "boolean") {
    throw new ValidationError("`active` must be true or false");
  }
  const key = normalizeKey(cardKey, "card");
  const file = path.join(CARDS_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown card "${cardKey}"`);
  }
  const card = readYamlFile(file);
  card.active = active;
  fs.writeFileSync(file, yaml.dump(card, { lineWidth: 100 }), "utf8");
  return loadCard(key);
}

export function deleteCard(cardKey) {
  const key = normalizeKey(cardKey, "card");
  const file = path.join(CARDS_DIR, `${key}.yaml`);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Unknown card "${cardKey}"`);
  }
  fs.rmSync(file);
  return { deleted: key };
}
