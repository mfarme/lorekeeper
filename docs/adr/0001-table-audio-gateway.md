# ADR 0001: Keep the table-audio gateway as a sidecar

- Status: accepted
- Date: 2026-09-16

## Decision

Run the shared-table PCM/WebSocket gateway as a sibling process to the single
Next.js/SQLite application. Keep Next.js authoritative for authentication,
campaign membership, floor state, campaign messages, DM turns, events, and TTS.
The gateway owns only a browser audio session and a Lemonade Moonshine realtime
connection. It forwards finalized utterances to an authenticated Next route.

## Why this is an exception

The application must remain a single SQLite writer and a single campaign-state
authority, but Next App Router route handlers do not own a WebSocket upgrade
server. A custom Next entrypoint would make production builds and Docker
lifecycle more fragile. A small sidecar gives the table microphone a true
binary streaming path without introducing a second game database or DM engine.

This is deliberately a process boundary, not a service boundary: the launcher
starts both processes, the gateway has no persistent game state, and the route
preflight validates the session before a provider session is opened. The
reverse proxy terminates TLS and forwards `/ws/audio/*` to the sidecar.

## Consequences

- There is one additional localhost/TCP port (`8765` by default) and a gateway
  health check.
- Remote tables must use HTTPS/WSS, an exact `VOICE_GATEWAY_ORIGINS` allowlist,
  and `VOICE_GATEWAY_PUBLIC_URL` when the gateway is behind a proxy.
- Gateway session state is intentionally ephemeral. Canonical final utterance
  metadata is persisted by Next in `voice_transcript`; raw audio is not.
- The existing WebRTC/mediasoup remote voice path remains separate and is not
  repurposed as a server PCM source.
- A future custom Node entrypoint may collapse the process boundary, but only
  after it preserves single-writer semantics and has equivalent lifecycle and
  upgrade tests.
