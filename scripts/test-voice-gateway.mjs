import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const gateway = await import("./voice-gateway.mjs");
const config = await import("../src/lib/voice/gateway-config.mjs");

assert.equal(gateway.campaignIdFromPath("/ws/audio/camp%2Fone"), "camp/one");
assert.equal(gateway.campaignIdFromPath("/ws/audio/camp"), "camp");
assert.equal(gateway.campaignIdFromPath("/ws/audio"), null);
assert.equal(gateway.gatewayPath("camp one"), "/ws/audio/camp%20one");
assert.equal(gateway.lemonadeRealtimeUrl("http://127.0.0.1:13305", "Moonshine-Medium-Streaming"), "ws://127.0.0.1:13305/v1/realtime?model=Moonshine-Medium-Streaming");
assert.equal(gateway.lemonadeRealtimeUrl("https://example.test/base/", "Moonshine-Medium-Streaming"), "wss://example.test/base/v1/realtime?model=Moonshine-Medium-Streaming");
assert.deepEqual(gateway.turnDetectionSettings(), {
  type: "session.update",
  session: {
    model: "Moonshine-Medium-Streaming",
    turn_detection: { threshold: 0.01, silence_duration_ms: 800, prefix_padding_ms: 250 },
  },
});

const savedOrigins = process.env.VOICE_GATEWAY_ORIGINS;
const savedPublicUrl = process.env.APP_PUBLIC_URL;
delete process.env.VOICE_GATEWAY_ORIGINS;
delete process.env.APP_PUBLIC_URL;
assert.equal(gateway.allowedOrigin("http://localhost:3005"), true);
assert.equal(gateway.allowedOrigin("http://192.168.1.10:3005"), false);
assert.equal(gateway.allowedOrigin("http://192.168.1.10:8765"), false);
assert.equal(gateway.allowedOrigin("http://evil.invalid"), false);
process.env.VOICE_GATEWAY_ORIGINS = "https://table.example,https://localhost:3005";
assert.equal(gateway.allowedOrigin("https://table.example"), true);
assert.equal(gateway.allowedOrigin("https://evil.example:3005"), false);
if (savedOrigins === undefined) delete process.env.VOICE_GATEWAY_ORIGINS;
else process.env.VOICE_GATEWAY_ORIGINS = savedOrigins;
if (savedPublicUrl === undefined) delete process.env.APP_PUBLIC_URL;
else process.env.APP_PUBLIC_URL = savedPublicUrl;

assert.equal(config.gatewayPort("18765"), 18765);
assert.equal(config.gatewayPort("1"), 1024);
assert.equal(config.gatewayPort("not-a-port"), config.DEFAULT_GATEWAY_PORT);

console.log("test-voice-gateway: 16 passed");
