import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENV_PATH = path.join(ROOT, '.env');

export function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  dryRun: String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  schedulerEnabled: String(process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60_000),
  maxPostsPerDay: Number(process.env.MAX_POSTS_PER_DAY || 3),
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    channelId: process.env.DISCORD_CHANNEL_ID || '',
    intakeSecret: process.env.DISCORD_INTAKE_SECRET || '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || ''
  },
  linkedin: {
    allowedSub: process.env.LINKEDIN_ALLOWED_SUB || '',
    allowedEmail: process.env.LINKEDIN_ALLOWED_EMAIL || '',
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
    redirectUri: process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/auth/linkedin/callback',
    scopes: (process.env.LINKEDIN_SCOPES || 'openid profile email w_member_social').split(/\s+/).filter(Boolean),
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userInfoUrl: 'https://api.linkedin.com/v2/userinfo',
    ugcPostsUrl: 'https://api.linkedin.com/v2/ugcPosts'
  }
};

export function validateConfig() {
  const missing = [];
  if (!config.linkedin.clientId) missing.push('LINKEDIN_CLIENT_ID');
  if (!config.linkedin.clientSecret) missing.push('LINKEDIN_CLIENT_SECRET');
  if (!config.linkedin.redirectUri) missing.push('LINKEDIN_REDIRECT_URI');
  if (!config.linkedin.scopes.includes('w_member_social')) missing.push('LINKEDIN_SCOPES must include w_member_social');
  return missing;
}
