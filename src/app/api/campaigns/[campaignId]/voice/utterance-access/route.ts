import { isErrorResponse, requireVoice } from "@/lib/campaign-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The audio sidecar calls this before opening a provider session. It keeps
// campaign membership/mute validation in the authoritative Next process while
// the sidecar remains stateless with respect to game data.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireVoice(campaignId);
  if (isErrorResponse(context)) return context;
  return Response.json(
    { ok: true, userId: context.user.id },
    { headers: { "Cache-Control": "no-store" } },
  );
}
