export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Public resume presents its failure diagnostic via a durable-file pointer instead. */
  omitFailureStderrDiagnostic?: boolean;
};
