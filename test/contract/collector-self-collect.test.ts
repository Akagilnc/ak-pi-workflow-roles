/**
 * #1088: 通进司 keeps the seat and request-manifest; code no longer collects.
 * LLM uses host CLI tools; evidence seat stays non-construction.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadCollectorManifest } from "../../src/collector-config.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { packagedRoleMetadata } from "../../src/packaged-role-registry.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import type { HostToolDefinition } from "../../src/host-contracts.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

type Handler = (...args: unknown[]) => unknown;

const CODE_COLLECTION_TOOLS = [
  "ak_collector_observe",
  "ak_collector_read",
  "ak_collector_request",
  "ak_collector_wait",
  "ak_collector_open_wait_window",
  "ak_collector_bind_target",
  "ak_collector_handbook_write",
] as const;

function extensionHarness(
  role: string | undefined,
  extraFlags: Readonly<Record<string, string>> = {},
) {
  const handlerLists = new Map<string, Handler[]>();
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, HostToolDefinition>();
  const flags = new Map<string, unknown>();
  let activeTools: string[] = ["bash", "read", "write"];

  // Host surface present before seat activation (ADR 0064 evidence path).
  for (const name of activeTools) {
    tools.set(name, {
      name,
      label: name,
      description: name,
      parameters: {},
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    } as unknown as HostToolDefinition);
  }

  const dispatch = (name: string): Handler => async (event, ctx) => {
    const results: unknown[] = [];
    for (const handler of handlerLists.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    for (let i = results.length - 1; i >= 0; i -= 1) {
      if (results[i] !== undefined) return results[i];
    }
    return undefined;
  };

  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.set(name, options);
    },
    getFlag(name: string) {
      if (name === "ak-role") return role;
      return extraFlags[name];
    },
    on(name: string, handler: Handler) {
      const list = handlerLists.get(name) ?? [];
      list.push(handler);
      handlerLists.set(name, list);
      handlers.set(name, dispatch(name));
    },
    registerTool(tool: HostToolDefinition) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return [...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getActiveTools() {
      return [...activeTools];
    },
  };
  return { pi, handlers, tools, flags, active: () => activeTools };
}

function activationCtx(home: string): ExtensionContext {
  const sessionDir = join(
    home,
    ".ak-roles",
    "books",
    basename(home),
    "runs",
    "collector-self",
    "session",
  );
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(home, sessionDir);
  return {
    abort: () => {},
    cwd: home,
    mode: "print",
    sessionManager,
  } as unknown as ExtensionContext;
}

test("#1088 collector seat stays evidence-only (not construction worker)", () => {
  const meta = packagedRoleMetadata("collector");
  assert.ok(meta);
  assert.equal(
    "artifactFace" in meta && meta.artifactFace?.evidenceRole === true,
    true,
  );
  assert.equal("worker" in meta && meta.worker === true, false);
  assert.equal(
    "phases" in meta && Array.isArray(meta.phases) && meta.phases.includes("apply"),
    false,
  );
});

test("#1088 public request-manifest keeps semantic validation (UTF-8 JSON + required fields)", async () => {
  await withTempRoot("collector-1088-manifest-", async (root) => {
    const path = join(root, "requests.json");
    await writeFile(
      path,
      JSON.stringify({ requests: [{ id: "codex", body: "@codex review" }] }),
    );
    const manifest = await loadCollectorManifest(path);
    assert.equal(manifest.requests.length, 1);
    assert.equal(manifest.requests[0]?.id, "codex");

    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(() => loadCollectorManifest(path), /UTF-8 JSON|must be UTF-8 JSON/);

    await writeFile(path, JSON.stringify({ requests: [{ id: "x", body: "" }] }));
    await assert.rejects(() => loadCollectorManifest(path), /requests\[0\] is invalid/);
  });
});

test("#1088 collector activation keeps host CLI tools and drops code-collection tools", async () => {
  await withTempRoot("collector-1088-tools-", async (home) => {
    const harness = extensionHarness("collector", {
      "ak-collector-repo": "acme/widgets",
      "ak-collector-pr": "42",
    });
    createPiRoleRuntimeExtension({
      loadRoleSoul: async (role) =>
        role === "collector" ? "# Collector\nCollect with host CLI." : "other",
    })(harness.pi as unknown as ExtensionAPI);

    const ctx = activationCtx(home);
    await harness.handlers.get("session_start")?.({ reason: "startup" }, ctx);

    assert.ok(
      harness.tools.has(COLLECTOR_OUTPUT_TOOL),
      "collector output tool must remain for LLM submission",
    );
    for (const name of CODE_COLLECTION_TOOLS) {
      assert.equal(
        harness.tools.has(name),
        false,
        `code-collection tool ${name} must be removed`,
      );
    }

    const active = harness.active();
    assert.ok(active.includes(COLLECTOR_OUTPUT_TOOL), "output tool must be active");
    assert.ok(active.includes("bash"), "host bash must stay reachable for gh CLI");
    assert.ok(active.includes("read"), "host read must stay reachable");

    const toolCall = harness.handlers.get("tool_call");
    assert.ok(toolCall, "tool_call gate registers after admission");
    const bashGate = await toolCall(
      { toolName: "bash", toolCallId: "call-bash" },
      ctx,
    );
    assert.equal(
      bashGate,
      undefined,
      "host bash must not be blocked by collector allowlist",
    );
    const writeGate = await toolCall(
      { toolName: "write", toolCallId: "call-write" },
      ctx,
    );
    // 收证席: construction write stays blocked even when host surface exists.
    assert.equal(
      (writeGate as { block?: boolean } | undefined)?.block,
      true,
      "collector must not gain construction write permission",
    );
  });
});
