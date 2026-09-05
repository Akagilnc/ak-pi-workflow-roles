import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { testTmpdir } from "../helpers/worktree-temp.ts";

import { RELEASE_SOUL_INVENTORY } from "../helpers/package-entrypoint-fixtures.ts";
import {
  getSharedIsolatedPack,
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  packageRoot,
} from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);

/** Registry-settled package identity (docs/npm-identity.md). */
const SETTLED_PACKAGE_NAME = "@akagilnc/pi-workflow-roles";

const CANONICAL_APACHE_2_0 = await readFile(
  resolve(packageRoot, "test/fixtures/licenses/Apache-2.0.txt"),
  "utf8",
);
const UPSTREAM_MATT_MIT = await readFile(
  resolve(packageRoot, "test/fixtures/licenses/matt-pocock-skills-MIT.txt"),
  "utf8",
);

const HOST_PEERS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "typebox",
] as const;

interface ExtractedPack {
  root: string;
  packageJson: {
    name: string;
    license?: string;
    bin?: Record<string, string>;
    pi?: { extensions?: unknown[] };
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  licenseText: string;
  thirdPartyNoticeText: string;
  paths: string[];
}

async function extractPackedArtifact(): Promise<ExtractedPack> {
  const pack = await getSharedIsolatedPack();
  const root = await mkdtemp(resolve(testTmpdir(), "ak-pack-meta-"));
  try {
    await execFileAsync("tar", ["-xzf", pack.tarball, "-C", root]);
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package/package.json"), "utf8"),
    ) as ExtractedPack["packageJson"];
    const licenseText = await readFile(resolve(root, "package/LICENSE"), "utf8");
    const thirdPartyNoticeText = await readFile(
      resolve(root, "package/THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    return {
      root,
      packageJson,
      licenseText,
      thirdPartyNoticeText,
      paths: pack.files.map((file) => file.path),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * #420 整改：元数据断言全部落在一次解包的只读不可变产物上（解包 8 次 → 1 次，
 * 不触「独立契约塞共享可变状态」禁令）。进程退出时清理唯一 worktree 自建根。
 */
const extracted = await extractPackedArtifact();
process.on("exit", () => {
  try {
    rmSync(extracted.root, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup; never mask test results.
  }
});

/**
 * License identity: project license authority stays Apache-2.0 alone; Matt's
 * MIT ships as a complete separate third-party notice; package name is the
 * registry-settled identity.
 */
test("packed artifact carries the settled license identity", async () => {
  assert.equal(extracted.packageJson.name, SETTLED_PACKAGE_NAME);
  assert.equal(extracted.packageJson.license, "Apache-2.0");
  assert.ok(
    extracted.paths.includes("LICENSE"),
    "npm pack file list must include LICENSE",
  );
  assert.equal(
    extracted.paths.some((path) => path === "patches" || path.startsWith("patches/")),
    false,
    "npm pack must exclude repository-only patches",
  );
  assert.equal(extracted.licenseText, CANONICAL_APACHE_2_0);

  assert.ok(
    extracted.paths.includes("THIRD_PARTY_NOTICES.md"),
    "npm pack file list must include THIRD_PARTY_NOTICES.md",
  );
  // Keyed package metadata: project license authority stays Apache-2.0 alone.
  assert.notEqual(extracted.packageJson.license, "MIT");
  assert.notEqual(extracted.packageJson.license, "Apache-2.0 OR MIT");
  assert.notEqual(extracted.packageJson.license, "(Apache-2.0 OR MIT)");
  assert.notEqual(extracted.thirdPartyNoticeText, extracted.licenseText);
  // Exact license artifact seam — complete upstream MIT text, not free-form prose.
  assert.ok(
    extracted.thirdPartyNoticeText.includes(UPSTREAM_MATT_MIT.trim()),
    "third-party notice must embed the complete upstream Matt Pocock MIT text",
  );
});

/**
 * Method-tree frozen provenance: every shipped method family binds to its
 * upstream commit/tag with per-file sha256/gitBlob pins. Byte binding is owned
 * by provenance.files.sha256 (#420: SKILL.md English-prose substring assertions
 * deleted — prose staring violates ADR 0052 and duplicates the sha256 pin).
 */
test("packed artifact ships frozen method trees bound to upstream provenance", async () => {
  interface MethodProvenance {
    name: string;
    packageAdaptation?: string;
    upstream: {
      repository: string;
      path: string;
      commit: string;
      tag: string;
      attribution: string;
      license: string;
    };
    files: Record<string, { sha256: string; byteLength: number; gitBlob: string }>;
  }
  const readProvenance = async (method: string): Promise<MethodProvenance> =>
    JSON.parse(
      await readFile(
        resolve(extracted.root, `package/resources/methods/${method}/provenance.json`),
        "utf8",
      ),
    ) as MethodProvenance;

  // tdd: full companion set.
  const tddFiles = [
    "resources/methods/tdd/SKILL.md",
    "resources/methods/tdd/tests.md",
    "resources/methods/tdd/mocking.md",
    "resources/methods/tdd/agents/openai.yaml",
    "resources/methods/tdd/provenance.json",
  ];
  for (const path of tddFiles) {
    assert.ok(extracted.paths.includes(path), `npm pack must include ${path}`);
    await access(resolve(extracted.root, "package", path));
  }

  // code-review + diagnosing-bugs trees ship with agents/scripts companions.
  const otherFiles = [
    "resources/methods/code-review/SKILL.md",
    "resources/methods/code-review/agents/openai.yaml",
    "resources/methods/code-review/provenance.json",
    "resources/methods/diagnosing-bugs/SKILL.md",
    "resources/methods/diagnosing-bugs/agents/openai.yaml",
    "resources/methods/diagnosing-bugs/scripts/hitl-loop.template.sh",
    "resources/methods/diagnosing-bugs/provenance.json",
  ];
  for (const path of otherFiles) {
    assert.ok(extracted.paths.includes(path), `npm pack must include ${path}`);
    await access(resolve(extracted.root, "package", path));
  }

  // Frozen provenance bindings per family.
  const expectations = [
    {
      method: "tdd",
      path: "skills/engineering/tdd",
      packageAdaptation: "red-green-advisory-no-historical-compliance-gate",
    },
    {
      method: "code-review",
      path: "skills/engineering/code-review",
      packageAdaptation: "reviewer-no-setup-fixed-target-two-axis",
    },
    {
      method: "diagnosing-bugs",
      path: "skills/engineering/diagnosing-bugs",
      packageAdaptation: "fixer-boundary-no-external-skill-chain",
    },
  ] as const;
  for (const expectation of expectations) {
    const provenance = await readProvenance(expectation.method);
    assert.equal(provenance.name, expectation.method);
    assert.equal(provenance.packageAdaptation, expectation.packageAdaptation);
    assert.equal(provenance.upstream.repository, "https://github.com/mattpocock/skills");
    assert.equal(provenance.upstream.path, expectation.path);
    assert.equal(provenance.upstream.commit, "8b36d4fb2635b3c21998dcd8144439c9e5ba7302");
    assert.equal(provenance.upstream.tag, "v1.2.2");
    assert.equal(provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(provenance.upstream.license, "MIT");
    assert.equal(typeof provenance.files["SKILL.md"]?.sha256, "string");
    assert.equal(provenance.files["SKILL.md"]!.sha256.length, 64);
    assert.equal(typeof provenance.files["SKILL.md"]?.gitBlob, "string");
    assert.equal(provenance.files["SKILL.md"]!.gitBlob.length, 40);
  }
  // Companion-file byte pins survive for every family that ships them.
  const tddProvenance = await readProvenance("tdd");
  for (const file of ["tests.md", "mocking.md"]) {
    assert.equal(typeof tddProvenance.files[file]?.sha256, "string");
    assert.equal(typeof tddProvenance.files[file]?.gitBlob, "string");
  }
  const codeReviewProvenance = await readProvenance("code-review");
  assert.equal(typeof codeReviewProvenance.files["agents/openai.yaml"]?.gitBlob, "string");
  const diagnosingProvenance = await readProvenance("diagnosing-bugs");
  assert.equal(typeof diagnosingProvenance.files["agents/openai.yaml"]?.gitBlob, "string");
  assert.equal(typeof diagnosingProvenance.files["scripts/hitl-loop.template.sh"]?.gitBlob, "string");

  // resolving-merge-conflicts — the one method family without its own deep
  // owner elsewhere; presence + provenance here keep it covered.
  const rmc = [
    "resources/methods/resolving-merge-conflicts/SKILL.md",
    "resources/methods/resolving-merge-conflicts/agents/openai.yaml",
    "resources/methods/resolving-merge-conflicts/provenance.json",
  ];
  for (const rel of rmc) {
    assert.ok(extracted.paths.includes(rel), `pack must include ${rel}`);
  }
  const rmcProvenance = await readProvenance("resolving-merge-conflicts");
  assert.equal(rmcProvenance.name, "resolving-merge-conflicts");
  assert.equal(rmcProvenance.upstream.attribution, "mattpocock/skills");
  assert.equal(rmcProvenance.upstream.license, "MIT");
});

/**
 * Release inventory sole owner: souls, method trees, runtime entrypoints, and
 * the manifest load fields. Absorbs the packed-tarball existence assertions
 * from the former packaged-workers structure test (Doctor/Merger/Navigator
 * sources, compiled dist modules, packets, and the closed fixer-repair.json
 * negative); internal flag/schema shapes stay deleted (schema passthrough in
 * contract/fixer-prerequisite-contract). Install/cold-matrix argv tracers
 * culled under #685 — host install face → production dossiers.
 */
test("packed artifact ships the release inventory: souls, methods, runtime entrypoints, packets", async () => {
  for (const soul of RELEASE_SOUL_INVENTORY) {
    assert.ok(extracted.paths.includes(soul), `pack must include ${soul}`);
  }
  // #443: factory constitution ships on the files surface for every role session.
  assert.ok(
    extracted.paths.includes("CLAUDE.md"),
    "npm pack file list must include CLAUDE.md",
  );

  // Method trees (deep provenance above; presence here completes the inventory).
  for (const method of [
    "resources/methods/tdd/SKILL.md",
    "resources/methods/code-review/SKILL.md",
    "resources/methods/diagnosing-bugs/SKILL.md",
    "resources/methods/resolving-merge-conflicts/SKILL.md",
  ]) {
    assert.ok(extracted.paths.includes(method), `pack must include ${method}`);
  }

  // Runtime entrypoints ship in the artifact.
  assert.ok(
    extracted.paths.includes("dist/public-cli/main.js"),
    "pack must include dist/public-cli/main.js",
  );
  assert.ok(
    extracted.paths.includes(INTERNAL_ROLE_ENTRYPOINT_RELATIVE),
    "pack must include the internal role entrypoint",
  );
  assert.ok(
    extracted.paths.includes("extensions/role-runtime.ts"),
    "pack must include extensions/role-runtime.ts",
  );

  // Doctor seat: source contracts + evidence machinery + souls entry.
  for (const path of [
    "src/doctor-contracts.ts",
    "src/doctor-evidence.ts",
    "src/canonical-json.ts",
  ]) {
    assert.ok(extracted.paths.includes(path), `${path} must be present in the npm tarball`);
  }
  // Navigator seat: source + compiled module and topology dependency.
  assert.ok(extracted.paths.includes("src/navigator-attendance.ts"), "src/navigator-attendance.ts must be present in the npm tarball");
  assert.ok(extracted.paths.includes("dist/navigator-attendance.js"), "dist/navigator-attendance.js must be present in the npm tarball");
  assert.ok(extracted.paths.includes("dist/activation-ledger-topology.js"), "dist/activation-ledger-topology.js must be present in the npm tarball");

  // Merger seat: source chain + packet contract module.
  for (const path of [
    "src/merger-contracts.ts",
    "src/merger-git-state.ts",
    "src/merger-role.ts",
    "src/package-contracts/fixer-packet.ts",
    "dist/package-contracts/fixer-packet.js",
  ]) {
    assert.ok(extracted.paths.includes(path), `${path} must be present in the npm tarball`);
  }

  // Packets: repair doc + prerequisites schema ship; the closed repair.json
  // shell must never come back into the tarball.
  assert.ok(extracted.paths.includes("packets/fixer-repair.md"), "packets/fixer-repair.md must be present in the npm tarball");
  assert.ok(extracted.paths.includes("packets/fixer-prerequisites.json"), "packets/fixer-prerequisites.json must be present in the npm tarball");
  assert.equal(
    extracted.paths.includes("packets/fixer-repair.json"),
    false,
    "removed closed packet shell must not be packed",
  );

  // Manifest load fields: bin mapping and empty auto-extension list (ADR 0052:
  // package auto-registration stays empty; explicit entrypoint owns loading).
  assert.equal(extracted.packageJson.bin?.["ak-role"], "dist/public-cli/main.js");
  assert.deepEqual(extracted.packageJson.pi?.extensions ?? ["missing"], []);
});

// #685: private npm install of packed artifact culled — host install surface.
// Peer optional/* declarations stay as pack-metadata call-input asserts.
// Live install non-materialization → production pack/install runs (C3 handoff).
test("packed artifact declares Pi host peers as optional star peers", () => {
  for (const name of HOST_PEERS) {
    assert.equal(extracted.packageJson.peerDependencies?.[name], "*");
    assert.equal(extracted.packageJson.peerDependenciesMeta?.[name]?.optional, true);
  }
});
