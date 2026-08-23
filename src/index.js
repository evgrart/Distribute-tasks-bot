import { loadConfig } from './config.js';
import { TelegramApi } from './telegram-api.js';
import { SheetsBridgeClient } from './bridge-client.js';
import { StateStore } from './state-store.js';
import { DistributionBot } from './bot.js';

try {
  const config = loadConfig();
  const api = new TelegramApi(config.token, config.pollTimeoutSeconds);
  const bridge = new SheetsBridgeClient(config.bridgeUrl, config.bridgeSecret, config.sheetsCacheMs);
  const state = new StateStore(config.stateFile, config.draftTtlMs, config.pairReservationMs);
  const bot = new DistributionBot(config, api, bridge, state);
  process.on('SIGINT', () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  await bot.start();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
