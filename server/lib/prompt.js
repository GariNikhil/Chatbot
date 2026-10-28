// Prompt assembler (T-1.3): agent system_prompt + scenario foundation +
// character context + cards + current scene + memory.
// Scenarios, scenes, and cards are passed in already loaded (or as a key/name
// reference) so the prompt reflects exactly what the chat handler validated.
import { loadCard, loadScenario, loadScene } from "./loader.js";
import { readMemories } from "./memory.js";
import { tagsForTarget } from "./tags.js";

function fieldLabel(field) {
  return field
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function detailLines(extras = {}) {
  const lines = [];
  for (const [field, value] of Object.entries(extras)) {
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${fieldLabel(field)}: ${value.join(", ")}`);
    } else if (typeof value === "string" && value.trim()) {
      lines.push(`${fieldLabel(field)}: ${value.trim()}`);
    }
  }
  return lines;
}

// Selected catalogue tags, limited to categories that apply to this target.
function tagLines(target, selections) {
  return tagsForTarget(target, selections).map(
    ({ categoryLabel, labels }) => `${categoryLabel}: ${labels.join(", ")}`,
  );
}

function scenarioBlock(scenario) {
  const lines = [`## Scenario: ${scenario.name}`];
  lines.push(
    "This is the overall story you are part of. The current scene is one chapter " +
    "inside it: keep this premise, these relationships, and established facts " +
    "unless the story explicitly changes them.",
  );
  if (scenario.description) lines.push(scenario.description);
  lines.push(...detailLines(scenario.extras));
  lines.push(...tagLines("scenario", scenario.tag_selections));
  if (scenario.participants?.length) {
    lines.push(`Characters in this story: ${scenario.participants.join(", ")}.`);
  }
  return lines.join("\n");
}

function sceneBlock(scene, agent, scenario = null) {
  const lines = [`## Current Scene: ${scene.name}`];
  if (scenario) lines.push(`Chapter of the scenario "${scenario.name}".`);
  if (scene.location) lines.push(`Location: ${scene.location}`);
  if (scene.description) lines.push(scene.description);
  lines.push(...detailLines(scene.extras));
  lines.push(...tagLines("scene", scene.tag_selections));

  const self = String(agent?.nickname ?? "").trim().toLowerCase();
  const others = (scene.participants ?? []).filter(
    (participant) => String(participant).trim().toLowerCase() !== self,
  );
  lines.push(
    others.length
      ? `Other agents present in this scene: ${others.join(", ")}.`
      : "You are the only agent present in this scene.",
  );
  lines.push("Stay aware of this setting when reacting and speaking.");
  return lines.join("\n");
}

function cardBlock(card) {
  const lines = [`## Active Card: ${card.name}`, card.description];
  lines.push(...detailLines(card.extras));
  lines.push(...tagLines("card", card.tag_selections));
  return lines.join("\n");
}

export async function assembleMemories(agent, { memoryRoot, sceneName } = {}) {
  if (!agent?.memory_enabled || !memoryRoot) return "";
  // `sceneName` is intentionally an exact scene name: with "" we only replay
  // free-chat memories, and a named scene never inherits another scene's notes.
  const memories = await readMemories({
    root: memoryRoot,
    character: agent.nickname,
    scene: sceneName ?? "",
  });
  return memories.join("\n\n");
}

export async function assembleSystemPrompt(agent, sceneReference, cardNames = [], options = {}) {
  const parts = [agent.system_prompt];

  let scene = null;
  if (sceneReference && typeof sceneReference === "object") {
    scene = sceneReference;
  } else if (sceneReference) {
    scene = loadScene(sceneReference);
  }

  // The scenario is the book; the scene is the chapter. A broken/missing
  // scenario link must not break a standalone scene.
  let scenario = null;
  if (options.scenario && typeof options.scenario === "object") {
    scenario = options.scenario;
  } else if (scene?.scenario) {
    try {
      scenario = loadScenario(scene.scenario);
    } catch (err) {
      console.warn(`Skipping scenario context for scene "${scene.name}": ${err.message}`);
    }
  }
  if (scenario) parts.push(scenarioBlock(scenario));

  const characterTags = tagLines("character", agent.tag_selections);
  if (characterTags.length) {
    parts.push(`## Character Traits\n${characterTags.join("\n")}`);
  }

  for (const cardName of cardNames) {
    const card = typeof cardName === "object" ? cardName : loadCard(cardName);
    parts.push(cardBlock(card));
  }

  if (scene) parts.push(sceneBlock(scene, agent, scenario));

  const memories = await assembleMemories(agent, {
    ...options,
    sceneName: scene?.name ?? "",
  });
  if (memories) {
    parts.push(`## Memories\n${memories}`);
  }
  return parts.join("\n\n");
}
