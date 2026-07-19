import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InlineKeyboard, type Api } from 'grammy';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { getNodeById, setNodeStatus } from './db.js';
import { runRemoteInstall } from './ssh.js';
import { deploySeller, getBotUsername } from './deploy-seller.js';
import { notifyAdmins } from './admin.js';

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

  setNodeStatus(nodeId, 'provisioning');
  await show(`🔌 Ставлю AmneziaWG на ${node.server_ip}… (пара минут)`);

  try {
    await runRemoteInstall({
      host: node.server_ip,
      password,
      scriptLocalPath: SCRIPT_PATH,
      args: [node.server_ip],
    });
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
    const uname = await getBotUsername(sellerToken);
    const kb = uname ? new InlineKeyboard().url('🚀 Открыть моего бота', `https://t.me/${uname}`) : undefined;
    await show(
      '🎉 Готово! Твой VPN-бизнес запущен.\n\n' +
        'Открой своего бота → /start → «🆓 Мой VPN» — заберёшь свой VPN там.\n' +
        'Клиентам он продаёт VPN за ⭐️. Для подключения — приложение AmneziaVPN.',
      kb,
    );
  } catch (e) {
    setNodeStatus(nodeId, 'error');
    const msg = e instanceof Error ? e.message : String(e);
    await show(`❌ Не получилось довести настройку:\n${msg}\n\nМы уже видим ошибку и разберёмся.`);
    await notifyAdmins(
      api,
      `⚠️ Провижининг узла #${nodeId} упал.\nСервер: ${node.server_ip}\nЮзер: @${node.tg_username ?? '—'} (${node.tg_user_id})\nОшибка: ${msg}`,
    );
  }
}
