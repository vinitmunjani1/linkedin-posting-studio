# LinkedIn Posting Studio v1 — Brief Overview

## What v1 does

v1 turns the basic LinkedIn posting app into a small scheduling system.

It lets a user:

1. Sign in with LinkedIn.
2. Create a post draft.
3. Attach optional image/video media.
4. Choose a scheduled time in IST.
5. Approve the post.
6. Let the background scheduler publish it automatically at the scheduled time.

The app still uses LinkedIn’s official OAuth/API flow. It does not use browser automation or detection bypassing.

## Main flow

```text
LinkedIn Sign In
      ↓
Create Draft
      ↓
Optional media upload
      ↓
Set schedule time in IST
      ↓
Approve post
      ↓
Scheduler checks due posts every minute
      ↓
Publish to LinkedIn via API
```

## Post statuses

| Status | Meaning |
|---|---|
| `draft` | Post is created but not approved yet. |
| `approved` | Post can be manually published. |
| `scheduled` | Post is approved and waiting for scheduled time. |
| `publishing` | App is currently trying to publish it. |
| `published` | Post was successfully published to LinkedIn. |
| `failed` | Publishing failed; reason is shown in UI. |

## Scheduler behavior

- Scheduler runs in the background.
- It checks for due scheduled posts every 60 seconds.
- Time is entered/displayed in **IST**.
- Time is stored internally as UTC.
- Only approved/scheduled posts can be published.
- Daily post cap is enabled using `MAX_POSTS_PER_DAY`.
- Default cap: `3 posts/day`.

## Media support

v1 supports:

- Text-only posts
- Text + image
- Text + video

Supported media formats:

- PNG
- JPG/JPEG
- GIF
- MP4
- MOV
- WEBM

## Multi-user behavior

Each LinkedIn user gets:

- their own LinkedIn OAuth token
- their own draft queue
- their own scheduled posts
- their own daily post cap

So if multiple people use the app, posts are published to the LinkedIn account that signed in.

## Safety controls

- Uses official LinkedIn API.
- Requires LinkedIn OAuth sign-in.
- Keeps `.env`, tokens, uploaded media, and runtime data out of GitHub.
- Supports `DRY_RUN=true` for safe testing.
- Shows failed publish reasons in the UI.
- Does not publish Discord intake content directly; approval is required.

## Important environment variables

```env
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REDIRECT_URI=https://your-domain.com/auth/linkedin/callback
LINKEDIN_SCOPES=openid profile email w_member_social

DRY_RUN=false
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
MAX_POSTS_PER_DAY=3
```

## Short summary

v1 is the core publishing engine. It handles LinkedIn login, draft creation, media upload, scheduling, approval, rate safety, and final posting. Future modules like Discord intake should feed content into v1 instead of publishing directly.
