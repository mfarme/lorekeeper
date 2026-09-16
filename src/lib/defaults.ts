import { DEFAULT_LOCAL_TEXT_MODEL } from "@/lib/text-models";
import {
  DEFAULT_LEMONADE_BASE_URL,
  DEFAULT_LEMONADE_TEXT_MODEL,
} from "@/lib/lemonade";
import type { StorySettings } from "@/lib/types";

export const DEFAULT_CHAT_TITLE = "Untitled story";

export const DEFAULT_STORY_SETTINGS: StorySettings = {
  world:
    "A grounded interactive fiction scene with sharp dialogue, human stakes, and space for the player to steer the story.",
  style:
    "Classic text-adventure narration: direct second person, vivid but restrained prose, natural dialogue, and no purple exposition.",
  // Default DM model is the user's Lemonade/lemond stack on :13305 via its
  // OpenAI-compatible /v1 endpoint. The legacy llama.cpp :8001 shape remains
  // configurable through the campaign/admin settings. Context size and
  // samplers live in Lemonade's model recipe, not in domain state. Any API key
  // comes from .env.server, never code.
  textProvider: "custom",
  localTextModel: DEFAULT_LOCAL_TEXT_MODEL,
  customBaseUrl: `${DEFAULT_LEMONADE_BASE_URL}/v1`,
  customModel: DEFAULT_LEMONADE_TEXT_MODEL,
  customApiKey: "",
  // OFF by default: a second model is a hardware luxury, so the shipped
  // default keeps everything on the story model. Set utilityModel in the
  // campaign's model settings to split the mechanical work off. On the Ollama
  // side "Gemma4:e4b-it-qat" (~3 GB resident) pairs well with a llama-server
  // story model, since the two processes hold their weights independently and
  // neither evicts the other's prompt cache.
  utilityProvider: "local",
  utilityModel: "",
  utilityBaseUrl: "",
  utilityApiKey: "",
  imageMode: "fast",
  // The Lemonade image endpoint implements the OpenAI-compatible generation
  // contract, so it is the primary local backend for this fork. ComfyUI and
  // hosted OpenAI-compatible services remain selectable per campaign.
  imageBackend: "openai",
  comfyUrl: "",
  comfyCheckpoint: "CyberRealisticXLPlay_V6.0.safetensors",
  aspect: "square",
  imageGenerationEnabled: true,
  autoImages: true,
  proseSize: "medium",
};

export function titleFromInput(input: string) {
  const compact = input.replace(/\s+/g, " ").trim();
  if (!compact) {
    return DEFAULT_CHAT_TITLE;
  }

  return compact.length > 58 ? `${compact.slice(0, 55).trim()}...` : compact;
}
