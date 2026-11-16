// `refresh-tokens`: Instagram tokens last 60 days. This extends both, and if Instagram hands
// back a different token string, saves it into the GitHub secret so the next run uses it.
import type { GraphClient } from "../graph";
import { refreshToken } from "../instagram";
import { errorMessage, type Logger } from "../log";
import { loadState, saveState, withTokenRefresh } from "../state";

export type SecretWriter = (name: string, value: string) => Promise<void>;

export interface RefreshTarget {
  secretName: "OLD_IG_TOKEN" | "NEW_IG_TOKEN";
  client: GraphClient;
  currentToken: string;
}

export interface RefreshDeps {
  targets: RefreshTarget[];
  statePath: string;
  log: Logger;
  /** Undefined when no GitHub token is configured; then a changed token is an error. */
  writeSecret?: SecretWriter;
  /** Hides a value from GitHub Actions logs. */
  mask: (value: string) => void;
  now?: () => Date;
}

export class RefreshFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshFailedError";
  }
}

export async function runRefresh(deps: RefreshDeps): Promise<void> {
  const failures: string[] = [];

  for (const target of deps.targets) {
    try {
      const refreshed = await refreshToken(target.client);
      deps.mask(refreshed.access_token);
      if (refreshed.access_token !== target.currentToken) {
        if (!deps.writeSecret) {
          throw new Error("Instagram issued a new token but GH_PAT is not set, so it cannot be saved. See docs/SETUP.md, step 5.");
        }
        await deps.writeSecret(target.secretName, refreshed.access_token);
        deps.log(`${target.secretName}: new token saved to GitHub secrets.`);
      }
      deps.log(`${target.secretName}: valid for ${Math.floor(refreshed.expires_in / 86_400)} more days.`);
    } catch (error) {
      failures.push(`${target.secretName}: ${errorMessage(error)}`);
    }
  }

  if (failures.length > 0) throw new RefreshFailedError(`Token refresh failed. ${failures.join(" | ")}`);

  const state = await loadState(deps.statePath);
  await saveState(deps.statePath, withTokenRefresh(state, (deps.now ?? (() => new Date()))().toISOString()));
}
