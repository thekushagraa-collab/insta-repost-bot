import { describe, expect, it } from "vitest";
import {
  runPost,
  PostFailedError,
  PublishUncertainError,
  SameAccountError,
  WrongAccountError,
  type PostDeps,
} from "../src/commands/post";
import { GraphApiError } from "../src/graph";
import { loadState, saveState, emptyState, withPending, withPosted } from "../src/state";
import { fakeClient, noSleep, silentLog, tempStatePath, video } from "./fakes";

const WAIT = { intervalMs: 1, timeoutMs: 1000, sleep: noSleep };
const NOW = () => new Date("2026-11-17T04:30:00Z");

function oldPage(media = [video("v1"), video("v2")]) {
  return fakeClient({
    "GET me": () => ({ user_id: "OLD", username: "oldpage" }),
    "GET me/media": () => ({ data: media }),
  });
}

function newPage(overrides: Record<string, (options: any, call: number) => unknown> = {}) {
  return fakeClient({
    "GET me": () => ({ user_id: "NEW", username: "newpage" }),
    "POST NEW/media": (_o, call) => ({ id: `c${call}` }),
    "GET c1": () => ({ status_code: "FINISHED" }),
    "GET c2": () => ({ status_code: "FINISHED" }),
    "GET c3": () => ({ status_code: "FINISHED" }),
    "POST NEW/media_publish": () => ({ id: "NEWPOST" }),
    ...overrides,
  });
}

async function deps(partial: Partial<PostDeps> = {}): Promise<PostDeps> {
  return {
    oldClient: oldPage(),
    newClient: newPage(),
    statePath: await tempStatePath(),
    dryRun: false,
    maxAttempts: 3,
    log: silentLog,
    rng: () => 0,
    now: NOW,
    wait: WAIT,
    ...partial,
  };
}

describe("runPost with a Facebook-issued token (uploads the file itself)", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  function facebookNewPage(overrides: Record<string, (options: any, call: number) => unknown> = {}) {
    const base = newPage({
      "GET NEW": () => ({ id: "NEW", username: "newpage" }),
      "POST NEW/media": (_o, call) => ({ id: `c${call}`, uri: "https://rupload.facebook.com/ig-api-upload/v24.0/c1" }),
      "POST UPLOAD https://rupload.facebook.com/ig-api-upload/v24.0/c1": () => ({ success: true }),
      ...overrides,
    });
    return Object.assign(base, { accountNode: "NEW" });
  }

  it("downloads the video, creates a resumable container, uploads the bytes, then publishes", async () => {
    const downloaded: string[] = [];
    const newClient = facebookNewPage();
    const d = await deps({
      newClient,
      download: async (url) => {
        downloaded.push(url);
        return bytes;
      },
    });

    await expect(runPost(d)).resolves.toEqual({ kind: "posted", oldMediaId: "v1", newMediaId: "NEWPOST" });

    expect(downloaded).toEqual(["https://cdn.example/v1.mp4"]);
    const create = newClient.calls.find((c) => c.path === "NEW/media");
    expect(create?.options.body).toMatchObject({ upload_type: "resumable", media_type: "REELS", caption: "caption v1 #tag" });
    expect(create?.options.body).not.toHaveProperty("video_url");
    const upload = newClient.calls.find((c) => c.path.startsWith("UPLOAD "));
    expect(upload?.options.body).toEqual({ bytes: 4 });
    expect(newClient.calls.map((c) => c.path)).toEqual([
      "NEW",
      "NEW/media",
      "UPLOAD https://rupload.facebook.com/ig-api-upload/v24.0/c1",
      "c1",
      "NEW/media_publish",
    ]);
  });

  it("records a failure and tries another video when the download fails", async () => {
    let calls = 0;
    const d = await deps({
      newClient: facebookNewPage(),
      download: async () => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 403");
        return bytes;
      },
    });

    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted", oldMediaId: "v2" });
    expect((await loadState(d.statePath)).failures.v1?.lastReason).toContain("HTTP 403");
  });
});

describe("one post per slot", () => {
  it("does nothing a second time in the same slot", async () => {
    const d = await deps();
    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted" });
    await expect(runPost(d)).resolves.toEqual({ kind: "already-posted" });
  });

  it("posts again in the next slot", async () => {
    const d = await deps();
    await runPost(d);
    await expect(runPost({ ...d, now: () => new Date("2026-11-17T13:30:00Z") })).resolves.toMatchObject({ kind: "posted" });
  });

  it("treats the small hours as part of the previous evening's slot", async () => {
    const d = await deps({ now: () => new Date("2026-11-17T14:00:00Z") });
    await runPost(d);
    await expect(runPost({ ...d, now: () => new Date("2026-11-17T22:00:00Z") })).resolves.toEqual({ kind: "already-posted" });
  });
});

describe("runPost", () => {
  it("reposts one video with its caption and cover and remembers it", async () => {
    const d = await deps();

    const outcome = await runPost(d);

    expect(outcome).toEqual({ kind: "posted", oldMediaId: "v1", newMediaId: "NEWPOST" });
    const newClient = d.newClient as ReturnType<typeof newPage>;
    const create = newClient.calls.find((c) => c.path === "NEW/media");
    expect(create?.options.body).toMatchObject({
      video_url: "https://cdn.example/v1.mp4",
      caption: "caption v1 #tag",
      cover_url: "https://cdn.example/v1.jpg",
    });
    const state = await loadState(d.statePath);
    expect(state.posted.v1).toEqual({ newMediaId: "NEWPOST", postedAt: "2026-11-17T04:30:00.000Z" });
    expect(state.pending).toBeNull();
  });

  it("never picks a video that was already posted", async () => {
    const d = await deps();
    await saveState(d.statePath, withPosted(emptyState(), "v1", { newMediaId: "x", postedAt: "t" }));

    await expect(runPost(d)).resolves.toMatchObject({ oldMediaId: "v2" });
  });

  it("does nothing in dry-run mode", async () => {
    const d = await deps({ dryRun: true });

    await expect(runPost(d)).resolves.toEqual({ kind: "dry-run", oldMediaId: "v1" });
    const newClient = d.newClient as ReturnType<typeof newPage>;
    expect(newClient.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports when everything has been posted", async () => {
    const d = await deps({ oldClient: oldPage([video("m1", { media_url: undefined })]) });
    await expect(runPost(d)).resolves.toEqual({ kind: "exhausted" });
  });

  it("retries without the cover when the cover is rejected", async () => {
    const d = await deps({ newClient: newPage({ "GET c1": () => ({ status_code: "ERROR", status: "bad cover" }) }) });

    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted", oldMediaId: "v1" });
    const newClient = d.newClient as ReturnType<typeof newPage>;
    const creates = newClient.calls.filter((c) => c.path === "NEW/media");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.options.body).not.toHaveProperty("cover_url");
  });

  it("moves to another video when one keeps failing, and records the failure", async () => {
    const d = await deps({
      newClient: newPage({
        "GET c1": () => ({ status_code: "ERROR" }),
        "GET c2": () => ({ status_code: "ERROR" }),
      }),
      rng: () => 0,
    });

    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted", oldMediaId: "v2" });
    const state = await loadState(d.statePath);
    expect(state.failures.v1?.count).toBe(1);
    expect(state.posted.v2).toBeDefined();
  });

  it("fails loudly after the attempt limit", async () => {
    const d = await deps({
      maxAttempts: 2,
      newClient: newPage({ "POST NEW/media": () => Promise.reject(new Error("rejected")) }),
    });

    await expect(runPost(d)).rejects.toBeInstanceOf(PostFailedError);
    const state = await loadState(d.statePath);
    const totalFailures = Object.values(state.failures).reduce((sum, f) => sum + f.count, 0);
    expect(totalFailures).toBe(2);
  });

  it("refuses to run when both tokens are the same account", async () => {
    const d = await deps({ newClient: oldPage() });
    await expect(runPost(d)).rejects.toBeInstanceOf(SameAccountError);
  });

  it("records a video that last run published before crashing, then posts today's", async () => {
    const d = await deps({ newClient: newPage({ "GET c9": () => ({ status_code: "PUBLISHED" }) }) });
    await saveState(d.statePath, withPending(emptyState(), { oldMediaId: "v1", containerId: "c9", createdAt: "t0" }));

    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted", oldMediaId: "v2" });
    const state = await loadState(d.statePath);
    expect(state.posted.v1).toEqual({ newMediaId: "unknown", postedAt: "t0" });
  });

  it("publishes a video that last run processed but never published", async () => {
    const d = await deps({ newClient: newPage({ "GET c9": () => ({ status_code: "FINISHED" }) }) });
    await saveState(d.statePath, withPending(emptyState(), { oldMediaId: "v2", containerId: "c9", createdAt: "t0" }));

    await expect(runPost(d)).resolves.toEqual({ kind: "recovered", oldMediaId: "v2", newMediaId: "NEWPOST" });
  });

  it("drops a dead pending upload and carries on", async () => {
    const d = await deps({ newClient: newPage({ "GET c9": () => ({ status_code: "EXPIRED" }) }) });
    await saveState(d.statePath, withPending(emptyState(), { oldMediaId: "v2", containerId: "c9", createdAt: "t0" }));

    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted", oldMediaId: "v1" });
  });

  it("records the video as posted when publish errors but Instagram shows it live", async () => {
    const d = await deps({
      newClient: newPage({
        "POST NEW/media_publish": () => Promise.reject(new Error("socket hang up")),
        "GET c1": (_o, call) => ({ status_code: call === 1 ? "FINISHED" : "PUBLISHED" }),
      }),
    });

    await expect(runPost(d)).resolves.toEqual({ kind: "posted", oldMediaId: "v1", newMediaId: "unknown" });
    expect((await loadState(d.statePath)).posted.v1?.newMediaId).toBe("unknown");
  });

  it("stops and keeps the pending upload when it cannot tell whether publish worked", async () => {
    const d = await deps({
      newClient: newPage({
        "POST NEW/media_publish": () => Promise.reject(new Error("socket hang up")),
        "GET c1": (_o, call) => (call === 1 ? { status_code: "FINISHED" } : Promise.reject(new Error("offline"))),
      }),
    });

    await expect(runPost(d)).rejects.toBeInstanceOf(PublishUncertainError);
    const state = await loadState(d.statePath);
    expect(state.pending).toMatchObject({ oldMediaId: "v1", containerId: "c1" });
    expect(state.failures.v1).toBeUndefined();
  });

  it("treats a publish error as a failure when the video is not live", async () => {
    const d = await deps({
      maxAttempts: 1,
      newClient: newPage({ "POST NEW/media_publish": () => Promise.reject(new Error("limit reached")) }),
    });

    await expect(runPost(d)).rejects.toBeInstanceOf(PostFailedError);
    expect((await loadState(d.statePath)).failures.v1?.lastReason).toBe("limit reached");
  });

  it("stops and keeps a pending upload it cannot check", async () => {
    const d = await deps({ newClient: newPage({ "GET c9": () => Promise.reject(new Error("gone")) }) });
    await saveState(d.statePath, withPending(emptyState(), { oldMediaId: "v2", containerId: "c9", createdAt: "t0" }));

    await expect(runPost(d)).rejects.toBeInstanceOf(PublishUncertainError);
    expect((await loadState(d.statePath)).pending?.containerId).toBe("c9");
  });

  it("does not blame the video for a rate limit or outage", async () => {
    const d = await deps({
      newClient: newPage({
        "POST NEW/media": () => Promise.reject(new GraphApiError("rate limited", 400, 4)),
      }),
    });

    await expect(runPost(d)).rejects.toThrow("rate limited");
    const state = await loadState(d.statePath);
    expect(state.failures).toEqual({});
    expect(state.pending).toBeNull();
  });

  it("aborts when a token belongs to a different account than expected", async () => {
    const d = await deps({ expectedOldUsername: "@OldPage", expectedNewUsername: "someoneelse" });
    await expect(runPost(d)).rejects.toBeInstanceOf(WrongAccountError);
  });

  it("accepts the expected usernames in any case and with @", async () => {
    const d = await deps({ expectedOldUsername: "@OldPage", expectedNewUsername: "NEWPAGE" });
    await expect(runPost(d)).resolves.toMatchObject({ kind: "posted" });
  });
});
