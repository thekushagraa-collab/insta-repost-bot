// The bot's memory: which old videos were already reposted. Stored as JSON in the repo
// (state/state.json) and committed back by the GitHub Actions workflow after every run.
// Every helper returns a new object; nothing is mutated in place.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PostedEntry {
  /** Id of the new post, or "unknown" when recovered after a crash. */
  newMediaId: string;
  postedAt: string;
}

export interface PendingEntry {
  oldMediaId: string;
  containerId: string;
  createdAt: string;
}

export interface FailureEntry {
  count: number;
  lastReason: string;
  lastAt: string;
}

export interface BotState {
  version: 1;
  /** Keyed by the OLD page's media id. */
  posted: Record<string, PostedEntry>;
  failures: Record<string, FailureEntry>;
  /** A container that was created but whose publish result was not saved yet. */
  pending: PendingEntry | null;
  lastTokenRefreshAt: string | null;
}

export function emptyState(): BotState {
  return { version: 1, posted: {}, failures: {}, pending: null, lastTokenRefreshAt: null };
}

export class StateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and checks the saved state, so a hand-edited or corrupted file fails loudly instead of reposting everything. */
export function parseState(raw: string): BotState {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new StateFileError("State file is not valid JSON. Fix it or restore it from git history.");
  }
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.posted) || !isRecord(data.failures)) {
    throw new StateFileError("State file has an unexpected shape. Fix it or restore it from git history.");
  }
  const pending = data.pending;
  if (pending !== null && pending !== undefined && !isRecord(pending)) {
    throw new StateFileError("State file has an invalid 'pending' entry.");
  }
  return {
    version: 1,
    posted: data.posted as BotState["posted"],
    failures: data.failures as BotState["failures"],
    pending: (pending ?? null) as PendingEntry | null,
    lastTokenRefreshAt: typeof data.lastTokenRefreshAt === "string" ? data.lastTokenRefreshAt : null,
  };
}

export async function loadState(path: string): Promise<BotState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  return parseState(raw);
}

/** Writes to a temp file first, then renames, so a crash never leaves half a file behind. */
export async function saveState(path: string, state: BotState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export function withPending(state: BotState, pending: PendingEntry | null): BotState {
  return { ...state, pending };
}

export function withPosted(state: BotState, oldMediaId: string, entry: PostedEntry): BotState {
  const { [oldMediaId]: _cleared, ...failures } = state.failures;
  return {
    ...state,
    posted: { ...state.posted, [oldMediaId]: entry },
    failures,
    pending: null,
  };
}

export function withFailure(state: BotState, oldMediaId: string, reason: string, at: string): BotState {
  const previous = state.failures[oldMediaId];
  return {
    ...state,
    failures: {
      ...state.failures,
      [oldMediaId]: { count: (previous?.count ?? 0) + 1, lastReason: reason, lastAt: at },
    },
    pending: null,
  };
}

export function withTokenRefresh(state: BotState, at: string): BotState {
  return { ...state, lastTokenRefreshAt: at };
}
