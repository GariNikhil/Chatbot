// Integration tests (T-6.4): full chat flow against a mock LM Studio server,
// plus the character CRUD and card activation endpoints.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Integration tests mutate the house (cards, characters, scenes), so run
// against a throwaway copy instead of the user's authored content.
const HOUSE_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "house",
);
const HOUSE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "Chatbot-house-"));
fs.cpSync(HOUSE_SOURCE, HOUSE_ROOT, { recursive: true });
const HOUSE_CARDS = path.join(HOUSE_ROOT, "world cards");
const HOUSE_SCENES = path.join(HOUSE_ROOT, "scenes");
const HOUSE_CHARACTERS = path.join(HOUSE_ROOT, "characters");

// ---- Mock LM Studio (OpenAI-compatible streaming) ----
const seenRequests = [];

const mockLmStudio = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    seenRequests.push(parsed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
    const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";
    let words;
    if (system.includes("## Group Chat")) {
      // Group turns get a distinct reply per speaker so the harness can check
      // ordering, naming, dedupe, and [PASS] handling.
      const self = /You are (.+?), speaking in one shared group room/.exec(system)?.[1] ?? "Someone";
      const reply = userText.includes("@pass")
        ? "[PASS]"
        : userText.includes("@duplicate")
          ? "Same reply."
          : `${self} replies.`;
      words = reply.match(/\S+\s*/g) ?? [reply];
    } else {
      words = ["Hello", " there,", " from", " the", " mock!"];
    }
    for (const word of words) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((resolve) => mockLmStudio.listen(0, "127.0.0.1", resolve));
const mockPort = mockLmStudio.address().port;

// Configure the server under test before importing index.js.
const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "Chatbot-mem-"));
// OBSIDIAN_VAULT_PATH is the vault root; the server stores under Chatbot/Memories.
const MEMORY_DIR = path.join(memoryRoot, "Chatbot", "Memories");
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.LMSTUDIO_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
process.env.OBSIDIAN_VAULT_PATH = memoryRoot;
process.env.AI_HOUSE_ROOT = HOUSE_ROOT;

const { default: server } = await import("../index.js");
if (!server.address()) {
  await new Promise((resolve) => server.once("listening", resolve));
}
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

async function request(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text.split("\n")[0]); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}

// Returns the prompt text between a header and the next "## " block.
function promptSection(system, header) {
  const start = system.indexOf(header);
  if (start === -1) return "";
  const rest = system.slice(start + header.length);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

function lastSystemPrompt() {
  return seenRequests.at(-1).messages.find((message) => message.role === "system").content;
}

test("GET /health reports the mock LM Studio endpoint", async () => {
  const { status, json } = await request("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.lmStudioBaseUrl, `http://127.0.0.1:${mockPort}/v1`);
});

test("GET /agents, /scenes, /cards list workspace data", async () => {
  const agents = await request("GET", "/agents");
  assert.equal(agents.status, 200);
  assert.ok(agents.json.agents.some((agent) => agent.nickname === "Mom"));

  const scenes = await request("GET", "/scenes");
  assert.equal(scenes.status, 200);
  assert.ok(scenes.json.scenes[0].participants.length > 0);

  const cards = await request("GET", "/cards");
  assert.equal(cards.status, 200);
  assert.equal(cards.json.count, 9);
});

test("POST /chat streams a reply and assembles scene + card context", async () => {
  // Use dedicated fixtures so edits to the user's authored house cannot make
  // this test fail (participants and cards change over time).
  const scene = await request("POST", "/scenes", {
    name: "Test Chat Room",
    description: "A room used only by the integration test.",
    participants: ["Mom"],
  });
  assert.equal(scene.status, 201);
  const card = await request("POST", "/cards", {
    name: "Test Rainy Card",
    description: "A rainy test evening.",
    type: "world",
    active: false,
  });
  assert.equal(card.status, 201);

  try {
    const response = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentNickname: "Mom",
        sceneName: "test_chat_room",
        message: "Hi Mom!",
        activeCards: ["test_rainy_card"],
      }),
    });
    assert.equal(response.status, 200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "delta");
    assert.equal(lines.at(-1).type, "done");
    assert.equal(lines.at(-1).text, "Hello there, from the mock!");

    const sent = seenRequests.at(-1);
    const system = sent.messages.find((m) => m.role === "system").content;
    assert.ok(system.includes("You are Mom"), "includes agent system prompt");
    assert.ok(system.includes("Current Scene: Test Chat Room"), "includes scene context");
    assert.ok(system.includes("Active Card: Test Rainy Card"), "includes active card");
    assert.ok(!system.includes("## Scenario: "), "standalone scenes get no story context");
    assert.ok(sent.stream === true);
  } finally {
    await request("DELETE", "/scenes/test_chat_room");
    fs.rmSync(path.join(HOUSE_CARDS, "test_rainy_card.yaml"), { force: true });
  }
});

test("GET /models discovers loaded models via LM Studio", async () => {
  const { status, json } = await request("GET", "/models");
  assert.equal(status, 200);
  assert.deepEqual(json.models, ["mock-model"]);
  assert.equal(json.defaultModel, "mock-model");
});

test("GET /health reports LM Studio reachability", async () => {
  const { status, json } = await request("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.lmStudio.reachable, true);
  assert.deepEqual(json.lmStudio.models, ["mock-model"]);
});

test("chat resolves the placeholder model to a discovered model", async () => {
  await request("POST", "/chat", { agentNickname: "Mom", message: "Which model?" });
  assert.equal(seenRequests.at(-1).model, "mock-model");
});

test("POST /chat defaults activeCards to persisted card state", async () => {
  // rainy_evening is inactive by default; activate it, chat without activeCards, restore.
  const before = await request("PATCH", "/cards/rainy_evening", { active: true });
  assert.equal(before.status, 200);
  try {
    await request("POST", "/chat", { agentNickname: "Mom", message: "Weather?" });
    const system = seenRequests.at(-1).messages.find((m) => m.role === "system").content;
    assert.ok(system.includes("Active Card: Rainy Evening"));
  } finally {
    await request("PATCH", "/cards/rainy_evening", { active: false });
  }
  assert.ok(fs.existsSync(path.join(HOUSE_CARDS, "rainy_evening.yaml")));
});

test("POST /chat rejects non-participant agents and oversized history", async () => {
  const scene = await request("POST", "/scenes", {
    name: "Test Non Participant",
    description: "Temporary scene for the non-participant check.",
    participants: ["Mom"],
  });
  assert.equal(scene.status, 201, scene.text);
  try {
    const bad = await request("POST", "/chat", {
      agentNickname: "Kaviya",
      sceneName: scene.json.scene.key,
      message: "hi",
    });
    assert.equal(bad.status, 400);
  } finally {
    await request("DELETE", `/scenes/${scene.json.scene.key}`);
  }

  const longHistory = Array.from({ length: 51 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const badHistory = await request("POST", "/chat", { agentNickname: "Mom", message: "hi", history: longHistory });
  assert.equal(badHistory.status, 400);
});

test("card activation persists to the YAML file", async () => {
  try {
    const activated = await request("PATCH", "/cards/rainy_evening", { active: true });
    assert.equal(activated.json.card.active, true);
    const yamlText = fs.readFileSync(path.join(HOUSE_CARDS, "rainy_evening.yaml"), "utf8");
    assert.match(yamlText, /active: true/);
  } finally {
    await request("PATCH", "/cards/rainy_evening", { active: false });
  }
  const rejected = await request("PATCH", "/cards/rainy_evening", { active: "yes" });
  assert.equal(rejected.status, 400);
  const unknown = await request("PATCH", "/cards/nope", { active: true });
  assert.equal(unknown.status, 404);
});

test("character CRUD: create, duplicate rejected, chat with new character, delete", async () => {
  // Create (T-5.3)
  const created = await request("POST", "/characters", {
    nickname: "Test Dummy",
    gender: "nonbinary",
    age: 33,
    personality: "fictional, ephemeral",
    appearance: "made of test assertions",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.agent.nickname, "Test Dummy");

  // Duplicate nickname (T-5.2)
  const duplicate = await request("POST", "/characters", {
    nickname: "test dummy",
    gender: "nonbinary",
    age: 33,
    personality: "copy",
    appearance: "copy",
  });
  assert.equal(duplicate.status, 409);

  // Invalid age range (T-5.2)
  const badAge = await request("POST", "/characters", {
    nickname: "Ancient One",
    gender: "other",
    age: 900,
    personality: "old",
    appearance: "old",
  });
  assert.equal(badAge.status, 400);

  // Missing required field (T-5.2)
  const missing = await request("POST", "/characters", { nickname: "Hollow", age: 10 });
  assert.equal(missing.status, 400);

  // Chat with the freshly created character (T-5.6)
  const chat = await request("POST", "/chat", { agentNickname: "Test Dummy", message: "Hello?" });
  assert.equal(chat.status, 200);
  assert.match(chat.text, /Hello there, from the mock!/);
  const system = seenRequests.at(-1).messages.find((m) => m.role === "system").content;
  assert.match(system, /You are Test Dummy/);

  // Update (T-5.4)
  const updated = await request("PUT", "/characters/test_dummy", { age: 34 });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.agent.age, 34);
  const unknownUpdate = await request("PUT", "/characters/ghost", { age: 34 });
  assert.equal(unknownUpdate.status, 404);

  // Delete (T-5.5)
  const deleted = await request("DELETE", "/characters/test_dummy");
  assert.equal(deleted.status, 200);
  const afterDelete = await request("GET", "/agents");
  assert.equal(afterDelete.json.agents.some((agent) => agent.nickname === "Test Dummy"), false);
  const unknownDelete = await request("DELETE", "/characters/test_dummy");
  assert.equal(unknownDelete.status, 404);
});

test("chat writes durable memory for memory-enabled agents", async () => {
  const files = [];
  for (const dir of fs.readdirSync(memoryRoot, { recursive: true, withFileTypes: true })) {
    if (dir.isFile() && dir.name.endsWith(".md")) files.push(dir.name);
  }
  assert.ok(files.length > 0, "expected at least one memory markdown file");
});

test("scene CRUD: create, validate participants, chat, rename, delete", async () => {
  // Create
  const created = await request("POST", "/scenes", {
    name: "Test Balcony",
    description: "A quiet rooftop evening for tests.",
    location: "Rooftop",
    participants: ["Mom", "Dad"],
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.scene.name, "Test Balcony");
  assert.equal(created.json.scene.world_card, null);

  // Duplicate name
  const duplicate = await request("POST", "/scenes", {
    name: "Test Balcony",
    participants: ["Mom"],
  });
  assert.equal(duplicate.status, 409);

  // Unknown participant is rejected
  const badParticipant = await request("POST", "/scenes", {
    name: "Ghost Movie Night",
    participants: ["Nobody", "Mom"],
  });
  assert.equal(badParticipant.status, 400);

  // Scene chat works for a participant
  const chat = await request("POST", "/chat", {
    agentNickname: "Mom",
    sceneName: "test_balcony",
    message: "Evening on the roof",
  });
  assert.equal(chat.status, 200);
  assert.match(chat.text, /Hello there, from the mock!/);

  // Per-scene participant update (agents selection)
  const updated = await request("PUT", "/scenes/test_balcony", {
    participants: ["Mom", "Dad", "Alex"],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.scene.participants.length, 3);

  // Non-participant now rejected mid-flight
  const excluded = await request("POST", "/chat", {
    agentNickname: "Kaviya",
    sceneName: "test_balcony",
    message: "hi",
  });
  assert.equal(excluded.status, 400);

  // Rename
  const renamed = await request("PUT", "/scenes/test_balcony", { name: "Star Balcony", participants: ["Mom"] });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.scene.key, "star_balcony");
  const staleRename = await request("PUT", "/scenes/test_balcony", { name: "X", participants: ["Mom"] });
  assert.equal(staleRename.status, 404);

  // Delete
  const deleted = await request("DELETE", "/scenes/star_balcony");
  assert.equal(deleted.status, 200);
  const unknownDelete = await request("DELETE", "/scenes/star_balcony");
  assert.equal(unknownDelete.status, 404);
});

test("scenario CRUD: story foundation, linked scene prompt, rename, delete", async () => {
  let scenarioKey = null;
  let sceneKey = null;
  try {
    const created = await request("POST", "/scenarios", {
      name: "Test Story",
      description: "A story used only by integration tests.",
      premise: "Two neighbours agree to pretend they are engaged for one summer.",
      relationship_dynamics: "They start as awkward co-conspirators and slowly trust each other.",
      central_conflict: "Their families expect a real wedding by autumn.",
      participants: ["Mom", "Dad"],
      world_card: "rainy_evening",
      tag_selections: {
        story_genres: ["story_genres.romance"],
        relationship_dynamics: ["relationship_dynamics.slow_burn"],
        roleplay_format: ["roleplay_format.pov"],
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.scenario.key, "test_story");
    assert.equal(created.json.scenario.world_card, "rainy_evening");
    assert.deepEqual(created.json.scenario.participants, ["Mom", "Dad"]);
    scenarioKey = created.json.scenario.key;

    const duplicate = await request("POST", "/scenarios", { name: "Test Story" });
    assert.equal(duplicate.status, 409);

    const badParticipant = await request("POST", "/scenarios", {
      name: "Ghost Story",
      participants: ["Nobody"],
    });
    assert.equal(badParticipant.status, 400);

    const badCard = await request("POST", "/scenarios", {
      name: "Cardless Story",
      world_card: "No Such Card",
    });
    assert.equal(badCard.status, 400);

    // Scenes link by display name but store the canonical scenario key.
    const scene = await request("POST", "/scenes", {
      name: "Test Story Scene",
      description: "A test chapter with its own immediate context.",
      location: "Test Veranda",
      participants: ["Mom"],
      scenario: "Test Story",
      tag_selections: {
        story_genres: ["story_genres.mystery"],
        conversation_mood: ["conversation_mood.tension"],
      },
    });
    assert.equal(scene.status, 201, scene.text);
    assert.equal(scene.json.scene.scenario, "test_story");
    sceneKey = scene.json.scene.key;

    const chat = await request("POST", "/chat", {
      agentNickname: "Mom",
      sceneName: "test_story_scene",
      message: "What are we pretending?",
      activeCards: [],
    });
    assert.equal(chat.status, 200, chat.text);
    const system = lastSystemPrompt();
    const storySection = promptSection(system, "## Scenario: Test Story");
    const sceneSection = promptSection(system, "## Current Scene: Test Story Scene");

    assert.match(storySection, /Two neighbours agree to pretend they are engaged/);
    assert.match(storySection, /They start as awkward co-conspirators/);
    assert.match(storySection, /Genre: Romance/);
    assert.match(storySection, /Relationship dynamics: Slow Burn/);
    assert.match(sceneSection, /A test chapter with its own immediate context/);
    assert.match(sceneSection, /Genre: Mystery/);
    assert.match(sceneSection, /Conversation mood: Tension/);
    // Tags stay at their own level and inapplicable tags are ignored.
    assert.doesNotMatch(storySection, /Conversation mood:/);
    assert.doesNotMatch(storySection, /Roleplay format: POV/);
    assert.doesNotMatch(sceneSection, /Romance/);
    // The scenario world card is always applied; scenario precedes scene.
    assert.match(system, /## Active Card: Rainy Evening/);
    assert.ok(system.indexOf("## Scenario: Test Story") < system.indexOf("## Active Card: Rainy Evening"));
    assert.ok(system.indexOf("## Active Card: Rainy Evening") < system.indexOf("## Current Scene: Test Story Scene"));

    // Renaming the story repoints every linked chapter.
    const renamed = await request("PUT", "/scenarios/test_story", { name: "Renamed Story" });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json.scenario.key, "renamed_story");
    scenarioKey = renamed.json.scenario.key;
    const linked = (await request("GET", "/scenes")).json.scenes.find((item) => item.key === sceneKey);
    assert.equal(linked.scenario, "renamed_story");

    // Deleting the story unlinks its chapters instead of deleting them.
    const deleted = await request("DELETE", "/scenarios/renamed_story");
    assert.equal(deleted.status, 200, deleted.text);
    assert.ok(deleted.json.scenesUpdated.includes(sceneKey));
    scenarioKey = null;
    const standalone = (await request("GET", "/scenes")).json.scenes.find((item) => item.key === sceneKey);
    assert.equal(standalone.scenario, null);

    const standaloneChat = await request("POST", "/chat", {
      agentNickname: "Mom",
      sceneName: sceneKey,
      message: "Still here?",
      activeCards: [],
    });
    assert.equal(standaloneChat.status, 200, standaloneChat.text);
    assert.doesNotMatch(lastSystemPrompt(), /## Scenario: /);
  } finally {
    if (sceneKey) await request("DELETE", `/scenes/${sceneKey}`);
    if (scenarioKey) await request("DELETE", `/scenarios/${scenarioKey}`);
  }
});

test("scenario scene list links and unlinks chapters in bulk", async () => {
  let scenarioKey = null;
  const sceneKeys = [];
  try {
    const created = await request("POST", "/scenarios", {
      name: "Bulk Chapter Story",
      premise: "A test story with several rooms in one house.",
    });
    assert.equal(created.status, 201, created.text);
    scenarioKey = created.json.scenario.key;
    // The link list is transient: it must never leak into the scenario YAML.
    assert.equal(created.json.scenario.extras.scenes, undefined);

    for (const name of ["Bulk Living Room", "Bulk Kitchen"]) {
      const scene = await request("POST", "/scenes", {
        name,
        description: `${name} description`,
        participants: ["Mom"],
        location: name,
      });
      assert.equal(scene.status, 201, scene.text);
      assert.equal(scene.json.scene.scenario, null);
      sceneKeys.push(scene.json.scene.key);
    }

    // Link both chapters at once, using a mix of display names and file keys.
    const linked = await request("PUT", `/scenarios/${scenarioKey}`, {
      scenes: ["Bulk Living Room", sceneKeys[1]],
    });
    assert.equal(linked.status, 200, linked.text);
    let scenes = (await request("GET", "/scenes")).json.scenes;
    assert.equal(scenes.find((scene) => scene.key === sceneKeys[0]).scenario, scenarioKey);
    assert.equal(scenes.find((scene) => scene.key === sceneKeys[1]).scenario, scenarioKey);

    // The newly linked chapter now receives the story foundation.
    const chat = await request("POST", "/chat", {
      agentNickname: "Mom",
      sceneName: sceneKeys[1],
      message: "Which room is this?",
      activeCards: [],
    });
    assert.equal(chat.status, 200, chat.text);
    assert.match(lastSystemPrompt(), /## Scenario: Bulk Chapter Story/);
    assert.match(lastSystemPrompt(), /## Current Scene: Bulk Kitchen/);

    // Memory files follow the same book → chapter → character hierarchy.
    const memoryDir = path.join(
      MEMORY_DIR,
      "scenarios",
      scenarioKey,
      sceneKeys[1],
      "mom",
    );
    assert.equal(fs.existsSync(memoryDir), true, "expected a scenario/scene/character memory folder");
    assert.ok(fs.readdirSync(memoryDir).some((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)));

    // Dropping a chapter from the list unlinks it without deleting the scene.
    const narrowed = await request("PUT", `/scenarios/${scenarioKey}`, {
      scenes: [sceneKeys[1]],
    });
    assert.equal(narrowed.status, 200, narrowed.text);
    scenes = (await request("GET", "/scenes")).json.scenes;
    assert.equal(scenes.find((scene) => scene.key === sceneKeys[0]).scenario, null);
    assert.equal(scenes.find((scene) => scene.key === sceneKeys[1]).scenario, scenarioKey);

    // An empty list unlinks every chapter; they stay usable as standalone scenes.
    const cleared = await request("PUT", `/scenarios/${scenarioKey}`, { scenes: [] });
    assert.equal(cleared.status, 200, cleared.text);
    scenes = (await request("GET", "/scenes")).json.scenes;
    assert.equal(scenes.find((scene) => scene.key === sceneKeys[1]).scenario, null);

    const unknown = await request("PUT", `/scenarios/${scenarioKey}`, {
      scenes: ["No Such Scene"],
    });
    assert.equal(unknown.status, 400);
  } finally {
    for (const key of sceneKeys) await request("DELETE", `/scenes/${key}`);
    if (scenarioKey) await request("DELETE", `/scenarios/${scenarioKey}`);
  }
});

test("The Arranged Marriage keeps story context across all three scenes", async () => {
  const story = (await request("GET", "/scenarios")).json.scenarios
    .find((scenario) => scenario.key === "the_arranged_marriage");
  assert.ok(story, "expected the acceptance scenario");
  assert.equal(story.name, "The Arranged Marriage");
  assert.equal(story.world_card, "The City of Little Moments");

  // The acceptance chapters may be reassigned in the live house; keep this test
  // self-contained by linking them to the acceptance story in the temp copy.
  const acceptanceChapters = [
    "the_first_meeting",
    "the_family_dinner",
    "the_private_conversation",
  ];
  const relinked = await request("PUT", `/scenarios/${story.key}`, {
    scenes: acceptanceChapters,
  });
  assert.equal(relinked.status, 200, relinked.text);

  const chapters = (await request("GET", "/scenes")).json.scenes
    .filter((scene) => scene.scenario === story.key);
  assert.deepEqual(
    chapters.map((scene) => scene.name).sort(),
    ["The Family Dinner", "The First Meeting", "The Private Conversation"],
    "all three acceptance scenes belong to one scenario",
  );

  const expected = [
    {
      scene: "The First Meeting",
      marker: "Tea is poured, small talk is stretched thin",
      tag: "Story situation: Meet-Cute",
    },
    {
      scene: "The Family Dinner",
      marker: "Dinner is laid out and the families trade stories",
      tag: "Story situation: Forced Proximity",
    },
    {
      scene: "The Private Conversation",
      marker: "cups cooling between them",
      tag: "Story situation: Confession",
    },
  ];

  const storySections = [];
  const sceneSections = [];
  for (const { scene, marker, tag } of expected) {
    const chat = await request("POST", "/chat", {
      agentNickname: "Priya",
      sceneName: scene,
      message: "What happens now?",
      activeCards: [],
    });
    assert.equal(chat.status, 200, chat.text);
    const system = lastSystemPrompt();
    const storySection = promptSection(system, "## Scenario: The Arranged Marriage");
    const sceneSection = promptSection(system, `## Current Scene: ${scene}`);

    // The story foundation survives every scene switch.
    assert.match(storySection, /The engagement ceremony is approaching/);
    assert.match(storySection, /Relationship dynamics: Nick and Priya begin as polite strangers/);
    assert.match(storySection, /Genre: Romance, Drama/);
    assert.match(storySection, /Relationship dynamics: Arranged Marriage, Slow Burn/);
    assert.match(storySection, /World & setting: Modern City/);
    // The immediate scene context changes per chapter.
    assert.match(sceneSection, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(sceneSection, new RegExp(tag));
    // Separate levels: scenario tags do not leak into the scene block.
    assert.doesNotMatch(sceneSection, /Relationship dynamics: Arranged Marriage/);
    assert.doesNotMatch(sceneSection, /World & setting: Modern City/);
    assert.doesNotMatch(storySection, /Conversation mood:/);
    // Character identity and the scenario world card stay available.
    assert.match(system, /You are Priya, a 27-year-old friend of Nick/);
    assert.match(system, /## Active Card: The City of Little Moments/);
    assert.ok(system.indexOf("## Scenario:") < system.indexOf("## Active Card:"));
    assert.ok(system.indexOf("## Active Card:") < system.indexOf("## Current Scene:"));

    storySections.push(storySection);
    sceneSections.push(sceneSection);
  }

  assert.equal(new Set(storySections).size, 1, "story foundation is identical across chapters");
  for (let i = 0; i < sceneSections.length; i += 1) {
    for (let j = 0; j < expected.length; j += 1) {
      if (i === j) continue;
      assert.equal(
        sceneSections[i].includes(expected[j].marker),
        false,
        `${expected[i].scene} must not inherit ${expected[j].scene} context`,
      );
    }
  }
});

test("memories: list scenario → scene → character groups and delete by path", async () => {
  const listed = await request("GET", "/memories");
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.json.scenarios));
  assert.ok(listed.json.scenarios.length > 0);

  const entries = listed.json.scenarios.flatMap((scenario) =>
    scenario.scenes.flatMap((scene) =>
      scene.characters.flatMap((character) =>
        character.memories.map((memory) => ({ scenario, scene, character, memory })),
      ),
    ),
  );
  const target = entries.find((entry) => entry.character.character.toLowerCase() === "mom") ?? entries[0];
  assert.ok(target, "expected a memory entry");
  assert.ok(target.memory.preview.length > 0);
  assert.match(target.memory.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(target.memory.path, "dashboard entries carry their vault-relative path");

  // Delete the temp memory by its hierarchy path, then confirm 404 on repeat.
  const deletedOnce = await request("DELETE", `/memories/${target.memory.path}`);
  assert.equal(deletedOnce.status, 200);
  const deletedTwice = await request("DELETE", `/memories/${target.memory.path}`);
  assert.equal(deletedTwice.status, 404);
  const badDate = await request("DELETE", "/memories/mom/2026-1-1");
  assert.equal(badDate.status, 400);
  const badPath = await request("DELETE", "/memories/scenarios/only_two/2026-01-01");
  assert.equal(badPath.status, 400);
});

test("memories: skips stray files and known non-memory vault folders", async () => {
  const legacyDir = path.join(MEMORY_DIR, "scenes");
  const scenarioDir = path.join(MEMORY_DIR, "scenarios", "notes_story");
  fs.mkdirSync(path.join(scenarioDir, "notes.md"), { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "notes.md"), "storyline notes, not a character memory");
  try {
    const listed = await request("GET", "/memories");
    assert.equal(listed.status, 200);
    const scenarioKeys = listed.json.scenarios.map((scenario) => scenario.scenario);
    assert.equal(scenarioKeys.includes("scenes"), false);
    assert.equal(scenarioKeys.includes("notes_story"), false);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(path.join(MEMORY_DIR, "scenarios", "notes_story"), { recursive: true, force: true });
  }
});

test("chat resolves scenes by key, display name, and Unicode name", async () => {
  const byKey = await request("POST", "/chat", {
    agentNickname: "Priya",
    sceneName: "the_rainy_veranda",
    message: "Rain?",
  });
  assert.equal(byKey.status, 200, byKey.text);

  const byDisplay = await request("POST", "/chat", {
    agentNickname: "Nick",
    sceneName: "Rainy Evening Veranda",
    message: "Rain?",
  });
  assert.equal(byDisplay.status, 200, byDisplay.text);

  const cafeKey = await request("POST", "/chat", {
    agentNickname: "Nick",
    sceneName: "the_corner_cafe",
    message: "Coffee?",
  });
  assert.equal(cafeKey.status, 200, cafeKey.text);

  const cafeDisplay = await request("POST", "/chat", {
    agentNickname: "Jordan",
    sceneName: "The Corner Café",
    message: "Coffee?",
  });
  assert.equal(cafeDisplay.status, 200, cafeDisplay.text);
});

test("scene extras, other participants, and world_card reach the prompt", async () => {
  const created = await request("POST", "/scenes", {
    name: "Prompt Veranda",
    description: "A prompt-fidelity test scene.",
    participants: ["Nick", "Priya"],
    world_card: "rainy_evening",
    tags: ["test"],
    interactions: ["stargazing"],
  });
  assert.equal(created.status, 201);

  const chat = await request("POST", "/chat", {
    agentNickname: "Priya",
    sceneName: "prompt_veranda",
    message: "hi",
    activeCards: [],
  });
  assert.equal(chat.status, 200, chat.text);

  const system = seenRequests.at(-1).messages.find((m) => m.role === "system").content;
  assert.match(system, /Tags: test/);
  assert.match(system, /Interactions: stargazing/);
  assert.match(system, /Active Card: Rainy Evening/, "scene world_card is always applied");
  const others = system.split("\n").find((line) => line.startsWith("Other agents present"));
  assert.equal(others, "Other agents present in this scene: Nick.");

  await request("DELETE", "/scenes/prompt_veranda");
});

test("write endpoints require JSON object bodies", async () => {
  const notJson = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ agentNickname: "Mom", message: "hi" }),
  });
  assert.equal(notJson.status, 415);

  const formEncoded = await fetch(`${BASE}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "name=Form+Card",
  });
  assert.equal(formEncoded.status, 415);

  const nullBody = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  assert.equal(nullBody.status, 400);
});

test("age below 18 is rejected, 18 is accepted", async () => {
  const tooYoung = await request("POST", "/characters", {
    nickname: "Young One",
    gender: "female",
    age: 17,
    personality: "test",
    appearance: "test",
  });
  assert.equal(tooYoung.status, 400);

  const adult = await request("POST", "/characters", {
    nickname: "Eighteen",
    gender: "female",
    age: 18,
    personality: "test",
    appearance: "test",
  });
  assert.equal(adult.status, 201);
  await request("DELETE", "/characters/eighteen");
});

test("character edits preserve optional roleplay fields", async () => {
  const created = await request("POST", "/characters", {
    nickname: "Extra Person",
    gender: "female",
    age: 30,
    personality: "p",
    appearance: "a",
    background: "grew up by the sea",
    speech_style: "dry",
    motivations: "finish the novel",
    relationship: "friend",
    behavior_rules: "never lies",
  });
  assert.equal(created.status, 201);

  const updated = await request("PUT", "/characters/extra_person", { age: 31 });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.agent.age, 31);
  assert.equal(updated.json.agent.background, "grew up by the sea");
  assert.equal(updated.json.agent.speech_style, "dry");
  assert.equal(updated.json.agent.motivations, "finish the novel");
  assert.equal(updated.json.agent.relationship, "friend");
  assert.equal(updated.json.agent.behavior_rules, "never lies");

  await request("DELETE", "/characters/extra_person");
});

test("scene edits and renames preserve author fields", async () => {
  const created = await request("POST", "/scenes", {
    name: "Extra Scene",
    participants: ["Mom"],
    tags: ["alpha"],
    interactions: ["beta"],
  });
  assert.equal(created.status, 201);

  const renamed = await request("PUT", "/scenes/extra_scene", {
    name: "Renamed Extra Scene",
    participants: ["Mom"],
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.scene.key, "renamed_extra_scene");

  const text = fs.readFileSync(path.join(HOUSE_SCENES, "renamed_extra_scene.yaml"), "utf8");
  assert.match(text, /tags:/);
  assert.match(text, /alpha/);
  assert.match(text, /interactions:/);
  assert.match(text, /beta/);

  await request("DELETE", "/scenes/renamed_extra_scene");
});

test("deleting a character cleans scene references", async () => {
  await request("POST", "/characters", {
    nickname: "Temp Friend",
    gender: "nonbinary",
    age: 25,
    personality: "temporary",
    appearance: "temporary",
  });
  await request("POST", "/scenes", { name: "Temp Solo", participants: ["Temp Friend"] });
  await request("POST", "/scenes", { name: "Temp Shared", participants: ["Temp Friend", "Mom"] });

  const deleted = await request("DELETE", "/characters/temp_friend");
  assert.equal(deleted.status, 200);
  assert.ok(deleted.json.scenesDeleted.includes("temp_solo"));
  assert.ok(deleted.json.scenesUpdated.includes("temp_shared"));
  assert.equal(fs.existsSync(path.join(HOUSE_SCENES, "temp_solo.yaml")), false);

  const scenes = await request("GET", "/scenes");
  assert.equal(scenes.json.scenes.some((scene) => scene.key === "temp_solo"), false);
  const shared = scenes.json.scenes.find((scene) => scene.key === "temp_shared");
  assert.deepEqual(shared.participants, ["Mom"]);

  await request("DELETE", "/scenes/temp_shared");
});

test("a malformed card file does not break card listing", async () => {
  const broken = path.join(HOUSE_CARDS, "broken_card.yaml");
  fs.writeFileSync(broken, "name: [unclosed\n", "utf8");
  try {
    const cards = await request("GET", "/cards");
    assert.equal(cards.status, 200);
    assert.equal(cards.json.cards.some((card) => card.key === "broken_card"), false);
  } finally {
    fs.rmSync(broken, { force: true });
  }
});

test("GET /tags serves the canonical catalog with target filtering", async () => {
  const all = await request("GET", "/tags");
  assert.equal(all.status, 200);
  assert.ok(all.json.categories.length >= 10, "expected the full tag catalog");
  const personality = all.json.categories.find((category) => category.id === "personality");
  assert.ok(personality.tags.some((tag) => tag.id === "personality.tsundere"));
  assert.ok(personality.tags.some((tag) => tag.id === "personality.shy"));

  const characters = await request("GET", "/tags?target=character");
  assert.equal(characters.status, 200);
  assert.ok(characters.json.categories.length > 0);
  assert.ok(characters.json.categories.every((category) => category.appliesTo.includes("character")));
  assert.equal(characters.json.categories.some((category) => category.id === "roleplay_format"), false);

  const badTarget = await request("GET", "/tags?target=planet");
  assert.equal(badTarget.status, 400);
});

test("character tag selections persist and reach the prompt", async () => {
  const created = await request("POST", "/characters", {
    nickname: "Taggy",
    gender: "female",
    age: 27,
    personality: "quiet but warm",
    appearance: "glasses and a cardigan",
    tag_selections: {
      personality: ["personality.shy", "personality.playful"],
      roles: ["roles.best_friend"],
      hair_eyes: ["hair_eyes.glasses"],
      roleplay_format: ["roleplay_format.pov"],
      deleted_category: ["deleted_category.gone"],
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.agent.tag_selections.personality, ["personality.shy", "personality.playful"]);
  assert.deepEqual(created.json.agent.tag_selections.deleted_category, ["deleted_category.gone"]);

  const stored = fs.readFileSync(path.join(HOUSE_CHARACTERS, "taggy.yaml"), "utf8");
  assert.match(stored, /tag_selections:/);
  assert.match(stored, /personality\.shy/);
  assert.match(stored, /deleted_category\.gone/);

  const chat = await request("POST", "/chat", { agentNickname: "Taggy", message: "Hello" });
  assert.equal(chat.status, 200, chat.text);
  const system = seenRequests.at(-1).messages.find((message) => message.role === "system").content;
  assert.match(system, /## Character Traits/);
  assert.match(system, /Personality: Shy, Playful/);
  assert.match(system, /Role: Best Friend/);
  assert.match(system, /Hair & eyes: Glasses/);
  assert.equal(system.includes("POV"), false, "non-applicable tags stay out of the prompt");

  const updated = await request("PUT", "/characters/taggy", {
    tag_selections: { emotional_traits: ["emotional_traits.gentle"] },
  });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(updated.json.agent.tag_selections, { emotional_traits: ["emotional_traits.gentle"] });
  await request("DELETE", "/characters/taggy");
});

test("scene tag selections persist and reach the prompt", async () => {
  const created = await request("POST", "/scenes", {
    name: "Tag Veranda",
    description: "A quiet test veranda.",
    participants: ["Mom"],
    tag_selections: {
      story_genres: ["story_genres.romance"],
      conversation_mood: ["conversation_mood.fluff"],
      style: ["style.gothic"],
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.scene.tag_selections.story_genres, ["story_genres.romance"]);

  const chat = await request("POST", "/chat", {
    agentNickname: "Mom",
    sceneName: "tag_veranda",
    message: "Nice evening.",
  });
  assert.equal(chat.status, 200, chat.text);
  const system = seenRequests.at(-1).messages.find((message) => message.role === "system").content;
  assert.match(system, /Genre: Romance/);
  assert.match(system, /Conversation mood: Fluff/);
  assert.equal(system.includes("Gothic"), false, "character/card-only tags are ignored on scenes");

  const updated = await request("PUT", "/scenes/tag_veranda", {
    tag_selections: { story_genres: ["story_genres.mystery"] },
  });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(updated.json.scene.tag_selections, { story_genres: ["story_genres.mystery"] });
  await request("DELETE", "/scenes/tag_veranda");
});

test("world card tags persist, edit, and reach the prompt", async () => {
  const created = await request("POST", "/cards", {
    name: "Tag Card",
    description: "A card used to test tags.",
    tag_selections: {
      story_genres: ["story_genres.mystery"],
      world_settings: ["world_settings.small_town"],
      roleplay_format: ["roleplay_format.pov"],
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.card.tag_selections.world_settings, ["world_settings.small_town"]);

  await request("POST", "/chat", {
    agentNickname: "Mom",
    message: "Where are we?",
    activeCards: ["tag_card"],
  });
  const system = seenRequests.at(-1).messages.find((message) => message.role === "system").content;
  assert.match(system, /Genre: Mystery/);
  assert.match(system, /World & setting: Small Town/);
  assert.equal(system.includes("POV"), false, "scene-only tags are ignored on cards");

  const updated = await request("PUT", "/cards/tag_card", {
    description: "Updated card lore.",
    tag_selections: { story_genres: ["story_genres.horror"] },
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.card.description, "Updated card lore.");
  assert.deepEqual(updated.json.card.tag_selections, { story_genres: ["story_genres.horror"] });
  const stored = fs.readFileSync(path.join(HOUSE_CARDS, "tag_card.yaml"), "utf8");
  assert.match(stored, /story_genres\.horror/);
  assert.equal(stored.includes("story_genres.mystery"), false);
  fs.rmSync(path.join(HOUSE_CARDS, "tag_card.yaml"), { force: true });
});

test("invalid tag selection payloads are rejected", async () => {
  const base = {
    nickname: "Bad Tags",
    gender: "nonbinary",
    age: 30,
    personality: "test",
    appearance: "test",
  };
  const notAnObject = await request("POST", "/characters", {
    ...base,
    tag_selections: ["personality.shy"],
  });
  assert.equal(notAnObject.status, 400);

  const notAList = await request("POST", "/characters", {
    ...base,
    tag_selections: { personality: "personality.shy" },
  });
  assert.equal(notAList.status, 400);
});

test("group chat: mentioned characters speak first and share named history", async () => {
  // Dedicated scene: the test must not depend on the user's current scene roster.
  const scene = await request("POST", "/scenes", {
    name: "Test Group Room",
    description: "A room used only by the group chat test.",
    participants: ["Dad", "Mom", "Alex"],
  });
  assert.equal(scene.status, 201);

  try {
    const before = seenRequests.length;
    const response = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        characterNicknames: ["Dad", "Mom", "Alex"],
        sceneName: "test_group_room",
        message: "Mom, what is for dinner?",
        history: [{ role: "assistant", content: "Earlier line.", name: "Dad" }],
      }),
    });
    assert.equal(response.status, 200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const done = lines.filter((line) => line.type === "done");
    assert.deepEqual(done.map((line) => line.speaker), ["Mom", "Dad", "Alex"]);
    assert.equal(done[0].text, "Mom replies.");
    assert.equal(done[1].text, "Dad replies.");
    assert.equal(done[2].text, "Alex replies.");

    const calls = seenRequests.slice(before);
    assert.equal(calls.length, 3, "one model call per speaking character");
    const firstSystem = calls[0].messages.find((message) => message.role === "system").content;
    assert.match(firstSystem, /You are Mom/);
    assert.match(firstSystem, /## Group Chat/);
    assert.match(firstSystem, /Never speak, act, or decide for another character/);

    // The second character sees the first reply in the same shared timeline.
    const assistantContents = calls[1].messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    assert.ok(assistantContents.includes("Dad: Earlier line."), "prior named history is labelled");
    assert.ok(assistantContents.includes("Mom: Mom replies."), "same-turn replies are visible");
  } finally {
    await request("DELETE", "/scenes/test_group_room");
  }
});

test("group chat suppresses duplicate replies", async () => {
  const response = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      characterNicknames: ["Mom", "Dad"],
      message: "@duplicate",
    }),
  });
  assert.equal(response.status, 200);
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.type === "done").length, 1);
  assert.equal(lines.filter((line) => line.type === "skip" && line.reason === "duplicate").length, 1);
});

test("group chat skips [PASS] replies and keeps no empty turns", async () => {
  const response = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      characterNicknames: ["Mom", "Dad"],
      message: "@pass",
    }),
  });
  assert.equal(response.status, 200);
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.type === "done").length, 0);
  assert.equal(lines.filter((line) => line.type === "skip" && line.reason === "pass").length, 2);
});

test("unknown routes return 404 JSON", async () => {
  const { status } = await request("GET", "/definitely-not-a-route");
  assert.equal(status, 404);
});

// Keep the servers only for this file's lifetime; closing as the final test.
test("suite cleanup closes servers", async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mockLmStudio.close(resolve));
  fs.rmSync(HOUSE_ROOT, { recursive: true, force: true });
  fs.rmSync(memoryRoot, { recursive: true, force: true });
});
