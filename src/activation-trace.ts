import { Type, type Static } from "typebox";

const causeSchema = Type.Object({
  identity: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  message: Type.String(),
  evidenceId: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const activationTraceRecordSchema = Type.Union([
  Type.Object({
    role: Type.String({ minLength: 1 }),
    stageId: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    status: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
    timestamp: Type.String({ format: "date-time" }),
  }, { additionalProperties: false }),
  Type.Object({
    role: Type.String({ minLength: 1 }),
    stageId: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    status: Type.Literal("failed"),
    timestamp: Type.String({ format: "date-time" }),
    cause: causeSchema,
  }, { additionalProperties: false }),
]);

export type ActivationTraceRecord = Static<typeof activationTraceRecordSchema>;
export type ActivationTraceWriter = (record: ActivationTraceRecord) => void;

let activationCauseEvidence = 0;
const retainedActivationCauses = new Map<string, unknown>();
export function namedActivationCause(error: unknown): { identity: string; name: string; message: string; evidenceId?: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const name = error.name || "Error";
    return { identity: typeof code === "string" && code.length > 0 ? code : name, name, message: error.message };
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
    return { identity: "UnknownThrownCause", name: "UnknownThrownCause", message };
  } catch {
    const evidenceId = `activation-cause-${++activationCauseEvidence}`;
    retainedActivationCauses.set(evidenceId, error);
    return { identity: "UnknownThrownCause", name: "UnknownThrownCause", message: String(error), evidenceId };
  }
}
