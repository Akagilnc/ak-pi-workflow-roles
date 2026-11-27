export const discardStdout = (_text: string): void => {};

export type CliIo = {
  /** A quiet nested seat's package faults (unreadable receipts, faults beside a conclusion) still belong to the public caller. */
  callerDiagnostic?: (text: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Public resume presents its failure diagnostic via a durable-file pointer instead. */
  omitFailureStderrDiagnostic?: boolean;
};

export type SummonIo = CliIo | Pick<CliIo, "callerDiagnostic">;
