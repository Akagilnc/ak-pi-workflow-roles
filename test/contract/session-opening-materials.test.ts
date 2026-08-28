/**
 * #443 / #495 S4 / #524 — session opening materials: ticket-oracle path rosters
 * at the three loader families (no soul-prose byte pin). Pack/default-wiring
 * real entries live in package + gatekeeper integration trunks.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDITOR_SESSION_MATERIALS,
  AUDITOR_SOUL_ROLES,
} from "../../src/auditor-soul.ts";
import {
  GATEKEEPER_SESSION_MATERIALS,
  joinPackageMaterials,
  MAIN_ROLE_SESSION_MATERIALS,
  type GatekeeperSessionRole,
  type MainRoleSession,
} from "../../src/session-opening-materials.ts";

/** Ticket #443 What-to-build path oracles — not imported from production tables. */
const TICKET_MAIN_MATERIALS = {
  judge: [
    "CLAUDE.md",
    "souls/judge.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
    "souls/judge-output-guide.md",
  ],
  fixer: [
    "CLAUDE.md",
    "souls/fixer.md",
    "souls/quality-law.md",
    "souls/fixer-output-guide.md",
  ],
  coder: [
    "CLAUDE.md",
    "souls/coder.md",
    "souls/quality-law.md",
    "souls/coder-output-guide.md",
  ],
  reviewer: [
    "CLAUDE.md",
    "souls/reviewer.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
  ],
  collector: ["CLAUDE.md", "souls/collector.md"],
  doctor: ["CLAUDE.md", "souls/doctor.md"],
  merger: ["CLAUDE.md", "souls/merger.md"],
  notary: ["CLAUDE.md", "souls/notary.md", "souls/gate-output-guide.md"],
  navigator: ["CLAUDE.md", "souls/navigator.md"],
} as const;

const TICKET_GATEKEEPER_MATERIALS = {
  gatekeeper: ["CLAUDE.md", "souls/gatekeeper.md", "souls/gate-output-guide.md"],
  inspector: [
    "CLAUDE.md",
    "souls/inspector.md",
    "souls/quality-law.md",
    "souls/gate-output-guide.md",
  ],
  notary: ["CLAUDE.md", "souls/notary.md", "souls/gate-output-guide.md"],
} as const;

const TICKET_AUDITOR_MATERIALS = {
  judge: [
    "CLAUDE.md",
    "souls/judge-auditor.md",
    "souls/audit-law.md",
    "souls/quality-law.md",
  ],
  // #470 范围修正: doctor auditor 暂不装审刑院法典
  // #495 S6: reviewer-side auditor roster retired with gate
  doctor: ["CLAUDE.md", "souls/doctor-auditor.md"],
} as const;

test("main-role material roster matches ticket path list", () => {
  for (const [role, paths] of Object.entries(TICKET_MAIN_MATERIALS)) {
    assert.deepEqual(
      [...MAIN_ROLE_SESSION_MATERIALS[role as MainRoleSession]],
      [...paths],
      `${role} must carry ticket material paths`,
    );
  }
});

test("gatekeeper family material roster matches ticket path list", () => {
  for (const [role, paths] of Object.entries(TICKET_GATEKEEPER_MATERIALS)) {
    assert.deepEqual(
      [...GATEKEEPER_SESSION_MATERIALS[role as GatekeeperSessionRole]],
      [...paths],
      `${role} must carry ticket material paths`,
    );
  }
  // #524: public and gatekeeper notary path lists stay identical (shared definition).
  assert.deepEqual(
    [...MAIN_ROLE_SESSION_MATERIALS.notary],
    [...GATEKEEPER_SESSION_MATERIALS.notary],
  );
});

test("auditor material roster matches ticket path list", () => {
  for (const role of AUDITOR_SOUL_ROLES) {
    assert.deepEqual(
      [...AUDITOR_SESSION_MATERIALS[role]],
      [...TICKET_AUDITOR_MATERIALS[role]],
      `${role} auditor must carry ticket material paths`,
    );
  }
});

test("missing injected material fails as native ENOENT, not a soft empty", async () => {
  await assert.rejects(
    () => joinPackageMaterials(["souls/__no_such_opening_material__.md"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});
