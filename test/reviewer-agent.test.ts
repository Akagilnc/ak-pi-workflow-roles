import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createHash } from "node:crypto";
import { createReviewerAgentRunner } from "../src/reviewer-agent.ts";
import type { AcceptedReviewerDispatch } from "../src/reviewer-dispatch.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch } from "../src/reviewer-execution-ledger.ts";

async function dispatch(root: string, prompts: readonly string[], tools: readonly ("read" | "grep" | "find" | "ls" | "bash" | "write" | "edit")[] = ["read", "grep", "find", "ls", "bash", "write", "edit"], bashCommands: readonly string[] = []): Promise<AcceptedReviewerDispatch> {
  const targetHead = await git(root, "rev-parse", "HEAD^{commit}");
  const refs = Object.fromEntries((await git(root, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)", "refs/heads", "refs/tags", "refs/remotes")).split("\n").filter(Boolean).map((line) => { const [name, objectId, peeled, objectType, peeledType] = line.split("\0"); return [name!, { objectId: objectId!, peeledCommitId: objectType === "commit" ? objectId! : peeledType === "commit" ? peeled! : null }]; }));
  const prerequisites = ["runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot"] as const;
  return { identity: "accepted", recipe: "reviewer-dispatch-v1", input: { task: { bytes: "task", utf8Length: 4, sha256: createHash("sha256").update("task").digest("hex") }, canonicalSkillSha256: "skill" }, materials: { standards: [] }, targetSnapshot: { repositoryRoot: root, targetHead, refs }, range: { base: targetHead, target: targetHead, diffCommand: "git diff", diffSha256: createHash("sha256").update("diff").digest("hex"), commits: [] }, legs: prompts.map((prompt, index) => ({ axis: index === 0 ? "standards" : "spec", prompt, utf8Length: Buffer.byteLength(prompt), sha256: createHash("sha256").update(prompt).digest("hex"), grant: { tools, bashCommands, prerequisiteOperations: prerequisites } })) } as AcceptedReviewerDispatch;
}

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "ak-reviewer-source-"));
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "fixture.txt"), "original\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "branch", "fixed-branch", base);
  await git(root, "tag", "fixed-tag", base);
  await git(root, "tag", "-a", "annotated-commit", base, "-m", "annotated");
  const blob = await git(root, "rev-parse", "HEAD:fixture.txt");
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  await git(root, "update-ref", "refs/tags/blob-object", blob);
  await git(root, "update-ref", "refs/tags/tree-object", tree);
  await git(root, "update-ref", "refs/remotes/upstream/fixed", base);
  await writeFile(join(root, "fixture.txt"), "reviewed\n");
  await git(root, "commit", "-am", "reviewed change");
  return { root, base };
}

async function parentContext(
  cwd: string,
  onRequest: (
    context: Context,
    options: StreamOptions | undefined,
    model: { baseUrl?: string },
  ) => Promise<void>,
  expectedConcurrentStarts = 2,
) {
  const faux = fauxProvider({
    api: "ak-review-child",
    provider: "ak-review-child",
    tokenSize: { min: 1000, max: 1000 },
  });
  let starts = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const firstRound = [0, 1].map((index) => async (context: Context, options: StreamOptions | undefined, _state: unknown, requestModel: any) => {
    starts += 1;
    if (starts === expectedConcurrentStarts) release();
    await barrier;
    await onRequest(context, options, requestModel);
    return fauxAssistantMessage(
      fauxToolCall("write", { path: `scratch-${index}.txt`, content: "probe\n" }),
      { stopReason: "toolUse" },
    );
  });
  const editRound = [0, 1].map((index) => async (context: Context, options: StreamOptions | undefined, _state: unknown, requestModel: any) => {
    await onRequest(context, options, requestModel);
    return fauxAssistantMessage(
      fauxToolCall("edit", {
        path: `scratch-${index}.txt`,
        edits: [{ oldText: "probe\n", newText: "probe edited\n" }],
      }),
      { stopReason: "toolUse" },
    );
  });
  const finalRound = [0, 1].map((index) => async (context: Context, options: StreamOptions | undefined, _state: unknown, requestModel: any) => {
    await onRequest(context, options, requestModel);
    return fauxAssistantMessage(`axis ${index + 1} report`);
  });
  faux.setResponses([...firstRound, ...editRound, ...finalRound]);
  const model = { ...faux.getModel(), baseUrl: "https://default.invalid" };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "parent auth",
        async resolve() {
          return {
            auth: {
              apiKey: "inherited-secret",
              headers: { "x-parent": "yes" },
              baseUrl: "https://resolved.invalid",
            },
            env: { REVIEW_TENANT: "test" },
          };
        },
      },
    },
    getModels() { return [model]; },
  });
  return {
    context: {
      cwd,
      model,
      thinkingLevel: "off",
      modelRegistry: new ModelRegistry(runtime),
    } as unknown as ExtensionContext,
    faux,
  };
}

test("Reviewer materializes shallow session snapshot refs into the workspace", async () => {
  const seed = await repository();
  const shallowRoot = await mkdtemp(join(tmpdir(), "ak-reviewer-shallow-"));
  try {
    await exec("git", [
      "clone",
      "--depth",
      "1",
      `file://${seed.root}`,
      shallowRoot,
    ]);
    assert.equal(await git(shallowRoot, "rev-parse", "--is-shallow-repository"), "true");

    await git(shallowRoot, "config", "user.email", "test@example.com");
    await git(shallowRoot, "config", "user.name", "Test");
    const tip = await git(shallowRoot, "rev-parse", "HEAD^{commit}");
    await git(shallowRoot, "branch", "fixed-branch", tip);
    await git(shallowRoot, "tag", "fixed-tag", tip);
    await git(shallowRoot, "update-ref", "refs/remotes/upstream/fixed", tip);

    const sourceRefs: Record<string, string> = {};
    for (const line of (await git(shallowRoot, "show-ref")).split("\n").filter(Boolean)) {
      const space = line.indexOf(" ");
      sourceRefs[line.slice(space + 1)] = line.slice(0, space);
    }

    let childReached = false;
    const { context } = await parentContext(shallowRoot, async () => {
      childReached = true;
    }, 1);
    const runner = createReviewerAgentRunner();
    try {
      const result = await runner.run(await dispatch(shallowRoot, ["Shallow snapshot review"]), { context });
      const leg = result.legs.standards;
      assert.equal(childReached, true);
      assert.match(leg.report, /\S/);
      assert.equal(result.target.targetHead, tip);
      assert.equal(result.target.refs["refs/heads/fixed-branch"]?.objectId, tip);
      assert.equal(result.target.refs["refs/tags/fixed-tag"]?.objectId, tip);
      assert.equal(result.target.refs["refs/remotes/upstream/fixed"]?.objectId, tip);
      for (const [name, sha] of Object.entries(sourceRefs)) assert.equal(result.target.refs[name]?.objectId, sha);
    } finally {
      await runner.shutdown();
    }
  } finally {
    await rm(shallowRoot, { recursive: true, force: true });
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("two Reviewer Agent legs overlap in isolated clones with one pinned ref snapshot", async () => {
  const source = await repository();
  const requests: Array<{
    prompt: string;
    tools: string[];
    dispatch: Record<string, unknown>;
    sessionId: string | undefined;
  }> = [];
  const { context } = await parentContext(source.root, async (childContext, options, model) => {
    const user = childContext.messages.find((message) => message.role === "user");
    requests.push({
      prompt: user?.role === "user"
        ? (typeof user.content === "string" ? user.content : user.content.map((part) => part.type === "text" ? part.text : "").join(""))
        : "",
      tools: childContext.tools?.map((tool) => tool.name) ?? [],
      sessionId: options?.sessionId,
      dispatch: {
        baseUrl: model.baseUrl,
        apiKey: options?.apiKey,
        headers: options?.headers,
        env: options?.env,
      },
    });
  });
  const runner = createReviewerAgentRunner();
  const before = {
    bytes: await readFile(join(source.root, "fixture.txt"), "utf8"),
    head: await git(source.root, "rev-parse", "HEAD"),
    refs: await git(source.root, "show-ref"),
    status: await git(source.root, "status", "--porcelain"),
  };

  try {
    const batch = await runner.run(await dispatch(source.root, ["Standards prompt", "Spec prompt"]), { context });
    const standards = batch.legs.standards;
    const spec = batch.legs.spec!;

    assert.deepEqual(
      [standards.report, spec.report].sort(),
      ["axis 1 report", "axis 2 report"],
    );
    assert.equal(standards.workspaceDisposition, "deleted");
    assert.equal(spec.workspaceDisposition, "deleted");
    assert.deepEqual(standards.target, spec.target);
    assert.equal(standards.target.refs["refs/heads/fixed-branch"]?.objectId, source.base);
    assert.equal(standards.target.refs["refs/tags/fixed-tag"]?.objectId, source.base);
    assert.equal(standards.target.refs["refs/remotes/upstream/fixed"]?.objectId, source.base);
    assert.equal(standards.prompt.bytes, "Standards prompt");
    assert.equal(spec.prompt.bytes, "Spec prompt");
    assert.deepEqual(
      [...new Set(requests.map((request) => request.prompt))].sort(),
      ["Spec prompt", "Standards prompt"],
    );
    assert.equal(new Set(requests.map((request) => request.sessionId)).size, 2);
    for (const request of requests) {
      assert.deepEqual(request.tools, ["read", "grep", "find", "ls", "bash", "write", "edit"]);
      assert.deepEqual(request.dispatch, {
        baseUrl: "https://resolved.invalid",
        apiKey: "inherited-secret",
        headers: { "x-parent": "yes" },
        env: { REVIEW_TENANT: "test" },
      });
    }
    assert.deepEqual({
      bytes: await readFile(join(source.root, "fixture.txt"), "utf8"),
      head: await git(source.root, "rev-parse", "HEAD"),
      refs: await git(source.root, "show-ref"),
      status: await git(source.root, "status", "--porcelain"),
    }, before);
  } finally {
    await runner.shutdown();
    await rm(source.root, { recursive: true, force: true });
  }
});

test("Reviewer child provider delegates class-private streams to the original receiver", async () => {
  const source = await repository();
  const faux = fauxProvider({
    api: "ak-review-private-provider",
    provider: "ak-review-private-provider",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf widened > forbidden.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("private provider report"),
  ]);
  const originalModel = {
    ...faux.getModel(),
    baseUrl: "https://default.invalid",
  };
  const dispatches: Array<Record<string, unknown>> = [];
  const visibleTools: string[][] = [];
  const toolResults: string[] = [];

  class PrivateProvider implements Provider {
    readonly id = faux.provider.id;
    readonly name = faux.provider.name;
    readonly auth: Provider["auth"] = {
      apiKey: {
        name: "Private provider auth",
        async resolve() {
          return {
            auth: {
              apiKey: "private-secret",
              headers: { "x-private": "yes" },
              baseUrl: "https://private-resolved.invalid",
            },
            env: { PRIVATE_TENANT: "test" },
          };
        },
      },
    };
    #delegate: Provider = faux.provider;

    getModels(): readonly Model<Api>[] { return [originalModel]; }

    stream(model: Model<Api>, childContext: Context, options?: StreamOptions) {
      dispatches.push({
        baseUrl: model.baseUrl,
        apiKey: options?.apiKey,
        headers: options?.headers,
        env: options?.env,
      });
      return this.#delegate.stream(model, childContext, options);
    }

    streamSimple(
      model: Model<Api>,
      childContext: Context,
      options?: SimpleStreamOptions,
    ) {
      visibleTools.push(childContext.tools?.map((tool) => tool.name) ?? []);
      toolResults.push(...childContext.messages.filter((message) => message.role === "toolResult").flatMap((message) => message.content.map((part) => part.type === "text" ? part.text : "")));
      dispatches.push({
        baseUrl: model.baseUrl,
        apiKey: options?.apiKey,
        headers: options?.headers,
        env: options?.env,
      });
      return this.#delegate.streamSimple(model, childContext, options);
    }
  }

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerNativeProvider(new PrivateProvider());
  const context = {
    cwd: source.root,
    model: originalModel,
    thinkingLevel: "off",
    modelRegistry: new ModelRegistry(runtime),
  } as unknown as ExtensionContext;
  const runner = createReviewerAgentRunner();
  try {
    const result = await runner.run(await dispatch(source.root, ["Inspect private provider dispatch"], ["bash"], ["printf exact > allowed.txt"]), { context });
    assert.equal(result.legs.standards.report, "private provider report");
    assert.deepEqual(visibleTools, [["bash"], ["bash"]]);
    assert.match(toolResults.join("\n"), /exact accepted member/);
    await assert.rejects(access(join(source.root, "forbidden.txt")));
    assert.equal(result.legs.standards.prompt.bytes, "Inspect private provider dispatch");
    assert.deepEqual(dispatches, [0, 1].map(() => ({
      baseUrl: "https://private-resolved.invalid",
      apiKey: "private-secret",
      headers: { "x-private": "yes" },
      env: { PRIVATE_TENANT: "test" },
    })));
  } finally {
    await runner.shutdown();
    await rm(source.root, { recursive: true, force: true });
  }
});

test("Reviewer Agent reports deterministic setup failures with bounded retention evidence", async () => {
  const cases = [
    ["mirror.before-create", "not-created"],
    ["mirror.create", "retained"],
    ["mirror.verify", "retained"],
    ["workspace.before-create", "not-created"],
    ["workspace.init", "retained"],
    ["workspace.fetch", "retained"],
    ["workspace.verify", "retained"],
  ] as const;
  for (const [fault, expected] of cases) {
    const source = await repository();
    const { context } = await parentContext(source.root, async () => {}, 1);
    const runner = createReviewerAgentRunner({ fault(operation) { if (operation === fault) throw new Error(`injected ${fault}`); } });
    const acceptedDispatch = await dispatch(source.root, [fault]);
    let retained: string | undefined;
    try {
      await assert.rejects(
        runner.run(acceptedDispatch, { context }),
        (error: any) => {
          const disposition = error.outcome.legs.standards.workspaceDisposition;
          if (expected === "not-created") assert.equal(disposition, "not-created");
          else {
            retained = disposition.retained;
            assert.ok(retained?.startsWith(tmpdir()));
          }
          const accepted = error.outcome;
          const ledger = createReviewerExecutionLedger();
          // Project the exact failed settlement through the durable ledger seam.
          ledger.append(projectAcceptedDispatch({ ...acceptedDispatch, materials: { ...acceptedDispatch.materials, noSpecEvidence: [] } }));
          ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: accepted.identity, cardinality: 1 });
          ledger.append({ source: "reviewer-agent", type: "leg-settled", dispatchIdentity: accepted.identity, axis: "standards", ...accepted.legs.standards });
          assert.deepEqual(ledger.recordForAudit("refused").results.standards?.workspaceDisposition, disposition);
          return true;
        },
      );
      if (retained !== undefined) await access(retained);
    } finally {
      await runner.shutdown().catch(() => {});
      if (retained !== undefined) await rm(retained, { recursive: true, force: true });
      await rm(source.root, { recursive: true, force: true });
    }
  }
});

test("Reviewer Agent cancellation is infrastructure failure and retains its workspace", async () => {
  const source = await repository();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { context } = await parentContext(source.root, async (_context, options) => {
    markStarted();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }, 1);
  const runner = createReviewerAgentRunner();
  const controller = new AbortController();
  const call = dispatch(source.root, ["Long review"]).then((accepted) => runner.run(accepted, { context, signal: controller.signal }));
  await started;
  controller.abort();
  let retained: string | undefined;
  try {
    await assert.rejects(async () => {
      try {
        await call;
      } catch (error) {
        retained = (error as { workspaceDisposition?: { retained?: string } })
          .workspaceDisposition?.retained;
        throw error;
      }
    }, (error: any) => {
      assert.equal(error.name, "ReviewerDispatchExecutionError");
      assert.equal(error.outcome.legs.standards.status, "failed");
      assert.equal(error.outcome.legs.standards.failure, "cancelled");
      retained = error.outcome.legs.standards.workspaceDisposition.retained;
      return true;
    });
    assert.ok(retained);
    await access(retained);
  } finally {
    await runner.shutdown().catch(() => {});
    if (retained !== undefined) {
      await rm(retained, { recursive: true, force: true });
    }
    await rm(source.root, { recursive: true, force: true });
  }
});
