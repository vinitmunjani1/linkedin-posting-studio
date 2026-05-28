# LinkedIn Posting Automation MVP Plan

## Goal
Build a compliant, safe posting pipeline for one LinkedIn account:

1. Generate/write drafts outside LinkedIn.
2. Review and approve drafts locally.
3. Publish via the official LinkedIn API using `w_member_social`.
4. Log every action and prevent accidental duplicate/spam publishing.

## Architecture

```text
Browser → Local Node app → LinkedIn OAuth → Access token
                         → Draft store JSON
                         → Publish endpoint → LinkedIn UGC Post API
```

## MVP Features

- OAuth login with CSRF `state` validation.
- Token exchange and local token persistence.
- Draft creation UI/API.
- Draft approval before publishing.
- Dry-run mode enabled by default.
- Duplicate publish protection.
- Basic post validation: length, empty text, missing token, missing scope.
- JSON audit log.

## Edge Cases Covered

- Missing `.env` config.
- Redirect URI mismatch.
- OAuth denied/cancelled by user.
- OAuth CSRF/state mismatch.
- LinkedIn token exchange failure.
- Token expiry or revoked token.
- Missing `w_member_social` scope.
- Empty or too-long post text.
- Attempting to publish an unapproved draft.
- Accidental re-publish of an already-published draft.
- Dry-run safety gate.
- LinkedIn API rate limits / 429 responses surfaced clearly.
- LinkedIn API validation errors surfaced with response body.

## Operational Safety

- This only posts through LinkedIn’s API; no anti-detection or browser bypass logic.
- Keep `DRY_RUN=true` until a test draft looks correct.
- Never commit `.env` or client secret.
- Publish only approved posts.

## Next Iteration

- Google Sheets/Airtable draft source.
- AI draft generation.
- Calendar scheduling.
- Image upload support.
- Refresh/re-auth reminders before token expiry.
