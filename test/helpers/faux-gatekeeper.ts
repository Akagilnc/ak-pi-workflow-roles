import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";

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
