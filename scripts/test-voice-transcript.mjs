import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `lorekeeper-voice-${randomUUID()}.sqlite`);
process.env.SQLITE_DB_PATH = dbPath;
register("./lib/register-alias.mjs", import.meta.url);
const { getDatabase } = await import("../src/lib/db/core.ts");
const { insertTranscriptLines, listTranscriptSince } = await import("../src/lib/db/voice-transcript.ts");
const db = getDatabase();
const columns = db.prepare("PRAGMA table_info(voice_transcript)").all().map((row) => row.name);
for (const column of [
  "text_raw",
  "utterance_id",
  "audio_stream_id",
  "speech_span_id",
  "audio_start_sample",
  "audio_end_sample",
  "stt_confidence",
  "speaker_confidence",
  "speaker_is_enrolled",
  "audio_metadata_json",
]) assert.equal(columns.includes(column), true, `missing ${column}`);

db.pragma("foreign_keys = OFF");
const utteranceId = randomUUID();
insertTranscriptLines("test-campaign", "test-user", [{
  speaker: "Ariadne",
  text: "Search the room.",
  textRaw: " um, Search   the room. ",
  utteranceId,
  audioStreamId: "stream-1",
  speechSpanId: "span-1",
  audioStartSample: 3200,
  audioEndSample: 48_000,
  sttConfidence: 0.93,
  speakerConfidence: 0.42,
  speakerEnrolled: false,
  audioMetadata: { sampleRate: 16_000, format: "pcm16le" },
  startedAt: new Date().toISOString(),
  clockLabel: "midnight",
}]);
const rows = listTranscriptSince("test-campaign", "1970-01-01T00:00:00.000Z");
assert.equal(rows.length, 1);
assert.equal(rows[0].utteranceId, utteranceId);
assert.equal(rows[0].textRaw, " um, Search   the room. ");
assert.deepEqual(rows[0].audioMetadata, { sampleRate: 16_000, format: "pcm16le" });
assert.equal(rows[0].audioStartSample, 3200);
assert.equal(rows[0].sttConfidence, 0.93);
console.log("test-voice-transcript: 16 passed");
try { db.close(); } catch { /* test database cleanup is best effort */ }
rmSync(dbPath, { force: true });
