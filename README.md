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
