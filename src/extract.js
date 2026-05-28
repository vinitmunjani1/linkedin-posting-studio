import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPLOADS_DIR, ensureUploadsDir } from './store.js';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export async function extractUrlPreview(targetUrl) {
  const cleanUrl = normalizeUrl(targetUrl);
  const response = await fetch(cleanUrl, {
    headers: {
      'User-Agent': 'LinkedInPostingStudio/0.2 (+https://example.local)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`URL fetch failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    const mediaPath = await downloadMedia(cleanUrl, contentType);
    return buildPreview({ url: cleanUrl, title: path.basename(new URL(cleanUrl).pathname) || cleanUrl, mediaPath });
  }

  const html = await response.text();
  const title = pickMeta(html, ['og:title', 'twitter:title']) || pickTitle(html) || cleanUrl;
  const description = pickMeta(html, ['og:description', 'twitter:description', 'description']) || '';
  const image = absolutize(pickMeta(html, ['og:image', 'twitter:image', 'twitter:image:src']), cleanUrl);
  const video = absolutize(pickMeta(html, ['og:video', 'og:video:url', 'twitter:player:stream']), cleanUrl);
  const mediaUrl = video || image;
  let mediaPath = null;
  let mediaType = null;
  if (mediaUrl) {
    try {
      mediaPath = await downloadMedia(mediaUrl);
      mediaType = video ? 'video' : 'image';
    } catch {
      mediaPath = null;
      mediaType = null;
    }
  }

  return buildPreview({ url: cleanUrl, title, description, mediaPath, mediaType });
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
  const response = await fetch(mediaUrl, { redirect: 'follow', headers: { 'User-Agent': 'LinkedInPostingStudio/0.2' } });
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
  const ext = path.extname(new URL(mediaUrl).pathname).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm'].includes(ext) ? ext : null;
}

function normalizeUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported');
  return url.toString();
}

function pickMeta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, 'i')
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeHtml(match[1]);
    }
  }
  return '';
}

function pickTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtml(match[1]) : '';
}

function absolutize(value, base) {
  if (!value) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

function sanitize(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ').trim());
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
