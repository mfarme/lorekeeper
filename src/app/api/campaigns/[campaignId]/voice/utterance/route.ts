import { z } from "zod";
import { isErrorResponse, requireVoice, steersStory } from "@/lib/campaign-api";
import { describeInstant } from "@/lib/dm/calendar";
import { dmTurnBusy, requestDmTurn } from "@/lib/dm/loop";
import {
  allocateSeq,
  campaignSeats,
  canAct,
  getFloor,
  setFloor,
  type Floor,
} from "@/lib/db/campaigns";
import { getActiveEncounter } from "@/lib/db/encounters";
import { insertCampaignMessage } from "@/lib/db/messages";
import { getSheetForUser, listSheets } from "@/lib/db/sheets";
import { insertTranscriptLines } from "@/lib/db/voice-transcript";
import { hasHumanDm } from "@/lib/dm/viewer";
import { coverInEffect } from "@/lib/dm/delegation";
import { publishEphemeral, publishPersisted, publishWithSeq } from "@/lib/events";
import {
  VoiceDecision,
  decideVoiceResponse,
  isVoiceCancellation,
  isVoiceConfirmation,
  normalizeVoiceText,
  type VoiceDecisionResult,
  type VoiceSceneTime,
} from "@/lib/voice/conversation-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const utteranceSchema = z.object({
  text: z.string().min(1).max(2_000),
  textRaw: z.string().min(1).max(2_000).optional(),
  characterId: z.string().trim().min(1).max(200).optional(),
  narrationActive: z.boolean().default(false),
  utteranceId: z.string().trim().min(1).max(100).optional(),
  audioStreamId: z.string().trim().min(1).max(100).optional(),
  speechSpanId: z.string().trim().min(1).max(100).optional(),
  audioStartSample: z.number().int().nonnegative().nullable().optional(),
  audioEndSample: z.number().int().nonnegative().nullable().optional(),
  sttConfidence: z.number().min(0).max(1).nullable().optional(),
  speakerConfidence: z.number().min(0).max(1).optional(),
  speakerEnrolled: z.boolean().optional(),
  captureSettings: z.record(z.string(), z.unknown()).optional(),
  audioMetadata: z.record(z.string(), z.unknown()).optional(),
  confirmationToken: z.string().trim().min(1).max(120).nullable().optional(),
  startedAt: z.string().trim().max(80).optional(),
});

type PendingConfirmation = {
  token: string;
  userId: string;
  characterId: string;
  actionText: string;
  expiresAt: number;
};

const pendingConfirmations = new Map<string, PendingConfirmation>();
const CONFIRMATION_TTL_MS = 60_000;

function confirmationKey(campaignId: string, userId: string): string {
  return `${campaignId}:${userId}`;
}

function pruneConfirmations(now = Date.now()): void {
  for (const [key, pending] of pendingConfirmations) {
    if (pending.expiresAt <= now) pendingConfirmations.delete(key);
  }
}

function sceneTimeForCampaign(campaignId: string, active: boolean): VoiceSceneTime {
  if (!active) return "table_time";
  if (getActiveEncounter(campaignId)) return "urgent_time";
  return "scene_time";
}

function floorError(floor: Floor): Response {
  if (floor.mode === "hold") {
    return Response.json(
      { error: "The party lead has not opened responses yet. Use OOC for table talk.", floor },
      { status: 409 },
    );
  }
  if (floor.mode === "initiative") {
    return Response.json(
      { error: `It is ${floor.currentName || "another character"}'s turn in the initiative order.`, floor },
      { status: 409 },
    );
  }
  return Response.json({ error: "It is not your moment to act.", floor }, { status: 409 });
}

function voiceResponse(decision: VoiceDecisionResult) {
  return {
    decision: decision.decision,
    intent: decision.intent,
    commitment: decision.commitment,
    reason: decision.reason,
    confidence: decision.confidence,
    wakeWord: decision.wakeWord,
    addressedTo: decision.addressedTo,
    normalizedText: decision.normalizedText,
    interrupt: decision.decision === VoiceDecision.INTERRUPT_AND_RESPOND,
    pause: decision.decision === VoiceDecision.PAUSE,
    requiresConfirmation: decision.requiresConfirmation,
    confirmationRequired: false,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireVoice(campaignId);
  if (isErrorResponse(context)) return context;
  return Response.json({ ok: true, userId: context.user.id }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireVoice(campaignId);
  if (isErrorResponse(context)) return context;

  const parsed = utteranceSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Invalid voice utterance." }, { status: 400 });
  const input = parsed.data;
  pruneConfirmations();

  const ownSheet = getSheetForUser(campaignId, context.user.id);
  const selectedSheet = input.characterId
    ? listSheets(campaignId).find((sheet) => sheet.id === input.characterId) ?? null
    : ownSheet;
  if (input.characterId && !selectedSheet) {
    return Response.json({ error: "That speaking character is not in this campaign." }, { status: 400 });
  }
  if (selectedSheet && selectedSheet.userId !== context.user.id && !steersStory(context)) {
    return Response.json({ error: "Only the party lead may select another speaking character." }, { status: 403 });
  }

  const normalized = normalizeVoiceText(input.text);
  const rawUtterance = input.textRaw ?? input.text;
  const pendingKey = confirmationKey(campaignId, context.user.id);
  const pending = pendingConfirmations.get(pendingKey);
  const confirmationMatches = Boolean(
    pending &&
      input.confirmationToken === pending.token &&
      selectedSheet?.id === pending.characterId,
  );
  const cancelling = confirmationMatches && isVoiceCancellation(normalized);
  const confirming = confirmationMatches && isVoiceConfirmation(normalized);
  const actionText = confirming ? pending!.actionText : normalized;
  if (confirming || cancelling) pendingConfirmations.delete(pendingKey);

  const decision = confirming
    ? {
        ...decideVoiceResponse(actionText, {
          narrationActive: input.narrationActive,
          sceneTime: sceneTimeForCampaign(campaignId, context.campaign.status === "active"),
        }),
        requiresConfirmation: false,
      }
    : cancelling
      ? {
          ...decideVoiceResponse(normalized, {
            narrationActive: input.narrationActive,
            sceneTime: "table_time" as VoiceSceneTime,
          }),
          decision: VoiceDecision.WAIT,
          reason: "pending high-stakes action cancelled",
          requiresConfirmation: false,
        }
      : decideVoiceResponse(normalized, {
          narrationActive: input.narrationActive,
          sceneTime: sceneTimeForCampaign(campaignId, context.campaign.status === "active"),
        });

  const speaker = selectedSheet?.name ?? context.user.username;
  const startedAt = input.startedAt && !Number.isNaN(Date.parse(input.startedAt))
    ? input.startedAt
    : new Date().toISOString();
  insertTranscriptLines(campaignId, context.user.id, [
    {
      speaker,
      text: normalized,
      textRaw: rawUtterance,
      utteranceId: input.utteranceId,
      audioStreamId: input.audioStreamId,
      speechSpanId: input.speechSpanId,
      audioStartSample: input.audioStartSample,
      audioEndSample: input.audioEndSample,
      sttConfidence: input.sttConfidence,
      speakerConfidence: input.speakerConfidence,
      speakerEnrolled: input.speakerEnrolled,
      audioMetadata: {
        ...(input.audioMetadata ?? {}),
        captureSettings: input.captureSettings ?? {},
      },
      startedAt,
      clockLabel: describeInstant(context.campaign.clock.calendar, context.campaign.clock.instant),
    },
  ]);
  publishEphemeral(campaignId, "transcript_updated", {
    at: Date.now(),
    utteranceId: input.utteranceId ?? null,
    audioStreamId: input.audioStreamId ?? null,
    speechSpanId: input.speechSpanId ?? null,
    audioStartSample: input.audioStartSample ?? null,
    audioEndSample: input.audioEndSample ?? null,
  });

  const response = voiceResponse(decision);
  const modelBound = decision.decision === VoiceDecision.RESPOND || decision.decision === VoiceDecision.INTERRUPT_AND_RESPOND;
  if (modelBound && context.campaign.status !== "active") {
    return Response.json({ ...response, error: "The adventure has not started yet.", confirmationRequired: false }, { status: 400 });
  }
  if (cancelling) {
    return Response.json({ ...response, confirmationCancelled: true });
  }
  if (decision.requiresConfirmation && !confirming) {
    if (!selectedSheet) {
      return Response.json(
        { ...response, error: "Choose a speaking character before confirming a consequential action.", confirmationRequired: false },
        { status: 400 },
      );
    }
    const token = crypto.randomUUID();
      pendingConfirmations.set(pendingKey, {
        token,
        userId: context.user.id,
        characterId: selectedSheet.id,
        actionText: normalized,
        expiresAt: Date.now() + CONFIRMATION_TTL_MS,
      });
    return Response.json({
      ...response,
      confirmationRequired: true,
      confirmationToken: token,
      confirmationPrompt: "That action is consequential. Say yes to confirm or no to cancel.",
    });
  }

  if (
    decision.decision === VoiceDecision.IGNORE ||
    decision.decision === VoiceDecision.WAIT ||
    decision.decision === VoiceDecision.RESUME_PRIOR_OUTPUT ||
    decision.decision === VoiceDecision.PAUSE
  ) {
    return Response.json({ ...response, confirmed: confirming });
  }
  if (context.campaign.status !== "active") {
    return Response.json({ ...response, error: "The adventure has not started yet." }, { status: 400 });
  }
  if (!selectedSheet) {
    return Response.json(
      { ...response, error: "Choose a speaking character before declaring an action by voice." },
      { status: 400 },
    );
  }
  if (dmTurnBusy(campaignId)) {
    return Response.json(
      { ...response, error: "The Dungeon Master is still working on the previous turn." },
      { status: 409 },
    );
  }

  const floor = getFloor(campaignId);
  if (!canAct(floor, context.user.id, "do")) return floorError(floor);

  let spotlightStillWaiting = false;
  if (floor.mode === "spotlight") {
    const responded = floor.userIds.includes(context.user.id) && !floor.respondedUserIds.includes(context.user.id)
      ? [...floor.respondedUserIds, context.user.id]
      : floor.respondedUserIds;
    const allAnswered = floor.userIds.every((id) => responded.includes(id));
    const nextFloor: Floor = allAnswered ? { mode: "open" } : { ...floor, respondedUserIds: responded };
    if (allAnswered || responded !== floor.respondedUserIds) {
      setFloor(campaignId, nextFloor);
      publishPersisted(campaignId, "floor_changed", { floor: nextFloor });
    }
    spotlightStillWaiting = !allAnswered;
  }

  const seq = allocateSeq(campaignId);
  const message = insertCampaignMessage({
    campaignId,
    seq,
    authorType: "player",
    userId: context.user.id,
    characterId: selectedSheet.id,
    content: actionText,
  });
  publishWithSeq(campaignId, seq, "message_added", { message });

  const humanDm = hasHumanDm(campaignSeats(context.campaign)) && !coverInEffect(
    context.campaign.gameSettings.dmMode,
    context.campaign.gameSettings.dmAssist,
    context.campaign.dmCover,
  );
  if (!spotlightStillWaiting) {
    if (humanDm) {
      publishPersisted(campaignId, "dm_intent_queued", {
        messageId: message.id,
        userId: context.user.id,
        characterId: selectedSheet.id,
        seq,
      });
    } else {
      requestDmTurn(campaignId);
    }
  }

  return Response.json({ ...response, messageId: message.id, confirmed: confirming }, { status: 202 });
}
