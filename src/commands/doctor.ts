// `doctor`: checks that both tokens work and point at the right kind of accounts.
import type { GraphClient } from "../graph";
import { getAccount, getPublishingLimit } from "../instagram";
import { errorMessage, type Logger } from "../log";
import { loadState } from "../state";

const PROFESSIONAL_TYPES = new Set(["BUSINESS", "MEDIA_CREATOR"]);
const TOKEN_LIFETIME_DAYS = 60;
const DAY_MS = 86_400_000;

export interface DoctorDeps {
  oldClient: GraphClient;
  newClient: GraphClient;
  statePath: string;
  log: Logger;
  now?: () => Date;
}

/** Returns the list of problems found. An empty list means everything is ready. */
export async function runDoctor(deps: DoctorDeps): Promise<string[]> {
  const problems: string[] = [];
  const ids: Record<string, string> = {};

  for (const [label, client] of [
    ["OLD", deps.oldClient],
    ["NEW", deps.newClient],
  ] as const) {
    try {
      const account = await getAccount(client);
      ids[label] = account.user_id;
      deps.log(`${label} token OK: @${account.username} (${account.account_type ?? "type unknown"}, ${account.media_count ?? "?"} posts)`);
      if (account.account_type && !PROFESSIONAL_TYPES.has(account.account_type)) {
        problems.push(`${label} account must be a Business or Creator account.`);
      }
    } catch (error) {
      problems.push(`${label}_IG_TOKEN does not work: ${errorMessage(error)}`);
    }
  }

  if (ids.OLD && ids.OLD === ids.NEW) problems.push("Both tokens belong to the same account.");

  if (ids.NEW) {
    try {
      const limit = await getPublishingLimit(deps.newClient, ids.NEW);
      if (limit) deps.log(`NEW page has used ${limit.quota_usage} of ${limit.config?.quota_total ?? "?"} API posts in the last 24 hours.`);
    } catch (error) {
      problems.push(`NEW token cannot publish: ${errorMessage(error)}`);
    }
  }

  const state = await loadState(deps.statePath);
  deps.log(`Reposted so far: ${Object.keys(state.posted).length}.`);
  if (!state.lastTokenRefreshAt && !deps.oldClient.accountNode && !deps.newClient.accountNode) {
    deps.log("Tokens have not been refreshed by the bot yet (the weekly job does this).");
  } else if (state.lastTokenRefreshAt) {
    const now = (deps.now ?? (() => new Date()))();
    const ageDays = Math.floor((now.getTime() - Date.parse(state.lastTokenRefreshAt)) / DAY_MS);
    deps.log(`Tokens last refreshed ${ageDays} days ago.`);
    if (ageDays > TOKEN_LIFETIME_DAYS - 10) problems.push("Tokens have not been refreshed for over 50 days and will expire soon.");
  }

  for (const problem of problems) deps.log(`PROBLEM: ${problem}`);
  if (problems.length === 0) deps.log("All checks passed.");
  return problems;
}
