import { getDatabase, nowIso } from "@/lib/db/core";
import type { TranscriptLine } from "@/lib/voice/transcript";

// Transcript lines (docs/vtt-parity-implementation-plan.md 13.3): what
// was said at a transcribed table, by whom, and when on both clocks. Never fed
// to the DM prompt. Raw audio is not retained; metadata is.

type Row = {
  id: string;
  user_id: string;
  speaker: string;
  text: string;
  text_raw: string | null;
  utterance_id: string | null;
  audio_stream_id: string | null;
  speech_span_id: string | null;
  audio_start_sample: number | null;
  audio_end_sample: number | null;
  stt_confidence: number | null;
  speaker_confidence: number;
  speaker_is_enrolled: number;
  audio_metadata_json: string | null;
  clock_label: string;
  started_at: string;
  created_at: string;
};

function metadataFromRow(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function insertTranscriptLines(campaignId: string, userId: string, lines: TranscriptLine[]): number {
  const db = getDatabase();
  const now = nowIso();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO voice_transcript (
      id, campaign_id, user_id, speaker, text, text_raw, utterance_id,
      audio_stream_id, speech_span_id, audio_start_sample, audio_end_sample,
      stt_confidence, speaker_confidence, speaker_is_enrolled,
      audio_metadata_json, clock_label, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const line of lines) {
      insert.run(
        crypto.randomUUID(),
        campaignId,
        userId,
        line.speaker.slice(0, 80),
        line.text.slice(0, 1200),
        (line.textRaw ?? line.text).slice(0, 2000),
        line.utteranceId?.slice(0, 100) ?? null,
        line.audioStreamId?.slice(0, 100) ?? null,
        line.speechSpanId?.slice(0, 100) ?? null,
        line.audioStartSample ?? null,
        line.audioEndSample ?? null,
        line.sttConfidence ?? null,
        line.speakerConfidence ?? 0,
        line.speakerEnrolled ? 1 : 0,
        JSON.stringify(line.audioMetadata ?? {}),
        line.clockLabel.slice(0, 160),
        line.startedAt,
        now,
      );
    }
  })();
  return lines.length;
}

export function listTranscriptSince(campaignId: string, sinceIso: string, limit = 400): TranscriptLine[] {
  const rows = getDatabase()
    .prepare(`SELECT * FROM voice_transcript WHERE campaign_id = ? AND started_at > ? ORDER BY started_at ASC LIMIT ?`)
    .all(campaignId, sinceIso, limit) as Row[];
  return rows.map((row) => ({
    speaker: row.speaker,
    text: row.text,
    textRaw: row.text_raw ?? row.text,
    utteranceId: row.utterance_id ?? undefined,
    audioStreamId: row.audio_stream_id ?? undefined,
    speechSpanId: row.speech_span_id ?? undefined,
    audioStartSample: row.audio_start_sample,
    audioEndSample: row.audio_end_sample,
    sttConfidence: row.stt_confidence,
    speakerConfidence: row.speaker_confidence,
    speakerEnrolled: row.speaker_is_enrolled === 1,
    audioMetadata: metadataFromRow(row.audio_metadata_json),
    startedAt: row.started_at,
    clockLabel: row.clock_label,
  }));
}

export function countTranscriptLines(campaignId: string): number {
  const row = getDatabase().prepare(`SELECT COUNT(*) AS n FROM voice_transcript WHERE campaign_id = ?`).get(campaignId) as { n: number };
  return row.n;
}
