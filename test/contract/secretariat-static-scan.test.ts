/**
 * #924 static scans: ticket-law load topology (repo-wide structural sole owner);
 * role modules have no second summon drive seam (ADR 0018); public face has no
 * new flags/mode params. No free-text / prose regex on law content.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { PUBLIC_ROLE_RECORDS } from "../../src/packaged-role-registry.ts";
import { optionsForOwner } from "../../src/public-cli/option-definitions.ts";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".ak-roles",
  "coverage",
]);

/** Structural ticket-law path owners: basename ticket-law.md or *-ticket-law.md. */
function isTicketLawPath(name: string): boolean {
  return name === "ticket-law.md" || name.endsWith("-ticket-law.md");
}

async function collectTicketLawRelativePaths(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && isTicketLawPath(entry.name)) {
        found.push(relative(root, full).split("\\").join("/"));
      }
    }
  }
  await walk(root);
  return found.sort();
}

test("ticket-law is the sole structural law owner and three seats load it", async () => {
  const paths = await collectTicketLawRelativePaths(packageRoot);
  assert.deepEqual(
    paths,
    ["souls/ticket-law.md"],
    `expected sole souls/ticket-law.md; found: ${paths.join(", ") || "(none)"}`,
  );

  // Registry is the session-material true source — structural load relation only.
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
  // #924: secretariat-soul=exists — independent Soul is in the load list.
  assert.ok(
    (byRole.secretariat as readonly string[]).includes("souls/secretariat.md"),
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

test("public secretariat face has no new flags or mode params", () => {
  const options = optionsForOwner("secretariat");
  const ids = options.map((o) => o.id).sort();
  assert.deepEqual(ids, ["attach", "project"].sort());
  assert.equal(
    options.some((o) => o.id === "mode" || o.id === "ticket" || o.id === "phase"),
    false,
  );
});
