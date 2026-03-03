import { PolymarketService, PolymarketUserConfig } from './polymarketService';
import { getAllUsers, getWallets, isUserSleeping, WalletRecord } from './database';

export class UserManager {
    /** Active services keyed by wallet ID (walletId → service) */
    private services: Map<number, PolymarketService> = new Map();

    private sendNotification: (telegramId: string, message: string) => void;

    constructor(sendNotification: (telegramId: string, message: string) => void) {
        this.sendNotification = sendNotification;
    }

    /** Start monitoring for a specific wallet */
    startWallet(wallet: WalletRecord) {
        // Stop existing service for this wallet if any
        this.stopWallet(wallet.id);

        const config: PolymarketUserConfig = {
            telegramId: wallet.telegram_id,
            address: wallet.address,
            apiKey: wallet.api_key,
            apiSecret: wallet.api_secret,
            apiPassphrase: wallet.api_passphrase,
        };

        const service = new PolymarketService(config);

        service.on('trade', async (notification: string) => {
            if (!(await isUserSleeping(wallet.telegram_id))) {
                const header = `🏦 _[${wallet.nickname}]_\n`;
                this.sendNotification(wallet.telegram_id, header + notification);
            }
        });

        service.on('position_update', async (notification: string) => {
            if (!(await isUserSleeping(wallet.telegram_id))) {
                const header = `🏦 _[${wallet.nickname}]_\n`;
                this.sendNotification(wallet.telegram_id, header + notification);
            }
        });

        service.startPortfolioPolling(5000);

        this.services.set(wallet.id, service);
        console.log(`[UserManager] Started wallet #${wallet.id} "${wallet.nickname}" for user ${wallet.telegram_id}`);
    }

    /** Stop monitoring for a specific wallet */
    stopWallet(walletId: number) {
        const existing = this.services.get(walletId);
        if (existing) {
            existing.stop();
            this.services.delete(walletId);
            console.log(`[UserManager] Stopped wallet #${walletId}`);
        }
    }

    /** Stop all wallets for a given Telegram user */
    stopUser(telegramId: string) {
        for (const [walletId, service] of this.services) {
            if ((service as any).config?.telegramId === telegramId) {
                service.stop();
                this.services.delete(walletId);
            }
        }
    }

    /** Get combined portfolio for all wallets of a user */
    async getPortfolio(telegramId: string): Promise<{ wallet: string; positions: any[] }[]> {
        const result: { wallet: string; positions: any[] }[] = [];
        for (const [walletId, service] of this.services) {
            if ((service as any).config?.telegramId === telegramId) {
                const positions = await service.getPortfolio();
                const walletName = (service as any).config?.nickname || `Wallet #${walletId}`;
                result.push({ wallet: walletName, positions });
            }
        }
        return result;
    }

    /** Restore all wallet services from DB on startup */
    async restoreAll() {
        const users = await getAllUsers();
        console.log(`[UserManager] Restoring ${users.length} user(s) from database...`);
        for (const user of users) {
            const wallets = await getWallets(user.telegram_id);
            for (const wallet of wallets) {
                this.startWallet(wallet);
            }
        }
    }

    /** Check if user has any active wallets */
    hasUser(telegramId: string): boolean {
        for (const [, service] of this.services) {
            if ((service as any).config?.telegramId === telegramId) return true;
        }
        return false;
    }
}
