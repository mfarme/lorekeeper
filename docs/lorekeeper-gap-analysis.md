# Lorekeeper gap analysis: ODM fork

This document compares the local Lorekeeper specification with the
[Open Dungeon Master](https://github.com/Lebbitheplow/open-dungeon-master) codebase
used for this fork.

The short version: ODM is a much more complete 5E campaign/table application.
Lorekeeper is a different product priority: an autonomous DM for people sitting
around one table, with one shared microphone and screen. The fork should keep
ODM's rules, campaign, presentation, and admin machinery, then put a
Lemonade-first audio/conversation layer in front of it.

## Current fork baseline

Branch: `lemonade-primary`  
Commit: `2a957b1`  
Remote: `https://github.com/mfarme/lorekeeper/tree/lemonade-primary`

Default local inference plane:

| Capability | Lemonade endpoint | Default model |
|---|---|---|
| Chat | `/v1/chat/completions` | `Qwen3.6-35B-A3B-MTP-ROCmFP4-GGUF-STRIX-embF16-headQ6` |
| TTS | `/v1/audio/speech` | `kokoro-v1` |
| STT | `/v1/audio/transcriptions` | `Moonshine-Medium-Streaming` |
| Images | `/v1/images/generations` | `Z-Image-Turbo-TheNoise` |

The app talks to `http://127.0.0.1:13305/v1`; health checks use the Lemonade
server root. The OpenAI-compatible adapter can still target a hosted or other
local compatible server, and the legacy Ollama, ComfyUI, Kokoro, and
faster-whisper paths remain configurable.

Run the built fork:

```bash
cd /home/matt/Projects/lorekeeper-odm
npm run start:lemonade
```

The launcher checks Lemonade, creates `.env.server` with a local database key
if needed, and starts the production app at `http://localhost:3005`. It does
not install or supervise Lemonade; `lemond` remains an external prerequisite.

## Comparison

Status means:

- **Good** — ODM already meets the intent or is stronger than the spec in this area.
- **Partial** — the seam or a related feature exists, but not the Lorekeeper acceptance behavior.
- **Gap** — new product code is required.

| Lorekeeper requirement | ODM baseline / fork status | Assessment |
|---|---|---|
| Autonomous 5E DM with server-owned numbers | Tool-calling DM, deterministic SRD engines, clamped state, pending rolls, audit/undo, encounters, companions, and world/story engines | **Good** |
| One shared laptop, room mic, speakers, no operator | ODM is optimized for solo/multiplayer browser play; its live voice is a participant WebRTC/SFU feature and speech input is push-to-talk | **Gap** |
| Lemonade as local inference plane | Fork defaults chat, TTS, STT, and image generation to Lemonade's OpenAI-compatible API; the browser still calls Lorekeeper, never Lemonade | **Good for provider routing; partial for lifecycle** |
| Managed Lemonade runtime supervisor | The launcher performs a readiness check only. It does not install, load, restart, or resource-govern `lemond` | **Gap** |
| Streaming Moonshine STT with interim hypotheses | Fork normalizes browser WebM/Opus to finalized 16 kHz mono PCM16 WAV and calls the batch transcription endpoint | **Partial** |
| Binary AudioWorklet PCM over WSS | ODM currently uses browser media/WebRTC and blob-based push-to-talk capture; no Lorekeeper Audio Gateway with sequence/sample-clock frames | **Gap** |
| Acoustic echo cancellation and local barge-in | Browser voice infrastructure exists, but the Lorekeeper two-stage “duck immediately, decide semantically later” room-mic contract is not present | **Gap** |
| Speaker attribution/enrollment | ODM has user/character seats and voice-chat identity, but no one-mic diarization/enrollment pipeline with confidence-aware mechanical confirmation | **Gap** |
| Conversation Engine | ODM has turn-taking, spotlight, initiative, hand-raising, and DM tools; it does not yet implement the Lorekeeper intent classes and `IGNORE/WAIT/RESPOND/INTERRUPT_AND_RESPOND` policy over room speech | **Gap** |
| Natural physical-dice reports | ODM supports typed physical dice, server dice, and Pixels Bluetooth dice, with parked roll requests | **Good for dice sources; partial for spoken reports** |
| Conservative commitment/retraction and high-stakes confirmation | Existing pending-roll, lead controls, safety, audit, and DM turn machinery provide useful pieces; the voice commitment boundary is not yet wired | **Partial** |
| Commit-before-reveal and replayable canonical history | ODM persists turns, engines, audit entries, undo, snapshots, and SSE updates. Its canonical store is encrypted single-writer SQLite, not Lorekeeper's PostgreSQL immutable-events + projections + transactional outbox model | **Partial** |
| Campaign memory and retrieval | ODM has rolling summaries, MiniLM semantic recall, lore/facts/notes, context inspection, pins, and chapter LOD | **Good feature coverage; different storage contract** |
| Kokoro through Lemonade | Fork routes default TTS to Lemonade `/v1/audio/speech`, retaining standalone Kokoro as an override | **Good** |
| Interruptible low-latency TTS playback | ODM has sentence segmentation, a serial media queue, latest-only playback, mute, and retry behavior. A room-level AudioWorklet playback/ducking contract is still needed | **Partial** |
| Lemonade image generation | Fork defaults the OpenAI-compatible image backend to Lemonade with `Z-Image-Turbo-TheNoise`, diffusion steps, CFG scale, and local no-key behavior; ComfyUI remains selectable | **Good** |
| Lemonade-generated SFX/music | ODM has an ambience/music catalog and media queue, but not the Lorekeeper `AudioGenerationProvider` contract for generated SFX with provenance | **Partial** |
| Cinematic shared-screen presentation | ODM already has the table, scene art, maps, initiative, party state, conditions, ambience, handouts, and PWA layout | **Good** |
| Session Zero | ODM has guided character creation, campaign setup, world packs, rules settings, and a lobby; voice enrollment, table boundaries, and autonomous session initialization need a table-mode flow | **Partial** |
| Pause / End Session raw-audio semantics | ODM has safety and session controls, but Lorekeeper's explicit pause semantics and guaranteed raw-audio deletion/checkpoint contract need an audit | **Partial** |
| Local privacy/authentication | Encrypted local SQLite, username/password auth, optional Discord, admin controls, and no cloud telemetry are already present | **Good** |
| HTTPS/WSS LAN table deployment | ODM documents HTTPS for microphone/voice and supports LAN announcements; the single-laptop Lorekeeper gateway and certificate/bootstrap story are not implemented | **Partial** |
| Resource governor | ODM has a global serial media/GPU queue and background work, but not the P0–P6 audio-to-SFX priority governor or model residency policy | **Partial** |
| Diagnostics | ODM exposes capability probes, background-work visibility, context inspection, and application logs; the full audio correlation chain and latency budget from the spec are missing | **Partial** |
| Test/soak target | ODM has 206 passing test suites after this fork's additions. Audio fixtures, Playwright table E2E, real-hardware latency tests, 30-minute autonomous acceptance, and four-hour soak are still needed | **Partial** |

## What to preserve from ODM

Do not rebuild these from scratch:

1. The server-side 5E engines and tool boundary. This is the fork's strongest
   asset and directly satisfies Lorekeeper's “the narrator never owns the
   numbers” rule.
2. Campaigns, world packs, chapters, arcs, summaries, lore, NPCs, companions,
   maps, workshops, exports, auth, admin settings, audit/undo, and PWA table
   presentation.
3. The media queue and existing TTS segmentation. Add priority and room-table
   semantics rather than replacing working playback behavior.
4. The provider seam. Lemonade is the default local provider, not a domain
   dependency; hosted OpenAI-compatible, Ollama, ComfyUI, Kokoro, and Whisper
   overrides remain useful fallback/testing paths.

## Recommended build order for the actual Lorekeeper interface

### 1. Table mode, before more game features

Add a first-class shared-device table route that assumes one browser, one room
mic, one output device, and one active campaign session. Keep the existing
multiplayer table for remote groups. Do not make players operate separate
push-to-talk controls in the in-person path.

### 2. Audio risk spike

Implement the smallest real loop from the spec:

```text
browser AudioWorklet mic
→ AEC/NS/AGC settings readback
→ 16 kHz mono PCM frames over WSS
→ server Audio Gateway
→ Lemonade Moonshine streaming
→ trivial response policy
→ Lemonade Kokoro
→ AudioWorklet playback
→ human interruption
→ local duck + server stop
```

Record sample-clock metadata, interim/final transcript events, first-audio
latency, duck/stop latency, self-transcription, and false interruptions on the
actual laptop and Strix Halo.

### 3. Conversation Engine and attribution

Add provider-neutral interfaces for:

- `SpeakerAttributionProvider` and enrollment profiles;
- utterance/interim/final/canonical transcript lifecycle;
- deterministic intent cues;
- `TABLE_TIME`, `SCENE_TIME`, and `URGENT_TIME`;
- conservative commitment/retraction;
- `IGNORE`, `WAIT`, `RESPOND`, `INTERRUPT_AND_RESPOND`, and resume decisions.

Interim speech may prefetch context or duck narration, but it must not mutate
hard state or commit dice. Only a committed utterance enters the existing DM
turn/tool path.

### 4. Adapt ODM's state boundary rather than pretending SQLite is Postgres

Keep SQLite for this fork's current single-process product unless measurement
requires a migration. First make the invariants explicit: commit before reveal,
immutable audit/replay records, idempotent post-commit media/memory jobs, and
safe reconnect/resume. A future PostgreSQL adapter can then implement the
Lorekeeper event/projection contract behind `CampaignRepository`.

### 5. Add resource priorities and lifecycle ownership

Wrap the existing media queue with priorities: audio ingress/STT, active TTS,
conversation/DM, immediate retrieval, memory, image, and generated SFX. Add a
Lemonade capability/runtime adapter that can report model residency and degrade
safely. Keep lifecycle calls out of domain modules.

### 6. Ship the acceptance session, not a feature collage

The milestone is a 30-minute session with 3–4 people, one mic, natural
interruptions, physical dice, an unexpected plan, one rules challenge, one
high-stakes confirmation, one combat, one puzzle, and zero keyboard/mouse
intervention after start. The release gate should include a prerecorded-audio
E2E path plus a real hardware p50/p95 report.

## Sources

- Local canonical spec: `/home/matt/Projects/lorekeeper/LOREKEEPER_SPEC.md`
- Upstream ODM: `https://github.com/Lebbitheplow/open-dungeon-master`
- Fork branch: `https://github.com/mfarme/lorekeeper/tree/lemonade-primary`
