import { describe, expect, it } from "vitest";
import {
  ContainerFailedError,
  createReelContainer,
  getPublishingLimit,
  listAllMedia,
  refreshToken,
  waitForContainer,
} from "../src/instagram";
import { fakeClient, noSleep, video } from "./fakes";

describe("listAllMedia", () => {
  it("follows the paging cursor until there is no next page", async () => {
    const client = fakeClient({
      "GET me/media": (options, call) =>
        call === 1
          ? { data: [video("a"), video("b")], paging: { cursors: { after: "CUR1" }, next: "https://next" } }
          : { data: [video("c")], paging: { cursors: { after: "CUR2" } } },
    });

    const media = await listAllMedia(client);

    expect(media.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(client.calls[0]?.options.params?.after).toBeUndefined();
    expect(client.calls[1]?.options.params?.after).toBe("CUR1");
    expect(client.calls[0]?.options.params?.fields).toContain("media_url");
  });
});

describe("createReelContainer", () => {
  it("sends a Reel with caption and cover", async () => {
    const client = fakeClient({ "POST 42/media": () => ({ id: "c1" }) });

    await expect(createReelContainer(client, "42", { videoUrl: "v.mp4", caption: "hi #x", coverUrl: "c.jpg" })).resolves.toBe("c1");
    expect(client.calls[0]?.options.body).toEqual({
      media_type: "REELS",
      video_url: "v.mp4",
      caption: "hi #x",
      share_to_feed: true,
      cover_url: "c.jpg",
    });
  });

  it("leaves cover_url out when there is no cover", async () => {
    const client = fakeClient({ "POST 42/media": () => ({ id: "c1" }) });
    await createReelContainer(client, "42", { videoUrl: "v.mp4", caption: "" });
    expect(client.calls[0]?.options.body).not.toHaveProperty("cover_url");
  });
});

describe("waitForContainer", () => {
  it("polls until FINISHED", async () => {
    const client = fakeClient({ "GET c1": (_o, call) => ({ status_code: call < 3 ? "IN_PROGRESS" : "FINISHED" }) });
    await waitForContainer(client, "c1", { intervalMs: 1, timeoutMs: 1000, sleep: noSleep });
    expect(client.calls).toHaveLength(3);
  });

  it("fails on ERROR with Instagram's reason", async () => {
    const client = fakeClient({ "GET c1": () => ({ status_code: "ERROR", status: "Unsupported format" }) });
    const error = await waitForContainer(client, "c1", { intervalMs: 1, timeoutMs: 1000, sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerFailedError);
    expect((error as ContainerFailedError).message).toContain("Unsupported format");
  });

  it("times out", async () => {
    let clock = 0;
    const client = fakeClient({ "GET c1": () => ({ status_code: "IN_PROGRESS" }) });
    const sleep = async (ms: number) => {
      clock += ms;
    };
    await expect(
      waitForContainer(client, "c1", { intervalMs: 60_000, timeoutMs: 180_000, sleep, now: () => clock }),
    ).rejects.toThrow("still processing after 3 minutes");
  });
});

describe("small calls", () => {
  it("reads the publishing limit", async () => {
    const client = fakeClient({ "GET 42/content_publishing_limit": () => ({ data: [{ quota_usage: 2 }] }) });
    await expect(getPublishingLimit(client, "42")).resolves.toEqual({ quota_usage: 2 });
  });

  it("refreshes a token through the unversioned endpoint", async () => {
    const client = fakeClient({ "GET refresh_access_token": () => ({ access_token: "t2", expires_in: 5_184_000 }) });
    await expect(refreshToken(client)).resolves.toEqual({ access_token: "t2", expires_in: 5_184_000 });
    expect(client.calls[0]?.options).toMatchObject({ versioned: false, tokenInQuery: true });
  });
});
