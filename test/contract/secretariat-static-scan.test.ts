/**
 * #924 static scans: ticket-law load topology; role modules have no second
 * summon drive seam (ADR 0018); public face has no new flags/mode params.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { PUBLIC_ROLE_RECORDS } from "../../src/packaged-role-registry.ts";
import { optionsForOwner } from "../../src/public-cli/option-definitions.ts";

test("ticket-law is the sole souls law file and three seats load it", async () => {
  const souls = await readdir(join(packageRoot, "souls"));
  const ticketLaws = souls.filter(
    (name) => name === "ticket-law.md" || name.endsWith("-ticket-law.md"),
  );
  assert.deepEqual(ticketLaws, ["ticket-law.md"]);

  const byRole = Object.fromEntries(
    PUBLIC_ROLE_RECORDS.map((r) => [r.role, r.sessionMaterials]),
  );
  for (const role of ["secretariat", "countersign", "notary"] as const) {
    assert.ok(
      (byRole[role] as readonly string[]).includes("souls/ticket-law.md"),
      `${role} must load souls/ticket-law.md`,
    );
  }
  assert.ok(
    (byRole.secretariat as readonly string[]).includes("souls/countersign.md"),
  );
  assert.ok(
    (byRole.secretariat as readonly string[]).includes("souls/notary.md"),
  );
});

/**
 * ADR 0018 class scan: *-role.ts must not value-import or call shared summon
 * drivers. Structured relation — import binding / call expression — not a
 * free-text blacklist of arbitrary strings.
 */
test("role modules do not value-import or call shared summon drivers (ADR 0018)", async () => {
  const srcDir = join(packageRoot, "src");
  const roleFiles = (await readdir(srcDir))
    .filter((name) => name.endsWith("-role.ts"))
    .map((name) => join(srcDir, name));
  assert.ok(roleFiles.length > 0);

  const summonDrivers = [
    "summonPublicRole",
    "summonGateOfficer",
    "createDefaultGateOfficerSummon",
  ] as const;

  for (const rolePath of roleFiles) {
    const source = await readFile(rolePath, "utf8");
    const file = basename(rolePath);

    for (const name of summonDrivers) {
      // Static value import: import { … name … } from "…summons|envelope…"
      const staticImport = new RegExp(
        String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*["'][^"']*["']`,
      );
      assert.equal(
        staticImport.test(source),
        false,
        `${file} must not value-import ${name}`,
      );

      // Dynamic import binding used as drive: const { name } = await import(...)
      // or (await import(...)).name(
      const dynamicBind = new RegExp(
        String.raw`(?:const|let|var)\s*\{[^}]*\b${name}\b[^}]*\}\s*=\s*await\s+import\s*\(`,
      );
      const dynamicMember = new RegExp(
        String.raw`await\s+import\s*\([^)]*\)[^;\n]*\b${name}\s*\(`,
      );
      assert.equal(
        dynamicBind.test(source) || dynamicMember.test(source),
        false,
        `${file} must not dynamically bind/call ${name}`,
      );
    }
  }
});

test("secretariat role module is projection-only (ADR 0018 / #924)", async () => {
  const source = await readFile(
    join(packageRoot, "src", "secretariat-role.ts"),
    "utf8",
  );
  assert.equal(/async\s+activate\s*\(/.test(source), false);
  assert.equal(/\bregisterTool\b/.test(source), false);
  assert.equal(/createFiledOfficerRuntime/.test(source), false);
  assert.equal(/before_agent_start/.test(source), false);
  assert.equal(/child_process/.test(source), false);
  assert.equal(/\bspawn\s*\(/.test(source), false);
  assert.match(source, /SECRETARIAT_OUTPUT_TOOL_SPEC/);
  assert.match(source, /projectSecretariatSummonResult/);
});

test("public secretariat face has no new flags or mode params", () => {
  const options = optionsForOwner("secretariat");
  const ids = options.map((o) => o.id).sort();
  assert.deepEqual(ids, ["attach", "project"].sort());
  assert.equal(
    options.some((o) => o.id === "mode" || o.id === "ticket" || o.id === "phase"),
    false,
  );
});
