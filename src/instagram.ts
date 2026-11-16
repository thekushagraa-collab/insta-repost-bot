// Instagram calls the bot needs: read an account's videos, publish a Reel, refresh a token.
import type { GraphClient, Sleep } from "./graph";
import { realSleep } from "./graph";

export interface IgAccount {
  user_id: string;
  username: string;
  account_type?: string;
  media_count?: number;
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  /** Missing when the video has licensed audio (Instagram music library) or a copyright flag. */
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  permalink?: string;
}

export interface ContainerStatus {
  status_code: "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED" | string;
  status?: string;
}

export interface ReelInput {
  videoUrl: string;
  caption: string;
  coverUrl?: string;
}

export interface WaitOptions {
  intervalMs: number;
  timeoutMs: number;
  sleep?: Sleep;
  now?: () => number;
}

export const DEFAULT_WAIT: WaitOptions = { intervalMs: 15_000, timeoutMs: 15 * 60_000 };

const MEDIA_FIELDS = "id,caption,media_type,media_product_type,media_url,thumbnail_url,timestamp,permalink";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export class ContainerFailedError extends Error {
  constructor(message: string, readonly statusCode: string) {
    super(message);
    this.name = "ContainerFailedError";
  }
}

export async function getAccount(client: GraphClient): Promise<IgAccount> {
  return client.get<IgAccount>("me", { params: { fields: "user_id,username,account_type,media_count" } });
}

interface MediaPage {
  data: IgMedia[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Every post on the account behind the client's token, newest first. */
export async function listAllMedia(client: GraphClient): Promise<IgMedia[]> {
  const collected: IgMedia[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.get<MediaPage>("me/media", {
      params: { fields: MEDIA_FIELDS, limit: PAGE_SIZE, after },
    });
    collected.push(...result.data);
    after = result.paging?.cursors?.after;
    if (!result.paging?.next || !after) return collected;
  }
  return collected;
}

export async function createReelContainer(client: GraphClient, igUserId: string, input: ReelInput): Promise<string> {
  const body: Record<string, unknown> = {
    media_type: "REELS",
    video_url: input.videoUrl,
    caption: input.caption,
    share_to_feed: true,
  };
  if (input.coverUrl) body.cover_url = input.coverUrl;
  const result = await client.post<{ id: string }>(`${igUserId}/media`, { body });
  return result.id;
}

export async function getContainerStatus(client: GraphClient, containerId: string): Promise<ContainerStatus> {
  return client.get<ContainerStatus>(containerId, { params: { fields: "status_code,status" } });
}

/** Polls until Instagram has processed the video. Throws ContainerFailedError on ERROR, EXPIRED or timeout. */
export async function waitForContainer(
  client: GraphClient,
  containerId: string,
  options: WaitOptions = DEFAULT_WAIT,
): Promise<void> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const { status_code: code, status } = await getContainerStatus(client, containerId);
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED" || code === "PUBLISHED") {
      throw new ContainerFailedError(`Video processing ended with ${code}${status ? `: ${status}` : ""}`, code);
    }
    if (now() >= deadline) {
      throw new ContainerFailedError(`Video was still processing after ${options.timeoutMs / 60_000} minutes`, "TIMEOUT");
    }
    await sleep(options.intervalMs);
  }
}

export async function publishContainer(client: GraphClient, igUserId: string, containerId: string): Promise<string> {
  // Never retried automatically: a lost reply may hide a successful publish. The caller checks the container instead.
  const result = await client.post<{ id: string }>(`${igUserId}/media_publish`, {
    body: { creation_id: containerId },
    retry: false,
  });
  return result.id;
}

export interface PublishingLimit {
  quota_usage: number;
  config?: { quota_total?: number; quota_duration?: number };
}

export async function getPublishingLimit(client: GraphClient, igUserId: string): Promise<PublishingLimit | undefined> {
  const result = await client.get<{ data: PublishingLimit[] }>(`${igUserId}/content_publishing_limit`, {
    params: { fields: "quota_usage,config" },
  });
  return result.data[0];
}

export interface RefreshedToken {
  access_token: string;
  expires_in: number;
}

/** Extends a long-lived token by 60 days. The token must be at least 24 hours old and still valid. */
export async function refreshToken(client: GraphClient): Promise<RefreshedToken> {
  return client.get<RefreshedToken>("refresh_access_token", {
    params: { grant_type: "ig_refresh_token" },
    versioned: false,
    tokenInQuery: true,
  });
}
