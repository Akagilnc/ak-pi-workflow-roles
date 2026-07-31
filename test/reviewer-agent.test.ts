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

import { createReviewerAgentRunner } from "../src/reviewer-agent.ts";

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
    const result = await runner.runReviewerAgent(
      { description: "Standards", prompt: "Shallow snapshot review" },
      { context },
    );
    assert.equal(childReached, true);
    assert.match(result.report, /\S/);
    assert.equal(result.targetSnapshot?.targetHead, tip);
    assert.equal(result.targetSnapshot?.refs["refs/heads/fixed-branch"], tip);
    assert.equal(result.targetSnapshot?.refs["refs/tags/fixed-tag"], tip);
    assert.equal(result.targetSnapshot?.refs["refs/remotes/upstream/fixed"], tip);
    for (const [name, sha] of Object.entries(sourceRefs)) {
      assert.equal(result.targetSnapshot?.refs[name], sha);
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
    const [standards, spec] = await Promise.all([
      runner.runReviewerAgent(
        { description: "Standards", prompt: "Standards prompt" },
        { context },
      ),
      runner.runReviewerAgent(
        { description: "Spec", prompt: "Spec prompt" },
        { context },
      ),
    ]);

    assert.deepEqual(
      [standards.report, spec.report].sort(),
      ["axis 1 report", "axis 2 report"],
    );
    assert.equal(standards.workspaceDisposition, "deleted");
    assert.equal(spec.workspaceDisposition, "deleted");
    assert.deepEqual(standards.targetSnapshot, spec.targetSnapshot);
    assert.equal(standards.targetSnapshot?.refs["refs/heads/fixed-branch"], source.base);
    assert.equal(standards.targetSnapshot?.refs["refs/tags/fixed-tag"], source.base);
    assert.equal(standards.targetSnapshot?.refs["refs/remotes/upstream/fixed"], source.base);
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
  faux.setResponses([fauxAssistantMessage("private provider report")]);
  const originalModel = {
    ...faux.getModel(),
    baseUrl: "https://default.invalid",
  };
  const dispatches: Array<Record<string, unknown>> = [];

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
    const result = await runner.runReviewerAgent(
      { description: "Standards", prompt: "Inspect private provider dispatch" },
      { context },
    );
    assert.equal(result.report, "private provider report");
    assert.deepEqual(dispatches, [{
      baseUrl: "https://private-resolved.invalid",
      apiKey: "private-secret",
      headers: { "x-private": "yes" },
      env: { PRIVATE_TENANT: "test" },
    }]);
  } finally {
    await rm(source.root, { recursive: true, force: true });
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
  const call = runner.runReviewerAgent(
    { description: "Standards", prompt: "Long review" },
    { context, signal: controller.signal },
  );
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
    }, /cancel|abort/i);
    assert.ok(retained);
    await access(retained);
  } finally {
    if (retained !== undefined) {
      await rm(retained, { recursive: true, force: true });
    }
    await rm(source.root, { recursive: true, force: true });
  }
});
