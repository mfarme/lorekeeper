import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const {
  DEFAULT_LEMONADE_BASE_URL,
  DEFAULT_LEMONADE_IMAGE_MODEL,
  DEFAULT_LEMONADE_STT_MODEL,
  DEFAULT_LEMONADE_TEXT_MODEL,
  DEFAULT_LEMONADE_TTS_MODEL,
  isLemonadeBaseUrl,
  lemonadeBaseUrl,
  lemonadeV1BaseUrl,
  normalizeLemonadeBaseUrl,
} = await import("../src/lib/lemonade.ts");

assert.equal(DEFAULT_LEMONADE_BASE_URL, "http://127.0.0.1:13305");
assert.equal(
  DEFAULT_LEMONADE_TEXT_MODEL,
  "Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6",
);
assert.equal(DEFAULT_LEMONADE_TTS_MODEL, "kokoro-v1");
assert.equal(DEFAULT_LEMONADE_STT_MODEL, "Moonshine-Medium-Streaming");
assert.equal(DEFAULT_LEMONADE_IMAGE_MODEL, "Z-Image-Turbo-TheNoise");
assert.equal(normalizeLemonadeBaseUrl("http://127.0.0.1:13305/v1/"), DEFAULT_LEMONADE_BASE_URL);
assert.equal(lemonadeBaseUrl(), DEFAULT_LEMONADE_BASE_URL);
assert.equal(lemonadeV1BaseUrl(), "http://127.0.0.1:13305/v1");
assert.equal(isLemonadeBaseUrl("http://127.0.0.1:13305/v1"), true);
assert.equal(isLemonadeBaseUrl("http://127.0.0.1:13306"), false);
console.log("test-lemonade: 9 passed");
