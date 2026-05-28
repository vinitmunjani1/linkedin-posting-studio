import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { approveIntake, approvePost, audit, createIntake, getChannelAccount, rejectIntake, schedulePost } from './store.js';
import { extractUrlPreview } from './extract.js';
import { publishFromPostId } from './publisher.js';

if (!config.discord.botToken) {
  console.error('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Discord intake bot logged in as ${client.user.tag}`);
  if (config.discord.channelId) console.log(`Watching channel ${config.discord.channelId}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (config.discord.channelId && message.channelId !== config.discord.channelId) return;

    const text = String(message.content || '').trim();
    if (/^!(connect|connect-linkedin)\b/i.test(text)) return handleConnect(message);
    if (/^!(account|status)\b/i.test(text)) return handleAccount(message);
    if (/^!(approve|post-now)\b/i.test(text)) return handleApproveNow(message, text);
    if (/^!schedule\b/i.test(text)) return handleSchedule(message, text);
    if (/^!reject\b/i.test(text)) return handleReject(message, text);

    const url = extractFirstUrl(text);
    if (!url) return;
    return handleUrl(message, url);
  } catch (error) {
    await audit('discord_intake_error', { message: error.message, channelId: message.channelId });
    try { await message.reply(`Could not process request: ${error.message}`); } catch {}
  }
});

async function handleConnect(message) {
  const loginUrl = `${publicBaseUrl()}/auth/linkedin?discord_channel_id=${encodeURIComponent(message.channelId)}`;
  await message.reply([
    'Connect this Discord channel to a LinkedIn account:',
    loginUrl,
    '',
    'After login, every URL in this channel will use that connected account.'
  ].join('\n'));
}

async function handleAccount(message) {
  const account = await getChannelAccount(message.channelId);
  if (!account) return message.reply('No LinkedIn account connected for this channel yet. Run `!connect-linkedin`.');
  return message.reply(`This channel is connected to: **${account.ownerName}**`);
}

async function handleUrl(message, url) {
  const account = await getChannelAccount(message.channelId);
  if (!account) {
    return message.reply('This channel is not connected to LinkedIn yet. Run `!connect-linkedin` first.');
  }

  const statusMessage = await message.reply('Extracting draft preview…');
  const preview = await extractUrlPreview(url);
  const item = await createIntake({
    ...preview,
    ownerSub: account.ownerSub,
    ownerName: account.ownerName,
    source: 'discord',
    discord: {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      authorUsername: message.author.username
    }
  });

  await statusMessage.edit([
    'Draft preview created ✅',
    `Account: **${account.ownerName}**`,
    `Title: ${preview.title || 'Untitled'}`,
    `Intake ID: \`${item.id}\``,
    '',
    'Commands:',
    `\`!approve ${item.id}\` — publish now`,
    `\`!schedule ${item.id} 2026-05-28 18:30\` — schedule in IST`,
    `\`!reject ${item.id}\``
  ].join('\n'));
}

async function handleApproveNow(message, text) {
  const id = text.split(/\s+/)[1];
  if (!id) return message.reply('Usage: `!approve <intake_id>`');
  const account = await requireAccount(message);
  const { post } = await approveIntake(id, { ownerSub: account.ownerSub, ownerName: account.ownerName });
  await approvePost(post.id, account.ownerSub);
  const published = await publishFromPostId(post.id, { ownerSub: account.ownerSub });
  await message.reply(`Published now ✅\nPost ID: \`${published.id}\``);
}

async function handleSchedule(message, text) {
  const parts = text.split(/\s+/);
  const id = parts[1];
  const scheduledFor = parts.slice(2).join(' ');
  if (!id || !scheduledFor) return message.reply('Usage: `!schedule <intake_id> YYYY-MM-DD HH:mm` (IST)');
  const account = await requireAccount(message);
  const { post } = await approveIntake(id, { ownerSub: account.ownerSub, ownerName: account.ownerName, scheduledFor });
  await approvePost(post.id, account.ownerSub);
  await schedulePost(post.id, scheduledFor, account.ownerSub);
  await message.reply(`Scheduled ✅\nAccount: **${account.ownerName}**\nTime: ${scheduledFor} IST\nPost ID: \`${post.id}\``);
}

async function handleReject(message, text) {
  const id = text.split(/\s+/)[1];
  if (!id) return message.reply('Usage: `!reject <intake_id>`');
  const account = await requireAccount(message);
  await rejectIntake(id, account.ownerSub);
  await message.reply('Rejected ✅');
}

async function requireAccount(message) {
  const account = await getChannelAccount(message.channelId);
  if (!account) throw new Error('This channel is not connected. Run `!connect-linkedin` first.');
  return account;
}

function publicBaseUrl() {
  return (config.discord.publicBaseUrl || 'https://linkpost.infinitycorp.tech').replace(/\/$/, '');
}

function extractFirstUrl(text) {
  return String(text || '').match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,]+$/, '') || null;
}

await client.login(config.discord.botToken);
