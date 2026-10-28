import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
let child;
let baseUrl;

function startServer(port = 3444) {
  child = spawn(process.execPath, [path.join(SERVER_ROOT, "index.js")], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LMSTUDIO_BASE_URL: "http://127.0.0.1:9/no-real-lmstudio",
      OBSIDIAN_VAULT_PATH: path.join(SERVER_ROOT, "workspace", "memory"),
      CORS_ORIGIN: "http://localhost:3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 3000);
    child.stdout.on("data", () => {
      clearTimeout(timer);
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function stopServer() {
  if (child) {
    child.kill();
    child = null;
  }
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Starts the server, runs the assertions, always stops the server.
async function withServer(port, run) {
  await startServer(port);
  try {
    await run();
  } finally {
    stopServer();
    await waitFor(100);
  }
}

test("[smoke] /health returns the status shape", async () => {
  await withServer(3444, async () => {
    const res = await fetch(`${baseUrl}/health`);
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.status, "ok");
    assert.equal(typeof payload.lmStudioBaseUrl, "string");
    assert.equal(typeof payload.model, "string");
  });
});

test("[smoke] /chat rejects oversized bodies", async () => {
  await withServer(3445, async () => {
    const tooLarge = JSON.stringify({ agentNickname: "Mom", message: "x".repeat(1024 * 1024 + 64) });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/chat`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(tooLarge.length) } }, (res) => {
        res.destroy();
        resolve(res.statusCode);
      });
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("request timed out"));
      });
      req.on("error", () => {
        resolve(400);
      });
      req.write(tooLarge);
      req.end();
    });
    assert.equal(result, 413);
  });
});

test("[smoke] /agents lists the configured house roster", async () => {
  await withServer(3446, async () => {
    const res = await fetch(`${baseUrl}/agents`);
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.ok(payload.count >= 7, `expected the house roster, got ${payload.count}`);
  });
});

test("[smoke] GET /unknown returns 404", async () => {
  await withServer(3447, async () => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});

test("[smoke] OPTIONS handles the CORS preflight", async () => {
  await withServer(3448, async () => {
    const res = await fetch(`${baseUrl}/health`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
  });
});
