// Инфраструктурные константы в одном месте — никаких «магических» значений по коду.

export const SSH = {
  PORT: 22,
  USERNAME: 'root',
  READY_TIMEOUT_MS: 20_000,
} as const;

export const REMOTE = {
  INSTALL_SCRIPT: '/root/install-amneziawg.sh',
  SELLER_DIR: '/root/seller-bot',
  SELLER_DATA_DIR: '/root/seller-bot-data', // изменяемое состояние; НЕ стирается при обновлении кода
  NODE_SETUP_URL: 'https://deb.nodesource.com/setup_22.x',
} as const;

// Маркеры, между которыми install-скрипт печатает клиентский конфиг.
export const CONFIG_MARKERS = {
  START: '###CLIENT_CONFIG_START###',
  END: '###CLIENT_CONFIG_END###',
} as const;
