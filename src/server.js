import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, validateConfig } from './config.js';
import { extractUrlPreview } from './extract.js';
import { buildAuthUrl, exchangeCodeForToken, getUserInfo, publishMediaPost, publishTextPost } from './linkedin.js';
import { UPLOADS_DIR, approveIntake, approvePost, audit, countPublishedSince, createIntake, createPost, ensureUploadsDir, getPost, getToken, getUserToken, listDueScheduledPosts, listIntake, listPosts, markFailed, markPublished, markPublishing, rejectIntake, saveToken, schedulePost, tokenIsExpired, validateMediaPath, validatePostText, httpError } from './store.js';

const sessions = new Map();

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function makeSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, {});
  return sid;
}

function getSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const raw = cookies.sid;
  if (raw) {
    const [sid, sig] = raw.split('.');
    if (sid && sig && sign(sid) === sig && sessions.has(sid)) return sessions.get(sid);
  }
  const sid = makeSession();
  res.setHeader('Set-Cookie', `sid=${sid}.${sign(sid)}; HttpOnly; SameSite=Lax; Path=/`);
  return sessions.get(sid);
}

const server = http.createServer(async (req, res) => {
  const session = getSession(req, res);
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${config.port}`}`);

  try {
    if (req.method === 'GET' && url.pathname === '/login') return await loginPage(res, url);
    if (req.method === 'POST' && url.pathname === '/login') return redirect(res, '/auth/linkedin');
    if (!isAllowed(req, url, session)) return redirect(res, '/login?next=' + encodeURIComponent(url.pathname));

    if (req.method === 'GET' && url.pathname === '/') return html(res, await homeHtml(url, session));
    if (req.method === 'GET' && url.pathname === '/health') return json(res, { ok: true, dryRun: config.dryRun, schedulerEnabled: config.schedulerEnabled, maxPostsPerDay: config.maxPostsPerDay, missingConfig: validateConfig() });
    if (req.method === 'GET' && url.pathname === '/auth/linkedin') return startAuth(res, session);
    if (req.method === 'GET' && url.pathname === '/auth/linkedin/callback') return await handleCallback(url, res, session);
    if (req.method === 'GET' && url.pathname === '/posts') return json(res, await listPosts(session.linkedinSub));
    if (req.method === 'GET' && url.pathname === '/intake') return json(res, await listIntake(session.linkedinSub));
    if (req.method === 'POST' && url.pathname === '/intake/form') return await handleIntakeForm(req, res, session);
    if (req.method === 'POST' && url.pathname === '/api/v2/intake/url') return json(res, await handleIntakeApi(req), 201);
    if (req.method === 'POST' && url.pathname === '/drafts/form') return await handleDraftForm(req, res, session);
    if (req.method === 'POST' && url.pathname === '/uploads') return json(res, await handleUpload(req), 201);
    if (req.method === 'POST' && url.pathname === '/posts') return json(res, await createPost({ ...(await readJsonBody(req)), ownerSub: session.linkedinSub, ownerName: session.linkedinName }), 201);

    const approveMatch = req.method === 'POST' && url.pathname.match(/^\/posts\/([^/]+)\/approve$/);
    if (approveMatch) return json(res, await approvePost(approveMatch[1], session.linkedinSub));

    const scheduleMatch = req.method === 'POST' && url.pathname.match(/^\/posts\/([^/]+)\/schedule$/);
    if (scheduleMatch) return json(res, await schedulePost(scheduleMatch[1], (await readFormOrJsonBody(req)).scheduledFor, session.linkedinSub));

    const intakeApproveMatch = req.method === 'POST' && url.pathname.match(/^\/intake\/([^/]+)\/approve$/);
    if (intakeApproveMatch) return json(res, await approveIntake(intakeApproveMatch[1], { ownerSub: session.linkedinSub, ownerName: session.linkedinName, scheduledFor: (await readFormOrJsonBody(req)).scheduledFor }));

    const intakeRejectMatch = req.method === 'POST' && url.pathname.match(/^\/intake\/([^/]+)\/reject$/);
    if (intakeRejectMatch) return json(res, await rejectIntake(intakeRejectMatch[1], session.linkedinSub));

    const publishMatch = req.method === 'POST' && url.pathname.match(/^\/posts\/([^/]+)\/publish$/);
    if (publishMatch) return json(res, await publishPost(publishMatch[1], { manual: true, ownerSub: session.linkedinSub }));

    throw httpError(404, 'Not found');
  } catch (error) {
    await audit('request_error', { path: url.pathname, status: error.status || 500, message: error.message });
    return json(res, { error: error.message, details: error.details }, error.status || 500);
  }
});

function startAuth(res, session) {
  const missing = validateConfig();
  if (missing.length) throw httpError(400, `Missing config: ${missing.join(', ')}`);
  const { url, state } = buildAuthUrl();
  session.oauthState = state;
  res.writeHead(302, { Location: url });
  res.end();
}

async function assertAllowedLinkedInUser(user) {
  const existingToken = await getToken();
  const allowedSub = config.linkedin.allowedSub || existingToken?.linkedin_user?.sub || '';
  const allowedEmail = config.linkedin.allowedEmail || existingToken?.linkedin_user?.email || '';
  if (allowedSub && user.sub !== allowedSub) {
    throw httpError(403, 'This LinkedIn account is not allowed for this app. Sign in with the originally connected account.');
  }
  if (allowedEmail && user.email && user.email !== allowedEmail) {
    throw httpError(403, 'This LinkedIn email is not allowed for this app.');
  }
}

async function handleCallback(url, res, session) {
  if (url.searchParams.get('error')) {
    throw httpError(400, `LinkedIn OAuth failed: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!code) throw httpError(400, 'Missing OAuth code');
  if (!state || state !== session.oauthState) throw httpError(400, 'OAuth state mismatch; restart login');
  delete session.oauthState;

  const token = await exchangeCodeForToken(code);
  const user = await getUserInfo(token.access_token);
  await saveToken({ ...token, linkedin_user: user });
  session.authed = true;
  session.linkedinSub = user.sub;
  session.linkedinName = user.name || user.email || user.sub;
  await audit('oauth_connected', { linkedinSub: user.sub });

  res.writeHead(302, { Location: '/?connected=1' });
  res.end();
}

async function publishPost(id, { manual = false, scheduler = false, ownerSub = null } = {}) {
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
  if (!token?.access_token) throw httpError(401, 'Connect LinkedIn first at /auth/linkedin');
  if (tokenIsExpired(token)) throw httpError(401, 'LinkedIn access token is expired or near expiry; reconnect at /auth/linkedin');
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

async function homeHtml(url = new URL('http://localhost/'), session = {}) {
  const posts = await listPosts(session.linkedinSub);
  const intakeItems = await listIntake(session.linkedinSub);
  const token = await getUserToken(session.linkedinSub) || await getToken();
  const missing = validateConfig();
  const counts = posts.reduce((acc, post) => {
    acc.total += 1;
    acc[post.status] = (acc[post.status] || 0) + 1;
    return acc;
  }, { total: 0 });
  const nextScheduled = posts
    .filter((post) => post.status === 'scheduled' && post.scheduledFor)
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
  const isLinkedInConnected = Boolean(token?.access_token) && !tokenIsExpired(token);
  const connectLabel = isLinkedInConnected ? `Connected: ${escapeHtml(token.linkedin_user?.name || 'LinkedIn')}` : 'Connect LinkedIn';

  const intakeRows = intakeItems.slice(0, 8).map((item) => `
    <tr>
      <td><div class="post-text">${escapeHtml(item.title || item.sourceUrl)}</div><div class="post-meta">${escapeHtml(item.source)} · ${escapeHtml(item.sourceUrl)}</div></td>
      <td><span class="badge status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
      <td>${escapeHtml(item.caption || '').slice(0, 220)}</td>
      <td class="actions-cell"><button class="btn btn-primary" onclick="call('/intake/${item.id}/approve')">Approve to draft</button><button class="btn btn-secondary" onclick="call('/intake/${item.id}/reject')">Reject</button></td>
    </tr>`).join('');

  const rows = posts.map((post) => `
    <tr>
      <td>
        <div class="post-text">${escapeHtml(post.text).replace(/\n/g, '<br>')}</div>
        <div class="post-meta"><span>ID</span> <code>${escapeHtml(post.id.slice(0, 8))}</code>${post.mediaPath ? ` · <span>Media</span> ${escapeHtml(post.mediaPath.split('/').pop())}` : ''}</div>
      </td>
      <td><span class="badge status-${escapeHtml(post.status)}">${escapeHtml(post.status)}</span>${post.failureReason ? `<div class="error-box">${escapeHtml(post.failureReason)}</div>` : ''}</td>
      <td>${post.scheduledFor ? `<strong>${escapeHtml(formatDateTimeLocal(post.scheduledFor))}</strong><div class="post-meta">IST</div>` : '<span class="muted">Not scheduled</span>'}</td>
      <td class="actions-cell">
        <button class="btn btn-secondary" onclick="call('/posts/${post.id}/approve')">Approve</button>
        <button class="btn btn-primary" onclick="call('/posts/${post.id}/publish')">Publish now${config.dryRun ? ' dry-run' : ''}</button>
        <form class="inline-form" onsubmit="schedule(event, '${post.id}')">
          <input name="scheduledFor" type="datetime-local" value="${post.scheduledFor ? escapeHtml(formatDateTimeLocal(post.scheduledFor)) : ''}" aria-label="Schedule time IST">
          <button class="btn btn-secondary" type="submit">Schedule</button>
        </form>
      </td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LinkedIn Posting Studio</title>
<style>
:root{--bg:#f6f8fb;--panel:#fff;--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:#0a66c2;--brand-dark:#064f97;--good:#047857;--warn:#b45309;--bad:#b91c1c;--shadow:0 18px 50px rgba(15,23,42,.08)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#e8f2ff,transparent 34rem),var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45}.shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:32px 0 48px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}.eyebrow{color:var(--brand);font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;margin:0 0 8px}.hero h1{font-size:clamp(30px,5vw,56px);line-height:1;margin:0 0 12px;letter-spacing:-.05em}.hero p{margin:0;color:var(--muted);max-width:680px}.top-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}.grid{display:grid;grid-template-columns:1fr 1.35fr;gap:20px}.card{background:rgba(255,255,255,.88);border:1px solid rgba(229,231,235,.9);border-radius:24px;box-shadow:var(--shadow);backdrop-filter:blur(10px)}.card-head{padding:22px 22px 0}.card-body{padding:22px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}.stat{padding:16px;border-radius:18px;background:var(--panel);border:1px solid var(--line)}.stat span{display:block;color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.stat strong{display:block;font-size:26px;letter-spacing:-.04em;margin-top:4px}.status-strip{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:#fff;border-radius:999px;padding:8px 12px;color:#374151;font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}label{display:block;font-weight:700;font-size:13px;margin:14px 0 7px}textarea,input{width:100%;border:1px solid var(--line);background:#fff;border-radius:14px;padding:12px 14px;font:inherit;color:var(--ink);outline:none;transition:.15s border,.15s box-shadow}textarea{min-height:190px;resize:vertical}input:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(10,102,194,.12)}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.btn{appearance:none;border:0;border-radius:999px;padding:10px 15px;font-weight:800;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:.15s transform,.15s background,.15s border}.btn:hover{transform:translateY(-1px)}.btn-primary{background:var(--brand);color:#fff}.btn-primary:hover{background:var(--brand-dark)}.btn-secondary{background:#fff;color:#111827;border:1px solid var(--line)}.btn-connected{background:#ecfdf5;color:#166534;border:1px solid #bbf7d0}.btn-connected:before{content:'✓';font-weight:900}.btn-wide{width:100%;margin-top:16px;padding:13px 18px}.warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:16px;padding:14px 16px;margin:16px 0}.success{background:#ecfdf5;border:1px solid #bbf7d0;color:#166534;border-radius:16px;padding:14px 16px;margin:16px 0}.table-wrap{overflow:auto}.posts-table{width:100%;border-collapse:separate;border-spacing:0 10px}.posts-table th{text-align:left;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;padding:0 12px 6px}.posts-table td{background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 12px;vertical-align:top}.posts-table td:first-child{border-left:1px solid var(--line);border-radius:16px 0 0 16px}.posts-table td:last-child{border-right:1px solid var(--line);border-radius:0 16px 16px 0}.post-text{font-weight:700;max-width:420px}.post-meta,.muted{color:var(--muted);font-size:12px;margin-top:6px}.post-meta span{font-weight:800;text-transform:uppercase;letter-spacing:.06em}.badge{display:inline-flex;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.06em}.status-draft{background:#f3f4f6;color:#374151}.status-approved{background:#ecfdf5;color:#047857}.status-scheduled{background:#eff6ff;color:#1d4ed8}.status-publishing{background:#fef3c7;color:#92400e}.status-published{background:#dcfce7;color:#166534}.status-failed{background:#fee2e2;color:#991b1b}.error-box{margin-top:8px;color:var(--bad);font-size:12px;max-width:260px}.actions-cell{min-width:260px}.inline-form{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}.empty{padding:28px;text-align:center;color:var(--muted)}code{font-size:12px;background:#f3f4f6;border-radius:6px;padding:2px 5px}@media(max-width:900px){.hero,.grid{display:block}.top-actions{justify-content:flex-start;margin-top:16px}.stats{grid-template-columns:repeat(2,1fr)}.card{margin-bottom:18px}.form-row{grid-template-columns:1fr}.inline-form{grid-template-columns:1fr}.posts-table{min-width:760px}}
</style></head>
<body><main class="shell">
  <section class="hero">
    <div><p class="eyebrow">LinkedIn Automation · v1 Scheduler</p><h1>Posting Studio</h1><p>Create text, image, or video posts, approve them safely, and schedule publishing in IST.</p></div>
    <div class="top-actions"><a class="btn ${isLinkedInConnected ? 'btn-connected' : 'btn-secondary'}" href="/auth/linkedin">${connectLabel}</a><a class="btn btn-primary" href="/health">Health</a></div>
  </section>

  <section class="stats" aria-label="Post summary">
    <div class="stat"><span>Total</span><strong>${counts.total}</strong></div>
    <div class="stat"><span>Scheduled</span><strong>${counts.scheduled || 0}</strong></div>
    <div class="stat"><span>Published</span><strong>${counts.published || 0}</strong></div>
    <div class="stat"><span>Failed</span><strong>${counts.failed || 0}</strong></div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="card-head"><h2>Create draft</h2><p class="muted">Schedule time is IST. Leave empty to approve/publish manually.</p></div>
      <div class="card-body">
        ${url.searchParams.get('connected') ? `<div class="success"><b>LinkedIn connected.</b> OAuth token saved successfully.</div>` : ''}
        ${missing.length ? `<div class="warn"><b>Missing config:</b> ${escapeHtml(missing.join(', '))}. Copy <code>.env.example</code> to <code>.env</code>.</div>` : ''}
        <div class="status-strip">
          <span class="pill"><span class="dot ${config.dryRun ? 'warn' : ''}"></span>${config.dryRun ? 'Dry run' : 'Live publishing'}</span>
          <span class="pill"><span class="dot ${config.schedulerEnabled ? '' : 'bad'}"></span>Scheduler ${config.schedulerEnabled ? 'on' : 'off'}</span>
          <span class="pill">Cap ${config.maxPostsPerDay}/day</span>
          <span class="pill">${token?.access_token ? `Connected: ${escapeHtml(token.linkedin_user?.name || 'LinkedIn')}` : 'LinkedIn not connected'}</span>
        </div>
        <form method="post" action="/drafts/form" enctype="multipart/form-data">
          <label for="text">Post content</label>
          <textarea id="text" name="text" maxlength="3000" placeholder="Write your LinkedIn post..." required></textarea>
          <label for="image">Media</label>
          <input id="image" name="image" type="file" accept="image/png,image/jpeg,image/gif,video/mp4,video/quicktime,video/webm">
          <div class="form-row">
            <div><label for="mediaTitle">Media title</label><input id="mediaTitle" name="mediaTitle" placeholder="Optional"></div>
            <div><label for="scheduledFor">Schedule time (IST)</label><input id="scheduledFor" name="scheduledFor" type="datetime-local"></div>
          </div>
          <label for="mediaDescription">Media description</label>
          <input id="mediaDescription" name="mediaDescription" placeholder="Optional alt/context text">
          <button class="btn btn-primary btn-wide" type="submit">Save draft</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>v2 Intake</h2><p class="muted">Paste a URL or let Discord create these items. Approve to turn into a v1 draft.</p></div>
      <div class="card-body">
        <form method="post" action="/intake/form">
          <label for="sourceUrl">URL</label>
          <input id="sourceUrl" name="sourceUrl" type="url" placeholder="https://example.com/post" required>
          <button class="btn btn-primary btn-wide" type="submit">Extract URL</button>
        </form>
        <div class="table-wrap" style="margin-top:18px"><table class="posts-table"><thead><tr><th>Source</th><th>Status</th><th>Caption draft</th><th>Actions</th></tr></thead><tbody>${intakeRows || '<tr><td class="empty" colspan="4">No intake items yet.</td></tr>'}</tbody></table></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Queue</h2><p class="muted">${nextScheduled ? `Next scheduled: ${escapeHtml(formatDateTimeLocal(nextScheduled.scheduledFor))} IST` : 'No scheduled posts yet.'}</p></div>
      <div class="card-body table-wrap">
        <table class="posts-table"><thead><tr><th>Post</th><th>Status</th><th>Scheduled</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td class="empty" colspan="4">No drafts yet. Create your first post on the left.</td></tr>'}</tbody></table>
      </div>
    </div>
  </section>
</main>
<script>
async function call(path){
  const r = await fetch(path,{method:'POST'});
  alert(JSON.stringify(await r.json(), null, 2)); location.reload();
}
async function schedule(event, id){
  event.preventDefault();
  const scheduledFor = event.target.scheduledFor.value;
  const r = await fetch('/posts/'+id+'/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scheduledFor})});
  alert(JSON.stringify(await r.json(), null, 2)); location.reload();
}
</script>
</body></html>`;
}



async function handleIntakeForm(req, res, session = {}) {
  const body = await readFormBody(req);
  const preview = await extractUrlPreview(body.sourceUrl);
  await createIntake({ ...preview, source: 'manual', ownerSub: session.linkedinSub, ownerName: session.linkedinName });
  return redirect(res, '/');
}

async function handleIntakeApi(req) {
  if (config.discord.intakeSecret) {
    const provided = req.headers['x-intake-secret'] || '';
    if (provided !== config.discord.intakeSecret) throw httpError(401, 'Invalid intake secret');
  }
  const body = await readJsonBody(req);
  const preview = await extractUrlPreview(body.url || body.sourceUrl);
  return createIntake({
    ...preview,
    source: body.source || 'api',
    ownerSub: body.ownerSub || null,
    ownerName: body.ownerName || '',
    discord: body.discord || null
  });
}

async function handleDraftForm(req, res, session = {}) {
  const form = await readMultipartForm(req);
  const saved = form.file ? await saveUploadedImage(form.file) : null;
  const post = await createPost({
    text: form.fields.text,
    scheduledFor: form.fields.scheduledFor || null,
    mediaPath: saved?.mediaPath || null,
    mediaTitle: form.fields.mediaTitle || '',
    mediaDescription: form.fields.mediaDescription || '',
    ownerSub: session.linkedinSub || null,
    ownerName: session.linkedinName || ''
  });
  await audit('draft_form_saved', { id: post.id, hasMedia: Boolean(saved) });
  return redirect(res, '/');
}

async function readMultipartForm(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw httpError(400, 'Expected multipart/form-data');
  const boundary = Buffer.from('--' + boundaryMatch[1]);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (body.length > 220 * 1024 * 1024) throw httpError(400, 'Upload too large; keep media under 200MB');
  const parts = splitMultipart(body, boundary);
  const fields = {};
  let file = null;
  for (const part of parts) {
    const name = (part.headers.match(/name="([^"]+)"/) || [])[1];
    if (!name) continue;
    const filename = (part.headers.match(/filename="([^"]*)"/) || [])[1];
    if (filename) {
      if (name === 'image' && part.data.length) file = { filename, data: part.data };
    } else {
      fields[name] = part.data.toString('utf8').trim();
    }
  }
  return { fields, file };
}

async function saveUploadedImage(file) {
  if (!file || !file.data.length) throw httpError(400, 'No image uploaded');
  if (file.data.length > 200 * 1024 * 1024) throw httpError(400, 'Media too large; keep it under 200MB');
  const ext = path.extname(file.filename || 'upload.png').toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm'].includes(ext)) throw httpError(400, 'Unsupported media type. Use PNG, JPG, JPEG, GIF, MP4, MOV, or WEBM.');
  await ensureUploadsDir();
  const safeName = crypto.randomUUID() + ext;
  const fullPath = path.join(UPLOADS_DIR, safeName);
  await fs.writeFile(fullPath, file.data, { mode: 0o600 });
  const mediaPath = path.relative(config.root, fullPath);
  await audit('image_uploaded', { mediaPath, bytes: file.data.length });
  return { mediaPath, bytes: file.data.length };
}

async function handleUpload(req) {
  const form = await readMultipartForm(req);
  return saveUploadedImage(form.file);
}

function splitMultipart(body, boundary) {
  const parts = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    let part = body.subarray(start, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      parts.push({
        headers: part.subarray(0, headerEnd).toString('utf8'),
        data: part.subarray(headerEnd + 4)
      });
    }
    start = next;
  }
  return parts;
}

async function readFormOrJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) return readJsonBody(req);
  return readFormBody(req);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON body'); }
}

function json(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function html(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(payload);
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split('=');
    return [key, rest.join('=')];
  }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatDateTimeLocal(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  // Display UTC timestamps as IST in datetime-local format.
  const istMs = date.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 16);
}

function isAllowed(req, url, session) {
  if (url.pathname === '/health' || url.pathname === '/auth/linkedin' || url.pathname === '/auth/linkedin/callback') return true;
  return session.authed === true;
}

async function loginPage(res, url) {
  const token = await getToken();
  return html(res, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · LinkedIn Posting Studio</title>
<style>
:root{--bg:#f6f8fb;--panel:#fff;--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:#0a66c2;--brand-dark:#064f97;--bad:#b91c1c;--shadow:0 24px 70px rgba(15,23,42,.12)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,#dbeafe,transparent 32rem),radial-gradient(circle at 90% 90%,#e0f2fe,transparent 28rem),var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.login-card{width:min(440px,calc(100% - 32px));background:rgba(255,255,255,.9);border:1px solid rgba(229,231,235,.95);border-radius:28px;box-shadow:var(--shadow);padding:30px;backdrop-filter:blur(10px)}.logo{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,var(--brand),#38bdf8);display:grid;place-items:center;color:#fff;font-weight:900;margin-bottom:18px}.eyebrow{color:var(--brand);font-size:12px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;margin:0 0 8px}h1{font-size:32px;line-height:1;margin:0 0 10px;letter-spacing:-.04em}p{margin:0 0 22px;color:var(--muted)}label{display:block;font-size:13px;font-weight:800;margin-bottom:8px}input{width:100%;border:1px solid var(--line);border-radius:14px;padding:13px 14px;font:inherit;outline:none;transition:.15s border,.15s box-shadow}input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(10,102,194,.12)}button{width:100%;margin-top:16px;border:0;border-radius:999px;background:var(--brand);color:#fff;font-weight:900;font:inherit;padding:13px 18px;cursor:pointer;transition:.15s background,.15s transform}button:hover{background:var(--brand-dark);transform:translateY(-1px)}.error{background:#fee2e2;color:var(--bad);border:1px solid #fecaca;border-radius:14px;padding:12px 14px;margin-bottom:16px;font-size:14px}.hint{font-size:12px;color:var(--muted);margin-top:14px;text-align:center}@media(max-width:520px){.login-card{padding:24px}h1{font-size:28px}}
</style></head><body><main class="login-card"><div class="logo">in</div><p class="eyebrow">LinkedIn Posting Studio</p><h1>Sign in with LinkedIn</h1><p>Use LinkedIn OAuth to access the scheduler and refresh the posting token in one step.</p>${url.searchParams.get('error') ? '<div class="error">LinkedIn sign-in failed. Please try again.</div>' : ''}<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(url.searchParams.get('next') || '/')}"><button>Continue with LinkedIn</button></form><div class="hint">Each LinkedIn user gets their own private queue and token.</div></main></body></html>`);
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return Object.fromEntries(params.entries());
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

let schedulerRunning = false;
async function schedulerTick() {
  if (!config.schedulerEnabled || schedulerRunning) return;
  schedulerRunning = true;
  try {
    const duePosts = await listDueScheduledPosts(new Date());
    for (const post of duePosts) {
      try {
        await audit('scheduler_due_post_found', { id: post.id, scheduledFor: post.scheduledFor });
        await publishPost(post.id, { scheduler: true, ownerSub: post.ownerSub });
      } catch (error) {
        await audit('scheduler_publish_error', { id: post.id, status: error.status || 500, message: error.message });
        if ((error.status || 500) >= 500 || error.status === 429 || error.status === 401 || error.status === 403) {
          await markFailed(post.id, error.message, error.details, post.ownerSub);
        }
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

server.listen(config.port, config.host, () => {
  console.log(`LinkedIn Posting MVP running at http://${config.host}:${config.port}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Scheduler: ${config.schedulerEnabled ? 'enabled' : 'disabled'} (${config.schedulerIntervalMs}ms), cap=${config.maxPostsPerDay}/day`);
  if (config.schedulerEnabled) {
    setInterval(() => schedulerTick().catch((error) => console.error('scheduler_tick_failed', error)), config.schedulerIntervalMs);
    schedulerTick().catch((error) => console.error('scheduler_initial_tick_failed', error));
  }
  if (config.host === '0.0.0.0' && !config.appPassword) console.log('WARNING: public bind without APP_PASSWORD');
  const missing = validateConfig();
  if (missing.length) console.log(`Missing config: ${missing.join(', ')}`);
});
