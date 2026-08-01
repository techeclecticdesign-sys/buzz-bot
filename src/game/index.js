// Game module entry point. logger-bot's src/index.js imports this and calls
// init() at startup, registerCommands() on ready, and routes interactions here.
// Everything is gated on GAME_ENABLED so the bot can run without the game.
const db = require('./db');
const commands = require('./commands');

const ENABLED = process.env.GAME_ENABLED !== 'false';

async function init() {
  await db.init();
}

// Register the game's slash commands as guild commands (instant, no 1h global
// delay) in every guild the bot is in. Requires the bot to have been invited
// with the applications.commands scope.
async function registerCommands(client) {
  const cmds = commands.commandData();
  for (const guild of client.guilds.cache.values()) {
    try {
      await client.application.commands.set(cmds, guild.id);
      console.log(`[game] registered ${cmds.length} commands in ${guild.name}`);
    } catch (err) {
      console.error(`[game] command registration failed for ${guild.name}:`, err.message);
    }
  }
}

function commandData() {
  return commands.commandData();
}

// Route an interaction. Replies with a friendly error if a handler throws, so
// the user never sees a bare "interaction failed".
async function handleInteraction(interaction) {
  try {
    return await commands.handleInteraction(interaction);
  } catch (err) {
    console.error('[game] interaction error:', err.message);
    try {
      const msg = { content: '⚠️ Something went wrong — try again in a moment.' };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ ...msg, flags: 64 /* Ephemeral */ });
    } catch {
      /* interaction already gone */
    }
    return true;
  }
}

module.exports = { ENABLED, init, registerCommands, commandData, handleInteraction };
