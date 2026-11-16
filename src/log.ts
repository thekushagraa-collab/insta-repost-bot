// One-line timestamped logs. GitHub Actions keeps these in the run history.
export type Logger = (message: string) => void;

export const log: Logger = (message) => {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
