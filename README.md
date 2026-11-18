# Insta Repost Bot

Reposts videos from an old Instagram account to a new one, twice a day, with the original caption, hashtags and cover image.
It runs for free on GitHub Actions and uses only Instagram's official API, so there are no unofficial logins or scraping.

**First time? Read [docs/SETUP.md](docs/SETUP.md).**

## What it does

| When (India time) | What |
|---|---|
| 10:00 AM and 7:00 PM daily | Picks one random old video not posted yet and posts it as a Reel on the new page |
| 1:00 PM daily | Deletes the 3 oldest videos the previous owner left on the new page (see below) |
| Sunday 7:40 AM | Extends Instagram Login tokens (`IG...`, 60 days). Facebook-issued `EAA...` system-user tokens never expire, so this does nothing for them |

It remembers what it posted in `state/state.json`, which the workflow commits back after every run, so a video is never posted twice.

**Deleting old posts:** `cleanup` permanently deletes the previous owner's oldest videos, 3 per run. It only touches videos older than the bot's first repost, never anything the bot posted, and it refuses to run until the bot has posted at least once. It needs the `instagram_manage_contents` permission on the new page's token. If Instagram refuses, the run fails with the reason and nothing else is deleted. Photos and carousels are left alone.

## Commands

```bash
npm run bot -- doctor          # check both tokens and accounts
npm run bot -- inventory       # count old videos; list ones that can't be reposted
npm run bot -- post            # repost one random video (set DRY_RUN=true to only preview)
npm run bot -- cleanup         # delete the previous owner's 3 oldest videos (DRY_RUN=true lists them only)
npm run bot -- refresh-tokens  # extend both tokens
```

To run on your own computer, put the settings in a `.env` file (never commit it):

| Variable | Needed for | Notes |
|---|---|---|
| `OLD_IG_TOKEN` | everything | Old page token, `instagram_business_basic` |
| `NEW_IG_TOKEN` | everything | New page token, plus `instagram_business_content_publish` |
| `OLD_IG_USERNAME`, `NEW_IG_USERNAME` | recommended | Stops the bot if the two tokens are swapped |
| `OLD_IG_USER_ID`, `NEW_IG_USER_ID` | tokens starting `EAA` | Instagram account ids (shown next to each account in the Meta app). Not secret |
| `GH_PAT` | `refresh-tokens` on GitHub | Saves a refreshed token into the repo secrets |
| `DRY_RUN` | optional | `true` = preview only |
| `GRAPH_API_VERSION` | optional | default `v24.0` |
| `MAX_ATTEMPTS` | optional | videos tried per run before failing, default 3 |
| `STATE_PATH` | optional | default `state/state.json` |

## How a post works

1. Read every post on the old page. Instagram returns each video's file link and cover image link.
2. Choose a random video that is not in `state.json` and has failed fewer than 3 times.
3. Ask Instagram to create a Reel on the new page from that file link, with the same caption and the old cover.
4. Wait until Instagram has processed it, then publish it.
5. Save the result.

If the cover is rejected, it retries with the first frame as the cover. If a video fails, it tries another one (up to 3 per run).
If a run crashes halfway, the next run checks the unfinished upload first and finishes or drops it, so nothing is posted twice.

## Limits

- Videos with music from Instagram's music library: Instagram does not give the file to the API. `inventory` lists them, and they are skipped.
- Instagram allows 100 API posts per account per 24 hours. The bot uses 2.
- Photos and carousels on the old page are skipped. Only videos are reposted.

## Development

```bash
npm ci
npm test            # unit tests
npm run test:coverage
npm run typecheck
```
