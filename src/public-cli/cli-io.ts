export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};
