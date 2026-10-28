import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listMemories, readMemories, writeMemory } from "../lib/memory.js";

const tempRoots = [];

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "Chatbot-memory-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("writes and reads scene-scoped Markdown memories", async () => {
  const root = await tempRoot();
  await writeMemory({
    root,
    character: "Mom",
    scenario: "The Arranged Marriage",
    scenarioKey: "the_arranged_marriage",
    scene: "Kitchen Morning",
    sceneKey: "kitchen_morning",
    userMessage: "I ate breakfast",
    assistantMessage: "Good, dear.",
  });

  const file = path.join(
    root,
    "scenarios",
    "the_arranged_marriage",
    "kitchen_morning",
    "mom",
    `${new Date().toISOString().slice(0, 10)}.md`,
  );
  const content = await fs.readFile(file, "utf8");
  assert.match(content, /^scenario: The Arranged Marriage$/m);
  assert.match(content, /^scene: Kitchen Morning$/m);

  const memories = await readMemories({
    root,
    character: "Mom",
    scene: "Kitchen Morning",
  });
  assert.equal(memories.length, 1);
  assert.match(memories[0], /I ate breakfast/);
});

test("memory reads match the exact scene, not substrings", async () => {
  const root = await tempRoot();
  const timestamp = new Date("2026-03-04T10:00:00Z");
  await writeMemory({ root, character: "Mom", scene: "Kitchen Morning", sceneKey: "kitchen_morning", userMessage: "breakfast", assistantMessage: "ok", timestamp });
  await writeMemory({ root, character: "Mom", scene: "Kitchen Morning (old)", sceneKey: "kitchen_morning_old", userMessage: "decoy", assistantMessage: "ok", timestamp });
  await writeMemory({ root, character: "Mom", scene: "Garage Workshop", sceneKey: "garage_workshop", userMessage: "tools", assistantMessage: "ok", timestamp });
  await writeMemory({ root, character: "Mom", scene: "", userMessage: "free chat", assistantMessage: "ok", timestamp });

  const kitchen = await readMemories({ root, character: "Mom", scene: "Kitchen Morning" });
  assert.equal(kitchen.length, 1);
  assert.match(kitchen[0], /breakfast/);
  assert.doesNotMatch(kitchen[0], /decoy/);

  const freeChat = await readMemories({ root, character: "Mom", scene: "" });
  assert.equal(freeChat.length, 1);
  assert.match(freeChat[0], /free chat/);

  const everything = await readMemories({ root, character: "Mom" });
  assert.equal(everything.length, 4);
});

test("memory reads respect the limit across days", async () => {
  const root = await tempRoot();
  await writeMemory({ root, character: "Dad", scene: "Garage", sceneKey: "garage", userMessage: "day one", assistantMessage: "ok", timestamp: new Date("2026-03-01T10:00:00Z") });
  await writeMemory({ root, character: "Dad", scene: "Garage", sceneKey: "garage", userMessage: "day two", assistantMessage: "ok", timestamp: new Date("2026-03-02T10:00:00Z") });
  await writeMemory({ root, character: "Dad", scene: "Garage", sceneKey: "garage", userMessage: "day three", assistantMessage: "ok", timestamp: new Date("2026-03-03T10:00:00Z") });

  const memories = await readMemories({ root, character: "Dad", scene: "Garage", limit: 2 });
  assert.equal(memories.length, 2);
  assert.match(memories[0], /day three/);
  assert.match(memories[1], /day two/);
});

test("dashboard listing groups scenario, scene, and character", async () => {
  const root = await tempRoot();
  const timestamp = new Date("2026-03-04T10:00:00Z");
  const story = {
    scenario: "The Arranged Marriage",
    scenarioKey: "the_arranged_marriage",
  };
  await writeMemory({ root, character: "Mom", ...story, scene: "Kitchen Morning", sceneKey: "kitchen_morning", userMessage: "first user", assistantMessage: "first reply", timestamp });
  await writeMemory({ root, character: "Mom", ...story, scene: "Garage Workshop", sceneKey: "garage_workshop", userMessage: "second user", assistantMessage: "second reply", timestamp });
  await writeMemory({ root, character: "Dad", ...story, scene: "Kitchen Morning", sceneKey: "kitchen_morning", userMessage: "third user", assistantMessage: "third reply", timestamp });

  const listed = await listMemories({ root });
  assert.equal(listed.length, 1);
  const scenario = listed[0];
  assert.equal(scenario.scenario, "the_arranged_marriage");
  assert.equal(scenario.name, "The Arranged Marriage");

  const sceneNames = scenario.scenes.map((scene) => scene.name);
  assert.deepEqual(sceneNames, ["Garage Workshop", "Kitchen Morning"]);
  const kitchen = scenario.scenes.find((scene) => scene.scene === "kitchen_morning");
  assert.equal(kitchen.characters.length, 2);

  const mom = kitchen.characters.find((group) => group.character === "mom");
  assert.equal(mom.name, "Mom");
  assert.equal(mom.memories.length, 1);
  const entry = mom.memories[0];
  assert.equal(entry.date, "2026-03-04");
  assert.equal(entry.scene, "Kitchen Morning");
  assert.equal(entry.path, "scenarios/the_arranged_marriage/kitchen_morning/mom/2026-03-04");
  assert.equal(entry.legacy, false);
  assert.match(entry.content, /first user/);
  assert.doesNotMatch(entry.content, /^---/);
  assert.doesNotMatch(entry.content, /importance:/);
});

test("legacy character-first memories stay readable and visible", async () => {
  const root = await tempRoot();
  const legacyDir = path.join(root, "mom");
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(
    path.join(legacyDir, "2026-03-04.md"),
    [
      "---",
      "character: Mom",
      "scene: Kitchen Morning",
      "timestamp: 2026-03-04T10:00:00.000Z",
      "importance: 6",
      "---",
      "",
      "User: old breakfast",
      "Assistant: old reply",
      "",
    ].join("\n"),
    "utf8",
  );

  const memories = await readMemories({ root, character: "Mom", scene: "Kitchen Morning" });
  assert.equal(memories.length, 1);
  assert.match(memories[0], /old breakfast/);

  const listed = await listMemories({ root });
  const standalone = listed.find((scenario) => scenario.scenario === "_standalone");
  assert.ok(standalone);
  assert.equal(standalone.name, "Standalone scenes");
  const kitchen = standalone.scenes.find((scene) => scene.name === "Kitchen Morning");
  assert.ok(kitchen);
  const mom = kitchen.characters.find((group) => group.character === "mom");
  assert.equal(mom.memories[0].path, "mom/2026-03-04");
  assert.equal(mom.memories[0].legacy, true);
});

test("slugs Unicode character names safely", async () => {
  const root = await tempRoot();
  await writeMemory({ root, character: "José", scene: "Café", sceneKey: "cafe", userMessage: "olá", assistantMessage: "olá" });

  assert.deepEqual(await fs.readdir(root), ["standalone"]);
  assert.deepEqual(await fs.readdir(path.join(root, "standalone")), ["cafe"]);
  const memories = await readMemories({ root, character: "José", scene: "Café" });
  assert.equal(memories.length, 1);
  assert.match(memories[0], /olá/);
});
