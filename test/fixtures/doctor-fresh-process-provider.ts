import { writeFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { navigatorChildOrUndefined } from "../helpers/navigator-child-fixture.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
/** #675 public auditor terminating tool. */
const AUDITOR_OUTPUT_TOOL_NAME = "ak_auditor_output";

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
  const capture = (context: Context, names: readonly string[]) => {
    if (captured || typeof capturePath !== "string" || capturePath.trim() === "") return;
    // #675: nested public auditor reuses this fixture — only capture the doctor seat prompt.
    if (!names.includes(DOCTOR_OUTPUT_TOOL_NAME)) return;
    captured = true;
    writeFileSync(capturePath, context.systemPrompt ?? "", "utf8");
  };
  // Deterministic dispatch by real tool names: nested public Navigator may
  // consume a turn before Doctor output/audit (#675).
  const respond = (context: Context) => {
    const navigator = navigatorChildOrUndefined(context, { role: "doctor", phase: null });
    if (navigator !== undefined) return navigator;
    const names = context.tools?.map((tool) => tool.name) ?? [];
    capture(context, names);
    const auditTool = names.includes(AUDITOR_OUTPUT_TOOL_NAME)
      ? AUDITOR_OUTPUT_TOOL_NAME
      : names.includes(DOCTOR_AUDIT_TOOL_NAME)
        ? DOCTOR_AUDIT_TOOL_NAME
        : undefined;
    if (auditTool !== undefined) {
      return fauxAssistantMessage(
        fauxToolCall(
          auditTool,
          { status: "pass", violations: [], conflicts: [], decisionGate: null },
          { id: "doctor-audit" },
        ),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      fauxToolCall(
        DOCTOR_OUTPUT_TOOL_NAME,
        { status: "completed", case: { issueNumber, runsPath }, findings: [] },
        { id: "doctor-output" },
      ),
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses(Array.from({ length: 8 }, () => respond));

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
  });
}
