// Entry point: `npm run bot -- <command>`
//   doctor          check both tokens and accounts
//   inventory       count the old page's videos, list the ones that can't be reposted
//   post            repost one random video (runs at 10 AM and 7 PM IST)
//   refresh-tokens  extend both tokens (runs weekly)
import { spawn } from "node:child_process";
import dns from "node:dns";
import { existsSync } from "node:fs";
import { runDoctor } from "./commands/doctor";
import { runInventory } from "./commands/inventory";
import { runPost } from "./commands/post";
import { runRefresh, type SecretWriter } from "./commands/refresh";
import { loadConfig } from "./config";
import { createGraphClient } from "./graph";
import { errorMessage, log } from "./log";

// Meta's API has known failures over IPv6 on some networks; IPv4 first avoids them.
dns.setDefaultResultOrder("ipv4first");

const COMMANDS = ["doctor", "inventory", "post", "refresh-tokens"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

function maskInActions(value: string): void {
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${value}\n`);
}

/** Saves a GitHub Actions secret through the gh CLI. The value goes in through stdin, never as an argument. */
function githubSecretWriter(): SecretWriter | undefined {
  const pat = process.env.GH_PAT?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!pat || !repo) return undefined;
  return (name, value) =>
    new Promise((resolve, reject) => {
      const child = spawn("gh", ["secret", "set", name, "--repo", repo], {
        env: { ...process.env, GH_TOKEN: pat },
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gh secret set ${name} exited with code ${code}`))));
      child.stdin.end(value);
    });
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    log(`Usage: npm run bot -- <${COMMANDS.join(" | ")}>`);
    return 1;
  }
  if (existsSync(".env")) process.loadEnvFile(".env");

  const config = loadConfig();
  const oldClient = createGraphClient({ token: config.oldToken, apiVersion: config.apiVersion });
  const newClient = createGraphClient({ token: config.newToken, apiVersion: config.apiVersion });

  switch (command) {
    case "doctor": {
      const problems = await runDoctor({ oldClient, newClient, statePath: config.statePath, log });
      return problems.length === 0 ? 0 : 1;
    }
    case "inventory":
      await runInventory({ oldClient, statePath: config.statePath, log });
      return 0;
    case "post":
      await runPost({
        oldClient,
        newClient,
        statePath: config.statePath,
        dryRun: config.dryRun,
        maxAttempts: config.maxAttempts,
        expectedOldUsername: config.oldUsername,
        expectedNewUsername: config.newUsername,
        log,
      });
      return 0;
    case "refresh-tokens":
      await runRefresh({
        targets: [
          { secretName: "OLD_IG_TOKEN", client: oldClient, currentToken: config.oldToken },
          { secretName: "NEW_IG_TOKEN", client: newClient, currentToken: config.newToken },
        ],
        statePath: config.statePath,
        log,
        writeSecret: githubSecretWriter(),
        mask: maskInActions,
      });
      return 0;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log(`FAILED: ${errorMessage(error)}`);
    process.exitCode = 1;
  },
);
