import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import type { Api } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { promoEnabled } from './branding.js';
import { getOwnerId } from './owner.js';
import { allSubs } from './subscriptions.js';
import { promoLink } from './promo-nudge.js';

// Реклама франшизы клиентам от имени бота владельца — ТОЛЬКО с согласия владельца.
//
// 23.10: идея писать клиентам «от станка» упёрлась в Telegram (бот пишет лишь тем, кто с ним
// начинал диалог). Рабочий и честный путь — сам бот-продавец, но у него чужие клиенты и чужая
// репутация, поэтому правила жёсткие:
//  - по умолчанию ВЫКЛЮЧЕНО; владелец сам включает в «⚙️ Мой бот → 📣 Реклама франшизы» или
//    отвечает «Включить» на единственный вопрос после обновления (условия, п. 2б);
//  - отправляет бот на сервере владельца: токен не покидает его, список клиентов не уходит на станок;
//  - объявление подписано ключом автора франшизы (ed25519): публичный репозиторий не даёт права
//    рассылать, кто бы ни получил туда доступ;
//  - клиенту — не чаще раза в 14 дней, одно и то же объявление один раз, днём, с пометкой «Реклама»
//    и кнопкой «Больше не показывать»; написавшим «стоп» не пишем вообще;
//  - владелец и оплатившие белую марку (promoEnabled) не получают и не рассылают.

const AD_URL = 'https://raw.githubusercontent.com/digmen/vpn-stanok/main/seller-bot/ads/current.json';
const STATE_FILE = path.join(config.dataDir, 'ads-state.json');

/** Публичный ключ автора франшизы. Приватный — только у него (C:\Users\User\.secrets\ads-signing.key). */
export const ADS_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVUjPeE0IgeDGatAAx3w95AIGRBS1cAqrYHQldMdw3Co=
-----END PUBLIC KEY-----
`;

export const AD_LIMITS = {
  /** Одному клиенту — не чаще. */
  MIN_GAP_MS: 14 * 86_400_000,
  /** Клиент «активный», если подписка кончилась не раньше, чем столько назад. */
  ACTIVE_WINDOW_MS: 30 * 86_400_000,
  /** За один запуск не больше (остальным — в следующие), чтобы не получить лимиты Telegram. */
  BATCH: 150,
  SEND_DELAY_MS: 100,
  /** Окно отправки по UTC: 07–18 = 10–21 по Москве, 13–00 по Бишкеку. */
  HOUR_FROM: 7,
  HOUR_TO: 18,
  MAX_TEXT: 800,
} as const;

export interface Ad {
  id: string;
  text: string;
  /** ISO-даты начала и конца показа. */
  from: string;
  until: string;
  sig: string;
}

/** Что именно подписывается. Любое изменение текста или срока ломает подпись. */
export function adPayload(ad: Pick<Ad, 'id' | 'text' | 'from' | 'until'>): string {
  return [ad.id, ad.from, ad.until, ad.text].join('\n');
}

export function verifyAd(ad: Ad, publicKeyPem: string = ADS_PUBLIC_KEY_PEM): boolean {
  try {
    return verify(
      null,
      Buffer.from(adPayload(ad), 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(ad.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Разбор JSON объявления: неполное или кривое — null. Пустой id = «кампании нет». */
export function parseAd(raw: unknown): Ad | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const { id, text, from, until, sig } = o;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  if (typeof text !== 'string' || text.length === 0 || text.length > AD_LIMITS.MAX_TEXT) return null;
  if (typeof from !== 'string' || typeof until !== 'string' || typeof sig !== 'string') return null;
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(until))) return null;
  return { id, text, from, until, sig };
}

export function isAdActive(ad: Ad, now: number): boolean {
  return now >= Date.parse(ad.from) && now <= Date.parse(ad.until);
}

export function inSendWindow(now: number): boolean {
  const h = new Date(now).getUTCHours();
  return h >= AD_LIMITS.HOUR_FROM && h < AD_LIMITS.HOUR_TO;
}

// ── состояние на узле ──────────────────────────────────────────────────────

export interface AdsState {
  /** Спрашивали ли владельца (один раз после обновления). */
  asked: boolean;
  /** Согласие владельца: null — не решал. */
  consent: { on: boolean; at: number } | null;
  /** Клиенты, написавшие «больше не показывать». */
  optout: number[];
  /** Кому уже ушла эта кампания: id объявления → userId. Хранится несколько последних. */
  sent: Record<string, number[]>;
  /** Когда клиенту писали последний раз. */
  last: Record<string, number>;
}

export function emptyState(): AdsState {
  return { asked: false, consent: null, optout: [], sent: {}, last: {} };
}

export function readAdsState(): AdsState {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<AdsState>) };
  } catch {
    return emptyState();
  }
}

export function writeAdsState(s: AdsState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    /* не критично: худшее — клиент получит объявление повторно позже срока */
  }
}

export function adsEnabled(): boolean {
  return readAdsState().consent?.on === true;
}

// ── кому слать ─────────────────────────────────────────────────────────────

/** Люди, у которых есть или недавно была подписка (ключи пробного — тоже подписки). */
export function activeClientIds(now: number = Date.now()): number[] {
  const ids = new Set<number>();
  for (const s of allSubs()) {
    if (s.userId && s.expiresAt > now - AD_LIMITS.ACTIVE_WINDOW_MS) ids.add(s.userId);
  }
  return [...ids];
}

/** Чистое решение: кому из клиентов слать в этот запуск. */
export function planBatch(input: {
  ad: Ad;
  clients: number[];
  ownerId: number;
  state: AdsState;
  now: number;
}): number[] {
  const { ad, clients, ownerId, state, now } = input;
  const got = new Set(state.sent[ad.id] ?? []);
  const out = new Set(state.optout);
  const picked: number[] = [];
  for (const uid of clients) {
    if (uid === ownerId || out.has(uid) || got.has(uid)) continue;
    const last = state.last[String(uid)];
    if (last !== undefined && now - last < AD_LIMITS.MIN_GAP_MS) continue;
    picked.push(uid);
    if (picked.length >= AD_LIMITS.BATCH) break;
  }
  return picked;
}

export function adMessage(ad: Ad, link: string): string {
  return '📢 Реклама · VPNForge\n\n' + ad.text.replaceAll('{LINK}', link);
}

export const ADS_OPTOUT_CALLBACK = 'ads:off';

// ── запуск ─────────────────────────────────────────────────────────────────

async function fetchAd(): Promise<Ad | null> {
  try {
    const res = await fetch(AD_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return parseAd(await res.json());
  } catch {
    return null;
  }
}

/**
 * Один проход: если владелец согласен, окно подходящее, а объявление подписано и активно —
 * отправить очередной пакет клиентам. Возвращает, сколько отправлено (для лога).
 */
export async function runAds(api: Api, now: number = Date.now()): Promise<number> {
  const state = readAdsState();
  if (state.consent?.on !== true) return 0;
  if (!promoEnabled()) return 0; // белая марка: у оплативших реклама франшизы не идёт
  if (!inSendWindow(now)) return 0;

  const ad = await fetchAd();
  if (!ad || !isAdActive(ad, now) || !verifyAd(ad)) return 0;

  const batch = planBatch({ ad, clients: activeClientIds(now), ownerId: getOwnerId(), state, now });
  if (batch.length === 0) return 0;

  const text = adMessage(ad, promoLink(config.stanokUrl, getOwnerId()));
  const kb = new InlineKeyboard().text('🔕 Больше не показывать', ADS_OPTOUT_CALLBACK);
  let sent = 0;
  const done = state.sent[ad.id] ?? [];
  for (const uid of batch) {
    try {
      await api.sendMessage(uid, text, { reply_markup: kb, link_preview_options: { is_disabled: true } });
      sent++;
    } catch (e) {
      // 429 — Telegram просит притормозить: остальным в следующий запуск. Прочее (бот заблокирован,
      // чат не найден) — человека пропускаем навсегда по этой кампании, не долбим.
      if (/429|Too Many Requests/i.test(String(e))) break;
    }
    done.push(uid);
    state.last[String(uid)] = now;
    await new Promise((r) => setTimeout(r, AD_LIMITS.SEND_DELAY_MS));
  }
  state.sent[ad.id] = done;
  // Помним только несколько последних кампаний — файл не растёт без конца.
  for (const k of Object.keys(state.sent).slice(0, -5)) delete state.sent[k];
  writeAdsState(state);
  return sent;
}

/** Ответ клиента «больше не показывать». */
export function optOut(userId: number): void {
  const s = readAdsState();
  if (!s.optout.includes(userId)) s.optout.push(userId);
  writeAdsState(s);
}

export function setConsent(on: boolean, now: number = Date.now()): void {
  const s = readAdsState();
  s.consent = { on, at: now };
  s.asked = true;
  writeAdsState(s);
}

export function markAsked(): void {
  const s = readAdsState();
  s.asked = true;
  writeAdsState(s);
}

export const ADS_CONSENT_QUESTION =
  '📣 Реклама франшизы в твоём боте — разрешаешь?\n\n' +
  'Франшиза VPNForge может показывать твоим клиентам рекламу: «хочешь такой же бот?». Сообщение уйдёт от имени твоего бота, ' +
  'с пометкой «Реклама · VPNForge» и кнопкой «Больше не показывать».\n\n' +
  'Правила: только по твоему согласию (сейчас выключено); одному клиенту не чаще раза в 14 дней; только днём; только активным клиентам ' +
  '(подписка или пробный за последние 30 дней); тебе реклама не приходит; список клиентов с твоего сервера не уходит, отправляет твой бот. ' +
  'Выключить можно в любой момент: ⚙️ Мой бот → 📣 Реклама франшизы. Условия: п. 2б, команда /terms в @VPNForge_bot.';
