/**
 * Public CLI build/package seam (ADR 0052 / #106):
 * package.json#bin executes dist/public-cli/main.js — the committed artifact
 * must match a fresh bundle from src/public-cli, or installs and local bins
 * ship a stale Terminal encoder / settlement path.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { packageRoot } from "../helpers/pi-test-harness.ts";

async function loadBuildPackage(): Promise<{
  buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
}> {
  const url = pathToFileURL(resolve(packageRoot, "scripts/build-package.mjs")).href;
  return (await import(url)) as {
    buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("committed ak-role bin matches fresh public-cli bundle from source", async () => {
  const { buildPublicAkRoleBin } = await loadBuildPackage();
  const committedPath = resolve(packageRoot, "dist/public-cli/main.js");
  const committed = await readFile(committedPath);

  const dir = await mkdtemp(join(tmpdir(), "ak-public-cli-bin-"));
  const freshPath = join(dir, "main.js");
  try {
    // Build from the package root so entryPoints resolve like prepack/build.
    const previousCwd = process.cwd();
    process.chdir(packageRoot);
    try {
      await buildPublicAkRoleBin(freshPath);
    } finally {
      process.chdir(previousCwd);
    }

    const fresh = await readFile(freshPath);
    assert.equal(
      sha256(fresh),
      sha256(committed),
      "dist/public-cli/main.js drifted from src/public-cli — run: node scripts/build-package.mjs",
    );
    // Behavioral markers for public settlement seams (not presentation freezes).
    const committedText = committed.toString("utf8");
    assert.equal(
      committedText.includes("settleJudgeFailureTerminalResult"),
      true,
      "public bin must ship controlled failure settlement",
    );
    assert.equal(
      committedText.includes("validateAcceptedJudgeDetails"),
      true,
      "public bin must ship Judge verdict validation before lawful settlement",
    );
    // #108 resume path must be in the installed bin, not only in tsx source tests.
    assert.equal(
      committedText.includes("ak-role resume"),
      true,
      "public bin must ship complete ak-role resume command rendering",
    );
    assert.equal(
      committedText.includes("typed-provider-http.json"),
      true,
      "public bin must ship typed HTTP 429 observation file seam",
    );
    assert.equal(
      /case\s*[\"']resume[\"']|command\s*===\s*[\"']resume[\"']/.test(committedText),
      true,
      "public bin must ship resume command dispatch",
    );
    // #109 public Coder adapter + package method seam must ship in the installed bin.
    assert.equal(
      /command\s*===\s*[\"']coder[\"']|case\s*[\"']coder[\"']/.test(committedText),
      true,
      "public bin must ship coder command dispatch",
    );
    assert.equal(
      committedText.includes("resources/methods"),
      true,
      "public bin must bind package-owned method resource root",
    );
    assert.equal(
      /resolvePackagedMethodSkillPath\([^)]*"tdd"/.test(committedText),
      true,
      "public bin must resolve the package-owned tdd skill path",
    );
    assert.equal(
      committedText.includes("validateAcceptedCoderDetails"),
      true,
      "public bin must ship Coder success settlement validation",
    );
    assert.equal(
      committedText.includes("ak-coder-phase"),
      true,
      "public bin must preserve coder phase on activation/resume",
    );
    // #111 public Reviewer adapter + package code-review method must ship in the installed bin.
    assert.equal(
      /command\s*===\s*[\"']reviewer[\"']|case\s*[\"']reviewer[\"']/.test(committedText),
      true,
      "public bin must ship reviewer command dispatch",
    );
    assert.equal(
      /resolvePackagedMethodSkillPath\([^)]*"code-review"/.test(committedText),
      true,
      "public bin must resolve the package-owned code-review skill path",
    );
    assert.equal(
      committedText.includes("validateRuntimeReviewerReceipt"),
      true,
      "public bin must ship Reviewer receipt validation before lawful settlement",
    );
    assert.equal(
      committedText.includes("ak-review-base"),
      true,
      "public bin must pin the Reviewer base on activation",
    );
    // #114 public Merger adapter + package merge-only method must ship in the installed bin.
    assert.equal(
      /command\s*===\s*["']merger["']|case\s*["']merger["']/.test(committedText),
      true,
      "public bin must ship merger command dispatch",
    );
    assert.equal(
      /resolvePackagedMethodSkillPath\([^)]*"resolving-merge-conflicts"/.test(
        committedText,
      ),
      true,
      "public bin must resolve the package-owned resolving-merge-conflicts skill path",
    );
    assert.equal(
      committedText.includes("ak-merger-input"),
      true,
      "public bin must pin derived merger input on activation",
    );
    // #112 public Collector adapter must ship in the installed bin.
    assert.equal(
      /command\s*===\s*[\"']collector[\"']|case\s*[\"']collector[\"']/.test(committedText),
      true,
      "public bin must ship collector command dispatch",
    );
    assert.equal(
      committedText.includes("validateAcceptedCollectorReceipt"),
      true,
      "public bin must ship Collector receipt validation before lawful settlement",
    );
    assert.equal(
      committedText.includes("ak-collector-repo"),
      true,
      "public bin must pin the collector repository on activation",
    );
    assert.equal(
      committedText.includes("typed groups terminal discriminator"),
      true,
      "public bin must settle Collector from typed groups",
    );
    // #110 / #113 public Fixer + Doctor adapters must ship in the installed bin.
    assert.equal(
      /command\s*===\s*["']fixer["']|case\s*["']fixer["']/.test(committedText),
      true,
      "public bin must ship fixer command dispatch",
    );
    assert.equal(
      /resolvePackagedMethodSkillPath\([^)]*"diagnosing-bugs"/.test(committedText),
      true,
      "public bin must resolve the package-owned diagnosing-bugs skill path",
    );
    assert.equal(
      /command\s*===\s*["']doctor["']|case\s*["']doctor["']/.test(committedText),
      true,
      "public bin must ship doctor command dispatch",
    );
    assert.equal(
      committedText.includes("ak-doctor-case"),
      true,
      "public bin must pin doctor case flag on activation",
    );
    // #115: every public callable role is a completed dispatch path in the shipped bin.
    const roleDispatch = (role: string): boolean =>
      new RegExp(
        "command\\s*===\\s*[\"']" + role + "[\"']|case\\s*[\"']" + role + "[\"']",
      ).test(committedText);
    for (const role of [
      "judge",
      "coder",
      "fixer",
      "reviewer",
      "collector",
      "doctor",
      "merger",
    ] as const) {
      assert.equal(roleDispatch(role), true, `public bin must ship ${role} command dispatch`);
    }
    assert.equal(
      committedText.includes("not available in this install slice"),
      false,
      "release bin must not ship deferred-slice role stubs",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
