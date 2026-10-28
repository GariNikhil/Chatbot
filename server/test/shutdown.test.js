// Verifies Settings ▸ End session: POST /shutdown acknowledges, then the
// server process exits cleanly. Runs in its own child process so the shared
// integration-test server is not affected.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("POST /shutdown stops the server process", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      // Unroutable LM Studio: the server must still start and shut down.
      LMSTUDIO_BASE_URL: "http://127.0.0.1:9/v1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const base = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !output.includes("listening on")) {
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  assert.match(output, /listening on/, `server did not start:\n${output}`);

  // Same CSRF guard as the other write endpoints: plain text is rejected and
  // the server keeps running.
  const rejected = await fetch(`${base}/shutdown`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "stop",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(rejected.status, 415);
  assert.equal(child.exitCode, null, "server must stay up after a rejected request");

  const response = await fetch(`${base}/shutdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "stopping" });

  const exitCode = await Promise.race([
    exited,
    sleep(5000).then(() => "timeout"),
  ]);
  assert.equal(exitCode, 0, `server did not exit cleanly:\n${output}`);
});
