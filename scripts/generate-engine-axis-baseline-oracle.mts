/**
 * Freeze #356 default-path byte oracle from baseline builders at 3aec6621.
 *
 * Provenance command (run against baseline builders, not package HEAD):
 *   git worktree add --detach /tmp/ak-engine-baseline-3aec6621 3aec6621
 *   ln -sfn <repo>/node_modules /tmp/ak-engine-baseline-3aec6621/node_modules
 *   mkdir -p /tmp/ak-engine-baseline-3aec6621/scripts
 *   cp <repo>/scripts/generate-engine-axis-baseline-oracle.mts \
 *      /tmp/ak-engine-baseline-3aec6621/scripts/
 *   cd /tmp/ak-engine-baseline-3aec6621
 *   GOLDEN_OUT=<repo>/test/fixtures/engine-axis-baseline \
 *     node --import tsx ./scripts/generate-engine-axis-baseline-oracle.mts
 *
 * Fixture path: test/fixtures/engine-axis-baseline/default-path-no-engine.json
 * Non-deterministic bytes (run id / timestamp / real LLM output) are absent
 * under the frozen admitted inputs below — no exclusion mask required.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COLLECTOR_FIXED_KICKOFF } from "../src/collector-config.ts";
import { buildCollectorActivationExtraArgs } from "../src/public-cli/collector-run.ts";
import { buildCoderActivationExtraArgs } from "../src/public-cli/coder-run.ts";
import { buildJudgeActivationExtraArgs } from "../src/public-cli/judge-run.ts";
import {
  buildCollectorTransportPrompt,
  buildCoderTransportPrompt,
  buildJudgeTransportPrompt,
  type AdmittedCoderInvocation,
  type AdmittedCollectorInvocation,
  type AdmittedJudgeInvocation,
} from "../src/public-cli/invocation.ts";

const judge: AdmittedJudgeInvocation = {
  role: "judge",
  runId: "run-engine-oracle",
  bookKey: "book",
  projectRoot: "/project",
  instruction: "Decide the matter.",
  instructionEmpty: false,
  attachments: [],
  runDirectory: "/runs/r",
  sessionDirectory: "/runs/r/session",
  sessionFile: "/runs/r/session/session.jsonl",
  admittedRequestPath: "/runs/r/admitted-request.json",
};

const coder: AdmittedCoderInvocation = {
  role: "coder",
  runId: "run-engine-oracle",
  bookKey: "book",
  projectRoot: "/project",
  phase: "apply",
  instruction: "Implement the slice.",
  instructionEmpty: false,
  attachments: [],
  runDirectory: "/runs/r",
  sessionDirectory: "/runs/r/session",
  sessionFile: "/runs/r/session/session.jsonl",
  admittedRequestPath: "/runs/r/admitted-request.json",
  taskPath: "/runs/r/task.md",
};

const collector: AdmittedCollectorInvocation = {
  role: "collector",
  runId: "run-engine-oracle",
  bookKey: "book",
  projectRoot: "/project",
  instruction: "",
  instructionEmpty: true,
  attachments: [],
  runDirectory: "/runs/r",
  sessionDirectory: "/runs/r/session",
  sessionFile: "/runs/r/session/session.jsonl",
  admittedRequestPath: "/runs/r/admitted-request.json",
  prNumber: 42,
  repository: {
    display: "acme/widgets",
    canonical: "acme/widgets",
    owner: "acme",
    repo: "widgets",
  },
  manifestDigest: "abc",
};

/** packageRoot only affects coder skill path; pin absolute frozen value. */
const packageRoot = "/frozen-package-root";

const golden = {
  provenance: {
    baseline: "3aec6621",
    note: "Generated from baseline builders at 3aec6621 with frozen admitted inputs. Non-deterministic bytes (run id/timestamp/LLM output) are absent from these builders' outputs under frozen inputs.",
    generator: "scripts/generate-engine-axis-baseline-oracle.mts",
    command:
      "git worktree add --detach /tmp/ak-engine-baseline-3aec6621 3aec6621 && ln -sfn <repo>/node_modules /tmp/ak-engine-baseline-3aec6621/node_modules && mkdir -p /tmp/ak-engine-baseline-3aec6621/scripts && cp <repo>/scripts/generate-engine-axis-baseline-oracle.mts /tmp/ak-engine-baseline-3aec6621/scripts/ && cd /tmp/ak-engine-baseline-3aec6621 && GOLDEN_OUT=<repo>/test/fixtures/engine-axis-baseline node --import tsx ./scripts/generate-engine-axis-baseline-oracle.mts",
  },
  inputs: {
    judge,
    coder,
    collector,
    packageRoot,
  },
  outputs: {
    judge: {
      transportPrompt: buildJudgeTransportPrompt(judge),
      activationArgv: buildJudgeActivationExtraArgs(judge, {}),
    },
    coder: {
      transportPrompt: buildCoderTransportPrompt(coder),
      activationArgv: buildCoderActivationExtraArgs(coder, { packageRoot }),
    },
    collector: {
      transportPrompt: buildCollectorTransportPrompt(collector),
      activationArgv: buildCollectorActivationExtraArgs(collector, {}),
      fixedKickoff: COLLECTOR_FIXED_KICKOFF,
    },
  },
};

const outDir = process.env.GOLDEN_OUT ?? join(process.cwd(), "test/fixtures/engine-axis-baseline");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "default-path-no-engine.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
console.log(outPath);
