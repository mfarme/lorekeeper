import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const { composerGate } = await import("../src/app/campaigns/[campaignId]/composerGate.ts");

const base = {
  floor: { mode: "open" },
  sheets: [],
  meUserId: "user-1",
  myName: "Avery",
  leadPrivate: false,
  openingNarrationPlaying: false,
};

for (const dmStatus of ["thinking", "rolling", "narrating", "awaiting_rolls", "writing_chapter", "plotting_arc"]) {
  for (const kind of ["do", "say", "lead", "narrate"]) {
    assert.equal(
      composerGate({ ...base, kind, dmStatus }).inputBlocked,
      true,
      `${kind} is blocked while ${dmStatus}`,
    );
  }
  assert.equal(
    composerGate({ ...base, kind: "ooc", dmStatus }).inputBlocked,
    false,
    `OOC remains open while ${dmStatus}`,
  );
}

assert.equal(composerGate({ ...base, kind: "do", dmStatus: "idle" }).inputBlocked, false);
console.log("test-composer-gate: 25 passed");
