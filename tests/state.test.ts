import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyState,
  loadState,
  parseState,
  saveState,
  StateFileError,
  withFailure,
  withPending,
  withPosted,
  withTokenRefresh,
} from "../src/state";
import { tempStatePath } from "./fakes";

describe("state file", () => {
  it("starts empty when no file exists yet", async () => {
    await expect(loadState(await tempStatePath())).resolves.toEqual(emptyState());
  });

  it("round-trips through disk", async () => {
    const path = await tempStatePath();
    const state = withPosted(emptyState(), "old1", { newMediaId: "new1", postedAt: "2026-11-17T04:30:00Z" });

    await saveState(path, state);

    await expect(loadState(path)).resolves.toEqual(state);
  });

  it("refuses a corrupted file instead of starting over", async () => {
    const path = await tempStatePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");

    await expect(loadState(path)).rejects.toBeInstanceOf(StateFileError);
    expect(() => parseState('{"version":2,"posted":{},"failures":{}}')).toThrow(StateFileError);
    expect(() => parseState('{"version":1,"posted":{},"failures":{},"pending":"x"}')).toThrow(StateFileError);
  });

  it("fills defaults for optional fields", () => {
    expect(parseState('{"version":1,"posted":{},"failures":{}}')).toEqual(emptyState());
  });
});

describe("state updates", () => {
  it("withPosted records the post and clears its failure and the pending upload without mutating", () => {
    const failed = withFailure(emptyState(), "old1", "timeout", "t1");
    const pending = withPending(failed, { oldMediaId: "old1", containerId: "c1", createdAt: "t2" });

    const next = withPosted(pending, "old1", { newMediaId: "new1", postedAt: "t3" });

    expect(next.posted.old1).toEqual({ newMediaId: "new1", postedAt: "t3" });
    expect(next.failures.old1).toBeUndefined();
    expect(next.pending).toBeNull();
    expect(pending.posted.old1).toBeUndefined();
    expect(pending.failures.old1).toBeDefined();
  });

  it("withFailure counts repeated failures", () => {
    const once = withFailure(emptyState(), "old1", "first", "t1");
    const twice = withFailure(once, "old1", "second", "t2");

    expect(twice.failures.old1).toEqual({ count: 2, lastReason: "second", lastAt: "t2" });
    expect(once.failures.old1?.count).toBe(1);
  });

  it("withTokenRefresh stores the time", () => {
    expect(withTokenRefresh(emptyState(), "t9").lastTokenRefreshAt).toBe("t9");
  });
});
