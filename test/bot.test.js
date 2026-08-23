import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DistributionBot } from '../src/bot.js';
import { StateStore } from '../src/state-store.js';

class FakeApi {
  constructor() { this.calls = []; }
  async call(method, payload) { this.calls.push({ method, payload }); return method === 'getMe' ? { username: 'test_bot' } : true; }
  async sendMessage(chatId, text, keyboard) { this.calls.push({ method: 'sendMessage', chatId: String(chatId), text, keyboard }); return {}; }
  async answerCallback() {}
  async clearKeyboard() {}
  async editMessage() {}
}

function config(stateFile) {
  return {
    token: 'unused', allowedUserIds: new Set(['7']), adminUserIds: new Set(['8']),
    targetChatIds: { 1: '-1001', 2: '-1002', 3: '-1003' },
    practitioners: ['Артём', 'Рами', 'Немат'], practiceCount: 15,
    randomMax: 997, draftTtlMs: 7200000, pairReservationMs: 120000,
    actionTimeoutMs: 120000,
    maxMessageLength: 3900, timeZone: 'Europe/Moscow', stateFile
  };
}

test('preview is private, saved and published only after approval', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-bot-handler-'));
  const cfg = config(path.join(directory, 'state.json'));
  const api = new FakeApi();
  const bridge = { async getProblem() { return {
    practitionerNo: 1, practitioner: 'Артём', practiceNo: 1,
    tasks: [{ key: 'n:1', label: '1', covered: false }],
    students: [{ id: 'a', name: 'А', telegram: '@a', existingOnes: 0, slots: 2, semesterSolved: 0, candidateTaskKeys: ['n:1'] }],
    noCandidateTasks: [], diagnostics: { missingCentral: [], wrongPractitioner: [], inactive: [], absent: [], full: [], missingPracticeSheets: [] }
  }; } };
  const state = new StateStore(cfg.stateFile, cfg.draftTtlMs, cfg.pairReservationMs);
  await state.load();
  const bot = new DistributionBot(cfg, api, bridge, state);
  await bot.handleMessage({ text: '/preview 1 1', from: { id: 7 }, chat: { id: 7, type: 'private' } });
  const draft = state.getLastDraft('7');
  assert.equal(draft.status, 'draft');
  assert.ok(api.calls.some(call => call.method === 'sendMessage' && call.chatId === '7'));
  assert.ok(!api.calls.some(call => call.method === 'sendMessage' && call.chatId === '-1001'));
  await bot.publishDraft(draft.id, '7', '7', null);
  assert.ok(api.calls.some(call => call.method === 'sendMessage' && call.chatId === '-1001'));
  assert.equal(state.getDraft(draft.id).status, 'published');
  await fs.rm(directory, { recursive: true, force: true });
});

test('unauthorized user receives an access error', async () => {
  const cfg = config('unused');
  const api = new FakeApi();
  const bot = new DistributionBot(cfg, api, {}, {});
  await bot.handleMessage({ text: '/start', from: { id: 99 }, chat: { id: 99, type: 'private' } });
  assert.match(api.calls.at(-1).text, /нет доступа/);
});
