import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  type Api,
  type Model,
  type Provider,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { prepareComplianceDispatch } from "./compliance-transport.ts";
import { parseReviewerRefSnapshot, reviewerRefSnapshotArgs, sameReviewerPinnedTarget, sameReviewerRefs, type ReviewerRefEntry } from "./reviewer-git-snapshot.ts";
import { isReviewerPromptIdentity, reviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import type {
  AcceptedReviewerExecution,
  AcceptedReviewerLeg,
  ReviewerPrerequisiteOperation,
} from "./reviewer-dispatch.ts";
import { REVIEWER_VERIFICATION_POLICY } from "./reviewer-verification-policy.ts";
import { materializeMechanicalBundle, type MaterializedBundleEvidenceV1 } from "./reviewer-bundle-materializer.ts";
import type {
  ReviewerTargetSnapshot,
  ReviewerWorkspaceDisposition,
  ReviewerFailureClassification,
  ReviewerUsage,
} from "./reviewer-execution-ledger.ts";

const RUNNER_PREREQUISITES = [
  "runner.git.materialize-mirror",
  "runner.git.materialize-workspace",
  "runner.git.verify-snapshot",
] as const satisfies readonly ReviewerPrerequisiteOperation[];

export type ReviewerSuccessfulLegRunResult = Readonly<{
  status: "successful"; report: string; usage: ReviewerUsage;
  target: ReviewerTargetSnapshot; prompt: ReviewerPromptIdentity;
  workspaceDisposition: ReviewerWorkspaceDisposition;
  runtimeConstructionEvidence?: MaterializedBundleEvidenceV1;
}>;
export type ReviewerFailedLegRunResult = Readonly<{
  status: "failed"; failure: ReviewerFailureClassification;
  target: ReviewerTargetSnapshot; prompt: ReviewerPromptIdentity;
  workspaceDisposition: ReviewerWorkspaceDisposition;
}>;
export type ReviewerLegRunResult = ReviewerSuccessfulLegRunResult | ReviewerFailedLegRunResult;
type ReviewerRunEnvelope<Legs> = Readonly<{
  identity: string; target: ReviewerTargetSnapshot; legs: Readonly<Legs>;
}>;
type ReviewerOneLegResult<Leg> = ReviewerRunEnvelope<{ standards: Leg; spec?: never }>;
type ReviewerTwoLegResult<Leg> = ReviewerRunEnvelope<{ standards: Leg; spec: Leg }>;
export type ReviewerDispatchRunResult = ReviewerOneLegResult<ReviewerLegRunResult> | ReviewerTwoLegResult<ReviewerLegRunResult>;
export type ReviewerSuccessfulDispatchRunResult = ReviewerOneLegResult<ReviewerSuccessfulLegRunResult> | ReviewerTwoLegResult<ReviewerSuccessfulLegRunResult>;
export class ReviewerDispatchExecutionError extends Error {
  constructor(readonly outcome: ReviewerDispatchRunResult) { super("Reviewer dispatch execution failed"); this.name = "ReviewerDispatchExecutionError"; }
}
export type ReviewerAgentRunner = {
  run(dispatch: AcceptedReviewerExecution, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ReviewerSuccessfulDispatchRunResult>;
  shutdown(): Promise<void>;
};
export type ReviewerAgentFaultPoint =
  | "snapshot.head" | "snapshot.refs"
  | "mirror.before-create" | "mirror.create" | "mirror.verify"
  | "workspace.before-create" | "workspace.init" | "workspace.fetch" | "workspace.verify"
  | "child.reload" | "child.session";
type ReviewerAgentDependencies = Readonly<{ fault?(operation: ReviewerAgentFaultPoint): void }>;

type GitSnapshot = ReviewerTargetSnapshot & {
  mirrorRoot: string;
  mirrorPath: string;
};

type CommandResult = { stdout: string; stderr: string; code: number };

type ClassifiedReviewerError = Error & Readonly<{ reviewerFailure: ReviewerFailureClassification }>;

function classifiedError(
  error: unknown,
  reviewerFailure: ReviewerFailureClassification,
  evidence: {
    workspaceDisposition?: ReviewerWorkspaceDisposition;
    targetSnapshot?: ReviewerTargetSnapshot;
  } = {},
): ClassifiedReviewerError {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  const classification = "reviewerFailure" in wrapped
    ? (wrapped as ClassifiedReviewerError).reviewerFailure
    : reviewerFailure;
  return Object.assign(wrapped, { reviewerFailure: classification }, evidence);
}

function classifyFailure(error: unknown, signal?: AbortSignal): ReviewerFailureClassification {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  if (typeof error === "object" && error !== null && "reviewerFailure" in error) {
    return (error as ClassifiedReviewerError).reviewerFailure;
  }
  return "unknown";
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    allowedCodes?: readonly number[];
  } = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const actualCode = code ?? 1;
      if ((options.allowedCodes ?? [0]).includes(actualCode)) {
        resolve({ stdout, stderr, code: actualCode });
      } else {
        reject(new Error(
          `${command} ${args.join(" ")} failed (${actualCode}): ${stderr.trim() || stdout.trim()}`,
        ));
      }
    });
  });
}

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  allowedCodes?: readonly number[],
): Promise<CommandResult> {
  return runCommand("git", ["-C", cwd, ...args], {
    ...(signal === undefined ? {} : { signal }),
    ...(allowedCodes === undefined ? {} : { allowedCodes }),
  });
}

async function readRefs(
  cwd: string,
  signal?: AbortSignal,
): Promise<Record<string, ReviewerRefEntry>> {
  const result = await git(
    cwd,
    reviewerRefSnapshotArgs(),
    signal,
  );
  return parseReviewerRefSnapshot(result.stdout.trim());
}

async function verifySnapshot(
  cwd: string,
  snapshot: ReviewerTargetSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  const objectFormat = (await git(cwd, ["rev-parse", "--show-object-format"], signal)).stdout.trim();
  if (objectFormat !== snapshot.objectFormat) throw new Error("Review clone object format does not match the pinned session snapshot");
  const head = (await git(cwd, ["rev-parse", "HEAD^{commit}"], signal)).stdout.trim();
  if (head !== snapshot.targetHead) {
    throw new Error(
      `Review clone target mismatch: expected ${snapshot.targetHead}, got ${head}`,
    );
  }
  const refs = await readRefs(cwd, signal);
  if (!sameReviewerRefs(refs, snapshot.refs)) {
    throw new Error("Review clone ref map does not match the pinned session snapshot");
  }
  for (const entry of Object.values(snapshot.refs)) {
    await git(cwd, ["cat-file", "-e", `${entry.objectId}^{object}`], signal);
    if (entry.peeledCommitId !== null) {
      await git(cwd, ["cat-file", "-e", `${entry.peeledCommitId}^{commit}`], signal);
    }
  }
}

async function prepareSnapshot(
  accepted: ReviewerTargetSnapshot,
  signal?: AbortSignal,
  dependencies: ReviewerAgentDependencies = {},
): Promise<GitSnapshot> {
  const repositoryRoot = accepted.repositoryRoot;
  let mirrorRoot: string | undefined;
  try {
    dependencies.fault?.("snapshot.head");
    const objectFormat = (await git(repositoryRoot, ["rev-parse", "--show-object-format"], signal)).stdout.trim();
    if (objectFormat !== accepted.objectFormat) throw new Error("Accepted Reviewer object format no longer matches the repository");
    const targetHead = (
      await git(repositoryRoot, ["rev-parse", "HEAD^{commit}"], signal)
    ).stdout.trim();
    dependencies.fault?.("snapshot.refs");
    const refs = await readRefs(repositoryRoot, signal);
    if (!sameReviewerPinnedTarget({ repositoryRoot, objectFormat: accepted.objectFormat, targetHead, refs }, accepted)) {
      throw new Error("Accepted Reviewer target/ref identity no longer matches the repository");
    }
    dependencies.fault?.("mirror.before-create");
    mirrorRoot = await mkdtemp(join(tmpdir(), "ak-reviewer-snapshot-"));
    const mirrorPath = join(mirrorRoot, "repository.git");
    dependencies.fault?.("mirror.create");
    await runCommand(
      "git",
      ["clone", "--mirror", "--no-hardlinks", repositoryRoot, mirrorPath],
      signal === undefined ? {} : { signal },
    );
    const targetPresent = await git(
      mirrorPath,
      ["cat-file", "-e", `${targetHead}^{commit}`],
      signal,
      [0, 1, 128],
    );
    if (targetPresent.code !== 0) {
      await git(mirrorPath, ["fetch", "--no-tags", repositoryRoot, targetHead], signal);
      await git(
        mirrorPath,
        ["update-ref", "refs/ak-reviewer/target", targetHead],
        signal,
      );
    }
    dependencies.fault?.("mirror.verify");
    const mirrorRefs = await readRefs(mirrorPath, signal);
    if (!sameReviewerRefs(mirrorRefs, refs)) {
      throw new Error("Bare review mirror ref map changed while the snapshot was prepared");
    }
    const preservedObjects = Object.values(refs).flatMap((entry) =>
      entry.peeledCommitId === null
        ? [entry.objectId]
        : [entry.objectId, entry.peeledCommitId]
    );
    for (const object of new Set([targetHead, ...preservedObjects])) {
      await git(mirrorPath, ["cat-file", "-e", `${object}^{object}`], signal);
    }
    await git(
      mirrorPath,
      ["config", "--remove-section", "remote.origin"],
      signal,
      [0, 5, 128],
    );
    return { repositoryRoot, objectFormat: accepted.objectFormat, targetHead, refs, mirrorRoot, mirrorPath };
  } catch (error) {
    throw classifiedError(error, "snapshot", {
      workspaceDisposition: mirrorRoot === undefined ? "not-created" : { retained: mirrorRoot },
      targetSnapshot: accepted,
    });
  }
}

async function prepareWorkspace(
  snapshot: GitSnapshot,
  signal?: AbortSignal,
  dependencies: ReviewerAgentDependencies = {},
): Promise<string> {
  let workspace: string | undefined;
  try {
    dependencies.fault?.("workspace.before-create");
    workspace = await mkdtemp(join(tmpdir(), "ak-reviewer-leg-"));
    dependencies.fault?.("workspace.init");
    await git(workspace, ["init", `--object-format=${snapshot.objectFormat}`, "--initial-branch=ak-reviewer-unborn"], signal);
    dependencies.fault?.("workspace.fetch");
    await git(
      workspace,
      [
        "fetch",
        "--no-tags",
        "--force",
        "--update-shallow",
        snapshot.mirrorPath,
        snapshot.targetHead,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
        "+refs/remotes/*:refs/remotes/*",
      ],
      signal,
    );
    await git(
      workspace,
      ["config", "--remove-section", "remote.origin"],
      signal,
      [0, 5, 128],
    );
    await git(workspace, ["checkout", "--detach", snapshot.targetHead], signal);
    dependencies.fault?.("workspace.verify");
    await verifySnapshot(workspace, snapshot, signal);
    return workspace;
  } catch (error) {
    throw classifiedError(error, "workspace", {
      workspaceDisposition: workspace === undefined ? "not-created" : { retained: workspace },
      targetSnapshot: {
        repositoryRoot: snapshot.repositoryRoot,
        objectFormat: snapshot.objectFormat,
        targetHead: snapshot.targetHead,
        refs: { ...snapshot.refs },
      },
    });
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, next: Usage): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.totalTokens += next.totalTokens;
  total.cost.input += next.cost.input;
  total.cost.output += next.cost.output;
  total.cost.cacheRead += next.cost.cacheRead;
  total.cost.cacheWrite += next.cost.cacheWrite;
  total.cost.total += next.cost.total;
}

async function createChildRuntime(
  context: ExtensionContext,
): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const activeModel = context.model;
  if (activeModel === undefined) {
    throw new Error("Reviewer Agent requires an active model");
  }
  const dispatch = await prepareComplianceDispatch(
    activeModel,
    context,
    "Reviewer Agent",
  );
  const parentProvider = context.modelRegistry.getProvider(activeModel.provider);
  if (parentProvider === undefined) {
    throw new Error(`Reviewer Agent provider not found: ${activeModel.provider}`);
  }
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const provider: Provider = {
    id: parentProvider.id,
    name: parentProvider.name,
    ...(parentProvider.baseUrl === undefined
      ? {}
      : { baseUrl: parentProvider.baseUrl }),
    ...(parentProvider.headers === undefined
      ? {}
      : { headers: parentProvider.headers }),
    auth: {
      apiKey: {
        name: "Inherited Reviewer Agent authentication",
        async resolve() {
          return {
            auth: {
              ...(dispatch.auth.apiKey === undefined
                ? {}
                : { apiKey: dispatch.auth.apiKey }),
              ...(dispatch.auth.headers === undefined
                ? {}
                : { headers: dispatch.auth.headers }),
              ...(dispatch.model.baseUrl === undefined
                ? {}
                : { baseUrl: dispatch.model.baseUrl }),
            },
            ...(dispatch.auth.env === undefined
              ? {}
              : { env: dispatch.auth.env }),
          };
        },
      },
    },
    getModels() { return [dispatch.model]; },
    stream(model, childContext, options) {
      return parentProvider.stream(model, childContext, options);
    },
    streamSimple(model, childContext, options) {
      return parentProvider.streamSimple(model, childContext, options);
    },
  };
  runtime.registerNativeProvider(provider);
  return { runtime, model: dispatch.model };
}

async function runChild(
  workspace: string,
  leg: AcceptedReviewerLeg,
  context: ExtensionContext,
  signal?: AbortSignal,
  fault?: ReviewerAgentDependencies["fault"],
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptIdentity }> {
  const childConfigDir = await mkdtemp(join(tmpdir(), "ak-reviewer-child-"));
  try {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: childConfigDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: [
      "Work only in the supplied writable review clone.",
      REVIEWER_VERIFICATION_POLICY,
      "Inspect and probe; do not repair the reviewed product, commit, push, or mutate remotes.",
      "Clearly distinguish scratch artifacts and probe changes from facts about the pinned reviewed target.",
      "Return one substantive non-blank review-leg report.",
    ].join("\n"),
  });
  fault?.("child.reload");
  await loader.reload();
  let runtime: ModelRuntime;
  let model: Model<Api>;
  try {
    ({ runtime, model } = await createChildRuntime(context));
  } catch (error) {
    throw classifiedError(error, "provider");
  }
  const customTools = leg.grant.tools.includes("bash")
    ? [{
        ...createBashTool(workspace),
        async execute(...args: any[]) {
          const input = args[1] as { command?: unknown };
          if (typeof input.command !== "string" || !leg.grant.bashCommands.includes(input.command)) {
            throw new Error("Reviewer bash command denied: command is not an exact accepted member");
          }
          return (createBashTool(workspace).execute as any)(...args);
        },
      }]
    : [];
  fault?.("child.session");
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: childConfigDir,
    model,
    thinkingLevel: context.thinkingLevel ?? "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: [...leg.grant.tools],
    customTools,
    sessionManager: context.sessionManager?.getSessionFile?.() === undefined
      ? SessionManager.inMemory(workspace)
      : SessionManager.create(
          workspace,
          join(context.sessionManager.getSessionDir(), "reviewer-legs"),
        ),
    settingsManager: settings,
  });
  const usage = emptyUsage();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      addUsage(usage, event.message.usage);
    }
  });
  const abortChild = () => { void session.abort(); };
  if (signal?.aborted) abortChild();
  else signal?.addEventListener("abort", abortChild, { once: true });
  try {
    const visibleTools = session.agent.state.tools.map((tool) => tool.name);
    if (JSON.stringify(visibleTools) !== JSON.stringify(leg.grant.tools)) {
      throw new Error(`Reviewer child tool isolation failed: ${visibleTools.join(", ")}`);
    }
    const delivered = leg.prompt;
    try {
      await session.prompt(delivered.text);
    } catch (error) {
      throw classifiedError(error, "provider");
    }
    if (signal?.aborted) {
      throw new Error("Reviewer Agent was cancelled");
    }
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
      throw classifiedError(new Error(`Reviewer Agent provider failed: ${lastAssistant.errorMessage ?? lastAssistant.stopReason}`), "provider");
    }
    if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason === "aborted") {
      throw classifiedError(new Error(`Reviewer Agent child failed: ${lastAssistant?.role === "assistant" ? lastAssistant.stopReason : "no assistant output"}`), "child");
    }
    const report = session.getLastAssistantText() ?? "";
    if (report.trim().length === 0) {
      throw new Error("Reviewer Agent returned a blank child report");
    }
    return { report, usage, prompt: delivered };
  } catch (error) {
    throw classifiedError(error, "child");
  } finally {
    signal?.removeEventListener("abort", abortChild);
    unsubscribe();
    session.dispose();
  }
  } catch (error) {
    throw classifiedError(error, "child");
  } finally {
    await rm(childConfigDir, { recursive: true, force: true });
  }
}

function failedLegEvidence(
  error: unknown,
  fallbackTarget: ReviewerTargetSnapshot,
  prompt: ReviewerPromptIdentity,
  signal: AbortSignal | undefined,
  retainedWorkspace?: string,
): ReviewerFailedLegRunResult {
  const attached = typeof error === "object" && error !== null ? error as {
    targetSnapshot?: ReviewerTargetSnapshot;
    workspaceDisposition?: ReviewerWorkspaceDisposition;
  } : undefined;
  return Object.freeze({
    status: "failed",
    failure: classifyFailure(error, signal),
    target: attached?.targetSnapshot ?? fallbackTarget,
    prompt,
    workspaceDisposition: retainedWorkspace === undefined
      ? attached?.workspaceDisposition ?? "not-created"
      : Object.freeze({ retained: retainedWorkspace }),
  });
}

export function createReviewerAgentRunner(dependencies: ReviewerAgentDependencies = {}): ReviewerAgentRunner {
  let snapshotPromise: Promise<GitSnapshot> | undefined;
  let acceptedIdentity: string | undefined;
  let snapshotDeleted = false;

  return {
    async run(dispatch, options) {
      if (dispatch.recipe !== "reviewer-common-bundle-v1" || dispatch.legs.length < 1 || dispatch.legs.length > 2 ||
          dispatch.legs[0]?.axis !== "standards" || (dispatch.legs.length === 2 && dispatch.legs[1]?.axis !== "spec")) {
        throw new Error("Invalid accepted Reviewer dispatch cardinality or axes");
      }
      if (acceptedIdentity !== undefined) throw new Error("Reviewer runner accepts exactly one dispatch");
      acceptedIdentity = dispatch.identity;
      for (const leg of dispatch.legs) {
        if (!isReviewerPromptIdentity(leg.prompt)) throw new Error("Accepted Reviewer prompt evidence mismatch");
      }
      for (const operation of RUNNER_PREREQUISITES) {
        if (!dispatch.prerequisiteOperations.includes(operation)) throw new Error(`Missing accepted runner prerequisite: ${operation}`);
      }
      snapshotPromise = prepareSnapshot(dispatch.targetSnapshot, options.signal, dependencies);
      let snapshot: GitSnapshot;
      try { snapshot = await snapshotPromise; }
      catch (error) {
        const legs = Object.fromEntries(dispatch.legs.map((leg) => [leg.axis, failedLegEvidence(error, dispatch.targetSnapshot, leg.prompt, options.signal)]));
        const target = Object.values(legs)[0]!.target;
        throw new ReviewerDispatchExecutionError(Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(legs) }) as ReviewerDispatchRunResult);
      }
      const target: ReviewerTargetSnapshot = { repositoryRoot: snapshot.repositoryRoot, objectFormat: snapshot.objectFormat, targetHead: snapshot.targetHead, refs: { ...snapshot.refs } };
      const prepared: Array<{ leg: AcceptedReviewerLeg; workspace: string; evidence: MaterializedBundleEvidenceV1 }> = [];
      try {
        // Verify every clone before any sibling provider starts.
        for (const leg of dispatch.legs) {
          const workspace = await prepareWorkspace(snapshot, options.signal, dependencies);
          const evidence = await materializeMechanicalBundle(workspace, leg.axis, dispatch.bundle);
          prepared.push({ leg, workspace, evidence });
        }
      } catch (error) {
        const legs = Object.fromEntries(dispatch.legs.map((leg) => [leg.axis, failedLegEvidence(error, target, leg.prompt, options.signal, prepared.find(x => x.leg.axis === leg.axis)?.workspace)]));
        throw new ReviewerDispatchExecutionError(Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(legs) }) as ReviewerDispatchRunResult);
      }
      const settled = await Promise.allSettled(prepared.map(async ({ leg, workspace, evidence }) => {
        try {
          const child = await runChild(workspace, leg, options.context, options.signal, dependencies.fault);
          await rm(workspace, { recursive: true, force: false });
          return [leg.axis, Object.freeze({ status: "successful" as const, report: child.report, usage: child.usage, target, prompt: child.prompt, workspaceDisposition: "deleted" as const, runtimeConstructionEvidence: evidence })] as const;
        } catch (error) {
          return [leg.axis, failedLegEvidence(error, target, leg.prompt, options.signal, workspace)] as const;
        }
      }));
      const pairs = settled.map((item) => item.status === "fulfilled" ? item.value : (() => { throw item.reason; })());
      const outcome = Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(Object.fromEntries(pairs)) }) as ReviewerDispatchRunResult;
      if (Object.values(outcome.legs).some((leg) => leg?.status === "failed")) throw new ReviewerDispatchExecutionError(outcome);
      return outcome as ReviewerSuccessfulDispatchRunResult;
    },
    async shutdown() {
      if (snapshotPromise === undefined || snapshotDeleted) return;
      const snapshot = await snapshotPromise;
      await rm(snapshot.mirrorRoot, { recursive: true, force: false });
      snapshotDeleted = true;
    },
  };
}
