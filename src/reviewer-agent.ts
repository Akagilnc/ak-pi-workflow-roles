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
import { parseReviewerRefSnapshot, reviewerRefSnapshotArgs, sameReviewerRefs, type ReviewerRefEntry } from "./reviewer-git-snapshot.ts";
import { isReviewerPromptIdentity, reviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import type {
  AcceptedReviewerDispatch,
  AcceptedReviewerLeg,
  ReviewerPrerequisiteOperation,
} from "./reviewer-dispatch.ts";
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
}>;
export type ReviewerFailedLegRunResult = Readonly<{
  status: "failed"; failure: ReviewerFailureClassification;
  target: ReviewerTargetSnapshot; prompt: ReviewerPromptIdentity;
  workspaceDisposition: ReviewerWorkspaceDisposition;
}>;
export type ReviewerLegRunResult = ReviewerSuccessfulLegRunResult | ReviewerFailedLegRunResult;
export type ReviewerDispatchRunResult = Readonly<{
  identity: string; target: ReviewerTargetSnapshot;
  legs: Readonly<{ standards: ReviewerLegRunResult; spec?: ReviewerLegRunResult }>;
}>;
export type ReviewerSuccessfulDispatchRunResult = Readonly<{
  identity: string; target: ReviewerTargetSnapshot;
  legs: Readonly<{ standards: ReviewerSuccessfulLegRunResult; spec?: ReviewerSuccessfulLegRunResult }>;
}>;
export class ReviewerDispatchExecutionError extends Error {
  constructor(readonly outcome: ReviewerDispatchRunResult) { super("Reviewer dispatch execution failed"); this.name = "ReviewerDispatchExecutionError"; }
}
export type ReviewerAgentRunner = {
  run(dispatch: AcceptedReviewerDispatch, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ReviewerSuccessfulDispatchRunResult>;
  shutdown(): Promise<void>;
};

type GitSnapshot = ReviewerTargetSnapshot & {
  mirrorRoot: string;
  mirrorPath: string;
};

type CommandResult = { stdout: string; stderr: string; code: number };

function classifyFailure(error: unknown): ReviewerFailureClassification {
  const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
  if (/abort|cancel/.test(text)) return "cancelled";
  if (/provider|model|auth/.test(text)) return "provider";
  if (/snapshot|mirror|target|ref map/.test(text)) return "snapshot";
  if (/workspace|clone|checkout|fetch/.test(text)) return "workspace";
  if (/child|report|tool isolation/.test(text)) return "child";
  return "unknown";
}

function infrastructureError(
  error: unknown,
  evidence: {
    workspaceDisposition?: ReviewerWorkspaceDisposition;
    targetSnapshot?: ReviewerTargetSnapshot;
  } = {},
): Error {
  const wrapped =
    error instanceof Error ? error : new Error(String(error));
  return Object.assign(wrapped, evidence);
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
    await git(cwd, ["cat-file", "-e", `${entry.peeledCommitId}^{commit}`], signal);
  }
}

async function prepareSnapshot(
  accepted: ReviewerTargetSnapshot,
  signal?: AbortSignal,
): Promise<GitSnapshot> {
  const repositoryRoot = accepted.repositoryRoot;
  const targetHead = (
    await git(repositoryRoot, ["rev-parse", "HEAD^{commit}"], signal)
  ).stdout.trim();
  const refs = await readRefs(repositoryRoot, signal);
  if (targetHead !== accepted.targetHead || !sameReviewerRefs(refs, accepted.refs)) {
    throw new Error("Accepted Reviewer target/ref identity no longer matches the repository");
  }
  const mirrorRoot = await mkdtemp(join(tmpdir(), "ak-reviewer-snapshot-"));
  const mirrorPath = join(mirrorRoot, "repository.git");
  try {
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
    const mirrorRefs = await readRefs(mirrorPath, signal);
    if (!sameReviewerRefs(mirrorRefs, refs)) {
      throw new Error("Bare review mirror ref map changed while the snapshot was prepared");
    }
    for (const object of new Set([targetHead, ...Object.values(refs).flatMap((entry) => [entry.objectId, entry.peeledCommitId])])) {
      await git(mirrorPath, ["cat-file", "-e", `${object}^{object}`], signal);
    }
    await git(
      mirrorPath,
      ["config", "--remove-section", "remote.origin"],
      signal,
      [0, 5, 128],
    );
    return { repositoryRoot, targetHead, refs, mirrorRoot, mirrorPath };
  } catch (error) {
    throw infrastructureError(error, {
      workspaceDisposition: { retained: mirrorRoot },
      targetSnapshot: { repositoryRoot, targetHead, refs },
    });
  }
}

async function prepareWorkspace(
  snapshot: GitSnapshot,
  signal?: AbortSignal,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "ak-reviewer-leg-"));
  try {
    await git(workspace, ["init", "--initial-branch=ak-reviewer-unborn"], signal);
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
    await verifySnapshot(workspace, snapshot, signal);
    return workspace;
  } catch (error) {
    throw infrastructureError(error, {
      workspaceDisposition: { retained: workspace },
      targetSnapshot: {
        repositoryRoot: snapshot.repositoryRoot,
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
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptIdentity }> {
  const childConfigDir = await mkdtemp(join(tmpdir(), "ak-reviewer-child-"));
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
      "Inspect and probe; do not repair the reviewed product, commit, push, or mutate remotes.",
      "Clearly distinguish scratch artifacts and probe changes from facts about the pinned reviewed target.",
      "Return one substantive non-blank review-leg report.",
    ].join("\n"),
  });
  await loader.reload();
  const { runtime, model } = await createChildRuntime(context);
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
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: childConfigDir,
    model,
    thinkingLevel: context.thinkingLevel ?? "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: [...leg.grant.tools],
    customTools,
    sessionManager: SessionManager.inMemory(workspace),
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
    const delivered = Object.freeze(reviewerPromptIdentity(leg.prompt));
    await session.prompt(delivered.bytes);
    if (signal?.aborted) {
      throw new Error("Reviewer Agent was cancelled");
    }
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      lastAssistant?.role !== "assistant" ||
      lastAssistant.stopReason === "error" ||
      lastAssistant.stopReason === "aborted"
    ) {
      throw new Error(
        `Reviewer Agent child failed: ${lastAssistant?.role === "assistant" ? lastAssistant.errorMessage ?? lastAssistant.stopReason : "no assistant output"}`,
      );
    }
    const report = session.getLastAssistantText()?.trim() ?? "";
    if (report.length === 0) {
      throw new Error("Reviewer Agent returned a blank child report");
    }
    return { report, usage, prompt: delivered };
  } finally {
    signal?.removeEventListener("abort", abortChild);
    unsubscribe();
    session.dispose();
    await rm(childConfigDir, { recursive: true, force: true });
  }
}

export function createReviewerAgentRunner(): ReviewerAgentRunner {
  let snapshotPromise: Promise<GitSnapshot> | undefined;
  let acceptedIdentity: string | undefined;
  let snapshotDeleted = false;

  return {
    async run(dispatch, options) {
      if (dispatch.recipe !== "reviewer-dispatch-v1" || dispatch.legs.length < 1 || dispatch.legs.length > 2 ||
          dispatch.legs[0]?.axis !== "standards" || (dispatch.legs.length === 2 && dispatch.legs[1]?.axis !== "spec")) {
        throw new Error("Invalid accepted Reviewer dispatch cardinality or axes");
      }
      if (acceptedIdentity !== undefined) throw new Error("Reviewer runner accepts exactly one dispatch");
      acceptedIdentity = dispatch.identity;
      for (const leg of dispatch.legs) {
        if (!isReviewerPromptIdentity({ bytes: leg.prompt, utf8Length: leg.utf8Length, sha256: leg.sha256 })) throw new Error("Accepted Reviewer prompt evidence mismatch");
        for (const operation of RUNNER_PREREQUISITES) {
          if (!leg.grant.prerequisiteOperations.includes(operation)) throw new Error(`Missing accepted runner prerequisite: ${operation}`);
        }
      }
      snapshotPromise = prepareSnapshot(dispatch.targetSnapshot, options.signal);
      let snapshot: GitSnapshot;
      try { snapshot = await snapshotPromise; }
      catch (error) {
        const target = dispatch.targetSnapshot;
        const legs = Object.fromEntries(dispatch.legs.map((leg) => [leg.axis, Object.freeze({ status: "failed" as const, failure: classifyFailure(error), target, prompt: Object.freeze(reviewerPromptIdentity(leg.prompt)), workspaceDisposition: "not-created" as const })]));
        throw new ReviewerDispatchExecutionError(Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(legs) }) as ReviewerDispatchRunResult);
      }
      const target: ReviewerTargetSnapshot = { repositoryRoot: snapshot.repositoryRoot, targetHead: snapshot.targetHead, refs: { ...snapshot.refs } };
      const settled = await Promise.allSettled(dispatch.legs.map(async (leg) => {
        let workspace: string | undefined;
        try {
          workspace = await prepareWorkspace(snapshot, options.signal);
          const child = await runChild(workspace, leg, options.context, options.signal);
          await rm(workspace, { recursive: true, force: false });
          return [leg.axis, Object.freeze({ status: "successful" as const, report: child.report, usage: child.usage, target, prompt: child.prompt, workspaceDisposition: "deleted" as const })] as const;
        } catch (error) {
          return [leg.axis, Object.freeze({ status: "failed" as const, failure: classifyFailure(error), target, prompt: Object.freeze(reviewerPromptIdentity(leg.prompt)), workspaceDisposition: workspace === undefined ? "not-created" as const : Object.freeze({ retained: workspace }) })] as const;
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
