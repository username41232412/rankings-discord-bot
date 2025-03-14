// index.js
const axios = require('axios');
require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// for the confirmation button for /reset_ranks
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pendingResetConfirmations = new Map();

const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
const schedule = require('node-schedule');

// For App Engine health checks and update notifications
const http = require('http');
const express = require('express');
const app = express();
const bodyParser = require('body-parser');

// Add a queue for pending updates near the configuration section
const updateQueue = [];
let botReady = false;

// Parse JSON bodies
app.use(bodyParser.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Discord bot is running!');
});

// Endpoint to receive update notifications from the backend
// Modify the update-rankings endpoint to queue updates if bot isn't ready
app.post('/update-rankings', async (req, res) => {
    console.log('Received update request from backend server');

    try {
        // Check if we have match data
        const matchData = req.body;
        const hasMatchData = matchData && Object.keys(matchData).length > 0;

        // If bot is not ready yet, queue the update
        if (!botReady) {
            console.log('Bot not ready, queuing update request');
            updateQueue.push({
                type: 'match',
                data: hasMatchData ? matchData : null
            });
            return res.status(202).send('Update queued, bot is initializing');
        }

        // Process match data if available
        if (hasMatchData) {
            console.log('Processing match data');
            await sendMatchResults(matchData);
        }

        // Update all ranks channels
        for (const channelId of ranksChannels) {
            await updateRanks(channelId);
        }

        res.status(200).send('Rankings updated successfully');
    } catch (error) {
        console.error('Error handling update request:', error);
        res.status(500).send('Error updating rankings');
    }
});

// Start the server
const server = app.listen(process.env.PORT || 8080, () => {
    console.log(`Server running on port ${process.env.PORT || 8080}`);
});

// Initialize Discord client with intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// Initialize BigQuery client with specific project
const bigqueryClient = new BigQuery({
    projectId: 'bplrankings'
});

// Configuration
const configChannels = ['1246103921114746890', '1246088196475981866', '1271504921824333926'];
const ranksChannels = ['1276850074428903435', '948052164226474024'];
const matchResultsChannels = ['1344789867560833064'];
const UPDATE_PERIOD = 150; // seconds
// K-value configuration cache
let cachedKValueConfig = {
    thresholds: { newPlayer: 5, developingPlayer: 15 },
    kValues: { newPlayer: 120, developingPlayer: 60, establishedPlayer: 30 },
    descriptions: {
        newPlayer: "New players (<5 games)",
        developingPlayer: "Developing players (5-15 games)",
        establishedPlayer: "Established players (15+ games)"
    }
};


// Modify the getRanks function in the Discord bot (index.js) to include pastgames field
async function getRanks() {
    const query = `
    SELECT name, steamid, elo, timestamp, nationality, pastgames
    FROM (
        SELECT name, steamid, elo, timestamp, nationality, pastgames,
        ROW_NUMBER() OVER(PARTITION BY steamid ORDER BY timestamp DESC) as rn
        FROM \`bplrankings.Main.rankings\`
    )
    WHERE rn = 1
    ORDER BY elo DESC
    LIMIT 100
    `;

    // Execute the query
    const [rows] = await bigqueryClient.query(query);

    // Generate Discord timestamp for "last updated"
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const discordTimestamp = `<t:${currentTimestamp}:R>`;

    let resultString = `The Ranks, as of ${discordTimestamp}.\n`;

    // Use the cached K-value config instead of fetching it every time
    const minGames = cachedKValueConfig?.thresholds?.newPlayer || 5;

    // Filter and number the qualified players
    let rank = 1;
    rows.forEach((row) => {
        const pastGames = row.pastgames || 0;

        // Only include players with enough games
        if (pastGames >= minGames) {
            const prefix = row.nationality ? `${row.nationality}` : '';
            resultString += `${rank}. ${prefix} ${row.name} ${row.elo}\n`;
            rank++;
        }
    });

    resultString += '\nRanking Information'
    resultString += '\n• Rankings are calculated from Ranked Games'
    resultString += `\n• Message an admin to change your emoji.`;
    resultString += `\n• Players with fewer than ${minGames} games are unranked.`;
    resultString += `\n• Rating can't go below ${cachedKValueConfig.defaultElo}.`;
    resultString += `\n• Check your rating with /rank steamid: YourSteamID`;

    return resultString;
}

// Update the getAllRanksData function to include pastgames
async function getAllRanksData() {
    const query = `
    SELECT name, steamid, elo, nationality, pastgames,
    ROW_NUMBER() OVER(ORDER BY elo DESC) as absolute_rank
    FROM (
        SELECT name, steamid, elo, nationality, pastgames,
        ROW_NUMBER() OVER(PARTITION BY steamid ORDER BY timestamp DESC) as rn
        FROM \`bplrankings.Main.rankings\`
    )
    WHERE rn = 1
    ORDER BY elo DESC
    `;

    // Execute the query
    const [rows] = await bigqueryClient.query(query);

    // Use the cached K-value config instead of fetching it every time
    const minGames = cachedKValueConfig?.thresholds?.newPlayer || 5;
    let displayRank = 1;

    // Create an array with recalculated ranks
    const processedRows = rows.map(row => {
        const pastGames = row.pastgames || 0;

        // For players with enough games, assign a sequential rank
        // For others, assign -1 to indicate "unranked"
        const rank = pastGames >= minGames ? displayRank++ : -1;

        return {
            ...row,
            rank: rank,
            absoluteRank: row.absolute_rank
        };
    });

    return processedRows;
}

// Get player rank by Steam ID
async function getPlayerRank(steamId) {
    try {
        const allRanks = await getAllRanksData();
        const playerData = allRanks.find(player => player.steamid === steamId);

        if (!playerData) {
            return null;
        }

        return playerData;
    } catch (error) {
        console.error('Error fetching player rank:', error);
        return null;
    }
}

// Store message IDs for each channel
const messageCache = {};

// Update ranks in a channel
async function updateRanks(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`Channel ${channelId} not found`);
            return;
        }

        const ranksMessage = await getRanks();

        // Check if we already have a message to edit in this channel
        if (messageCache[channelId]) {
            try {
                // Try to fetch the existing message
                const existingMessage = await channel.messages.fetch(messageCache[channelId]);
                if (existingMessage) {
                    // Edit the existing message if found
                    await existingMessage.edit(ranksMessage);
                    const timestamp = new Date().toISOString();
                    console.log(`[${timestamp}] Updated ranks in channel ${channelId}`);
                    return existingMessage;
                }
            } catch (err) {
                // Message not found or could not be edited - we'll create a new one
                console.log(`Could not find previous message, creating new one: ${err.message}`);
                delete messageCache[channelId];
            }
        }

        // If we don't have a cached message or couldn't edit it, send a new one
        const message = await channel.send(ranksMessage);
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] Sent new ranks message to channel ${channelId}`);

        // Store the message ID for future updates
        messageCache[channelId] = message.id;
        return message;
    } catch (error) {
        console.error(`Error updating ranks in channel ${channelId}:`, error);
    }
}

// Update nationality in BigQuery
// Update the updateNationality function in index.js to include pastgames
async function updateNationality(steamid, newNationality, channelId) {
    console.log(`Trying to switch nationality of ${steamid} to ${newNationality}`);

    try {
        // First query to get the existing record
        const selectQuery = `
        SELECT *
        FROM \`Main.rankings\`
        WHERE steamid = @steamid
        ORDER BY timestamp DESC
        LIMIT 1
        `;

        const selectOptions = {
            query: selectQuery,
            params: { steamid: steamid }
        };

        const [rows] = await bigqueryClient.query(selectOptions);

        if (rows.length > 0) {
            const selectedRow = rows[0];

            // Insert query with the updated nationality, preserving pastgames
            const insertQuery = `
            INSERT INTO \`Main.rankings\` (name, steamid, elo, timestamp, nationality, pastgames)
            VALUES (@name, @steamid, @elo, @timestamp, @nationality, @pastgames)
            `;

            const insertOptions = {
                query: insertQuery,
                params: {
                    name: selectedRow.name,
                    steamid: selectedRow.steamid,
                    elo: selectedRow.elo,
                    timestamp: Math.floor(Date.now() / 1000),
                    nationality: newNationality.toLowerCase() === "null" ? null : newNationality,
                    pastgames: selectedRow.pastgames || 0  // Preserve pastgames or default to 0
                },
                types: {
                    name: 'STRING',
                    steamid: 'STRING',
                    elo: 'INT64',
                    timestamp: 'INT64',
                    nationality: 'STRING',
                    pastgames: 'INT64'
                }
            };

            const [insertResponse] = await bigqueryClient.query(insertOptions);

            const channel = await client.channels.fetch(channelId);
            const resultMessage = `Switched nationality for steamid ${steamid} to ${newNationality}.`;
            console.log(resultMessage);
            await channel.send(resultMessage);

            // Update the ranks in the ranks channels instead of the config channel
            for (const ranksChannelId of ranksChannels) {
                await updateRanks(ranksChannelId);
            }
            return true;
        } else {
            const channel = await client.channels.fetch(channelId);
            const resultMessage = `Steamid ${steamid} not in database.`;
            console.log(resultMessage);
            await channel.send(resultMessage);
            return false;
        }
    } catch (error) {
        const channel = await client.channels.fetch(channelId);
        const resultMessage = `Exceptions happening: ${error.message}`;
        console.log(resultMessage);
        await channel.send(resultMessage);
        return false;
    }
}

// Set up periodic updates
function setupPeriodicUpdates() {
    // Using node-schedule instead of setInterval for better reliability
    const rule = new schedule.RecurrenceRule();
    rule.second = new schedule.Range(0, 59, UPDATE_PERIOD);

    schedule.scheduleJob(rule, async () => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] Running scheduled rank updates`);
        for (const channelId of ranksChannels) {
            await updateRanks(channelId);
        }
    });
}

// Update the commands array - we'll register the reset command only to specific guilds with role checks
const globalCommands = [
    new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Check your or another player\'s rank')
    .addStringOption(option =>
    option.setName('steamid')
    .setDescription('Steam ID of the player to check (leave empty to check by name)')
    .setRequired(false))
    .addStringOption(option =>
    option.setName('name')
    .setDescription('Name of the player to check (partial names work)')
    .setRequired(false))
];

const adminCommands = [
    new SlashCommandBuilder()
    .setName('reset_ranks')
    .setDescription('Reset all player ranks to a default value (Admin only)')
    .addIntegerOption(option =>
    option.setName('default_elo')
    .setDescription('Default ELO value to reset to (default: 2000)')
    .setRequired(false)),

    // Add the new set_elo command
    new SlashCommandBuilder()
    .setName('set_elo_zero')
    .setDescription('Set a player\'s ELO to 0 (Admin only)')
    .addStringOption(option =>
    option.setName('steamid')
    .setDescription('Steam ID of the player')
    .setRequired(false))
    .addStringOption(option =>
    option.setName('name')
    .setDescription('Name of the player (partial names work)')
    .setRequired(false)),

    // Add the new set_rating command
    new SlashCommandBuilder()
    .setName('set_rating')
    .setDescription('Set a player\'s rating to a specific value (Admin only)')
    .addStringOption(option =>
    option.setName('steamid')
    .setDescription('Steam ID of the player')
    .setRequired(true))
    .addIntegerOption(option =>
    option.setName('rating')
    .setDescription('New rating value to set')
    .setRequired(true))
    .addIntegerOption(option =>
    option.setName('pastgames')
    .setDescription('Number of past games (optional)')
    .setRequired(false))
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Register global commands
async function registerGlobalCommands() {
    try {
        console.log('Started refreshing global application (/) commands.');

        await rest.put(
            Routes.applicationCommands(client.user.id),
                       { body: globalCommands },
        );

        console.log('Successfully reloaded global application (/) commands.');
    } catch (error) {
        console.error('Error refreshing global commands:', error);
    }
}

// Register guild-specific commands
async function registerGuildCommands(guild) {
    try {
        console.log(`Checking guild ${guild.name} for admin role...`);

        // Check if this guild has the admin role
        const adminRole = guild.roles.cache.get(ADMIN_ROLE_ID);

        if (adminRole) {
            console.log(`Guild ${guild.name} has the admin role, registering admin commands`);

            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guild.id),
                           { body: adminCommands },
            );

            console.log(`Successfully registered admin commands for guild ${guild.name}`);
        } else {
            console.log(`Guild ${guild.name} does not have the admin role, clearing guild commands`);

            // Clear any guild-specific commands
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guild.id),
                           { body: [] },
            );
        }
    } catch (error) {
        console.error(`Error managing guild commands for ${guild.name}:`, error);
    }
}

// Handle messages
client.on(Events.MessageCreate, async (message) => {
    const channelId = message.channelId;

    // Check if the message is from a monitored channel
    if (configChannels.includes(channelId)) {
        const content = message.content;

        // Handle update command
        if (content.startsWith('update now')) {
            // Refresh the K-value configuration
            await fetchKValueConfig();

            // Update all ranks channels
            for (const ranksChannelId of ranksChannels) {
                await updateRanks(ranksChannelId);
            }
            await message.channel.send('K-value config refreshed and update made in all ranks channels.');
        }

        // Handle nationality change command
        if (content.startsWith('change nationality of')) {
            const parts = content.split(' ');
            if (parts.length >= 6 && parts[4] === 'to') {
                const steamid = parts[3];
                const newNationality = parts.slice(5).join(' ');
                await updateNationality(steamid, newNationality, channelId);
            }
        }

        // Add a debug command to verify project settings
        if (content === 'check project') {
            const projectInfo = `Using Google Cloud project: Name: BPLRankings, Project ID: ${bigqueryClient.projectId}, Number: 805958038734`;
            await message.channel.send(projectInfo);
        }
    }
});

// Get color based on player rank
function getRankColor(rank) {
    if (rank <= 3) return 0xFFD700;      // Gold for top 3
    if (rank <= 10) return 0xC0C0C0;     // Silver for top 10
    if (rank <= 20) return 0xCD7F32;     // Bronze for top 20
    return 0x0099FF;                     // Blue for everyone else
}

// Modify the ClientReady event to process queued updates after initialization
client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);

    // Fetch the K-value configuration on startup
    await fetchKValueConfig();

    // Register global commands
    await registerGlobalCommands();

    // For each guild the bot is in, check for admin role and register admin commands if needed
    for (const guild of readyClient.guilds.cache.values()) {
        await registerGuildCommands(guild);
    }

    // Fetch existing messages in ranks channels to see if we should edit them
    try {
        for (const channelId of ranksChannels) {
            const channel = await client.channels.fetch(channelId);
            if (channel) {
                // Get the most recent messages
                const messages = await channel.messages.fetch({ limit: 10 });

                // Find the most recent message from this bot
                const botMessage = messages.find(msg => msg.author.id === client.user.id);
                if (botMessage) {
                    // Store this message ID for future edits
                    messageCache[channelId] = botMessage.id;
                    console.log(`Found existing bot message in channel ${channelId}: ${botMessage.id}`);
                }
            }
        }
    } catch (error) {
        console.error('Error fetching existing messages:', error);
    }

    setupPeriodicUpdates();

    // Set bot as ready and process any queued updates
    botReady = true;

    if (updateQueue.length > 0) {
        console.log(`Found ${updateQueue.length} queued updates, processing now`);
        await processUpdateQueue();
    }
});

// Function to get Steam avatar URL from Steam ID
async function getSteamAvatar(steamId) {
    // If the Steam API key is not provided, return null
    if (!process.env.STEAM_API_KEY) {
        console.warn('STEAM_API_KEY not found in environment variables');
        return null;
    }

    try {
        // Convert steamId to steamId64 if needed (if it's not already in that format)
        let steamId64 = steamId;
        if (!steamId.startsWith('7656')) {
            // This is a simplified conversion, in reality it would need more logic
            // for different Steam ID formats
            console.warn('SteamID is not in steamId64 format, using fallback image');
            return null;
        }

        // Call the Steam API to get player info
        const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId64}`);

        // Check if we got a valid response with player data
        if (response.data &&
            response.data.response &&
            response.data.response.players &&
            response.data.response.players.length > 0) {

            const player = response.data.response.players[0];

        // Return the avatar URL (medium size)
        return player.avatarmedium || player.avatar || null;
            }

            return null;
    } catch (error) {
        console.error('Error fetching Steam avatar:', error.message);
        return null;
    }
}

// Update the formatMatchResults function to use K-value config
async function formatMatchResults(matchData) {
    if (!matchData || !matchData.teams) {
        return "Error: Invalid match data";
    }

    // Use the cached K-value config instead of fetching it every time
    const kValueConfig = cachedKValueConfig;

    const winningTeam = matchData.winning_team;
    const timestamp = matchData.timestamp ? `<t:${matchData.timestamp}:F>` : "Unknown time";
    const team1Rating = matchData.team_ratings["1"];
    const team2Rating = matchData.team_ratings["2"];
    const team1WinChance = (matchData.expected_outcomes["1"] * 100).toFixed(1);
    const team2WinChance = (matchData.expected_outcomes["2"] * 100).toFixed(1);

    let resultString = `# Match Results (${timestamp})\n\n`;
    resultString += `## 🏆 **Team ${winningTeam} Victory**\n\n`;

    // Team info
    resultString += `**Team 1** (Rating: ${team1Rating}, Win Chance: ${team1WinChance}%)\n`;
    resultString += `**Team 2** (Rating: ${team2Rating}, Win Chance: ${team2WinChance}%)\n\n`;

    // Create a table for each team with player stats
    resultString += `### Team 1 Players\n`;
    if (matchData.teams["1"].length === 0) {
        resultString += "No players\n";
    } else {
        resultString += "```\n";
        resultString += "Player           | Before | After | Change | K  | Games \n";
        resultString += "-----------------|--------|-------|--------|----|---------\n";

        matchData.teams["1"].forEach(player => {
            const name = player.name.padEnd(16).substring(0, 16);
            const oldRating = String(player.old_rating).padEnd(7);
            const newRating = String(player.new_rating).padEnd(6);
            const delta = player.delta > 0 ? `+${player.delta}`.padEnd(7) : String(player.delta).padEnd(7);
            const kValue = String(player.k_value || "32").padEnd(3);
            const games = String(player.pastgames || "?");
            resultString += `${name} | ${oldRating}| ${newRating}| ${delta}| ${kValue}| ${games}\n`;
        });

        resultString += "```\n";
    }

    resultString += `### Team 2 Players\n`;
    if (matchData.teams["2"].length === 0) {
        resultString += "No players\n";
    } else {
        resultString += "```\n";
        resultString += "Player           | Before | After | Change | K  | Games \n";
        resultString += "-----------------|--------|-------|--------|----|---------\n";

        matchData.teams["2"].forEach(player => {
            const name = player.name.padEnd(16).substring(0, 16);
            const oldRating = String(player.old_rating).padEnd(7);
            const newRating = String(player.new_rating).padEnd(6);
            const delta = player.delta > 0 ? `+${player.delta}`.padEnd(7) : String(player.delta).padEnd(7);
            const kValue = String(player.k_value || "32").padEnd(3);
            const games = String(player.pastgames || "?");
            resultString += `${name} | ${oldRating}| ${newRating}| ${delta}| ${kValue}| ${games}\n`;
        });

        resultString += "```\n";
    }

    // Add explanation of K-value using the descriptions from config
    resultString += `\n**About K-Values:**\n`;
    resultString += `• K=${kValueConfig.kValues.newPlayer}: ${kValueConfig.descriptions.newPlayer}\n`;
    resultString += `• K=${kValueConfig.kValues.developingPlayer}: ${kValueConfig.descriptions.developingPlayer}\n`;
    resultString += `• K=${kValueConfig.kValues.establishedPlayer}: ${kValueConfig.descriptions.establishedPlayer}\n`;
    resultString += `\nHigher K-values cause larger rating changes.`;

    return resultString;
}

// Add error handling for channel fetching in sendMatchResults
async function sendMatchResults(matchData) {
    try {
        const formattedResults = await formatMatchResults(matchData);

        for (const channelId of matchResultsChannels) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel) {
                    await channel.send(formattedResults);
                    console.log(`Sent match results to channel ${channelId}`);
                } else {
                    console.error(`Channel ${channelId} not found for match results`);
                }
            } catch (error) {
                console.error(`Error sending match results to channel ${channelId}:`, error);
            }
        }
    } catch (error) {
        console.error("Error formatting or sending match results:", error);
    }
}

// Add a function to process the update queue
async function processUpdateQueue() {
    console.log(`Processing update queue (${updateQueue.length} items)`);

    while (updateQueue.length > 0) {
        const update = updateQueue.shift();

        try {
            if (update.type === 'match' && update.data) {
                console.log('Processing queued match data');
                await sendMatchResults(update.data);
            }

            // Update all ranks channels after each queued update
            for (const channelId of ranksChannels) {
                await updateRanks(channelId);
            }
        } catch (error) {
            console.error('Error processing queued update:', error);
        }
    }
}

// Define the admin role ID
const ADMIN_ROLE_ID = '1226974606687080598';

// Add a function to reset ranks via backend
async function resetRanksViaBackend(defaultElo = 2000) {
    try {
        // Use a special internal endpoint with a shared secret in the headers
        const backendUrl = 'https://bplrankings.uc.r.appspot.com/internal/reset-ranks';

        // Use a shared secret from environment variables
        const botSecret = process.env.BOT_INTERNAL_SECRET;

        if (!botSecret) {
            throw new Error('BOT_INTERNAL_SECRET not configured in environment variables');
        }

        const response = await axios.post(
            backendUrl,
            { default_elo: defaultElo },
            { headers: { 'X-Bot-Secret': botSecret } }
        );

        // The backend returns plain text with status code
        return {
            success: response.status === 200,
            message: response.data
        };
    } catch (error) {
        console.error('Error calling reset ranks endpoint:', error);
        return {
            success: false,
            message: error.response?.data || error.message
        };
    }
}

// Add this function near the resetRanksViaBackend function in index.js
async function setPlayerEloToZero(steamId = null, playerName = null) {
    try {
        // Use a special internal endpoint with a shared secret in the headers
        const backendUrl = 'https://bplrankings.uc.r.appspot.com/internal/set-elo-zero';

        // Use a shared secret from environment variables
        const botSecret = process.env.BOT_INTERNAL_SECRET;

        if (!botSecret) {
            throw new Error('BOT_INTERNAL_SECRET not configured in environment variables');
        }

        const response = await axios.post(
            backendUrl,
            {
                steamid: steamId,
                name: playerName
            },
            { headers: { 'X-Bot-Secret': botSecret } }
        );

        // The backend returns plain text with status code
        return {
            success: response.status === 200,
            message: response.data,
            playerData: response.data.playerData || null
        };
    } catch (error) {
        console.error('Error calling set elo zero endpoint:', error);
        return {
            success: false,
            message: error.response?.data || error.message,
            playerData: null
        };
    }
}

// The rest of the Discord bot code remains the same as in the previous artifact

// Handle the reset_ranks command in the interaction handler
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // Update the rank command handler to handle unranked players
    if (interaction.commandName === 'rank') {
        try {
            // Always respond immediately to prevent timeout
            await interaction.reply({ content: "Fetching rank information...", ephemeral: false });

            // Get parameters from the command
            const steamId = interaction.options.getString('steamid');
            const name = interaction.options.getString('name');

            // Get all ranking data
            const allRanks = await getAllRanksData();
            let playerData = null;

            // If steamId is provided, search by that
            if (steamId) {
                playerData = allRanks.find(player => player.steamid === steamId);
            }
            // Otherwise search by name
            else if (name) {
                // Case insensitive partial match
                playerData = allRanks.find(player =>
                player.name.toLowerCase().includes(name.toLowerCase()));
            }
            // If no parameters, assume looking up self by Discord name
            else {
                // Try to find a player with a name similar to the discord username
                const discordName = interaction.user.username;
                playerData = allRanks.find(player =>
                player.name.toLowerCase().includes(discordName.toLowerCase()));
            }

            if (!playerData) {
                let errorMessage = "Player not found in the rankings. They may not have played any ranked matches yet.";

                // Customize error message based on the search method
                if (steamId) {
                    errorMessage = `Could not find a player with Steam ID: ${steamId} in the rankings.`;
                } else if (name) {
                    errorMessage = `Could not find a player with name matching "${name}" in the rankings.`;
                } else {
                    errorMessage = `Could not match your Discord username (${interaction.user.username}) to any player in the rankings.`;
                }

                // Edit the original reply with the error message
                await interaction.editReply({ content: errorMessage });
                return;
            }

            // Use the cached K-value config
            const kValueConfig = cachedKValueConfig;

            // Determine player status
            const pastGames = playerData.pastgames || 0;
            const minGames = kValueConfig?.thresholds?.newPlayer || 5;
            const devGames = kValueConfig?.thresholds?.developingPlayer || 15;

            let playerStatus = "Unranked";
            let kValue = kValueConfig?.kValues?.newPlayer || 120;

            if (pastGames >= devGames) {
                playerStatus = "Established Player";
                kValue = kValueConfig?.kValues?.establishedPlayer || 30;
            } else if (pastGames >= minGames) {
                playerStatus = "Developing Player";
                kValue = kValueConfig?.kValues?.developingPlayer || 60;
            } else {
                playerStatus = "New Player (Unranked)";
                kValue = kValueConfig?.kValues?.newPlayer || 120;
            }

            // Format the rank display value
            const rankDisplay = playerData.rank === -1
            ? "Unranked"
            : `#${playerData.rank}`;

            // Simple text response as a fallback that will always work
            const simpleResponse = `${playerData.name} is ${rankDisplay} with ${playerData.elo} ELO. (${playerStatus}, ${pastGames} games played)`;

            try {
                // Try to get the Steam avatar
                let avatarUrl = null;
                try {
                    avatarUrl = await getSteamAvatar(playerData.steamid);
                } catch (avatarError) {
                    console.error("Error getting Steam avatar:", avatarError);
                }

                // Create a fancy embed for the player's stats
                const rankEmbed = {
                    color: getRankColor(playerData.absoluteRank),
          title: `${playerData.nationality || ''} ${playerData.name}'s Ranking Stats`,
          description: `Current ranking information for ${playerData.name}`,
          fields: [
              {
                  name: 'Rank',
          value: rankDisplay,
          inline: true,
              },
          {
              name: 'Rating',
          value: playerData.elo === cachedKValueConfig.defaultElo ? `${playerData.elo} (bottom)` : `${playerData.elo}`,
          inline: true,
          },
          {
              name: 'Games Played',
          value: `${pastGames}`,
          inline: true,
          },
          {
              name: 'Steam ID',
          value: `${playerData.steamid}`,
          inline: false,
          },
          ],
          timestamp: new Date(),
          footer: {
              text: `BPL Rankings | ${minGames}+ games needed to be ranked\nRating will never drop below ${cachedKValueConfig.defaultElo}`,
          },
                };

                // Add note for unranked players
                if (playerData.rank === -1) {
                    rankEmbed.fields.push({
                        name: 'Ranking Status',
                        value: `Need ${minGames - pastGames} more games to be officially ranked.`,
                        inline: false,
                    });
                }

                // Add thumbnail if we have an avatar
                if (avatarUrl) {
                    rankEmbed.thumbnail = { url: avatarUrl };
                }

                // Edit the original reply with the embed
                await interaction.editReply({ content: '', embeds: [rankEmbed] });

            } catch (embedError) {
                // If creating the embed fails, fall back to simple text
                console.error("Error creating embed:", embedError);
                await interaction.editReply({ content: simpleResponse });
            }

        } catch (error) {
            // If anything fails, log it and try to send a simple error message
            console.error("Error in rank command:", error);
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.editReply({ content: "An error occurred while fetching rank information." });
                } else {
                    await interaction.reply({ content: "An error occurred while fetching rank information." });
                }
            } catch (e) {
                console.error("Failed to send error message:", e);
            }
        }
    }

    // Reset ranks command handler
    if (interaction.commandName === 'reset_ranks') {
        try {
            // Double-check that user has the admin role for extra security
            const member = interaction.member;
            const hasAdminRole = member && member.roles && member.roles.cache.has(ADMIN_ROLE_ID);

            if (!hasAdminRole) {
                await interaction.reply({
                    content: "You need the admin role to use this command.",
                    ephemeral: true
                });
                return;
            }

            // Get the default ELO option
            const defaultElo = interaction.options.getInteger('default_elo') || 2000;

            // Create confirmation buttons
            const confirmButton = new ButtonBuilder()
            .setCustomId(`confirm_reset_${interaction.user.id}_${defaultElo}`)
            .setLabel('Confirm Reset')
            .setStyle(ButtonStyle.Danger);

            const cancelButton = new ButtonBuilder()
            .setCustomId(`cancel_reset_${interaction.user.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder()
            .addComponents(confirmButton, cancelButton);

            // Send confirmation message with buttons
            await interaction.reply({
                content: `⚠️ **WARNING**: You are about to reset ALL player ranks to ${defaultElo} ELO.\n\nThis action cannot be undone and will affect all players. Are you sure you want to proceed?`,
                components: [row],
                ephemeral: false
            });

            // Store the confirmation request with a 60-second timeout
            pendingResetConfirmations.set(interaction.user.id, {
                defaultElo: defaultElo,
                    messageId: (await interaction.fetchReply()).id,
                                          channelId: interaction.channelId,
                                          timestamp: Date.now(),
                                          userId: interaction.user.id
            });

            // Set timeout to expire the confirmation after 60 seconds
            setTimeout(() => {
                const pendingRequest = pendingResetConfirmations.get(interaction.user.id);
                if (pendingRequest) {
                    pendingResetConfirmations.delete(interaction.user.id);

                    // Try to edit the message to indicate expiration
                    try {
                        const channel = client.channels.cache.get(pendingRequest.channelId);
                        if (channel) {
                            channel.messages.fetch(pendingRequest.messageId)
                            .then(message => {
                                message.edit({
                                    content: `⏱️ Reset confirmation has expired.`,
                                    components: []
                                }).catch(console.error);
                            }).catch(console.error);
                        }
                    } catch (error) {
                        console.error("Error updating expired confirmation message:", error);
                    }
                }
            }, 60000); // 60 seconds

        } catch (error) {
            console.error("Error in reset_ranks command:", error);
            await interaction.reply({
                content: "An error occurred while processing the reset command.",
                ephemeral: true
            });
        }
    }

    // Set ELO to zero command handler
    if (interaction.commandName === 'set_elo_zero') {
        try {
            // Double-check that user has the admin role for extra security
            const member = interaction.member;
            const hasAdminRole = member && member.roles && member.roles.cache.has(ADMIN_ROLE_ID);

            if (!hasAdminRole) {
                await interaction.reply({
                    content: "You need the admin role to use this command.",
                    ephemeral: true
                });
                return;
            }

            // Get the parameters from the command
            const steamId = interaction.options.getString('steamid');
            const name = interaction.options.getString('name');

            // Validate input - need at least one parameter
            if (!steamId && !name) {
                await interaction.reply({
                    content: "Please provide either a Steam ID or a player name.",
                    ephemeral: true
                });
                return;
            }

            // Defer reply to buy time for the API call
            await interaction.deferReply();

            // First find the player if name is provided
            let targetSteamId = steamId;
            let targetName = name;
            let playerData = null;

            if (!steamId && name) {
                // Find player by name
                const allRanks = await getAllRanksData();
                playerData = allRanks.find(player =>
                player.name.toLowerCase().includes(name.toLowerCase())
                );

                if (!playerData) {
                    await interaction.editReply(`Could not find a player with name matching "${name}" in the rankings.`);
                    return;
                }

                targetSteamId = playerData.steamid;
                targetName = playerData.name;
            }

            // Call our backend function
            const result = await setPlayerEloToZero(targetSteamId, targetName);

            if (result.success) {
                // Send success message
                await interaction.editReply({
                    content: `⚠️ Player **${result.playerData?.name || targetName}** (${result.playerData?.steamid || targetSteamId}) ELO has been set to 0.\n\nRanks channels will be updated shortly.`
                });

                // Log the action
                console.log(`ELO set to 0 for player ${result.playerData?.name || targetName} (${result.playerData?.steamid || targetSteamId}) by ${interaction.user.tag} (${interaction.user.id})`);

                // Announce in admin channels
                for (const channelId of configChannels) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (channel) {
                            await channel.send(`⚠️ **ELO RESET**: Player **${result.playerData?.name || targetName}** (${result.playerData?.steamid || targetSteamId}) ELO has been set to 0 by ${interaction.user.tag}`);
                        }
                    } catch (error) {
                        console.error(`Error sending reset announcement to channel ${channelId}:`, error);
                    }
                }

                // Update all ranks channels
                for (const channelId of ranksChannels) {
                    await updateRanks(channelId);
                }
            } else {
                await interaction.editReply(`Error: ${result.message || 'Failed to set player ELO to 0'}`);
            }

        } catch (error) {
            console.error("Error in set_elo_zero command:", error);

            // Check if we've already replied
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: "An error occurred while setting player ELO to 0. Check the server logs for details."
                });
            } else {
                await interaction.reply({
                    content: "An error occurred while setting player ELO to 0. Check the server logs for details.",
                    ephemeral: true
                });
            }
        }
    }

    if (interaction.commandName === 'set_rating') {
        try {
            // Double-check that user has the admin role for extra security
            const member = interaction.member;
            const hasAdminRole = member && member.roles && member.roles.cache.has(ADMIN_ROLE_ID);

            if (!hasAdminRole) {
                await interaction.reply({
                    content: "You need the admin role to use this command.",
                    ephemeral: true
                });
                return;
            }

            // Get the parameters from the command
            const steamId = interaction.options.getString('steamid');
            const newRating = interaction.options.getInteger('rating');
            const pastGamesOption = interaction.options.getInteger('pastgames');

            // Defer reply to buy time for the database operation
            await interaction.deferReply();

            try {
                // First query to get the existing record - with explicit type for steamid
                const selectQuery = `
                SELECT *
                FROM \`Main.rankings\`
                WHERE steamid = @steamid
                ORDER BY timestamp DESC
                LIMIT 1
                `;

                const selectOptions = {
                    query: selectQuery,
          params: { steamid: steamId },
          types: { steamid: 'STRING' }
                };

                const [rows] = await bigqueryClient.query(selectOptions);

                if (rows.length === 0) {
                    await interaction.editReply({
                        content: `Error: No player found with Steam ID ${steamId}`
                    });
                    return;
                }

                const selectedRow = rows[0];
                const oldRating = selectedRow.elo;

                // Insert query with the updated rating - with explicit types for all parameters
                const insertQuery = `
                INSERT INTO \`Main.rankings\` (name, steamid, elo, timestamp, nationality, pastgames)
                VALUES (@name, @steamid, @elo, @timestamp, @nationality, @pastgames)
                `;

                const insertOptions = {
                    query: insertQuery,
          params: {
              name: selectedRow.name,
          steamid: selectedRow.steamid,
          elo: newRating,
          timestamp: Math.floor(Date.now() / 1000),
          nationality: selectedRow.nationality,
          pastgames: pastGamesOption !== null ? pastGamesOption : (selectedRow.pastgames || 0)
          },
          // Explicitly specify types for all parameters to handle null values
          types: {
              name: 'STRING',
          steamid: 'STRING',
          elo: 'INT64',
          timestamp: 'INT64',
          nationality: 'STRING',
          pastgames: 'INT64'
          }
                };

                const [insertResponse] = await bigqueryClient.query(insertOptions);

                // Determine if pastgames was updated
                const oldPastGames = selectedRow.pastgames || 0;
                const newPastGames = pastGamesOption !== null ? pastGamesOption : oldPastGames;
                const pastGamesUpdated = pastGamesOption !== null;

                // Send success message
                let successMessage = `✅ Player **${selectedRow.name}** (${steamId}) rating has been changed from ${oldRating} to ${newRating}.`;

                // Add information about pastgames if it was updated
                if (pastGamesUpdated) {
                    successMessage += `\nGames played count has been changed from ${oldPastGames} to ${newPastGames}.`;
                }

                successMessage += `\n\nRanks channels will be updated shortly.`;

                await interaction.editReply({
                    content: successMessage
                });

                // Log the action
                console.log(`Rating changed for player ${selectedRow.name} (${steamId}) from ${oldRating} to ${newRating} by ${interaction.user.tag} (${interaction.user.id})`);

                // Announce in admin channels
                for (const channelId of configChannels) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (channel) {
                            let announcementMessage = `⚠️ **RATING CHANGE**: Player **${selectedRow.name}** (${steamId}) rating has been manually changed from ${oldRating} to ${newRating} by ${interaction.user.tag}`;

                            // Add information about pastgames if it was updated
                            if (pastGamesUpdated) {
                                announcementMessage += `\nGames played count has been changed from ${oldPastGames} to ${newPastGames}.`;
                            }

                            await channel.send(announcementMessage);
                        }
                    } catch (error) {
                        console.error(`Error sending rating change announcement to channel ${channelId}:`, error);
                    }
                }

                // Update all ranks channels
                for (const channelId of ranksChannels) {
                    await updateRanks(channelId);
                }
            } catch (error) {
                console.error("Error in database operation:", error);
                await interaction.editReply({
                    content: `Error: ${error.message || 'Failed to set player rating'}`
                });
            }
        } catch (error) {
            console.error("Error in set_rating command:", error);

            // Check if we've already replied
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: "An error occurred while setting player rating. Check the server logs for details."
                });
            } else {
                await interaction.reply({
                    content: "An error occurred while setting player rating. Check the server logs for details.",
                    ephemeral: true
                });
            }
        }
    }
});

// Handle guild join/update events
client.on(Events.GuildCreate, async guild => {
    console.log(`Joined new guild: ${guild.name}`);
    await registerGuildCommands(guild);
});

// When a guild role is updated, check if it's our admin role
client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
    if (newRole.id === ADMIN_ROLE_ID) {
        console.log(`Admin role updated in guild ${newRole.guild.name}`);
        await registerGuildCommands(newRole.guild);
    }
});


// Add a handler for button interactions in the InteractionCreate event
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;

    // Handle reset confirmation buttons
    if (customId.startsWith('confirm_reset_')) {
        // Extract user ID and default ELO from the custom ID
        const parts = customId.split('_');
        const userId = parts[2];
        const defaultElo = parseInt(parts[3], 10);

        // Check if this is the user who initiated the reset
        if (interaction.user.id !== userId) {
            await interaction.reply({
                content: "Only the user who initiated the reset can confirm it.",
                ephemeral: true
            });
            return;
        }

        // Check if we have a pending reset for this user
        const pendingRequest = pendingResetConfirmations.get(userId);
        if (!pendingRequest) {
            await interaction.reply({
                content: "This reset confirmation has expired or was already processed.",
                ephemeral: true
            });
            return;
        }

        // Remove the pending request
        pendingResetConfirmations.delete(userId);

        // Update the message to indicate processing
        await interaction.update({
            content: "Processing reset... Please wait.",
            components: []
        });

        try {
            // Call our backend function
            const result = await resetRanksViaBackend(defaultElo);

            // fake calling the backend function
            // const result = {
            //     success: true,
            //     message: "Reset command is currently disabled. This is just a simulation."
            // };

            if (result.success) {
                // Send success message
                await interaction.editReply({
                    content: `🔄 All player ranks have been reset to ${defaultElo} ELO with 0 past games.\n\nRanks channels will be updated shortly.`
                });

                // Log the action
                console.log(`Ranks reset to ${defaultElo} by ${interaction.user.tag} (${interaction.user.id})`);

                // Announce in admin channels
                for (const channelId of configChannels) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (channel) {
                            await channel.send(`🔄 **RANKS RESET**: All player ranks have been reset to ${defaultElo} by ${interaction.user.tag}`);
                        }
                    } catch (error) {
                        console.error(`Error sending reset announcement to channel ${channelId}:`, error);
                    }
                }

                // Update all ranks channels
                for (const channelId of ranksChannels) {
                    await updateRanks(channelId);
                }
            } else {
                await interaction.editReply(`Error: ${result.message || 'Failed to reset ranks'}`);
            }
        } catch (error) {
            console.error("Error processing reset after confirmation:", error);
            await interaction.editReply({
                content: "An error occurred while resetting ranks. Check the server logs for details."
            });
        }
    }

    // Handle cancel button
    else if (customId.startsWith('cancel_reset_')) {
        // Extract user ID from the custom ID
        const userId = customId.split('_')[2];

        // Check if this is the user who initiated the reset
        if (interaction.user.id !== userId) {
            await interaction.reply({
                content: "Only the user who initiated the reset can cancel it.",
                ephemeral: true
            });
            return;
        }

        // Check if we have a pending reset for this user
        const pendingRequest = pendingResetConfirmations.get(userId);
        if (!pendingRequest) {
            await interaction.reply({
                content: "This reset confirmation has expired or was already processed.",
                ephemeral: true
            });
            return;
        }

        // Remove the pending request
        pendingResetConfirmations.delete(userId);

        // Update the message to indicate cancellation
        await interaction.update({
            content: "❌ Reset cancelled.",
            components: []
        });
    }
});

// Function to fetch the K-value configuration from the backend
async function fetchKValueConfig() {
    try {
        console.log('Fetching K-value configuration from backend');
        const configResponse = await axios.get('https://bplrankings.uc.r.appspot.com/api/k-value-config');
        cachedKValueConfig = configResponse.data;
        console.log('K-value configuration updated successfully');
        return cachedKValueConfig;
    } catch (error) {
        console.error('Error fetching K-value config:', error);
        // Return the cached config if the fetch fails
        return cachedKValueConfig;
    }
}

// Login to Discord with your token from .env
client.login(process.env.DISCORD_TOKEN);
