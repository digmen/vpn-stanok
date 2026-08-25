// Маркеры, между которыми скрипт add-peer печатает клиентский конфиг.
export const CONFIG_MARKERS = {
  START: '###CLIENT_CONFIG_START###',
  END: '###CLIENT_CONFIG_END###',
} as const;

export const AWG = {
  INTERFACE: 'awg0',
  HANDSHAKE_ONLINE_SEC: 180, // рукопожатие свежее 3 минут = «онлайн»
} as const;

export const PEER_SCRIPT_TIMEOUT_MS = 60_000;

// Установка VPN на новый сервер — долгая операция: свежий VPS первые минуты
// держит dpkg-lock под unattended-upgrades (установщик ждёт его до 10 мин),
// плюс сборка модуля ядра. Даём с запасом, иначе оборвём валидную установку.
export const INSTALL_SCRIPT_TIMEOUT_MS = 15 * 60_000;

// Доступ к дополнительным локациям (см. locations.ts). Те же значения, что
// в станке: он ходит на те же серверы теми же способами.
export const SSH = {
  PORT: 22,
  READY_TIMEOUT_MS: 30_000,
} as const;
