// `post`: reposts ONE random, not-yet-posted video from the old page to the new page,
// with the same caption (hashtags included) and the same cover image.
import { GraphApiError, type GraphClient } from "../graph";
import {
  createReelContainer,
  createResumableReelContainer,
  downloadVideo,
  getAccount,
  getContainerStatus,
  listAllMedia,
  publishContainer,
  waitForContainer,
  type Downloader,
  type IgMedia,
  type WaitOptions,
} from "../instagram";
import { errorMessage, type Logger } from "../log";
import { pickRandomUnposted, type Rng } from "../select";
import { loadState, saveState, withFailure, withPending, withPosted, type BotState } from "../state";

export interface PostDeps {
  oldClient: GraphClient;
  newClient: GraphClient;
  statePath: string;
  dryRun: boolean;
  maxAttempts: number;
  log: Logger;
  /** When set, the run aborts if a token belongs to a different account (catches swapped secrets). */
  expectedOldUsername?: string;
  expectedNewUsername?: string;
  rng?: Rng;
  now?: () => Date;
  wait?: WaitOptions;
  /** Fetches the old video's file. Only used for Facebook-token accounts. */
  download?: Downloader;
}

export class WrongAccountError extends Error {
  constructor(label: string, expected: string, actual: string) {
    super(`${label}_IG_TOKEN belongs to @${actual}, but ${label}_IG_USERNAME says @${expected}. Are the tokens swapped?`);
    this.name = "WrongAccountError";
  }
}

function checkExpectedUsername(label: string, expected: string | undefined, actual: string): void {
  if (!expected) return;
  const clean = (name: string) => name.trim().replace(/^@/, "").toLowerCase();
  if (clean(expected) !== clean(actual)) throw new WrongAccountError(label, clean(expected), actual);
}

export type PostOutcome =
  | { kind: "posted"; oldMediaId: string; newMediaId: string }
  | { kind: "recovered"; oldMediaId: string; newMediaId: string }
  | { kind: "dry-run"; oldMediaId: string }
  | { kind: "exhausted" };

export class PostFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostFailedError";
  }
}

/** Publishing may or may not have worked. The run stops and keeps the pending upload for the next run to settle. */
export class PublishUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishUncertainError";
  }
}

export class SameAccountError extends Error {
  constructor() {
    super("OLD_IG_TOKEN and NEW_IG_TOKEN belong to the same Instagram account. Refusing to repost onto itself.");
    this.name = "SameAccountError";
  }
}

export async function runPost(deps: PostDeps): Promise<PostOutcome> {
  const now = deps.now ?? (() => new Date());
  let state = await loadState(deps.statePath);

  const [oldAccount, newAccount] = await Promise.all([getAccount(deps.oldClient), getAccount(deps.newClient)]);
  if (oldAccount.user_id === newAccount.user_id) throw new SameAccountError();
  checkExpectedUsername("OLD", deps.expectedOldUsername, oldAccount.username);
  checkExpectedUsername("NEW", deps.expectedNewUsername, newAccount.username);
  deps.log(`Old page: @${oldAccount.username}  ->  New page: @${newAccount.username}`);

  const recovery = await resolvePending(deps, state, newAccount.user_id);
  state = recovery.state;
  if (recovery.outcome) return recovery.outcome;

  const library = await listAllMedia(deps.oldClient);
  const triedThisRun = new Set<string>();

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    const untried = library.filter((item) => !triedThisRun.has(item.id));
    const pick = pickRandomUnposted(untried, state, deps.rng);
    if (!pick) {
      if (attempt === 1) {
        deps.log("Nothing left to post: every available video from the old page is already on the new page.");
        return { kind: "exhausted" };
      }
      break;
    }

    triedThisRun.add(pick.id);
    deps.log(`Picked ${describe(pick)}`);
    if (deps.dryRun) {
      deps.log("DRY_RUN is on, so nothing was posted.");
      return { kind: "dry-run", oldMediaId: pick.id };
    }

    try {
      const result = await publishOne(deps, state, newAccount.user_id, pick, now);
      state = result.state;
      deps.log(`Posted. New post id ${result.newMediaId}.`);
      return { kind: "posted", oldMediaId: pick.id, newMediaId: result.newMediaId };
    } catch (error) {
      if (error instanceof PublishUncertainError) throw error; // pending upload stays saved on disk
      if (isAccountWideError(error)) {
        // Rate limits, outages and bad tokens are not this video's fault; don't count them against it.
        await persist(deps, withPending(state, null));
        throw error;
      }
      const reason = errorMessage(error);
      deps.log(`Attempt ${attempt} failed for ${pick.id}: ${reason}`);
      state = withFailure(state, pick.id, reason, now().toISOString());
      await saveState(deps.statePath, state);
    }
  }

  throw new PostFailedError(`Could not post any video after ${deps.maxAttempts} attempts. See the log above.`);
}

/**
 * A previous run may have crashed after creating (or even publishing) a video, before it saved
 * the result. Settle that first so the same video is never posted twice.
 */
async function resolvePending(
  deps: PostDeps,
  state: BotState,
  igUserId: string,
): Promise<{ state: BotState; outcome?: PostOutcome }> {
  const pending = state.pending;
  if (!pending) return { state };

  let code: string;
  try {
    code = (await getContainerStatus(deps.newClient, pending.containerId)).status_code;
  } catch (error) {
    // Unknown means it might be live. Keep it and stop; the next run asks again.
    throw new PublishUncertainError(
      `Could not check last run's unfinished upload (${errorMessage(error)}). Stopping so nothing is posted twice.`,
    );
  }

  if (code === "PUBLISHED") {
    deps.log(`Last run's video ${pending.oldMediaId} was in fact published. Recording it.`);
    const next = withPosted(state, pending.oldMediaId, { newMediaId: "unknown", postedAt: pending.createdAt });
    return { state: await persist(deps, next) };
  }

  if (code === "FINISHED" && !deps.dryRun) {
    deps.log(`Last run's video ${pending.oldMediaId} was processed but not published. Publishing it now.`);
    const newMediaId = await publishContainer(deps.newClient, igUserId, pending.containerId);
    const next = withPosted(state, pending.oldMediaId, {
      newMediaId,
      postedAt: (deps.now ?? (() => new Date()))().toISOString(),
    });
    return {
      state: await persist(deps, next),
      outcome: { kind: "recovered", oldMediaId: pending.oldMediaId, newMediaId },
    };
  }

  if (deps.dryRun) return { state };
  deps.log(`Last run's unfinished upload is ${code}. Dropping it.`);
  return { state: await persist(deps, withPending(state, null)) };
}

async function publishOne(
  deps: PostDeps,
  startState: BotState,
  igUserId: string,
  media: IgMedia,
  now: () => Date,
): Promise<{ state: BotState; newMediaId: string }> {
  let state = startState;
  const videoUrl = media.media_url;
  if (!videoUrl) throw new Error("Instagram did not provide this video's file.");

  // Facebook-token accounts upload the file themselves; Instagram-Login accounts hand Instagram the link.
  const uploadDirectly = deps.newClient.accountNode !== undefined;
  const videoBytes = uploadDirectly ? await (deps.download ?? downloadVideo)(videoUrl) : undefined;

  const prepare = async (coverUrl: string | undefined): Promise<string> => {
    let containerId: string;
    let uploadUri: string | undefined;
    if (videoBytes) {
      const container = await createResumableReelContainer(deps.newClient, igUserId, { caption: media.caption ?? "", coverUrl });
      containerId = container.id;
      uploadUri = container.uploadUri;
    } else {
      containerId = await createReelContainer(deps.newClient, igUserId, { videoUrl, caption: media.caption ?? "", coverUrl });
    }
    state = await persist(
      deps,
      withPending(state, { oldMediaId: media.id, containerId, createdAt: now().toISOString() }),
    );
    if (videoBytes && uploadUri) await deps.newClient.upload(uploadUri, videoBytes);
    await waitForContainer(deps.newClient, containerId, deps.wait);
    return containerId;
  };

  let containerId: string;
  try {
    containerId = await prepare(media.thumbnail_url);
  } catch (error) {
    // The original cover image is a nice-to-have. If Instagram rejects it, post with the first frame instead.
    if (!media.thumbnail_url) throw error;
    deps.log(`Upload with the original cover failed (${errorMessage(error)}). Retrying without a custom cover.`);
    containerId = await prepare(undefined);
  }

  const newMediaId = await publishSafely(deps, igUserId, containerId);
  state = await persist(deps, withPosted(state, media.id, { newMediaId, postedAt: now().toISOString() }));
  return { state, newMediaId };
}

/**
 * If publishing errors, the video may still have gone live (for example the reply was lost).
 * Ask Instagram before calling it a failure, so the video is never posted a second time.
 */
async function publishSafely(deps: PostDeps, igUserId: string, containerId: string): Promise<string> {
  try {
    return await publishContainer(deps.newClient, igUserId, containerId);
  } catch (publishError) {
    let code: string;
    try {
      code = (await getContainerStatus(deps.newClient, containerId)).status_code;
    } catch {
      throw new PublishUncertainError(
        `Publishing failed (${errorMessage(publishError)}) and Instagram could not confirm whether the video went live. The next run will check again.`,
      );
    }
    if (code === "PUBLISHED") {
      deps.log("Publishing reported an error, but Instagram shows the video is live. Recording it as posted.");
      return "unknown";
    }
    throw publishError;
  }
}

/** Graph API codes for rate limits (4, 17, 32, 613), permissions (10, 200) and invalid tokens (190). */
const ACCOUNT_WIDE_CODES = new Set([4, 10, 17, 32, 190, 200, 613]);

function isAccountWideError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  return error.isTransient || (error.code !== undefined && ACCOUNT_WIDE_CODES.has(error.code));
}

async function persist(deps: PostDeps, state: BotState): Promise<BotState> {
  await saveState(deps.statePath, state);
  return state;
}

function describe(media: IgMedia): string {
  const caption = (media.caption ?? "").replace(/\s+/g, " ").slice(0, 60);
  return `${media.id} from ${media.timestamp.slice(0, 10)}${media.permalink ? ` (${media.permalink})` : ""} "${caption}"`;
}
