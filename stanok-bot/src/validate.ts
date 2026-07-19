// Чистые проверки пользовательского ввода. Без побочек — удобно тестировать.

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isValidIpv4(s: string): boolean {
  return IPV4_RE.test(s.trim());
}

// Токен бота Telegram: <цифры>:<35+ символов [A-Za-z0-9_-]>
const BOT_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function isValidBotToken(s: string): boolean {
  return BOT_TOKEN_RE.test(s.trim());
}

export function isNonEmptySecret(s: string): boolean {
  return s.trim().length >= 3;
}
