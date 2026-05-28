# LinkedIn Posting Studio

A safe LinkedIn personal-profile posting app with OAuth sign-in, media drafts, approval, and scheduled publishing.

## Features

- Sign in with LinkedIn OAuth
- Per-user private token + post queue
- Text, image, and video drafts
- Approval before publishing
- Scheduled publishing in IST
- Daily publish cap (`MAX_POSTS_PER_DAY`)
- Live/dry-run mode
- Cloud/VPS friendly

## Setup

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill in LinkedIn Developer App values in `.env`:

```env
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REDIRECT_URI=https://your-domain.com/auth/linkedin/callback
```

3. Add the same redirect URL in LinkedIn Developer Portal → Auth.

4. Start:

```bash
npm start
```

## Safety

Do not commit `.env`, `secrets.txt`, runtime token data, or uploaded media. They are ignored by `.gitignore`.

## Scheduler

- Times are entered/displayed in IST.
- Times are stored internally as UTC.
- Scheduler checks every `SCHEDULER_INTERVAL_MS`.
- Daily cap defaults to 3 posts/day.

## v2 Discord Intake

Discord intake is separate from the v1 publisher. It creates approval items; approved items become normal v1 drafts.

Flow:

1. Run the web app with `npm start`.
2. Configure Discord env values in `.env`.
3. Run the Discord intake bot:

```bash
npm run start:discord
```

4. Share a URL in the configured Discord channel.
5. The bot extracts metadata/media and creates a pending intake item.
6. Open the Posting Studio dashboard, review the caption, and approve it to create a draft.
7. Schedule/publish through the v1 engine.

Required Discord setup:

- Create a Discord application + bot.
- Enable Message Content Intent.
- Invite the bot with permission to read/send messages in the target channel.
- Set `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, and `PUBLIC_BASE_URL`.

Security:

- Do not commit `DISCORD_BOT_TOKEN`.
- The bot does not publish directly; it only creates approval items.

### v2 Channel Workspace Model

Each Discord channel can be connected to one LinkedIn account.

Commands:

```text
!connect-linkedin
!account
!approve <intake_id>
!schedule <intake_id> YYYY-MM-DD HH:mm
!reject <intake_id>
```

Flow:

1. Create a Discord channel for a LinkedIn account/workspace.
2. Run `!connect-linkedin` in that channel.
3. Sign in with LinkedIn using the generated link.
4. Share URLs in that channel.
5. Bot extracts a draft preview and replies with approval commands.
6. Approve now or schedule in IST from Discord.

The web UI is only needed for the first LinkedIn login or manual v1 management.
