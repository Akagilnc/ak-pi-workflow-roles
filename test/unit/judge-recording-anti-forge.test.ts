import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPackagedSoulMatchesMeta,
  soulTextDigest,
} from "../../src/judge-recording-anti-forge.ts";

test("anti-forge helper rejects mismatched synthetic soul digest", () => {
  // Synthetic data only — zero soul bytes, zero recordings, wording-immune.
  const soulText = "synthetic-soul-body";
  assert.throws(
    () =>
      assertPackagedSoulMatchesMeta(
        {
          packageSha: "deadbeef",
          soulDigest: "0".repeat(64),
        },
        "synthetic-bundle",
        () => soulText,
      ),
    /synthetic-bundle metadata soulDigest must match the soul supplied at consumption/,
  );

  // Positive path with the same synthetic bytes proves construct-at-consumption.
  assert.doesNotThrow(() =>
    assertPackagedSoulMatchesMeta(
      {
        packageSha: "deadbeef",
        soulDigest: soulTextDigest(soulText),
      },
      "synthetic-bundle",
      () => soulText,
    ),
  );
});
