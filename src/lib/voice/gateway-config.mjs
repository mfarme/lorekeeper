export const DEFAULT_GATEWAY_PORT = 8765;

export function gatewayPort(value = process.env.VOICE_GATEWAY_PORT) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(1_024, Math.min(65_535, parsed))
    : DEFAULT_GATEWAY_PORT;
}
