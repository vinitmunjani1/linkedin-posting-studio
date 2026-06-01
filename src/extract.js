import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPLOADS_DIR, ensureUploadsDir } from './store.js';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export async function extractUrlPreview(targetUrl) {
  const cleanUrl = normalizeUrl(targetUrl);

  if (isTwitterStatusUrl(cleanUrl)) {
    const twitterPreview = await extractTwitterPreview(cleanUrl);
    if (twitterPreview) return twitterPreview;
  }

  const response = await fetch(cleanUrl, {
    headers: htmlHeaders(),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`URL fetch failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    const mediaPath = await downloadMedia(cleanUrl, contentType);
    const mediaType = mediaKindForExtension(path.extname(mediaPath));
    return buildPreview({ url: cleanUrl, title: path.basename(new URL(cleanUrl).pathname) || cleanUrl, mediaPath, mediaType });
  }

  const html = await response.text();
  return buildHtmlPreview(html, cleanUrl);
}

async function extractTwitterPreview(cleanUrl) {
  const tweet = parseTwitterStatus(cleanUrl);
  if (!tweet?.id) return null;

  const syndicationPreview = await extractTwitterSyndicationPreview(tweet, cleanUrl);
  if (hasUsefulTwitterPreview(syndicationPreview)) return syndicationPreview;

  for (const candidateUrl of twitterMirrorUrls(tweet, cleanUrl)) {
    try {
      const response = await fetch(candidateUrl, { headers: htmlHeaders(), redirect: 'follow' });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) continue;
      const html = await response.text();
      const preview = await buildHtmlPreview(html, cleanUrl, candidateUrl);
      if (hasUsefulTwitterPreview(preview)) return preview;
    } catch {
      // Try the next mirror/fallback. Twitter/X preview availability varies by post.
    }
  }

  return null;
}

async function extractTwitterSyndicationPreview(tweet, cleanUrl) {
  try {
    const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweet.id)}&lang=en`;
    const response = await fetch(apiUrl, {
      headers: { ...htmlHeaders(), Referer: 'https://platform.twitter.com/' },
      redirect: 'follow'
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || !Object.keys(payload).length) return null;

    const text = sanitize(payload.text || payload.full_text || payload.card?.binding_values?.description?.string_value || '');
    const author = sanitize(payload.user?.name || payload.user?.screen_name || tweet.username || 'Twitter/X');
    const title = text ? `${author} on X` : `X post by ${author}`;
    const mediaUrl = firstTwitterMediaUrl(payload);
    const downloaded = await tryDownloadMedia(mediaUrl);
    return buildPreview({
      url: cleanUrl,
      title,
      description: text,
      mediaPath: downloaded?.mediaPath || null,
      mediaType: downloaded?.mediaType || null
    });
  } catch {
    return null;
  }
}

function firstTwitterMediaUrl(payload) {
  const candidates = [];
  for (const photo of payload.photos || []) candidates.push(photo.url || photo.image_url);
  for (const media of payload.mediaDetails || []) {
    candidates.push(media.media_url_https || media.media_url);
    const variants = [...(media.video_info?.variants || [])]
      .filter((variant) => /video\/mp4/i.test(variant.content_type || '') && variant.url)
      .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
    if (variants[0]?.url) candidates.push(variants[0].url);
  }
  const cardValues = payload.card?.binding_values || {};
  for (const value of Object.values(cardValues)) {
    candidates.push(value?.image_value?.url, value?.string_value);
  }
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) || null;
}

function twitterMirrorUrls(tweet, cleanUrl) {
  const original = new URL(cleanUrl);
  const pathName = original.pathname.replace(/^\//, '');
  const userPath = tweet.username ? `${tweet.username}/status/${tweet.id}` : pathName;
  return [
    cleanUrl,
    `https://fixupx.com/${userPath}`,
    `https://fxtwitter.com/${userPath}`,
    `https://vxtwitter.com/${userPath}`,
    `https://nitter.net/${userPath}`
  ];
}

function parseTwitterStatus(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['twitter.com', 'x.com', 'mobile.twitter.com', 'm.twitter.com'].includes(host)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const statusIndex = parts.findIndex((part) => ['status', 'statuses'].includes(part.toLowerCase()));
    if (statusIndex < 0 || !/^\d+$/.test(parts[statusIndex + 1] || '')) return null;
    return { username: parts[statusIndex - 1] || '', id: parts[statusIndex + 1] };
  } catch {
    return null;
  }
}

function isTwitterStatusUrl(value) {
  return Boolean(parseTwitterStatus(value));
}

function hasUsefulTwitterPreview(preview) {
  if (!preview) return false;
  if (preview.mediaPath) return true;
  const title = String(preview.title || '').trim().toLowerCase();
  const description = String(preview.description || '').trim().toLowerCase();
  const text = `${title} ${description}`.trim();
  if (!text || description.length < 8) return false;
  return !/(failed to scan|javascript is not available|enable javascript|log in to x|x\.com|^x$|^twitter$)/i.test(text);
}

async function buildHtmlPreview(html, cleanUrl, mediaBaseUrl = cleanUrl) {
  const title = pickMeta(html, ['og:title', 'twitter:title']) || pickTitle(html) || cleanUrl;
  const description = pickMeta(html, ['og:description', 'twitter:description', 'description']) || '';
  const image = absolutize(pickMeta(html, ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']), mediaBaseUrl);
  const video = absolutize(pickMeta(html, ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream']), mediaBaseUrl);
  const mediaUrl = bestDownloadableMediaUrl(video, image);
  const downloaded = await tryDownloadMedia(mediaUrl);

  return buildPreview({
    url: cleanUrl,
    title,
    description,
    mediaPath: downloaded?.mediaPath || null,
    mediaType: downloaded?.mediaType || null
  });
}

function bestDownloadableMediaUrl(video, image) {
  if (video && !/\.m3u8(?:$|[?#])/i.test(video)) return video;
  return image || null;
}

async function tryDownloadMedia(mediaUrl) {
  if (!mediaUrl) return null;
  try {
    const mediaPath = await downloadMedia(mediaUrl);
    return { mediaPath, mediaType: mediaKindForExtension(path.extname(mediaPath)) };
  } catch {
    return null;
  }
}

function buildPreview({ url, title, description = '', mediaPath = null, mediaType = null }) {
  return {
    sourceUrl: url,
    title: sanitize(title),
    description: sanitize(description),
    mediaPath,
    mediaType,
    caption: draftCaption({ title, description, url })
  };
}

function draftCaption({ title, description, url }) {
  const cleanTitle = sanitize(title);
  const cleanDescription = sanitize(description);
  const lines = [];
  if (cleanTitle) lines.push(cleanTitle);
  if (cleanDescription && cleanDescription !== cleanTitle) lines.push('', cleanDescription.slice(0, 500));
  lines.push('', `Source: ${url}`);
  return lines.join('\n').trim();
}

async function downloadMedia(mediaUrl, providedContentType = '') {
  const response = await fetch(mediaUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/mp4,video/*,*/*;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`Media fetch failed: ${response.status}`);
  const contentType = providedContentType || response.headers.get('content-type') || '';
  const ext = extensionFor(contentType, mediaUrl);
  if (!ext) throw new Error(`Unsupported media type: ${contentType}`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) throw new Error('Media too large');
  await ensureUploadsDir();
  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, Buffer.from(arrayBuffer), { mode: 0o600 });
  return path.join('uploads', filename);
}

function extensionFor(contentType, mediaUrl) {
  const lower = String(contentType).toLowerCase();
  if (lower.includes('image/png')) return '.png';
  if (lower.includes('image/jpeg') || lower.includes('image/jpg')) return '.jpg';
  if (lower.includes('image/gif')) return '.gif';
  if (lower.includes('video/mp4')) return '.mp4';
  if (lower.includes('video/quicktime')) return '.mov';
  if (lower.includes('video/webm')) return '.webm';
  const url = new URL(mediaUrl);
  const format = (url.searchParams.get('format') || url.searchParams.get('fm') || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'mp4', 'mov', 'webm'].includes(format)) return `.${format === 'jpeg' ? 'jpg' : format}`;
  const ext = path.extname(url.pathname).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm'].includes(ext) ? ext : null;
}

function mediaKindForExtension(ext) {
  return ['.mp4', '.mov', '.webm'].includes(String(ext).toLowerCase()) ? 'video' : 'image';
}

function normalizeUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported');
  return url.toString();
}

function pickMeta(html, names) {
  const metas = parseMetaTags(html);
  for (const name of names) {
    const value = metas.get(name.toLowerCase());
    if (value) return value;
  }
  return '';
}

function parseMetaTags(html) {
  const metas = new Map();
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content;
    if (key && content && !metas.has(key)) metas.set(key, decodeHtml(content));
  }
  return metas;
}

function parseAttributes(tag) {
  const attrs = {};
  const attrPattern = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of tag.matchAll(attrPattern)) attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  return attrs;
}

function pickTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtml(match[1]) : '';
}

function absolutize(value, base) {
  if (!value) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

function htmlHeaders() {
  return {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9'
  };
}

function sanitize(value) {
  return decodeHtml(String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
