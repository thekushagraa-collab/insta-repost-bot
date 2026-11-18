import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphClient, RequestOptions } from "../src/graph";
import type { IgMedia } from "../src/instagram";

export interface RecordedCall {
  method: "GET" | "POST" | "DELETE";
  path: string;
  options: RequestOptions;
}

type Handler = (options: RequestOptions, call: number) => unknown;

/** A GraphClient whose answers come from a table of "METHOD path" handlers. */
export function fakeClient(routes: Record<string, Handler>): GraphClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const counts = new Map<string, number>();
  const handle = async (method: "GET" | "POST" | "DELETE", path: string, options: RequestOptions = {}) => {
    calls.push({ method, path, options });
    const key = `${method} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected call ${key}`);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return handler(options, count);
  };
  return {
    calls,
    upload: async (uploadUri: string, data: Uint8Array) => {
      await handle("POST", `UPLOAD ${uploadUri}`, { body: { bytes: data.byteLength } });
    },
    get: <T>(path: string, options?: RequestOptions) => handle("GET", path, options) as Promise<T>,
    post: <T>(path: string, options?: RequestOptions) => handle("POST", path, options) as Promise<T>,
    delete: <T>(path: string, options?: RequestOptions) => handle("DELETE", path, options) as Promise<T>,
  };
}

export function video(id: string, extra: Partial<IgMedia> = {}): IgMedia {
  return {
    id,
    media_type: "VIDEO",
    media_product_type: "REELS",
    caption: `caption ${id} #tag`,
    media_url: `https://cdn.example/${id}.mp4`,
    thumbnail_url: `https://cdn.example/${id}.jpg`,
    timestamp: "2024-01-01T00:00:00+0000",
    permalink: `https://instagram.com/reel/${id}`,
    ...extra,
  };
}

export async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "insta-bot-"));
  return join(dir, "state", "state.json");
}

export const silentLog = (): void => undefined;
export const noSleep = async (): Promise<void> => undefined;
