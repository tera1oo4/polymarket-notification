import * as dotenv from 'dotenv';
dotenv.config();

import { initDatabase } from './database';
import { userManager } from './bot';

async function main() {
    console.log('🚀 Polymarket Telegram Bot is starting...');

    // Initialize PostgreSQL database
    await initDatabase();

    // Restore all registered users from DB
    await userManager.restoreAll();

    console.log('✅ Bot is ready. Send /start in Telegram to register.');
}

main().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
