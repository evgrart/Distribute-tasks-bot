export class TelegramApi {
  constructor(token, pollTimeoutSeconds = 45) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
  }

  async call(method, payload = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(`Telegram API (${method}): ${result?.description || `HTTP ${response.status}`}`);
      }
      return result.result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`Telegram API (${method}): превышено время ожидания.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  getUpdates(offset) {
    return this.call('getUpdates', {
      offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ['message', 'callback_query']
    }, (this.pollTimeoutSeconds + 10) * 1000);
  }

  sendMessage(chatId, text, keyboard = null) {
    const payload = {
      chat_id: String(chatId), text: String(text), parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (keyboard) payload.reply_markup = keyboard;
    return this.call('sendMessage', payload);
  }

  editMessage(chatId, messageId, text, keyboard) {
    return this.call('editMessageText', {
      chat_id: String(chatId), message_id: Number(messageId), text: String(text),
      parse_mode: 'HTML', reply_markup: keyboard || { inline_keyboard: [] }
    });
  }

  clearKeyboard(chatId, messageId) {
    return this.call('editMessageReplyMarkup', {
      chat_id: String(chatId), message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] }
    });
  }

  answerCallback(id, text = '') {
    return this.call('answerCallbackQuery', {
      callback_query_id: id, text, show_alert: false
    });
  }
}
