import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Crypto {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

// Фабрика шифрования на заданном ключе (без зависимости от конфига — тестируемо).
// Формат хранения: base64(iv) : base64(tag) : base64(ciphertext).
export function makeCrypto(keyHex: string): Crypto {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Ключ шифрования должен быть 64 hex-символа (32 байта).');
  }

  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
    },

    decrypt(payload: string): string {
      const [ivB64, tagB64, dataB64] = payload.split(':');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
