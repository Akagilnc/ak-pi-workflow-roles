import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #109 package-owned method Skill seam — empty home, no network, exact provenance.
 */
import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

import { loadPackagedCanonicalSkillBinding } from "../../src/package-resources/method-skill-binding.ts";
import {
  gitBlobOid,
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
} from "../../src/package-resources/method-skill.ts";
import { sha256Hex } from "../../src/sha256.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const originalHome = process.env.HOME;

async function withEmptyHome<T>(run: () => Promise<T>): Promise<T> {
  return await withTempRoot("ak-empty-home-method-", async (home) => {
  process.env.HOME = home;
    return withPrimaryAwareCleanup(
      async () => {

    // Empty home: no ~/.agents/skills at all.
    await assert.rejects(
      () => access(join(home, ".agents", "skills")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    return await run();
        },
      async () => { if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome; }
    );
  });
}

test("packaged tdd method loads from package root in empty home with upstream identity and current-byte provenance", async () => {
  await withEmptyHome(async () => {
    const material = await loadPackagedMethodSkillMaterial(packageRoot, "tdd");
    assert.equal(material.name, "tdd");
    assert.equal(material.body.includes("Test-Driven Development"), true);
    assert.equal(material.companionRelativePaths.includes("tests.md"), true);
    assert.equal(material.companionRelativePaths.includes("mocking.md"), true);
    assert.equal(
      material.companionRelativePaths.includes("agents/openai.yaml"),
      true,
    );
    assert.equal(
      material.provenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(material.provenance.upstream.path, "skills/engineering/tdd");
    assert.equal(
      material.provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(material.provenance.upstream.tag, "v1.2.2");
    assert.equal(material.provenance.upstream.license, "MIT");
    assert.equal(
      material.provenance.upstream.copyright,
      "Copyright (c) 2026 Matt Pocock",
    );
    assert.equal(material.provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(
      material.provenance.packageAdaptation,
      "red-green-advisory-no-historical-compliance-gate",
    );

    for (const [rel, expected] of Object.entries(material.provenance.files)) {
      const actual = material.provenance.files[rel];
      assert.ok(actual, `missing file pin ${rel}`);
      assert.equal(actual.sha256, expected.sha256);
      assert.equal(actual.byteLength, expected.byteLength);
      assert.equal(actual.gitBlob, expected.gitBlob);
      const bytes = await readFile(join(material.rootDirectory, rel));
      assert.equal(sha256Hex(bytes), expected.sha256);
      assert.equal(gitBlobOid(bytes), expected.gitBlob);
    }

    // Companion body prose titles are not an integrity seam — sha256/gitBlob pins above own bytes.

    // Skill path is under the package tree, not HOME.
    assert.equal(material.skillPath.includes(packageRoot), true);
    assert.equal(material.skillPath.includes(".agents/skills"), false);
  });
});

test("provenance without immutable upstream commit is rejected", async () => {
  await withEmptyHome(async () => {
    await withTempRoot("ak-method-no-commit-", async (tempRoot) => {
      const packageRootTemp = join(tempRoot, "pkg");
      const methodDir = join(packageRootTemp, "resources/methods/tdd");
      await cp(join(packageRoot, "resources/methods/tdd"), methodDir, {
        recursive: true,
      });
      const provenancePath = join(methodDir, "provenance.json");
      const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as {
        upstream: Record<string, unknown>;
      };
      delete provenance.upstream.commit;
      await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
      await assert.rejects(
        () => loadPackagedMethodSkillMaterial(packageRootTemp, "tdd"),
        /upstream\.commit/,
      );
        });
  });
});

test("packaged diagnosing-bugs loads adapted boundary method without external skill-chain handoff", async () => {
  await withEmptyHome(async () => {
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "diagnosing-bugs",
    );
    assert.equal(material.name, "diagnosing-bugs");
    assert.equal(material.body.includes("Diagnosing Bugs"), true);
    assert.equal(
      material.provenance.packageAdaptation,
      "fixer-boundary-no-external-skill-chain",
    );
    assert.equal(
      material.provenance.upstream.path,
      "skills/engineering/diagnosing-bugs",
    );
    assert.equal(
      material.provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(material.provenance.upstream.tag, "v1.2.2");
    assert.equal(material.companionRelativePaths.includes("agents/openai.yaml"), true);
    assert.equal(
      material.companionRelativePaths.includes("scripts/hitl-loop.template.sh"),
      true,
    );
    // Adaptation forbids automatic role-external Skill chain / architecture Grill launch.
    assert.equal(material.body.includes("hand off to the `/improve-codebase-architecture`"), false);
    assert.equal(material.body.includes("Do **not** launch"), true);
    assert.equal(material.body.includes("architecture Grill"), true);
    assert.equal(material.skillPath.includes(packageRoot), true);
    assert.equal(material.skillPath.includes(".agents/skills"), false);
  });
});

test("packaged tdd binding captures expansion against package skill path only", async () => {
  await withEmptyHome(async () => {
    const binding = await loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
    assert.equal(binding.name, "tdd");
    const request = "Implement the approved slice.";
    assert.equal(binding.invocation(request), `/skill:tdd ${request}`);

    // Use binding snapshot paths for exact expansion (realpath may differ by OS).
    const location = binding.snapshot.path;
    const expectedContent = `References are relative to ${binding.snapshot.baseDir}.\n\n${binding.snapshot.body}`;
    assert.deepEqual(binding.captureExpansion({ name: "tdd", location, content: expectedContent, userMessage: request }, request), {
      name: "tdd",
      location,
      content: expectedContent,
      userMessage: request,
    });

    // Configured (non-realpath) package path spelling is also accepted.
    const configuredPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
    const configuredExpected = `References are relative to ${dirname(configuredPath)}.\n\n${binding.snapshot.body}`;
    assert.deepEqual(binding.captureExpansion({ name: "tdd", location: configuredPath, content: configuredExpected, userMessage: request }, request), {
      name: "tdd",
      location: configuredPath,
      content: configuredExpected,
      userMessage: request,
    });

    // Ambient home path must not satisfy package binding.
    assert.equal(binding.captureExpansion({ name: "tdd", location: "/tmp/fake-home/.agents/skills/tdd/SKILL.md", content: expectedContent, userMessage: request }, request), undefined);
  });
});

test("packaged code-review loads adapted two-axis method without Matt setup", async () => {
  await withEmptyHome(async () => {
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "code-review",
    );
    assert.equal(material.name, "code-review");
    assert.equal(material.body.includes("Standards"), true);
    assert.equal(material.body.includes("Spec"), true);
    assert.equal(
      material.provenance.packageAdaptation,
      "reviewer-no-setup-fixed-target-two-axis",
    );
    assert.equal(
      material.provenance.upstream.path,
      "skills/engineering/code-review",
    );
    assert.equal(
      material.provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(material.provenance.upstream.tag, "v1.2.2");
    assert.equal(
      material.companionRelativePaths.includes("agents/openai.yaml"),
      true,
    );
    // Adaptation forbids Matt setup / governance mutation and product repairs.
    assert.equal(material.body.includes("/setup-matt-pocock-skills"), true);
    assert.equal(
      material.body.includes("Do **not** run `/setup-matt-pocock-skills`"),
      true,
    );
    assert.equal(material.body.includes("must **not** modify project governance"), true);
    assert.equal(material.body.includes("scratch probes"), true);
    assert.equal(
      material.body.includes("never turn the review into product repairs"),
      true,
    );
    assert.equal(material.skillPath.includes(packageRoot), true);
    assert.equal(material.skillPath.includes(".agents/skills"), false);
  });
});

test("packaged code-review binding captures expansion against package skill path only", async () => {
  await withEmptyHome(async () => {
    const binding = await loadPackagedCanonicalSkillBinding(packageRoot, "code-review");
    assert.equal(binding.name, "code-review");
    const request = "Review the branch since main.";
    assert.equal(binding.invocation(request), `/skill:code-review ${request}`);

    const location = binding.snapshot.path;
    const expectedContent = `References are relative to ${binding.snapshot.baseDir}.\n\n${binding.snapshot.body}`;
    assert.deepEqual(binding.captureExpansion({ name: "code-review", location, content: expectedContent, userMessage: request }, request), {
      name: "code-review",
      location,
      content: expectedContent,
      userMessage: request,
    });

    const configuredPath = resolvePackagedMethodSkillPath(
      packageRoot,
      "code-review",
    );
    const configuredExpected = `References are relative to ${dirname(configuredPath)}.\n\n${binding.snapshot.body}`;
    assert.deepEqual(binding.captureExpansion({ name: "code-review", location: configuredPath, content: configuredExpected, userMessage: request }, request), {
      name: "code-review",
      location: configuredPath,
      content: configuredExpected,
      userMessage: request,
    });

    assert.equal(binding.captureExpansion({ name: "code-review", location: "/tmp/fake-home/.agents/skills/code-review/SKILL.md", content: expectedContent, userMessage: request }, request), undefined);
  });
});

test("packaged resolving-merge-conflicts loads merge-only method that escalates new authority", async () => {
  await withEmptyHome(async () => {
    const material = await loadPackagedMethodSkillMaterial(
      packageRoot,
      "resolving-merge-conflicts",
    );
    assert.equal(material.name, "resolving-merge-conflicts");
    assert.equal(
      material.provenance.packageAdaptation,
      "merger-merge-only-escalate-new-intent",
    );
    assert.equal(
      material.provenance.upstream.path,
      "skills/engineering/resolving-merge-conflicts",
    );
    assert.equal(
      material.provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(material.provenance.upstream.tag, "v1.2.2");
    assert.equal(
      material.companionRelativePaths.includes("agents/openai.yaml"),
      true,
    );
    // Keep primary-source investigation and authorized checks.
    assert.equal(material.body.includes("primary sources"), true);
    assert.equal(material.body.includes("authorized checks"), true);
    // Merge-only: no unconditional resolve authority; no rebase workflow.
    assert.equal(material.body.includes("Always resolve"), false);
    assert.equal(material.body.includes("merge-only"), true);
    assert.equal(material.body.includes("escalate"), true);
    assert.equal(material.body.includes("continue a rebase"), true);
    assert.equal(
      /If rebasing, continue the rebase/.test(material.body),
      false,
    );
    assert.equal(material.skillPath.includes(packageRoot), true);
    assert.equal(material.skillPath.includes(".agents/skills"), false);
  });
});
