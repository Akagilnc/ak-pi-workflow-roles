/**
 * #924 static scans: unique 票面法 source; secretariat role module has no
 * second drive seam; public face has no new flags/mode params.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { PUBLIC_ROLE_RECORDS } from "../../src/packaged-role-registry.ts";
import { optionsForOwner } from "../../src/public-cli/option-definitions.ts";

async function collectFiles(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git"
      ) {
        continue;
      }
      await collectFiles(full, acc);
    } else if (
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".mjs")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

test("票面法 has one package true source at souls/ticket-law.md", async () => {
  const lawPath = join(packageRoot, "souls", "ticket-law.md");
  const body = await readFile(lawPath, "utf8");
  assert.match(body, /票面面向执行/);
  assert.match(body, /不写考古追责/);
  assert.match(body, /不得把票面、prompt、驳回语或实现现状升格为授权/);
  assert.match(body, /事实与处方分开/);

  // Unique true-source file name under souls/ — no parallel ticket-law copies.
  const souls = await readdir(join(packageRoot, "souls"));
  const ticketLaws = souls.filter(
    (name) => name === "ticket-law.md" || name.endsWith("-ticket-law.md"),
  );
  assert.deepEqual(ticketLaws, ["ticket-law.md"]);
});

test("secretariat / countersign / notary materials load ticket-law", () => {
  const byRole = Object.fromEntries(
    PUBLIC_ROLE_RECORDS.map((r) => [r.role, r.sessionMaterials]),
  );
  assert.ok(
    (byRole.secretariat as readonly string[]).includes("souls/ticket-law.md"),
  );
  assert.ok(
    (byRole.countersign as readonly string[]).includes("souls/ticket-law.md"),
  );
  assert.ok(
    (byRole.notary as readonly string[]).includes("souls/ticket-law.md"),
  );
  assert.ok(
    (byRole.secretariat as readonly string[]).includes("souls/countersign.md"),
  );
  assert.ok(
    (byRole.secretariat as readonly string[]).includes("souls/notary.md"),
  );
});

test("secretariat role module has no spawn/session/resume/cleanup lifecycle", async () => {
  const rolePath = join(packageRoot, "src", "secretariat-role.ts");
  const source = await readFile(rolePath, "utf8");
  // Shared-seam import is the only nested path; role must not own a second driver.
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("spawn("), false);
  assert.equal(source.includes("createRoleRuntimeExtension"), false);
  assert.equal(source.includes("runPostAdmission"), false);
  assert.equal(source.includes("markRunAdmitted"), false);
  assert.equal(source.includes("SessionManager"), false);
  // May dynamically import shared summons — that is the shared seam, not a second driver.
  assert.match(source, /summonPublicRole|summonCountersign/);
});

test("public secretariat face has no new flags or mode params", () => {
  const options = optionsForOwner("secretariat");
  const ids = options.map((o) => o.id).sort();
  // Same shared project + attach face as countersign/diarist — no ticket/mode flag.
  assert.deepEqual(ids, ["attach", "project"].sort());
  assert.equal(
    options.some((o) => o.id === "mode" || o.id === "ticket" || o.id === "phase"),
    false,
  );
});
