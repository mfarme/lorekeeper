import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configValue, getGlobalConfig } from "@/lib/app-config";
import {
  DEFAULT_LEMONADE_IMAGE_MODEL,
  isLemonadeBaseUrl,
  lemonadeV1BaseUrl,
} from "@/lib/lemonade";
import { serverEnv } from "@/lib/server-env";
import type { AspectPreset, GeneratedImage, ImageMode } from "@/lib/types";

// OpenAI-compatible Images backend: by default this fork points at Lemonade's
// local `/v1/images/generations` endpoint, while the same adapter still works
// with OpenAI or another compatible proxy. Local Lemonade does not need an API
// key; remote OpenAI-compatible services can still use the admin/env key.
//
// Lemonade accepts b64_json responses and its image models use diffusion
// controls (`steps`, `cfg_scale`) rather than OpenAI quality tiers.

const DEFAULT_MODEL = "gpt-image-1";
const GENERATE_TIMEOUT_MS = 4 * 60 * 1000;

function resolveConfig() {
  const images = getGlobalConfig().images;
  const baseUrl = configValue(
    images.openaiBaseUrl,
    "OPENAI_IMAGE_BASE_URL",
    lemonadeV1BaseUrl(),
  ).replace(/\/+$/, "");
  const lemonade = isLemonadeBaseUrl(baseUrl);
  return {
    baseUrl,
    lemonade,
    model: configValue(
      images.openaiModel,
      "OPENAI_IMAGE_MODEL",
      lemonade
        ? serverEnv("LEMONADE_IMAGE_MODEL", DEFAULT_LEMONADE_IMAGE_MODEL)
        : DEFAULT_MODEL,
    ),
    // OPENAI_API_KEY as the last fallback because it is the name every other
    // tool trains people to set. Lemonade itself does not require one.
    apiKey:
      images.openaiApiKey.trim() ||
      serverEnv("OPENAI_IMAGE_API_KEY") ||
      serverEnv("OPENAI_API_KEY"),
  };
}

// Whether picking the "openai" backend can actually produce anything. The
// dispatcher checks this before enqueueing; local Lemonade needs no key, while
// hosted OpenAI-compatible endpoints still require one.
export function openAiImagesConfigured(): boolean {
  const config = resolveConfig();
  return config.lemonade || config.apiKey !== "";
}

// gpt-image-1 sizes; dall-e-3 uses its own pair for the non-square shapes.
function sizeFor(
  model: string,
  aspect: AspectPreset,
  lemonade: boolean,
): { size: string; width: number; height: number } {
  if (lemonade) {
    const defaults: Record<AspectPreset, [number, number]> = {
      square: [512, 512],
      portrait: [512, 768],
      landscape: [768, 512],
    };
    const configured = serverEnv("LEMONADE_IMAGE_SIZE", "").trim();
    const match = /^(\d+)x(\d+)$/.exec(configured);
    const [width, height] = match
      ? [Number(match[1]), Number(match[2])]
      : defaults[aspect];
    if (width > 0 && height > 0) {
      return { size: `${width}x${height}`, width, height };
    }
  }
  const dalle = model.startsWith("dall-e");
  if (aspect === "portrait") {
    return dalle
      ? { size: "1024x1792", width: 1024, height: 1792 }
      : { size: "1024x1536", width: 1024, height: 1536 };
  }
  if (aspect === "landscape") {
    return dalle
      ? { size: "1792x1024", width: 1792, height: 1024 }
      : { size: "1536x1024", width: 1536, height: 1024 };
  }
  return { size: "1024x1024", width: 1024, height: 1024 };
}

function promptSlug(prompt: string) {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "image"
  );
}

export async function generateOpenAiImage(options: {
  prompt: string;
  mode: ImageMode;
  aspect: AspectPreset;
  hasReferences?: boolean;
}): Promise<GeneratedImage> {
  const { baseUrl, lemonade, model, apiKey } = resolveConfig();
  if (!lemonade && !apiKey) {
    throw new Error(
      "The OpenAI-compatible image backend has no API key. Add one in Admin > Image generation, or point it at Lemonade.",
    );
  }

  const startedAt = Date.now();
  const { size, width, height } = sizeFor(model, options.aspect, lemonade);
  const body: Record<string, unknown> = {
    model,
    prompt: options.prompt,
    size,
    n: 1,
    response_format: "b64_json",
  };
  if (lemonade) {
    // Lemonade's stable-diffusion.cpp image route accepts these controls and
    // does not use OpenAI's paid quality tiers.
    const steps = Number.parseInt(serverEnv("LEMONADE_IMAGE_STEPS", "8"), 10);
    const cfgScale = Number.parseFloat(serverEnv("LEMONADE_IMAGE_CFG_SCALE", "1"));
    if (Number.isFinite(steps) && steps > 0) {
      body.steps = steps;
    }
    if (Number.isFinite(cfgScale) && cfgScale >= 0) {
      body.cfg_scale = cfgScale;
    }
  } else if (model.startsWith("dall-e")) {
    // dall-e-3 has its own quality names; b64_json keeps the response local.
    body.quality = options.mode === "slow" ? "hd" : "standard";
  } else {
    // The app's fast/slow dial maps onto gpt-image quality tiers; "high" is
    // several times the price of "medium", which is exactly what the slow
    // switch is for.
    body.quality = options.mode === "slow" ? "high" : "medium";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  let payload: {
    data?: Array<{ b64_json?: string; url?: string }>;
    error?: { message?: string };
  };
  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    payload = (await response.json().catch(() => ({}))) as typeof payload;
    if (!response.ok) {
      // The upstream message names the real problem (bad key, no billing,
      // moderation refusal) far better than a status code would.
      const detail = payload.error?.message || `the API answered ${response.status}`;
      throw new Error(`OpenAI-compatible image generation failed: ${detail}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenAI-compatible image generation timed out.");
    }
    if (error instanceof Error && error.message.startsWith("OpenAI-compatible image")) {
      throw error;
    }
    throw new Error(`Could not reach the OpenAI-compatible image API at ${baseUrl}.`);
  } finally {
    clearTimeout(timer);
  }

  const entry = payload.data?.[0];
  let bytes: Buffer | null = entry?.b64_json ? Buffer.from(entry.b64_json, "base64") : null;
  if (!bytes && entry?.url) {
    const download = await fetch(entry.url, { signal: AbortSignal.timeout(60_000) });
    if (download.ok) {
      bytes = Buffer.from(await download.arrayBuffer());
    }
  }
  if (!bytes?.length) {
    throw new Error("The OpenAI image API finished without returning an image.");
  }

  const generatedDir = path.join(process.cwd(), "public", "generated");
  mkdirSync(generatedDir, { recursive: true });
  const filename = `${Date.now()}-openai-${promptSlug(options.prompt)}.png`;
  writeFileSync(path.join(generatedDir, filename), bytes);

  return {
    id: crypto.randomUUID(),
    url: `/generated/${filename}`,
    prompt: options.prompt,
    mode: options.mode,
    backend: "openai",
    aspect: options.aspect,
    width,
    height,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    warnings: options.hasReferences
      ? ["Character reference images are not used by the OpenAI backend."]
      : undefined,
  };
}
