import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { httpError, mediaContentType, mediaKind, validatePostText } from './store.js';

export function buildAuthUrl() {
  const state = crypto.randomBytes(24).toString('hex');
  const url = new URL(config.linkedin.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.linkedin.clientId);
  url.searchParams.set('redirect_uri', config.linkedin.redirectUri);
  url.searchParams.set('scope', config.linkedin.scopes.join(' '));
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

export async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.linkedin.redirectUri,
    client_id: config.linkedin.clientId,
    client_secret: config.linkedin.clientSecret
  });
  const response = await fetch(config.linkedin.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw httpError(response.status, 'LinkedIn token exchange failed. Check redirect URI, client credentials, and scopes.', payload);
  }
  return payload;
}

export async function getUserInfo(accessToken) {
  const response = await fetch(config.linkedin.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await readPayload(response);
  if (!response.ok) throw httpError(response.status, 'Failed to fetch LinkedIn user info', payload);
  if (!payload.sub) throw httpError(502, 'LinkedIn userinfo response did not include sub/member id', payload);
  return payload;
}

export async function publishTextPost({ accessToken, authorId, text }) {
  validatePostText(text);
  return createUgcPost({ accessToken, authorId, text, media: null });
}

export async function publishMediaPost({ accessToken, authorId, text, mediaPath, title = '', description = '' }) {
  validatePostText(text);
  const kind = mediaKind(mediaPath);
  const owner = `urn:li:person:${authorId}`;
  const { asset, uploadUrl } = await registerMediaUpload({ accessToken, owner, kind });
  await uploadMediaBinary({ accessToken, uploadUrl, mediaPath });
  return createUgcPost({
    accessToken,
    authorId,
    text,
    media: {
      kind,
      asset,
      title: title || (kind === 'video' ? 'Video' : 'Image'),
      description: description || title || `LinkedIn ${kind}`
    }
  });
}

// Backward-compatible alias.
export const publishImagePost = publishMediaPost;

async function registerMediaUpload({ accessToken, owner, kind }) {
  const response = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [kind === 'video' ? 'urn:li:digitalmediaRecipe:feedshare-video' : 'urn:li:digitalmediaRecipe:feedshare-image'],
        owner,
        serviceRelationships: [
          { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }
        ]
      }
    })
  });
  const payload = await readPayload(response);
  if (!response.ok) throw httpError(response.status, `LinkedIn ${kind} upload registration failed.`, payload);
  const uploadUrl = payload?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
  const asset = payload?.value?.asset;
  if (!uploadUrl || !asset) throw httpError(502, 'LinkedIn upload registration response missing uploadUrl or asset', payload);
  return { uploadUrl, asset };
}

async function uploadMediaBinary({ accessToken, uploadUrl, mediaPath }) {
  const bytes = await fs.readFile(mediaPath);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mediaContentType(mediaPath)
    },
    body: bytes
  });
  const payload = await readPayload(response);
  if (!response.ok) throw httpError(response.status, 'LinkedIn media binary upload failed.', payload);
  return payload;
}

async function createUgcPost({ accessToken, authorId, text, media }) {
  const shareContent = {
    shareCommentary: { text },
    shareMediaCategory: media ? media.kind.toUpperCase() : 'NONE'
  };
  if (media) {
    shareContent.media = [{
      status: 'READY',
      media: media.asset,
      title: { text: media.title },
      description: { text: media.description }
    }];
  }

  const body = {
    author: `urn:li:person:${authorId}`,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
  };

  const response = await fetch(config.linkedin.ugcPostsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify(body)
  });

  const payload = await readPayload(response);
  if (!response.ok) {
    const message = response.status === 429
      ? 'LinkedIn rate limit hit; wait before retrying.'
      : 'LinkedIn post publish failed.';
    throw httpError(response.status, message, payload);
  }

  return {
    linkedinPostId: response.headers.get('x-restli-id') || payload.id || null,
    response: payload
  };
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
