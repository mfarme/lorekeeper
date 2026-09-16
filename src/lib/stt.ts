import { spawn } from "node:child_process";
import { configValue, getGlobalConfig } from "@/lib/app-config";
import {
  DEFAULT_LEMONADE_STT_MODEL,
  isLemonadeBaseUrl,
  lemonadeBaseUrl,
} from "@/lib/lemonade";
import { serverEnv } from "@/lib/server-env";

// Speech to text uses Lemonade's OpenAI-compatible transcription endpoint by
// default. A legacy faster-whisper service remains supported through STT_URL.
// Lemonade's file endpoint expects a PCM16 WAV, while browsers normally send
// WebM/Opus from MediaRecorder, so the Lemonade path normalizes at this server
// boundary before forwarding audio.

export function sttUrl(): string {
  return configValue(
    getGlobalConfig().speech.sttUrl,
    "STT_URL",
    lemonadeBaseUrl(),
  ).replace(/\/+$/, "");
}

export function sttAvailable(): boolean {
  return Boolean(sttUrl());
}

export function finalizePcmWavHeader(bytes: Buffer): Buffer {
  // WAV streamed to a pipe uses an unknown-length sentinel. Lemonade's
  // Moonshine parser requires concrete RIFF and data chunk sizes, so finalize
  // both fields after ffmpeg has emitted the complete buffer.
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return bytes;
  }
  bytes.writeUInt32LE(Math.min(bytes.length - 8, 0xffffffff), 4);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "data") {
      bytes.writeUInt32LE(
        Math.min(bytes.length - offset - 8, 0xffffffff),
        offset + 4,
      );
      break;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }
  return bytes;
}

function transcodeToPcmWav(audio: Blob): Promise<Blob> {
  return audio.arrayBuffer().then(
    (arrayBuffer) =>
      new Promise<Blob>((resolve, reject) => {
        const child = spawn(
          serverEnv("FFMPEG_BIN", "ffmpeg"),
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const output: Buffer[] = [];
        let diagnostics = "";
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill("SIGKILL");
          reject(new Error("Audio normalization timed out."));
        }, 60_000);

        child.stdout?.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString();
        });
        child.once("error", (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });
        child.once("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(diagnostics.trim() || `ffmpeg exited with code ${code ?? "unknown"}.`));
            return;
          }
          const bytes = finalizePcmWavHeader(Buffer.concat(output));
          const copy = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          resolve(new Blob([copy], { type: "audio/wav" }));
        });

        child.stdin?.end(Buffer.from(arrayBuffer));
      }),
  );
}

async function prepareAudio(
  audio: Blob,
  filename: string,
  lemonade: boolean,
): Promise<{ audio: Blob; filename: string }> {
  if (!lemonade) {
    return { audio, filename };
  }
  return { audio: await transcodeToPcmWav(audio), filename: "speech.wav" };
}

export async function transcribeAudio(
  audio: Blob,
  filename = "ring.webm",
): Promise<{ text: string } | { error: string }> {
  const base = sttUrl();
  if (!base) {
    return { error: "This server has no transcription service configured." };
  }

  const lemonade = isLemonadeBaseUrl(base);
  let prepared: { audio: Blob; filename: string };
  try {
    prepared = await prepareAudio(audio, filename, lemonade);
  } catch {
    return { error: "Microphone audio could not be normalized for Lemonade." };
  }

  const form = new FormData();
  form.append("file", prepared.audio, prepared.filename);
  form.append(
    "model",
    lemonade
      ? serverEnv("LEMONADE_STT_MODEL", DEFAULT_LEMONADE_STT_MODEL)
      : serverEnv("STT_MODEL", "distil-large-v3"),
  );
  form.append("response_format", "json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { error: `The transcriber answered ${response.status}.` };
    }
    const data = (await response.json().catch(() => ({}))) as { text?: string };
    return { text: String(data.text ?? "").trim() };
  } catch {
    return { error: "The transcriber could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}
