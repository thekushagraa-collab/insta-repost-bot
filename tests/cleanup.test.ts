import { describe, expect, it } from "vitest";
import { CleanupFailedError, runCleanup, type CleanupDeps } from "../src/commands/cleanup";
import { GraphApiError } from "../src/graph";
import { pickMediaToDelete } from "../src/select";
import { emptyState, loadState, saveState, withPosted } from "../src/state";
import { fakeClient, silentLog, tempStatePath, video } from "./fakes";

const BOT_FIRST_POST = "2026-11-18T13:56:11.000Z";

/** Previous owner's videos, oldest first by id number, plus the bot's own repost. */
const OLD = (n: number) => video(`old${n}`, { timestamp: `2025-0${n}-01T00:00:00+0000` });
const OURS = video("ours1", { timestamp: "2026-11-18T13:56:20+0000" });

function stateWithOnePost() {
  return withPosted(emptyState(), "src1", { newMediaId: "ours1", postedAt: BOT_FIRST_POST });
}

function page(media = [OURS, OLD(3), OLD(1), OLD(2), OLD(4)], overrides: Record<string, (o: any, c: number) => unknown> = {}) {
  const base = fakeClient({
    "GET NEW": () => ({ id: "NEW", username: "tips_4ryou" }),
    "GET NEW/media": () => ({ data: media }),
    "DELETE old1": () => ({ success: true }),
    "DELETE old2": () => ({ success: true }),
    "DELETE old3": () => ({ success: true }),
    "DELETE old4": () => ({ success: true }),
    ...overrides,
  });
  return Object.assign(base, { accountNode: "NEW" });
}

async function deps(partial: Partial<CleanupDeps> = {}): Promise<CleanupDeps> {
  const statePath = await tempStatePath();
  await saveState(statePath, stateWithOnePost());
  return { newClient: page(), statePath, dryRun: false, log: silentLog, now: () => new Date("2026-11-19T07:30:00Z"), ...partial };
}

describe("pickMediaToDelete", () => {
  it("picks the oldest previous-owner videos and never the bot's own", () => {
    const picks = pickMediaToDelete([OURS, OLD(3), OLD(1), OLD(2), OLD(4)], stateWithOnePost(), 3);
    expect(picks.map((m) => m.id)).toEqual(["old1", "old2", "old3"]);
  });

  it("returns nothing until the bot has posted", () => {
    expect(pickMediaToDelete([OLD(1)], emptyState(), 3)).toEqual([]);
  });

  it("skips photos, already deleted posts, and posts made after the bot started", () => {
    const photo = { ...OLD(1), id: "photo", media_type: "IMAGE" };
    const later = video("later", { timestamp: "2026-11-18T14:30:00+0000" });
    const state = { ...stateWithOnePost(), deleted: { old2: { deletedAt: "x" } } };
    expect(pickMediaToDelete([photo, later, OLD(2), OLD(3)], state, 3).map((m) => m.id)).toEqual(["old3"]);
  });

  it("keeps a margin before the first repost so nothing near it is touched", () => {
    const justBefore = video("near", { timestamp: "2026-11-18T13:30:00+0000" });
    expect(pickMediaToDelete([justBefore], stateWithOnePost(), 3)).toEqual([]);
  });
});

describe("runCleanup", () => {
  it("deletes the 3 oldest previous-owner videos and remembers them", async () => {
    const d = await deps();
    const client = d.newClient as ReturnType<typeof page>;

    await expect(runCleanup(d)).resolves.toEqual({ kind: "deleted", ids: ["old1", "old2", "old3"] });

    expect(client.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["old1", "old2", "old3"]);
    const state = await loadState(d.statePath);
    expect(Object.keys(state.deleted)).toEqual(["old1", "old2", "old3"]);
    expect(state.deleted.old1?.deletedAt).toBe("2026-11-19T07:30:00.000Z");
  });

  it("never deletes anything in dry-run mode", async () => {
    const d = await deps({ dryRun: true });
    await expect(runCleanup(d)).resolves.toEqual({ kind: "dry-run", ids: ["old1", "old2", "old3"] });
    const client = d.newClient as ReturnType<typeof page>;
    expect(client.calls.some((c) => c.path.startsWith("old"))).toBe(false);
    expect((await loadState(d.statePath)).deleted).toEqual({});
  });

  it("refuses when the bot has not posted yet", async () => {
    const statePath = await tempStatePath();
    const outcome = await runCleanup({ newClient: page(), statePath, dryRun: false, log: silentLog });
    expect(outcome.kind).toBe("refused");
  });

  it("refuses when the bot's own reposts are not on this account", async () => {
    const d = await deps({ newClient: page([OLD(1), OLD(2)]) });
    await expect(runCleanup(d)).resolves.toMatchObject({ kind: "refused" });
    const client = d.newClient as ReturnType<typeof page>;
    expect(client.calls.some((c) => c.path.startsWith("old"))).toBe(false);
  });

  it("aborts when the token belongs to a different username than expected", async () => {
    const d = await deps({ expectedNewUsername: "someoneelse" });
    await expect(runCleanup(d)).rejects.toBeInstanceOf(CleanupFailedError);
  });

  it("stops at the first failure and keeps what was already deleted", async () => {
    const d = await deps({
      newClient: page(undefined, { "DELETE old2": () => Promise.reject(new GraphApiError("(#10) Permission denied", 400, 10)) }),
    });

    await expect(runCleanup(d)).rejects.toThrow("Could not delete old2");

    const state = await loadState(d.statePath);
    expect(Object.keys(state.deleted)).toEqual(["old1"]);
    const client = d.newClient as ReturnType<typeof page>;
    expect(client.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["old1", "old2"]);
  });

  it("deletes at most 3 per India day even if started again", async () => {
    const d = await deps();
    await runCleanup(d);
    const again = await runCleanup({ ...d, newClient: page([OURS, OLD(4)]) });
    expect(again).toEqual({ kind: "already-done-today" });
  });

  it("only tops up to 3 when some were already deleted today", async () => {
    const d = await deps();
    const state = await loadState(d.statePath);
    await saveState(d.statePath, { ...state, deleted: { old1: { deletedAt: "2026-11-19T01:00:00.000Z" } } });
    await expect(runCleanup(d)).resolves.toEqual({ kind: "deleted", ids: ["old2", "old3"] });
  });

  it("says so when there is nothing left", async () => {
    const d = await deps({ newClient: page([OURS]) });
    await expect(runCleanup(d)).resolves.toEqual({ kind: "nothing-to-delete" });
  });
});
