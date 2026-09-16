import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const {
  configuredMaxOutputTokens,
  dmMaxOutputTokens,
  requestCustomMessage,
  storyContextTokens,
} = await import("../src/lib/model-client.ts");

const names = [
  "LEMONADE_MAX_OUTPUT_TOKENS",
  "OPENAI_COMPAT_MAX_TOKENS",
  "OPENROUTER_MAX_TOKENS",
  "DM_MAX_OUTPUT_TOKENS",
  "LEMONADE_CONTEXT_TOKENS",
  "OPENAI_COMPAT_CONTEXT",
];
const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  assert.equal(configuredMaxOutputTokens(), 4096);
  assert.equal(dmMaxOutputTokens(), 2048);
  assert.equal(
    storyContextTokens({
      textProvider: "custom",
      localTextModel: "",
      customBaseUrl: "http://127.0.0.1:13305/v1",
      customModel: "Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6",
    }),
    262144,
  );

  process.env.LEMONADE_CONTEXT_TOKENS = "32768";
  assert.equal(
    storyContextTokens({
      textProvider: "custom",
      localTextModel: "",
      customBaseUrl: "http://127.0.0.1:13305/v1",
      customModel: "Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6",
    }),
    32768,
  );

  let capturedUrl = "";
  let capturedInit;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await requestCustomMessage(
      "http://127.0.0.1:13305/v1",
      "Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6",
      "",
      [{ role: "user", content: "hello" }],
      { thinking: false, maxOutputTokens: 1536 },
    );
    assert.equal(result.message?.content, "ok");
  } finally {
    globalThis.fetch = realFetch;
  }
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(capturedUrl, "http://127.0.0.1:13305/v1/chat/completions");
  assert.equal(body.max_tokens, 1536);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal("Authorization" in capturedInit.headers, false);
} finally {
  for (const name of names) {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }
}

console.log("test-model-guards: 8 passed");
