/** Shared public CLI usage error (structural reject before admission). */
export class CliUsageError extends Error {
  readonly code = "AK_ROLE_USAGE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CliUsageError";
  }
}
