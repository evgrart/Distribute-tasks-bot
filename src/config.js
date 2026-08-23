import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  loadEnvFile(path.join(projectRoot, '.env'));
  const config = {
    token: required('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: new Set(parseIdList(process.env.ALLOWED_USER_IDS)),
    adminUserIds: new Set(parseIdList(process.env.ADMIN_USER_IDS)),
    targetChatIds: parseJsonObject(required('TARGET_CHAT_IDS'), 'TARGET_CHAT_IDS'),
    bridgeUrl: required('SHEETS_BRIDGE_URL').replace(/\/+$/, ''),
    bridgeSecret: required('SHEETS_BRIDGE_SECRET'),
    dropPendingUpdatesOnStart: parseBoolean(process.env.DROP_PENDING_UPDATES_ON_START, false),
    stateFile: path.resolve(projectRoot, process.env.STATE_FILE || './data/state.json'),
    sheetsCacheMs: parsePositiveInt(process.env.SHEETS_CACHE_SECONDS, 15) * 1000,
    pollTimeoutSeconds: Math.min(50, parsePositiveInt(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS, 45)),
    solvedPriorityPower: parseNumberInRange(process.env.SOLVED_PRIORITY_POWER, 0.5, 0, 2),
    timeZone: process.env.TIME_ZONE || 'Europe/Moscow',
    practitioners: ['Артём', 'Рами', 'Немат'],
    practiceCount: 15,
    randomMax: 997,
    draftTtlMs: 2 * 60 * 60 * 1000,
    pairReservationMs: 2 * 60 * 1000,
    actionTimeoutMs: 2 * 60 * 1000,
    maxMessageLength: 3900
  };
  if (!config.allowedUserIds.size && !config.adminUserIds.size) {
    throw new Error('Задайте ALLOWED_USER_IDS или ADMIN_USER_IDS.');
  }
  for (let number = 1; number <= config.practitioners.length; number++) {
    if (!String(config.targetChatIds[number] ?? '').trim()) {
      throw new Error(`В TARGET_CHAT_IDS отсутствует чат для практика ${number}.`);
    }
  }
  return config;
}

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return;
  const lines = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (Object.hasOwn(process.env, key)) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Не задана переменная ${name}.`);
  return value;
}

function parseIdList(value) {
  return String(value || '').split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
}

function parseJsonObject(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} должен быть JSON-объектом, например {"1":"-100..."}.`);
  }
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'да'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumberInRange(value, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Ожидалось число от ${minimum} до ${maximum}, получено: ${value}.`);
  }
  return parsed;
}
