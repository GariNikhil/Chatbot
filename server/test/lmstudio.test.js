import test from "node:test";
import assert from "node:assert/strict";
import { streamChatCompletion } from "../lib/lmstudio.js";

test("streams OpenAI-compatible SSE without an automatic zero timeout", async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal;
  globalThis.fetch = async (_url, options) => {
    receivedSignal = options.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const chunks = [];
    const result = await streamChatCompletion({ model: "test", messages: [], onDelta: (text) => chunks.push(text), baseUrl: "http://test/v1" });
    assert.equal(receivedSignal, undefined);
    assert.equal(result, "Hello");
    assert.deepEqual(chunks, ["Hello"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});