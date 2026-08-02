# RPC Logger Bot

Archives **every message** on the server into a free Postgres database (Neon).
When a message is edited or deleted — no matter how old — it posts a before/after embed
to the log channel. No cache window: if it's in the database, it can be logged.
The archive is trimmed by a retention window (adverts after a year, other channels
after two) so a free database can keep up — see [Database retention](#database-retention).

- **Edit** → orange embed with Before / After + jump link
- **Delete** → red embed with the original content, author, and **who deleted it**
  (from the audit log; self-deletes are labeled as such). Attachment names are
  shown only for messages still in the bot's live cache — they aren't archived.
- **Bulk delete** (bans, purges) → one embed + a full `.txt` transcript attached
- **Name change** → embed whenever a member changes their **nickname**, **@username**,
  or **display name**. Always on.
- **Role change** → embed when a member gains or loses roles. **Off by default**
  (it's noisy on servers with onboarding flows / role menus) — turn it on with
  `>>settings`.
- `npm run backfill` archives *existing* server history so even messages sent
  before the bot existed are covered — back to the same retention windows the
  database keeps (one year for advert channels, two years elsewhere; see
  [Database retention](#database-retention)).
- **`c!members @role`** (also takes a role name or id) lists everyone holding a
  role, CircleBot-style: `@username (id)` lines, up to 200 members, no pings.
- **`npm run check-links`** scans the channels listed in `LINK_CHECK_CHANNELS`
  for **dead Discord invite links** and prints a report — see
  [Dead invite check](#dead-invite-check).
- **Anonymous polls:** `/poll` creates a timed poll with 2-20 choices and a
  fixed number of votes per person. Voters use private button interactions, so
  the public message only shows choices until `/closepoll` or the timer posts
  the final EasyPoll-style result bar.
- **Member history:** every nickname and role change is also recorded permanently
  to the database (regardless of the role-logging toggle). Query it with:
  - **`>>nicknames @user`** — the user's nickname history (also accepts a user id
    or username).
  - **`>>roles @user`** — the user's current roles plus recent role add/removes.
  - **`>>settings`** — **owner-only** interactive panel (buttons). A master
    **Log channel posting** switch (**off by default** — the bot archives to the
    database silently until you turn it on) pauses/resumes all posts to the log
    channel; while off, messages are still archived and only the channel output
    stops. Also a toggle for role-change logging. Edits, deletions, and name
    changes are always on and shown as locked switches.
- **Failsafe (YAGPDB backup):** when the YAGPDB bot ("Jarvis") goes **offline**,
  this bot takes over specific pieces of its automation until it returns. While
  **any** YAGPDB instance is online, the failsafe stays completely dormant.
  - **Age Please on join** — assign the Age Please role to everyone who joins
    (any join — new or returning members) while YAGPDB is down.
  - **Onboarding gate** — run the rest of the join flow: age verification in the
    verification channel (Age Please → Rules Please) and the rules reaction
    (Rules Please → Newbie), reproducing YAGPDB's embeds and underage kick.
  - **Advert enforcement** — mirror YAGPDB's advert commands (length, cooldown,
    duplicates, banned words, etc.).
  - **`>>failsafe`** — owner-only readout of what it detects as YAGPDB and
    whether the failsafe is currently active. See [Failsafe](#failsafe-yagpdb-backup) below.

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`).
3. Still on the Bot tab, under **Privileged Gateway Intents**, enable
   **Message Content Intent** (required — without it every message arrives empty),
   **Server Members Intent** (required for the `c!members` command; the bot
   refuses to log in with "Used disallowed intents" if this is off), and
   **Presence Intent** (required for the **failsafe** to see whether YAGPDB is
   online — the bot won't log in without it unless you set `FAILSAFE_ENABLED=false`).
4. **Installation** tab (or OAuth2 → URL Generator): scope `bot`, permissions
   Include the `applications.commands` scope so slash commands appear.
   **View Channels, Read Message History, Send Messages, Embed Links, Attach
   Files, View Audit Log** (audit log access is how "Deleted by" is resolved),
   plus **Manage Roles** (assign Age Please), **Manage Messages** (delete
   rule-breaking adverts), and **Add Reactions** (the `:staffpending:` flag). Or
   use this URL with your client ID:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=268561600
   ```

   Already invited the bot with the older link? Just enable **View Audit Log**,
   **Manage Roles**, **Manage Messages**, and **Add Reactions** on the bot's role
   in Server Settings → Roles. For the failsafe to assign **Age Please**, the
   bot's highest role must sit **above** Age Please in the role list.
5. Open the URL, invite the bot to the server.

### 2. Create the free database (Neon)

1. Sign up at https://neon.tech (free tier: 0.5 GB — years of text for a typical server).
2. Create a project → **Connect** → copy the connection string (this is `DATABASE_URL`).
   The bot creates its own table on first start; no manual SQL needed.

### 3. Log channel

Create e.g. `#server-log` (staff-only), enable Discord **Developer Mode**
(User Settings → Advanced), right-click the channel → **Copy Channel ID**
(this is `LOG_CHANNEL_ID`).

### 4. Test locally

```
cd logger-bot
npm install
copy .env.example .env    # then fill in the three values
npm start
```

Send / edit / delete a test message and check the log channel.

### 5. Backfill existing history (once)

```
npm run backfill
```

Pages through every channel and thread the bot can see and archives it, back
to the retention windows (one year of history for advert channels, two years
for everything else — older messages would just be pruned again by the daily
retention job). Large servers take a while (Discord rate limits paging); it
prints progress and is safe to re-run: already-archived messages are refreshed.

### 6. Deploy to the free host

**bot-hosting.net** (verified free tier: 256 MB RAM / 1 GB disk, Node.js):

1. Sign in with Discord at https://bot-hosting.net → create a free **Node.js** server.
2. Upload the code: either connect this folder as a GitHub repo (auto-redeploys on
   push) or upload the files through their file panel (`package.json`, `src/`).
   **Do not upload `node_modules` or your local `.env`.**
3. Create a `.env` file in the panel's file manager with the three values
   (or use the panel's startup/variables tab if it offers one).
4. Set the startup file to `src/index.js` (or startup command `npm start`) and start it.
5. ⚠️ **Free servers require a manual renewal click every 4 days** or they stop.
   Put a recurring reminder somewhere you'll see it. (Wispbyte.com is a similar
   free host that advertises no renewal requirement, if that becomes annoying.)

## Run it by double-clicking

Two launcher scripts let you run the bot without typing commands — handy on a
laptop or spare desktop instead of the free host. Both live next to
`package.json`, so **double-click** them from the `logger-bot/` folder. Each one:

1. checks Node 18+ is installed and that `.env` exists (finish [Setup](#setup) first),
2. runs `npm install` automatically on the very first launch,
3. runs `npm run backfill` once, then
4. starts the bot and **keeps it alive** — if it ever crashes it restarts after
   5 seconds (same idea as running it in a terminal supervisor).

Leave the window open — that's the bot running; its logs print there. **Close the
window (or press `Ctrl+C`) to stop it.**

- **Windows:** double-click **`start-bot.cmd`**.
- **macOS:** double-click **`start-bot.command`**. macOS needs the file marked
  executable once — in Terminal, run `chmod +x start-bot.command` in this folder
  (or right-click the file → Open the first time to get past Gatekeeper). If Node
  was installed with **nvm**, Finder may not see it — run the script from a
  terminal (`./start-bot.command`) instead; the official installer and Homebrew
  are found automatically.

This is not a background service: the bot only runs while the window is open. To
have it run unattended / survive reboots, use the free host in
[step 6](#6-deploy-to-the-free-host) instead.

## Failsafe (YAGPDB backup)

The server's automation normally runs on **YAGPDB** (nicknamed "Jarvis"). This
bot can stand in for pieces of that automation **only while YAGPDB is offline**,
so the server keeps working during a YAGPDB outage. As soon as any YAGPDB
instance is back online, every failsafe action stops.

**How "is YAGPDB online?" is decided.** The bot watches presence (needs the
Presence intent). A member counts as YAGPDB if it's a **bot** whose username or
display name contains `yagpdb` after case/punctuation are stripped — so
`YAGPDB.xyz`, `YAGPDB`, etc. all match regardless of the `#discriminator`, which
can change. Requiring the bot flag means a human renaming themselves "yagpdb"
can't fake it. YAGPDB is "online" if its presence is `online`, `idle`, or `dnd`.
For the strongest match you can pin the exact bot user id(s) with `YAGPDB_BOT_IDS`
(ids never change).

**Failsafe tasks.**

1. **Age Please on join** — when someone **joins** (new *or* returning), if
   YAGPDB is offline the bot assigns the **Age Please** role (`AGE_PLEASE_ROLE_ID`,
   default `735544386678554738`) and notes it in the log channel. Role adds are
   idempotent, so a brief overlap with a reconnecting YAGPDB does no harm.

2. **Onboarding gate** — the rest of the join flow, reproducing YAGPDB's
   age-verification custom command and rules reaction role as closely as
   possible. **Dormant until you set `AGE_VERIFY_CHANNEL_ID`** (like the advert
   failsafe with no channels); the role/message/emoji IDs default to RPC's live
   values and are each overridable in `.env`.
   - **Age verification** — when a member holding **Age Please** posts in the
     verification channel, the bot reads their message the way YAGPDB's `toInt`
     does (a whole-string integer, else treated as 0):
     - **Not a number / 0** → the "Roleplay Central Database" embed asking them
       to enter their age (echoing what they typed).
     - **Below `MIN_AGE`** (default 15) → the "come back when you're old enough"
       message, then a **kick** — but only after YAGPDB has been offline for
       `ADVERT_MIN_OFFLINE_SECS` (so a reconnect blip can't kick anyone).
     - **Above `MAX_AGE`** (default 75) → the "input a two-digit age" warning embed.
     - **In range** → adds **Rules Please**, removes **Age Please**.
   - **Rules reaction** — when a member holding **Rules Please** reacts to the
     rules message (`RULES_MESSAGE_ID`) with the `:rpc:` emoji (`RULES_EMOJI_ID`),
     the bot adds **Newbie** and removes **Rules Please**. Only new reactions
     during the outage are processed — it can't retroactively read reactions
     added while it (or YAGPDB) was down.
   - Both steps only touch members already on the matching gate role, so a stray
     message or reaction from staff or an already-verified member is ignored.

3. **Advert enforcement** — mirrors YAGPDB's consolidated advert commands
   (group / 1x1 / quick) while YAGPDB is offline:
   - **Hard (deletes the post + DMs the user):** over length, cooldown not
     elapsed, or a duplicate post already standing in the channel — with the same
     10-minute delete-and-repost grace window.
   - **Advisory (keeps the post, one combined ping to #rule_infractions):**
     disallowed headers / images / links (per channel type), banned words
     (spoilered), and cross-channel duplicates.
   - Cooldown/duplicate state is read from the logger-bot's **own message
     archive**, so it's accurate from the first post of an outage — it never
     needs YAGPDB's database. It does **not** replicate the infraction ledger or
     14-day advert bans (those live only in YAGPDB).
   - **Setup:** channel IDs live in per-server files
     [`src/advertConfig.live.js`](src/advertConfig.live.js) and
     [`src/advertConfig.test.js`](src/advertConfig.test.js); set `ADVERT_ENV=test`
     on the test deployment (default is live). Rules, limits, and banned words are
     shared in `advertConfig.base.js`. If a variant has no channels the task stays
     inactive (the boot log says so).

**Requirements.**
- **Presence Intent** enabled (see Setup step 3). If you can't enable it, set
  `FAILSAFE_ENABLED=false` — the bot then drops the intent and the failsafe stays
  off, but the rest of the logger runs normally.
- **Manage Roles** with the bot's highest role **above** every gate role it
  assigns (Age Please, Rules Please, Newbie).
- **Kick Members** (for the onboarding failsafe's underage kick), with the bot's
  highest role above the members it kicks.
- **Manage Messages** (to delete rule-breaking adverts) and **Add Reactions**
  (for the `:staffpending:` flag) in the advert + #rule_infractions channels.

**Check it.** `>>failsafe` (owner only) prints which bots it sees as YAGPDB,
their live status, and whether the failsafe is currently active — use it to
confirm detection matched your YAGPDB without waiting for a real outage.

**Note.** The advert failsafe deletes posts only while YAGPDB is genuinely
offline. It doesn't debounce brief YAGPDB reconnects; because a reconnect
usually doesn't flip Discord presence to "offline," this is rarely an issue, but
a "must be offline for N seconds" guard can be added if it ever misfires.

## Caveats

- **Downtime = gaps.** Events that happen while the bot is offline are not logged
  (a re-run of `backfill` will still archive any *new* messages it missed, but
  edits/deletes that occurred during the outage are invisible).
- **Attachments aren't archived.** To keep the database small, attachment info is
  no longer stored. A deleted message still lists its attachment names/links when
  it's in the bot's live cache, but archived (uncached) deletes show none. Even
  when shown, Discord CDN URLs are signed and die after ~24h, so an older link may
  already be dead.
- **The log channel itself is not tracked** (prevents feedback loops).
- **Bot message noise:** bots like YAGPDB edit their own messages constantly
  (paginated embeds, updating status messages), and each edit hits the log.
  Set `IGNORE_BOTS=true` in `.env` to skip messages from all bots.
- **Excluding channels:** set `IGNORE_CHANNELS` in `.env` to a comma-separated
  list of channel IDs to skip entirely — no archive, no edit/delete embeds, and
  skipped by the backfill. Listing a **category** ID excludes every channel under
  it; listing a **text channel** ID also excludes its threads. Name/role logging
  isn't per-channel, so it's unaffected. (e.g. `IGNORE_CHANNELS=123,456`.)

## Database retention

The archive can't grow forever on a free database, so a **daily retention
prune** trims old rows out of the `messages` table. **Retention never touches
Discord** — it only deletes the bot's local database copy; every real message
stays on the server. (This bot deliberately has no feature for deleting old
posts from Discord — removing stale adverts is YAGPDB's job, or done manually.
The only Discord deletions this bot ever performs are the advert failsafe's
bounced rule-breaking adverts during a YAGPDB outage.)

- **Advert channels** (the failsafe's configured advert channels in
  `src/advertConfig.live.js` / `.test.js`) are pruned after
  `ADVERT_RETENTION_DAYS` (**default 365 = one year**).
- **Every other channel** is pruned after `MESSAGE_RETENTION_DAYS` (**default
  730 = two years**).
- The prune runs about a minute after startup, then every 24 hours, and
  deletes in batches so a large first run can't lock the table. Set
  `DB_RETENTION_ENABLED=false` to keep everything forever (mind your Neon
  storage).

## Invite-link sweep (dead links + duplicate servers)

Scans the archived posts of chosen channels for Discord invite links
(`discord.gg/...`, `discord.com/invite/...`) and asks Discord about each one. It
enforces two rules, both through the same warn→grace→delete pipeline:

1. **Dead links** — invites Discord reports as Unknown Invite (expired/revoked).
2. **Duplicate servers** — the same server advertised in more than one channel
   (group servers may only be advertised in one channel at a time). Each live
   invite is resolved to its **server (guild) id**, so two *different* invite
   codes that point to the same server still count as duplicates. The **newest**
   post's channel is kept; every copy in another channel is warned/removed.

It runs two ways, both sharing the same logic:

- **Automatic (daily):** when `LINK_CHECK_CHANNELS` is set, the running bot
  sweeps once a day on its own — no cron needed, which is what makes it work on
  hosts that only run `npm start` (e.g. Wispbyte). The time is `LINK_CHECK_HOUR`
  (0–23, UTC; default `4` = 04:00 UTC). It runs one sweep per calendar day even
  across restarts, so a restart won't re-fire the author pings.
- **Manual (on demand):** `npm run check-links` runs a single sweep and exits —
  handy for a one-off check or from your own machine.

Options:

- **Choosing channels:** set `LINK_CHECK_CHANNELS` in `.env` to a
  comma-separated list of channel and/or category IDs (right-click → Copy
  Channel ID). A category ID covers every channel under it, and a text-channel
  ID covers its threads — the same rule as `IGNORE_CHANNELS`. Unset = the whole
  feature is off (no daily sweep, and the manual script errors out).
- **Notifying authors:** set `LINK_CHECK_NOTIFY_CHANNEL_ID` to a channel id
  (e.g. #rule_infractions) and the sweep posts one message per offending post
  there, pinging the author. Dead link:
  > Hi @Mario, it looks like your link in #fandom_groups has expired. Please
  > update it with a valid link within 24 hours or it will be removed.
  > For your convenience, [here is a link to your post]. Thank you!

  Duplicate server:
  > Hi @Mario, your server is advertised in more than one channel. Group servers
  > may only be advertised in one channel at a time, so please remove this post
  > in #fandom_groups within 24 hours — your more recent post in #original_groups
  > can stay. [Here is a link to this post]. Thank you!

  One message per post. Leave unset for a console-only report. **Each sweep
  sends the first warning only once per post/reason. Later sweeps keep the grace
  clock, but do not re-ping unless the same post is fixed and later re-offends.**
- **Auto-deletion (enforcement):** `LINK_CHECK_GRACE_HOURS` (default `24`) is the
  grace period between the first warning and the bot **deleting** the post if it's
  still in violation. With the daily sweep that's: warned on day 1, deleted on
  day 2 if still bad. On deletion an un-pinged notice is posted to the notify
  channel (e.g. `🗑️ Removed @Mario's post in #fandom_groups — the same server was
  advertised in more than one channel (only one is allowed).`). Requirements and
  safety:
  - Needs the **Manage Messages** permission and `LINK_CHECK_NOTIFY_CHANNEL_ID`
    set — a post is **never deleted without the author having been warned first**.
  - The grace clock is stored in the DB (`flagged_posts`, keyed by post + reason),
    so it **survives restarts** — a restart won't reset the 24h timer or delete
    early. Rows clear the moment a post is fixed or removed, so the table stays
    tiny.
  - Each archived invite post is fetched from Discord before the sweep reports
    or enforces anything, so edited posts are judged by their current content.
    A post is only deleted if it's **still** dead / still duplicated at that
    moment - fix it and nothing happens.
  - Nothing is deleted during a suspected Discord outage (see the outage guard).
  - Set `LINK_CHECK_GRACE_HOURS=0` to disable deletion and keep warn/report only.
- **Outage guard:** all links are checked before anything is posted, and if
  **¾ or more of the lookups fail** (dead and unverifiable combined), the
  script assumes a *Discord* outage rather than mass link death — during the
  July 2026 outage, perfectly good invites came back "Unknown Invite". The
  report still prints (clearly labeled as suspect) but **no notifications are
  posted**; re-run once Discord is healthy.
- Deleted posts are skipped; each unique invite code is checked once no matter
  how many posts contain it, paced at ~1 lookup/second (a channel with
  hundreds of distinct invites takes a few minutes).
- **"Dead" caveats:** Discord reports expired, revoked, and never-valid codes
  identically, so the report can't say *why* a link is dead. Lookups that fail
  for other reasons (network, rate limit) are listed separately as unverified
  instead of being guessed either way — re-run to retry them.
- Only message **text** is scanned; invites inside embeds (e.g. bot- or
  webhook-posted adverts) aren't visible to it.

## Local JSON backup (optional)

`JSON_ARCHIVE_DIR` is a **directory path** (not a true/false flag). Set it to a
folder — e.g. `JSON_ARCHIVE_DIR=archive` — and the bot appends every archived
message and every edit/delete event to
`<dir>/<guildId>/<channel-name>-<channelId>.jsonl`, one JSON object per line.
Leave it unset on the bot host; it's meant as an offline copy on your own
machine. Transient network/database errors are retried with backoff.

**The JSON archive can outrun the database.** During live logging the two stay
in step (a message is appended to JSON as it's inserted into the DB). But
`npm run backfill` deliberately diverges: it writes **all of history** to the
JSON archive while only seeding the DB with messages **inside the retention
windows** — so your offline copy stays complete even though Neon is trimmed to
the `*_RETENTION_DAYS` cutoffs. With `JSON_ARCHIVE_DIR` unset, backfill has no
reason to page past the cutoff and stops there.

Because the JSON files are append-only, the live path only writes a line the
first time a message is inserted (no duplicates), but **re-running `backfill`
re-appends the all-time history** — clear the JSON dir first, or use
`npm run export-json` (which regenerates the files, deduplicated, but only from
what's currently in the DB — i.e. within the cutoffs, not all-time).
- Messages edited/deleted that predate both the bot *and* the backfill show
  "(not archived)".
