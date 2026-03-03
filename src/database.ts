import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { encrypt, decrypt } from './crypto';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export interface UserRecord {
    telegram_id: string;
    address: string;
    api_key: string;
    api_secret: string;
    api_passphrase: string;
    sleep_until: number | null;
    created_at: number;
}

/** Initialize the database schema */
export async function initDatabase(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id TEXT PRIMARY KEY,
            address TEXT NOT NULL,
            api_key TEXT NOT NULL,
            api_secret TEXT NOT NULL,
            api_passphrase TEXT NOT NULL,
            sleep_until BIGINT,
            created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
        )
    `);
    console.log('✅ PostgreSQL database initialized.');
}

/** Get a user by Telegram ID */
export async function getUser(telegramId: string): Promise<UserRecord | null> {
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        telegram_id: row.telegram_id,
        address: row.address,
        api_key: decrypt(row.api_key),
        api_secret: decrypt(row.api_secret),
        api_passphrase: decrypt(row.api_passphrase),
        sleep_until: row.sleep_until ? Number(row.sleep_until) : null,
        created_at: Number(row.created_at),
    };
}

/** Save or update a user */
export async function saveUser(user: Omit<UserRecord, 'created_at' | 'sleep_until'>): Promise<void> {
    await pool.query(`
        INSERT INTO users (telegram_id, address, api_key, api_secret, api_passphrase, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (telegram_id) DO UPDATE SET
            address = EXCLUDED.address,
            api_key = EXCLUDED.api_key,
            api_secret = EXCLUDED.api_secret,
            api_passphrase = EXCLUDED.api_passphrase
    `, [
        user.telegram_id,
        user.address,
        encrypt(user.api_key),
        encrypt(user.api_secret),
        encrypt(user.api_passphrase),
        Math.floor(Date.now() / 1000),
    ]);
}

/** Delete a user */
export async function deleteUser(telegramId: string): Promise<void> {
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
}

/** Set sleep_until timestamp */
export async function setSleepUntil(telegramId: string, until: number | null): Promise<void> {
    await pool.query('UPDATE users SET sleep_until = $1 WHERE telegram_id = $2', [until, telegramId]);
}

/** Check if user is currently sleeping */
export async function isUserSleeping(telegramId: string): Promise<boolean> {
    const result = await pool.query('SELECT sleep_until FROM users WHERE telegram_id = $1', [telegramId]);
    if (result.rows.length === 0) return false;
    const sleepUntil = result.rows[0].sleep_until;
    if (!sleepUntil) return false;
    if (Number(sleepUntil) > Math.floor(Date.now() / 1000)) return true;
    // Sleep expired — clear it
    await setSleepUntil(telegramId, null);
    return false;
}

/** Get all registered users */
export async function getAllUsers(): Promise<UserRecord[]> {
    const result = await pool.query('SELECT * FROM users');
    return result.rows.map(row => ({
        telegram_id: row.telegram_id,
        address: row.address,
        api_key: decrypt(row.api_key),
        api_secret: decrypt(row.api_secret),
        api_passphrase: decrypt(row.api_passphrase),
        sleep_until: row.sleep_until ? Number(row.sleep_until) : null,
        created_at: Number(row.created_at),
    }));
}

export { pool };
