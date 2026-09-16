// Deterministic voice-response policy for the shared table.
//
// This is the TypeScript port of the pure part of
// /home/matt/Projects/lorekeeper/lorekeeper/conversation/intents.py. It never
// calls a model and never mutates campaign state. Final utterances are the only
// inputs allowed to reach this seam; interim STT is presentation-only.

export const VoiceIntent = {
  TABLE_CHAT: "table_chat",
  PLANNING: "planning",
  QUESTION: "question",
  DECLARATION_TENTATIVE: "declaration_tentative",
  DECLARATION_COMMITTED: "declaration_committed",
  CORRECTION: "correction",
  RETRACTION: "retraction",
  RULE_CHALLENGE: "rule_challenge",
  DICE_RESULT: "dice_result",
  PAUSE: "pause",
} as const;
export type VoiceIntent = (typeof VoiceIntent)[keyof typeof VoiceIntent];

export const VoiceDecision = {
  IGNORE: "ignore",
  WAIT: "wait",
  RESPOND: "respond",
  INTERRUPT_AND_RESPOND: "interrupt_and_respond",
  RESUME_PRIOR_OUTPUT: "resume_prior_output",
  PAUSE: "pause",
} as const;
export type VoiceDecision = (typeof VoiceDecision)[keyof typeof VoiceDecision];

export const VoiceCommitment = {
  TENTATIVE: "tentative",
  COMMITTED: "committed",
  NOT_AN_ACTION: "not_an_action",
} as const;
export type VoiceCommitment = (typeof VoiceCommitment)[keyof typeof VoiceCommitment];

export type VoiceSceneTime = "table_time" | "scene_time" | "urgent_time";

export type VoiceClassification = {
  intent: VoiceIntent;
  cues: string[];
};

export type VoiceDecisionResult = {
  decision: VoiceDecision;
  reason: string;
  confidence: number;
  intent: VoiceIntent;
  cues: string[];
  commitment: VoiceCommitment;
  wakeWord: boolean;
  addressedTo: "dm" | null;
  normalizedText: string;
  requiresConfirmation: boolean;
};

const FILLERS = /(?:,\s*)?\b(?:um+|uh+|er+)\b[,.]*\s*/gi;
const FILLER_PHRASES = /(?:,\s*\blike\b\s*|\blike\b,\s*|,\s*\byou know\b\s*|\byou know\b,\s*)/gi;
const RETRACTION = /\b(?:never ?mind|scratch that|forget (?:it|that|what i said)|ignore that|actually,? no|wait,? no|don't do that|undo that|take ?that back)\b/i;
const CORRECTION = /\b(?:i meant|i actually meant|correction|no wait|i said|i'm gonna say instead|let me rephrase|rather than|instead (?:of|,))\b/i;
const RULE_CHALLENGE = /\b(?:(?:isn't|shouldn't|doesn't|don't) (?:that|it|the rules?|he|she|they)|rules? as written|raw|raw says|that's not how|according to the rules|the rules say|double proficiency|that's not (?:right|how it works))\b/i;
const QUESTION = /\?|^\s*(?:what|where|when|who|why|how|which|can|could|do|does|did|is|are|should)\b/i;
const PLANNING = /\b(?:we (?:should|could|need to|can)|let's|i'll cover|you (?:take|go|cover)|(?:our )?plan is|first we|then we|split up|on three|ready\?)\b/i;
const ACTION_VERBS = "attack|swing|strike|shoot|fire|stab|slash|cast|drink|quaff|open|close|unlock|pick(?: the)?|push|pull|grab|take|steal|move|walk|run|sprint|dash|dodge|retreat|flee|hide|sneak|search|investigate|examine|inspect|observe|look|survey|scan|listen|hear|watch|read|approach|enter|leave|follow|check|feel|smell|touch|hold|drop|throw|toss|give|hand|tell|ask|say|shout|whisper|use|light|ignite|extinguish|smash|break|kick|climb|jump|leap|swim|crawl|stand|sit|sleep|rest|pray|detect|toggle|sign|sacrifice";
const COMMITTED = new RegExp(
  `^\\s*(?:ok(?:ay)?[,. ]+|then )?i (?:'ll |will |am |)\\s*(?:go ahead and |try to )?(${ACTION_VERBS})\\b`,
  "i",
);
const TENTATIVE = /\b(?:maybe i (?:could|should|can)|i could|i'm thinking (?:of|about)|what if i|should i|can i|i wonder if i|i want to|i'm going to|i am going to|i'm gonna|i am gonna|i plan to|i'd like to)\b/i;
const PROPOSAL = /\b(?:what if i|maybe i (?:could|should|can)|i'm thinking (?:of|about)|i wonder if i)\b/i;
const DICE_CUE = /\b(?:i rolled|i got|natural twenty|nat 20|on the die|on the dice|total(?:s|ed)?)\b/i;
const WAKE = /^(?:\s*(?:hey|ok|okay|yo|hi)?\s*(?:ember)\b\s*[,.:]?|\s*(?:hey|ok|okay|yo|hi)\s+(?:lorekeeper|keeper)\b)/i;
const LEGACY_WAKE = /\b(?:lorekeeper|keeper)\b/i;
const DM_VOCATIVE = /^\s*(?:hey|ok|okay|yo|hi)?\s*(?:dm|dungeon master)\b\s*[,.:]?/i;
const PAUSE = /^\s*(?:pause(?: the game)?|hold on|hold up|stop for a moment|take a break)\s*[.!?]?\s*$/i;
const HIGH_STAKES = /\b(?:kill|execute|destroy|burn (?:it|the|down|him|her|them)|gamble|bet|wager|all of (?:it|my|our)|sign|oath|swear|sacrifice|drink the)\b/i;
const CONFIRMATION = /^\s*(?:(?:yes|yeah|yep)(?:[,. ]+(?:confirm(?:ed)?))?|confirm(?:ed)?|do it|go ahead|proceed|that's right|that is right)\s*[.!?]?\s*$/i;
const CANCELLATION = /^\s*(?:no|nope|cancel|cancel that|never mind|forget it|don't)\s*[.!?]?\s*$/i;

export function normalizeVoiceText(text: string): string {
  return text.replace(FILLERS, " ").replace(FILLER_PHRASES, " ").replace(/\s+/g, " ").trim();
}

export function detectVoiceAddress(text: string): { wakeWord: boolean; addressedTo: "dm" | null } {
  const wakeWord = WAKE.test(text) || LEGACY_WAKE.test(text);
  return { wakeWord, addressedTo: wakeWord || DM_VOCATIVE.test(text) ? "dm" : null };
}

export function classifyVoiceIntent(text: string): VoiceClassification {
  const input = normalizeVoiceText(text);
  if (PAUSE.test(input)) return { intent: VoiceIntent.PAUSE, cues: ["spoken_pause"] };
  if (RETRACTION.test(input)) return { intent: VoiceIntent.RETRACTION, cues: ["retraction_cue"] };
  if (CORRECTION.test(input)) return { intent: VoiceIntent.CORRECTION, cues: ["correction_cue"] };
  if (DICE_CUE.test(input) && !QUESTION.test(input)) return { intent: VoiceIntent.DICE_RESULT, cues: ["dice_statement"] };
  if (RULE_CHALLENGE.test(input)) return { intent: VoiceIntent.RULE_CHALLENGE, cues: ["rule_challenge_cue"] };
  if (PROPOSAL.test(input)) return { intent: VoiceIntent.DECLARATION_TENTATIVE, cues: ["proposal_hedge"] };
  if (QUESTION.test(input)) return { intent: VoiceIntent.QUESTION, cues: ["question_cue"] };
  if (TENTATIVE.test(input)) return { intent: VoiceIntent.DECLARATION_TENTATIVE, cues: ["tentative_hedge"] };
  if (COMMITTED.test(input)) return { intent: VoiceIntent.DECLARATION_COMMITTED, cues: ["present_tense_action"] };
  if (PLANNING.test(input)) return { intent: VoiceIntent.PLANNING, cues: ["planning_cue"] };
  return { intent: VoiceIntent.TABLE_CHAT, cues: ["no_deterministic_cue"] };
}

export function commitmentForVoiceIntent(intent: VoiceIntent): VoiceCommitment {
  if (intent === VoiceIntent.DECLARATION_COMMITTED || intent === VoiceIntent.DICE_RESULT) {
    return VoiceCommitment.COMMITTED;
  }
  if (
    intent === VoiceIntent.DECLARATION_TENTATIVE ||
    intent === VoiceIntent.PLANNING ||
    intent === VoiceIntent.QUESTION
  ) {
    return VoiceCommitment.TENTATIVE;
  }
  return VoiceCommitment.NOT_AN_ACTION;
}

function responseWhileNarrating(decision: VoiceDecision, narrationActive: boolean): VoiceDecision {
  return narrationActive ? VoiceDecision.INTERRUPT_AND_RESPOND : decision;
}

export function decideVoiceResponse(
  text: string,
  options: { narrationActive: boolean; sceneTime: VoiceSceneTime },
): VoiceDecisionResult {
  const normalizedText = normalizeVoiceText(text);
  const { intent, cues } = classifyVoiceIntent(normalizedText);
  const { wakeWord, addressedTo } = detectVoiceAddress(normalizedText);
  const commitment = commitmentForVoiceIntent(intent);
  const interrupt = (decision: VoiceDecision, reason: string, confidence: number) => ({
    decision: responseWhileNarrating(decision, options.narrationActive),
    reason,
    confidence,
  });

  let outcome: { decision: VoiceDecision; reason: string; confidence: number };
  if (intent === VoiceIntent.PAUSE) {
    outcome = { decision: VoiceDecision.PAUSE, reason: "explicit spoken pause command", confidence: 0.99 };
  } else if (wakeWord) {
    outcome = interrupt(VoiceDecision.RESPOND, "wake word: direct DM address", 0.95);
  } else if (addressedTo === "dm") {
    outcome = interrupt(VoiceDecision.RESPOND, "addressed to DM", 0.9);
  } else if (intent === VoiceIntent.RETRACTION) {
    outcome = interrupt(VoiceDecision.RESPOND, "retraction supersedes prior output", 0.9);
  } else if (intent === VoiceIntent.CORRECTION) {
    outcome = interrupt(VoiceDecision.RESPOND, "correction of spoken output", 0.85);
  } else if (intent === VoiceIntent.RULE_CHALLENGE) {
    outcome = interrupt(VoiceDecision.RESPOND, "rules challenge for the DM", 0.8);
  } else if (intent === VoiceIntent.DICE_RESULT && commitment === VoiceCommitment.COMMITTED) {
    outcome = interrupt(VoiceDecision.RESPOND, "committed physical dice result", 0.9);
  } else if (intent === VoiceIntent.QUESTION) {
    if (options.sceneTime === "urgent_time" || options.sceneTime === "scene_time") {
      outcome = interrupt(VoiceDecision.RESPOND, "in-scene question", 0.75);
    } else if (options.narrationActive) {
      outcome = { decision: VoiceDecision.RESUME_PRIOR_OUTPUT, reason: "table-time question during narration", confidence: 0.65 };
    } else {
      outcome = { decision: VoiceDecision.WAIT, reason: "table-time question, likely player-to-player", confidence: 0.6 };
    }
  } else if (intent === VoiceIntent.DECLARATION_COMMITTED) {
    outcome = interrupt(VoiceDecision.RESPOND, "committed action declaration", 0.85);
  } else if (intent === VoiceIntent.DECLARATION_TENTATIVE) {
    if (options.sceneTime === "urgent_time") {
      outcome = interrupt(VoiceDecision.RESPOND, "urgent time: resolve tentative intent", 0.7);
    } else if (options.narrationActive) {
      outcome = { decision: VoiceDecision.RESUME_PRIOR_OUTPUT, reason: "tentative table talk during narration", confidence: 0.6 };
    } else {
      outcome = { decision: VoiceDecision.WAIT, reason: "table is considering it; DM waits", confidence: 0.55 };
    }
  } else if (intent === VoiceIntent.PLANNING) {
    if (options.sceneTime === "urgent_time") {
      outcome = interrupt(VoiceDecision.RESPOND, "urgent time: nudge the plan along", 0.7);
    } else if (options.narrationActive) {
      outcome = { decision: VoiceDecision.RESUME_PRIOR_OUTPUT, reason: "table planning during narration", confidence: 0.65 };
    } else {
      outcome = { decision: VoiceDecision.WAIT, reason: "table is planning; DM waits", confidence: 0.7 };
    }
  } else if (options.narrationActive) {
    outcome = { decision: VoiceDecision.RESUME_PRIOR_OUTPUT, reason: "side chatter during narration", confidence: 0.7 };
  } else {
    outcome = { decision: VoiceDecision.IGNORE, reason: "table chatter, not DM-directed", confidence: 0.7 };
  }

  return {
    ...outcome,
    intent,
    cues,
    commitment,
    wakeWord,
    addressedTo,
    normalizedText,
    requiresConfirmation: isHighStakesVoice(normalizedText, intent),
  };
}

export function isSpokenPauseCommand(text: string): boolean {
  return PAUSE.test(normalizeVoiceText(text));
}

export function isVoiceConfirmation(text: string): boolean {
  return CONFIRMATION.test(normalizeVoiceText(text));
}

export function isVoiceCancellation(text: string): boolean {
  return CANCELLATION.test(normalizeVoiceText(text));
}

export function isHighStakesVoice(text: string, intent: VoiceIntent): boolean {
  return (
    (intent === VoiceIntent.DECLARATION_COMMITTED ||
      intent === VoiceIntent.DECLARATION_TENTATIVE ||
      intent === VoiceIntent.QUESTION ||
      intent === VoiceIntent.PLANNING) &&
    HIGH_STAKES.test(normalizeVoiceText(text))
  );
}
