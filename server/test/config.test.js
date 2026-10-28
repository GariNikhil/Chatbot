import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig, loadEnvFile } from "../lib/config.js";

test("loadEnvFile parses quoted values without overwriting process env", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "Chatbot-config-"));
  const file = path.join(directory, ".env");
  await fs.writeFile(file, 'LMSTUDIO_BASE_URL="http://example.test/v1"\nAI_HOUSE_TEST=from-file\n', "utf8");
  const original = process.env.AI_HOUSE_TEST;
  delete process.env.AI_HOUSE_TEST;
  try {
    loadEnvFile(file);
    assert.equal(process.env.LMSTUDIO_BASE_URL, "http://example.test/v1");
    assert.equal(process.env.AI_HOUSE_TEST, "from-file");
  } finally {
    if (original === undefined) delete process.env.AI_HOUSE_TEST;
    else process.env.AI_HOUSE_TEST = original;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("getConfig uses the documented LM Studio variable", () => {
  const config = getConfig({ LMSTUDIO_BASE_URL: "http://test/v1", LMSTUDIO_MODEL: "test-model" });
  assert.equal(config.lmStudioBaseUrl, "http://test/v1");
  assert.equal(config.defaultModel, "test-model");
});