import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor";
import { runInventory } from "../src/commands/inventory";
import { runRefresh, RefreshFailedError } from "../src/commands/refresh";
import { loadConfig, ConfigError } from "../src/config";
import { emptyState, loadState, saveState, withTokenRefresh } from "../src/state";
import { fakeClient, silentLog, tempStatePath, video } from "./fakes";

function account(userId: string, type = "BUSINESS") {
  return fakeClient({
    "GET me": () => ({ user_id: userId, username: userId.toLowerCase(), account_type: type, media_count: 3 }),
    [`GET ${userId}/content_publishing_limit`]: () => ({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] }),
  });
}

describe("runDoctor", () => {
  it("passes for two different professional accounts", async () => {
    const statePath = await tempStatePath();
    await expect(runDoctor({ oldClient: account("OLD"), newClient: account("NEW"), statePath, log: silentLog })).resolves.toEqual([]);
  });

  it("flags a personal account, a shared account and stale tokens", async () => {
    const statePath = await tempStatePath();
    await saveState(statePath, withTokenRefresh(emptyState(), "2026-09-01T00:00:00Z"));

    const problems = await runDoctor({
      oldClient: account("SAME", "PERSONAL"),
      newClient: account("SAME"),
      statePath,
      log: silentLog,
      now: () => new Date("2026-11-17T00:00:00Z"),
    });

    expect(problems).toEqual([
      "OLD account must be a Business or Creator account.",
      "Both tokens belong to the same account.",
      "Tokens have not been refreshed for over 50 days and will expire soon.",
    ]);
  });

  it("reports a broken token", async () => {
    const broken = fakeClient({ "GET me": () => Promise.reject(new Error("Invalid OAuth access token")) });
    const problems = await runDoctor({ oldClient: broken, newClient: account("NEW"), statePath: await tempStatePath(), log: silentLog });
    expect(problems).toEqual(["OLD_IG_TOKEN does not work: Invalid OAuth access token"]);
  });
});

describe("runInventory", () => {
  it("lists what can and cannot be reposted", async () => {
    const lines: string[] = [];
    const oldClient = fakeClient({ "GET me/media": () => ({ data: [video("v1"), video("v2"), video("m1", { media_url: undefined })] }) });

    const summary = await runInventory({ oldClient, statePath: await tempStatePath(), log: (l) => lines.push(l) });

    expect(summary.remaining).toBe(2);
    expect(lines.join("\n")).toContain("1 videos cannot be reposted automatically");
    expect(lines.join("\n")).toContain("https://instagram.com/reel/m1");
  });
});

describe("runRefresh", () => {
  const refreshed = (token: string) => fakeClient({ "GET refresh_access_token": () => ({ access_token: token, expires_in: 5_184_000 }) });

  it("saves only tokens that changed and records the refresh time", async () => {
    const statePath = await tempStatePath();
    const writeSecret = vi.fn(async () => undefined);
    const mask = vi.fn();

    await runRefresh({
      targets: [
        { secretName: "OLD_IG_TOKEN", client: refreshed("same"), currentToken: "same" },
        { secretName: "NEW_IG_TOKEN", client: refreshed("fresh"), currentToken: "stale" },
      ],
      statePath,
      log: silentLog,
      writeSecret,
      mask,
      now: () => new Date("2026-11-17T00:00:00Z"),
    });

    expect(writeSecret).toHaveBeenCalledExactlyOnceWith("NEW_IG_TOKEN", "fresh");
    expect(mask).toHaveBeenCalledWith("fresh");
    expect((await loadState(statePath)).lastTokenRefreshAt).toBe("2026-11-17T00:00:00.000Z");
  });

  it("fails when a new token cannot be saved", async () => {
    await expect(
      runRefresh({
        targets: [{ secretName: "NEW_IG_TOKEN", client: refreshed("fresh"), currentToken: "stale" }],
        statePath: await tempStatePath(),
        log: silentLog,
        mask: () => undefined,
      }),
    ).rejects.toBeInstanceOf(RefreshFailedError);
  });
});

describe("loadConfig", () => {
  it("reads tokens and defaults", () => {
    expect(loadConfig({ OLD_IG_TOKEN: " a ", NEW_IG_TOKEN: "b" })).toEqual({
      oldToken: "a",
      newToken: "b",
      apiVersion: "v24.0",
      statePath: "state/state.json",
      dryRun: false,
      maxAttempts: 3,
    });
  });

  it("reads overrides", () => {
    const config = loadConfig({
      OLD_IG_TOKEN: "a",
      NEW_IG_TOKEN: "b",
      DRY_RUN: "true",
      MAX_ATTEMPTS: "5",
      GRAPH_API_VERSION: "v25.0",
      OLD_IG_USERNAME: " oldpage ",
      NEW_IG_USERNAME: "",
    });
    expect(config).toMatchObject({ dryRun: true, maxAttempts: 5, apiVersion: "v25.0", oldUsername: "oldpage" });
    expect(config.newUsername).toBeUndefined();
  });

  it("rejects missing or bad values", () => {
    expect(() => loadConfig({})).toThrow("Missing OLD_IG_TOKEN and NEW_IG_TOKEN");
    expect(() => loadConfig({ OLD_IG_TOKEN: "a", NEW_IG_TOKEN: "b", MAX_ATTEMPTS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ OLD_IG_TOKEN: "a", NEW_IG_TOKEN: "b", GRAPH_API_VERSION: "24" })).toThrow(ConfigError);
  });
});
