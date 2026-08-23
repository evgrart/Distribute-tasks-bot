import crypto from 'node:crypto';
import { calculateDistribution, escapeHtml, formatDistribution, problemFingerprint } from './distribution.js';

export class DistributionBot {
  constructor(config, api, bridge, state) {
    this.config = config;
    this.api = api;
    this.bridge = bridge;
    this.state = state;
    this.stopping = false;
  }

  async start() {
    await this.state.load();
    const dropPending = this.config.dropPendingUpdatesOnStart && !this.state.bootstrapComplete;
    await this.api.call('deleteWebhook', { drop_pending_updates: dropPending });
    await this.state.markBootstrapComplete();
    await this.api.call('setMyCommands', { commands: [
      { command: 'preview', description: 'Создать черновик распределения' },
      { command: 'repeat', description: 'Показать последний черновик' },
      { command: 'reroll', description: 'Пересчитать последний черновик' },
      { command: 'help', description: 'Инструкция по боту' },
      { command: 'id', description: 'Показать Telegram ID' }
    ] });
    const me = await this.api.call('getMe');
    this.username = me.username || '';
    this.log(`Бот @${this.username} запущен в режиме long polling.`);
    if (dropPending) {
      this.log('Старый webhook и накопившиеся обновления удалены (одноразовая операция).');
    }
    await this.poll();
  }

  stop() { this.stopping = true; }

  async poll() {
    let delay = 1000;
    while (!this.stopping) {
      try {
        const updates = await this.api.getUpdates(this.state.offset);
        delay = 1000;
        for (const update of updates) {
          await this.handleSafely(update);
          await this.state.setOffset(Number(update.update_id) + 1);
        }
      } catch (error) {
        this.logError('Ошибка long polling', error);
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  async handleSafely(update) {
    try {
      if (update.callback_query) await this.handleCallback(update.callback_query);
      else if (update.message) await this.handleMessage(update.message);
    } catch (error) {
      this.logError(`Ошибка update ${update.update_id}`, error);
      const chatId = update.message?.chat?.id ?? update.callback_query?.from?.id;
      if (chatId != null) {
        await this.api.sendMessage(chatId, `⚠️ ${escapeHtml(error.message || 'Неизвестная ошибка.')}`)
          .catch(nested => this.logError('Не удалось отправить ошибку', nested));
      }
    }
  }

  async handleMessage(message) {
    const text = String(message.text || '').trim();
    if (!text.startsWith('/')) return;
    const args = text.split(/\s+/);
    const command = args.shift().split('@')[0].toLowerCase();
    const userId = String(message.from?.id ?? '');
    const chatId = String(message.chat?.id ?? '');
    const isPrivate = message.chat?.type === 'private';

    if (command === '/id') {
      await this.api.sendMessage(chatId,
        `<b>Ваш Telegram ID:</b> <code>${escapeHtml(userId)}</code>\n` +
        `<b>ID этого чата:</b> <code>${escapeHtml(chatId)}</code>`);
      return;
    }
    if (!this.isAllowed(userId)) {
      await this.api.sendMessage(chatId,
        `У вас нет доступа к распределению. Передайте практику этот ID: <code>${escapeHtml(userId)}</code>`);
      return;
    }
    if (command === '/start' || command === '/help') {
      await this.sendHelp(chatId, isPrivate);
      return;
    }
    if (!isPrivate) {
      await this.sendPrivateOnly(chatId);
      return;
    }
    if (command === '/preview') return this.previewCommand(userId, chatId, args);
    if (command === '/repeat') return this.repeatLast(userId, chatId);
    if (command === '/reroll') return this.rerollLast(userId, chatId);
    await this.sendHelp(chatId, true);
  }

  async handleCallback(query) {
    const userId = String(query.from?.id ?? '');
    const chatId = String(query.message?.chat?.id ?? userId);
    const messageId = query.message?.message_id;
    await this.api.answerCallback(String(query.id || ''), 'Принято').catch(() => {});
    if (!this.isAllowed(userId)) {
      await this.api.sendMessage(chatId, 'У вас нет доступа к распределению.');
      return;
    }
    if (query.message?.chat?.type && query.message.chat.type !== 'private') {
      await this.sendPrivateOnly(chatId);
      return;
    }
    const parts = String(query.data || '').split(':');
    if (parts[0] !== 'tg') return;
    if (parts[1] === 'practitioner') {
      const practitionerNo = this.validPractitioner(parts[2]);
      await this.safeEdit(chatId, messageId,
        `Выберите практику для ${escapeHtml(this.config.practitioners[practitionerNo - 1])}:`,
        this.practiceKeyboard(practitionerNo));
    } else if (parts[1] === 'preview') {
      await this.createAndSendPreview(userId, chatId,
        this.validPractitioner(parts[2]), this.validPractice(parts[3]), true);
    } else if (parts[1] === 'publish') {
      await this.publishDraft(parts[2], userId, chatId, messageId);
    } else if (parts[1] === 'reroll') {
      await this.rerollDraft(parts[2], userId, chatId, messageId);
    } else if (parts[1] === 'cancel') {
      await this.cancelDraft(parts[2], userId, chatId, messageId);
    }
  }

  async previewCommand(userId, chatId, args) {
    if (!args.length) return this.api.sendMessage(chatId, 'Выберите практика:', this.practitionerKeyboard());
    const practitionerNo = this.validPractitioner(args[0]);
    if (args.length === 1) {
      return this.api.sendMessage(chatId,
        `Выберите практику для ${escapeHtml(this.config.practitioners[practitionerNo - 1])}:`,
        this.practiceKeyboard(practitionerNo));
    }
    return this.createAndSendPreview(userId, chatId, practitionerNo, this.validPractice(args[1]), true);
  }

  async createAndSendPreview(userId, chatId, practitionerNo, practiceNo, fresh) {
    const reservation = await this.state.reservePair(practitionerNo, practiceNo, userId);
    try {
      await this.api.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      const seed = crypto.randomUUID();
      const problem = await this.bridge.getProblem(practitionerNo, practiceNo, { fresh });
      problem.fingerprint ||= problemFingerprint(problem);
      const result = calculateDistribution(
        problem, seed, this.config.randomMax, this.config.solvedPriorityPower
      );
      const text = formatDistribution(problem, result, this.config.maxMessageLength);
      const draft = {
        id: crypto.randomUUID().replaceAll('-', '').slice(0, 12),
        ownerId: String(userId), practitionerNo, practitioner: problem.practitioner,
        practiceNo, targetChatId: String(this.config.targetChatIds[practitionerNo]),
        seed, fingerprint: problem.fingerprint, createdAt: Date.now(), status: 'draft', text,
        assignments: result.assignments.map(item => [
          item.name, item.telegram || '', item.tasks.map(task => task.label)
        ])
      };
      await this.state.saveDraft(draft);
      await this.sendDraft(chatId, draft);
      return draft;
    } finally {
      await this.state.releasePair(reservation);
    }
  }

  async sendDraft(chatId, draft) {
    const keyboard = draft.status === 'draft' ? { inline_keyboard: [
      [{ text: '✅ Опубликовать', callback_data: `tg:publish:${draft.id}` }],
      [
        { text: '🎲 Пересчитать', callback_data: `tg:reroll:${draft.id}` },
        { text: '✖ Отменить', callback_data: `tg:cancel:${draft.id}` }
      ]
    ] } : null;
    await this.api.sendMessage(chatId, draft.text, keyboard);
  }

  async repeatLast(userId, chatId) {
    const draft = await this.getUsableLastDraft(userId);
    await this.sendDraft(chatId, draft);
  }

  async rerollLast(userId, chatId) {
    const draft = await this.getUsableLastDraft(userId);
    await this.rerollDraft(draft.id, userId, chatId, null);
  }

  async rerollDraft(id, userId, chatId, messageId) {
    const draft = await this.lockDraft(id, userId, 'rerolling');
    try {
      const next = await this.createAndSendPreview(
        userId, chatId, Number(draft.practitionerNo), Number(draft.practiceNo), false);
      await this.setDraftStatus(id, 'superseded');
      if (messageId) await this.safeClear(chatId, messageId);
      return next;
    } catch (error) {
      await this.setDraftStatus(id, 'draft');
      throw error;
    }
  }

  async publishDraft(id, userId, chatId, messageId) {
    const draft = await this.lockDraft(id, userId, 'publishing');
    try {
      await this.api.sendMessage(draft.targetChatId, draft.text);
      await this.setDraftStatus(id, 'published');
    } catch (error) {
      await this.setDraftStatus(id, 'draft');
      throw error;
    }
    if (messageId) await this.safeClear(chatId, messageId);
    await this.api.sendMessage(chatId, '✅ Распределение опубликовано в беседе.');
  }

  async cancelDraft(id, userId, chatId, messageId) {
    await this.lockDraft(id, userId, 'cancelled');
    if (messageId) await this.safeClear(chatId, messageId);
    await this.api.sendMessage(chatId, 'Черновик отменён.');
  }

  async getUsableLastDraft(userId) {
    let draft = this.state.getLastDraft(userId);
    if (!draft || String(draft.ownerId) !== String(userId) ||
        ['cancelled', 'superseded'].includes(draft.status)) {
      throw new Error('Свежего черновика нет. Создайте его командой /preview.');
    }
    if (['publishing', 'rerolling'].includes(draft.status) &&
        Date.now() - Number(draft.actionAt || 0) > this.config.actionTimeoutMs) {
      draft = await this.setDraftStatus(draft.id, 'draft');
    }
    return draft;
  }

  lockDraft(id, userId, status) {
    return this.state.updateDraft(id, draft => {
      if (String(draft.ownerId) !== String(userId) && !this.isAdmin(userId)) {
        throw new Error('Это черновик другого практика.');
      }
      if (Date.now() - Number(draft.createdAt) > this.config.draftTtlMs) throw new Error('Черновик уже устарел.');
      if (draft.status === 'published') throw new Error('Этот черновик уже опубликован.');
      if (draft.status === 'cancelled') throw new Error('Этот черновик отменён.');
      if (draft.status === 'superseded') throw new Error('Этот черновик уже был пересчитан.');
      if (['publishing', 'rerolling'].includes(draft.status) &&
          Date.now() - Number(draft.actionAt || 0) <= this.config.actionTimeoutMs) {
        throw new Error('Операция уже выполняется.');
      }
      draft.status = status;
      draft.actionAt = Date.now();
    });
  }

  setDraftStatus(id, status) {
    return this.state.updateDraft(id, draft => {
      draft.status = status;
      draft.actionAt = Date.now();
    });
  }

  practitionerKeyboard() {
    return { inline_keyboard: this.config.practitioners.map((name, index) => [{
      text: `${index + 1}. ${name}`, callback_data: `tg:practitioner:${index + 1}`
    }]) };
  }

  practiceKeyboard(practitionerNo) {
    const rows = [];
    for (let practice = 1; practice <= this.config.practiceCount; practice += 5) {
      rows.push(Array.from({ length: Math.min(5, this.config.practiceCount - practice + 1) }, (_, offset) => ({
        text: String(practice + offset), callback_data: `tg:preview:${practitionerNo}:${practice + offset}`
      })));
    }
    return { inline_keyboard: rows };
  }

  async sendHelp(chatId, isPrivate) {
    let text = [
      '<b>Распределение задач ДМ</b>', '',
      '<code>/preview 1 6</code> — черновик для Артёма, практики 6.',
      '<code>/repeat</code> — повторить последний черновик.',
      '<code>/reroll</code> — пересчитать его с новой случайностью.',
      '<code>/id</code> — показать ваш ID и ID текущего чата.', '',
      'Таблицы: 1 — Артём, 2 — Рами, 3 — Немат.',
      'Бот ничего не записывает в учебные таблицы.'
    ].join('\n');
    if (!isPrivate) text += '\n\nЧерновики создаются только в личном диалоге с ботом.';
    await this.api.sendMessage(chatId, text, isPrivate ? this.practitionerKeyboard() : null);
  }

  async sendPrivateOnly(chatId) {
    const suffix = this.username
      ? `\n<a href="https://t.me/${escapeHtml(this.username)}">Открыть бота</a>`
      : '\nОткройте личный диалог с ботом и отправьте /preview.';
    await this.api.sendMessage(chatId,
      'Черновик распределения доступен только практику в личном диалоге.' + suffix);
  }

  async safeEdit(chatId, messageId, text, keyboard) {
    try { await this.api.editMessage(chatId, messageId, text, keyboard); }
    catch (error) { if (!/message is not modified/i.test(error.message)) throw error; }
  }

  async safeClear(chatId, messageId) {
    try { await this.api.clearKeyboard(chatId, messageId); }
    catch (error) { if (!/message is not modified/i.test(error.message)) throw error; }
  }

  validPractitioner(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > this.config.practitioners.length) {
      throw new Error('Номер таблицы должен быть целым числом от 1 до 3.');
    }
    return number;
  }

  validPractice(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > this.config.practiceCount) {
      throw new Error(`Номер практики должен быть от 1 до ${this.config.practiceCount}.`);
    }
    return number;
  }

  isAdmin(userId) { return this.config.adminUserIds.has(String(userId)); }
  isAllowed(userId) { return this.isAdmin(userId) || this.config.allowedUserIds.has(String(userId)); }
  log(message) { console.log(`[${formatNow(this.config.timeZone)}] ${message}`); }
  logError(context, error) { console.error(`[${formatNow(this.config.timeZone)}] ${context}:`, error?.stack || error); }
}

function formatNow(timeZone) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
