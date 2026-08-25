import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InlineKeyboard, type Api } from 'grammy';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { getNodeById, getPrimaryReadyNode, setNodeStatus, setNodeSupportKey } from './db.js';
import { runRemoteInstall } from './ssh.js';
import { deploySeller, getBotUsername } from './deploy-seller.js';
import { attachLocationToPrimary } from './attach-location.js';
import { notifyAdmins } from './admin.js';
import { checkSshPort, preflightMessage } from './preflight.js';
import { logEvent } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../scripts/install-amneziawg.sh');

// Провижининг узла: ставим AmneziaWG и разворачиваем бота-продавца.
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

  setNodeStatus(nodeId, 'provisioning');
  await show(`🔌 Ставлю AmneziaWG на ${node.server_ip}… (пара минут)`);

  try {
    await runRemoteInstall({
      host: node.server_ip,
      password,
      scriptLocalPath: SCRIPT_PATH,
      args: [node.server_ip],
    });

    if (node.is_primary) {
      await show('✅ VPN установлен. ⚙️ Запускаю твоего бота-продавца… ещё пара минут.');

      await deploySeller({
        host: node.server_ip,
        password,
        sellerToken,
        ownerId: node.tg_user_id,
        stanokUrl: config.stanokUrl,
        priceStars: config.sellerPriceStars,
      });

      setNodeStatus(nodeId, 'ready');
      logEvent(who, 'provision_ok', node.server_ip);
      const uname = await getBotUsername(sellerToken);
      const kb = uname ? new InlineKeyboard().url('🚀 Открыть моего бота', `https://t.me/${uname}`) : undefined;
      await show(
        '🎉 Готово! Твой VPN-бизнес запущен.\n\n' +
          'Открой своего бота → /start → «🆓 Мой VPN» — заберёшь свой VPN там.\n' +
          'Клиентам он продаёт VPN за ⭐️. Для подключения — приложение AmneziaVPN.',
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
      });
      setNodeSupportKey(nodeId, encrypt(supportPrivateKey));

      setNodeStatus(nodeId, 'ready');
      logEvent(who, 'provision_ok', node.server_ip);
      const uname = await getBotUsername(decrypt(primary.seller_token_enc));
      const kb = uname ? new InlineKeyboard().url('🚀 Открыть моего бота', `https://t.me/${uname}`) : undefined;
      await show(
        `🎉 Готово! Сервер ${node.server_ip} добавлен как ещё одна точка в твоём боте.\n\n` +
          'Открывать его отдельно не нужно — он уже там, в списке локаций.',
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
