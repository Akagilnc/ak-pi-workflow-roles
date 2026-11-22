export const discardStdout = (_text: string): void => {};

export type CliIo = {
  /** Receipt read faults from quiet nested seats still belong to the public caller. */
  receiptDiagnostic?: (text: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Public resume presents its failure diagnostic via a durable-file pointer instead. */
  omitFailureStderrDiagnostic?: boolean;
};

export type SummonIo = CliIo | Pick<CliIo, "receiptDiagnostic">;
