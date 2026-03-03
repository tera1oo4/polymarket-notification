import * as dotenv from 'dotenv';
dotenv.config();

import { initDatabase } from './database';
import { userManager, bot } from './bot';

async function main() {
    console.log('🚀 Polymarket Telegram Bot is starting...');

    // Initialize PostgreSQL database
    await initDatabase();

    // Restore all registered users from DB
    await userManager.restoreAll();

    // Register command suggestions (shown when user types "/" in Telegram)
    await bot.setMyCommands([
        { command: 'start', description: 'Register / Main menu' },
        { command: 'portfolio', description: 'View your positions & P/L' },
        { command: 'settings', description: 'Manage wallets & account' },
        { command: 'sleep', description: 'Mute notifications (30m / 1h / 4h / 8h)' },
        { command: 'wakeup', description: 'Unmute notifications' },
        { command: 'logout', description: 'Delete your account' },
        { command: 'help', description: 'Show all commands' },
    ]);
    console.log('✅ Bot commands registered.');

    console.log('✅ Bot is ready. Send /start in Telegram to register.');
}

main().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
