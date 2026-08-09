import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context, type Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../../src/fixer-auditor.ts";

const input = {
  soul: "Fixer law exact bytes",
  packet: Object.freeze({ version: 1 as const, instructions: "Assigned finding packet", prerequisites: Object.freeze([{ id: "owner.choice", requirement: "Owner chooses." }]) }),
  phase: "apply" as const,
  transcript: "invocation transcript",
  candidate: { status: "completed" as const, report: "settled", classResults: [{ name: "Parser", disposition: "completed" as const, searchScope: "all parsers", exceptions: [], commitSha: "a".repeat(40) }] },
};
const context = { model: { provider: "active", id: "same-model" }, modelRegistry: {
  async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
  async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; },
}, sessionManager: SessionManager.inMemory() } as unknown as ExtensionContext;
