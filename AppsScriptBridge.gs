/**
 * Read-only API-мост между серверным Telegram-ботом и ДМсистемой.
 * Добавьте этот файл в тот же Apps Script-проект, где находится Code.gs.
 * Старый TelegramBot.gs из Apps Script удалите: Telegram теперь работает через long polling.
 */

const BOT_BRIDGE = {
  secretProperty: 'BOT_BRIDGE_SECRET',
  maxClockSkewSeconds: 300,
  nonceTtlSeconds: 600
};

function telegramMenu_(ui) {
  return ui.createMenu('Telegram-бот')
    .addItem('Проверить API-мост', 'telegramBridgeTest');
}

function telegramBridgeTest() {
  bridge_validateSecret_();
  validateConfig_();
  const problem = bridge_readDistributionProblem_(1, 1);
  const result = {
    central: SpreadsheetApp.openById(getCentralId_()).getName(),
    practitioner: problem.practitioner,
    practice: problem.practiceNo,
    tasks: problem.tasks.length,
    eligibleStudents: problem.students.length
  };
  console.log(JSON.stringify(result, null, 2));
  SpreadsheetApp.getActive().toast('API-мост работает. Результат записан в журнал выполнения.');
  return result;
}

function doGet(e) {
  try {
    bridge_authorize_(e && e.parameter ? e.parameter : {});
    const parameters = e.parameter;
    if (parameters.action !== 'problem') throw new Error('Неизвестное действие API.');
    const practitionerNo = bridge_integer_(parameters.practitioner, 1, DM.practitioners.length, 'Практик');
    const practiceNo = bridge_integer_(parameters.practice, 1, DM.practiceCount, 'Практика');
    return bridge_json_({
      ok: true,
      problem: bridge_readDistributionProblem_(practitionerNo, practiceNo)
    });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return bridge_json_({ ok: false, error: String(error && error.message || error) });
  }
}

function bridge_authorize_(parameters) {
  const secret = bridge_validateSecret_();
  const timestamp = bridge_integer_(parameters.ts, 1, 9999999999, 'Время запроса');
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > BOT_BRIDGE.maxClockSkewSeconds) {
    throw new Error('Запрос просрочен. Проверьте время на сервере бота.');
  }
  const nonce = String(parameters.nonce || '');
  if (!/^[a-f0-9]{24,64}$/i.test(nonce)) throw new Error('Некорректный nonce.');
  const action = String(parameters.action || '');
  const practitioner = String(parameters.practitioner || '');
  const practice = String(parameters.practice || '');
  const canonical = [String(timestamp), nonce, action, practitioner, practice].join('\n');
  const expected = bridge_hmacHex_(canonical, secret);
  const received = String(parameters.signature || '').toLowerCase();
  if (!bridge_constantTimeEqual_(expected, received)) throw new Error('Неверная подпись запроса.');

  const cache = CacheService.getScriptCache();
  const nonceKey = 'BOT_BRIDGE_NONCE_' + nonce;
  if (cache.get(nonceKey)) throw new Error('Повторный запрос отклонён.');
  cache.put(nonceKey, '1', BOT_BRIDGE.nonceTtlSeconds);
}

function bridge_validateSecret_() {
  const secret = String(PropertiesService.getScriptProperties()
    .getProperty(BOT_BRIDGE.secretProperty) || '').trim();
  if (secret.length < 32) {
    throw new Error('Задайте BOT_BRIDGE_SECRET длиной не менее 32 символов в Script Properties.');
  }
  return secret;
}

function bridge_hmacHex_(text, secret) {
  return Utilities.computeHmacSha256Signature(text, secret)
    .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); })
    .join('');
}

function bridge_constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bridge_json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function bridge_integer_(value, minimum, maximum, title) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(title + ': ожидалось целое число от ' + minimum + ' до ' + maximum + '.');
  }
  return number;
}

function bridge_readDistributionProblem_(practitionerNo, practiceNo) {
  validateConfig_();
  const practitioner = DM.practitioners[practitionerNo - 1];
  const central = SpreadsheetApp.openById(getCentralId_());
  const common = central.getSheetByName(DM.common);
  if (!common) throw new Error('Не найден лист «' + DM.common + '».');

  const commonHeaderRow = DM.commonFirstRow - 1;
  const commonWidth = Math.max(14, Math.min(common.getLastColumn(), 50));
  const commonHeaders = common.getRange(commonHeaderRow, 1, 1, commonWidth).getDisplayValues()[0];
  const commonColumns = {
    name: bridge_findHeader_(commonHeaders, ['ФИО']),
    practitioner: bridge_findHeader_(commonHeaders, ['Практик']),
    telegram: bridge_findHeader_(commonHeaders, ['TG', 'Telegram', 'Телеграм']),
    active: bridge_findHeader_(commonHeaders, ['Прод', 'Активен'])
  };
  const commonRows = common.getRange(
    DM.commonFirstRow, 1, DM.commonLastRow - DM.commonFirstRow + 1, commonWidth
  ).getDisplayValues();
  const centralByName = {};
  const telegramOwners = {};
  commonRows.forEach(function(row) {
    const name = bridge_clean_(row[commonColumns.name]);
    if (!name) return;
    const key = bridge_nameKey_(name);
    if (centralByName[key]) throw new Error('В листе «' + DM.common + '» два студента с ФИО «' + name + '».');
    const telegram = bridge_normalizeTelegram_(row[commonColumns.telegram]);
    const telegramKey = telegram.toLowerCase();
    if (telegram && telegramOwners[telegramKey]) {
      throw new Error('Telegram ' + telegram + ' указан одновременно у «' + telegramOwners[telegramKey] + '» и «' + name + '».');
    }
    if (telegram) telegramOwners[telegramKey] = name;
    centralByName[key] = {
      name: name,
      practitioner: bridge_clean_(row[commonColumns.practitioner]),
      telegram: telegram,
      active: bridge_isActive_(row[commonColumns.active])
    };
  });

  const fileId = DM.plusFileIds[practitioner];
  if (!fileId) throw new Error('Не указан ID файла практика ' + practitioner + '.');
  const plusFile = SpreadsheetApp.openById(fileId);
  const layout = plusLayout_(practitioner, practiceNo);
  const semesterSolved = {};
  const missingPracticeSheets = [];
  let selectedSnapshot = null;

  for (let number = 1; number <= DM.practiceCount; number++) {
    const practiceLayout = plusLayout_(practitioner, number);
    const sheet = plusFile.getSheetByName('Практика ' + number);
    if (!sheet) {
      missingPracticeSheets.push(number);
      continue;
    }
    assertPracticeTaskLayout_(sheet, practiceLayout, number);
    const block = sheet.getRange(
      DM.plusHeaderRow, 1, DM.studentsPerGroup + 1, practiceLayout.taskLastCol
    ).getDisplayValues();
    const headers = block[0].slice(practiceLayout.taskFirstCol - 1, practiceLayout.taskLastCol);
    const rows = block.slice(1);
    const seenNames = {};
    const enabledOffsets = [];
    headers.forEach(function(header, offset) {
      if (bridge_clean_(header)) enabledOffsets.push(offset);
    });
    rows.forEach(function(row) {
      const name = bridge_clean_(row[0]);
      if (!name) return;
      const key = bridge_nameKey_(name);
      if (seenNames[key]) throw new Error('На листе «Практика ' + number + '» дважды встречается ФИО «' + name + '».');
      seenNames[key] = true;
      let solved = 0;
      enabledOffsets.forEach(function(offset) {
        const marker = bridge_marker_(row[practiceLayout.taskFirstCol - 1 + offset]);
        if (marker === '+' || marker === '1') solved++;
      });
      semesterSolved[key] = (semesterSolved[key] || 0) + solved;
    });
    if (number === practiceNo) selectedSnapshot = { headers: headers, rows: rows };
  }
  if (!selectedSnapshot) throw new Error('В файле ' + practitioner + ' нет листа «Практика ' + practiceNo + '».');

  const tasks = [];
  const taskByKey = {};
  selectedSnapshot.headers.forEach(function(rawLabel, offset) {
    const label = bridge_clean_(rawLabel);
    if (!label) return;
    const key = bridge_taskKey_(label);
    if (taskByKey[key]) throw new Error('В шапке практики повторяется задача «' + label + '».');
    const task = { key: key, label: label, offset: offset, covered: false };
    tasks.push(task);
    taskByKey[key] = task;
  });
  if (!tasks.length) throw new Error('В выбранной практике нет заголовков задач.');
  selectedSnapshot.rows.forEach(function(row) {
    if (!bridge_clean_(row[0])) return;
    tasks.forEach(function(task) {
      if (bridge_marker_(row[layout.taskFirstCol - 1 + task.offset]) === '1') task.covered = true;
    });
  });

  const diagnostics = {
    missingCentral: [], wrongPractitioner: [], inactive: [], absent: [], full: [],
    missingPracticeSheets: missingPracticeSheets
  };
  const students = [];
  const requiresPresence = practitioner !== 'Рами';
  selectedSnapshot.rows.forEach(function(row, order) {
    const sheetName = bridge_clean_(row[0]);
    if (!sheetName) return;
    const key = bridge_nameKey_(sheetName);
    const centralStudent = centralByName[key];
    if (!centralStudent) { diagnostics.missingCentral.push(sheetName); return; }
    if (bridge_nameKey_(centralStudent.practitioner) !== bridge_nameKey_(practitioner)) {
      diagnostics.wrongPractitioner.push(centralStudent.name); return;
    }
    if (!centralStudent.active) { diagnostics.inactive.push(centralStudent.name); return; }
    if (requiresPresence && !bridge_isYes_(row[layout.presenceCol - 1])) {
      diagnostics.absent.push(centralStudent.name); return;
    }
    let existingOnes = 0;
    const candidateTaskKeys = [];
    tasks.forEach(function(task) {
      const marker = bridge_marker_(row[layout.taskFirstCol - 1 + task.offset]);
      if (marker === '1') existingOnes++;
      if (marker === '+' && !task.covered) candidateTaskKeys.push(task.key);
    });
    if (existingOnes > 2) {
      throw new Error('У студента «' + centralStudent.name + '» уже ' + existingOnes + ' единицы на практике ' + practiceNo + '.');
    }
    const slots = Math.max(0, 2 - existingOnes);
    if (!slots) diagnostics.full.push(centralStudent.name);
    students.push({
      id: key, name: centralStudent.name, telegram: centralStudent.telegram,
      order: order, existingOnes: existingOnes, slots: slots,
      semesterSolved: semesterSolved[key] || 0, candidateTaskKeys: candidateTaskKeys
    });
  });

  const candidateKeys = {};
  students.forEach(function(student) {
    if (!student.slots) return;
    student.candidateTaskKeys.forEach(function(key) { candidateKeys[key] = true; });
  });
  const noCandidateTasks = tasks.filter(function(task) {
    return !task.covered && !candidateKeys[task.key];
  }).map(function(task) { return task.key; });
  return {
    practitionerNo: practitionerNo, practitioner: practitioner, practiceNo: practiceNo,
    tasks: tasks, students: students, noCandidateTasks: noCandidateTasks, diagnostics: diagnostics
  };
}

function bridge_findHeader_(headers, aliases) {
  const normalized = headers.map(bridge_nameKey_);
  for (let index = 0; index < aliases.length; index++) {
    const found = normalized.indexOf(bridge_nameKey_(aliases[index]));
    if (found >= 0) return found;
  }
  throw new Error('Не найден столбец «' + aliases[0] + '».');
}

function bridge_clean_(value) { return String(value == null ? '' : value).trim(); }
function bridge_nameKey_(value) { return bridge_clean_(value).replace(/\s+/g, ' ').toLowerCase(); }
function bridge_marker_(value) { return bridge_clean_(value).replace(/^'/, ''); }
function bridge_taskKey_(value) {
  const text = bridge_clean_(value);
  const numeric = Number(text.replace(',', '.'));
  return text && !isNaN(numeric) ? 'n:' + String(numeric) : 's:' + bridge_nameKey_(text);
}
function bridge_normalizeTelegram_(value) {
  let text = bridge_clean_(value).replace(/^'/, '');
  text = text.replace(/^https?:\/\/(?:www\.)?t\.me\//i, '').replace(/^@+/, '').replace(/\/$/, '');
  return text ? '@' + text : '';
}
function bridge_isActive_(value) {
  const text = bridge_nameKey_(value);
  return !text || ['нет', 'no', 'n', 'false', '0'].indexOf(text) < 0;
}
function bridge_isYes_(value) {
  return ['да', 'yes', 'y', '1', 'true'].indexOf(bridge_nameKey_(value)) >= 0;
}
