// Lemonade's ffmpeg pipe emits unknown WAV sizes; the adapter finalizes
// them before forwarding audio to Moonshine.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const { finalizePcmWavHeader } = await import("../src/lib/stt.ts");

const wav = Buffer.alloc(48);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(0xffffffff, 4);
wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(0xffffffff, 40);
wav.writeInt16LE(0, 44);
wav.writeInt16LE(0, 46);

const finalized = finalizePcmWavHeader(wav);
assert.equal(finalized.readUInt32LE(4), 40);
assert.equal(finalized.readUInt32LE(40), 4);
assert.equal(finalized.toString("ascii", 0, 4), "RIFF");
assert.equal(finalized.toString("ascii", 8, 12), "WAVE");

const invalid = Buffer.from("not wav");
assert.deepEqual(finalizePcmWavHeader(invalid), invalid);
console.log("test-stt: 2 passed");
