#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { gatewayPort } from "../src/lib/voice/gateway-config.mjs";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(".env.server");
loadEnvFile(".env.local");

const DEFAULT_GATEWAY_HOST = "0.0.0.0";
const DEFAULT_NEXT_BASE_URL = "http://127.0.0.1:3005";
const DEFAULT_LEMONADE_BASE_URL = "http://127.0.0.1:13305";
const DEFAULT_STT_MODEL = "Moonshine-Medium-Streaming";
const SAMPLE_RATE = 16_000;
const MAX_PENDING_PCM = 32;
const MAX_TEXT_CHARS = 2_000;
const STT_CONNECT_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;

export function gatewayPath(campaignId) {
  return `/ws/audio/${encodeURIComponent(campaignId)}`;
}

export function campaignIdFromPath(pathname) {
  const match = /^\/ws\/audio\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function allowedOrigin(origin) {
  if (!origin) return false;
  const configuredValues = process.env.VOICE_GATEWAY_ORIGINS ?? process.env.APP_PUBLIC_URL ?? "";
  const configured = configuredValues
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const normalized = origin.replace(/\/$/, "");
  if (configured.length > 0) return new Set(configured).has(normalized);
  const defaults = new Set([
    "http://localhost:3005",
    "http://127.0.0.1:3005",
    "https://localhost:3005",
    "https://127.0.0.1:3005",
  ]);
  return defaults.has(normalized);
}

export function lemonadeRealtimeUrl(baseUrl, model = DEFAULT_STT_MODEL) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/realtime`;
  url.search = new URLSearchParams({ model }).toString();
  return url.toString();
}

export function turnDetectionSettings() {
  return {
    type: "session.update",
    session: {
      model: process.env.LEMONADE_STT_MODEL || DEFAULT_STT_MODEL,
      turn_detection: {
        threshold: 0.01,
        silence_duration_ms: 800,
        prefix_padding_ms: 250,
      },
    },
  };
}

function jsonMessage(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function nowMs() {
  return Math.round(performance.now());
}

function normalizeCaptureSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value;
  return Object.fromEntries(
    ["echoCancellation", "noiseSuppression", "autoGainControl", "channelCount", "sampleRate"]
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

class TableAudioSession {
  constructor(socket, request, campaignId) {
    this.socket = socket;
    this.request = request;
    this.campaignId = campaignId;
    this.cookie = request.headers.cookie ?? "";
    this.stt = null;
    this.sttReady = false;
    this.sttConnectPromise = null;
    this.accessPromise = null;
    this.pendingPcm = [];
    this.closed = false;
    this.paused = false;
    this.narrationActive = false;
    this.characterId = null;
    this.audioStreamId = crypto.randomUUID();
    this.audioSequence = 0;
    this.lastFrame = null;
    this.speechSpanId = null;
    this.speechStartSample = null;
    this.speechStartedAt = null;
    this.interimText = "";
    this.captureSettings = {};
    this.pendingConfirmationToken = null;
    this.finalChain = Promise.resolve();

    socket.on("message", (data, isBinary) => {
      void this.handleMessage(data, isBinary).catch((error) => {
        const detail = error instanceof Error ? error.message : "voice gateway request failed";
        jsonMessage(this.socket, { type: "error", detail });
        this.close();
      });
    });
    socket.on("close", () => this.close());
    socket.on("error", (error) => {
      console.warn("[voice-gateway] browser socket error", error.message);
      this.close();
    });
  }

  async start() {}

  async handleMessage(data, isBinary) {
    if (this.closed) return;
    if (isBinary) {
      if (this.paused) return;
      const pcm = Buffer.from(data);
      if (pcm.length === 0 || pcm.length > SAMPLE_RATE * 2) {
        jsonMessage(this.socket, { type: "error", detail: "PCM frame must be 1–1000 ms" });
        return;
      }
      await this.sendPcm(pcm);
      return;
    }

    let message;
    try {
      message = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      jsonMessage(this.socket, { type: "error", detail: "invalid control JSON" });
      return;
    }
    if (!message || typeof message !== "object") {
      jsonMessage(this.socket, { type: "error", detail: "control message must be an object" });
      return;
    }

    switch (message.type) {
      case "hello":
        await this.handleHello(message);
        break;
      case "audio_frame":
        this.handleFrameMetadata(message);
        break;
      case "tts_active":
        this.narrationActive = message.active === true;
        break;
      case "capture_settings":
        this.captureSettings = normalizeCaptureSettings(message.settings);
        jsonMessage(this.socket, { type: "capture_settings_applied", settings: this.captureSettings });
        break;
      case "bargein_local":
        jsonMessage(this.socket, {
          type: "bargein_local_ack",
          client_monotonic_ms: message.client_monotonic_ms ?? null,
        });
        break;
      case "pause":
        this.paused = true;
        jsonMessage(this.socket, { type: "paused" });
        break;
      case "resume":
        this.paused = false;
        jsonMessage(this.socket, { type: "resumed" });
        break;
      default:
        jsonMessage(this.socket, { type: "error", detail: `unknown control type: ${String(message.type)}` });
    }
  }

  async handleHello(message) {
    if (message.capture_sample_rate !== undefined && message.capture_sample_rate !== SAMPLE_RATE) {
      jsonMessage(this.socket, { type: "error", detail: "capture must be 16 kHz PCM16 mono" });
      return;
    }
    this.characterId = typeof message.characterId === "string" ? message.characterId : null;
    await this.ensureAccess();
    jsonMessage(this.socket, {
      type: "connected",
      audio_stream_id: this.audioStreamId,
      sample_rate: SAMPLE_RATE,
      campaign_id: this.campaignId,
    });
    await this.ensureStt();
    jsonMessage(this.socket, {
      type: "ready",
      audio_stream_id: this.audioStreamId,
      sample_rate: SAMPLE_RATE,
      stt_model: process.env.LEMONADE_STT_MODEL || DEFAULT_STT_MODEL,
    });
  }

  handleFrameMetadata(message) {
    if (message.sample_rate !== SAMPLE_RATE || message.channels !== 1 || message.format !== "pcm16le") {
      jsonMessage(this.socket, { type: "error", detail: "audio_frame metadata must describe 16 kHz mono PCM16" });
      return;
    }
    this.lastFrame = {
      sequence: Number.isInteger(message.sequence) ? message.sequence : this.audioSequence,
      sampleStart: Number.isInteger(message.sample_start) ? message.sample_start : null,
      byteLength: Number.isInteger(message.byte_length) ? message.byte_length : 0,
      clientMonotonicMs: Number.isFinite(message.client_monotonic_ms) ? message.client_monotonic_ms : null,
    };
  }

  async ensureAccess() {
    if (this.accessPromise) return this.accessPromise;
    this.accessPromise = fetch(
      `${process.env.NEXT_BASE_URL || DEFAULT_NEXT_BASE_URL}/api/campaigns/${encodeURIComponent(this.campaignId)}/voice/utterance-access`,
      {
        headers: { Cookie: this.cookie },
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      },
    ).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Voice access denied (${response.status})`);
      return body;
    }).finally(() => {
      this.accessPromise = null;
    });
    return this.accessPromise;
  }

  async ensureStt() {
    if (this.sttReady) return;
    if (this.sttConnectPromise) return this.sttConnectPromise;
    this.sttConnectPromise = new Promise((resolve, reject) => {
      const url = lemonadeRealtimeUrl(
        process.env.LEMONADE_BASE_URL || DEFAULT_LEMONADE_BASE_URL,
        process.env.LEMONADE_STT_MODEL || DEFAULT_STT_MODEL,
      );
      const stt = new WebSocket(url, { perMessageDeflate: false });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stt.close();
          reject(new Error("Moonshine realtime connection timed out"));
        }
      }, STT_CONNECT_TIMEOUT_MS);
      stt.on("open", () => {
        // Lemonade sends session.created first. The update is safe immediately
        // after open and keeps VAD settings explicit for every session.
        stt.send(JSON.stringify(turnDetectionSettings()));
      });
      stt.on("message", (data) => {
        void this.handleSttMessage(data, resolve, reject, () => {
          settled = true;
          clearTimeout(timer);
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : "Moonshine event handling failed";
          jsonMessage(this.socket, { type: "error", detail });
          this.close();
        });
      });
      stt.on("close", () => {
        this.sttReady = false;
        if (!this.closed) jsonMessage(this.socket, { type: "error", detail: "Moonshine realtime session closed" });
      });
      stt.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        if (!this.closed) jsonMessage(this.socket, { type: "error", detail: "Moonshine realtime session failed" });
      });
      this.stt = stt;
    }).finally(() => {
      this.sttConnectPromise = null;
    });
    return this.sttConnectPromise;
  }

  async handleSttMessage(data, resolve, reject, settle) {
    let event;
    try {
      event = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      return;
    }
    const type = event.type ?? "";
    if (type === "session.created") {
      this.sttReady = true;
      settle();
      resolve();
      for (const pcm of this.pendingPcm.splice(0)) this.sendPcm(pcm);
      return;
    }
    if (type === "error") {
      const detail = typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? event);
      if (!this.sttReady) {
        settle();
        reject(new Error(detail));
      }
      jsonMessage(this.socket, { type: "error", detail: `Moonshine: ${detail}` });
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.speechSpanId = crypto.randomUUID();
      this.speechStartSample = this.lastFrame?.sampleStart ?? null;
      this.speechStartedAt = new Date().toISOString();
      this.interimText = "";
      jsonMessage(this.socket, {
        type: "speech_started",
        server_monotonic_ms: nowMs(),
        speech_span_id: this.speechSpanId,
      });
      if (this.narrationActive) {
        jsonMessage(this.socket, { type: "bargein_server", reason: "server speech started" });
      }
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const endSample = this.lastFrame?.sampleStart !== null && this.lastFrame?.sampleStart !== undefined
        ? this.lastFrame.sampleStart + Math.floor((this.lastFrame.byteLength || 0) / 2)
        : null;
      jsonMessage(this.socket, { type: "speech_stopped", server_monotonic_ms: nowMs(), speech_span_id: this.speechSpanId, audio_end_sample: endSample });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const delta = String(event.delta ?? event.transcript ?? "");
      this.interimText = `${this.interimText}${delta}`.slice(-MAX_TEXT_CHARS);
      jsonMessage(this.socket, { type: "transcript", stage: "interim", text: this.interimText });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      this.finalChain = this.finalChain.then(() => this.handleFinalTranscript(String(event.transcript ?? ""), event.confidence));
      await this.finalChain;
    }
  }

  async sendPcm(pcm) {
    if (!this.sttReady || !this.stt || this.stt.readyState !== WebSocket.OPEN) {
      if (this.pendingPcm.length >= MAX_PENDING_PCM) this.pendingPcm.shift();
      this.pendingPcm.push(pcm);
      return;
    }
    this.audioSequence += 1;
    this.stt.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    }));
  }

  async handleFinalTranscript(text, confidence) {
    const rawText = text.slice(0, MAX_TEXT_CHARS);
    const clean = rawText.replace(/\s+/g, " ").trim();
    this.interimText = "";
    if (!clean) return;
    const utteranceId = crypto.randomUUID();
    const numericConfidence = typeof confidence === "number" ? confidence : Number(confidence);
    const sttConfidence = Number.isFinite(numericConfidence) ? numericConfidence : null;
    const frame = this.lastFrame;
    jsonMessage(this.socket, {
      type: "transcript",
      stage: "final",
      text: clean,
      utterance_id: utteranceId,
      audio_stream_id: this.audioStreamId,
      speech_span_id: this.speechSpanId,
      audio_start_sample: this.speechStartSample,
      audio_end_sample: frame?.sampleStart !== null && frame?.sampleStart !== undefined
        ? frame.sampleStart + Math.floor((frame.byteLength || 0) / 2)
        : null,
      audio_sequence: frame?.sequence ?? this.audioSequence,
      stt_confidence: sttConfidence,
      capture_settings: this.captureSettings,
    });
    const response = await fetch(
      `${process.env.NEXT_BASE_URL || DEFAULT_NEXT_BASE_URL}/api/campaigns/${encodeURIComponent(this.campaignId)}/voice/utterance`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
        body: JSON.stringify({
          text: rawText,
          textRaw: rawText,
          characterId: this.characterId,
          narrationActive: this.narrationActive,
          utteranceId,
          audioStreamId: this.audioStreamId,
          speechSpanId: this.speechSpanId,
          audioStartSample: this.speechStartSample,
          audioEndSample: frame?.sampleStart !== null && frame?.sampleStart !== undefined
            ? frame.sampleStart + Math.floor((frame.byteLength || 0) / 2)
            : null,
          sttConfidence,
          captureSettings: this.captureSettings,
          audioMetadata: {
            sampleRate: SAMPLE_RATE,
            channels: 1,
            format: "pcm16le",
            audioSequence: frame?.sequence ?? this.audioSequence,
            clientMonotonicMs: frame?.clientMonotonicMs ?? null,
          },
          confirmationToken: this.pendingConfirmationToken,
          startedAt: this.speechStartedAt,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    ).catch((error) => ({ ok: false, status: 502, json: async () => ({ error: error.message }) }));
    const body = await response.json().catch(() => ({ error: "Unreadable voice-route response" }));
    if (!response.ok) {
      jsonMessage(this.socket, { type: "error", detail: body.error || `Voice route failed (${response.status})` });
      if (this.narrationActive) {
        this.narrationActive = true;
        jsonMessage(this.socket, { type: "tts_resume", reason: "voice route rejected utterance" });
      }
      return;
    }
    jsonMessage(this.socket, { type: "voice_decision", ...body });
    if (typeof body.confirmationToken === "string" && body.confirmationRequired === true) {
      this.pendingConfirmationToken = body.confirmationToken;
    } else if (body.confirmed === true || body.confirmationCancelled === true) {
      this.pendingConfirmationToken = null;
    }
    if (body.pause === true) {
      this.narrationActive = false;
      jsonMessage(this.socket, { type: "tts_pause", reason: "explicit spoken pause" });
    } else if (body.interrupt === true) {
      this.narrationActive = false;
      jsonMessage(this.socket, { type: "tts_cancel", reason: "semantic interruption" });
    } else if (body.decision === "resume_prior_output") {
      this.narrationActive = true;
      jsonMessage(this.socket, { type: "tts_resume" });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pendingPcm = [];
    if (this.stt) {
      this.stt.close();
      this.stt = null;
    }
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(4003, "voice session closed");
    }
  }
}

export function createGatewayServer() {
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: SAMPLE_RATE * 2,
    perMessageDeflate: false,
  });
  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "voice-gateway", sample_rate: SAMPLE_RATE }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://voice-gateway.invalid");
    const campaignId = campaignIdFromPath(url.pathname);
    if (!campaignId || !allowedOrigin(request.headers.origin ?? "") || !request.headers.cookie) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request, campaignId);
    });
  });

  wss.on("connection", (socket, request, campaignId) => {
    const session = new TableAudioSession(socket, request, campaignId);
    void session.start();
  });
  return { httpServer, wss };
}

export async function startGateway() {
  const host = process.env.VOICE_GATEWAY_HOST || DEFAULT_GATEWAY_HOST;
  const port = gatewayPort();
  const { httpServer } = createGatewayServer();
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  console.log(`[voice-gateway] listening on ${host}:${port}`);
  return httpServer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startGateway().catch((error) => {
    console.error(`[voice-gateway] failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
