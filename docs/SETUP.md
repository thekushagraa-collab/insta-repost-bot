# Setup guide (one time, about 45 minutes, ₹0)

You do the logins. Claude can do the clicking in Chrome after you are logged in.
Never paste a password into the chat.

Meta changes its dashboard screens often. If a button below has moved, look for the same words nearby.

## What you need

- Logins for both Instagram accounts (old page and new page).
- A personal Facebook account. Meta's developer website only lets you sign in with one. This is a normal Facebook profile, **not** a Facebook Page. Nothing is linked to your Instagram pages.
- A GitHub account.

## Step 1: Make both Instagram accounts Professional

Do this for the old account and the new account, in the Instagram app:

1. Profile → ☰ menu → **Account type and tools** → **Switch to professional account**.
2. Pick any category, then choose **Creator** or **Business**.
3. If it asks to connect a Facebook Page, tap **Skip**. A Page is not needed.

This is free and you can switch back later.

## Step 2: Create the Meta app

1. Go to https://developers.facebook.com and log in with your Facebook account. If it asks, register as a developer (free).
2. **My Apps → Create app**.
3. Name it something like `Insta Repost Bot`.
4. For the use case, choose the one about **managing content on Instagram** (the Instagram API).
5. Meta asks for a **business portfolio** (Meta Business Suite) to finish the Instagram setup. This is free and is **not** a Facebook Page. If it says your Facebook account is too new, wait an hour or two and try again.
6. Finish creating it. Leave the app in **Development** mode. That is enough because only your two accounts will use it, so no App Review is needed.

## Step 3: Add both Instagram accounts as testers

1. In the app: **App roles → Roles → Add people → Instagram Tester**. Add the old account's username, then the new account's username.
2. Open https://www.instagram.com logged in as the **old** account: **Settings → Apps and websites → Tester invites → Accept**.
3. Log out, log in as the **new** account and accept its invite the same way.

## Step 4: Generate the two tokens

1. In the app: **Use cases → Customize → API setup with Unified login → 2. Generate access tokens**. Both tester accounts are listed there.
2. Click **Generate token** next to the **old** account, log in as it and allow access. Copy its token straight into the GitHub secret (step 5).
3. Do the same for the **new** account.

Tokens are like passwords. Keep them out of chat, email and files that go to GitHub.
The old account only needs read access (`instagram_business_basic`). The new account also needs `instagram_business_content_publish`.

## Step 5: Put the bot on GitHub

1. Create a **private** repository on GitHub, for example `insta-repost-bot`, and push this folder to it.
2. In the repository: **Settings → Secrets and variables → Actions → New repository secret**. Add:
   - `OLD_IG_TOKEN`: the old account's token.
   - `NEW_IG_TOKEN`: the new account's token.
3. On the same page, open the **Variables** tab and add `OLD_IG_USERNAME` and `NEW_IG_USERNAME` (the two usernames, without @). If the two tokens are ever swapped, the bot stops instead of posting to the wrong page.
4. Back on the **Secrets** tab, also add:
   - `GH_PAT`: a GitHub token that lets the bot save refreshed Instagram tokens. Create it at GitHub **Settings → Developer settings → Fine-grained tokens → Generate new token**. Give it access to **only this repository**, with **Secrets: Read and write** permission and the longest expiry offered. Note its expiry date: renew it before then.

## Step 6: Test it

In the repository go to **Actions → insta-bot → Run workflow** and run these in order:

1. `doctor`: checks both tokens. It must say **All checks passed**.
2. `inventory`: counts the old page's videos and lists any that Instagram won't hand over (usually videos with music from Instagram's music library).
3. `post` with **dry run** ticked: shows which video it would post, without posting.
4. `post` with **dry run** unticked: posts one real video. Check the new page.

## After that

Nothing. Every day at 10 AM and 7 PM (India time) it posts one random video. Every Sunday it extends the tokens.
GitHub emails you if a run fails. Open the run's log to see why.

Good to know:
- GitHub sometimes starts scheduled runs 5–30 minutes late.
- Deleting the previous owner's videos is **not** automated (it needs a Facebook Page). Delete those in the Instagram app yourself.
- If the bot stops for over 60 days, the tokens expire. Repeat step 4 and update the two secrets.
