const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// JSON file storage
const DATA_FILE = '/data/data.json';

// Voice channel tracking
const voiceSessions = new Map();

// Config
const TRACKED_VOICE_CHANNEL_IDS = ['1460373491776749708', '1462082630353944720'];
const XP_ANNOUNCEMENT_CHANNEL_ID = '1462682137680412672';

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
  
  return { level, currentXp: Math.floor(remaining), nextLevelXp: required };
}

function getKey(userId, guildId) {
  return `${guildId}-${userId}`;
}

function getUserData(data, userId, guildId) {
  const key = getKey(userId, guildId);
  if (!data[key]) {
    data[key] = {
      // Main stats
      soma: 0,
      knowledge: 0,
      perception: 0,
      work: 0,
      // Soma branches only
      agility: 0,
      strength: 0
    };
  }
  return data[key];
}

function getTotalXp(data, userId, guildId) {
  const userData = getUserData(data, userId, guildId);
  return userData.soma + userData.knowledge + userData.perception + userData.work;
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
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('log')
      .setDescription('Log your activities (in minutes)')
      .addIntegerOption(opt => opt.setName('agility').setDescription('Yoga, stretching, running, cardio (1x Soma)'))
      .addIntegerOption(opt => opt.setName('strength').setDescription('Lifting, calisthenics (1x Soma)'))
      .addIntegerOption(opt => opt.setName('video').setDescription('Video/audiobooks (0.7x Knowledge)'))
      .addIntegerOption(opt => opt.setName('reading').setDescription('Reading (1x Knowledge)'))
      .addIntegerOption(opt => opt.setName('writing').setDescription('Writing (1.2x Knowledge)'))
      .addIntegerOption(opt => opt.setName('meditation').setDescription('Meditation (1x Perception)'))
      .addIntegerOption(opt => opt.setName('background_med').setDescription('Background meditation (0.2x Perception)'))
      .addIntegerOption(opt => opt.setName('work').setDescription('Work (1x Work)')),
    
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

// Voice channel tracking
client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.id;
  const guildId = newState.guild.id;
  const sessionKey = getKey(userId, guildId);
  
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  
  const wasInTracked = oldChannel && TRACKED_VOICE_CHANNEL_IDS.includes(oldChannel.id);
  const isInTracked = newChannel && TRACKED_VOICE_CHANNEL_IDS.includes(newChannel.id);
  
  // Joined a tracked channel
  if (!wasInTracked && isInTracked) {
    voiceSessions.set(sessionKey, Date.now());
    console.log(`${newState.member.user.tag} joined ${newChannel.name}`);
  }
  
  // Left a tracked channel
  if (wasInTracked && !isInTracked) {
    const joinTime = voiceSessions.get(sessionKey);
    
    if (joinTime) {
      const duration = Date.now() - joinTime;
      const minutes = Math.floor(duration / 60000);
      
      voiceSessions.delete(sessionKey);
      
      if (minutes > 0) {
        // Add XP
        const data = loadData();
        const userData = getUserData(data, userId, guildId);
        userData.work += minutes;
        saveData(data);
        
        // Update nickname
        await updateNickname(newState.member, data);
        
        // Get new stats
        const totalXp = getTotalXp(data, userId, guildId);
        const { level, currentXp, nextLevelXp } = getLevel(totalXp);
        
        // Announce in channel
        const announcementChannel = newState.guild.channels.cache.get(XP_ANNOUNCEMENT_CHANNEL_ID);
        
        if (announcementChannel) {
          await announcementChannel.send(
            `**${newState.member.user.username}** earned **${minutes} Work XP** from ${oldChannel.name}!\nTotal Level ${level} (${currentXp}/${nextLevelXp} XP)`
          );
        }
        
        console.log(`${newState.member.user.tag} earned ${minutes} work XP`);
      }
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const data = loadData();

  if (interaction.commandName === 'log') {
    const logged = [];
    const userData = getUserData(data, interaction.user.id, interaction.guildId);
    
    // Soma branches
    const agility = interaction.options.getInteger('agility');
    if (agility && agility > 0) {
      userData.agility += agility;
      userData.soma += agility;
      logged.push(`Agility: ${agility} min → +${agility} XP (Soma & Agility)`);
    }
    
    const strength = interaction.options.getInteger('strength');
    if (strength && strength > 0) {
      userData.strength += strength;
      userData.soma += strength;
      logged.push(`Strength: ${strength} min → +${strength} XP (Soma & Strength)`);
    }
    
    // Knowledge
    const video = interaction.options.getInteger('video');
    if (video && video > 0) {
      const xp = Math.floor(video * 0.7);
      userData.knowledge += xp;
      logged.push(`Video: ${video} min x0.7 → +${xp} XP (Knowledge)`);
    }
    
    const reading = interaction.options.getInteger('reading');
    if (reading && reading > 0) {
      userData.knowledge += reading;
      logged.push(`Reading: ${reading} min → +${reading} XP (Knowledge)`);
    }
    
    const writing = interaction.options.getInteger('writing');
    if (writing && writing > 0) {
      const xp = Math.floor(writing * 1.2);
      userData.knowledge += xp;
      logged.push(`Writing: ${writing} min x1.2 → +${xp} XP (Knowledge)`);
    }
    
    // Perception
    const meditation = interaction.options.getInteger('meditation');
    if (meditation && meditation > 0) {
      userData.perception += meditation;
      logged.push(`Meditation: ${meditation} min → +${meditation} XP (Perception)`);
    }
    
    const bgMed = interaction.options.getInteger('background_med');
    if (bgMed && bgMed > 0) {
      const xp = Math.floor(bgMed * 0.2);
      userData.perception += xp;
      logged.push(`Background Med: ${bgMed} min x0.2 → +${xp} XP (Perception)`);
    }
    
    // Work
    const work = interaction.options.getInteger('work');
    if (work && work > 0) {
      userData.work += work;
      logged.push(`Work: ${work} min → +${work} XP (Work)`);
    }
    
    if (logged.length === 0) {
      return interaction.reply({ content: 'Please specify at least one activity with minutes!', ephemeral: true });
    }
    
    saveData(data);
    
    await updateNickname(interaction.member, data);
    
    const totalXp = getTotalXp(data, interaction.user.id, interaction.guildId);
    const { level, currentXp, nextLevelXp } = getLevel(totalXp);
    
    await interaction.reply({
      content: `Logged!\n${logged.join('\n')}\n\n**Total Level ${level}** (${currentXp}/${nextLevelXp} XP to next level)`,
      ephemeral: false
    });
  }

  if (interaction.commandName === 'stats') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    
    const totalXp = getTotalXp(data, targetUser.id, interaction.guildId);
    const totalLevel = getLevel(totalXp);
    const userData = getUserData(data, targetUser.id, interaction.guildId);
    
    let statsText = `**${targetUser.username}'s Stats**\n\n`;
    statsText += `**Total Level ${totalLevel.level}** (${totalLevel.currentXp}/${totalLevel.nextLevelXp} XP)\n\n`;
    
    // Soma with branches
    const somaLevel = getLevel(userData.soma);
    const agilityLevel = getLevel(userData.agility);
    const strengthLevel = getLevel(userData.strength);
    statsText += `**Soma** - Level ${somaLevel.level} (${somaLevel.currentXp}/${somaLevel.nextLevelXp})\n`;
    statsText += `  Agility: Lvl ${agilityLevel.level} (${agilityLevel.currentXp}/${agilityLevel.nextLevelXp})\n`;
    statsText += `  Strength: Lvl ${strengthLevel.level} (${strengthLevel.currentXp}/${strengthLevel.nextLevelXp})\n\n`;
    
    // Knowledge (single stat)
    const knowledgeLevel = getLevel(userData.knowledge);
    statsText += `**Knowledge** - Level ${knowledgeLevel.level} (${knowledgeLevel.currentXp}/${knowledgeLevel.nextLevelXp})\n\n`;
    
    // Perception (single stat)
    const perceptionLevel = getLevel(userData.perception);
    statsText += `**Perception** - Level ${perceptionLevel.level} (${perceptionLevel.currentXp}/${perceptionLevel.nextLevelXp})\n\n`;
    
    // Work (single stat)
    const workLevel = getLevel(userData.work);
    statsText += `**Work** - Level ${workLevel.level} (${workLevel.currentXp}/${workLevel.nextLevelXp})\n`;
    
    await interaction.reply({ content: statsText, ephemeral: false });
  }
});

client.login(process.env.DISCORD_TOKEN);
