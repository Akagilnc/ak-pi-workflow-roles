import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeMechanicalBundle } from "../../src/reviewer-bundle-materializer.ts";
import { compileMechanicalBundle, type PinnedMechanicalBundleV1 } from "../../src/reviewer-construction.ts";

const make = () =>
  compileMechanicalBundle({
    canonicalSkill: "skill\n",
    task: "task\n",
    range: {
      base: "A",
      target: "B",
      diffCommand: "git diff A...B",
      diffSha256: "1".repeat(64),
      commits: ["B"],
    },
    materials: [{
      id: "m",
      repositoryPath: "M.md",
      text: "material\n",
      sha256: "2".repeat(64),
    }],
  }).bundle;

async function root() {
  return mkdtemp(join(tmpdir(), "bundle-test-"));
}

test("materializer installs exact common bundle and verifies readback", async () => {
  const r = await root();
  try {
    const b = make();
    const e = await materializeMechanicalBundle(r, "standards", b);
    assert.equal(e.entries.every((x) => x.verified), true);
    for (const x of b.entries) {
      assert.equal(await readFile(join(r, x.relativeClonePath), "utf8"), x.bytes);
    }
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

test("materializer rejects digest and manifest mutation atomically", async () => {
  // Identity check runs before realpath(workspace); no tmpdir required.
  for (const mutate of [
    (b: PinnedMechanicalBundleV1) => ({ ...b, manifestSha256: "0".repeat(64) }),
    (b: PinnedMechanicalBundleV1) => ({
      ...b,
      entries: [{ ...b.entries[0]!, bytes: "changed" }, ...b.entries.slice(1)],
    }),
  ]) {
    await assert.rejects(
      materializeMechanicalBundle("/nonexistent-workspace-path-xyz", "standards", mutate(make()) as PinnedMechanicalBundleV1),
      /Mechanical bundle digest or manifest mismatch/,
    );
  }
});

test("materializer rejects traversal, absolute paths, collisions, and symlink parents", async () => {
  // Hostile paths must be built through compile so the manifest stays valid
  // and confinement (not digest mismatch) is the rejecting gate.
  const r = await root();
  try {
    for (const id of ["../../../escape", "/absolute", "foo/../../../escape"]) {
      const hostile = compileMechanicalBundle({
        canonicalSkill: "skill\n",
        task: "task\n",
        range: {
          base: "A",
          target: "B",
          diffCommand: "git diff A...B",
          diffSha256: "1".repeat(64),
          commits: ["B"],
        },
        materials: [{
          id,
          repositoryPath: "M.md",
          text: "material\n",
          sha256: "2".repeat(64),
        }],
      }).bundle;
      await assert.rejects(
        materializeMechanicalBundle(r, "standards", hostile),
        /Mechanical bundle path is not confined/,
      );
    }
  } finally {
    await rm(r, { recursive: true, force: true });
  }

  const symlinkRoot = await root();
  try {
    await mkdir(join(symlinkRoot, "outside"));
    await mkdir(join(symlinkRoot, ".ak-reviewer"));
    await symlink(join(symlinkRoot, "outside"), join(symlinkRoot, ".ak-reviewer", "materials"));
    await assert.rejects(
      materializeMechanicalBundle(symlinkRoot, "spec", make()),
      /symlink|confined/i,
    );
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true });
  }
});

test("existing destination collision does not overwrite reviewed clone content", async () => {
  const r = await root();
  const b = make();
  const p = join(r, b.entries[0]!.relativeClonePath);
  try {
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, "owned\n");
    await assert.rejects(materializeMechanicalBundle(r, "standards", b), /collision/);
    assert.equal(await readFile(p, "utf8"), "owned\n");
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});
