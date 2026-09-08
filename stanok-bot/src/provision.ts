import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InlineKeyboard, type Api } from 'grammy';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { getNodeById, getPrimaryReadyNode, setNodeProtocol, setNodeRelay, setNodeStatus, setNodeSupportKey, type NodeProtocol } from './db.js';
import { runRemoteInstall } from './ssh.js';
import { testHandshake, testVlessRealityHandshake, testVlessWsTlsHandshake } from './handshake-test.js';
import { deploySeller, getBotUsername } from './deploy-seller.js';
import { attachLocationToPrimary } from './attach-location.js';
import { nodeDomain, registerNodeDns } from './dns.js';
import { restoreBackup } from './backup.js';
import { TOKEN_INVALID_HELP, verifyBotToken } from './bot-token.js';
import { testFromRussia } from './ru-probe.js';
import { enableRelay } from './relay.js';
import { notifyAdmins } from './admin.js';
import { checkSshPort, preflightMessage } from './preflight.js';
import { logEvent } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Один скрипт установки и одна проверка "реально работает" на протокол — какую пару
// взять решает node.protocol (заведено 05.09 вместе с VLESS+Reality, до этого
// протокол был только один и путь был захардкожен прямо тут).
const INSTALL: Record<NodeProtocol, { script: string; label: string }> = {
  amneziawg: { script: path.resolve(__dirname, '../scripts/install-amneziawg.sh'), label: 'AmneziaWG' },
  vless_reality: { script: path.resolve(__dirname, '../scripts/install-vless-reality.sh'), label: 'VLESS+Reality' },
  // 🔴 08.09: протокол по умолчанию для новых узлов. В отличие от двух других, требует
  // домен — на него выписывается сертификат, поэтому A-запись заводится ДО установки.
  vless_ws_tls: { script: path.resolve(__dirname, '../scripts/install-vless-ws-tls.sh'), label: 'VLESS+WS+TLS' },
};

async function runHandshakeTest(protocol: NodeProtocol, clientConfig: string) {
  if (protocol === 'vless_reality') return testVlessRealityHandshake(clientConfig);
  if (protocol === 'vless_ws_tls') return testVlessWsTlsHandshake(clientConfig);
  return testHandshake(clientConfig);
}

// Провижининг узла: ставим VPN (AmneziaWG или VLESS+Reality — см. node.protocol)
// и разворачиваем бота-продавца.
// Всё показываем в ОДНОМ сообщении (редактируем его), чтобы чат не засорялся.
// Свой VPN владелец берёт уже в СВОЁМ боте («Мой VPN»), не тут.
export async function provisionNode(
  api: Api,
  chatId: number,
  nodeId: number,
  statusMsgId?: number,
): Promise<void> {
  const node = getNodeById(nodeId);
  if (!node) {
    await api.sendMessage(chatId, 'Заявка не найдена.');
    return;
  }

  const password = decrypt(node.root_password_enc);
  const sellerToken = decrypt(node.seller_token_enc);

  // Один статус-месседж: либо редактируем существующий, либо шлём новый
  let msgId = statusMsgId;
  const show = async (text: string, kb?: InlineKeyboard): Promise<void> => {
    const markup = kb ?? new InlineKeyboard(); // пустой = убирает старые кнопки
    if (msgId !== undefined) {
      await api.editMessageText(chatId, msgId, text, { reply_markup: markup }).catch(() => {});
    } else {
      const m = await api.sendMessage(chatId, text, { reply_markup: markup });
      msgId = m.message_id;
    }
  };

  const retryKb = new InlineKeyboard().text('🔄 Попробовать снова', `provision:${nodeId}`);

  // Сервер мог отвалиться между онбордингом и нажатием кнопки — проверяем связь заранее,
  // чтобы не ждать таймаута SSH и сразу назвать причину.
  const who = { id: node.tg_user_id, username: node.tg_username ?? undefined };

  const pf = await checkSshPort(node.server_ip);
  if (!pf.ok) {
    setNodeStatus(nodeId, 'error');
    logEvent(who, 'preflight_fail', `${node.server_ip} · ${pf.reason} · перед провижинингом`);
    await show(preflightMessage(node.server_ip, pf.reason), retryKb);
    return;
  }

  // 🔴 08.09: VLESS+WS+TLS требует домен (на него выписывается сертификат Let's Encrypt),
  // поэтому A-запись заводится ЗАРАНЕЕ — certbot проверяет владение доменом прямо во время
  // установки, и запись «после успеха», как было раньше, для этого бесполезна.
  // Если зона не настроена или PowerDNS не ответил — не падаем, а честно откатываемся на
  // Reality: домен ему не нужен, узел всё равно поднимется, просто менее стойким способом.
  let protocol = node.protocol;
  let domain: string | null = null;
  if (protocol === 'vless_ws_tls') {
    domain = nodeDomain(nodeId);
    const dnsOk = domain ? await registerNodeDns(nodeId, node.server_ip) : false;
    if (!dnsOk) {
      protocol = 'vless_reality';
      domain = null;
      setNodeProtocol(nodeId, protocol);
      logEvent(who, 'provision_fail', `${node.server_ip} · нет DNS для сертификата, откат на Reality`);
      await notifyAdmins(
        api,
        `⚠️ Узел #${nodeId}: не удалось завести DNS-запись для сертификата — ставлю Reality вместо WS+TLS.`,
      );
    }
  }

  const install = INSTALL[protocol];

  setNodeStatus(nodeId, 'provisioning');
  await show(`🔌 Ставлю ${install.label} на ${node.server_ip}… (пара минут)`);

  try {
    const firstClientConfig = await runRemoteInstall({
      host: node.server_ip,
      password,
      scriptLocalPath: install.script,
      // WS+TLS вторым аргументом принимает домен — под него и выпускается сертификат.
      args: domain ? [node.server_ip, domain] : [node.server_ip],
    });

    // 🔴 25.08: раньше отсюда сразу шли к setNodeStatus(nodeId, 'ready') на одном
    // только "install-скрипт вышел с кодом 0" — а сервер мог не принимать VPN
    // реально (порт UDP заблокирован у хостера и т.п.), и об этом узнавали
    // только когда клиент жаловался. Теперь — настоящий handshake со станка
    // ДО того, как сказать владельцу "готово". См. handshake-test.ts.
    await show(`✅ VPN установлен на ${node.server_ip}. 🤝 Проверяю, что он реально принимает подключения…`);
    const hs = await runHandshakeTest(protocol, firstClientConfig);
    if (!hs.ok) {
      setNodeStatus(nodeId, 'error');
      logEvent(who, 'provision_fail', `${node.server_ip} · handshake-test: ${hs.detail}`.slice(0, 200));
      const commonCause =
        protocol !== 'amneziawg'
          ? 'Частая причина — хостер блокирует исходящий/входящий TCP:443 снаружи (отдельно от ' +
            'файрвола на самом сервере) — стоит проверить в панели хостинга.'
          : 'Частая причина — хостер по умолчанию блокирует нестандартные UDP-порты снаружи ' +
            '(отдельно от файрвола на самом сервере) — стоит проверить в панели хостинга.';
      await show(
        `⚠️ Сервер установился, но VPN на нём не отвечает реальным подключениям:\n${hs.detail}\n\n` +
          `${commonCause} Можно нажать «Попробовать снова» после проверки.`,
        retryKb,
      );
      await notifyAdmins(
        api,
        `⚠️ Узел #${nodeId} (${node.server_ip}) поставился, но не прошёл проверку handshake: ${hs.detail}`,
      );
      return;
    }

    // 🔴 07.09: одного handshake со станка недостаточно — станок сам в Праге, а
    // целевая аудитория продукта в РФ. Найдено живьём: узел проходит проверку
    // отсюда и при этом недостижим для настоящего клиента внутри РФ (белый список
    // на некоторых маршрутах — не про протокол, про хостинг/страну). Проверяем
    // честно, вторым независимым клиентом из РФ. Best-effort — не блокирует
    // готовность узла (для не-РФ клиентов он всё равно рабочий), только предупреждает.
    // 🔴 07.09: если RU-проба провалилась — не только предупреждаем, но и сами
    // включаем мультихоп-релей через Прагу (см. relay.ts), подтверждённый вживую
    // способ обхода (Москва→Прага→узел проходит там, где Москва→узел — нет).
    // Только для is_primary (у relay.ts::pushRelayToNode локация всегда 'local') —
    // доп. локации владельца пока не покрыты, это отдельный заход.
    let ruWarning = '';
    let ruFailed: Awaited<ReturnType<typeof testFromRussia>> = null;
    if (protocol !== 'amneziawg') {
      ruFailed = await testFromRussia(firstClientConfig);
      if (ruFailed && !ruFailed.ok) {
        await notifyAdmins(
          api,
          `⚠️ Узел #${nodeId} (${node.server_ip}) прошёл проверку со станка, но НЕ отвечает ` +
            `российскому тестовому клиенту: ${ruFailed.detail}`,
        );
      }
    }

    if (node.is_primary) {
      // 🔴 07.09: разворачивать бота на мёртвый токен нельзя — он не сможет залогиниться в
      // Telegram, упадёт на старте, и pm2 будет поднимать его бесконечно (у Ramazan_LS так
      // набежало 2333 перезапуска и 100% CPU на его же сервере, при этом молча). Проверяем
      // ДО установки. Сеть моргнула ('network') — не блокируем, это не приговор токену.
      const tokenCheck = await verifyBotToken(sellerToken);
      if (!tokenCheck.ok && tokenCheck.reason === 'invalid') {
        setNodeStatus(nodeId, 'error');
        logEvent(who, 'token_invalid', `${node.server_ip} · перед установкой бота`);
        await show(
          `✅ VPN на ${node.server_ip} установлен и работает.\n\n` +
            TOKEN_INVALID_HELP +
            '\n\nКак получишь новый токен — нажми /start → «Я купил сервер» → «Настроить», ' +
            'я спрошу только его, остальное уже настроено.',
        );
        await notifyAdmins(
          api,
          `🔑 Узел #${nodeId} (@${node.tg_username ?? '—'}): VPN поставлен, но токен бота отозван — ` +
            'бота не разворачивал, жду новый токен от владельца.',
        );
        return;
      }

      await show('✅ VPN установлен. ⚙️ Запускаю твоего бота-продавца… ещё пара минут.');

      await deploySeller({
        host: node.server_ip,
        password,
        sellerToken,
        ownerId: node.tg_user_id,
        stanokUrl: config.stanokUrl,
        priceStars: config.sellerPriceStars,
        protocol,
        // Домен есть только у узлов на WS+TLS — им и будет доступна оплата картой.
        domain,
      });

      setNodeStatus(nodeId, 'ready');
      void registerNodeDns(nodeId, node.server_ip);

      // 🔴 07.09: если этот сервер встал НА ЗАМЕНУ мёртвому primary (см. onboarding.ts —
      // node.replaced_node_id ставится там), deploySeller выше только что создал бота
      // с ЧИСТЫМИ настройками по умолчанию — цены, скрытые локации, доп. сервера и
      // ключи к ним, кэш «Мой VPN» были только на старом (мёртвом) сервере и без этого
      // восстановления терялись бы навсегда. Кладём последний суточный бэкап владельца
      // поверх — best-effort, если бэкапа ещё не было (первые сутки нового владельца),
      // просто продолжаем с чистыми настройками, как раньше.
      let restoreWarning = '';
      if (node.replaced_node_id) {
        const restore = await restoreBackup(node.tg_user_id, node.server_ip, password);
        if (restore.restored) {
          restoreWarning = '\n\n♻️ Прошлый сервер был недоступен — поднял бота на новом и подтянул старые настройки (цены, локации) из вчерашнего бэкапа.';
        } else if (!restore.ok) {
          restoreWarning =
            `\n\n⚠️ Прошлый сервер был недоступен, поставил бота на новом заново, но восстановить старые ` +
            `настройки не получилось (${restore.detail.slice(0, 150)}) — цены и доп. локации придётся настроить заново.`;
          await notifyAdmins(api, `⚠️ Узел #${nodeId}: восстановление бэкапа после замены primary упало: ${restore.detail.slice(0, 300)}`);
        } else {
          restoreWarning = '\n\n♻️ Прошлый сервер был недоступен — поднял бота на новом. Бэкапа настроек ещё не было (снимается раз в сутки), начинаем с чистых.';
        }
      }

      // 🔴 07.09: RU-проба провалилась — сами включаем релей, не только предупреждаем.
      // Seller-bot уже задеплоен строкой выше — cli-set-relay.ts там точно есть.
      if (ruFailed && !ruFailed.ok) {
        try {
          const relay = await enableRelay(node, password);
          setNodeRelay(nodeId, relay.host, relay.port);
          ruWarning =
            '\n\n✅ Заметил, что из России сервер напрямую недоступен, и уже включил обход — ' +
            'клиенты подключаются автоматически через запасной маршрут, ничего делать не нужно.';
          await notifyAdmins(api, `🔀 Узел #${nodeId}: включён релей через Прагу (${relay.host}:${relay.port}).`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ruWarning =
            `\n\n⚠️ Важно: проверка из России показала, что этот сервер там недоступен ` +
            `(${ruFailed.detail}), а автоматически включить обход не получилось (${msg.slice(0, 150)}). ` +
            `Если целевая аудитория — Россия, стоит рассмотреть смену хостинга/страны сервера.`;
          await notifyAdmins(api, `⚠️ Узел #${nodeId}: релей не включился автоматически: ${msg.slice(0, 300)}`);
        }
      }

      logEvent(who, 'provision_ok', node.server_ip);
      const uname = await getBotUsername(sellerToken);
      const kb = uname ? new InlineKeyboard().url('🚀 Открыть моего бота', `https://t.me/${uname}`) : undefined;
      const appLine =
        protocol !== 'amneziawg'
          ? 'Клиентам он продаёт VPN за ⭐️. Для подключения — приложение OneXray (и Android, и iPhone).'
          : 'Клиентам он продаёт VPN за ⭐️. Для подключения — приложение AmneziaVPN.';
      await show(
        '🎉 Готово! Твой VPN-бизнес запущен.\n\n' +
          'Открой своего бота → /start → «🆓 Мой VPN» — заберёшь свой VPN там.\n' +
          appLine +
          restoreWarning +
          ruWarning,
        kb,
      );
    } else {
      // Доп. сервер владельца, у которого бот уже есть и работает: не второй
      // процесс с тем же токеном (баг 25.08 — 409, дважды на живом клиенте),
      // а новая локация ВНУТРИ уже работающего бота.
      const primary = getPrimaryReadyNode(node.tg_user_id);
      if (!primary) {
        // Основной узел за это время потерялся/сломался — не молчим, а
        // объясняем и не пытаемся приткнуть локацию в никуда.
        throw new Error(
          'у тебя нет ни одного готового (ready) основного сервера с ботом прямо сейчас — ' +
            'без него некуда добавлять локацию. Подними/почини основной сервер, потом повтори.',
        );
      }
      await show('✅ VPN установлен. 🔗 Добавляю сервер в твоего уже работающего бота…');

      const { supportPrivateKey } = await attachLocationToPrimary({
        newHost: node.server_ip,
        newPassword: password,
        primaryHost: primary.server_ip,
        primaryPassword: decrypt(primary.root_password_enc),
        protocol,
      });
      setNodeSupportKey(nodeId, encrypt(supportPrivateKey));

      setNodeStatus(nodeId, 'ready');
      void registerNodeDns(nodeId, node.server_ip);

      // Авто-релей тут не делаем (relay.ts нацелен на location 'local', это
      // локация владельца, а не отдельная запись) — только честно предупреждаем.
      if (ruFailed && !ruFailed.ok) {
        ruWarning =
          `\n\n⚠️ Важно: проверка из России показала, что эта локация там недоступна ` +
          `(${ruFailed.detail}). Для клиентов не из РФ всё будет работать нормально.`;
        await notifyAdmins(
          api,
          `⚠️ Узел #${nodeId} (${node.server_ip}, доп. локация) прошёл проверку со станка, но НЕ ` +
            `отвечает российскому тестовому клиенту: ${ruFailed.detail}`,
        );
      }

      logEvent(who, 'provision_ok', node.server_ip);
      const uname = await getBotUsername(decrypt(primary.seller_token_enc));
      const kb = uname ? new InlineKeyboard().url('🚀 Открыть моего бота', `https://t.me/${uname}`) : undefined;
      await show(
        `🎉 Готово! Сервер ${node.server_ip} добавлен как ещё одна точка в твоём боте.\n\n` +
          'Открывать его отдельно не нужно — он уже там, в списке локаций.' +
          ruWarning,
        kb,
      );
    }
  } catch (e) {
    setNodeStatus(nodeId, 'error');
    const msg = e instanceof Error ? e.message : String(e);
    logEvent(who, 'provision_fail', `${node.server_ip} · ${msg}`.slice(0, 200));
    await show(
      `❌ Не получилось довести настройку:\n${msg}\n\n` +
        'Можно нажать «Попробовать снова» — заново вводить ничего не нужно. ' +
        'Я уже вижу ошибку и разберусь.',
      retryKb,
    );
    await notifyAdmins(
      api,
      `⚠️ Провижининг узла #${nodeId} упал.\nСервер: ${node.server_ip}\nЮзер: @${node.tg_username ?? '—'} (${node.tg_user_id})\nОшибка: ${msg}`,
    );
  }
}
