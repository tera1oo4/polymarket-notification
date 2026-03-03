import { PolymarketService, PolymarketUserConfig } from './polymarketService';
import { getAllUsers, isUserSleeping, UserRecord } from './database';

export class UserManager {
    /** Active services keyed by Telegram user ID */
    private services: Map<string, PolymarketService> = new Map();

    /** Callback to send notifications to a specific Telegram user */
    private sendNotification: (telegramId: string, message: string) => void;

    constructor(sendNotification: (telegramId: string, message: string) => void) {
        this.sendNotification = sendNotification;
    }

    /** Start monitoring for a specific user */
    startUser(user: UserRecord | PolymarketUserConfig & { telegramId: string }) {
        // Stop existing service if any
        this.stopUser('telegram_id' in user ? user.telegram_id : user.telegramId);

        const telegramId = 'telegram_id' in user ? user.telegram_id : user.telegramId;
        const config: PolymarketUserConfig = {
            telegramId,
            address: 'telegram_id' in user ? user.address : user.address,
            apiKey: 'telegram_id' in user ? user.api_key : user.apiKey,
            apiSecret: 'telegram_id' in user ? user.api_secret : user.apiSecret,
            apiPassphrase: 'telegram_id' in user ? user.api_passphrase : user.apiPassphrase,
        };

        const service = new PolymarketService(config);

        // Wire up notifications with sleep check
        service.on('trade', async (notification: string) => {
            if (!(await isUserSleeping(telegramId))) {
                this.sendNotification(telegramId, notification);
            }
        });

        service.on('position_update', async (notification: string) => {
            if (!(await isUserSleeping(telegramId))) {
                this.sendNotification(telegramId, notification);
            }
        });

        // Start portfolio polling (every 5 seconds)
        service.startPortfolioPolling(5000);

        this.services.set(telegramId, service);
        console.log(`[UserManager] Started service for user ${telegramId}`);
    }

    /** Stop monitoring for a specific user */
    stopUser(telegramId: string) {
        const existing = this.services.get(telegramId);
        if (existing) {
            existing.stop();
            this.services.delete(telegramId);
            console.log(`[UserManager] Stopped service for user ${telegramId}`);
        }
    }

    /** Get portfolio for a specific user */
    async getPortfolio(telegramId: string) {
        const service = this.services.get(telegramId);
        if (!service) return null;
        return service.getPortfolio();
    }

    /** Restore all users from DB on startup */
    async restoreAll() {
        const users = await getAllUsers();
        console.log(`[UserManager] Restoring ${users.length} user(s) from database...`);
        for (const user of users) {
            this.startUser(user);
        }
    }

    /** Check if a user has an active service */
    hasUser(telegramId: string): boolean {
        return this.services.has(telegramId);
    }
}
