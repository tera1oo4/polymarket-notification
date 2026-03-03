import axios from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

const POLYMARKET_HOST = 'https://clob.polymarket.com';

export interface PolymarketUserConfig {
    telegramId: string;
    address: string;
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
}

export class PolymarketService extends EventEmitter {
    private ws: WebSocket | null = null;
    private reconnectionDelay = 5000;
    private readonly maxReconnectionDelay = 60000;
    private wsFailureCount = 0;
    private readonly maxWsFailures = 5;
    private config: PolymarketUserConfig;
    private lastPortfolio: Map<string, any> = new Map();
    private portfolioInitialized = false;
    private pollingInterval: ReturnType<typeof setInterval> | null = null;
    private stopped = false;

    constructor(config: PolymarketUserConfig) {
        super();
        this.config = config;
        this.initWebSocket();
        console.log(`[User ${config.telegramId}] PolymarketService started. Address: ${config.address}`);
    }

    /** Gracefully stop all polling and WebSocket connections */
    stop() {
        this.stopped = true;
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        this.removeAllListeners();
        console.log(`[User ${this.config.telegramId}] PolymarketService stopped.`);
    }

    async getPortfolio() {
        try {
            if (!this.config.address) {
                console.error(`[User ${this.config.telegramId}] getPortfolio: No address set`);
                return [];
            }

            const dataApiUrl = `https://data-api.polymarket.com/positions?user=${this.config.address}`;
            const response = await axios.get(dataApiUrl);
            const positions = response.data;

            if (!positions || !Array.isArray(positions)) return [];

            const portfolio = [];
            for (const pos of positions) {
                try {
                    const size = parseFloat(pos.size || '0');
                    if (size === 0) continue;
                    if (pos.redeemable === true) continue;

                    const assetId = pos.asset || pos.asset_id;
                    const avgPrice = parseFloat(pos.avgPrice || pos.avg_price || '0');
                    const currentPrice = parseFloat(pos.curPrice || pos.currentPrice || '0');

                    const pnl = pos.cashPnl !== undefined ? parseFloat(pos.cashPnl) : (currentPrice - avgPrice) * size;
                    const pnlPercent = pos.percentPnl !== undefined ? parseFloat(pos.percentPnl) : (avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0);

                    portfolio.push({
                        market: pos.title || pos.market_title || assetId || 'Unknown Market',
                        outcome: pos.outcome || 'N/A',
                        size,
                        avgPrice,
                        currentPrice,
                        pnl,
                        pnlPercent,
                        value: size * currentPrice,
                        endDate: pos.endDate,
                    });
                } catch (err) {
                    console.error(`[User ${this.config.telegramId}] Error parsing position:`, err);
                }
            }
            return portfolio;
        } catch (error: any) {
            console.error(`[User ${this.config.telegramId}] Error fetching portfolio:`, error.response?.data || error.message);
            return [];
        }
    }

    startPortfolioPolling(intervalMs = 60000) {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        console.log(`[User ${this.config.telegramId}] Portfolio polling started (every ${intervalMs / 1000}s).`);
        this.checkPortfolioChanges();
        this.pollingInterval = setInterval(() => {
            if (!this.stopped) this.checkPortfolioChanges();
        }, intervalMs);
    }

    private async checkPortfolioChanges() {
        try {
            const portfolio = await this.getPortfolio();
            const now = new Date();
            const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

            for (const pos of portfolio) {
                const key = `${pos.market}|${pos.outcome}`;
                const prev = this.lastPortfolio.get(key);

                if (!prev) {
                    if (this.portfolioInitialized) {
                        const pnlEmoji = pos.pnl >= 0 ? '🟢' : '🔴';
                        const pnlSign = pos.pnl >= 0 ? '+' : '';
                        const notification =
                            `🆕 *New Position Opened*\n` +
                            `🕐 ${timeStr} MSK\n\n` +
                            `📍 *${pos.market}*\n` +
                            `   Outcome: \`${pos.outcome}\`\n\n` +
                            `*── Position ──*\n` +
                            `📦 Size: ${pos.size.toFixed(1)} shares\n` +
                            `💰 Avg Buy: $${pos.avgPrice.toFixed(3)}\n` +
                            `💵 Current: $${pos.currentPrice.toFixed(3)}\n` +
                            `💎 Total Value: $${pos.value.toFixed(2)}\n` +
                            `${pnlEmoji} P/L: ${pnlSign}$${pos.pnl.toFixed(2)} (${pnlSign}${pos.pnlPercent.toFixed(2)}%)`;
                        this.emit('position_update', notification);
                    }
                    this.lastPortfolio.set(key, pos);
                    continue;
                }

                const sizeDelta = pos.size - prev.size;

                // Only notify when the number of shares changes (buy more / partial sell)
                if (sizeDelta !== 0) {
                    const sizeDeltaSign = sizeDelta >= 0 ? '+' : '';
                    const action = sizeDelta > 0 ? '📥 *Shares Added*' : '📤 *Shares Reduced*';
                    const pnlEmoji = pos.pnl >= 0 ? '🟢' : '🔴';
                    const pnlSign = pos.pnl >= 0 ? '+' : '';

                    const notification =
                        `${action}\n` +
                        `🕐 ${timeStr} MSK\n\n` +
                        `📍 *${pos.market}*\n` +
                        `   Outcome: \`${pos.outcome}\`\n\n` +
                        `📦 Size: ${prev.size.toFixed(1)} → ${pos.size.toFixed(1)} shares (${sizeDeltaSign}${sizeDelta.toFixed(1)})\n` +
                        `💰 Avg Buy: $${pos.avgPrice.toFixed(3)}\n` +
                        `💵 Current: $${pos.currentPrice.toFixed(3)}\n` +
                        `💎 Value: $${pos.value.toFixed(2)}\n` +
                        `${pnlEmoji} P/L: ${pnlSign}$${pos.pnl.toFixed(2)} (${pnlSign}${pos.pnlPercent.toFixed(2)}%)`;
                    this.emit('position_update', notification);
                }

                this.lastPortfolio.set(key, pos);
            }

            // Detect closed positions
            if (this.portfolioInitialized) {
                for (const [key, prev] of this.lastPortfolio) {
                    const stillExists = portfolio.some(p => `${p.market}|${p.outcome}` === key);
                    if (!stillExists) {
                        const pnlSign = prev.pnl >= 0 ? '+' : '';
                        const pnlEmoji = prev.pnl >= 0 ? '🏆' : '❌';
                        const notification =
                            `${pnlEmoji} *Position Closed / Resolved*\n` +
                            `🕐 ${timeStr} MSK\n\n` +
                            `📍 *${prev.market}*\n` +
                            `   Outcome: \`${prev.outcome}\`\n\n` +
                            `💰 *Final P/L:* ${pnlSign}$${prev.pnl.toFixed(2)}`;
                        this.emit('position_update', notification);
                        this.lastPortfolio.delete(key);
                    }
                }
            }

            if (!this.portfolioInitialized) {
                this.portfolioInitialized = true;
                console.log(`[User ${this.config.telegramId}] Portfolio initialized with ${portfolio.length} position(s).`);
            }
        } catch (err: any) {
            console.error(`[User ${this.config.telegramId}] Portfolio polling error:`, err.message);
        }
    }

    async initWebSocket() {
        if (this.stopped) return;

        const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', async () => {
            console.log(`[User ${this.config.telegramId}] Connected to Polymarket WebSocket.`);

            try {
                const subscribeMsg = {
                    type: 'user',
                    auth: {
                        apiKey: this.config.apiKey,
                        secret: this.config.apiSecret,
                        passphrase: this.config.apiPassphrase,
                    }
                };

                this.ws?.send(JSON.stringify(subscribeMsg));

                const pingInterval = setInterval(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'ping' }));
                    } else {
                        clearInterval(pingInterval);
                    }
                }, 20000);
            } catch (err) {
                console.error(`[User ${this.config.telegramId}] WS auth failed:`, err);
            }
        });

        this.ws.on('message', (data: string) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'subscription_start') {
                    console.log(`[User ${this.config.telegramId}] ✅ WS subscription confirmed.`);
                    this.reconnectionDelay = 5000;
                    this.wsFailureCount = 0;
                }
                if (message.type === 'error' && message.message?.includes('Unauthorized')) {
                    console.error(`[User ${this.config.telegramId}] ❌ WS Auth Error:`, message.message);
                    this.wsFailureCount++;
                }
                this.handleWsMessage(message);
            } catch (err) {
                console.error(`[User ${this.config.telegramId}] WS parse error:`, err);
            }
        });

        this.ws.on('error', (err) => {
            console.error(`[User ${this.config.telegramId}] WS error:`, err.message);
        });

        this.ws.on('close', (code) => {
            if (this.stopped) return;
            this.wsFailureCount++;
            this.reconnectionDelay = Math.min(this.reconnectionDelay * 2, this.maxReconnectionDelay);

            if (this.wsFailureCount >= this.maxWsFailures) {
                console.error(`[User ${this.config.telegramId}] ❌ WS failed ${this.wsFailureCount} times. Stopping WS retries.`);
                return;
            }

            console.log(`[User ${this.config.telegramId}] WS closed (${code}). Retry in ${this.reconnectionDelay / 1000}s...`);
            setTimeout(() => this.initWebSocket(), this.reconnectionDelay);
        });
    }

    private handleWsMessage(data: any) {
        const validEvents = ['fill', 'order_fill', 'trade'];
        if (validEvents.includes(data.event_type) || data.type === 'fill' || data.type === 'order_fill') {
            const side = data.side || data.order?.side || data.msg?.side;
            const size = data.size || data.quantity || data.fill_size || data.order?.size || data.msg?.size;
            const price = data.price || data.fill_price || data.order?.price || data.msg?.price;
            const assetId = data.asset_id || data.market || data.order?.asset_id || data.msg?.asset_id;
            const marketTitle = data.market_title || data.title || data.order?.market_title || data.msg?.market_title || assetId;

            if (!side || !size || !price) return;

            const sideEmoji = side.toUpperCase() === 'BUY' ? '🟢' : '🔴';
            const notification = `✅ *Trade Executed*\n\n` +
                `📍 *Market:* ${marketTitle}\n` +
                `${sideEmoji} *Side:* ${side}\n` +
                `📦 *Size:* ${size}\n` +
                `💵 *Price:* $${price}\n` +
                `💰 *Total:* $${(parseFloat(size) * parseFloat(price)).toFixed(2)}`;
            this.emit('trade', notification);
        }
    }
}
