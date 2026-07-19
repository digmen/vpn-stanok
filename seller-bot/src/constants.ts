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
