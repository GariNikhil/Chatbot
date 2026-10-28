import fs from "node:fs/promises";
import path from "node:path";

// Memory files follow the story hierarchy:
//   <root>/scenarios/<scenarioKey>/<sceneKey>/<characterKey>/<date>.md
//   <root>/standalone/<sceneKey>/<characterKey>/<date>.md
// Older vaults used <root>/<characterKey>/<date>.md and remain readable.
const SCENARIOS_DIR = "scenarios";
const STANDALONE_DIR = "standalone";
const STANDALONE_GROUP_KEY = "_standalone";
const FREE_CHAT_SEGMENT = "_unscoped";
const NON_MEMORY_TOP_DIRS = new Set([
  SCENARIOS_DIR,
  STANDALONE_DIR,
  "scenes",
  "archives",
  "memories",
  "storylines",
  "attachments",
]);

// Mirrors the loader's key normalization: Unicode names (e.g. "José") become
// safe ASCII folder names instead of throwing.
function safeSegment(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error("Invalid memory identifier.");
  return normalized;
}

function safeOr(value, fallback) {
  try {
    return safeSegment(value);
  } catch {
    return fallback;
  }
}

function humanize(segment) {
  return String(segment ?? "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function oneLine(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function truncate(text, limit = 240) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// A memory file can contain several exchanges, each with its own frontmatter
// block. Parsing block-by-block avoids leaking one scene's context into another.
function parseMemoryBlocks(content) {
  const blocks = [];
  let header = null;
  let body = [];
  let inHeader = false;

  const flush = () => {
    if (header) blocks.push({ meta: header, body: body.join("\n").trim() });
    header = null;
    body = [];
  };

  for (const line of content.split(/\r?\n/)) {
    if (!inHeader && /^---[ \t]*$/.test(line)) {
      flush();
      header = {};
      inHeader = true;
      continue;
    }
    if (inHeader && /^---[ \t]*$/.test(line)) {
      inHeader = false;
      continue;
    }
    if (inHeader) {
      const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
      if (match) header[match[1]] = match[2];
      continue;
    }
    if (header) body.push(line);
  }
  flush();
  return blocks;
}

function formatForPrompt(block) {
  const stamp = block.meta.timestamp || "";
  const body = block.body || "";
  return stamp ? `[${stamp}] ${body}` : body;
}

function uniqueScenes(blocks) {
  return [...new Set(blocks.map((block) => String(block.meta.scene ?? "").trim()).filter(Boolean))];
}

async function readDirectory(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function markdownFiles(directory) {
  const entries = await readDirectory(directory);
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name);
}

function sortDateFiles(files) {
  return files.sort(
    (a, b) =>
      path.basename(b.file).localeCompare(path.basename(a.file)) ||
      a.file.localeCompare(b.file),
  );
}

// Every memory file with the hierarchy keys encoded in its path. Legacy files
// have no scenario/scene folders, so their scene is recovered from frontmatter.
async function collectMemoryFiles(root) {
  const files = [];

  for (const entry of await readDirectory(root)) {
    if (!entry.isDirectory() || NON_MEMORY_TOP_DIRS.has(entry.name.toLowerCase())) continue;
    for (const file of await markdownFiles(path.join(root, entry.name))) {
      files.push({
        file: path.join(root, entry.name, file),
        characterKey: entry.name,
        scenarioKey: STANDALONE_GROUP_KEY,
        sceneKey: "",
        legacy: true,
      });
    }
  }

  for (const scenario of await readDirectory(path.join(root, SCENARIOS_DIR))) {
    if (!scenario.isDirectory()) continue;
    const scenarioPath = path.join(root, SCENARIOS_DIR, scenario.name);
    for (const scene of await readDirectory(scenarioPath)) {
      if (!scene.isDirectory()) continue;
      const scenePath = path.join(scenarioPath, scene.name);
      for (const character of await readDirectory(scenePath)) {
        if (!character.isDirectory()) continue;
        const characterPath = path.join(scenePath, character.name);
        for (const file of await markdownFiles(characterPath)) {
          files.push({
            file: path.join(characterPath, file),
            characterKey: character.name,
            scenarioKey: scenario.name,
            sceneKey: scene.name,
            legacy: false,
          });
        }
      }
    }
  }

  const standalonePath = path.join(root, STANDALONE_DIR);
  for (const scene of await readDirectory(standalonePath)) {
    if (!scene.isDirectory()) continue;
    const scenePath = path.join(standalonePath, scene.name);
    for (const character of await readDirectory(scenePath)) {
      if (!character.isDirectory()) continue;
      const characterPath = path.join(scenePath, character.name);
      for (const file of await markdownFiles(characterPath)) {
        files.push({
          file: path.join(characterPath, file),
          characterKey: character.name,
          scenarioKey: STANDALONE_GROUP_KEY,
          sceneKey: scene.name,
          legacy: false,
        });
      }
    }
  }

  return sortDateFiles(files);
}

function sceneSegment(sceneKey, scene) {
  if (String(sceneKey ?? "").trim()) return safeSegment(sceneKey);
  if (String(scene ?? "").trim()) return safeSegment(scene);
  return FREE_CHAT_SEGMENT;
}

export async function writeMemory({
  root,
  character,
  scenario = "",
  scenarioKey = "",
  scene = "",
  sceneKey = "",
  userMessage,
  assistantMessage,
  importance = 5,
  timestamp = new Date(),
}) {
  const characterSegment = safeSegment(character);
  const scenarioSegment = String(scenarioKey ?? "").trim()
    ? safeSegment(scenarioKey)
    : String(scenario ?? "").trim()
      ? safeSegment(scenario)
      : "";
  const sceneSegmentValue = sceneSegment(sceneKey, scene);

  // A chapter under a scenario lives under that story; scenes without a
  // scenario (including free chat) live in the standalone tree.
  const directory = scenarioSegment
    ? path.join(root, SCENARIOS_DIR, scenarioSegment, sceneSegmentValue, characterSegment)
    : path.join(root, STANDALONE_DIR, sceneSegmentValue, characterSegment);
  await fs.mkdir(directory, { recursive: true });

  const date = timestamp.toISOString().slice(0, 10);
  const file = path.join(directory, `${date}.md`);
  const content = [
    "---",
    `character: ${oneLine(character)}`,
    `scenario: ${oneLine(scenario)}`,
    `scenario_key: ${scenarioSegment}`,
    `scene: ${oneLine(scene)}`,
    `scene_key: ${sceneSegmentValue}`,
    `timestamp: ${timestamp.toISOString()}`,
    `importance: ${Math.max(1, Math.min(10, Number(importance) || 5))}`,
    "---",
    "",
    `User: ${String(userMessage ?? "").trim()}`,
    `Assistant: ${String(assistantMessage ?? "").trim()}`,
    "",
  ].join("\n");
  await fs.appendFile(file, content, "utf8");
  return file;
}

// Lists every memory file as scenario → scene → character. Each file maps to
// one dashboard entry (so the date-based delete endpoint stays coherent) but
// parses every exchange block so previews never expose YAML frontmatter.
export async function listMemories({ root }) {
  const scenarios = new Map();

  for (const entry of await collectMemoryFiles(root)) {
    const content = await fs.readFile(entry.file, "utf8");
    const blocks = parseMemoryBlocks(content);
    if (!blocks.length) continue;

    const scenes = uniqueScenes(blocks);
    const firstMeta = blocks[0].meta ?? {};
    const displayCharacter = String(firstMeta.character ?? "").trim() || humanize(entry.characterKey);

    const scenarioKey = entry.legacy ? STANDALONE_GROUP_KEY : entry.scenarioKey;
    const scenarioName =
      !entry.legacy && String(firstMeta.scenario ?? "").trim()
        ? String(firstMeta.scenario).trim()
        : scenarioKey === STANDALONE_GROUP_KEY
          ? "Standalone scenes"
          : humanize(scenarioKey);

    let sceneKey = entry.sceneKey;
    let sceneName;
    if (entry.legacy) {
      if (scenes.length === 1) {
        sceneKey = safeOr(scenes[0], "legacy");
        sceneName = scenes[0];
      } else if (scenes.length > 1) {
        sceneKey = "_mixed";
        sceneName = "Mixed scenes";
      } else {
        sceneKey = FREE_CHAT_SEGMENT;
        sceneName = "Free chat";
      }
    } else if (sceneKey === FREE_CHAT_SEGMENT) {
      sceneName = "Free chat";
    } else {
      sceneName =
        String(firstMeta.scene ?? "").trim() ||
        humanize(sceneKey);
    }

    const importance = Math.max(
      ...blocks.map((block) => Number(block.meta.importance) || 5),
    );
    const timestamp =
      [...blocks].reverse().find((block) => block.meta.timestamp)?.meta.timestamp ?? "";
    const body = blocks.map((block) => block.body).filter(Boolean).join("\n\n");
    const relativePath = path
      .relative(root, entry.file)
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");

    let scenario = scenarios.get(scenarioKey);
    if (!scenario) {
      scenario = { key: scenarioKey, name: scenarioName, scenes: new Map() };
      scenarios.set(scenarioKey, scenario);
    }
    let scene = scenario.scenes.get(sceneKey);
    if (!scene) {
      scene = { key: sceneKey, name: sceneName, characters: new Map() };
      scenario.scenes.set(sceneKey, scene);
    }
    let character = scene.characters.get(entry.characterKey);
    if (!character) {
      character = { key: entry.characterKey, name: displayCharacter, memories: [] };
      scene.characters.set(entry.characterKey, character);
    }

    character.memories.push({
      date: path.basename(entry.file).replace(/\.md$/i, ""),
      scene: scenes.join(", ") || null,
      scenes,
      importance,
      timestamp,
      preview: truncate(body),
      content: body,
      path: relativePath,
      legacy: entry.legacy,
    });
  }

  return [...scenarios.values()]
    .map((scenario) => ({
      scenario: scenario.key,
      name: scenario.name,
      scenes: [...scenario.scenes.values()]
        .map((scene) => ({
          scene: scene.key,
          name: scene.name,
          characters: [...scene.characters.values()]
            .map((character) => ({
              character: character.key,
              name: character.name,
              memories: character.memories,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        (a.scenario === STANDALONE_GROUP_KEY ? 1 : 0) -
          (b.scenario === STANDALONE_GROUP_KEY ? 1 : 0) ||
        a.name.localeCompare(b.name),
    );
}

// Deletes one memory file by its vault-relative path (without extension):
//   <character>/<date>                                   legacy vaults
//   standalone/<scene>/<character>/<date>
//   scenarios/<scenario>/<scene>/<character>/<date>
export async function deleteMemory({ root, path: relativePath, character, date: legacyDate, deleteAll = false } = {}) {
  // Accept the original { character, date } call shape as well as the new
  // vault-relative path so existing integrations keep working.
  const target =
    relativePath ?? (character && legacyDate ? `${character}/${legacyDate}` : "");
  const raw = String(target)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!raw) throw new Error("Invalid memory path.");

  const parts = raw.split("/");
  
  // If deleteAll is true, delete the entire directory
  if (deleteAll && parts.length >= 2) {
    let dirSegments;
    if (parts.length === 2 && parts[0] === STANDALONE_GROUP_KEY) {
      // delete all standalone memories
      dirSegments = [STANDALONE_DIR];
    } else if (parts.length === 3 && parts[0] === STANDALONE_DIR) {
      dirSegments = [STANDALONE_DIR, safeSegment(parts[1])];
    } else if (parts.length === 2 && parts[0] !== SCENARIOS_DIR && parts[0] !== STANDALONE_DIR) {
      // legacy character folder
      dirSegments = [safeSegment(parts[0])];
    } else if (parts.length === 4 && parts[0] === SCENARIOS_DIR) {
      // delete entire scenario
      dirSegments = [SCENARIOS_DIR, safeSegment(parts[1])];
    } else if (parts.length === 5 && parts[0] === SCENARIOS_DIR) {
      // delete scenario/scene
      dirSegments = [SCENARIOS_DIR, safeSegment(parts[1]), safeSegment(parts[2])];
    } else {
      throw new Error("Invalid memory path.");
    }
    
    const dir = path.join(root, ...dirSegments);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("Memory not found.");
      }
      throw error;
    }
    return { deleted: raw };
  }
  
  const date = parts.pop();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid memory date.");
  }

  let segments;
  if (parts.length === 1) {
    segments = [safeSegment(parts[0])];
  } else if (parts.length === 3 && parts[0] === STANDALONE_DIR) {
    segments = [STANDALONE_DIR, safeSegment(parts[1]), safeSegment(parts[2])];
  } else if (parts.length === 4 && parts[0] === SCENARIOS_DIR) {
    segments = [
      SCENARIOS_DIR,
      safeSegment(parts[1]),
      safeSegment(parts[2]),
      safeSegment(parts[3]),
    ];
  } else {
    throw new Error("Invalid memory path.");
  }

  const file = path.join(root, ...segments, `${date}.md`);
  try {
    await fs.rm(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Memory not found.");
    }
    throw error;
  }
  return { deleted: `${raw}.md` };
}

// Reads the newest exchanges for one character. Pass a scene name for an exact
// match; pass "" for free-chat memories; omit the scene to read everything.
// The hierarchy is scenario → scene → character on disk, but recall stays
// scoped to the exact scene so chapters never inherit each other's history.
export async function readMemories({ root, character, scene, limit = 5 }) {
  const characterSegment = safeSegment(character);
  const scoped = scene !== undefined && scene !== null;
  const wantedScene = scoped ? String(scene).trim() : "";

  const memories = [];
  for (const entry of await collectMemoryFiles(root)) {
    if (safeOr(entry.characterKey, "") !== characterSegment) continue;
    const content = await fs.readFile(entry.file, "utf8");
    const blocks = parseMemoryBlocks(content);
    // Blocks are appended chronologically; iterate backwards for newest first.
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (scoped && String(block.meta.scene ?? "").trim() !== wantedScene) continue;
      memories.push(formatForPrompt(block));
      if (memories.length >= limit) return memories;
    }
  }
  return memories;
}
