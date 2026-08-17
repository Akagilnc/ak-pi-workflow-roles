/**
 * #376 — engine detour tool guidance covers optional notes and name-only paths.
 * Does not invent argv, alias maps, or a second tool; only inspects registered copy.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AK_ROLE_ENGINE_ENV } from "../../src/engine-detour.ts";
import { registerEngineDetourTool } from "../../src/engine-detour-tool.ts";

type RegisteredTool = {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters?: {
    properties?: {
      argv?: { description?: string };
    };
  };
};

test("detour tool guidance admits name-only and optional notes; no material precondition", () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "company..opus";
  try {
    const tools: RegisteredTool[] = [];
    const pi = {
      registerTool(def: RegisteredTool) {
        tools.push(def);
      },
    } as unknown as ExtensionAPI;

    const registration = registerEngineDetourTool(pi, {
      failInfrastructure() {
        throw new Error("failInfrastructure must not run during registration");
      },
    });
    assert.equal(registration.registered, true);
    assert.equal(tools.length, 1);

    const tool = tools[0]!;
    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    const argvDescription = tool.parameters?.properties?.argv?.description ?? "";
    const blob = [tool.description, guidelines, argvDescription].join("\n");

    // Must not gate the call on packaged material being present.
    assert.equal(
      /when engine method material is present/i.test(blob),
      false,
      "material must not be a detour precondition",
    );
    assert.equal(
      /Assemble argv from the engine method material path/i.test(blob),
      false,
      "argv must not be required to come only from a material path",
    );

    // Covers both optional notes and bare engine-name paths via host CLI.
    assert.match(blob, /host CLI actual interface/i);
    assert.match(blob, /optional packaged notes/i);
    assert.match(blob, /bare engine name|engine name alone|configured engine/i);
    assert.match(tool.description, /company\.\.opus/);
  } finally {
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});
