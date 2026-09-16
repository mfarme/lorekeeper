# Text backends

The Text Model panel in the sidebar picks the provider and model per story.
Narration streams in as the model writes it on every provider. This Lorekeeper
fork prefers the local Lemonade OpenAI-compatible endpoint; the legacy Ollama
provider and other compatible servers keep working.

## The default DM model: Qwen3.6-35B-A3B (Lemonade)

Campaign play defaults to Lemonade on `http://127.0.0.1:13305/v1` with the
exact model ID `Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6`. Lemonade
owns model loading and recipe settings. The app only needs the server ready:

```bash
curl -sS -X POST http://127.0.0.1:13305/api/v1/load \
  -H 'Content-Type: application/json' \
  -d '{"model_name":"Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6"}'
```

Then run `npm run start:lemonade`. The same Lemonade host supplies TTS,
Moonshine STT, and the OpenAI-compatible `Z-Image-Turbo-TheNoise` image route.

The Lemonade Qwen model has a **262,144-token (256K) native context window**.
ODM uses that full window for the context trace and reserves 2,048 tokens for a
reply. The DM separately caps generated narration at 2,048 tokens by default;
that output cap is not a reduction of the model's context window. Set
`LEMONADE_CONTEXT_TOKENS` or `DM_MAX_OUTPUT_TOKENS` only when intentionally
trading context or response length for resource use. Lemonade turns send
`enable_thinking: false` by default; `DM_THINKING=1` opts into hidden reasoning.


Prefer Ollama? The same model is committed as a Modelfile with the context
and samplers baked in; build it and point the app at
`http://127.0.0.1:11434/v1`:

```bash
ollama pull qwen3.6:35b-a3b-q8_0
ollama create qwen3.6-dm -f models/qwen3.6-dm.Modelfile
```

## Local models (legacy "Local" provider, Ollama)

The app uses the Gemma 4 quantization-aware-trained (QAT, Q4_0) builds, which
keep close to full-precision quality at a fraction of the memory. Any of
these work — pull what fits your RAM:

```bash
ollama pull gemma4:e2b-it-qat       # 4.3 GB
ollama pull gemma4:e4b-it-qat       # 6.1 GB
ollama pull gemma4:12b-it-qat       # 7.2 GB
ollama pull gemma4:26b-a4b-it-qat   # 16 GB
ollama pull gemma4:31b-it-qat       # 19 GB (default when none is configured)
```

Measured on an M2 Max (32 GB), real story prompts, ~300-token turns. RAM is
resident memory from `ollama ps` at the app's context settings (the E-models
stream per-layer embeddings, so they sit below their download size):

| Model | Disk | RAM | Context | Generation | Typical turn | Cold load |
|---|---|---|---|---|---|---|
| E2B | 4.3 GB | 4.5 GB | 128K | 56 tok/s | 3.4 s | ~7 s |
| E4B | 6.1 GB | 3.2 GB | 128K | 44 tok/s | 3.8 s | ~9 s |
| 12B | 7.2 GB | 7.7 GB | 256K | 21 tok/s | 11.5 s | ~9 s |
|| 26B MoE | 16 GB | 15 GB | 256K | 48 tok/s | 4.7 s | ~30 s |

The app runs each local model at its full native context window by default. Gemma 4
uses sliding-window attention for most layers, so the KV cache stays small —
the 12B measured ~7.6 GB of RAM even with 50K+ tokens of story in context.

The 26B MoE is both the strongest writer and nearly the fastest (only ~4B
params active per token), but wants headroom: prefer 24 GB+ RAM, more if you
run local image generation alongside it.

Two implementation notes baked into the app:

- Gemma 4 is a hybrid reasoning model; the app disables its thinking channel
  (`think: false`) so the whole token budget goes to story text. Models that
  don't support the flag are retried without it.
- If a local model's chat template doesn't support function tools, the turn
  is retried without the image tool, so the story continues without auto
  images.

## Connect a server

The default llama-server setup above uses this provider. Switch a story's
provider to **Connect a server** in the Text Model panel to point it at any
OpenAI-compatible backend: llama.cpp, LM Studio, vLLM, TabbyAPI, KoboldCpp, a
remote Ollama, or **OpenRouter**. Enter:

- **Backend URL** — your server's address. A bare host
  (`http://127.0.0.1:8080`), a versioned base (`.../v1`), or the full
  `.../chat/completions` endpoint all work. Quick-fill buttons set the URL
  for OpenRouter, LM Studio, llama.cpp, and Ollama.
- **Model** — whatever model name your server expects. For OpenRouter, paste
  an id from [openrouter.ai/models](https://openrouter.ai/models).
- **API key** — optional, right in the panel. Most local servers need none;
  OpenRouter does.

### OpenAI and other strict vendor APIs

"OpenAI-compatible" covers two different things: a local server that ignores
fields it does not recognise, and a vendor API that answers 400 for any
unrecognised argument. ODM's request body grew around the former, so the
fields that make the local Qwen preset behave are the ones OpenAI rejects.
The backend URL decides which body gets sent
(`describeEndpoint` in `src/lib/dm/sampling-logic.ts`):

| | local server | OpenRouter | OpenAI |
|---|---|---|---|
| `top_k`, `min_p`, `repeat_penalty` | sent | stripped | stripped |
| `chat_template_kwargs` (thinking mode) | sent | sent | not sent |
| output cap field | `max_tokens` | `max_tokens` | `max_completion_tokens` |
| `presence_penalty: 0` | sent | sent | not sent |

For OpenAI, set the **Backend URL** to `https://api.openai.com/v1`, the
**Model** to whatever you pay for, and paste your key in the **API key**
field (or set `OPENAI_COMPAT_API_KEY`). Nothing else needs changing.

Two of those rows are why a paid key works. Reasoning models dropped
`max_tokens` in favour of `max_completion_tokens`, and they reject
`presence_penalty` outright; `chat_template_kwargs` is how ODM asks llama.cpp
and vLLM for thinking mode, and a vendor API has no chat template to pass it
to. The thinking request is simply not made against OpenAI, which costs
nothing there: it exists because Qwen is an unreliable tool caller without it,
not because the DM needs it.

Anything ODM does not recognise by host is treated as a permissive local
server. If such a backend turns out to be strict, the first 400 that names a
field is handled rather than failing the turn: that one field is dropped and
the request is retried, up to three times, and the drop is logged. Tool
support is deliberately excluded from that path, because a backend without
function calling is already handled by the retry-without-tools fallback.

Note that the DM leans on tools heavily, so a model with weak function
calling will narrate past its dice no matter which backend serves it.

You can enter everything in-app and store it locally with the story. The Mac
DMG and `Launch.command` can also save first-run defaults to `.env.server`:
`DEFAULT_TEXT_PROVIDER=custom`, `OPENAI_COMPAT_BASE_URL`, and
`OPENAI_COMPAT_MODEL`. If you'd rather keep keys out of the UI, leave the
field blank and set an env var instead — `OPENROUTER_API_KEY` (and optional
`OPENROUTER_MODEL`) for OpenRouter, or `OPENAI_COMPAT_API_KEY` for any other
server. The narrator's `generate_image` tool is sent when your server
advertises tool support; if it doesn't, the turn is retried without it so the
story still flows.

## Long-story memory

Story history is packed into the context window with a token budget that
stays ~10% under the limit. When a story finally outgrows the window, the
oldest passages are evicted in blocks of 16 — keeping the prompt prefix
append-only so Ollama's prompt cache makes each turn pay only for its new
tokens — and the evicted passages are folded into a rolling "story so far"
summary (the same handoff-summary approach Codex CLI uses for context
compaction, adapted for fiction). The narrator keeps plot threads, character
details, debts, and secrets even after the raw text has scrolled out of
context.

Deep prefill is the one real cost of huge contexts (~160 tok/s at 50K depth
on the 12B), and it only bites when the cache goes cold on a very long story;
set `LOCAL_TEXT_CONTEXT` to cap the window if you'd rather bound that.
Windows caps the default local context at 65K tokens for smoother first-run
behavior, but you can still set `LOCAL_TEXT_CONTEXT` higher if your machine
has the headroom.
