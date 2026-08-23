/**
 * Telegram-бот распределения задач для ДМсистемы.
 *
 * Этот файл нужно добавить в тот же Apps Script-проект, где находится Code.gs.
 * Он использует объект DM и функцию plusLayout_ из Code.gs, но только читает
 * учебные таблицы: бот не меняет плюсы, единицы, штрафы и баллы.
 */

const TG_BOT = {
  draftPrefix: 'TG_DRAFT_',
  draftTextPrefix: 'TG_DRAFT_TEXT_',
  lastDraftPrefix: 'TG_LAST_',
  pairPrefix: 'TG_PAIR_',
  updatePrefix: 'TG_UPDATE_',
  draftTtlMs: 2 * 60 * 60 * 1000,
  pairReservationMs: 2 * 60 * 1000,
  publishingTimeoutMs: 2 * 60 * 1000,
  updateCacheSeconds: 6 * 60 * 60,
  maxMessageLength: 3900,
  draftTextChunkLength: 1800,
  randomMax: 997
};

// Вызывается из onOpen() в Code.gs, если TelegramBot.gs добавлен в проект.
function telegramMenu_(ui) {
  return ui.createMenu('Telegram-бот')
    .addItem('Проверить настройки', 'telegramTestConfiguration')
    .addItem('Установить webhook', 'telegramSetWebhook')
    .addItem('Информация о webhook', 'telegramWebhookInfo')
    .addItem('Удалить webhook', 'telegramDeleteWebhook');
}

/**
 * Устанавливает webhook на URL текущего Web App-развёртывания.
 * До запуска заполните Script Properties согласно README.
 */
function telegramSetWebhook() {
  const config = tg_getConfig_(false);
  if (!config.webhookSecret) throw new Error('Не задан TELEGRAM_WEBHOOK_SECRET.');
  const serviceUrl = config.webAppUrl || ScriptApp.getService().getUrl();
  if (!serviceUrl) {
    throw new Error(
      'Сначала разверните проект как Web App или задайте TELEGRAM_WEB_APP_URL в Script Properties.'
    );
  }
  if (/\/dev(?:\?|$)/.test(serviceUrl)) {
    throw new Error(
      'Для Telegram нужен опубликованный URL, заканчивающийся на /exec. URL /dev доступен только редакторам.'
    );
  }

  const me = tg_api_('getMe', {});
  PropertiesService.getScriptProperties()
    .setProperty('TELEGRAM_BOT_USERNAME', String(me.username || ''));

  tg_api_('setMyCommands', {
    commands: [
      { command: 'preview', description: 'Создать черновик распределения' },
      { command: 'repeat', description: 'Показать последний черновик' },
      { command: 'reroll', description: 'Пересчитать последний черновик' },
      { command: 'help', description: 'Инструкция по боту' },
      { command: 'id', description: 'Показать Telegram ID' }
    ]
  });

  const separator = serviceUrl.indexOf('?') >= 0 ? '&' : '?';
  const webhookUrl = serviceUrl + separator +
    'secret=' + encodeURIComponent(config.webhookSecret);
  const result = tg_api_('setWebhook', {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false
  });
  console.log(JSON.stringify({ ok: result, bot: me.username, url: serviceUrl }));
  tg_toast_('Webhook Telegram-бота установлен.');
  return result;
}

function telegramDeleteWebhook() {
  tg_getConfig_(false);
  const result = tg_api_('deleteWebhook', { drop_pending_updates: false });
  console.log(JSON.stringify(result));
  tg_toast_('Webhook Telegram-бота удалён.');
  return result;
}

function telegramWebhookInfo() {
  tg_getConfig_(false);
  const result = tg_api_('getWebhookInfo', {});
  console.log(JSON.stringify(result, null, 2));
  tg_toast_('Информация записана в журнал выполнения Apps Script.');
  return result;
}

function telegramTestConfiguration() {
  validateConfig_();
  const config = tg_getConfig_(true);
  const central = SpreadsheetApp.openById(getCentralId_());
  if (!central.getSheetByName(DM.common)) {
    throw new Error(`В центральной таблице нет листа «${DM.common}».`);
  }

  const files = {};
  DM.practitioners.forEach((practitioner, index) => {
    const file = SpreadsheetApp.openById(DM.plusFileIds[practitioner]);
    const missingSheets = [];
    for (let practice = 1; practice <= DM.practiceCount; practice++) {
      if (!file.getSheetByName(`Практика ${practice}`)) missingSheets.push(practice);
    }
    if (missingSheets.length) {
      throw new Error(
        `В файле ${practitioner} нет листов практик: ${missingSheets.join(', ')}.`
      );
    }
    if (!config.targetChatIds[String(index + 1)]) {
      throw new Error(`В TARGET_CHAT_IDS не указан чат для таблицы ${index + 1}.`);
    }
    files[practitioner] = file.getName();
  });

  const me = tg_api_('getMe', {});
  const result = {
    bot: '@' + me.username,
    central: central.getName(),
    practitionerFiles: files,
    allowedUsers: config.allowedUserIds,
    targetChats: config.targetChatIds,
    webAppUrl: config.webAppUrl || ScriptApp.getService().getUrl() || ''
  };
  console.log(JSON.stringify(result, null, 2));
  tg_toast_('Настройки Telegram-бота корректны.');
  return result;
}

/**
 * Точка входа Telegram webhook.
 * Apps Script Web App должен выполняться от имени владельца проекта.
 */
function doPost(e) {
  let update = null;
  try {
    if (!tg_hasValidWebhookSecret_(e)) {
      return tg_httpText_('forbidden');
    }
    update = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    if (!update || update.update_id == null) return tg_httpText_('ok');
    if (tg_isDuplicateUpdate_(update.update_id)) return tg_httpText_('ok');

    if (update.callback_query) {
      tg_handleCallback_(update.callback_query);
    } else if (update.message) {
      tg_handleMessage_(update.message);
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    tg_reportUpdateError_(update, error);
  }
  return tg_httpText_('ok');
}

function doGet() {
  return tg_httpText_('DM Telegram bot webhook is running.');
}

function tg_handleMessage_(message) {
  const text = String(message.text || '').trim();
  if (!text || text.charAt(0) !== '/') return;

  const parts = text.split(/\s+/);
  const command = parts.shift().split('@')[0].toLowerCase();
  const userId = String(message.from && message.from.id != null ? message.from.id : '');
  const chatId = String(message.chat && message.chat.id != null ? message.chat.id : '');
  const chatType = String(message.chat && message.chat.type || '');

  if (command === '/id') {
    tg_sendMessage_(chatId,
      `<b>Ваш Telegram ID:</b> <code>${tg_escapeHtml_(userId)}</code>\n` +
      `<b>ID этого чата:</b> <code>${tg_escapeHtml_(chatId)}</code>`
    );
    return;
  }

  if (!tg_isAllowedUser_(userId)) {
    tg_sendMessage_(chatId,
      'У вас нет доступа к распределению. Передайте практику этот ID: ' +
      `<code>${tg_escapeHtml_(userId)}</code>`
    );
    return;
  }

  if (command === '/start' || command === '/help') {
    tg_sendHelp_(chatId, chatType === 'private');
    return;
  }

  if (chatType !== 'private') {
    tg_sendPrivateOnlyMessage_(chatId);
    return;
  }

  if (command === '/preview') {
    tg_handlePreviewCommand_(userId, chatId, parts);
    return;
  }
  if (command === '/repeat') {
    tg_repeatLastDraft_(userId, chatId);
    return;
  }
  if (command === '/reroll') {
    tg_rerollLastDraft_(userId, chatId);
    return;
  }

  tg_sendHelp_(chatId, true);
}

function tg_handlePreviewCommand_(userId, chatId, args) {
  if (!args.length) {
    tg_sendPractitionerPicker_(chatId);
    return;
  }
  const practitionerNo = Number(args[0]);
  if (!tg_isIntegerInRange_(practitionerNo, 1, DM.practitioners.length)) {
    throw new Error('Номер таблицы должен быть целым числом от 1 до 3.');
  }
  if (args.length === 1) {
    tg_sendPracticePicker_(chatId, practitionerNo);
    return;
  }
  const practiceNo = Number(args[1]);
  if (!tg_isIntegerInRange_(practiceNo, 1, DM.practiceCount)) {
    throw new Error(`Номер практики должен быть целым числом от 1 до ${DM.practiceCount}.`);
  }
  tg_createAndSendPreview_(userId, chatId, practitionerNo, practiceNo);
}

function tg_handleCallback_(query) {
  const callbackId = String(query.id || '');
  const userId = String(query.from && query.from.id != null ? query.from.id : '');
  const message = query.message || {};
  const chatId = String(message.chat && message.chat.id != null
    ? message.chat.id : userId);
  const chatType = String(message.chat && message.chat.type || '');
  const data = String(query.data || '');

  tg_answerCallback_(callbackId, 'Принято');
  if (!tg_isAllowedUser_(userId)) {
    tg_sendMessage_(chatId, 'У вас нет доступа к распределению.');
    return;
  }
  if (chatType && chatType !== 'private') {
    tg_sendPrivateOnlyMessage_(chatId);
    return;
  }

  const parts = data.split(':');
  if (parts[0] !== 'tg') return;

  if (parts[1] === 'practitioner') {
    const practitionerNo = Number(parts[2]);
    tg_editPickerToPractices_(chatId, message.message_id, practitionerNo);
    return;
  }
  if (parts[1] === 'preview') {
    const practitionerNo = Number(parts[2]);
    const practiceNo = Number(parts[3]);
    tg_createAndSendPreview_(userId, chatId, practitionerNo, practiceNo);
    return;
  }
  if (parts[1] === 'publish') {
    tg_publishDraft_(parts[2], userId, chatId, message.message_id);
    return;
  }
  if (parts[1] === 'reroll') {
    tg_rerollDraft_(parts[2], userId, chatId, message.message_id);
    return;
  }
  if (parts[1] === 'cancel') {
    tg_cancelDraft_(parts[2], userId, chatId, message.message_id);
  }
}

function tg_sendHelp_(chatId, isPrivate) {
  let text = [
    '<b>Распределение задач ДМ</b>',
    '',
    '<code>/preview 1 6</code> — черновик для Артёма, практики 6.',
    '<code>/repeat</code> — повторить последний черновик.',
    '<code>/reroll</code> — пересчитать его с новой случайностью.',
    '<code>/id</code> — показать ваш ID и ID текущего чата.',
    '',
    'Таблицы: 1 — Артём, 2 — Рами, 3 — Немат.',
    'Бот ничего не записывает в учебные таблицы.'
  ].join('\n');
  if (!isPrivate) text += '\n\nЧерновики создаются только в личном диалоге с ботом.';
  tg_sendMessage_(chatId, text, isPrivate ? tg_practitionerKeyboard_() : null);
}

function tg_sendPrivateOnlyMessage_(chatId) {
  const username = PropertiesService.getScriptProperties()
    .getProperty('TELEGRAM_BOT_USERNAME');
  const suffix = username
    ? `\n<a href="https://t.me/${tg_escapeHtml_(username)}">Открыть бота</a>`
    : '\nОткройте личный диалог с ботом и отправьте /preview.';
  tg_sendMessage_(chatId, 'Черновик распределения доступен только практику в личном диалоге.' + suffix);
}

function tg_sendPractitionerPicker_(chatId) {
  tg_sendMessage_(chatId, 'Выберите практика:', tg_practitionerKeyboard_());
}

function tg_practitionerKeyboard_() {
  return {
    inline_keyboard: DM.practitioners.map((name, index) => [{
      text: `${index + 1}. ${name}`,
      callback_data: `tg:practitioner:${index + 1}`
    }])
  };
}

function tg_sendPracticePicker_(chatId, practitionerNo) {
  const practitioner = tg_practitionerByNumber_(practitionerNo);
  tg_sendMessage_(chatId, `Выберите практику для ${tg_escapeHtml_(practitioner)}:`,
    tg_practiceKeyboard_(practitionerNo));
}

function tg_editPickerToPractices_(chatId, messageId, practitionerNo) {
  const practitioner = tg_practitionerByNumber_(practitionerNo);
  tg_editMessage_(chatId, messageId,
    `Выберите практику для ${tg_escapeHtml_(practitioner)}:`,
    tg_practiceKeyboard_(practitionerNo));
}

function tg_practiceKeyboard_(practitionerNo) {
  tg_practitionerByNumber_(practitionerNo);
  const rows = [];
  let row = [];
  for (let practice = 1; practice <= DM.practiceCount; practice++) {
    row.push({
      text: String(practice),
      callback_data: `tg:preview:${practitionerNo}:${practice}`
    });
    if (row.length === 5) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

function tg_createAndSendPreview_(userId, chatId, practitionerNo, practiceNo) {
  tg_practitionerByNumber_(practitionerNo);
  if (!tg_isIntegerInRange_(practiceNo, 1, DM.practiceCount)) {
    throw new Error(`Практика должна быть от 1 до ${DM.practiceCount}.`);
  }
  const targetChatId = tg_targetChatId_(practitionerNo);
  const reservation = tg_reservePair_(practitionerNo, practiceNo, userId);
  try {
    tg_api_('sendChatAction', { chat_id: chatId, action: 'typing' });
    const seed = Utilities.getUuid();
    const problem = tg_readDistributionProblem_(practitionerNo, practiceNo);
    const result = tg_calculateDistribution_(problem, seed);
    const text = tg_formatDistribution_(problem, result);
    const draft = {
      id: tg_newDraftId_(),
      ownerId: String(userId),
      practitionerNo,
      practitioner: problem.practitioner,
      practiceNo,
      targetChatId: String(targetChatId),
      seed,
      fingerprint: problem.fingerprint,
      createdAt: Date.now(),
      status: 'draft',
      text,
      assignments: result.assignments.map(item => [
        item.name,
        item.telegram || '',
        item.tasks.map(task => task.label)
      ])
    };
    tg_saveNewDraft_(draft);
    tg_sendDraft_(chatId, draft);
    return draft;
  } finally {
    tg_releasePair_(practitionerNo, practiceNo, reservation);
  }
}

function tg_sendDraft_(chatId, draft) {
  const keyboard = draft.status === 'draft' ? {
    inline_keyboard: [
      [{ text: '✅ Опубликовать', callback_data: `tg:publish:${draft.id}` }],
      [
        { text: '🎲 Пересчитать', callback_data: `tg:reroll:${draft.id}` },
        { text: '✖ Отменить', callback_data: `tg:cancel:${draft.id}` }
      ]
    ]
  } : null;
  return tg_sendMessage_(chatId, draft.text, keyboard);
}

function tg_repeatLastDraft_(userId, chatId) {
  const draft = tg_getLastDraftForUser_(userId);
  if (!draft) throw new Error('Свежего черновика нет. Создайте его командой /preview.');
  tg_sendDraft_(chatId, draft);
}

function tg_rerollLastDraft_(userId, chatId) {
  const draft = tg_getLastDraftForUser_(userId);
  if (!draft) throw new Error('Свежего черновика нет. Создайте его командой /preview.');
  tg_rerollDraft_(draft.id, userId, chatId, null);
}

function tg_rerollDraft_(draftId, userId, chatId, messageId) {
  const draft = tg_lockDraftForAction_(draftId, userId, 'rerolling');
  try {
    const next = tg_createAndSendPreview_(
      userId, chatId, Number(draft.practitionerNo), Number(draft.practiceNo)
    );
    tg_finishDraftAction_(draftId, 'superseded');
    if (messageId) tg_clearInlineKeyboard_(chatId, messageId);
    return next;
  } catch (error) {
    tg_finishDraftAction_(draftId, 'draft');
    throw error;
  }
}

function tg_cancelDraft_(draftId, userId, chatId, messageId) {
  tg_lockDraftForAction_(draftId, userId, 'cancelled');
  if (messageId) tg_clearInlineKeyboard_(chatId, messageId);
  tg_sendMessage_(chatId, 'Черновик отменён.');
}

function tg_publishDraft_(draftId, userId, chatId, messageId) {
  const draft = tg_lockDraftForAction_(draftId, userId, 'publishing');
  try {
    tg_sendMessage_(String(draft.targetChatId), draft.text);
    tg_finishDraftAction_(draftId, 'published');
  } catch (error) {
    tg_finishDraftAction_(draftId, 'draft');
    throw error;
  }
  if (messageId) tg_clearInlineKeyboard_(chatId, messageId);
  tg_sendMessage_(chatId, '✅ Распределение опубликовано в беседе.');
}

/**
 * Читает центральную таблицу и все 15 листов выбранного практика.
 * Возвращает чистую структуру данных для алгоритма.
 */
function tg_readDistributionProblem_(practitionerNo, practiceNo) {
  validateConfig_();
  const practitioner = tg_practitionerByNumber_(practitionerNo);
  const central = SpreadsheetApp.openById(getCentralId_());
  const common = central.getSheetByName(DM.common);
  if (!common) throw new Error(`Не найден лист «${DM.common}».`);

  const commonHeaderRow = DM.commonFirstRow - 1;
  const commonWidth = Math.max(14, Math.min(common.getLastColumn(), 50));
  const commonHeaders = common.getRange(commonHeaderRow, 1, 1, commonWidth)
    .getDisplayValues()[0];
  const commonColumns = {
    name: tg_findHeader_(commonHeaders, ['ФИО'], true),
    practitioner: tg_findHeader_(commonHeaders, ['Практик'], true),
    telegram: tg_findHeader_(commonHeaders, ['TG', 'Telegram', 'Телеграм'], true),
    active: tg_findHeader_(commonHeaders, ['Прод', 'Активен'], true)
  };
  const commonRows = common.getRange(
    DM.commonFirstRow, 1,
    DM.commonLastRow - DM.commonFirstRow + 1,
    commonWidth
  ).getDisplayValues();
  const centralByName = {};
  const telegramOwners = {};
  commonRows.forEach(row => {
    const name = tg_cleanText_(row[commonColumns.name]);
    if (!name) return;
    const key = tg_nameKey_(name);
    if (centralByName[key]) {
      throw new Error(`В листе «${DM.common}» два студента с ФИО «${name}».`);
    }
    const telegram = tg_normalizeTelegram_(row[commonColumns.telegram]);
    const telegramKey = telegram.toLowerCase();
    if (telegram && telegramOwners[telegramKey]) {
      throw new Error(
        `Telegram ${telegram} указан одновременно у «${telegramOwners[telegramKey]}» и «${name}».`
      );
    }
    if (telegram) telegramOwners[telegramKey] = name;
    centralByName[key] = {
      name,
      practitioner: tg_cleanText_(row[commonColumns.practitioner]),
      telegram,
      active: tg_isActiveValue_(row[commonColumns.active])
    };
  });

  const fileId = DM.plusFileIds[practitioner];
  if (!fileId) throw new Error(`Не указан ID файла практика ${practitioner}.`);
  const plusFile = SpreadsheetApp.openById(fileId);
  const layout = plusLayout_(practitioner);
  const semesterSolved = {};
  const missingPracticeSheets = [];
  let selectedSnapshot = null;

  for (let number = 1; number <= DM.practiceCount; number++) {
    const sheet = plusFile.getSheetByName(`Практика ${number}`);
    if (!sheet) {
      missingPracticeSheets.push(number);
      continue;
    }
    const block = sheet.getRange(
      DM.plusHeaderRow, 1, DM.studentsPerGroup + 1, layout.taskLastCol
    ).getDisplayValues();
    const headers = block[0].slice(layout.taskFirstCol - 1, layout.taskLastCol);
    const rows = block.slice(1);
    const seenNames = {};
    const enabledOffsets = [];
    headers.forEach((header, offset) => {
      if (tg_cleanText_(header)) enabledOffsets.push(offset);
    });

    rows.forEach(row => {
      const name = tg_cleanText_(row[0]);
      if (!name) return;
      const key = tg_nameKey_(name);
      if (seenNames[key]) {
        throw new Error(`На листе «Практика ${number}» дважды встречается ФИО «${name}».`);
      }
      seenNames[key] = true;
      let solved = 0;
      enabledOffsets.forEach(offset => {
        const marker = tg_marker_(row[layout.taskFirstCol - 1 + offset]);
        if (marker === '+' || marker === '1') solved++;
      });
      semesterSolved[key] = (semesterSolved[key] || 0) + solved;
    });

    if (number === practiceNo) {
      selectedSnapshot = { sheetName: sheet.getName(), headers, rows };
    }
  }

  if (!selectedSnapshot) {
    throw new Error(`В файле ${practitioner} нет листа «Практика ${practiceNo}».`);
  }

  const tasks = [];
  const taskByKey = {};
  selectedSnapshot.headers.forEach((rawLabel, offset) => {
    const label = tg_cleanText_(rawLabel);
    if (!label) return;
    const key = tg_taskKey_(label);
    if (taskByKey[key]) {
      throw new Error(`В шапке практики повторяется задача «${label}».`);
    }
    const task = { key, label, offset, covered: false };
    tasks.push(task);
    taskByKey[key] = task;
  });
  if (!tasks.length) throw new Error('В выбранной практике нет заголовков задач.');

  selectedSnapshot.rows.forEach(row => {
    if (!tg_cleanText_(row[0])) return;
    tasks.forEach(task => {
      const marker = tg_marker_(row[layout.taskFirstCol - 1 + task.offset]);
      if (marker === '1') task.covered = true;
    });
  });

  const diagnostics = {
    missingCentral: [],
    wrongPractitioner: [],
    inactive: [],
    absent: [],
    full: [],
    missingPracticeSheets
  };
  const students = [];
  const requiresPresence = practitioner !== 'Рами';

  selectedSnapshot.rows.forEach((row, order) => {
    const sheetName = tg_cleanText_(row[0]);
    if (!sheetName) return;
    const key = tg_nameKey_(sheetName);
    const centralStudent = centralByName[key];
    if (!centralStudent) {
      diagnostics.missingCentral.push(sheetName);
      return;
    }
    if (tg_nameKey_(centralStudent.practitioner) !== tg_nameKey_(practitioner)) {
      diagnostics.wrongPractitioner.push(centralStudent.name);
      return;
    }
    if (!centralStudent.active) {
      diagnostics.inactive.push(centralStudent.name);
      return;
    }
    if (requiresPresence && !tg_isYes_(row[layout.presenceCol - 1])) {
      diagnostics.absent.push(centralStudent.name);
      return;
    }

    let existingOnes = 0;
    const candidateTaskKeys = [];
    tasks.forEach(task => {
      const marker = tg_marker_(row[layout.taskFirstCol - 1 + task.offset]);
      if (marker === '1') existingOnes++;
      if (marker === '+' && !task.covered) candidateTaskKeys.push(task.key);
    });
    if (existingOnes > 2) {
      throw new Error(
        `У студента «${centralStudent.name}» уже ${existingOnes} единицы на практике ${practiceNo}.`
      );
    }
    const slots = Math.max(0, 2 - existingOnes);
    if (!slots) diagnostics.full.push(centralStudent.name);
    students.push({
      id: key,
      name: centralStudent.name,
      telegram: centralStudent.telegram,
      order,
      existingOnes,
      slots,
      semesterSolved: semesterSolved[key] || 0,
      candidateTaskKeys
    });
  });

  const candidateKeys = {};
  students.forEach(student => {
    if (!student.slots) return;
    student.candidateTaskKeys.forEach(key => { candidateKeys[key] = true; });
  });
  const noCandidateTasks = tasks
    .filter(task => !task.covered && !candidateKeys[task.key])
    .map(task => task.key);

  const problem = {
    practitionerNo,
    practitioner,
    practiceNo,
    tasks,
    students,
    noCandidateTasks,
    diagnostics
  };
  problem.fingerprint = tg_problemFingerprint_(problem);
  return problem;
}

/**
 * Чистый алгоритм min-cost max-flow. Не обращается к Google/Telegram и поэтому
 * может тестироваться отдельно.
 */
function tg_calculateDistribution_(problem, seed) {
  const openTasks = problem.tasks.filter(task => !task.covered);
  if (!openTasks.length) {
    return {
      flow: 0,
      cost: 0,
      assignments: [],
      assignedTaskKeys: [],
      unmatchedTaskKeys: []
    };
  }

  const taskLookup = {};
  openTasks.forEach(task => { taskLookup[task.key] = task; });
  const students = problem.students.filter(student =>
    student.slots > 0 && student.candidateTaskKeys.some(key => taskLookup[key])
  );
  const slots = [];
  students.forEach(student => {
    for (let index = 0; index < student.slots; index++) {
      slots.push({
        student,
        ordinal: student.existingOnes + index + 1
      });
    }
  });

  const source = 0;
  const slotStart = 1;
  const taskStart = slotStart + slots.length;
  const sink = taskStart + openTasks.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const maxSolved = students.reduce((best, student) =>
    Math.max(best, Math.max(0, Number(student.semesterSolved) || 0)), 0);
  const flowBound = openTasks.length;
  const priorityUnit = flowBound * TG_BOT.randomMax + 1;
  const secondSlotPenalty =
    flowBound * (maxSolved * priorityUnit + TG_BOT.randomMax) + 1;
  const assignmentEdges = [];

  slots.forEach((slot, slotIndex) => {
    const slotNode = slotStart + slotIndex;
    const solved = Math.max(0, Number(slot.student.semesterSolved) || 0);
    const secondCost = slot.ordinal >= 2 ? secondSlotPenalty : 0;
    tg_addFlowEdge_(graph, source, slotNode, 1,
      secondCost + solved * priorityUnit, null);

    slot.student.candidateTaskKeys.forEach(taskKey => {
      const taskIndex = openTasks.findIndex(task => task.key === taskKey);
      if (taskIndex < 0) return;
      const taskNode = taskStart + taskIndex;
      const randomCost = tg_seededInt_(
        seed,
        `${slot.student.id}|${slot.ordinal}|${taskKey}`,
        TG_BOT.randomMax + 1
      );
      const edge = tg_addFlowEdge_(graph, slotNode, taskNode, 1, randomCost, {
        student: slot.student,
        task: openTasks[taskIndex]
      });
      assignmentEdges.push(edge);
    });
  });
  openTasks.forEach((task, index) => {
    tg_addFlowEdge_(graph, taskStart + index, sink, 1, 0, null);
  });

  const flowResult = tg_minCostMaxFlow_(graph, source, sink);
  const byStudent = {};
  const assignedTaskKeys = [];
  assignmentEdges.forEach(edge => {
    if (edge.initialCap !== 1 || edge.cap !== 0 || !edge.meta) return;
    const student = edge.meta.student;
    const task = edge.meta.task;
    if (!byStudent[student.id]) {
      byStudent[student.id] = {
        id: student.id,
        name: student.name,
        telegram: student.telegram || '',
        semesterSolved: student.semesterSolved,
        tasks: []
      };
    }
    byStudent[student.id].tasks.push(task);
    assignedTaskKeys.push(task.key);
  });

  const assignments = Object.keys(byStudent).map(key => byStudent[key]);
  assignments.forEach(item => item.tasks.sort(tg_compareTasks_));
  assignments.sort((left, right) =>
    String(left.name).localeCompare(String(right.name), 'ru', { numeric: true })
  );
  const assignedSet = {};
  assignedTaskKeys.forEach(key => { assignedSet[key] = true; });
  const unmatchedTaskKeys = openTasks
    .filter(task => !assignedSet[task.key])
    .map(task => task.key);

  return {
    flow: flowResult.flow,
    cost: flowResult.cost,
    assignments,
    assignedTaskKeys,
    unmatchedTaskKeys
  };
}

function tg_addFlowEdge_(graph, from, to, capacity, cost, meta) {
  const forward = {
    to,
    rev: graph[to].length,
    cap: capacity,
    initialCap: capacity,
    cost,
    meta: meta || null
  };
  const reverse = {
    to: from,
    rev: graph[from].length,
    cap: 0,
    initialCap: 0,
    cost: -cost,
    meta: null
  };
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function tg_minCostMaxFlow_(graph, source, sink) {
  let flow = 0;
  let cost = 0;
  const nodeCount = graph.length;

  while (true) {
    const distance = Array(nodeCount).fill(Infinity);
    const previousNode = Array(nodeCount).fill(-1);
    const previousEdge = Array(nodeCount).fill(-1);
    const inQueue = Array(nodeCount).fill(false);
    const queue = [source];
    let head = 0;
    distance[source] = 0;
    inQueue[source] = true;

    while (head < queue.length) {
      const node = queue[head++];
      inQueue[node] = false;
      graph[node].forEach((edge, edgeIndex) => {
        if (edge.cap <= 0) return;
        const candidate = distance[node] + edge.cost;
        if (candidate >= distance[edge.to]) return;
        distance[edge.to] = candidate;
        previousNode[edge.to] = node;
        previousEdge[edge.to] = edgeIndex;
        if (!inQueue[edge.to]) {
          queue.push(edge.to);
          inQueue[edge.to] = true;
        }
      });
    }

    if (!isFinite(distance[sink])) break;
    let node = sink;
    while (node !== source) {
      const from = previousNode[node];
      const edge = graph[from][previousEdge[node]];
      edge.cap -= 1;
      graph[node][edge.rev].cap += 1;
      node = from;
    }
    flow += 1;
    cost += distance[sink];
  }
  return { flow, cost };
}

function tg_formatDistribution_(problem, result) {
  const lines = [
    `<b>Практика ${problem.practiceNo} — ${tg_escapeHtml_(problem.practitioner)}</b>`,
    ''
  ];
  if (!result.assignments.length) {
    lines.push('Новых назначений нет.');
  } else {
    result.assignments.forEach(item => {
      const person = item.telegram
        ? tg_escapeHtml_(item.telegram)
        : `${tg_escapeHtml_(item.name)} <i>(TG не указан)</i>`;
      const labels = item.tasks.map(task => tg_escapeHtml_(task.label));
      const noun = labels.length === 1 ? 'задача' : 'задачи';
      lines.push(`${person} — ${noun} ${labels.join(', ')}`);
    });
  }

  const alreadyCovered = problem.tasks.filter(task => task.covered).length;
  const coveredAfter = alreadyCovered + result.flow;
  lines.push('', `Назначено сейчас: <b>${result.flow}</b>`);
  lines.push(`Покрыто после распределения: <b>${coveredAfter} из ${problem.tasks.length}</b>`);

  const noCandidate = tg_tasksByKeys_(problem, problem.noCandidateTasks);
  const noCandidateSet = {};
  problem.noCandidateTasks.forEach(key => { noCandidateSet[key] = true; });
  const constrained = tg_tasksByKeys_(problem,
    result.unmatchedTaskKeys.filter(key => !noCandidateSet[key]));
  if (noCandidate.length) {
    lines.push(`Без подходящего кандидата: ${tg_escapeHtml_(noCandidate.join(', '))}`);
  }
  if (constrained.length) {
    lines.push(`Не хватило свободных выходов: ${tg_escapeHtml_(constrained.join(', '))}`);
  }

  const assignedWithoutTelegram = result.assignments
    .filter(item => !item.telegram)
    .map(item => item.name);
  const diagnosticLines = [];
  tg_pushDiagnostic_(diagnosticLines, 'Назначены без TG', assignedWithoutTelegram);
  tg_pushDiagnostic_(diagnosticLines, 'Не отмечены присутствующими', problem.diagnostics.absent);
  tg_pushDiagnostic_(diagnosticLines, 'Уже имеют два выхода', problem.diagnostics.full);
  tg_pushDiagnostic_(diagnosticLines, 'Прод = Нет', problem.diagnostics.inactive);
  tg_pushDiagnostic_(diagnosticLines, 'Не найдены в «Общий»', problem.diagnostics.missingCentral);
  tg_pushDiagnostic_(diagnosticLines, 'Числятся у другого практика', problem.diagnostics.wrongPractitioner);
  if (problem.diagnostics.missingPracticeSheets.length) {
    diagnosticLines.push(
      `Нет листов практик: ${problem.diagnostics.missingPracticeSheets.join(', ')} ` +
      '(семестровый приоритет посчитан по доступным листам)'
    );
  }
  if (diagnosticLines.length) {
    lines.push('', '<b>Проверка данных</b>');
    diagnosticLines.forEach(line => lines.push(tg_escapeHtml_(line)));
  }
  return tg_limitMessage_(lines);
}

function tg_pushDiagnostic_(target, title, values) {
  const unique = tg_uniqueStrings_(values || []);
  if (!unique.length) return;
  target.push(`${title}: ${unique.join(', ')}`);
}

function tg_tasksByKeys_(problem, keys) {
  const wanted = {};
  keys.forEach(key => { wanted[key] = true; });
  return problem.tasks.filter(task => wanted[task.key])
    .sort(tg_compareTasks_)
    .map(task => task.label);
}

function tg_limitMessage_(lines) {
  const accepted = [];
  for (let index = 0; index < lines.length; index++) {
    const candidate = accepted.concat([lines[index]]).join('\n');
    if (candidate.length > TG_BOT.maxMessageLength) {
      accepted.push('<i>Часть диагностики сокращена из-за ограничения Telegram.</i>');
      break;
    }
    accepted.push(lines[index]);
  }
  return accepted.join('\n');
}

function tg_problemFingerprint_(problem) {
  const compact = {
    practitionerNo: problem.practitionerNo,
    practiceNo: problem.practiceNo,
    tasks: problem.tasks.map(task => [task.key, task.covered]),
    students: problem.students.map(student => [
      student.id,
      student.existingOnes,
      student.slots,
      student.semesterSolved,
      student.candidateTaskKeys
    ])
  };
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(compact),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 20);
}

function tg_seededInt_(seed, key, modulo) {
  let hash = 2166136261;
  const text = String(seed) + '|' + String(key);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909);
  hash ^= hash >>> 16;
  return (hash >>> 0) % modulo;
}

function tg_compareTasks_(left, right) {
  return String(left.label).localeCompare(String(right.label), 'ru', { numeric: true });
}

function tg_reservePair_(practitionerNo, practiceNo, userId) {
  const key = TG_BOT.pairPrefix + practitionerNo + '_' + practiceNo;
  const token = Utilities.getUuid();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Система занята. Повторите через несколько секунд.');
  try {
    const properties = PropertiesService.getScriptProperties();
    const current = tg_parseJson_(properties.getProperty(key), null);
    if (current && Date.now() - Number(current.createdAt) < TG_BOT.pairReservationMs) {
      throw new Error(
        `Распределение для этой пары уже рассчитывается пользователем ${current.userId}.`
      );
    }
    properties.setProperty(key, JSON.stringify({ token, userId: String(userId), createdAt: Date.now() }));
  } finally {
    lock.releaseLock();
  }
  return { key, token };
}

function tg_releasePair_(practitionerNo, practiceNo, reservation) {
  if (!reservation) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const properties = PropertiesService.getScriptProperties();
    const current = tg_parseJson_(properties.getProperty(reservation.key), null);
    if (current && current.token === reservation.token) {
      properties.deleteProperty(reservation.key);
    }
  } finally {
    lock.releaseLock();
  }
}

function tg_saveNewDraft_(draft) {
  tg_cleanupDrafts_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Не удалось сохранить черновик: система занята.');
  try {
    tg_writeDraftUnsafe_(draft);
    PropertiesService.getScriptProperties()
      .setProperty(TG_BOT.lastDraftPrefix + draft.ownerId, draft.id);
  } finally {
    lock.releaseLock();
  }
}

function tg_writeDraftUnsafe_(draft) {
  const stored = Object.assign({}, draft);
  const text = String(stored.text || '');
  delete stored.text;
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += TG_BOT.draftTextChunkLength) {
    chunks.push(text.slice(offset, offset + TG_BOT.draftTextChunkLength));
  }
  if (!chunks.length) chunks.push('');
  stored.textChunkCount = chunks.length;
  const json = JSON.stringify(stored);
  const byteCount = Utilities.newBlob(json).getBytes().length;
  if (byteCount > 8500) {
    throw new Error('Метаданные черновика получились слишком большими для Script Properties.');
  }
  const properties = PropertiesService.getScriptProperties();
  const previous = tg_parseJson_(properties.getProperty(TG_BOT.draftPrefix + draft.id), null);
  const previousCount = previous ? Number(previous.textChunkCount) || 0 : 0;
  properties.setProperty(TG_BOT.draftPrefix + draft.id, json);
  chunks.forEach((chunk, index) => {
    properties.setProperty(TG_BOT.draftTextPrefix + draft.id + '_' + index, chunk);
  });
  for (let index = chunks.length; index < previousCount; index++) {
    properties.deleteProperty(TG_BOT.draftTextPrefix + draft.id + '_' + index);
  }
}

function tg_loadDraft_(draftId, allowExpired) {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(TG_BOT.draftPrefix + String(draftId || ''));
  const draft = tg_parseJson_(raw, null);
  if (!draft) return null;
  const chunkCount = Number(draft.textChunkCount) || 0;
  if (chunkCount) {
    const properties = PropertiesService.getScriptProperties();
    const chunks = [];
    for (let index = 0; index < chunkCount; index++) {
      const chunk = properties.getProperty(TG_BOT.draftTextPrefix + draft.id + '_' + index);
      if (chunk == null) return null;
      chunks.push(chunk);
    }
    draft.text = chunks.join('');
  } else {
    draft.text = String(draft.text || '');
  }
  if (!allowExpired && Date.now() - Number(draft.createdAt) > TG_BOT.draftTtlMs) {
    return null;
  }
  return draft;
}

function tg_getLastDraftForUser_(userId) {
  const properties = PropertiesService.getScriptProperties();
  const draftId = properties.getProperty(TG_BOT.lastDraftPrefix + String(userId));
  if (!draftId) return null;
  const draft = tg_loadDraft_(draftId, false);
  if (!draft || String(draft.ownerId) !== String(userId) ||
      ['cancelled', 'superseded'].indexOf(draft.status) >= 0) return null;
  if (draft.status === 'publishing' &&
      Date.now() - Number(draft.actionAt || 0) > TG_BOT.publishingTimeoutMs) {
    draft.status = 'draft';
    tg_finishDraftAction_(draft.id, 'draft');
  }
  return draft;
}

function tg_lockDraftForAction_(draftId, userId, nextStatus) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Система занята. Повторите через несколько секунд.');
  try {
    const draft = tg_loadDraft_(draftId, false);
    if (!draft) throw new Error('Черновик не найден или уже устарел.');
    if (!tg_canManageDraft_(draft, userId)) throw new Error('Это черновик другого практика.');
    if (draft.status === 'published') throw new Error('Этот черновик уже опубликован.');
    if (draft.status === 'cancelled') throw new Error('Этот черновик отменён.');
    if (draft.status === 'superseded') throw new Error('Этот черновик уже был пересчитан.');
    if (draft.status === 'publishing' || draft.status === 'rerolling') {
      const stale = Date.now() - Number(draft.actionAt || 0) > TG_BOT.publishingTimeoutMs;
      if (!stale) throw new Error('Операция с этим черновиком уже выполняется.');
    }
    draft.status = nextStatus;
    draft.actionAt = Date.now();
    tg_writeDraftUnsafe_(draft);
    return draft;
  } finally {
    lock.releaseLock();
  }
}

function tg_finishDraftAction_(draftId, status) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Не удалось обновить статус черновика.');
  try {
    const draft = tg_loadDraft_(draftId, true);
    if (!draft) return;
    draft.status = status;
    draft.actionAt = Date.now();
    tg_writeDraftUnsafe_(draft);
  } finally {
    lock.releaseLock();
  }
}

function tg_cleanupDrafts_() {
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  const expired = [];
  const liveDraftIds = {};
  Object.keys(all).forEach(key => {
    if (key.indexOf(TG_BOT.draftPrefix) !== 0 ||
        key.indexOf(TG_BOT.draftTextPrefix) === 0) return;
    const draft = tg_parseJson_(all[key], null);
    if (!draft || Date.now() - Number(draft.createdAt) > TG_BOT.draftTtlMs) {
      expired.push(key);
    } else {
      liveDraftIds[String(draft.id)] = true;
    }
  });
  expired.forEach(key => {
    const draftId = key.slice(TG_BOT.draftPrefix.length);
    properties.deleteProperty(key);
    Object.keys(all).forEach(candidate => {
      if (candidate.indexOf(TG_BOT.draftTextPrefix + draftId + '_') === 0) {
        properties.deleteProperty(candidate);
      }
    });
  });
  Object.keys(all).forEach(key => {
    if (key.indexOf(TG_BOT.draftTextPrefix) !== 0) return;
    const remainder = key.slice(TG_BOT.draftTextPrefix.length);
    const separator = remainder.lastIndexOf('_');
    const draftId = separator >= 0 ? remainder.slice(0, separator) : '';
    if (draftId && !liveDraftIds[draftId] &&
        expired.indexOf(TG_BOT.draftPrefix + draftId) < 0) {
      properties.deleteProperty(key);
    }
  });
}

function tg_canManageDraft_(draft, userId) {
  return String(draft.ownerId) === String(userId) || tg_isAdminUser_(userId);
}

function tg_newDraftId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function tg_getConfig_(requireAll) {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    token: tg_cleanText_(properties.getProperty('TELEGRAM_BOT_TOKEN')),
    webhookSecret: tg_cleanText_(properties.getProperty('TELEGRAM_WEBHOOK_SECRET')),
    allowedUserIds: tg_parseIdList_(properties.getProperty('ALLOWED_USER_IDS')),
    adminUserIds: tg_parseIdList_(properties.getProperty('ADMIN_USER_IDS')),
    targetChatIds: tg_parseObject_(properties.getProperty('TARGET_CHAT_IDS')),
    webAppUrl: tg_cleanText_(properties.getProperty('TELEGRAM_WEB_APP_URL'))
  };
  if (!config.token) throw new Error('Не задан TELEGRAM_BOT_TOKEN.');
  if (requireAll) {
    if (!config.webhookSecret) throw new Error('Не задан TELEGRAM_WEBHOOK_SECRET.');
    if (!config.allowedUserIds.length) throw new Error('Не задан ALLOWED_USER_IDS.');
    if (!Object.keys(config.targetChatIds).length) throw new Error('Не задан TARGET_CHAT_IDS.');
  }
  return config;
}

function tg_hasValidWebhookSecret_(e) {
  const expected = tg_cleanText_(PropertiesService.getScriptProperties()
    .getProperty('TELEGRAM_WEBHOOK_SECRET'));
  const received = tg_cleanText_(e && e.parameter ? e.parameter.secret : '');
  return !!expected && expected === received;
}

function tg_targetChatId_(practitionerNo) {
  const config = tg_getConfig_(true);
  const value = config.targetChatIds[String(practitionerNo)];
  if (value == null || tg_cleanText_(value) === '') {
    throw new Error(`В TARGET_CHAT_IDS нет чата для таблицы ${practitionerNo}.`);
  }
  return String(value);
}

function tg_isAllowedUser_(userId) {
  const config = tg_getConfig_(false);
  return config.allowedUserIds.indexOf(String(userId)) >= 0 ||
    config.adminUserIds.indexOf(String(userId)) >= 0;
}

function tg_isAdminUser_(userId) {
  return tg_getConfig_(false).adminUserIds.indexOf(String(userId)) >= 0;
}

function tg_parseIdList_(raw) {
  const text = tg_cleanText_(raw);
  if (!text) return [];
  const parsed = tg_parseJson_(text, null);
  const values = Array.isArray(parsed) ? parsed : text.split(/[\s,;]+/);
  return tg_uniqueStrings_(values.map(value => String(value).trim()).filter(Boolean));
}

function tg_parseObject_(raw) {
  const parsed = tg_parseJson_(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function tg_parseJson_(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function tg_api_(method, payload) {
  const token = tg_cleanText_(PropertiesService.getScriptProperties()
    .getProperty('TELEGRAM_BOT_TOKEN'));
  if (!token) throw new Error('Не задан TELEGRAM_BOT_TOKEN.');
  const response = UrlFetchApp.fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    }
  );
  const status = response.getResponseCode();
  const body = response.getContentText();
  const parsed = tg_parseJson_(body, null);
  if (status < 200 || status >= 300 || !parsed || !parsed.ok) {
    const description = parsed && parsed.description
      ? parsed.description : `HTTP ${status}`;
    throw new Error(`Telegram API (${method}): ${description}`);
  }
  return parsed.result;
}

function tg_sendMessage_(chatId, text, keyboard) {
  const payload = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_notification: false
  };
  if (keyboard) payload.reply_markup = keyboard;
  return tg_api_('sendMessage', payload);
}

function tg_editMessage_(chatId, messageId, text, keyboard) {
  try {
    return tg_api_('editMessageText', {
      chat_id: String(chatId),
      message_id: Number(messageId),
      text: String(text),
      parse_mode: 'HTML',
      reply_markup: keyboard || { inline_keyboard: [] }
    });
  } catch (error) {
    if (String(error.message).toLowerCase().indexOf('message is not modified') >= 0) return null;
    throw error;
  }
}

function tg_clearInlineKeyboard_(chatId, messageId) {
  try {
    tg_api_('editMessageReplyMarkup', {
      chat_id: String(chatId),
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] }
    });
  } catch (error) {
    if (String(error.message).toLowerCase().indexOf('message is not modified') < 0) throw error;
  }
}

function tg_answerCallback_(callbackId, text) {
  if (!callbackId) return;
  try {
    tg_api_('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: text || '',
      show_alert: false
    });
  } catch (error) {
    console.warn(error);
  }
}

function tg_reportUpdateError_(update, error) {
  if (!update) return;
  const message = error && error.message ? error.message : 'Неизвестная ошибка.';
  let chatId = '';
  if (update.message && update.message.chat) chatId = String(update.message.chat.id);
  if (!chatId && update.callback_query && update.callback_query.from) {
    chatId = String(update.callback_query.from.id);
  }
  if (!chatId) return;
  try {
    tg_sendMessage_(chatId, `⚠️ ${tg_escapeHtml_(message)}`);
  } catch (nestedError) {
    console.error(nestedError);
  }
}

function tg_isDuplicateUpdate_(updateId) {
  const cache = CacheService.getScriptCache();
  const key = TG_BOT.updatePrefix + String(updateId);
  if (cache.get(key)) return true;
  cache.put(key, '1', TG_BOT.updateCacheSeconds);
  return false;
}

function tg_findHeader_(headers, aliases, required) {
  const normalized = headers.map(value => tg_nameKey_(value));
  for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
    const wanted = tg_nameKey_(aliases[aliasIndex]);
    const index = normalized.indexOf(wanted);
    if (index >= 0) return index;
  }
  if (required) throw new Error(`Не найден столбец «${aliases[0]}».`);
  return -1;
}

function tg_practitionerByNumber_(number) {
  const parsed = Number(number);
  if (!tg_isIntegerInRange_(parsed, 1, DM.practitioners.length)) {
    throw new Error('Номер таблицы должен быть от 1 до 3.');
  }
  return DM.practitioners[parsed - 1];
}

function tg_isIntegerInRange_(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function tg_marker_(value) {
  return tg_cleanText_(value).replace(/^'/, '');
}

function tg_cleanText_(value) {
  return String(value == null ? '' : value).trim();
}

function tg_nameKey_(value) {
  return tg_cleanText_(value).replace(/\s+/g, ' ').toLowerCase();
}

function tg_taskKey_(value) {
  const text = tg_cleanText_(value);
  const numeric = Number(text.replace(',', '.'));
  if (text && !isNaN(numeric)) return 'n:' + String(numeric);
  return 's:' + tg_nameKey_(text);
}

function tg_normalizeTelegram_(value) {
  let text = tg_cleanText_(value).replace(/^'/, '');
  text = text.replace(/^https?:\/\/(?:www\.)?t\.me\//i, '');
  text = text.replace(/^@+/, '').replace(/\/$/, '');
  return text ? '@' + text : '';
}

function tg_isActiveValue_(value) {
  const text = tg_nameKey_(value);
  return !text || ['нет', 'no', 'n', 'false', '0'].indexOf(text) < 0;
}

function tg_isYes_(value) {
  return ['да', 'yes', 'y', '1', 'true'].indexOf(tg_nameKey_(value)) >= 0;
}

function tg_escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tg_uniqueStrings_(values) {
  const seen = {};
  const result = [];
  (values || []).forEach(value => {
    const text = tg_cleanText_(value);
    const key = tg_nameKey_(text);
    if (!text || seen[key]) return;
    seen[key] = true;
    result.push(text);
  });
  return result;
}

function tg_httpText_(text) {
  // ContentService отвечает через 302-redirect на script.googleusercontent.com.
  // Telegram webhook принимает только 2xx, поэтому возвращаем HtmlOutput.
  return HtmlService.createHtmlOutput(String(text));
}

function tg_toast_(message) {
  try {
    SpreadsheetApp.getActive().toast(message);
  } catch (error) {
    console.log(message);
  }
}
