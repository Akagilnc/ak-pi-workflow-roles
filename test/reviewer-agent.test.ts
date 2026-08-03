import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { executeReviewerChild } from "../src/reviewer-child-executor.ts";
import { createReviewerWorkspaceOwner } from "../src/reviewer-workspace.ts";
import { compileMechanicalBundle } from "../src/reviewer-construction.ts";
import type { AcceptedReviewerExecution } from "../src/reviewer-dispatch.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch } from "../src/reviewer-execution-ledger.ts";
import { withPrimaryAwareCleanup } from "./helpers/primary-aware-cleanup.ts";

async function dispatch(root: string, prompts: readonly string[], tools: readonly ("read" | "grep" | "find" | "ls" | "bash" | "write" | "edit")[] = ["read", "grep", "find", "ls", "bash", "write", "edit"], bashCommands: readonly string[] = []): Promise<AcceptedReviewerExecution> {
  const objectFormat = await git(root, "rev-parse", "--show-object-format") as "sha1" | "sha256";
  const targetHead = await git(root, "rev-parse", "HEAD^{commit}");
  const refs = Object.fromEntries((await git(root, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)", "refs/heads", "refs/tags", "refs/remotes")).split("\n").filter(Boolean).map((line) => { const [name, objectId, peeled, objectType, peeledType] = line.split("\0"); return [name!, { objectId: objectId!, peeledCommitId: objectType === "commit" ? objectId! : peeledType === "commit" ? peeled! : null }]; }));
  const prerequisites = ["runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot"] as const;
  const bundle = compileMechanicalBundle({ canonicalSkill: "canonical\n", task: "task\n", range: { base: targetHead, target: targetHead, diffCommand: `git diff ${targetHead}...${targetHead}`, diffSha256: "1".repeat(64), commits: [targetHead] }, materials: [] }).bundle;
  return { identity: "accepted", recipe: "reviewer-common-bundle-v1", bundle, prerequisiteOperations: prerequisites, targetSnapshot: { repositoryRoot: root, objectFormat, targetHead, refs }, legs: prompts.map((prompt, index) => ({ axis: index === 0 ? "standards" : "spec", prompt: { text: prompt, utf8Length: Buffer.byteLength(prompt), sha256: createHash("sha256").update(prompt).digest("hex") }, grant: { tools, bashCommands, prerequisiteOperations: prerequisites } })) };
}

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function repository(objectFormat: "sha1" | "sha256" = "sha1") {
  const root = await mkdtemp(join(tmpdir(), "ak-reviewer-source-"));
  await git(root, "init", `--object-format=${objectFormat}`);
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

test("workspace owner prepares and installs every leg without constructing a provider", async () => {
  const source = await repository();
  const accepted = await dispatch(source.root, ["Standards", "Spec"]);
  let workspaceOperations = 0;
  const owner = createReviewerWorkspaceOwner({ fault() { workspaceOperations += 1; } });
  await withPrimaryAwareCleanup(async () => {
    const batch = await owner.prepare(accepted.targetSnapshot, ["standards", "spec"], accepted.bundle);
    assert.equal(batch.workspaces.length, 2);
    assert.ok(workspaceOperations > 0);
    for (const workspace of batch.workspaces) {
      assert.equal(workspace.evidence.entries.every(entry => entry.verified), true);
      await access(join(workspace.path, workspace.evidence.entries[0]!.relativeClonePath));
      await owner.dispose(workspace);
    }
  }, () => owner.shutdown(), () => rm(source.root, { recursive: true, force: true }));
});

test("child executor runs in an already-prepared workspace without Git materialization", async () => {
  const source = await repository();
  const accepted = await dispatch(source.root, ["Prepared child prompt"]);
  const owner = createReviewerWorkspaceOwner();
  await withPrimaryAwareCleanup(async () => {
    const batch = await owner.prepare(accepted.targetSnapshot, ["standards"], accepted.bundle);
    const workspace = batch.workspaces[0]!;
    const { context } = await parentContext(source.root, async () => {}, 1);
    const operations: string[] = [];
    const result = await executeReviewerChild(workspace.path, accepted.legs[0]!, context, undefined, operation => { operations.push(operation); });
    assert.equal(result.report, "axis 1 report");
    assert.deepEqual(operations, ["child.reload", "child.session"]);
    await owner.dispose(workspace);
  }, () => owner.shutdown(), () => rm(source.root, { recursive: true, force: true }));
});

test("Reviewer materializes shallow session snapshot refs into the workspace", async () => {
  const seed = await repository();
  const shallowRoot = await mkdtemp(join(tmpdir(), "ak-reviewer-shallow-"));
  await withPrimaryAwareCleanup(async () => {
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
    await withPrimaryAwareCleanup(async () => {
      const result = await runner.run(await dispatch(shallowRoot, ["Shallow snapshot review"]), { context });
      const leg = result.legs.standards;
      assert.equal(childReached, true);
      assert.match(leg.report, /\S/);
      assert.equal(result.target.targetHead, tip);
      assert.equal(result.target.refs["refs/heads/fixed-branch"]?.objectId, tip);
      assert.equal(result.target.refs["refs/tags/fixed-tag"]?.objectId, tip);
      assert.equal(result.target.refs["refs/remotes/upstream/fixed"]?.objectId, tip);
      for (const [name, sha] of Object.entries(sourceRefs)) assert.equal(result.target.refs[name]?.objectId, sha);
    }, () => runner.shutdown());
  }, () => rm(shallowRoot, { recursive: true, force: true }), () => rm(seed.root, { recursive: true, force: true }));
});

test("Reviewer materializes and verifies a real SHA-256 repository", async (t) => {
  let source: Awaited<ReturnType<typeof repository>>;
  try { source = await repository("sha256"); }
  catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === 128) {
      t.skip("Git rejected the SHA-256 repository capability");
      return;
    }
    throw error;
  }
  const runner = createReviewerAgentRunner();
  await withPrimaryAwareCleanup(async () => {
    const { context } = await parentContext(source.root, async () => {}, 1);
    const result = await runner.run(await dispatch(source.root, ["SHA-256 snapshot review"]), { context });
    assert.equal(result.target.objectFormat, "sha256");
    assert.match(result.target.targetHead, /^[0-9a-f]{64}$/);
    assert.equal(result.legs.standards.status, "successful");
  }, () => runner.shutdown(), () => rm(source.root, { recursive: true, force: true }));
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
    text: await readFile(join(source.root, "fixture.txt"), "utf8"),
    head: await git(source.root, "rev-parse", "HEAD"),
    refs: await git(source.root, "show-ref"),
    status: await git(source.root, "status", "--porcelain"),
  };

  await withPrimaryAwareCleanup(async () => {
    const acceptedDispatch = await dispatch(source.root, ["Standards prompt", "Spec prompt"]);
    const batch = await runner.run(acceptedDispatch, { context });
    const standards = batch.legs.standards;
    const spec = batch.legs.spec!;

    assert.deepEqual(
      [standards.report, spec.report].sort(),
      ["axis 1 report", "axis 2 report"],
    );
    assert.equal(standards.workspaceDisposition, "deleted");
    assert.equal(spec.workspaceDisposition, "deleted");
    for (const [axis, leg] of [["standards", standards], ["spec", spec]] as const) {
      assert.equal(leg.runtimeConstructionEvidence.leg, axis);
      assert.equal(leg.runtimeConstructionEvidence.manifestSha256, acceptedDispatch.bundle.manifestSha256);
      assert.deepEqual(leg.runtimeConstructionEvidence.entries, acceptedDispatch.bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => ({ id, relativeClonePath, utf8Length, sha256, verified: true })));
    }
    assert.deepEqual(standards.target, spec.target);
    assert.equal(standards.target.refs["refs/heads/fixed-branch"]?.objectId, source.base);
    assert.equal(standards.target.refs["refs/tags/fixed-tag"]?.objectId, source.base);
    assert.equal(standards.target.refs["refs/remotes/upstream/fixed"]?.objectId, source.base);
    assert.equal(standards.prompt.text, "Standards prompt");
    assert.equal(spec.prompt.text, "Spec prompt");
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
      text: await readFile(join(source.root, "fixture.txt"), "utf8"),
      head: await git(source.root, "rev-parse", "HEAD"),
      refs: await git(source.root, "show-ref"),
      status: await git(source.root, "status", "--porcelain"),
    }, before);
  }, () => runner.shutdown(), () => rm(source.root, { recursive: true, force: true }));
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
  await withPrimaryAwareCleanup(async () => {
    const result = await runner.run(await dispatch(source.root, ["Inspect private provider dispatch"], ["bash"], ["printf exact > allowed.txt"]), { context });
    assert.equal(result.legs.standards.report, "private provider report");
    assert.deepEqual(visibleTools, [["bash"], ["bash"]]);
    assert.match(toolResults.join("\n"), /exact accepted member/);
    await assert.rejects(access(join(source.root, "forbidden.txt")));
    assert.equal(result.legs.standards.prompt.text, "Inspect private provider dispatch");
    assert.deepEqual(dispatches, [0, 1].map(() => ({
      baseUrl: "https://private-resolved.invalid",
      apiKey: "private-secret",
      headers: { "x-private": "yes" },
      env: { PRIVATE_TENANT: "test" },
    })));
  }, () => runner.shutdown(), () => rm(source.root, { recursive: true, force: true }));
});

test("workspace shutdown does not replay pre-creation or post-creation preparation rejection", async () => {
  for (const fault of ["mirror.before-create", "mirror.create"] as const) {
    const source = await repository();
    const accepted = await dispatch(source.root, [fault]);
    const cause = new Error(`classified ${fault}`);
    const owner = createReviewerWorkspaceOwner({ fault(operation) { if (operation === fault) throw cause; } });
    let retained: string | undefined;
    await withPrimaryAwareCleanup(async () => {
      await assert.rejects(owner.prepare(accepted.targetSnapshot, ["standards"], accepted.bundle), (error) => {
        assert.equal(error, cause);
        const classified = error as typeof cause & { reviewerFailure: string; targetSnapshot: unknown; workspaceDisposition: "not-created" | { retained: string } };
        assert.equal(classified.reviewerFailure, "snapshot");
        assert.deepEqual(classified.targetSnapshot, accepted.targetSnapshot);
        if (fault === "mirror.before-create") assert.equal(classified.workspaceDisposition, "not-created");
        else {
          assert.notEqual(classified.workspaceDisposition, "not-created");
          retained = (classified.workspaceDisposition as { retained: string }).retained;
          assert.ok(retained);
        }
        return true;
      });
      // Double shutdown is the subject under test — propagate rejection if either fails.
      await owner.shutdown();
      await owner.shutdown();
      if (retained !== undefined) await access(retained);
    }, async () => {
      if (retained !== undefined) await rm(retained, { recursive: true, force: true });
    }, () => rm(source.root, { recursive: true, force: true }));
  }
});

test("Reviewer Agent reports deterministic setup failures with bounded retention evidence", async () => {
  const cases = [
    ["snapshot.head", "not-created", "snapshot"],
    ["snapshot.refs", "not-created", "snapshot"],
    ["mirror.before-create", "not-created", "snapshot"],
    ["mirror.create", "retained", "snapshot"],
    ["mirror.verify", "retained", "snapshot"],
    ["workspace.before-create", "not-created", "workspace"],
    ["workspace.init", "retained", "workspace"],
    ["workspace.fetch", "retained", "workspace"],
    ["workspace.verify", "retained", "workspace"],
    ["child.reload", "retained", "child"],
    ["child.session", "retained", "child"],
  ] as const;
  for (const [fault, expected, classification] of cases) {
    const source = await repository();
    const { context } = await parentContext(source.root, async () => {}, 1);
    const runner = createReviewerAgentRunner({ fault(operation) { if (operation === fault) throw new Error("provider cancelled child prose must not classify this failure"); } });
    const acceptedDispatch = await dispatch(source.root, [fault]);
    const scratchBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("ak-reviewer-child-")));
    let retained: string | undefined;
    await withPrimaryAwareCleanup(async () => {
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
          assert.equal(accepted.legs.standards.failure, classification);
          if (classification === "child") {
            assert.equal(accepted.legs.standards.runtimeConstructionEvidence?.leg, "standards");
            assert.equal(accepted.legs.standards.runtimeConstructionEvidence?.manifestSha256, acceptedDispatch.bundle.manifestSha256);
          } else assert.equal(accepted.legs.standards.runtimeConstructionEvidence, undefined);
          const ledger = createReviewerExecutionLedger();
          // Project the exact failed settlement through the durable ledger seam.
          const construction = compileMechanicalBundle({ canonicalSkill: "skill", task: acceptedDispatch.legs[0]!.prompt.text, range: { base: acceptedDispatch.targetSnapshot.targetHead, target: acceptedDispatch.targetSnapshot.targetHead, diffCommand: "git diff", diffSha256: createHash("sha256").update("diff").digest("hex"), commits: [] }, materials: [] });
          ledger.append(projectAcceptedDispatch({
            ...acceptedDispatch,
            input: { task: acceptedDispatch.legs[0]!.prompt, canonicalSkill: construction.canonicalSkill, construction: construction.construction, capabilityDocument: acceptedDispatch.legs[0]!.prompt },
            range: { base: acceptedDispatch.targetSnapshot.targetHead, target: acceptedDispatch.targetSnapshot.targetHead, diffCommand: "git diff", diffSha256: createHash("sha256").update("diff").digest("hex"), commits: [] },
            materials: [],
          }));
          ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: accepted.identity, cardinality: 1 });
          ledger.append({ source: "reviewer-agent", type: "leg-settled", dispatchIdentity: accepted.identity, axis: "standards", ...accepted.legs.standards });
          assert.deepEqual(ledger.recordForAudit("refused").results.standards?.workspaceDisposition, disposition);
          return true;
        },
      );
      if (retained !== undefined) await access(retained);
      const scratchAfter = (await readdir(tmpdir())).filter((name) => name.startsWith("ak-reviewer-child-") && !scratchBefore.has(name));
      assert.deepEqual(scratchAfter, [], `${fault} leaked credential scratch`);
    }, () => runner.shutdown(), async () => {
      if (retained !== undefined) await rm(retained, { recursive: true, force: true });
    }, () => rm(source.root, { recursive: true, force: true }));
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
  const scratchBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("ak-reviewer-child-")));
  const controller = new AbortController();
  const call = dispatch(source.root, ["Long review"]).then((accepted) => runner.run(accepted, { context, signal: controller.signal }));
  await started;
  controller.abort();
  let retained: string | undefined;
  await withPrimaryAwareCleanup(async () => {
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
    assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith("ak-reviewer-child-") && !scratchBefore.has(name)), []);
  }, () => runner.shutdown(), async () => {
    if (retained !== undefined) await rm(retained, { recursive: true, force: true });
  }, () => rm(source.root, { recursive: true, force: true }));
});
