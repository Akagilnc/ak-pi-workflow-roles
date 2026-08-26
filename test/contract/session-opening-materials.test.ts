/**
 * #443 — session opening materials: ticket-oracle byte equality at the three
 * loader families. Pack/default-wiring real entries live in package + gatekeeper
 * integration trunks (not parallel injected-loadSoul harnesses).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadAuditorSoul, AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import {
  joinPackageMaterials,
  loadGatekeeperSessionMaterials,
  loadMainRoleSessionMaterials,
} from "../../src/session-opening-materials.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

/** Ticket #443 What-to-build oracles — not imported from production tables. */
const TICKET_MAIN_MATERIALS = {
  judge: ["CLAUDE.md", "souls/judge.md", "souls/audit-law.md", "souls/judge-output-guide.md"],
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
  reviewer: ["CLAUDE.md", "souls/reviewer.md", "souls/audit-law.md"],
  collector: ["CLAUDE.md", "souls/collector.md"],
  doctor: ["CLAUDE.md", "souls/doctor.md"],
  merger: ["CLAUDE.md", "souls/merger.md"],
  notary: ["CLAUDE.md", "souls/notary.md", "souls/menxia-output-guide.md"],
  navigator: ["CLAUDE.md", "souls/navigator.md"],
} as const;

const TICKET_GATEKEEPER_MATERIALS = {
  gatekeeper: ["CLAUDE.md", "souls/gatekeeper.md", "souls/menxia-output-guide.md"],
  inspector: [
    "CLAUDE.md",
    "souls/inspector.md",
    "souls/quality-law.md",
    "souls/menxia-output-guide.md",
  ],
  notary: ["CLAUDE.md", "souls/notary.md", "souls/menxia-output-guide.md"],
} as const;

const TICKET_AUDITOR_MATERIALS = {
  judge: ["CLAUDE.md", "souls/judge-auditor.md", "souls/audit-law.md"],
  reviewer: ["CLAUDE.md", "souls/reviewer-auditor.md", "souls/audit-law.md"],
  // #470 范围修正: doctor auditor 暂不装审刑院法典
  doctor: ["CLAUDE.md", "souls/doctor-auditor.md"],
} as const;

async function expectJoined(relativePaths: readonly string[]): Promise<string> {
  const parts = [];
  for (const relativePath of relativePaths) {
    parts.push(await readFile(resolve(packageRoot, relativePath), "utf8"));
  }
  return parts.join("\n\n");
}

test("main-role loaders match ticket material roster byte-for-byte", async () => {
  for (const [role, paths] of Object.entries(TICKET_MAIN_MATERIALS)) {
    assert.equal(
      await loadMainRoleSessionMaterials(
        role as keyof typeof TICKET_MAIN_MATERIALS,
      ),
      await expectJoined(paths),
      `${role} must carry ticket materials from package source`,
    );
  }
});

test("gatekeeper family loaders match ticket material roster byte-for-byte", async () => {
  for (const [role, paths] of Object.entries(TICKET_GATEKEEPER_MATERIALS)) {
    assert.equal(
      await loadGatekeeperSessionMaterials(
        role as keyof typeof TICKET_GATEKEEPER_MATERIALS,
      ),
      await expectJoined(paths),
      `${role} must carry ticket materials from package source`,
    );
  }
});

test("auditor loaders match ticket material roster byte-for-byte", async () => {
  for (const role of AUDITOR_SOUL_ROLES) {
    assert.equal(
      await loadAuditorSoul(role),
      await expectJoined(TICKET_AUDITOR_MATERIALS[role]),
      `${role} auditor must carry ticket materials from package source`,
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
