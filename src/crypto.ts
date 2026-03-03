import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey(): Buffer {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY is required in .env for encrypting user credentials');
    // Derive a 32-byte key from whatever the user provides
    return crypto.createHash('sha256').update(key).digest();
}

export function encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv:tag:ciphertext (all hex)
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(data: string): string {
    const parts = data.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted data format');
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
}
