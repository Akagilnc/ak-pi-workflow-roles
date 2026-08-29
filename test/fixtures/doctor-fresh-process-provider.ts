import { writeFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";

export default async function doctorFreshProcessProvider(pi: ExtensionAPI): Promise<void> {
  const runsPath = process.env.AK_DOCTOR_FRESH_CASE_PATH;
  const issueNumber = Number(process.env.AK_DOCTOR_FRESH_ISSUE);
  if (typeof runsPath !== "string" || !runsPath || !Number.isInteger(issueNumber)) {
    throw new Error("Doctor fresh-process fixture is missing its case identity");
  }
  const capturePath = process.env.AK_DOCTOR_FRESH_CAPTURE_SYSTEM_PROMPT;

  const faux = fauxProvider({
    api: "ak-doctor-fresh",
    provider: "ak-doctor-fresh",
    tokenSize: { min: 1000, max: 1000 },
  });
  const seeded = await seedAgentDirModelsJsonFromFaux(faux, process.env.PI_CODING_AGENT_DIR);
  let captured = false;
  const capture = (context: Context) => {
    if (captured || typeof capturePath !== "string" || capturePath.trim() === "") return;
    captured = true;
    writeFileSync(capturePath, context.systemPrompt ?? "", "utf8");
  };
  faux.setResponses([
    (context: Context) => {
      capture(context);
      return fauxAssistantMessage(
        fauxToolCall(
          DOCTOR_OUTPUT_TOOL_NAME,
          { status: "completed", case: { issueNumber, runsPath }, findings: [] },
          { id: "doctor-output" },
        ),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage(
      fauxToolCall(
        DOCTOR_AUDIT_TOOL_NAME,
        { status: "pass", violations: [], conflicts: [], decisionGate: null },
        { id: "doctor-audit" },
      ),
      { stopReason: "toolUse" },
    ),
  ]);

  const model = faux.getModel();
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Offline Doctor fresh-process fixture",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
    getModels() {
      return [model];
    },
  };
  pi.registerProvider(provider);
  pi.on("session_shutdown", () => {
    void seeded.close();
    console.error(`DOCTOR_FRESH_PROVIDER_CALLS=${faux.state.callCount}`);
  });
}
