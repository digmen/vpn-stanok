import { config } from './config.js';
import { makeCrypto } from './crypto-core.js';

const c = makeCrypto(config.encryptionKey);

export const encrypt = c.encrypt;
export const decrypt = c.decrypt;
