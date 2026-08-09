import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createPiDoctorAuditor, DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";

const context = { model: { provider: "test", id: "doctor" }, modelRegistry: { async getProviderAuth() { return { auth: { apiKey: "secret" } }; }, async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; } }, sessionManager: SessionManager.inMemory() } as unknown as ExtensionContext;
