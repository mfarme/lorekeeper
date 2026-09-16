import { serverEnv } from "@/lib/server-env";

// Lemonade is the local inference plane for the Lorekeeper fork. Keep the
// server root separate from its OpenAI-compatible /v1 namespace because the
// same root serves chat, audio, health, and model-control endpoints.
export const DEFAULT_LEMONADE_BASE_URL = "http://127.0.0.1:13305";
export const DEFAULT_LEMONADE_TEXT_MODEL =
  "Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6";
export const DEFAULT_LEMONADE_TTS_MODEL = "kokoro-v1";
export const DEFAULT_LEMONADE_STT_MODEL = "Moonshine-Medium-Streaming";
export const DEFAULT_LEMONADE_IMAGE_MODEL = "Z-Image-Turbo-TheNoise";

/** Normalize a Lemonade root or /v1 base to the server root. */
export function normalizeLemonadeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

/** Resolve the configured Lemonade root without ever exposing a secret. */
export function lemonadeBaseUrl(): string {
  return normalizeLemonadeBaseUrl(
    serverEnv("LEMONADE_BASE_URL", DEFAULT_LEMONADE_BASE_URL),
  );
}

/** The OpenAI-compatible namespace used for chat, models, and embeddings. */
export function lemonadeV1BaseUrl(): string {
  return `${lemonadeBaseUrl()}/v1`;
}

/** True when a service URL points at the configured Lemonade server. */
export function isLemonadeBaseUrl(value: string): boolean {
  return normalizeLemonadeBaseUrl(value) === lemonadeBaseUrl();
}

/** Resolve a model preference, falling back to the fork's live-stack default. */
export function lemonadeModel(envKey: string, fallback: string): string {
  return serverEnv(envKey, fallback).trim();
}
