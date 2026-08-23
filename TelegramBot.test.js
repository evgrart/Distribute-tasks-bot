'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'TelegramBot.gs'), 'utf8');
const systemCandidates = [
  process.env.DM_CODE_GS,
  path.join(__dirname, '..', 'Advanced-Discrete-Math-2026', 'Sheet', 'Code.gs')
].filter(Boolean);
const systemPath = systemCandidates.find(candidate => fs.existsSync(candidate));

// Apps Script объединяет все .gs-файлы в один проект. Если основной
// репозиторий лежит рядом (или в CI задан DM_CODE_GS), дополнительно проверяем общий синтаксис.
const syntaxSource = systemPath
  ? `${fs.readFileSync(systemPath, 'utf8')}\n${source}`
  : source;
new vm.Script(syntaxSource, { filename: systemPath ? 'CombinedAppsScript.gs' : 'TelegramBot.gs' });
const context = { console };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'TelegramBot.gs' });

const calculate = context.tg_calculateDistribution_;

function task(number, covered = false) {
  return { key: `t${number}`, label: String(number), covered };
}

function student(name, candidates, options = {}) {
  return {
    id: name.toLowerCase(),
    name,
    telegram: '',
    existingOnes: options.existingOnes || 0,
    slots: options.slots == null ? 2 : options.slots,
    semesterSolved: options.semesterSolved || 0,
    candidateTaskKeys: candidates.map(number => `t${number}`)
  };
}

function problem(tasks, students) {
  return {
    tasks,
    students,
    noCandidateTasks: [],
    diagnostics: {
      missingCentral: [],
      wrongPractitioner: [],
      inactive: [],
      absent: [],
      full: [],
      missingPracticeSheets: []
    }
  };
}

function assignmentsByName(result) {
  const output = {};
  result.assignments.forEach(item => {
    output[item.name] = Array.from(item.tasks, itemTask => itemTask.label).sort();
  });
  return output;
}

function assertValid(result, input) {
  const seenTasks = new Set();
  const students = new Map(input.students.map(item => [item.id, item]));
  result.assignments.forEach(assignment => {
    const sourceStudent = students.get(assignment.id);
    assert(sourceStudent, `unknown student ${assignment.id}`);
    assert(assignment.tasks.length <= sourceStudent.slots, 'student capacity exceeded');
    assignment.tasks.forEach(assignedTask => {
      assert(!seenTasks.has(assignedTask.key), 'task assigned twice');
      seenTasks.add(assignedTask.key);
      assert(sourceStudent.candidateTaskKeys.includes(assignedTask.key), 'assignment without plus');
    });
  });
  assert.strictEqual(seenTasks.size, result.flow, 'flow and assignments differ');
}

function bruteMaximumCoverage(input) {
  const openTasks = input.tasks.filter(item => !item.covered);
  const capacities = input.students.map(item => item.slots);
  let best = 0;

  function visit(taskIndex, covered) {
    if (taskIndex === openTasks.length) {
      best = Math.max(best, covered);
      return;
    }
    if (covered + openTasks.length - taskIndex <= best) return;
    visit(taskIndex + 1, covered);
    input.students.forEach((item, studentIndex) => {
      if (capacities[studentIndex] <= 0) return;
      if (!item.candidateTaskKeys.includes(openTasks[taskIndex].key)) return;
      capacities[studentIndex]--;
      visit(taskIndex + 1, covered + 1);
      capacities[studentIndex]++;
    });
  }

  visit(0, 0);
  return best;
}

// Базовое покрытие трёх задач тремя студентами.
{
  const input = problem(
    [task(1), task(2), task(3)],
    [student('Анна', [1, 2]), student('Борис', [2, 3]), student('Вера', [3])]
  );
  const result = calculate(input, 'basic');
  assert.strictEqual(result.flow, 3);
  assertValid(result, input);
}

// Ловушка для последовательного жадного алгоритма: задача 2 доступна только A.
{
  const input = problem(
    [task(1), task(2)],
    [
      student('A', [1, 2], { slots: 1 }),
      student('B', [1], { slots: 1 })
    ]
  );
  const result = calculate(input, 'greedy-trap');
  assert.strictEqual(result.flow, 2);
  const mapping = assignmentsByName(result);
  assert.deepStrictEqual(mapping.A, ['2']);
  assert.deepStrictEqual(mapping.B, ['1']);
}

// При том же покрытии сначала вовлекаются разные студенты.
{
  const input = problem(
    [task(1), task(2)],
    [student('A', [1, 2]), student('B', [2])]
  );
  const result = calculate(input, 'involvement');
  assert.strictEqual(result.flow, 2);
  assert.strictEqual(result.assignments.length, 2);
}

// Среди двух кандидатов получает задачу тот, у кого меньше решений за семестр.
{
  const input = problem(
    [task(1)],
    [
      student('Мало', [1], { semesterSolved: 3 }),
      student('Много', [1], { semesterSolved: 30 })
    ]
  );
  const result = calculate(input, 'semester-priority');
  assert.strictEqual(result.assignments.length, 1);
  assert.strictEqual(result.assignments[0].name, 'Мало');
}

// Уже имеющаяся единица делает оставшийся выход вторым: новый студент приоритетнее.
{
  const input = problem(
    [task(1)],
    [
      student('Уже выходил', [1], { existingOnes: 1, slots: 1, semesterSolved: 0 }),
      student('Ещё не выходил', [1], { slots: 2, semesterSolved: 50 })
    ]
  );
  const result = calculate(input, 'existing-one');
  assert.strictEqual(result.assignments[0].name, 'Ещё не выходил');
}

// Покрытая единицей задача не назначается повторно.
{
  const input = problem(
    [task(1, true), task(2)],
    [student('A', [1, 2])]
  );
  const result = calculate(input, 'covered');
  assert.strictEqual(result.flow, 1);
  assert.deepStrictEqual(Array.from(result.assignedTaskKeys), ['t2']);
}

// Один и тот же seed даёт один и тот же результат.
{
  const input = problem(
    [task(1), task(2), task(3)],
    [student('A', [1, 2, 3]), student('B', [1, 2, 3])]
  );
  const left = calculate(input, 'stable-seed');
  const right = calculate(input, 'stable-seed');
  assert.deepStrictEqual(assignmentsByName(left), assignmentsByName(right));
}

// Случайные малые графы сравниваются с полным перебором по покрытию.
let randomState = 0x51f15e;
function random() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
}

for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
  const taskCount = 1 + Math.floor(random() * 6);
  const studentCount = 1 + Math.floor(random() * 5);
  const inputTasks = Array.from({ length: taskCount }, (_, index) => task(index + 1));
  const inputStudents = [];
  for (let studentIndex = 0; studentIndex < studentCount; studentIndex++) {
    const candidates = [];
    for (let taskIndex = 1; taskIndex <= taskCount; taskIndex++) {
      if (random() < 0.48) candidates.push(taskIndex);
    }
    inputStudents.push(student(`S${studentIndex + 1}`, candidates, {
      slots: random() < 0.35 ? 1 : 2,
      semesterSolved: Math.floor(random() * 40)
    }));
  }
  const input = problem(inputTasks, inputStudents);
  const expected = bruteMaximumCoverage(input);
  const result = calculate(input, `random-${caseIndex}`);
  assert.strictEqual(result.flow, expected, `coverage mismatch in case ${caseIndex}`);
  assertValid(result, input);
}

// Нормализация пользовательских значений.
assert.strictEqual(context.tg_marker_("'+"), '+');
assert.strictEqual(context.tg_marker_('+'), '+');
assert.strictEqual(context.tg_normalizeTelegram_('https://t.me/student_name'), '@student_name');
assert.strictEqual(context.tg_normalizeTelegram_('@student_name'), '@student_name');
assert.strictEqual(context.tg_taskKey_('2.0'), context.tg_taskKey_('2'));

// Интеграционный тест чтения центральной таблицы и двух разных макетов плюсовиков.
class MockRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getDisplayValues() {
    const output = [];
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset++) {
      const outputRow = [];
      for (let colOffset = 0; colOffset < this.columnCount; colOffset++) {
        const sourceRow = this.sheet.values[this.row - 1 + rowOffset] || [];
        const value = sourceRow[this.column - 1 + colOffset];
        outputRow.push(value == null ? '' : String(value));
      }
      output.push(outputRow);
    }
    return output;
  }
}

class MockSheet {
  constructor(name, values) {
    this.name = name;
    this.values = values;
  }

  getName() {
    return this.name;
  }

  getLastColumn() {
    return this.values.reduce((best, row) => Math.max(best, row.length), 0);
  }

  getRange(row, column, rowCount, columnCount) {
    return new MockRange(this, row, column, rowCount, columnCount);
  }
}

class MockFile {
  constructor(name, sheets) {
    this.name = name;
    this.sheets = sheets;
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }
}

function emptyMatrix(rows, columns) {
  return Array.from({ length: rows }, () => Array(columns).fill(''));
}

function makePracticeSheet(practitioner, practiceNo) {
  const hasPresence = practitioner !== 'Рами';
  const taskFirstIndex = hasPresence ? 5 : 4;
  const values = emptyMatrix(33, hasPresence ? 35 : 34);
  values[2][0] = 'ФИО';
  if (hasPresence) values[2][1] = 'Присутствие';
  for (let taskIndex = 0; taskIndex < 3; taskIndex++) {
    values[2][taskFirstIndex + taskIndex] = String(taskIndex + 1);
  }
  return new MockSheet(`Практика ${practiceNo}`, values);
}

{
  const commonValues = emptyMatrix(93, 14);
  ['ФИО', 'Практик', 'TG', 'Прод'].forEach((header, index) => {
    commonValues[2][index] = header;
  });
  commonValues[3].splice(0, 4, 'Анна', 'Артём', '@anna', 'Да');
  commonValues[4].splice(0, 4, 'Борис', 'Артём', 'boris', 'Да');
  commonValues[5].splice(0, 4, 'Нет на паре', 'Артём', '@absent', 'Да');
  commonValues[6].splice(0, 4, 'Неактивный', 'Артём', '@inactive', 'Нет');
  commonValues[7].splice(0, 4, 'Рами Студент', 'Рами', '@rami_student', 'Да');
  const common = new MockSheet('Общий', commonValues);

  const files = { central: new MockFile('ДМобщее', { Общий: common }) };
  ['Артём', 'Рами', 'Немат'].forEach(practitioner => {
    const sheets = {};
    for (let practiceNo = 1; practiceNo <= 15; practiceNo++) {
      sheets[`Практика ${practiceNo}`] = makePracticeSheet(practitioner, practiceNo);
    }
    files[practitioner] = new MockFile(`ДМ${practitioner}`, sheets);
  });

  // Артём, практика 1: задача 2 уже покрыта единицей Бориса.
  const artem1 = files['Артём'].getSheetByName('Практика 1').values;
  artem1[3][0] = 'Анна';
  artem1[3][1] = 'Да';
  artem1[3][5] = '+';
  artem1[3][6] = '+';
  artem1[4][0] = 'Борис';
  artem1[4][1] = 'Да';
  artem1[4][6] = '1';
  artem1[4][7] = '+';
  artem1[5][0] = 'Нет на паре';
  artem1[5][1] = 'Нет';
  artem1[5][5] = '+';
  artem1[6][0] = 'Неактивный';
  artem1[6][1] = 'Да';
  artem1[6][5] = '+';

  // Ещё одно семестровое решение Анны на практике 2.
  const artem2 = files['Артём'].getSheetByName('Практика 2').values;
  artem2[3][0] = 'Анна';
  artem2[3][1] = 'Да';
  artem2[3][5] = '+';

  // У Рами нет столбца посещения, студент всё равно допускается по плюсу.
  const rami1 = files['Рами'].getSheetByName('Практика 1').values;
  rami1[3][0] = 'Рами Студент';
  rami1[3][4] = '+';

  context.DM = {
    centralFileId: 'central',
    plusFileIds: { 'Артём': 'Артём', 'Рами': 'Рами', 'Немат': 'Немат' },
    practitioners: ['Артём', 'Рами', 'Немат'],
    common: 'Общий',
    practiceCount: 15,
    studentsPerGroup: 30,
    plusHeaderRow: 3,
    plusFirstRow: 4,
    plusCoefficientCol: 4,
    plusTotalCol: 5,
    taskFirstCol: 6,
    taskLastCol: 35,
    commonFirstRow: 4,
    commonLastRow: 93
  };
  context.validateConfig_ = () => {};
  context.getCentralId_ = () => 'central';
  context.plusLayout_ = practitioner => practitioner === 'Рами'
    ? { presenceCol: 0, coefficientCol: 3, totalCol: 4, taskFirstCol: 5, taskLastCol: 34 }
    : { presenceCol: 2, coefficientCol: 4, totalCol: 5, taskFirstCol: 6, taskLastCol: 35 };
  context.SpreadsheetApp = {
    openById: id => {
      if (!files[id]) throw new Error(`unknown mock file ${id}`);
      return files[id];
    }
  };
  context.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
    base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url')
  };

  const artemProblem = context.tg_readDistributionProblem_(1, 1);
  assert.strictEqual(artemProblem.students.length, 2);
  assert.strictEqual(artemProblem.tasks.find(item => item.label === '2').covered, true);
  assert.deepStrictEqual(
    Array.from(artemProblem.students.find(item => item.name === 'Анна').candidateTaskKeys),
    ['n:1']
  );
  assert.strictEqual(
    artemProblem.students.find(item => item.name === 'Анна').semesterSolved,
    3
  );
  assert.deepStrictEqual(Array.from(artemProblem.diagnostics.absent), ['Нет на паре']);
  assert.deepStrictEqual(Array.from(artemProblem.diagnostics.inactive), ['Неактивный']);
  const artemResult = calculate(artemProblem, 'sheet-layout');
  assert.strictEqual(artemResult.flow, 2);
  assertValid(artemResult, artemProblem);
  const previewText = context.tg_formatDistribution_(artemProblem, artemResult);
  assert(previewText.includes('Покрыто после распределения: <b>3 из 3</b>'));
  assert(previewText.length <= 3900);

  const ramiProblem = context.tg_readDistributionProblem_(2, 1);
  assert.strictEqual(ramiProblem.students.length, 1);
  assert.strictEqual(ramiProblem.students[0].name, 'Рами Студент');
  assert.deepStrictEqual(Array.from(ramiProblem.students[0].candidateTaskKeys), ['n:1']);
}

// Черновик длиннее одного свойства сохраняется и собирается обратно без потерь.
{
  const propertyStore = new Map();
  const properties = {
    getProperty: key => propertyStore.has(key) ? propertyStore.get(key) : null,
    setProperty: (key, value) => {
      propertyStore.set(String(key), String(value));
      return properties;
    },
    deleteProperty: key => {
      propertyStore.delete(String(key));
      return properties;
    },
    getProperties: () => Object.fromEntries(propertyStore.entries())
  };
  context.PropertiesService = { getScriptProperties: () => properties };
  context.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => {}
    })
  };
  context.Utilities.newBlob = value => ({
    getBytes: () => Array.from(Buffer.from(String(value), 'utf8'))
  });
  context.Utilities.getUuid = () => '00000000-0000-4000-8000-000000000001';

  const longText = 'Распределение '.repeat(280);
  const draft = {
    id: 'longdraft001',
    ownerId: '111',
    practitionerNo: 1,
    practiceNo: 1,
    createdAt: Date.now(),
    status: 'draft',
    text: longText,
    assignments: [['Студент', '@student', ['1', '2']]]
  };
  context.tg_saveNewDraft_(draft);
  const loaded = context.tg_loadDraft_(draft.id, false);
  assert(loaded);
  assert.strictEqual(loaded.text, longText);
  assert(propertyStore.has('TG_DRAFT_TEXT_longdraft001_1'));
  assert.strictEqual(context.tg_getLastDraftForUser_('111').id, draft.id);
}

console.log('TelegramBot tests: OK (300 random graphs + deterministic and sheet-layout scenarios)');
