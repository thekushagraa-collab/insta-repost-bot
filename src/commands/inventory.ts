// `inventory`: counts the old page's videos and lists the ones Instagram will not hand over.
import type { GraphClient } from "../graph";
import { listAllMedia } from "../instagram";
import type { Logger } from "../log";
import { summarizeLibrary, type LibrarySummary } from "../select";
import { loadState } from "../state";

export const POSTS_PER_DAY = 2;

export interface InventoryDeps {
  oldClient: GraphClient;
  statePath: string;
  log: Logger;
}

export async function runInventory(deps: InventoryDeps): Promise<LibrarySummary> {
  const [media, state] = await Promise.all([listAllMedia(deps.oldClient), loadState(deps.statePath)]);
  const summary = summarizeLibrary(media, state);

  deps.log(`Old page: ${summary.totalPosts} posts, ${summary.videos} of them videos.`);
  deps.log(`Already reposted: ${summary.posted}. Still to post: ${summary.remaining}.`);
  deps.log(`At ${POSTS_PER_DAY} a day that lasts about ${Math.ceil(summary.remaining / POSTS_PER_DAY)} more days.`);

  if (summary.blocked.length > 0) {
    deps.log(
      `${summary.blocked.length} videos cannot be reposted automatically (Instagram withholds the file, usually because of licensed music):`,
    );
    for (const item of summary.blocked) deps.log(`  - ${item.permalink ?? item.id}`);
  }
  if (summary.givenUp.length > 0) {
    deps.log(`${summary.givenUp.length} videos failed 3 times and are skipped:`);
    for (const item of summary.givenUp) deps.log(`  - ${item.permalink ?? item.id}: ${state.failures[item.id]?.lastReason}`);
  }
  return summary;
}
