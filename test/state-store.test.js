import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state-store.js';

test('state survives restart and pair reservation is exclusive', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-bot-'));
  const filename = path.join(directory, 'state.json');
  const first = new StateStore(filename, 60_000, 60_000);
  await first.load();
  await first.saveDraft({ id: 'd1', ownerId: '7', createdAt: Date.now(), status: 'draft', text: 'x' });
  await first.setOffset(42);
  const reservation = await first.reservePair(1, 2, '7');
  await assert.rejects(first.reservePair(1, 2, '8'), /уже рассчитывается/);
  await first.releasePair(reservation);

  const second = new StateStore(filename, 60_000, 60_000);
  await second.load();
  assert.equal(second.offset, 42);
  assert.equal(second.getLastDraft('7').text, 'x');
  await fs.rm(directory, { recursive: true, force: true });
});
