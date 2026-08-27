import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

export function fauxGatekeeper(
  calls: Array<{ tool?: string; args?: object | undefined; text?: string }>,
  seen: string[],
) {
  return async (_model: any, context: any) => {
    seen.push(context.systemPrompt);
    const next = calls.shift();
    if (!next) throw new Error("unexpected child turn");
    if (next.text !== undefined) return fauxAssistantMessage(next.text);
    // Missing args: emit a toolCall with arguments: undefined (Pi pre-execute reject path).
    if (next.args === undefined) {
      return fauxAssistantMessage(
        { type: "toolCall", id: `call-${seen.length}`, name: next.tool!, arguments: undefined as never },
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      fauxToolCall(next.tool!, next.args, { id: `call-${seen.length}` }),
      { stopReason: "toolUse" },
    );
  };
}

/**
 * Shared modelRegistry surface for scripted Gatekeeper provider fixtures.
 * Province resolve (#453) may read host public-cli seat selection and call `find`;
 * pass-path harnesses bind the scripted model so machine seats cannot break the seam.
 */
export function scriptedGatekeeperModelRegistry(
  model: { provider: string },
  provider: unknown,
  options: {
    matchProvider?: boolean;
    getProviderAuth?: () => Promise<unknown>;
    getApiKeyAndHeaders?: (...args: any[]) => Promise<unknown>;
  } = {},
) {
  const matchProvider = options.matchProvider !== false;
  return {
    getProvider(name: string) {
      return matchProvider ? (name === model.provider ? provider : undefined) : provider;
    },
    find(_provider: string, _modelId: string) {
      return model;
    },
    async getProviderAuth() {
      return options.getProviderAuth ? options.getProviderAuth() : { auth: {} };
    },
    async getApiKeyAndHeaders(...args: any[]) {
      return options.getApiKeyAndHeaders
        ? options.getApiKeyAndHeaders(...args)
        : { ok: true };
    },
  };
}
