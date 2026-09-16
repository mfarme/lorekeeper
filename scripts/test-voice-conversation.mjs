import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const {
  VoiceDecision,
  VoiceIntent,
  classifyVoiceIntent,
  decideVoiceResponse,
  isHighStakesVoice,
  isVoiceCancellation,
  isVoiceConfirmation,
  normalizeVoiceText,
} = await import("../src/lib/voice/conversation-policy.ts");

const cases = [
  {
    text: "Hey Ember, what do we see?",
    expected: [VoiceDecision.RESPOND, VoiceIntent.QUESTION],
    name: "wake-word question responds",
  },
  {
    text: "I search the room.",
    expected: [VoiceDecision.RESPOND, VoiceIntent.DECLARATION_COMMITTED],
    name: "committed action responds",
  },
  {
    text: "Maybe I should open the door.",
    expected: [VoiceDecision.WAIT, VoiceIntent.DECLARATION_TENTATIVE],
    name: "tentative proposal waits",
  },
  {
    text: "Let's split up.",
    expected: [VoiceDecision.WAIT, VoiceIntent.PLANNING],
    name: "table planning waits",
  },
  {
    text: "Pass the minis.",
    expected: [VoiceDecision.IGNORE, VoiceIntent.TABLE_CHAT],
    name: "table chatter is ignored",
  },
  {
    text: "Pause the game.",
    expected: [VoiceDecision.PAUSE, VoiceIntent.PAUSE],
    name: "spoken pause is a control decision",
  },
  {
    text: "Actually, no, I meant the west door.",
    expected: [VoiceDecision.RESPOND, VoiceIntent.RETRACTION],
    name: "retraction responds",
  },
  {
    text: "That's not how the rules work.",
    expected: [VoiceDecision.RESPOND, VoiceIntent.RULE_CHALLENGE],
    name: "rules challenge responds",
  },
];

for (const test of cases) {
  const result = decideVoiceResponse(test.text, { narrationActive: false, sceneTime: "table_time" });
  assert.deepEqual([result.decision, result.intent], test.expected, test.name);
}

assert.equal(
  decideVoiceResponse("What is behind us?", { narrationActive: true, sceneTime: "table_time" }).decision,
  VoiceDecision.RESUME_PRIOR_OUTPUT,
);
assert.equal(
  decideVoiceResponse("What is behind us?", { narrationActive: true, sceneTime: "scene_time" }).decision,
  VoiceDecision.INTERRUPT_AND_RESPOND,
);
assert.equal(
  decideVoiceResponse("Ember, stop.", { narrationActive: true, sceneTime: "table_time" }).decision,
  VoiceDecision.INTERRUPT_AND_RESPOND,
);
assert.equal(
  decideVoiceResponse("Maybe I sacrifice the relic?", { narrationActive: true, sceneTime: "urgent_time" }).decision,
  VoiceDecision.INTERRUPT_AND_RESPOND,
);
assert.equal(
  decideVoiceResponse("I sacrifice the relic.", { narrationActive: false, sceneTime: "scene_time" }).requiresConfirmation,
  true,
);
assert.equal(isHighStakesVoice("I sacrifice the relic.", VoiceIntent.DECLARATION_COMMITTED), true);
assert.equal(isVoiceConfirmation("yes, confirm"), true);
assert.equal(isVoiceCancellation("cancel that"), true);
assert.deepEqual(classifyVoiceIntent("um, I search the room"), {
  intent: VoiceIntent.DECLARATION_COMMITTED,
  cues: ["present_tense_action"],
});
assert.equal(normalizeVoiceText("  um,   Ember,   what is there?  "), "Ember, what is there?");

console.log(`test-voice-conversation: ${cases.length + 10} passed`);
