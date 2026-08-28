/**
 * Shared public-run credential seam — one owner for missing-credential
 * detection, typed failure construction, pre-dispatch fail-closed, and
 * post-run annotation used by the post-admission coordinator (#517).
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

/** All 8 public role runners dispatch through the unified post-admission coordinator. */
const ALL_ROLE_RUNNERS = [
  "coder-run.ts",
  "collector-run.ts",
  "doctor-run.ts",
  "fixer-run.ts",
  "judge-run.ts",
  "merger-run.ts",
  "notary-run.ts",
  "reviewer-run.ts",
] as const;

const POST_ADMISSION_COORDINATOR = "post-admission.ts";

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

test("credential seam ownership follows post-admission coordinator topology", async () => {
  const coordinatorSource = await readFile(
    join(packageRoot, "src/public-cli", POST_ADMISSION_COORDINATOR),
    "utf8",
  );
  assert.match(
    coordinatorSource,
    /from "\.\/public-run-credentials\.ts"/,
    `${POST_ADMISSION_COORDINATOR} must own credential checks for post-admission dispatch`,
  );
  assert.equal(
    coordinatorSource.includes("const missingCredential = knownFailureForMissingProviderCredential"),
    false,
    `${POST_ADMISSION_COORDINATOR} must use the shared pre-dispatch helper`,
  );

  for (const name of ALL_ROLE_RUNNERS) {
    const source = await readFile(join(packageRoot, "src/public-cli", name), "utf8");
    assert.match(
      source,
      /from "\.\/post-admission\.ts"/,
      `${name} must dispatch through the shared post-admission coordinator`,
    );
    assert.equal(
      /from "\.\/public-run-credentials\.ts"/.test(source),
      false,
      `${name} must not re-import credentials outside the post-admission coordinator`,
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
  }
});
