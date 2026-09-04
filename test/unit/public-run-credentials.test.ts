/**
 * Shared public-run credential seam — one owner for missing-credential
 * detection, typed failure construction, pre-dispatch fail-closed, and
 * post-run annotation used by the post-admission coordinator (#517).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  knownFailureForMissingProviderCredential,
  missingCredentialPreDispatchFailure,
  postRunMissingCredentialFailure,
} from "../../src/public-cli/public-run-credentials.ts";

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
