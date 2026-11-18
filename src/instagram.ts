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

function accountNode(client: GraphClient): string {
  return client.accountNode ?? "me";
}

export async function getAccount(client: GraphClient): Promise<IgAccount> {
  const node = accountNode(client);
  if (node === "me") {
    return client.get<IgAccount>("me", { params: { fields: "user_id,username,account_type,media_count" } });
  }
  // graph.facebook.com names the id field "id" and has no account_type (only professional accounts are reachable there).
  const result = await client.get<{ id: string; username: string; media_count?: number }>(node, {
    params: { fields: "id,username,media_count" },
  });
  return { user_id: result.id, username: result.username, media_count: result.media_count };
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
    const result = await client.get<MediaPage>(`${accountNode(client)}/media`, {
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

/** Permanently deletes one post. Needs the instagram_manage_contents permission on a Facebook-issued token. */
export async function deleteMedia(client: GraphClient, mediaId: string): Promise<void> {
  const result = await client.delete<{ success?: boolean }>(mediaId);
  if (result.success === false) throw new Error("Instagram reported that the delete did not succeed.");
}

export interface ResumableContainer {
  id: string;
  uploadUri: string;
}

/**
 * Facebook-token accounts: create a Reel container that waits for the video bytes.
 * Instagram's servers often cannot fetch another Instagram CDN link (error 2207076), so we upload the file ourselves.
 */
export async function createResumableReelContainer(
  client: GraphClient,
  igUserId: string,
  input: { caption: string; coverUrl?: string },
): Promise<ResumableContainer> {
  const body: Record<string, unknown> = {
    media_type: "REELS",
    upload_type: "resumable",
    caption: input.caption,
    share_to_feed: true,
  };
  if (input.coverUrl) body.cover_url = input.coverUrl;
  const result = await client.post<{ id: string; uri?: string }>(`${igUserId}/media`, { body });
  if (!result.uri) throw new Error("Instagram did not return an upload address for the video.");
  return { id: result.id, uploadUri: result.uri };
}

export type Downloader = (url: string) => Promise<Uint8Array>;

/** Downloads a video file. The old page's CDN links need no login. */
export const downloadVideo: Downloader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the old video (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("The old video file was empty.");
  return bytes;
};

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
