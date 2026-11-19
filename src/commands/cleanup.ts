// `cleanup`: deletes the previous owner's oldest videos from the NEW page (3 per run, once a day).
// Deleting is permanent, so every guard below refuses instead of guessing.
import type { GraphClient } from "../graph";
import { deleteMedia, getAccount, listAllMedia } from "../instagram";
import { errorMessage, type Logger } from "../log";
import { pickMediaToDelete } from "../select";
import { istDayStart } from "../slots";
import { loadState, saveState, withDeleted } from "../state";

export const DELETES_PER_RUN = 3;

export interface CleanupDeps {
  newClient: GraphClient;
  statePath: string;
  dryRun: boolean;
  log: Logger;
  limit?: number;
  expectedNewUsername?: string;
  now?: () => Date;
}

export type CleanupOutcome =
  | { kind: "deleted"; ids: string[] }
  | { kind: "dry-run"; ids: string[] }
  | { kind: "already-done-today" }
  | { kind: "nothing-to-delete" }
  | { kind: "refused"; reason: string };

export class CleanupFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupFailedError";
  }
}

function clean(name: string): string {
  return name.trim().replace(/^@/, "").toLowerCase();
}

export async function runCleanup(deps: CleanupDeps): Promise<CleanupOutcome> {
  const dailyLimit = deps.limit ?? DELETES_PER_RUN;
  let state = await loadState(deps.statePath);

  // At most `dailyLimit` deletes per India day, however many times this run is started.
  const dayStart = istDayStart((deps.now ?? (() => new Date()))()).getTime();
  const deletedToday = Object.values(state.deleted).filter((entry) => Date.parse(entry.deletedAt) >= dayStart).length;
  const limit = dailyLimit - deletedToday;
  if (limit <= 0) {
    deps.log(`Already deleted ${deletedToday} videos today. Nothing to do.`);
    return { kind: "already-done-today" };
  }

  if (Object.keys(state.posted).length === 0) {
    const reason = "The bot has not reposted anything yet, so it cannot tell the previous owner's videos from its own. Deleting nothing.";
    deps.log(reason);
    return { kind: "refused", reason };
  }

  const account = await getAccount(deps.newClient);
  if (deps.expectedNewUsername && clean(deps.expectedNewUsername) !== clean(account.username)) {
    throw new CleanupFailedError(
      `NEW_IG_TOKEN belongs to @${account.username}, but NEW_IG_USERNAME says @${clean(deps.expectedNewUsername)}. Deleting nothing.`,
    );
  }

  const media = await listAllMedia(deps.newClient);

  // Guard: our own reposts must be visible in this listing, otherwise this is not the page we think it is.
  const knownOurIds = Object.values(state.posted)
    .map((entry) => entry.newMediaId)
    .filter((id) => id !== "unknown");
  if (knownOurIds.length > 0 && !media.some((item) => knownOurIds.includes(item.id))) {
    const reason = "None of the bot's own reposts show up on this account. Refusing to delete anything.";
    deps.log(reason);
    return { kind: "refused", reason };
  }

  const picks = pickMediaToDelete(media, state, limit);
  if (picks.length === 0) {
    deps.log("No previous-owner videos left to delete.");
    return { kind: "nothing-to-delete" };
  }

  const verb = deps.dryRun ? "Would delete" : "Deleting";
  for (const item of picks) deps.log(`${verb} ${item.id} from ${item.timestamp.slice(0, 10)} (${item.permalink ?? "no link"})`);
  if (deps.dryRun) {
    deps.log("DRY_RUN is on, so nothing was deleted.");
    return { kind: "dry-run", ids: picks.map((item) => item.id) };
  }

  const deletedIds: string[] = [];
  for (const item of picks) {
    try {
      await deleteMedia(deps.newClient, item.id);
    } catch (error) {
      // Stop at the first failure: it is usually account-wide (permission, rate limit) and retrying would only repeat it.
      throw new CleanupFailedError(
        `Could not delete ${item.id}: ${errorMessage(error)}${deletedIds.length > 0 ? ` (${deletedIds.length} deleted before this)` : ""}`,
      );
    }
    deletedIds.push(item.id);
    state = withDeleted(state, item.id, { deletedAt: (deps.now ?? (() => new Date()))().toISOString(), permalink: item.permalink });
    await saveState(deps.statePath, state);
  }
  deps.log(`Deleted ${deletedIds.length} previous-owner videos. ${Object.keys(state.deleted).length} deleted in total.`);
  return { kind: "deleted", ids: deletedIds };
}
