import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import {
    getUser, ensureUser, deleteUser, setSleepUntil, isUserSleeping,
    getWallets, getWallet, addWallet, updateWallet, deleteWallet
} from './database';
import { UserManager } from './userManager';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required in .env');

export const bot = new TelegramBot(token, { polling: true });

// ─── Utility: split long Telegram messages ────────────────────────────────────
const splitMessage = (text: string, maxLength = 4000): string[] => {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let current = '';
    for (const line of text.split('\n')) {
        if ((current + line + '\n').length > maxLength) {
            chunks.push(current);
            current = line + '\n';
        } else {
            current += line + '\n';
        }
    }
    if (current) chunks.push(current);
    return chunks;
};

/** Smart price formatter: shows enough decimals without unnecessary zeros */
const fmtPrice = (price: number): string => {
    if (price === 0) return '$0.00';
    if (price >= 1) return `$${price.toFixed(2)}`;
    if (price >= 0.01) return `$${price.toFixed(2)}`; // e.g. $0.05 for 5 cents
    return `$${price.toFixed(4)}`; // e.g. $0.0015 for very small prices
};

const fmtPnl = (n: number): string => {
    const sign = n >= 0 ? '+' : '';
    return `${sign}$${Math.abs(n).toFixed(2)}`;
};

// ─── State machines ───────────────────────────────────────────────────────────
interface RegState {
    step: 'nickname' | 'address' | 'api_key' | 'api_secret' | 'api_passphrase';
    editing?: boolean;   // true = adding/editing wallet, false = initial registration
    walletId?: number;   // set when editing existing wallet
    editField?: string;  // set when editing a single field
    nickname?: string;
    address?: string;
    api_key?: string;
    api_secret?: string;
}

// chatId → state
const regStates = new Map<number, RegState>();

// ─── UserManager ──────────────────────────────────────────────────────────────
export const userManager = new UserManager((telegramId: string, message: string) => {
    bot.sendMessage(telegramId, message, { parse_mode: 'Markdown' }).catch(err => {
        console.error(`[Bot] Failed to notify ${telegramId}:`, err.message);
    });
});

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const existing = await getUser(telegramId);
    if (existing) {
        const wallets = await getWallets(telegramId);
        return bot.sendMessage(chatId,
            `🚀 *Polymarket Monitor Bot*\n\n` +
            `You have *${wallets.length}* wallet(s) monitored.\n\n` +
            `📊 *Commands:*\n` +
            `• /portfolio — Positions & P/L\n` +
            `• /settings — Manage wallets & sleep\n` +
            `• /sleep — Mute notifications\n` +
            `• /wakeup — Unmute\n` +
            `• /help — All commands`,
            { parse_mode: 'Markdown' }
        );
    }

    // Start registration
    await ensureUser(telegramId);
    regStates.set(chatId, { step: 'nickname' });
    bot.sendMessage(chatId,
        '👋 *Welcome to Polymarket Monitor Bot!*\n\n' +
        'Let\'s add your first wallet.\n\n' +
        '🏷️ *Step 1/5:* Enter a nickname for this wallet (e.g. "Main", "Trading"):',
        { parse_mode: 'Markdown' }
    );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
    bot.sendMessage(msg.chat.id,
        '📊 *Polymarket Monitor Bot*\n\n' +
        '*Commands:*\n' +
        '• `/start` — Register / main menu\n' +
        '• `/portfolio` — View all positions\n' +
        '• `/settings` — Manage wallets, sleep mode\n' +
        '• `/sleep` — Mute notifications\n' +
        '• `/wakeup` — Unmute\n' +
        '• `/logout` — Delete your account\n' +
        '• `/help` — This message\n\n' +
        '*Auto Notifications:*\n' +
        '• Trade fills (WebSocket)\n' +
        '• Shares added/reduced (polling)',
        { parse_mode: 'Markdown' }
    );
});

// ─── /portfolio ───────────────────────────────────────────────────────────────
bot.onText(/\/portfolio/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    if (!(await getUser(telegramId))) {
        return bot.sendMessage(chatId, '⚠️ Not registered. Use /start to set up.');
    }

    const loadingMsg = await bot.sendMessage(chatId, '⏳ _Calculating portfolio..._', { parse_mode: 'Markdown' });

    try {
        const grouped = await userManager.getPortfolio(telegramId);
        const allPositions = grouped.flatMap(g => g.positions.map(p => ({ ...p, _wallet: g.wallet })));

        if (!allPositions.length) {
            return bot.editMessageText('ℹ️ Your portfolio is currently empty.', {
                chat_id: chatId, message_id: loadingMsg.message_id,
            });
        }

        let response = '📊 *Portfolio Overview*\n\n';
        let totalValue = 0, totalPnl = 0;
        let lastWallet = '';

        for (const p of allPositions) {
            if (p._wallet !== lastWallet) {
                if (lastWallet) response += '\n';
                response += `🏦 *${p._wallet}*\n`;
                lastWallet = p._wallet;
            }
            const pnlEmoji = p.pnl >= 0 ? '📈' : '📉';
            const pnlSign = p.pnl >= 0 ? '+' : '';
            response += `\n📍 *${p.market}*\n` +
                `   Outcome: \`${p.outcome || 'N/A'}\`\n` +
                `   Size: ${p.size.toFixed(1)} @ ${fmtPrice(p.avgPrice)}\n` +
                `   Now: ${fmtPrice(p.currentPrice)} | $${p.value.toFixed(2)}\n` +
                `   ${pnlEmoji} P/L: ${pnlSign}$${p.pnl.toFixed(2)} (${pnlSign}${p.pnlPercent.toFixed(2)}%)\n`;
            totalValue += p.value;
            totalPnl += p.pnl;
        }

        const totalEmoji = totalPnl >= 0 ? '🟢' : '🔴';
        response += `\n───────\n` +
            `💎 *Total Value:* $${totalValue.toFixed(2)}\n` +
            `${totalEmoji} *Net P/L:* ${fmtPnl(totalPnl)}`;

        const chunks = splitMessage(response);
        await bot.editMessageText(chunks[0], {
            chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown',
        });
        for (let i = 1; i < chunks.length; i++) {
            await bot.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown' });
        }
    } catch (err) {
        console.error('Portfolio error:', err);
        await bot.editMessageText('❌ Failed to fetch portfolio.', {
            chat_id: chatId, message_id: loadingMsg.message_id,
        });
    }
});

// ─── /settings ────────────────────────────────────────────────────────────────
bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    if (!(await getUser(telegramId))) {
        return bot.sendMessage(chatId, '⚠️ Not registered. Use /start to set up.');
    }
    await sendSettingsMenu(chatId, telegramId);
});

async function sendSettingsMenu(chatId: number, telegramId: string, editMsgId?: number) {
    const wallets = await getWallets(telegramId);
    const sleeping = await isUserSleeping(telegramId);

    let text = '⚙️ *Settings*\n\n';
    text += sleeping ? '😴 Notifications: *Muted*\n' : '☀️ Notifications: *Active*\n';
    text += `\n📂 *Wallets (${wallets.length}):*\n`;
    for (const w of wallets) {
        text += `• \`${w.nickname}\` — ${w.address.slice(0, 6)}...${w.address.slice(-4)}\n`;
    }

    // Build inline keyboard with one button per wallet + add button
    const keyboard: TelegramBot.InlineKeyboardButton[][] = wallets.map(w => ([
        { text: `🏦 ${w.nickname}`, callback_data: `wallet_menu:${w.id}` }
    ]));
    keyboard.push([{ text: '➕ Add Wallet', callback_data: 'wallet_add' }]);

    const replyMarkup = { inline_keyboard: keyboard };

    if (editMsgId) {
        await bot.editMessageText(text, {
            chat_id: chatId, message_id: editMsgId,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup,
        } as TelegramBot.EditMessageTextOptions);
    } else {
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: replyMarkup,
        });
    }
}

async function sendWalletMenu(chatId: number, walletId: number, editMsgId?: number) {
    const w = await getWallet(walletId);
    if (!w) return;

    const text = `🏦 *Wallet: ${w.nickname}*\n\n` +
        `📍 Address: \`${w.address.slice(0, 6)}...${w.address.slice(-4)}\`\n` +
        `🔑 API Key: \`${w.api_key.slice(0, 8)}...\``;

    const keyboard: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: '✏️ Rename', callback_data: `wallet_edit_nickname:${walletId}` }],
        [{ text: '📍 Change Address', callback_data: `wallet_edit_address:${walletId}` }],
        [{ text: '🔑 Change API Keys', callback_data: `wallet_edit_keys:${walletId}` }],
        [{ text: '🗑️ Delete Wallet', callback_data: `wallet_delete_confirm:${walletId}` }],
        [{ text: '⬅️ Back to Settings', callback_data: 'settings_back' }],
    ];

    const opts: any = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    if (editMsgId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts });
    } else {
        await bot.sendMessage(chatId, text, opts);
    }
}

// ─── /sleep ───────────────────────────────────────────────────────────────────
bot.onText(/\/sleep/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId || !(await getUser(telegramId))) {
        return bot.sendMessage(chatId, '⚠️ Not registered. Use /start.');
    }
    if (await isUserSleeping(telegramId)) {
        return bot.sendMessage(chatId, '😴 Already in sleep mode. Use /wakeup to unmute.');
    }
    bot.sendMessage(chatId, '😴 *Sleep Mode* — For how long?', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '30 мин', callback_data: 'sleep_30' }, { text: '1 час', callback_data: 'sleep_60' }],
                [{ text: '4 часа', callback_data: 'sleep_240' }, { text: '8 часов', callback_data: 'sleep_480' }],
                [{ text: '❌ Отмена', callback_data: 'sleep_cancel' }],
            ],
        },
    });
});

// ─── /wakeup ──────────────────────────────────────────────────────────────────
bot.onText(/\/wakeup/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;
    if (!(await getUser(telegramId))) return bot.sendMessage(chatId, '⚠️ Not registered.');
    await setSleepUntil(telegramId, null);
    bot.sendMessage(chatId, '☀️ *Awake!* Notifications resumed.', { parse_mode: 'Markdown' });
});

// ─── /logout ──────────────────────────────────────────────────────────────────
bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId || !(await getUser(telegramId))) return;
    bot.sendMessage(chatId, '⚠️ *Delete your account?* All wallets and data will be removed.', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Yes, delete', callback_data: 'logout_confirm' },
                { text: '❌ Cancel', callback_data: 'logout_cancel' },
            ]],
        },
    });
});

// ─── Callback Query Handler ────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const msgId = query.message?.message_id;
    const telegramId = query.from.id.toString();
    const data = query.data || '';
    if (!chatId) return;

    await bot.answerCallbackQuery(query.id);

    // ── Sleep ──
    if (data.startsWith('sleep_')) {
        if (data === 'sleep_cancel') {
            return bot.editMessageText('👌 Cancelled.', { chat_id: chatId, message_id: msgId });
        }
        const minutes = parseInt(data.replace('sleep_', ''), 10);
        const until = Math.floor(Date.now() / 1000) + minutes * 60;
        await setSleepUntil(telegramId, until);
        const timeStr = new Date(until * 1000).toLocaleTimeString('ru-RU', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
        });
        return bot.editMessageText(
            `😴 *Muted until ${timeStr} MSK*\nUse /wakeup to unmute early.`,
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
    }

    // ── Logout ──
    if (data === 'logout_confirm') {
        userManager.stopUser(telegramId);
        await deleteUser(telegramId);
        return bot.editMessageText('✅ Account deleted. Use /start to re-register.', {
            chat_id: chatId, message_id: msgId,
        });
    }
    if (data === 'logout_cancel') {
        return bot.editMessageText('👌 Cancelled.', { chat_id: chatId, message_id: msgId });
    }

    // ── Settings back ──
    if (data === 'settings_back') {
        return sendSettingsMenu(chatId, telegramId, msgId);
    }

    // ── Wallet menu ──
    if (data.startsWith('wallet_menu:')) {
        const walletId = parseInt(data.split(':')[1], 10);
        return sendWalletMenu(chatId, walletId, msgId);
    }

    // ── Add wallet ──
    if (data === 'wallet_add') {
        regStates.set(chatId, { step: 'nickname', editing: true });
        return bot.editMessageText(
            '➕ *Add Wallet*\n\n🏷️ Enter a nickname (e.g. "Secondary", "Degen"):',
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
    }

    // ── Edit nickname ──
    if (data.startsWith('wallet_edit_nickname:')) {
        const walletId = parseInt(data.split(':')[1], 10);
        regStates.set(chatId, { step: 'nickname', editing: true, walletId, editField: 'nickname' });
        return bot.sendMessage(chatId, '✏️ Enter a new nickname for this wallet:');
    }

    // ── Edit address ──
    if (data.startsWith('wallet_edit_address:')) {
        const walletId = parseInt(data.split(':')[1], 10);
        regStates.set(chatId, { step: 'address', editing: true, walletId, editField: 'address' });
        return bot.sendMessage(chatId, '📍 Enter the new wallet address (0x...):');
    }

    // ── Edit API keys ──
    if (data.startsWith('wallet_edit_keys:')) {
        const walletId = parseInt(data.split(':')[1], 10);
        regStates.set(chatId, { step: 'api_key', editing: true, walletId, editField: 'keys' });
        return bot.sendMessage(chatId, '🔑 Enter the new API Key:');
    }

    // ── Delete wallet confirm ──
    if (data.startsWith('wallet_delete_confirm:')) {
        const walletId = parseInt(data.split(':')[1], 10);
        const w = await getWallet(walletId);
        if (!w) return;
        return bot.editMessageText(
            `🗑️ *Delete "${w.nickname}"?* This cannot be undone.`,
            {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Delete', callback_data: `wallet_delete:${walletId}` },
                        { text: '❌ Cancel', callback_data: `wallet_menu:${walletId}` },
                    ]],
                },
            }
        );
    }

    // ── Delete wallet ──
    if (data.startsWith('wallet_delete:')) {
        const walletId = parseInt(data.split(':')[1], 10);
        userManager.stopWallet(walletId);
        await deleteWallet(walletId);
        await bot.editMessageText('✅ Wallet deleted.', { chat_id: chatId, message_id: msgId });
        return sendSettingsMenu(chatId, telegramId);
    }
});

// ─── Message Handler (Registration / Edit flows) ──────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith('/')) return;

    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const state = regStates.get(chatId);
    if (!state) return;

    // Delete message containing sensitive data (api keys)
    const isSensitive = ['api_key', 'api_secret', 'api_passphrase'].includes(state.step);
    if (isSensitive) {
        try { await bot.deleteMessage(chatId, msg.message_id); } catch { }
    }

    // ── Nickname step ──
    if (state.step === 'nickname') {
        state.nickname = text.slice(0, 20);
        // If editing a single field
        if (state.editField === 'nickname' && state.walletId) {
            await updateWallet(state.walletId, { nickname: state.nickname });
            regStates.delete(chatId);
            await bot.sendMessage(chatId, `✅ Renamed to "${state.nickname}".`);
            return sendWalletMenu(chatId, state.walletId);
        }
        state.step = 'address';
        return bot.sendMessage(chatId, `📍 *Step 2/5:* Enter the wallet address (0x...):`, { parse_mode: 'Markdown' });
    }

    // ── Address step ──
    if (state.step === 'address') {
        if (!text.startsWith('0x') || text.length < 20) {
            return bot.sendMessage(chatId, '❌ Invalid address. Must start with 0x. Try again:');
        }
        state.address = text;
        // If editing single field
        if (state.editField === 'address' && state.walletId) {
            await updateWallet(state.walletId, { address: text });
            regStates.delete(chatId);
            userManager.stopWallet(state.walletId);
            const w = await getWallet(state.walletId);
            if (w) userManager.startWallet(w);
            await bot.sendMessage(chatId, '✅ Address updated.');
            return sendWalletMenu(chatId, state.walletId);
        }
        state.step = 'api_key';
        return bot.sendMessage(chatId, `🔑 *Step 3/5:* Enter your API Key:`, { parse_mode: 'Markdown' });
    }

    // ── API Key step ──
    if (state.step === 'api_key') {
        state.api_key = text;
        state.step = 'api_secret';
        return bot.sendMessage(chatId, `🔐 *Step 4/5:* Enter your API Secret:`, { parse_mode: 'Markdown' });
    }

    // ── API Secret step ──
    if (state.step === 'api_secret') {
        state.api_secret = text;
        state.step = 'api_passphrase';
        return bot.sendMessage(chatId, `🛡️ *Step 5/5:* Enter your API Passphrase:`, { parse_mode: 'Markdown' });
    }

    // ── Passphrase step ──
    if (state.step === 'api_passphrase') {
        const passphrase = text;
        regStates.delete(chatId);

        try {
            // If editing all keys for an existing wallet
            if (state.editField === 'keys' && state.walletId) {
                await updateWallet(state.walletId, {
                    api_key: state.api_key,
                    api_secret: state.api_secret,
                    api_passphrase: passphrase,
                });
                userManager.stopWallet(state.walletId);
                const w = await getWallet(state.walletId);
                if (w) userManager.startWallet(w);
                await bot.sendMessage(chatId, '✅ API Keys updated.');
                return sendWalletMenu(chatId, state.walletId);
            }

            // Add new wallet
            const wallet = await addWallet(
                telegramId,
                state.nickname || 'Wallet',
                state.address!,
                state.api_key!,
                state.api_secret!,
                passphrase
            );
            userManager.startWallet(wallet);

            bot.sendMessage(chatId,
                `✅ *Wallet "${wallet.nickname}" added!*\n\n` +
                `📡 Monitoring started.\n\n` +
                `Use /settings to manage wallets or /portfolio to view positions.`,
                { parse_mode: 'Markdown' }
            );
        } catch (err: any) {
            console.error('Add wallet error:', err);
            bot.sendMessage(chatId, '❌ Failed to save wallet. Use /settings to try again.');
        }
    }
});

console.log('Telegram Bot handlers initialized.');
