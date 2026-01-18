const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');

// Initialize database
const db = new Database('levels.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_xp (
    user_id TEXT,
    guild_id TEXT,
    activity TEXT,
    xp INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, guild_id, activity)
  )
`);

// Config
const ACTIVITIES = ['meditation', 'work', 'reading', 'writing', 'workout'];

// Level calculation: Level 1 = 100xp, Level 2 = 200xp, etc.
function getLevel(xp) {
  let level = 0;
  let required = 100;
  let remaining = xp;
  
  while (remaining >= required) {
    remaining -= required;
    level++;
    required = (level + 1) * 100;
  }
  
  return { level, currentXp: remaining, nextLevelXp: required };
}

function getTotalXp(userId, guildId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(xp), 0) as total 
    FROM user_xp 
    WHERE user_id = ? AND guild_id = ?
  `).get(userId, guildId);
  return row.total;
}

function getActivityXp(userId, guildId, activity) {
  const row = db.prepare(`
    SELECT COALESCE(xp, 0) as xp 
    FROM user_xp 
    WHERE user_id = ? AND guild_id = ? AND activity = ?
  `).get(userId, guildId, activity);
  return row ? row.xp : 0;
}

function addXp(userId, guildId, activity, minutes) {
  db.prepare(`
    INSERT INTO user_xp (user_id, guild_id, activity, xp) 
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, guild_id, activity) 
    DO UPDATE SET xp = xp + ?
  `).run(userId, guildId, activity, minutes, minutes);
}

async function updateNickname(member) {
  const totalXp = getTotalXp(member.id, member.guild.id);
  const { level } = getLevel(totalXp);
  
  // Get base name (remove existing level tag if present)
  let baseName = member.displayName.replace(/\s*\[Lvl \d+\]$/, '');
  
  // Truncate if needed (Discord max is 32 chars)
  const suffix = ` [Lvl ${level}]`;
  const maxBaseLength = 32 - suffix.length;
  if (baseName.length > maxBaseLength) {
    baseName = baseName.substring(0, maxBaseLength);
  }
  
  const newNickname = `${baseName}${suffix}`;
  
  try {
    await member.setNickname(newNickname);
  } catch (error) {
    console.log(`Couldn't update nickname for ${member.user.tag}: ${error.message}`);
  }
}

// Create client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('log')
      .setDescription('Log your activities (in minutes)')
      .addIntegerOption(opt => opt.setName('meditation').setDescription('Minutes of meditation'))
      .addIntegerOption(opt => opt.setName('work').setDescription('Minutes of work'))
      .addIntegerOption(opt => opt.setName('reading').setDescription('Minutes of reading'))
      .addIntegerOption(opt => opt.setName('writing').setDescription('Minutes of writing'))
      .addIntegerOption(opt => opt.setName('workout').setDescription('Minutes of workout')),
    
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Check your levels')
      .addUserOption(opt => opt.setName('user').setDescription('User to check (optional)')),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands registered');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'log') {
    const logged = [];
    
    for (const activity of ACTIVITIES) {
      const minutes = interaction.options.getInteger(activity);
      if (minutes && minutes > 0) {
        addXp(interaction.user.id, interaction.guildId, activity, minutes);
        logged.push(`${activity}: ${minutes} min`);
      }
    }
    
    if (logged.length === 0) {
      return interaction.reply({ content: 'Please specify at least one activity with minutes!', ephemeral: true });
    }
    
    // Update nickname
    await updateNickname(interaction.member);
    
    // Get new total
    const totalXp = getTotalXp(interaction.user.id, interaction.guildId);
    const { level, currentXp, nextLevelXp } = getLevel(totalXp);
    
    await interaction.reply({
      content: `✅ Logged!\n${logged.join('\n')}\n\n**Total Level ${level}** (${currentXp}/${nextLevelXp} XP to next level)`,
      ephemeral: false
    });
  }

  if (interaction.commandName === 'stats') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const targetMember = await interaction.guild.members.fetch(targetUser.id);
    
    const totalXp = getTotalXp(targetUser.id, interaction.guildId);
    const totalLevel = getLevel(totalXp);
    
    let statsText = `**${targetUser.username}'s Stats**\n\n`;
    statsText += `🏆 **Total Level ${totalLevel.level}** (${totalLevel.currentXp}/${totalLevel.nextLevelXp} XP)\n\n`;
    
    for (const activity of ACTIVITIES) {
      const xp = getActivityXp(targetUser.id, interaction.guildId, activity);
      const { level, currentXp, nextLevelXp } = getLevel(xp);
      const emoji = {
        meditation: '🧘',
        work: '💼',
        reading: '📚',
        writing: '✍️',
        workout: '💪'
      }[activity];
      statsText += `${emoji} ${activity}: Level ${level} (${currentXp}/${nextLevelXp})\n`;
    }
    
    await interaction.reply({ content: statsText, ephemeral: false });
  }
});

client.login(process.env.DISCORD_TOKEN);
