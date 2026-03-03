# Polymarket Monitor Telegram Bot

A self-hosted Telegram bot that monitors your [Polymarket](https://polymarket.com) account and sends real-time notifications about your positions and trades.

## Features

- 🔔 **Real-time trade alerts** — via Polymarket WebSocket (authenticated user channel)
- 📥📤 **Share change notifications** — notified when shares are added or reduced in a position
- 🆕 **New position detection** — instant alert when you open a new position
- ✅ **Position closed alerts** — notified when a position is resolved or fully sold
- � **Portfolio overview** — `/portfolio` command shows all open positions with current price & P/L
- 😴 **Sleep mode** — mute notifications for 30min / 1h / 4h / 8h without stopping the bot
- 👥 **Multi-user support** — each user registers independently with their own API keys
- 🔐 **Encrypted storage** — API keys encrypted with AES-256-GCM before saving to PostgreSQL

## Tech Stack

- **Node.js** + **TypeScript**
- **PostgreSQL** — user & credentials storage
- **node-telegram-bot-api** — Telegram Bot interaction
- **axios** — Polymarket REST API calls
- **ws** — WebSocket for real-time trade events

## Getting Started

### 1. Prerequisites

- Node.js 18+
- PostgreSQL database
- A [Telegram Bot](https://t.me/botfather) token
- Polymarket CLOB API keys (from your Polymarket account settings)

### 2. Installation

```bash
git clone https://github.com/YOUR_USERNAME/polymarket-telegram-bot.git
cd polymarket-telegram-bot
npm install
```

### 3. Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
DATABASE_URL=postgresql://user:password@localhost:5432/polymarket_bot
ENCRYPTION_KEY=your_random_secret_string
```

> ⚠️ **Never commit `.env` to your repository.** It is listed in `.gitignore`.

### 4. Set up the database

Create the database (PostgreSQL must be running):

```bash
createdb polymarket_bot
```

The table schema is created automatically on first run.

### 5. Run

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Register your Polymarket account (guided 4-step flow) |
| `/portfolio` | View all open positions with current price & P/L |
| `/sleep` | Mute notifications (30m / 1h / 4h / 8h) |
| `/wakeup` | Unmute notifications early |
| `/settings` | View your account info & notification status |
| `/logout` | Delete your account from the bot |
| `/help` | Show all commands |

## Registration Flow

When you send `/start`, the bot will guide you through entering:
1. Your Polymarket wallet address (`0x...`)
2. Your CLOB API Key
3. Your CLOB API Secret
4. Your CLOB API Passphrase

Your API credentials are encrypted with AES-256-GCM before being stored.

## Getting Polymarket API Keys

1. Go to [polymarket.com](https://polymarket.com) → Profile → Settings
2. Navigate to the **API** section
3. Generate your API Key, Secret, and Passphrase
4. Copy your wallet **address** from your profile page

> **Note:** Only read-only API access is required. No private key is needed.

## Auto-Notifications

The bot monitors your account in two ways:

- **WebSocket** — Listens for trade fill events in real-time
- **Polling (every 5s)** — Detects share count changes, new positions, and closed positions

Notifications are **only sent when shares change** — no spam from normal price movements.

## License

MIT
