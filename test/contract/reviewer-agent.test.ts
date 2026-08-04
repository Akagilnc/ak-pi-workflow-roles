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
import { createReviewerAgentRunner } from "../../src/reviewer-agent.ts";
import { executeReviewerChild } from "../../src/reviewer-child-executor.ts";
import { createReviewerWorkspaceOwner } from "../../src/reviewer-workspace.ts";
import { compileMechanicalBundle } from "../../src/reviewer-construction.ts";
import type { AcceptedReviewerExecution } from "../../src/reviewer-dispatch.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function buildRepository(objectFormat: "sha1" | "sha256" = "sha1") {
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

/** One frozen sha1 source repo shared by every construction in this file. */
let sharedSourceMemo: Promise<{ root: string; base: string }> | undefined;
function sharedSource() {
  sharedSourceMemo ??= buildRepository("sha1");
  return sharedSourceMemo;
}

let sharedSha256Memo: Promise<{ root: string; base: string } | "unsupported"> | undefined;
function sharedSha256Source() {
  sharedSha256Memo ??= (async () => {
    try {
      return await buildRepository("sha256");
    } catch {
      return "unsupported";
    }
  })();
  return sharedSha256Memo;
}

async function dispatch(
  root: string,
  prompts: readonly string[],
  tools: readonly ("read" | "grep" | "find" | "ls" | "bash" | "write" | "edit")[] = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    "edit",
  ],
  bashCommands: readonly string[] = [],
): Promise<AcceptedReviewerExecution> {
  const objectFormat = (await git(root, "rev-parse", "--show-object-format")) as "sha1" | "sha256";
  const targetHead = await git(root, "rev-parse", "HEAD^{commit}");
  const refs = Object.fromEntries(
    (
      await git(
        root,
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)",
        "refs/heads",
        "refs/tags",
        "refs/remotes",
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, objectId, peeled, objectType, peeledType] = line.split("\0");
        return [
          name!,
          {
            objectId: objectId!,
            peeledCommitId:
              objectType === "commit" ? objectId! : peeledType === "commit" ? peeled! : null,
          },
        ];
      }),
  );
  const prerequisites = [
    "runner.git.materialize-mirror",
    "runner.git.materialize-workspace",
    "runner.git.verify-snapshot",
  ] as const;
  const bundle = compileMechanicalBundle({
    canonicalSkill: "canonical\n",
    task: "task\n",
    range: {
      base: targetHead,
      target: targetHead,
      diffCommand: `git diff ${targetHead}...${targetHead}`,
      diffSha256: "1".repeat(64),
      commits: [targetHead],
    },
    materials: [],
  }).bundle;
  return {
    identity: "accepted",
    recipe: "reviewer-common-bundle-v1",
    bundle,
    prerequisiteOperations: prerequisites,
    targetSnapshot: { repositoryRoot: root, objectFormat, targetHead, refs },
    legs: prompts.map((prompt, index) => ({
      axis: index === 0 ? "standards" : "spec",
      prompt: {
        text: prompt,
        utf8Length: Buffer.byteLength(prompt),
        sha256: createHash("sha256").update(prompt).digest("hex"),
      },
      grant: { tools, bashCommands, prerequisiteOperations: prerequisites },
    })),
  };
}

/** Cached dual-leg and single-leg dispatches over the shared frozen source. */
let dualDispatchMemo: Promise<AcceptedReviewerExecution> | undefined;
let singleDispatchMemo: Promise<AcceptedReviewerExecution> | undefined;
async function sharedDualDispatch() {
  dualDispatchMemo ??= (async () => {
    const source = await sharedSource();
    return dispatch(source.root, ["Standards", "Spec"]);
  })();
  return dualDispatchMemo;
}
async function sharedSingleDispatch(prompt = "Prepared child prompt") {
  // prompt-varying callers still share the frozen source; only the identity bytes differ
  const source = await sharedSource();
  return dispatch(source.root, [prompt]);
}
async function sharedSingleDispatchCached() {
  singleDispatchMemo ??= sharedSingleDispatch("Prepared child prompt");
  return singleDispatchMemo;
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
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstRound = [0, 1].map(
    (index) =>
      async (context: Context, options: StreamOptions | undefined, _state: unknown, requestModel: any) => {
        starts += 1;
        if (starts === expectedConcurrentStarts) release();
        await barrier;
        await onRequest(context, options, requestModel);
        return fauxAssistantMessage(
          fauxToolCall("write", { path: `scratch-${index}.txt`, content: "probe\n" }),
          { stopReason: "toolUse" },
        );
      },
  );
  const editRound = [0, 1].map(
    (index) =>
      async (context: Context, options: StreamOptions | undefined, _state: unknown, requestModel: any) => {
        await onRequest(context, options, requestModel);
        return fauxAssistantMessage(
          fauxToolCall("edit", {
            path: `scratch-${index}.txt`,
            edits: [{ oldText: "probe\n", newText: "probe edited\n" }],
          }),
          { stopReason: "toolUse" },
        );
      },
  );
  const finalRound = [0, 1].map(
    (index) =>
      async (context: Context, options: StreamOptions | undefined, _state: unknown, requestModel: any) => {
        await onRequest(context, options, requestModel);
        return fauxAssistantMessage(`axis ${index + 1} report`);
      },
  );
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
    getModels() {
      return [model];
    },
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
  const source = await sharedSource();
  const accepted = await sharedDualDispatch();
  const owner = createReviewerWorkspaceOwner();
  try {
    const batch = await owner.prepare(accepted.targetSnapshot, ["standards", "spec"], accepted.bundle);
    assert.equal(batch.workspaces.length, 2);
    for (const workspace of batch.workspaces) {
      assert.equal(workspace.evidence.entries.every((entry) => entry.verified), true);
      await access(join(workspace.path, workspace.evidence.entries[0]!.relativeClonePath));
      await owner.dispose(workspace);
    }
  } finally {
    await owner.shutdown().catch(() => {});
  }
  // Shared frozen source is not owned by this test — leave it for siblings.
  void source;
});

test("child executor runs in an already-prepared workspace without Git materialization", async () => {
  const source = await sharedSource();
  const accepted = await sharedSingleDispatchCached();
  const owner = createReviewerWorkspaceOwner();
  try {
    const batch = await owner.prepare(accepted.targetSnapshot, ["standards"], accepted.bundle);
    const workspace = batch.workspaces[0]!;
    const { context } = await parentContext(source.root, async () => {}, 1);
    const operations: string[] = [];
    const result = await executeReviewerChild(
      workspace.path,
      accepted.legs[0]!,
      context,
      {
        fault(operation) {
          operations.push(operation);
        },
      },
    );
    assert.equal(result.report, "axis 1 report");
    assert.deepEqual(operations, ["child.reload", "child.session"]);
    await owner.dispose(workspace);
  } finally {
    await owner.shutdown().catch(() => {});
  }
});

test("Reviewer materializes shallow session snapshot refs into the workspace", async () => {
  const seed = await sharedSource();
  const shallowRoot = await mkdtemp(join(tmpdir(), "ak-reviewer-shallow-"));
  try {
    await exec("git", ["clone", "--depth", "1", `file://${seed.root}`, shallowRoot]);
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

    // Cheaper: owner.prepare proves shallow ref materialization without a full runner round-trip.
    const accepted = await dispatch(shallowRoot, ["Shallow snapshot review"]);
    const owner = createReviewerWorkspaceOwner();
    try {
      const batch = await owner.prepare(accepted.targetSnapshot, ["standards"], accepted.bundle);
      assert.equal(batch.target.targetHead, tip);
      assert.equal(batch.target.refs["refs/heads/fixed-branch"]?.objectId, tip);
      assert.equal(batch.target.refs["refs/tags/fixed-tag"]?.objectId, tip);
      assert.equal(batch.target.refs["refs/remotes/upstream/fixed"]?.objectId, tip);
      for (const [name, sha] of Object.entries(sourceRefs)) {
        assert.equal(batch.target.refs[name]?.objectId, sha);
      }
      for (const workspace of batch.workspaces) await owner.dispose(workspace);
    } finally {
      await owner.shutdown().catch(() => {});
    }
  } finally {
    await rm(shallowRoot, { recursive: true, force: true });
  }
});

test("Reviewer materializes and verifies a real SHA-256 repository", async (t) => {
  const source = await sharedSha256Source();
  if (source === "unsupported") {
    t.skip("installed Git lacks SHA-256 repository support");
    return;
  }
  const accepted = await dispatch(source.root, ["SHA-256 snapshot review"]);
  const owner = createReviewerWorkspaceOwner();
  try {
    const batch = await owner.prepare(accepted.targetSnapshot, ["standards"], accepted.bundle);
    assert.equal(batch.target.objectFormat, "sha256");
    assert.match(batch.target.targetHead, /^[0-9a-f]{64}$/);
    for (const workspace of batch.workspaces) {
      assert.equal(workspace.evidence.entries.every((entry) => entry.verified), true);
      await owner.dispose(workspace);
    }
  } finally {
    await owner.shutdown().catch(() => {});
  }
});

test("two Reviewer Agent legs overlap in isolated clones with one pinned ref snapshot", async () => {
  const source = await sharedSource();
  const requests: Array<{
    prompt: string;
    tools: string[];
    dispatch: Record<string, unknown>;
    sessionId: string | undefined;
  }> = [];
  const { context } = await parentContext(source.root, async (childContext, options, model) => {
    const user = childContext.messages.find((message) => message.role === "user");
    requests.push({
      prompt:
        user?.role === "user"
          ? typeof user.content === "string"
            ? user.content
            : user.content.map((part) => (part.type === "text" ? part.text : "")).join("")
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

  try {
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
    for (const [axis, leg] of [
      ["standards", standards],
      ["spec", spec],
    ] as const) {
      assert.equal(leg.runtimeConstructionEvidence.leg, axis);
      assert.equal(
        leg.runtimeConstructionEvidence.manifestSha256,
        acceptedDispatch.bundle.manifestSha256,
      );
      assert.deepEqual(
        leg.runtimeConstructionEvidence.entries,
        acceptedDispatch.bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => ({
          id,
          relativeClonePath,
          utf8Length,
          sha256,
          verified: true,
        })),
      );
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
    assert.deepEqual(
      {
        text: await readFile(join(source.root, "fixture.txt"), "utf8"),
        head: await git(source.root, "rev-parse", "HEAD"),
        refs: await git(source.root, "show-ref"),
        status: await git(source.root, "status", "--porcelain"),
      },
      before,
    );
  } finally {
    await runner.shutdown();
  }
});

test("Reviewer child provider delegates class-private streams to the original receiver", async () => {
  const source = await sharedSource();
  const faux = fauxProvider({
    api: "ak-review-private-provider",
    provider: "ak-review-private-provider",
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf widened > forbidden.txt" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("private provider report"),
  ]);
  const originalModel = {
    ...faux.getModel(),
    baseUrl: "https://default.invalid",
  };
  const dispatches: Array<Record<string, unknown>> = [];
  const visibleTools: string[][] = [];
  let deniedBashAttempts = 0;

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

    getModels(): readonly Model<Api>[] {
      return [originalModel];
    }

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
      for (const message of childContext.messages) {
        if (message.role === "toolResult" && message.isError === true) deniedBashAttempts += 1;
      }
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
    const result = await runner.run(
      await dispatch(
        source.root,
        ["Inspect private provider dispatch"],
        ["bash"],
        ["printf exact > allowed.txt"],
      ),
      { context },
    );
    assert.equal(result.legs.standards.report, "private provider report");
    assert.deepEqual(visibleTools, [["bash"], ["bash"]]);
    // Typed gate: denied bash is reported as toolResult isError, not free-text wording.
    assert.ok(deniedBashAttempts >= 1);
    await assert.rejects(access(join(source.root, "forbidden.txt")));
    assert.equal(result.legs.standards.prompt.text, "Inspect private provider dispatch");
    // Private-provider-specific fact only: resolved auth travels on the class stream.
    assert.equal(dispatches.length, 2);
    for (const entry of dispatches) {
      assert.equal(entry.baseUrl, "https://private-resolved.invalid");
      assert.equal(entry.apiKey, "private-secret");
    }
  } finally {
    await runner.shutdown();
  }
});

test("workspace shutdown does not replay pre-creation or post-creation preparation rejection", async () => {
  const source = await sharedSource();
  for (const fault of ["mirror.before-create", "mirror.create"] as const) {
    const accepted = await dispatch(source.root, [fault]);
    const cause = new Error(`classified ${fault}`);
    const owner = createReviewerWorkspaceOwner({
      fault(operation) {
        if (operation === fault) throw cause;
      },
    });
    let retained: string | undefined;
    try {
      await assert.rejects(owner.prepare(accepted.targetSnapshot, ["standards"], accepted.bundle), (error) => {
        assert.equal(error, cause);
        const classified = error as typeof cause & {
          reviewerFailure: string;
          targetSnapshot: unknown;
          workspaceDisposition: "not-created" | { retained: string };
        };
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
      // Double-shutdown must resolve without replaying the preparation rejection.
      await owner.shutdown();
      await owner.shutdown();
      if (retained !== undefined) await access(retained);
    } finally {
      if (retained !== undefined) await rm(retained, { recursive: true, force: true });
    }
  }
});

test("Reviewer Agent reports deterministic setup failures with bounded retention evidence", async () => {
  const source = await sharedSource();
  const { context } = await parentContext(source.root, async () => {}, 1);
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

  // Private parent: global tmpdir scans race with concurrent suite workers that also mint ak-reviewer-child-*.
  const credentialScratchParent = await mkdtemp(join(tmpdir(), "ak-reviewer-cred-scope-"));
  try {
    for (const [fault, expected, classification] of cases) {
      const runner = createReviewerAgentRunner({
        credentialScratchParent,
        fault(operation) {
          if (operation === fault) {
            throw new Error("provider cancelled child prose must not classify this failure");
          }
        },
      });
      const acceptedDispatch = await dispatch(source.root, [fault]);
      let retained: string | undefined;
      try {
        await assert.rejects(runner.run(acceptedDispatch, { context }), (error: any) => {
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
            assert.equal(
              accepted.legs.standards.runtimeConstructionEvidence?.manifestSha256,
              acceptedDispatch.bundle.manifestSha256,
            );
          } else assert.equal(accepted.legs.standards.runtimeConstructionEvidence, undefined);
          return true;
        });
        if (retained !== undefined) await access(retained);
        assert.deepEqual(
          await readdir(credentialScratchParent),
          [],
          `${fault} leaked credential scratch`,
        );
      } finally {
        await runner.shutdown().catch(() => {});
        if (retained !== undefined) await rm(retained, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(credentialScratchParent, { recursive: true, force: true });
  }
});

test("Reviewer Agent cancellation is infrastructure failure and retains its workspace", async () => {
  const source = await sharedSource();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { context } = await parentContext(
    source.root,
    async (_context, options) => {
      markStarted();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    1,
  );
  const credentialScratchParent = await mkdtemp(join(tmpdir(), "ak-reviewer-cred-scope-"));
  const runner = createReviewerAgentRunner({ credentialScratchParent });
  const controller = new AbortController();
  const call = dispatch(source.root, ["Long review"]).then((accepted) =>
    runner.run(accepted, { context, signal: controller.signal }),
  );
  await started;
  controller.abort();
  let retained: string | undefined;
  try {
    await assert.rejects(call, (error: any) => {
      assert.equal(error.name, "ReviewerDispatchExecutionError");
      assert.equal(error.outcome.legs.standards.status, "failed");
      assert.equal(error.outcome.legs.standards.failure, "cancelled");
      retained = error.outcome.legs.standards.workspaceDisposition.retained;
      return true;
    });
    assert.ok(retained);
    await access(retained!);
    assert.deepEqual(await readdir(credentialScratchParent), []);
  } finally {
    await runner.shutdown().catch(() => {});
    if (retained !== undefined) {
      await rm(retained, { recursive: true, force: true });
    }
    await rm(credentialScratchParent, { recursive: true, force: true });
  }
});
