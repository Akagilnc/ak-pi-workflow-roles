/**
 * Shared public-run credential seam — one owner for missing-credential
 * detection, typed failure construction, pre-dispatch fail-closed, and
 * post-run annotation used by all seven public role runners.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  knownFailureForMissingProviderCredential,
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "../../src/public-cli/public-run-credentials.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const RUNNERS = [
  "coder-run.ts",
  "collector-run.ts",
  "doctor-run.ts",
  "fixer-run.ts",
  "judge-run.ts",
  "merger-run.ts",
  "reviewer-run.ts",
] as const;

test("shared seam constructs MissingProviderCredential from public credential facts", () => {
  const missing = knownFailureForMissingProviderCredential(
    { provider: "xai", model: "grok-4", thinking: "off" },
    { "openai-codex": false, xai: false },
  );
  assert.deepEqual(missing, {
    cause: "provider",
    identity: { name: "MissingProviderCredential", code: "xai" },
  });

  assert.equal(
    knownFailureForMissingProviderCredential(
      { provider: "xai", model: "grok-4", thinking: "off" },
      { "openai-codex": false, xai: true },
    ),
    undefined,
  );
  assert.equal(
    knownFailureForMissingProviderCredential(
      { provider: "offline-test", model: "m", thinking: "off" } as never,
      { "openai-codex": false, xai: false },
    ),
    undefined,
  );
});

test("pre-dispatch payload is one fail-closed shape for all public runners", () => {
  const blocked = missingCredentialPreDispatchFailure(
    { provider: "openai-codex", model: "gpt", thinking: "off" },
    { "openai-codex": false, xai: true },
  );
  assert.deepEqual(blocked, {
    timedOut: false,
    code: 1,
    stderr: "Missing credential for provider openai-codex",
    knownFailure: {
      cause: "provider",
      identity: { name: "MissingProviderCredential", code: "openai-codex" },
    },
  });
  assert.equal(
    missingCredentialPreDispatchFailure(undefined, { "openai-codex": false, xai: false }),
    undefined,
  );
});

test("post-run annotation only attaches on nonzero or timeout exits", () => {
  const model = { provider: "xai" as const, model: "grok-4", thinking: "off" as const };
  const credentials = { "openai-codex": false, xai: false };
  assert.deepEqual(
    postRunMissingCredentialFailure({ timedOut: false, code: 1 }, model, credentials)?.identity,
    { name: "MissingProviderCredential", code: "xai" },
  );
  assert.deepEqual(
    postRunMissingCredentialFailure({ timedOut: true, code: null }, model, credentials)?.identity,
    { name: "MissingProviderCredential", code: "xai" },
  );
  assert.equal(
    postRunMissingCredentialFailure({ timedOut: false, code: 0 }, model, credentials),
    undefined,
  );
});

test("seven public runners consume the shared credential seam only", async () => {
  for (const name of RUNNERS) {
    const source = await readFile(join(packageRoot, "src/public-cli", name), "utf8");
    assert.match(
      source,
      /from "\.\/public-run-credentials\.ts"/,
      `${name} must import the shared credential seam`,
    );
    assert.equal(
      source.includes("const missingCredential = knownFailureForMissingProviderCredential"),
      false,
      `${name} must not keep a local pre-dispatch credential block`,
    );
    assert.equal(
      /result\.timedOut \|\| result\.code !== 0\s*\n\s*\? knownFailureForMissingProviderCredential/.test(
        source,
      ),
      false,
      `${name} must not keep a local post-run credential ternary`,
    );
    if (name !== "judge-run.ts") {
      assert.equal(
        source.includes('from "./judge-run.ts"'),
        false,
        `${name} must not import credential helpers from judge-run`,
      );
    }
  }
  const judge = await readFile(join(packageRoot, "src/public-cli/judge-run.ts"), "utf8");
  assert.equal(
    judge.includes("export function knownFailureForMissingProviderCredential"),
    false,
    "judge-run must not own the shared credential helper",
  );
});
