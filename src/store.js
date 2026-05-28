import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const DATA_DIR = path.join(config.root, 'data');
export const UPLOADS_DIR = path.join(config.root, 'uploads');
const POSTS_PATH = path.join(DATA_DIR, 'posts.json');
const TOKEN_PATH = path.join(DATA_DIR, 'token.json');
const TOKENS_DIR = path.join(DATA_DIR, 'tokens');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.log');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await ensureDataDir();
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function audit(event, details = {}) {
  await ensureDataDir();
  const record = { at: new Date().toISOString(), event, ...details };
  await fs.appendFile(AUDIT_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export async function saveToken(token) {
  const expiresAt = token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null;
  const saved = { ...token, expires_at: expiresAt, saved_at: new Date().toISOString() };
  await writeJson(TOKEN_PATH, saved);
  if (token.linkedin_user?.sub) await saveUserToken(token.linkedin_user.sub, saved);
  await audit('token_saved', { expires_at: expiresAt, linkedinSub: token.linkedin_user?.sub });
}

export async function getToken() {
  return readJson(TOKEN_PATH, null);
}

export async function saveUserToken(ownerSub, token) {
  if (!ownerSub) throw httpError(400, 'Missing LinkedIn user id for token');
  await fs.mkdir(TOKENS_DIR, { recursive: true });
  await fs.writeFile(path.join(TOKENS_DIR, `${safeOwner(ownerSub)}.json`), `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

export async function getUserToken(ownerSub) {
  if (!ownerSub) return null;
  return readJson(path.join(TOKENS_DIR, `${safeOwner(ownerSub)}.json`), null);
}

function safeOwner(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function tokenIsExpired(token, skewMs = 5 * 60 * 1000) {
  return Boolean(token?.expires_at && Date.now() + skewMs >= token.expires_at);
}

export async function listPosts(ownerSub = null) {
  const posts = await readJson(POSTS_PATH, []);
  return ownerSub ? posts.filter((post) => (post.ownerSub || 'legacy') === ownerSub) : posts;
}

export async function getPost(id, ownerSub = null) {
  const posts = await listPosts(ownerSub);
  return posts.find((post) => post.id === id) || null;
}

export async function createPost({ ownerSub = null, ownerName = '', text, scheduledFor = null, mediaPath = null, mediaTitle = '', mediaDescription = '' }) {
  const now = new Date().toISOString();
  const cleanMediaPath = mediaPath ? validateMediaPath(mediaPath) : null;
  const cleanScheduledFor = normalizeScheduledFor(scheduledFor);
  const post = {
    id: crypto.randomUUID(),
    ownerSub: ownerSub || 'legacy',
    ownerName: String(ownerName || '').trim(),
    text: String(text || '').trim(),
    status: 'draft',
    scheduledFor: cleanScheduledFor,
    mediaPath: cleanMediaPath,
    mediaTitle: String(mediaTitle || '').trim(),
    mediaDescription: String(mediaDescription || '').trim(),
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    scheduledAt: null,
    publishAttemptedAt: null,
    publishedAt: null,
    failedAt: null,
    failureReason: null,
    linkedinPostId: null
  };
  validatePostText(post.text);
  const posts = await listPosts();
  posts.unshift(post);
  await writeJson(POSTS_PATH, posts);
  await audit('post_created', { id: post.id, hasMedia: Boolean(post.mediaPath), scheduledFor: post.scheduledFor });
  return post;
}

export async function approvePost(id, ownerSub = null) {
  return updatePost(id, ownerSub, (post) => {
    if (post.status === 'published') throw httpError(409, 'Post is already published');
    validatePostText(post.text);
    if (post.mediaPath) validateMediaPath(post.mediaPath);
    post.status = post.scheduledFor ? 'scheduled' : 'approved';
    post.approvedAt = post.approvedAt || new Date().toISOString();
    post.scheduledAt = post.scheduledFor ? new Date().toISOString() : null;
    post.failureReason = null;
    post.failedAt = null;
  }, 'post_approved');
}

export async function schedulePost(id, scheduledFor, ownerSub = null) {
  const cleanScheduledFor = normalizeScheduledFor(scheduledFor, true);
  return updatePost(id, ownerSub, (post) => {
    if (post.status === 'published') throw httpError(409, 'Post is already published');
    post.scheduledFor = cleanScheduledFor;
    post.status = post.status === 'approved' || post.status === 'scheduled' ? 'scheduled' : post.status;
    post.scheduledAt = post.status === 'scheduled' ? new Date().toISOString() : post.scheduledAt;
  }, 'post_scheduled');
}

export async function markPublishing(id, ownerSub = null) {
  return updatePost(id, ownerSub, (post) => {
    if (!['approved', 'scheduled', 'failed'].includes(post.status)) throw httpError(409, `Post is not publishable from status ${post.status}`);
    if (post.linkedinPostId || post.status === 'published') throw httpError(409, 'Post has already been published');
    post.status = 'publishing';
    post.publishAttemptedAt = new Date().toISOString();
    post.failureReason = null;
  }, 'post_publish_started');
}

export async function markFailed(id, message, details = undefined, ownerSub = null) {
  return updatePost(id, ownerSub, (post) => {
    post.status = 'failed';
    post.failedAt = new Date().toISOString();
    post.failureReason = String(message || 'Unknown publish failure');
    if (details !== undefined) post.failureDetails = details;
  }, 'post_publish_failed');
}

export async function markPublished(id, linkedinPostId, dryRun = false, ownerSub = null) {
  return updatePost(id, ownerSub, (post) => {
    if (dryRun) {
      post.status = post.scheduledFor ? 'scheduled' : 'approved';
      post.dryRunCheckedAt = new Date().toISOString();
      post.dryRunResult = 'passed';
      return;
    }
    post.status = 'published';
    post.publishedAt = new Date().toISOString();
    post.linkedinPostId = linkedinPostId || null;
    post.failureReason = null;
    post.failedAt = null;
  }, dryRun ? 'post_dry_run_passed' : 'post_published');
}

export async function listDueScheduledPosts(now = new Date()) {
  const nowMs = now.getTime();
  const posts = await listPosts();
  return posts
    .filter((post) => post.status === 'scheduled' && post.scheduledFor && Date.parse(post.scheduledFor) <= nowMs)
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}

export async function countPublishedSince(sinceDate, ownerSub = null) {
  const sinceMs = sinceDate.getTime();
  const posts = await listPosts(ownerSub);
  return posts.filter((post) => post.publishedAt && Date.parse(post.publishedAt) >= sinceMs).length;
}

async function updatePost(id, ownerSub, mutator, event) {
  const posts = await readJson(POSTS_PATH, []);
  const post = posts.find((item) => item.id === id && (!ownerSub || (item.ownerSub || 'legacy') === ownerSub));
  if (!post) throw httpError(404, 'Post not found');
  mutator(post);
  post.updatedAt = new Date().toISOString();
  await writeJson(POSTS_PATH, posts);
  await audit(event, { id, ownerSub: post.ownerSub });
  return post;
}

export function validatePostText(text) {
  const clean = String(text || '').trim();
  if (!clean) throw httpError(400, 'Post text is empty');
  if (clean.length > 3000) throw httpError(400, 'Post text is too long for LinkedIn personal posts; keep it under 3000 characters');
}

export function normalizeScheduledFor(value, required = false) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw httpError(400, 'Scheduled time is required');
    return null;
  }

  // Browser datetime-local values have no timezone, e.g. 2026-05-28T10:00.
  // For this app, treat those wall-clock times as IST (UTC+05:30), then store UTC.
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasTimezone ? raw : `${raw}:00+05:30`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw httpError(400, 'Invalid scheduled time');
  return parsed.toISOString();
}

export function validateMediaPath(mediaPath) {
  const clean = String(mediaPath || '').trim();
  if (!clean) throw httpError(400, 'Media path is empty');
  if (clean.includes('\0')) throw httpError(400, 'Invalid media path');
  const resolved = path.resolve(config.root, clean);
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  if (!resolved.startsWith(uploadsRoot + path.sep)) throw httpError(400, 'Media must be uploaded through this app');
  return path.relative(config.root, resolved);
}

export function mediaKind(filePath) {
  const contentType = mediaContentType(filePath);
  return contentType.startsWith('video/') ? 'video' : 'image';
}

export function mediaContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  throw httpError(400, 'Unsupported media type. Use PNG, JPG, JPEG, GIF, MP4, MOV, or WEBM.');
}

export function httpError(status, message, details = undefined) {
  const err = new Error(message);
  err.status = status;
  err.details = details;
  return err;
}
