import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { encrypt, decrypt } from './crypto';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserRecord {
    telegram_id: string;
    sleep_until: number | null;
    created_at: number;
}

export interface WalletRecord {
    id: number;
    telegram_id: string;
    nickname: string;       // e.g. "Main", "Secondary"
    address: string;
    api_key: string;
    api_secret: string;
    api_passphrase: string;
    created_at: number;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id TEXT PRIMARY KEY,
            sleep_until BIGINT,
            created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS wallets (
            id            SERIAL PRIMARY KEY,
            telegram_id   TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
            nickname      TEXT NOT NULL DEFAULT 'Wallet',
            address       TEXT NOT NULL,
            api_key       TEXT NOT NULL,
            api_secret    TEXT NOT NULL,
            api_passphrase TEXT NOT NULL,
            created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
        )
    `);

    // Migrate old schema: if users table has address column, move data to wallets
    const cols = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'address'
    `);
    if (cols.rows.length > 0) {
        console.log('🔄 Migrating old schema to multi-wallet...');
        const oldUsers = await pool.query('SELECT * FROM users WHERE address IS NOT NULL');
        for (const u of oldUsers.rows) {
            // Insert into wallets if not already there
            const exists = await pool.query('SELECT id FROM wallets WHERE telegram_id = $1', [u.telegram_id]);
            if (exists.rows.length === 0) {
                // Keep users row (for sleep), move wallet data to wallets table
                // First add user without wallet fields
                await pool.query(`
                    INSERT INTO wallets (telegram_id, nickname, address, api_key, api_secret, api_passphrase)
                    VALUES ($1, 'Main', $2, $3, $4, $5)
                    ON CONFLICT DO NOTHING
                `, [u.telegram_id, u.address, u.api_key, u.api_secret, u.api_passphrase]);
            }
        }
        // Drop old columns
        await pool.query(`
            ALTER TABLE users
            DROP COLUMN IF EXISTS address,
            DROP COLUMN IF EXISTS api_key,
            DROP COLUMN IF EXISTS api_secret,
            DROP COLUMN IF EXISTS api_passphrase
        `);
        console.log('✅ Migration complete.');
    }

    console.log('✅ PostgreSQL database initialized.');
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function getUser(telegramId: string): Promise<UserRecord | null> {
    const r = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
        telegram_id: row.telegram_id,
        sleep_until: row.sleep_until ? Number(row.sleep_until) : null,
        created_at: Number(row.created_at),
    };
}

export async function ensureUser(telegramId: string): Promise<void> {
    await pool.query(`
        INSERT INTO users (telegram_id) VALUES ($1)
        ON CONFLICT DO NOTHING
    `, [telegramId]);
}

export async function deleteUser(telegramId: string): Promise<void> {
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
    // wallets are cascade-deleted
}

export async function setSleepUntil(telegramId: string, until: number | null): Promise<void> {
    await pool.query('UPDATE users SET sleep_until = $1 WHERE telegram_id = $2', [until, telegramId]);
}

export async function isUserSleeping(telegramId: string): Promise<boolean> {
    const r = await pool.query('SELECT sleep_until FROM users WHERE telegram_id = $1', [telegramId]);
    if (!r.rows.length) return false;
    const su = r.rows[0].sleep_until;
    if (!su) return false;
    if (Number(su) > Math.floor(Date.now() / 1000)) return true;
    await setSleepUntil(telegramId, null);
    return false;
}

export async function getAllUsers(): Promise<UserRecord[]> {
    const r = await pool.query('SELECT * FROM users');
    return r.rows.map(row => ({
        telegram_id: row.telegram_id,
        sleep_until: row.sleep_until ? Number(row.sleep_until) : null,
        created_at: Number(row.created_at),
    }));
}

// ─── Wallets ──────────────────────────────────────────────────────────────────

function decryptWallet(row: any): WalletRecord {
    return {
        id: Number(row.id),
        telegram_id: row.telegram_id,
        nickname: row.nickname,
        address: row.address,
        api_key: decrypt(row.api_key),
        api_secret: decrypt(row.api_secret),
        api_passphrase: decrypt(row.api_passphrase),
        created_at: Number(row.created_at),
    };
}

export async function getWallets(telegramId: string): Promise<WalletRecord[]> {
    const r = await pool.query(
        'SELECT * FROM wallets WHERE telegram_id = $1 ORDER BY created_at',
        [telegramId]
    );
    return r.rows.map(decryptWallet);
}

export async function getWallet(walletId: number): Promise<WalletRecord | null> {
    const r = await pool.query('SELECT * FROM wallets WHERE id = $1', [walletId]);
    if (!r.rows.length) return null;
    return decryptWallet(r.rows[0]);
}

export async function addWallet(
    telegramId: string,
    nickname: string,
    address: string,
    apiKey: string,
    apiSecret: string,
    apiPassphrase: string
): Promise<WalletRecord> {
    const r = await pool.query(`
        INSERT INTO wallets (telegram_id, nickname, address, api_key, api_secret, api_passphrase)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `, [telegramId, nickname, address, encrypt(apiKey), encrypt(apiSecret), encrypt(apiPassphrase)]);
    return decryptWallet(r.rows[0]);
}

export async function updateWallet(
    walletId: number,
    fields: Partial<{ nickname: string; address: string; api_key: string; api_secret: string; api_passphrase: string }>
): Promise<void> {
    if (fields.nickname !== undefined) {
        await pool.query('UPDATE wallets SET nickname = $1 WHERE id = $2', [fields.nickname, walletId]);
    }
    if (fields.address !== undefined) {
        await pool.query('UPDATE wallets SET address = $1 WHERE id = $2', [fields.address, walletId]);
    }
    if (fields.api_key !== undefined) {
        await pool.query('UPDATE wallets SET api_key = $1 WHERE id = $2', [encrypt(fields.api_key), walletId]);
    }
    if (fields.api_secret !== undefined) {
        await pool.query('UPDATE wallets SET api_secret = $1 WHERE id = $2', [encrypt(fields.api_secret), walletId]);
    }
    if (fields.api_passphrase !== undefined) {
        await pool.query('UPDATE wallets SET api_passphrase = $1 WHERE id = $2', [encrypt(fields.api_passphrase), walletId]);
    }
}

export async function deleteWallet(walletId: number): Promise<void> {
    await pool.query('DELETE FROM wallets WHERE id = $1', [walletId]);
}

export { pool };
