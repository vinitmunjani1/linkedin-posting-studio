import path from 'node:path';
import { config } from './config.js';
import { publishMediaPost, publishTextPost } from './linkedin.js';
import { countPublishedSince, getPost, getToken, getUserToken, markFailed, markPublished, markPublishing, tokenIsExpired, validateMediaPath, validatePostText, httpError } from './store.js';

export async function publishFromPostId(id, { ownerSub = null, scheduler = false } = {}) {
  const post = await getPost(id, ownerSub);
  if (!post) throw httpError(404, 'Post not found');
  if (!['approved', 'scheduled', 'failed'].includes(post.status)) throw httpError(409, 'Post must be approved or scheduled before publishing');
  if (post.linkedinPostId || post.status === 'published') throw httpError(409, 'Post has already been published');
  if (scheduler && post.scheduledFor && Date.parse(post.scheduledFor) > Date.now()) throw httpError(409, 'Scheduled time has not arrived yet');
  validatePostText(post.text);

  const publishedToday = await countPublishedSince(startOfUtcDay(new Date()), post.ownerSub);
  if (!config.dryRun && publishedToday >= config.maxPostsPerDay) {
    throw httpError(429, `Daily publish cap reached (${publishedToday}/${config.maxPostsPerDay}). Increase MAX_POSTS_PER_DAY only if intentional.`);
  }

  const token = await getUserToken(post.ownerSub) || await getToken();
  if (!token?.access_token) throw httpError(401, 'Connect LinkedIn first');
  if (tokenIsExpired(token)) throw httpError(401, 'LinkedIn access token is expired or near expiry; reconnect LinkedIn');
  if (token.scope && !String(token.scope).split(/[\s,]+/).includes('w_member_social')) {
    throw httpError(403, 'Access token does not include w_member_social; reconnect with the correct scope');
  }

  const authorId = token.linkedin_user?.sub;
  if (!authorId) throw httpError(500, 'No LinkedIn author id saved; reconnect LinkedIn');
  if (post.mediaPath) validateMediaPath(post.mediaPath);
  await markPublishing(id, post.ownerSub);

  try {
    if (config.dryRun) return markPublished(id, 'DRY_RUN_ONLY', true, post.ownerSub);
    const result = post.mediaPath
      ? await publishMediaPost({
          accessToken: token.access_token,
          authorId,
          text: post.text,
          mediaPath: path.resolve(config.root, post.mediaPath),
          title: post.mediaTitle,
          description: post.mediaDescription
        })
      : await publishTextPost({ accessToken: token.access_token, authorId, text: post.text });
    return markPublished(id, result.linkedinPostId, false, post.ownerSub);
  } catch (error) {
    await markFailed(id, error.message, error.details, post.ownerSub);
    throw error;
  }
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
