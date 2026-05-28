# LinkedIn Posting Studio v1 — Detailed Implementation Plan

## 1. Objective

Build v1 as the core LinkedIn publishing engine.

v1 should support:

- LinkedIn OAuth sign-in
- per-user post queues
- text/image/video post drafts
- approval workflow
- IST-based scheduling
- automatic publishing at scheduled time
- daily posting cap
- failure tracking and retry
- safe runtime storage

v1 should not depend on Discord. Future modules, including v2 Discord intake, should feed content into v1 instead of publishing directly.

---

## 2. High-Level Architecture

```text
Browser UI
  ↓
Node.js HTTP Server
  ↓
Local JSON Store
  ↓
Scheduler Loop
  ↓
LinkedIn OAuth + UGC API
```

Main components:

| Component | Responsibility |
|---|---|
| `server.js` | Web UI, routes, auth callback, scheduler loop |
| `linkedin.js` | LinkedIn OAuth/API calls, media upload, post publishing |
| `store.js` | JSON persistence, post lifecycle, tokens, validation |
| `config.js` | Environment config loading/validation |
| `uploads/` | Runtime media upload storage |
| `data/` | Runtime tokens/posts/audit logs |

---

## 3. User Flow

### 3.1 Sign in

```text
User opens app
  ↓
Clicks Continue with LinkedIn
  ↓
LinkedIn OAuth consent
  ↓
App receives callback
  ↓
Token + LinkedIn user profile saved
  ↓
User enters dashboard
```

Requirements:

- OAuth scopes must include `w_member_social`.
- Each LinkedIn user gets a separate token file.
- Each user sees only their own post queue.

---

### 3.2 Create draft

User can create:

- text-only post
- text + image post
- text + video post

Draft fields:

```json
{
  "id": "uuid",
  "ownerSub": "linkedin_user_id",
  "ownerName": "LinkedIn user name",
  "text": "post text",
  "status": "draft",
  "scheduledFor": "UTC ISO timestamp or null",
  "mediaPath": "uploads/file.png or null",
  "mediaTitle": "optional",
  "mediaDescription": "optional",
  "createdAt": "UTC ISO timestamp",
  "updatedAt": "UTC ISO timestamp",
  "publishedAt": null,
  "linkedinPostId": null
}
```

Validation:

- post text required
- max text length: 3000 characters
- media must be uploaded through app
- supported media only:
  - PNG
  - JPG/JPEG
  - GIF
  - MP4
  - MOV
  - WEBM

---

## 4. Scheduling Design

### 4.1 Timezone behavior

UI uses **IST**.

Storage uses UTC.

Example:

```text
User selects: 2026-05-28 10:00 IST
Stored as:    2026-05-28T04:30:00.000Z
```

Implementation rules:

- `datetime-local` values are treated as IST.
- Convert IST → UTC before saving.
- Convert UTC → IST before displaying.

---

### 4.2 Scheduler loop

Scheduler runs every 60 seconds by default.

```text
Every 60 seconds:
  find posts with status=scheduled
  check scheduledFor <= now
  publish due posts
  mark success/failure
```

Config:

```env
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
MAX_POSTS_PER_DAY=3
```

---

## 5. Post Lifecycle

```text
draft
  ↓ approve
approved
  ↓ schedule
scheduled
  ↓ due time reached
publishing
  ↓ success
published
```

Failure path:

```text
publishing
  ↓ error
failed
  ↓ retry/manual publish
publishing
```

Statuses:

| Status | Meaning |
|---|---|
| `draft` | Created but not approved. |
| `approved` | Approved for manual publishing. |
| `scheduled` | Approved and waiting for scheduled time. |
| `publishing` | Currently publishing. |
| `published` | Successfully posted to LinkedIn. |
| `failed` | Publish failed; error saved for review. |

---

## 6. LinkedIn Publishing Flow

### 6.1 Text-only post

```text
validate token
validate scope w_member_social
build UGC post body
POST /v2/ugcPosts
save returned LinkedIn post ID
```

Author:

```text
urn:li:person:<linkedin_user_id>
```

---

### 6.2 Image/video post

LinkedIn media posting requires 3 steps:

```text
1. Register media upload
2. Upload binary media file
3. Create UGC post referencing media asset
```

For image:

```text
urn:li:digitalmediaRecipe:feedshare-image
```

For video:

```text
urn:li:digitalmediaRecipe:feedshare-video
```

---

## 7. Multi-User Model

Each user signs in with LinkedIn.

The app stores:

```text
data/tokens/<linkedin_user_id>.json
```

Each post stores:

```json
{
  "ownerSub": "linkedin_user_id",
  "ownerName": "LinkedIn user name"
}
```

Rules:

- dashboard only shows current user’s posts
- scheduler publishes using the post owner’s token
- daily cap applies per user
- one user cannot publish another user’s drafts

---

## 8. Safety Controls

### 8.1 Dry run

```env
DRY_RUN=true
```

When enabled:

- app validates post
- scheduler can run
- LinkedIn API publish call is skipped
- post is not actually published

---

### 8.2 Daily cap

Default:

```env
MAX_POSTS_PER_DAY=3
```

Purpose:

- prevent accidental high-volume posting
- reduce spam risk
- keep usage closer to normal human behavior

---

### 8.3 Git safety

Never commit:

- `.env`
- `secrets.txt`
- `tunnel-access.txt`
- `data/*.json`
- `data/*.log`
- `uploads/*`

Only commit:

- source code
- docs
- `.env.example`
- `.gitignore`
- `.gitkeep` placeholders

---

## 9. UI Plan

Dashboard sections:

### Header

- app name
- health link
- LinkedIn connected status

### Stats

- total posts
- scheduled posts
- published posts
- failed posts

### Create Draft Card

Fields:

- post text
- media upload
- media title
- media description
- schedule time in IST

### Queue Table

Columns:

- post summary
- status badge
- scheduled time
- actions

Actions:

- approve
- publish now
- schedule
- retry failed post

---

## 10. Error Handling

Errors should be visible in the UI.

Examples:

| Error | Handling |
|---|---|
| Token expired | mark failed, ask user to reconnect LinkedIn |
| Missing `w_member_social` | show scope error |
| LinkedIn 429 | mark failed/rate limit message |
| Media upload failure | mark failed with LinkedIn response |
| Daily cap reached | do not publish, show cap message |

---

## 11. Environment Variables

```env
# LinkedIn app
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REDIRECT_URI=https://your-domain.com/auth/linkedin/callback
LINKEDIN_SCOPES=openid profile email w_member_social

# Server
PORT=3000
HOST=127.0.0.1
SESSION_SECRET=change_me_to_a_long_random_string

# Safety
DRY_RUN=false

# Scheduler
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
MAX_POSTS_PER_DAY=3
```

---

## 12. Testing Plan

### Unit/syntax checks

```bash
npm run check
```

### Manual checks

1. Sign in with LinkedIn.
2. Create text-only draft.
3. Approve and publish manually.
4. Create image draft.
5. Approve and publish manually.
6. Create video draft.
7. Schedule draft 2–3 minutes ahead.
8. Confirm scheduler publishes it.
9. Confirm failed post displays reason.
10. Confirm another LinkedIn user gets separate queue.

### Safety checks

- `.env` ignored by git
- `secrets.txt` ignored
- tokens ignored
- uploaded media ignored
- no access tokens in committed files

---

## 13. Future Extensions

v1 should stay the core publishing engine.

Future modules can build on top:

- v2 Discord URL intake
- AI caption generation
- approval cards in Discord
- analytics/performance tracking
- page/company posting after organization scopes are approved
- recurring content calendar

---

## 14. Final Summary

v1 is the production base for LinkedIn publishing. It handles identity, drafts, media, scheduling, publishing, safety caps, failure states, and multi-user separation. Any future automation should create drafts or intake items inside v1, then let v1 handle approval and publishing safely.
