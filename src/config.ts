// Reads settings from environment variables (GitHub Actions secrets, or a local .env file).
import { isInstagramToken } from "./graph";

export interface Config {
  oldToken: string;
  newToken: string;
  apiVersion: string;
  statePath: string;
  dryRun: boolean;
  /** How many different videos one run may try before giving up. */
  maxAttempts: number;
  /** Optional safety check that the tokens were not swapped. */
  oldUsername?: string;
  newUsername?: string;
  /** Instagram account ids. Needed for Facebook-issued (EAA...) tokens, which cannot use "me". */
  oldUserId?: string;
  newUserId?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_API_VERSION = "v24.0";
const DEFAULT_STATE_PATH = "state/state.json";
const DEFAULT_MAX_ATTEMPTS = 3;

function readFlag(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

function readPositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ConfigError(`${name} must be a whole number above 0.`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const oldToken = env.OLD_IG_TOKEN?.trim() ?? "";
  const newToken = env.NEW_IG_TOKEN?.trim() ?? "";
  const missing = [!oldToken && "OLD_IG_TOKEN", !newToken && "NEW_IG_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigError(`Missing ${missing.join(" and ")}. See docs/SETUP.md, step 4.`);
  }
  for (const [tokenName, token, idName, id] of [
    ["OLD_IG_TOKEN", oldToken, "OLD_IG_USER_ID", env.OLD_IG_USER_ID],
    ["NEW_IG_TOKEN", newToken, "NEW_IG_USER_ID", env.NEW_IG_USER_ID],
  ] as const) {
    if (!isInstagramToken(token) && !id?.trim()) {
      throw new ConfigError(`${tokenName} is a Facebook-issued token, so ${idName} (the Instagram account id) is also required.`);
    }
    if (id?.trim() && !/^\d+$/.test(id.trim())) throw new ConfigError(`${idName} must be digits only.`);
  }
  const apiVersion = env.GRAPH_API_VERSION?.trim() || DEFAULT_API_VERSION;
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new ConfigError("GRAPH_API_VERSION must look like v24.0.");

  return {
    oldToken,
    newToken,
    apiVersion,
    statePath: env.STATE_PATH?.trim() || DEFAULT_STATE_PATH,
    dryRun: readFlag(env.DRY_RUN),
    maxAttempts: readPositiveInt("MAX_ATTEMPTS", env.MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    oldUsername: env.OLD_IG_USERNAME?.trim() || undefined,
    newUsername: env.NEW_IG_USERNAME?.trim() || undefined,
    oldUserId: env.OLD_IG_USER_ID?.trim() || undefined,
    newUserId: env.NEW_IG_USER_ID?.trim() || undefined,
  };
}
