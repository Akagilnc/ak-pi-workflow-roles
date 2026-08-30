/**
 * Drive the production after_provider_response handler so typed HTTP 429
 * evidence is written through the real observation seam.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";

export async function observeTyped429ViaProductionHandler(input: {
  runDirectory: string;
  provider: "openai-codex" | "xai";
  httpStatus?: number;
}): Promise<void> {
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => unknown
  >();
  const pi = {
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
    getAllTools() {
      return [];
    },
    setActiveTools() {},
  };
  createPiRoleRuntimeExtension({
    loadJudgeSoul: async () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(pi as unknown as ExtensionAPI);

  const handler = handlers.get("after_provider_response");
  if (handler === undefined) {
    throw new Error("production after_provider_response handler was not registered");
  }

  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = input.runDirectory;
  try {
    await handler(
      {
        type: "after_provider_response",
        status: input.httpStatus ?? 429,
        headers: {},
      },
      { model: { provider: input.provider } },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AK_ROLE_RUN_DIR;
    } else {
      process.env.AK_ROLE_RUN_DIR = previous;
    }
  }
}
