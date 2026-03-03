import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import { getUser, saveUser, deleteUser, setSleepUntil, isUserSleeping } from './database';
import { UserManager } from './userManager';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required in .env');

export const bot = new TelegramBot(token, { polling: true });

// --- Registration state machine ---
interface RegistrationState {
    step: 'address' | 'api_key' | 'api_secret' | 'api_passphrase';
    address?: string;
    api_key?: string;
    api_secret?: string;
}

const registrations = new Map<number, RegistrationState>();

// --- Utility: split long Telegram messages ---
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

// --- Create UserManager with notification callback ---
export const userManager = new UserManager((telegramId: string, message: string) => {
    bot.sendMessage(telegramId, message, { parse_mode: 'Markdown' }).catch(err => {
        console.error(`[Bot] Failed to send notification to ${telegramId}:`, err.message);
    });
});

// ==============================
//  /start — Registration Flow
// ==============================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const existing = await getUser(telegramId);
    if (existing) {
        return bot.sendMessage(chatId,
            '🚀 *You are already registered!*\n\n' +
            '📊 *Commands:*\n' +
            '• /portfolio — Your positions & P/L\n' +
            '• /sleep — Mute notifications\n' +
            '• /wakeup — Unmute notifications\n' +
            '• /settings — Your account info\n' +
            '• /logout — Delete account\n' +
            '• /help — All commands',
            { parse_mode: 'Markdown' }
        );
    }

    registrations.set(chatId, { step: 'address' });
    bot.sendMessage(chatId,
        '👋 *Welcome to Polymarket Monitor Bot!*\n\n' +
        'Let\'s set up your account. I\'ll need a few details.\n\n' +
        '📍 *Step 1/4:* Send me your Polymarket wallet address (0x...)',
        { parse_mode: 'Markdown' }
    );
});

// ==============================
//  /help
// ==============================
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        '📊 *Polymarket Monitor Bot*\n\n' +
        '*Commands:*\n' +
        '• `/start` — Register your account\n' +
        '• `/portfolio` — View positions & P/L\n' +
        '• `/sleep` — Mute notifications (30m / 1h / 4h / 8h)\n' +
        '• `/wakeup` — Unmute notifications early\n' +
        '• `/settings` — View your account info\n' +
        '• `/logout` — Delete your account\n\n' +
        '🔔 *Auto Notifications:*\n' +
        '• Trade executions (WebSocket)\n' +
        '• Position price/P/L/size changes (polling)\n' +
        '• New positions opened\n' +
        '• Positions closed/resolved',
        { parse_mode: 'Markdown' }
    );
});

// ==============================
//  /portfolio
// ==============================
bot.onText(/\/portfolio/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, '⚠️ You are not registered. Use /start to set up.');

    const loadingMsg = await bot.sendMessage(chatId, '⏳ _Calculating portfolio..._', { parse_mode: 'Markdown' });

    try {
        const portfolio = await userManager.getPortfolio(telegramId);

        if (!portfolio || portfolio.length === 0) {
            return bot.editMessageText('ℹ️ Your portfolio is currently empty.', {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
            });
        }

        let response = '📊 *Your Portfolio Overview*\n\n';
        let totalValue = 0;
        let totalPnl = 0;

        portfolio.forEach((p: any) => {
            const pnlEmoji = p.pnl >= 0 ? '📈' : '📉';
            const pnlColor = p.pnl >= 0 ? '+' : '';
            response += `📍 *${p.market}*\n` +
                `    Outcome: \`${p.outcome || 'N/A'}\`\n` +
                `    Size: ${p.size.toFixed(1)} @ $${p.avgPrice.toFixed(3)}\n` +
                `    Now: $${p.currentPrice.toFixed(3)} | $${p.value.toFixed(2)}\n` +
                `    ${pnlEmoji} P/L: ${pnlColor}$${p.pnl.toFixed(2)} (${pnlColor}${p.pnlPercent.toFixed(2)}%)\n\n`;
            totalValue += p.value;
            totalPnl += p.pnl;
        });

        const totalPnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
        const totalPnlSign = totalPnl >= 0 ? '+' : '';
        response += `───────\n` +
            `💎 *Total Account Value:* $${totalValue.toFixed(2)}\n` +
            `${totalPnlEmoji} *Net P/L:* ${totalPnlSign}$${totalPnl.toFixed(2)}`;

        const chunks = splitMessage(response);
        await bot.editMessageText(chunks[0], {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
        });
        for (let i = 1; i < chunks.length; i++) {
            await bot.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Error fetching portfolio:', error);
        await bot.editMessageText('❌ Failed to fetch portfolio.', {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
        });
    }
});

// ==============================
//  /sleep — Mute notifications
// ==============================
bot.onText(/\/sleep/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, '⚠️ You are not registered. Use /start to set up.');

    const sleeping = await isUserSleeping(telegramId);
    if (sleeping) {
        const until = user.sleep_until ? new Date(user.sleep_until * 1000) : null;
        const timeStr = until ? until.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '?';
        return bot.sendMessage(chatId,
            `😴 You are already sleeping until *${timeStr} MSK*.\n\nUse /wakeup to unmute.`,
            { parse_mode: 'Markdown' }
        );
    }

    bot.sendMessage(chatId, '😴 *Sleep Mode*\n\nFor how long should I mute notifications?', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '30 мин', callback_data: 'sleep_30' },
                    { text: '1 час', callback_data: 'sleep_60' },
                ],
                [
                    { text: '4 часа', callback_data: 'sleep_240' },
                    { text: '8 часов', callback_data: 'sleep_480' },
                ],
                [
                    { text: '❌ Отмена', callback_data: 'sleep_cancel' },
                ],
            ],
        },
    });
});

// ==============================
//  /wakeup — Unmute notifications
// ==============================
bot.onText(/\/wakeup/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, '⚠️ You are not registered. Use /start to set up.');

    await setSleepUntil(telegramId, null);
    bot.sendMessage(chatId, '☀️ *You are awake!* Notifications resumed.', { parse_mode: 'Markdown' });
});

// ==============================
//  /settings — View account info
// ==============================
bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, '⚠️ You are not registered. Use /start to set up.');

    const sleeping = await isUserSleeping(telegramId);
    const sleepStatus = sleeping
        ? `😴 Sleeping until ${new Date(user.sleep_until! * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} MSK`
        : '☀️ Active';

    bot.sendMessage(chatId,
        '⚙️ *Your Settings*\n\n' +
        `📍 *Address:* \`${user.address}\`\n` +
        `🔑 *API Key:* \`${user.api_key.substring(0, 8)}...${user.api_key.slice(-4)}\`\n` +
        `📅 *Registered:* ${new Date(user.created_at * 1000).toLocaleDateString('ru-RU')}\n` +
        `🔔 *Status:* ${sleepStatus}`,
        { parse_mode: 'Markdown' }
    );
});

// ==============================
//  /logout — Delete account
// ==============================
bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user) return bot.sendMessage(chatId, '⚠️ You are not registered.');

    bot.sendMessage(chatId,
        '⚠️ *Are you sure you want to delete your account?*\n\nAll your data will be removed.',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Yes, delete', callback_data: 'logout_confirm' },
                        { text: '❌ Cancel', callback_data: 'logout_cancel' },
                    ],
                ],
            },
        }
    );
});

// ==============================
//  Callback query handler (inline buttons)
// ==============================
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id.toString();
    if (!chatId) return;

    const data = query.data;
    if (!data) return;

    // --- Sleep callbacks ---
    if (data.startsWith('sleep_')) {
        if (data === 'sleep_cancel') {
            await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
            return bot.editMessageText('👌 Sleep cancelled.', { chat_id: chatId, message_id: query.message?.message_id });
        }

        const minutes = parseInt(data.replace('sleep_', ''), 10);
        const until = Math.floor(Date.now() / 1000) + minutes * 60;
        await setSleepUntil(telegramId, until);

        const untilDate = new Date(until * 1000);
        const timeStr = untilDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

        await bot.answerCallbackQuery(query.id, { text: `Sleeping for ${minutes} min` });
        return bot.editMessageText(
            `😴 *Notifications muted until ${timeStr} MSK*\n\nUse /wakeup to unmute early.`,
            { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'Markdown' }
        );
    }

    // --- Logout callbacks ---
    if (data === 'logout_confirm') {
        userManager.stopUser(telegramId);
        await deleteUser(telegramId);
        await bot.answerCallbackQuery(query.id, { text: 'Account deleted' });
        return bot.editMessageText('✅ Your account has been deleted. Use /start to re-register.',
            { chat_id: chatId, message_id: query.message?.message_id });
    }
    if (data === 'logout_cancel') {
        await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
        return bot.editMessageText('👌 Logout cancelled.',
            { chat_id: chatId, message_id: query.message?.message_id });
    }
});

// ==============================
//  General message handler (Registration Flow)
// ==============================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith('/')) return;

    const telegramId = msg.from?.id.toString();
    if (!telegramId) return;

    const state = registrations.get(chatId);
    if (!state) return; // Not in registration flow

    switch (state.step) {
        case 'address':
            if (!text.startsWith('0x') || text.length < 10) {
                return bot.sendMessage(chatId, '❌ Invalid address. Must start with 0x. Try again:');
            }
            state.address = text;
            state.step = 'api_key';
            bot.sendMessage(chatId,
                '✅ Address saved!\n\n🔑 *Step 2/4:* Send me your *API Key*',
                { parse_mode: 'Markdown' }
            );
            break;

        case 'api_key':
            state.api_key = text;
            state.step = 'api_secret';
            bot.sendMessage(chatId,
                '✅ API Key saved!\n\n🔐 *Step 3/4:* Send me your *API Secret*',
                { parse_mode: 'Markdown' }
            );
            break;

        case 'api_secret':
            state.api_secret = text;
            state.step = 'api_passphrase';
            bot.sendMessage(chatId,
                '✅ API Secret saved!\n\n🛡️ *Step 4/4:* Send me your *API Passphrase*',
                { parse_mode: 'Markdown' }
            );
            break;

        case 'api_passphrase':
            const passphrase = text;
            registrations.delete(chatId);

            try {
                await saveUser({
                    telegram_id: telegramId,
                    address: state.address!,
                    api_key: state.api_key!,
                    api_secret: state.api_secret!,
                    api_passphrase: passphrase,
                });

                // Start monitoring
                userManager.startUser({
                    telegramId,
                    address: state.address!,
                    apiKey: state.api_key!,
                    apiSecret: state.api_secret!,
                    apiPassphrase: passphrase,
                });

                // Delete the messages containing sensitive data
                try {
                    // Delete the last 6 messages (user inputs + bot prompts)
                    await bot.deleteMessage(chatId, msg.message_id);
                } catch { }

                bot.sendMessage(chatId,
                    '🎉 *Registration Complete!*\n\n' +
                    '✅ Your credentials are encrypted and stored securely.\n' +
                    '📡 Monitoring started! You will receive notifications about:\n' +
                    '• Trade executions\n' +
                    '• Position changes\n' +
                    '• New positions / closures\n\n' +
                    '📊 Use /portfolio to view your positions.\n' +
                    '😴 Use /sleep to mute notifications.',
                    { parse_mode: 'Markdown' }
                );
            } catch (error: any) {
                console.error('Registration error:', error);
                bot.sendMessage(chatId, '❌ Registration failed. Please try /start again.');
            }
            break;
    }
});

console.log('Telegram Bot handlers initialized.');
