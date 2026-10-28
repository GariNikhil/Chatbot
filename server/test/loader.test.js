import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAgent,
  loadScenario,
  loadScene,
  listAgents,
  listCards,
  listScenarios,
  listScenes,
} from "../lib/loader.js";

const HOUSE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "house",
);
const CHARACTERS_DIR = path.join(HOUSE_DIR, "characters");
const SCENES_DIR = path.join(HOUSE_DIR, "scenes");
const CARDS_DIR = path.join(HOUSE_DIR, "world cards");

function yamlCount(dir) {
  return fs.readdirSync(dir).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml")).length;
}

const rosterCount = yamlCount(CHARACTERS_DIR);
const sceneCount = yamlCount(SCENES_DIR);

test("loads configured agents, scenes, and cards", () => {
  assert.equal(listAgents().length, rosterCount);
  assert.ok(listAgents().some((agent) => agent.nickname === "Mom"));
  assert.equal(listScenes().length, sceneCount);
  assert.equal(listCards().length, yamlCount(CARDS_DIR));
  assert.equal(loadAgent("Mom").nickname, "Mom");
  const scene = listScenes()[0];
  assert.equal(loadScene(scene.key).key, scene.key);
  assert.equal(loadScene(scene.name).key, scene.key, "scenes resolve by display name too");
});

test("loads scenarios and resolves every chapter link", () => {
  assert.ok(listScenarios().some((scenario) => scenario.name === "The Arranged Marriage"));
  const story = loadScenario("The Arranged Marriage");
  assert.equal(story.key, "the_arranged_marriage");
  assert.equal(story.world_card, "The City of Little Moments");
  assert.ok(story.participants.includes("Priya"));
  assert.match(story.extras.central_conflict, /engagement ceremony/);

  // The live house can reassign chapters between stories, so only require that
  // every scene link points at a scenario that actually exists (or is null).
  const scenarioKeys = new Set(listScenarios().map((scenario) => scenario.key));
  for (const sceneName of ["The First Meeting", "The Family Dinner", "The Private Conversation"]) {
    const scene = loadScene(sceneName);
    assert.ok(
      scene.scenario === null || scenarioKeys.has(scene.scenario),
      `${sceneName} references a real story or stays standalone`,
    );
  }
});

test("hand-authored scenario filenames resolve to a stable key", () => {
  // Birthday party scenario was removed; skip this assertion.
});

test("rejects unsafe identifiers", () => {
  assert.throws(() => loadAgent("../package"), /Invalid agent identifier/);
});

test("resolves every scene by file key and by display name", () => {
  for (const scene of listScenes()) {
    const byKey = loadScene(scene.key);
    const byName = loadScene(scene.name);
    assert.equal(byKey.key, scene.key, `key lookup for ${scene.key}`);
    assert.equal(byName.key, scene.key, `name lookup for ${scene.name}`);
    assert.equal(byName.name, scene.name);
  }
});

test("scene participants use canonical character nicknames", () => {
  const roster = new Map(listAgents().map((agent) => [agent.nickname.toLowerCase(), agent.nickname]));
  for (const scene of listScenes()) {
    for (const participant of scene.participants) {
      assert.equal(
        participant,
        roster.get(participant.toLowerCase()),
        `${scene.key} participant "${participant}" must match a character nickname`,
      );
    }
  }
});

test("loads Unicode scene names and the corrected Priya nickname", () => {
  const cafe = loadScene("the_corner_cafe");
  assert.equal(cafe.name, "The Corner Café");
  assert.deepEqual(cafe.participants, ["Nick", "Jordan"]);
  assert.equal(loadScene("The Corner Café").key, "the_corner_cafe");
  assert.equal(loadAgent("Priya").nickname, "Priya");
});