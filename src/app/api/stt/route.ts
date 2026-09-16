import { currentUser, unauthorized } from "@/lib/auth";
import { transcribeAudio } from "@/lib/stt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

// Proxies push-to-talk audio to the configured transcription service, with
// browser WebM normalized to PCM16 WAV when the service is Lemonade. Keeping
// the model endpoint server-side prevents browser access to the inference plane.
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File)) {
    return Response.json({ error: "Send audio as multipart field 'audio'." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Recording too long." }, { status: 413 });
  }

  const transcribed = await transcribeAudio(audio, audio.name || "speech.webm");
  if ("error" in transcribed) {
    return Response.json(
      { error: transcribed.error },
      { status: 502 },
    );
  }
  return Response.json({ text: transcribed.text });
}
