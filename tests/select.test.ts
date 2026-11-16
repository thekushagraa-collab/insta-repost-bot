import { describe, expect, it } from "vitest";
import { isRepostable, pickRandomUnposted, remainingCandidates, summarizeLibrary } from "../src/select";
import { emptyState, withFailure, withPosted } from "../src/state";
import { video } from "./fakes";

const photo = { ...video("p1"), media_type: "IMAGE" };
const musicVideo = video("m1", { media_url: undefined });

describe("isRepostable", () => {
  it("accepts videos with a file and rejects photos and withheld videos", () => {
    expect(isRepostable(video("v1"))).toBe(true);
    expect(isRepostable(photo)).toBe(false);
    expect(isRepostable(musicVideo)).toBe(false);
    expect(isRepostable(video("v2", { media_url: "" }))).toBe(false);
  });
});

describe("pickRandomUnposted", () => {
  const library = [video("v1"), photo, video("v2"), musicVideo, video("v3")];

  it("skips posted videos and videos that failed 3 times", () => {
    let state = withPosted(emptyState(), "v1", { newMediaId: "n1", postedAt: "t" });
    for (let i = 0; i < 3; i += 1) state = withFailure(state, "v2", "bad", "t");

    expect(remainingCandidates(library, state).map((m) => m.id)).toEqual(["v3"]);
  });

  it("keeps trying a video that failed fewer than 3 times", () => {
    const state = withFailure(emptyState(), "v2", "bad", "t");
    expect(remainingCandidates(library, state).map((m) => m.id)).toEqual(["v1", "v2", "v3"]);
  });

  it("uses the random number to choose", () => {
    expect(pickRandomUnposted(library, emptyState(), () => 0)?.id).toBe("v1");
    expect(pickRandomUnposted(library, emptyState(), () => 0.5)?.id).toBe("v2");
    expect(pickRandomUnposted(library, emptyState(), () => 0.9999)?.id).toBe("v3");
    expect(pickRandomUnposted(library, emptyState(), () => 1)?.id).toBe("v3");
  });

  it("returns null when everything is posted", () => {
    expect(pickRandomUnposted([photo, musicVideo], emptyState())).toBeNull();
  });
});

describe("summarizeLibrary", () => {
  it("counts posted, remaining, withheld and abandoned videos", () => {
    let state = withPosted(emptyState(), "v1", { newMediaId: "n1", postedAt: "t" });
    for (let i = 0; i < 3; i += 1) state = withFailure(state, "v2", "bad", "t");

    const summary = summarizeLibrary([video("v1"), photo, video("v2"), musicVideo, video("v3")], state);

    expect(summary).toMatchObject({ totalPosts: 5, videos: 4, posted: 1, remaining: 1 });
    expect(summary.blocked.map((m) => m.id)).toEqual(["m1"]);
    expect(summary.givenUp.map((m) => m.id)).toEqual(["v2"]);
  });
});
