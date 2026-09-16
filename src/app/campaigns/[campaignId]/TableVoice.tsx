"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CampaignState } from "@/app/campaigns/[campaignId]/useCampaignStream";
import type { NarrationAudio } from "@/app/campaigns/[campaignId]/useNarrationAudio";

const SAMPLE_RATE = 16_000;
const GATEWAY_PORT = 8_765;

// The worklet emits 100 ms PCM16 mono frames. It resamples instead of trusting
// a browser that silently ignores AudioContext({ sampleRate: 16000 }).
const CAPTURE_WORKLET = `
class LorekeeperCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.sourcePerTarget = sampleRate / this.targetRate;
    this.buffer = new Int16Array(1600);
    this.fill = 0;
    this.sumSquares = 0;
    this.sourceFrame = 0;
    this.nextTargetFrame = 0;
    this.previous = 0;
    this.hasPrevious = false;
  }
  emit(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.sumSquares += clamped * clamped;
    this.buffer[this.fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.fill === this.buffer.length) {
      this.port.postMessage({ type: 'pcm', buffer: this.buffer.slice(0), rms: Math.sqrt(this.sumSquares / this.fill) });
      this.fill = 0;
      this.sumSquares = 0;
    }
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];
      if (!this.hasPrevious) {
        this.previous = sample;
        this.hasPrevious = true;
        this.emit(sample);
        this.nextTargetFrame = this.sourcePerTarget;
      } else {
        while (this.nextTargetFrame <= this.sourceFrame) {
          const fraction = this.nextTargetFrame - (this.sourceFrame - 1);
          this.emit(this.previous + (sample - this.previous) * fraction);
          this.nextTargetFrame += this.sourcePerTarget;
        }
        this.previous = sample;
      }
      this.sourceFrame++;
    }
    return true;
  }
}
registerProcessor('lorekeeper-capture', LorekeeperCaptureProcessor);
`;

type VoiceStatus = "off" | "connecting" | "listening" | "error";
type VoiceMessage = { type?: string; [key: string]: unknown };

type TableVoiceProps = {
  campaignId: string;
  sheets: CampaignState["sheets"];
  defaultCharacterId: string;
  narration: NarrationAudio;
};

function gatewayUrl(campaignId: string, port: number, publicUrl: string | null): string {
  if (publicUrl) {
    const base = new URL(publicUrl, window.location.origin);
    const protocol = base.protocol === "https:" || base.protocol === "wss:" ? "wss:" : "ws:";
    const pathname = base.pathname.replace(/\/$/, "");
    const prefix = pathname.endsWith("/ws/audio") ? pathname : `${pathname}/ws/audio`;
    return `${protocol}//${base.host}${prefix}/${encodeURIComponent(campaignId)}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:${port}/ws/audio/${encodeURIComponent(campaignId)}`;
}

export function TableVoice({ campaignId, sheets, defaultCharacterId, narration }: TableVoiceProps) {
  const [status, setStatus] = useState<VoiceStatus>("off");
  const [characterId, setCharacterId] = useState(defaultCharacterId || sheets[0]?.id || "");
  const [interim, setInterim] = useState("");
  const [lastFinal, setLastFinal] = useState("");
  const [decision, setDecision] = useState("");
  const [error, setError] = useState("");
  const [gatewayPort, setGatewayPort] = useState(GATEWAY_PORT);
  const [gatewayPublicUrl, setGatewayPublicUrl] = useState<string | null>(null);
  const [audioStreamId, setAudioStreamId] = useState("");
  const [captureSettings, setCaptureSettings] = useState<Record<string, unknown> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const sampleCursorRef = useRef(0);
  const speakingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/voice-gateway/config", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (active && data && typeof data === "object" && "port" in data && typeof data.port === "number") {
          setGatewayPort(data.port);
          setGatewayPublicUrl("publicUrl" in data && typeof data.publicUrl === "string" ? data.publicUrl : null);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const selectedSheet = useMemo(
    () => sheets.find((sheet) => sheet.id === characterId) ?? null,
    [characterId, sheets],
  );

  const sendControl = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const stopSession = useCallback(() => {
    const node = workletRef.current;
    workletRef.current = null;
    node?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    void context?.close();
    if (workletUrlRef.current) URL.revokeObjectURL(workletUrlRef.current);
    workletUrlRef.current = null;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, "table voice stopped");
    speakingRef.current = false;
    setAudioStreamId("");
    setCaptureSettings(null);
    setInterim("");
    setStatus("off");
  }, []);

  const setupCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const trackSettings = stream.getAudioTracks()[0]?.getSettings();
      const appliedSettings: Record<string, unknown> = {
        echoCancellation: trackSettings?.echoCancellation ?? null,
        noiseSuppression: trackSettings?.noiseSuppression ?? null,
        autoGainControl: trackSettings?.autoGainControl ?? null,
        channelCount: trackSettings?.channelCount ?? null,
        sampleRate: trackSettings?.sampleRate ?? null,
      };
      setCaptureSettings(appliedSettings);
      sendControl({ type: "capture_settings", settings: appliedSettings });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contextRef.current = context;
      const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      workletUrlRef.current = workletUrl;
      await context.audioWorklet.addModule(workletUrl);
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "lorekeeper-capture", { numberOfInputs: 1, numberOfOutputs: 1 });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(context.destination);
      worklet.port.onmessage = (event: MessageEvent<{ type: string; buffer: Int16Array; rms: number }>) => {
        const ws = wsRef.current;
        if (event.data?.type !== "pcm" || !ws || ws.readyState !== WebSocket.OPEN || status === "error") return;
        const pcm = event.data.buffer;
        const rms = Number(event.data.rms) || 0;
        const now = Math.round(performance.now());
        if (rms > 0.03 && narration.playingMessageId && !speakingRef.current) {
          speakingRef.current = true;
          narration.pauseForInterruption();
          ws.send(JSON.stringify({ type: "bargein_local", client_monotonic_ms: now }));
        } else if (rms <= 0.03) {
          speakingRef.current = false;
        }
        const sequence = sequenceRef.current++;
        const sampleStart = sampleCursorRef.current;
        sampleCursorRef.current += pcm.length;
        ws.send(JSON.stringify({
          type: "audio_frame",
          sequence,
          sample_start: sampleStart,
          client_monotonic_ms: now,
          sample_rate: SAMPLE_RATE,
          channels: 1,
          format: "pcm16le",
          byte_length: pcm.byteLength,
        }));
        ws.send(pcm.buffer);
      };
      workletRef.current = worklet;
      await context.resume();
      setStatus("listening");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone permission or AudioWorklet setup failed.");
      stopSession();
      setStatus("error");
    }
  }, [narration, sendControl, status, stopSession]);

  const startSession = useCallback(() => {
    if (!selectedSheet) {
      setError("Choose a speaking character first.");
      return;
    }
    setError("");
    setDecision("");
    setInterim("");
    narration.unlock();
    setStatus("connecting");
    const ws = new WebSocket(gatewayUrl(campaignId, gatewayPort, gatewayPublicUrl));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => {
      sequenceRef.current = 0;
      sampleCursorRef.current = 0;
      ws.send(JSON.stringify({
        type: "hello",
        client_monotonic_ms: Math.round(performance.now()),
        capture_sample_rate: SAMPLE_RATE,
        characterId,
      }));
      ws.send(JSON.stringify({
        type: "tts_active",
        active: Boolean(narration.playingMessageId || narration.pausedMessageId),
      }));
      void setupCapture();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: VoiceMessage;
      try {
        message = JSON.parse(event.data) as VoiceMessage;
      } catch {
        setError("Voice gateway returned invalid JSON.");
        return;
      }
      if (message.type === "connected") {
        setAudioStreamId(String(message.audio_stream_id ?? ""));
      } else if (message.type === "ready") {
        setStatus("listening");
      } else if (message.type === "transcript") {
        const text = String(message.text ?? "");
        if (message.stage === "interim") setInterim(text);
        if (message.stage === "final") {
          setInterim("");
          setLastFinal(text);
        }
      } else if (message.type === "voice_decision") {
        setDecision(`${String(message.decision ?? "")} — ${String(message.reason ?? "")}`);
      } else if (message.type === "bargein_server") {
        narration.pauseForInterruption();
        setDecision("Speech detected; narration paused.");
      } else if (message.type === "tts_pause") {
        narration.pauseForInterruption();
        setDecision("Table paused; narration held.");
      } else if (message.type === "tts_cancel") {
        narration.stop();
        setDecision("Narration interrupted; listening.");
      } else if (message.type === "tts_resume") {
        narration.resume();
        setDecision("Narration resumed.");
      } else if (message.type === "error") {
        setError(String(message.detail ?? "Voice gateway error."));
      }
    };
    ws.onerror = () => {
      setError("Could not connect to the shared-table voice gateway.");
      stopSession();
      setStatus("error");
    };
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        setStatus((current) => (current === "error" ? current : "off"));
      }
    };
  }, [campaignId, characterId, gatewayPort, gatewayPublicUrl, narration, selectedSheet, setupCapture, stopSession]);

  useEffect(() => {
    sendControl({
      type: "tts_active",
      active: Boolean(narration.playingMessageId || narration.pausedMessageId),
    });
  }, [narration.pausedMessageId, narration.playingMessageId, sendControl]);

  useEffect(() => stopSession, [stopSession]);

  const statusLabel =
    status === "listening"
      ? "Listening"
      : status === "connecting"
        ? "Connecting"
        : status === "error"
          ? "Voice error"
          : "Voice off";

  return (
    <section className="pointer-events-auto w-[min(96vw,48rem)] rounded-2xl border border-amber-200/20 bg-stone-950/90 p-3 text-stone-200 shadow-2xl backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs font-medium uppercase tracking-[0.16em] text-amber-200/90">
          Table voice · {statusLabel}
        </span>
        <label className="flex items-center gap-2 text-xs text-stone-400">
          Speaking as
          <select
            value={characterId}
            onChange={(event) => setCharacterId(event.target.value)}
            disabled={status === "connecting" || status === "listening"}
            className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-stone-200"
          >
            {sheets.map((sheet) => (
              <option key={sheet.id} value={sheet.id}>{sheet.name}</option>
            ))}
          </select>
        </label>
        {status === "off" || status === "error" ? (
          <button type="button" onClick={startSession} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-stone-950">
            Start listening
          </button>
        ) : (
          <button type="button" onClick={stopSession} className="rounded-lg border border-stone-600 px-3 py-1.5 text-xs text-stone-300">
            Stop listening
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (!narration.unlocked) {
              narration.unlock();
              return;
            }
            narration.setMuted(!narration.muted);
          }}
          className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-300"
        >
          {narration.muted ? "Unmute DM" : "Mute DM"}
        </button>
      </div>
      <div className="mt-2 min-h-5 text-sm" aria-live="polite">
        {interim ? <span className="italic text-stone-500">{interim}</span> : lastFinal ? <span>{lastFinal}</span> : <span className="text-stone-600">The table is ready for speech.</span>}
      </div>
      {decision ? <p className="mt-1 text-[11px] text-amber-200/70">{decision}</p> : null}
      {audioStreamId ? <p className="mt-1 text-[10px] text-stone-700">audio stream active</p> : null}
      {captureSettings ? (
        <p className="mt-1 text-[10px] text-stone-500">
          mic settings · AEC {captureSettings.echoCancellation ? "on" : "off"} · NS {captureSettings.noiseSuppression ? "on" : "off"} · AGC {captureSettings.autoGainControl ? "on" : "off"}
        </p>
      ) : null}
      {error || narration.playbackError ? (
        <p className="mt-1 text-xs text-red-300" role="alert">{error || narration.playbackError}</p>
      ) : null}
    </section>
  );
}
