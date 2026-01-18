const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// JSON file storage
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('Creating new data file');
  }
  return {};
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

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

function getKey(userId, guildId) {
  return `${guildId}-${userId}`;
}

function getUserData(data, userId, guildId) {
  const key = getKey(userId, guildId);
  if (!data[key]) {
    data[key] = {};
    ACTIVITIES.forEach(a => data[key][a] = 0);
  }
  return data[key];
}

function getTotalXp(data, userId, guildId) {
  const userData = getUserData(data, userId, guildId);
  return Object.values(userData).reduce((sum, xp) => sum + xp, 0);
}

async function updateNickname(member, data) {
  const totalXp = getTotalXp(data, member.id, member.guild.id);
  const { level } = getLevel(totalXp);
  
  let baseName = member.displayName.replace(/\s*\[Lvl \d+\]$/, '');
  
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

  const data = loadData();

  if (interaction.commandName === 'log') {
    const logged = [];
    const userData = getUserData(data, interaction.user.id, interaction.guildId);
    
    for (const activity of ACTIVITIES) {
      const minutes = interaction.options.getInteger(activity);
      if (minutes && minutes > 0) {
        userData[activity] += minutes;
        logged.push(`${activity}: ${minutes} min`);
      }
    }
    
    if (logged.length === 0) {
      return interaction.reply({ content: 'Please specify at least one activity with minutes!', ephemeral: true });
    }
    
    saveData(data);
    
    await updateNickname(interaction.member, data);
    
    const totalXp = getTotalXp(data, interaction.user.id, interaction.guildId);
    const { level, currentXp, nextLevelXp } = getLevel(totalXp);
    
    await interaction.reply({
      content: `✅ Logged!\n${logged.join('\n')}\n\n**Total Level ${level}** (${currentXp}/${nextLevelXp} XP to next level)`,
      ephemeral: false
    });
  }

  if (interaction.commandName === 'stats') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    
    const totalXp = getTotalXp(data, targetUser.id, interaction.guildId);
    const totalLevel = getLevel(totalXp);
    const userData = getUserData(data, targetUser.id, interaction.guildId);
    
    let statsText = `**${targetUser.username}'s Stats**\n\n`;
    statsText += `🏆 **Total Level ${totalLevel.level}** (${totalLevel.currentXp}/${totalLevel.nextLevelXp} XP)\n\n`;
    
    for (const activity of ACTIVITIES) {
      const xp = userData[activity] || 0;
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
