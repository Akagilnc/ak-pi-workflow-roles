/**
 * Package-owned shared infrastructure-failure declaration for every primary
 * packaged-role output tool (#541 / #1214 A2).
 *
 * One module owns the infrastructureFailure declaration composed into each
 * output tool's schema. Name and semantic description only — no object type, so
 * a null fill is not a shape rejection (#1134). The field is part of the role's
 * original receipt: ledger records it as-is. Declaration alone does not abort
 * the host (#1214 A2). True host/lifecycle failure still fails honestly on its
 * own channel.
 */
import { Type, type TSchema } from "typebox";

export const INFRASTRUCTURE_FAILURE_DECLARATION_KEY =
  "infrastructureFailure" as const;

/** Name + semantic description. diagnostic's meaning lives in the description. */
const infrastructureFailureField = Type.Unknown({
  description: "仅基础设施真实失败时填 {diagnostic}；没有就填 null",
});

/**
 * Compose declarations shared by terminating output tools: infrastructure failure,
 * the optional role-asserted ticket identity, and the optional seat-written conclusion
 * summary (#1198). Returns an open object (additionalProperties: true) with the base
 * schema's properties plus the shared declarations. Incoming required keys that still
 * exist are kept; every other key stays optional.
 * Static typing is preserved on the base (`as S`), so existing
 * `Static<typeof ...>` derived parameter types are unchanged.
 */
export function withTerminatingOutputDeclarations<
  S extends TSchema & { properties?: Record<string, TSchema> },
>(schema: S): S {
  const baseProperties = (schema as { properties?: Record<string, TSchema> })
    .properties;
  const properties: Record<string, TSchema> = {
    ...(baseProperties ?? {}),
    ...(
      baseProperties?.ticketNumber === undefined
        ? {
            ticketNumber: Type.Unknown({
              description:
                "仅尚未绑定时填本票号（正整数、数字串或前导 #N；归位只读本字段）；没有就填 null",
            }),
          }
        : {}
    ),
    ...(
      baseProperties?.summary === undefined
        ? {
            summary: Type.Unknown({
              description:
                "仅本席有结论时填一两句、20–50 字结论摘要；没有就填 null。不因缺失或超长拒收、截断或代填。",
            }),
          }
        : {}
    ),
    [INFRASTRUCTURE_FAILURE_DECLARATION_KEY]: infrastructureFailureField,
  };
  const object = Type.Object(properties, { additionalProperties: true });
  const incoming = (schema as { required?: unknown }).required;
  const preserved = Array.isArray(incoming)
    ? incoming.filter((key): key is string => typeof key === "string" && Object.hasOwn(properties, key))
    : [];
  (object as unknown as { required: string[] }).required = preserved;
  return object as unknown as S;
}
