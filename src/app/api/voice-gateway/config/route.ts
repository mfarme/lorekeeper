import { serverEnv } from "@/lib/server-env";
import { gatewayPort } from "@/lib/voice/gateway-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const port = gatewayPort(serverEnv("VOICE_GATEWAY_PORT", "8765"));
  const publicUrl = serverEnv("VOICE_GATEWAY_PUBLIC_URL", "").trim() || null;
  return Response.json({ port, publicUrl }, { headers: { "Cache-Control": "no-store" } });
}
