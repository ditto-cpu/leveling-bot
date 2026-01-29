const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');

// Supabase setup
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabase(endpoint, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation'
    },
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Supabase error:', text);
    return null;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Voice channel tracking
const voiceSessions = new Map();

// Config
const TRACKED_VOICE_CHANNEL_IDS = ['1460373491776749708', '1462082630353944720'];
const XP_ANNOUNCEMENT_CHANNEL_ID = '1462682137680412672';

// Level calculation: Level 1 = 100xp, Level 2 = 200xp, etc.
function getLevel(xp) {
  let level = 1;
  let required = 100;
  let remaining = xp;
  
  while (remaining >= required) {
    remaining -= required;
    level++;
    required = level * 100;
  }
  
  return { level, currentXp: Math.floor(remaining), nextLevelXp: required };
}

async function getOrCreateUser(discordId, username) {
  // Try to find existing user
  let users = await supabase(`users?discord_id=eq.${discordId}&select=*`);
  
  if (users && users.length > 0) {
    return users[0];
  }
  
  // Create new user
  const newUser = await supabase('users', {
    method: 'POST',
    body: JSON.stringify({
      discord_id: discordId,
      username: username,
      soma: 0,
      knowledge: 0,
      perception: 0,
      work: 0
    })
  });
  
  return newUser ? newUser[0] : null;
}

async function updateUserStats(userId, stats) {
  await supabase(`users?id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(stats)
  });
}

async function logActivity(userId, activity, minutes, xpGained) {
  await supabase('activity_logs', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      activity: activity,
      minutes: minutes,
      xp_gained: xpGained
    })
  });
}

function getTotalXp(user) {
  return (user.soma || 0) + (user.knowledge || 0) + (user.perception || 0) + (user.work || 0);
}

async function updateNickname(member, user) {
  const totalXp = getTotalXp(user);
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
      .addIntegerOption(opt => opt.setName('workout').setDescription('Any physical activity (1x Soma)'))
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
  const discordId = newState.id;
  const guildId = newState.guild.id;
  const sessionKey = `${guildId}-${discordId}`;
  
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
        // Get or create user
        const user = await getOrCreateUser(discordId, newState.member.user.username);
        if (!user) return;
        
        // Update stats
        const newWork = (user.work || 0) + minutes;
        await updateUserStats(user.id, { work: newWork });
        await logActivity(user.id, 'work_voice', minutes, minutes);
        
        // Update user object for nickname
        user.work = newWork;
        
        // Update nickname
        await updateNickname(newState.member, user);
        
        // Get new stats
        const totalXp = getTotalXp(user);
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

  if (interaction.commandName === 'log') {
    const user = await getOrCreateUser(interaction.user.id, interaction.user.username);
    if (!user) {
      return interaction.reply({ content: 'Database error, try again later.', ephemeral: true });
    }
    
    const logged = [];
    const updates = {};
    
    // Soma (workout)
    const workout = interaction.options.getInteger('workout');
    if (workout && workout > 0) {
      updates.soma = (user.soma || 0) + workout;
      await logActivity(user.id, 'workout', workout, workout);
      logged.push(`Workout: ${workout} min → +${workout} XP (Soma)`);
    }
    
    // Knowledge
    const video = interaction.options.getInteger('video');
    if (video && video > 0) {
      const xp = Math.floor(video * 0.7);
      updates.knowledge = (updates.knowledge || user.knowledge || 0) + xp;
      await logActivity(user.id, 'video', video, xp);
      logged.push(`Video: ${video} min x0.7 → +${xp} XP (Knowledge)`);
    }
    
    const reading = interaction.options.getInteger('reading');
    if (reading && reading > 0) {
      updates.knowledge = (updates.knowledge || user.knowledge || 0) + reading;
      await logActivity(user.id, 'reading', reading, reading);
      logged.push(`Reading: ${reading} min → +${reading} XP (Knowledge)`);
    }
    
    const writing = interaction.options.getInteger('writing');
    if (writing && writing > 0) {
      const xp = Math.floor(writing * 1.2);
      updates.knowledge = (updates.knowledge || user.knowledge || 0) + xp;
      await logActivity(user.id, 'writing', writing, xp);
      logged.push(`Writing: ${writing} min x1.2 → +${xp} XP (Knowledge)`);
    }
    
    // Perception
    const meditation = interaction.options.getInteger('meditation');
    if (meditation && meditation > 0) {
      updates.perception = (updates.perception || user.perception || 0) + meditation;
      await logActivity(user.id, 'meditation', meditation, meditation);
      logged.push(`Meditation: ${meditation} min → +${meditation} XP (Perception)`);
    }
    
    const bgMed = interaction.options.getInteger('background_med');
    if (bgMed && bgMed > 0) {
      const xp = Math.floor(bgMed * 0.2);
      updates.perception = (updates.perception || user.perception || 0) + xp;
      await logActivity(user.id, 'background_med', bgMed, xp);
      logged.push(`Background Med: ${bgMed} min x0.2 → +${xp} XP (Perception)`);
    }
    
    // Work
    const work = interaction.options.getInteger('work');
    if (work && work > 0) {
      updates.work = (user.work || 0) + work;
      await logActivity(user.id, 'work', work, work);
      logged.push(`Work: ${work} min → +${work} XP (Work)`);
    }
    
    if (logged.length === 0) {
      return interaction.reply({ content: 'Please specify at least one activity with minutes!', ephemeral: true });
    }
    
    await updateUserStats(user.id, updates);
    
    // Merge updates for nickname
    const updatedUser = { ...user, ...updates };
    await updateNickname(interaction.member, updatedUser);
    
    const totalXp = getTotalXp(updatedUser);
    const { level, currentXp, nextLevelXp } = getLevel(totalXp);
    
    await interaction.reply({
      content: `Logged!\n${logged.join('\n')}\n\n**Total Level ${level}** (${currentXp}/${nextLevelXp} XP to next level)`,
      ephemeral: false
    });
  }

  if (interaction.commandName === 'stats') {
    const targetDiscordUser = interaction.options.getUser('user') || interaction.user;
    
    const user = await getOrCreateUser(targetDiscordUser.id, targetDiscordUser.username);
    if (!user) {
      return interaction.reply({ content: 'Database error, try again later.', ephemeral: true });
    }
    
    const totalXp = getTotalXp(user);
    const totalLevel = getLevel(totalXp);
    
    let statsText = `**${targetDiscordUser.username}'s Stats**\n\n`;
    statsText += `**Total Level ${totalLevel.level}** (${totalLevel.currentXp}/${totalLevel.nextLevelXp} XP)\n\n`;
    
    const somaLevel = getLevel(user.soma || 0);
    statsText += `**Soma** - Level ${somaLevel.level} (${somaLevel.currentXp}/${somaLevel.nextLevelXp})\n\n`;
    
    const knowledgeLevel = getLevel(user.knowledge || 0);
    statsText += `**Knowledge** - Level ${knowledgeLevel.level} (${knowledgeLevel.currentXp}/${knowledgeLevel.nextLevelXp})\n\n`;
    
    const perceptionLevel = getLevel(user.perception || 0);
    statsText += `**Perception** - Level ${perceptionLevel.level} (${perceptionLevel.currentXp}/${perceptionLevel.nextLevelXp})\n\n`;
    
    const workLevel = getLevel(user.work || 0);
    statsText += `**Work** - Level ${workLevel.level} (${workLevel.currentXp}/${workLevel.nextLevelXp})\n`;
    
    await interaction.reply({ content: statsText, ephemeral: false });
  }
});

client.login(process.env.DISCORD_TOKEN);
