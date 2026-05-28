import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { createIntake, audit } from './store.js';
import { extractUrlPreview } from './extract.js';

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
    const url = extractFirstUrl(message.content);
    if (!url) return;

    const statusMessage = await message.reply('Extracting LinkedIn draft preview…');
    const preview = await extractUrlPreview(url);
    const item = await createIntake({
      ...preview,
      source: 'discord',
      discord: {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorUsername: message.author.username
      }
    });

    const approvalUrl = config.discord.publicBaseUrl
      ? `${config.discord.publicBaseUrl.replace(/\/$/, '')}/`
      : 'Open the Posting Studio dashboard';

    await statusMessage.edit([
      'Draft preview created ✅',
      `Title: ${preview.title || 'Untitled'}`,
      `Intake ID: ${item.id}`,
      `Approve it here: ${approvalUrl}`
    ].join('\n'));
  } catch (error) {
    await audit('discord_intake_error', { message: error.message });
    try { await message.reply(`Could not create draft preview: ${error.message}`); } catch {}
  }
});

function extractFirstUrl(text) {
  return String(text || '').match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,]+$/, '') || null;
}

await client.login(config.discord.botToken);
