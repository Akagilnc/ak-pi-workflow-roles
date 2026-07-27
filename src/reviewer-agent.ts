import { spawn } from "node:child_process";
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
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { prepareComplianceDispatch } from "./compliance-transport.ts";
import type {
  ReviewerAgentResult,
  ReviewerTargetSnapshot,
  ReviewerWorkspaceDisposition,
} from "./role-runtime.ts";

const CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit"];
const REVIEW_REF_PREFIXES = ["refs/heads", "refs/tags", "refs/remotes"];

export type RunReviewerAgent = (
  input: { description: string; prompt: string },
  options: { context: ExtensionContext; signal?: AbortSignal },
) => Promise<ReviewerAgentResult>;

export type ReviewerAgentRunner = {
  runReviewerAgent: RunReviewerAgent;
  shutdown(): Promise<void>;
};

type GitSnapshot = ReviewerTargetSnapshot & {
  mirrorRoot: string;
  mirrorPath: string;
};

type CommandResult = { stdout: string; stderr: string; code: number };

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
): Promise<Record<string, string>> {
  const result = await git(
    cwd,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      ...REVIEW_REF_PREFIXES,
    ],
    signal,
  );
  const refs: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("\0");
    if (separator < 1) {
      throw new Error(`Malformed Git ref snapshot line: ${line}`);
    }
    refs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return refs;
}

function sameRefs(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualEntries = Object.entries(actual).sort();
  const expectedEntries = Object.entries(expected).sort();
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
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
  if (!sameRefs(refs, snapshot.refs)) {
    throw new Error("Review clone ref map does not match the pinned session snapshot");
  }
  for (const object of new Set(Object.values(snapshot.refs))) {
    await git(cwd, ["cat-file", "-e", `${object}^{object}`], signal);
  }
}

async function prepareSnapshot(
  cwd: string,
  signal?: AbortSignal,
): Promise<GitSnapshot> {
  const repositoryRoot = (
    await git(cwd, ["rev-parse", "--show-toplevel"], signal)
  ).stdout.trim();
  const targetHead = (
    await git(repositoryRoot, ["rev-parse", "HEAD^{commit}"], signal)
  ).stdout.trim();
  const refs = await readRefs(repositoryRoot, signal);
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
    if (!sameRefs(mirrorRefs, refs)) {
      throw new Error("Bare review mirror ref map changed while the snapshot was prepared");
    }
    for (const object of new Set([targetHead, ...Object.values(refs)])) {
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
  prompt: string,
  context: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ report: string; usage: Usage }> {
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
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: childConfigDir,
    model,
    thinkingLevel: context.thinkingLevel ?? "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: CHILD_TOOLS,
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
    if (JSON.stringify(visibleTools) !== JSON.stringify(CHILD_TOOLS)) {
      throw new Error(
        `Reviewer child tool isolation failed: ${visibleTools.join(", ")}`,
      );
    }
    await session.prompt(prompt);
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
    return { report, usage };
  } finally {
    signal?.removeEventListener("abort", abortChild);
    unsubscribe();
    session.dispose();
    await rm(childConfigDir, { recursive: true, force: true });
  }
}

export function createReviewerAgentRunner(): ReviewerAgentRunner {
  let snapshotPromise: Promise<GitSnapshot> | undefined;
  let pinnedCwd: string | undefined;
  let snapshotDeleted = false;

  const runReviewerAgent: RunReviewerAgent = async (input, options) => {
    if (snapshotPromise === undefined) {
      pinnedCwd = options.context.cwd;
      snapshotPromise = prepareSnapshot(
        options.context.cwd,
        options.signal,
      );
    } else if (pinnedCwd !== options.context.cwd) {
      throw new Error("Reviewer Agent session cannot change repository roots");
    }
    const snapshot = await snapshotPromise;
    const publicSnapshot: ReviewerTargetSnapshot = {
      repositoryRoot: snapshot.repositoryRoot,
      targetHead: snapshot.targetHead,
      refs: { ...snapshot.refs },
    };
    const workspace = await prepareWorkspace(snapshot, options.signal);
    try {
      const child = await runChild(
        workspace,
        input.prompt,
        options.context,
        options.signal,
      );
      await rm(workspace, { recursive: true, force: false });
      return {
        report: child.report,
        usage: child.usage,
        targetSnapshot: publicSnapshot,
        workspaceDisposition: "deleted",
      };
    } catch (error) {
      throw infrastructureError(error, {
        workspaceDisposition: { retained: workspace },
        targetSnapshot: publicSnapshot,
      });
    }
  };

  return {
    runReviewerAgent,
    async shutdown() {
      if (snapshotPromise === undefined || snapshotDeleted) return;
      const snapshot = await snapshotPromise;
      await rm(snapshot.mirrorRoot, { recursive: true, force: false });
      snapshotDeleted = true;
    },
  };
}
