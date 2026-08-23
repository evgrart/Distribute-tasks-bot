import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY_STATE = {
  offset: 0, bootstrapComplete: false, drafts: {}, lastDraftByUser: {}, pairReservations: {}
};

export class StateStore {
  constructor(filename, draftTtlMs, reservationTtlMs) {
    this.filename = filename;
    this.draftTtlMs = draftTtlMs;
    this.reservationTtlMs = reservationTtlMs;
    this.state = structuredClone(EMPTY_STATE);
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      this.state = { ...structuredClone(EMPTY_STATE), ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.mutate(state => cleanup(state, this.draftTtlMs, this.reservationTtlMs));
  }

  get offset() { return Number(this.state.offset) || 0; }
  get bootstrapComplete() { return this.state.bootstrapComplete === true; }
  getDraft(id) { return clone(this.state.drafts[id] || null); }
  getLastDraft(userId) {
    const id = this.state.lastDraftByUser[String(userId)];
    return id ? this.getDraft(id) : null;
  }

  setOffset(offset) { return this.mutate(state => { state.offset = Number(offset) || 0; }); }
  markBootstrapComplete() { return this.mutate(state => { state.bootstrapComplete = true; }); }

  saveDraft(draft) {
    return this.mutate(state => {
      cleanup(state, this.draftTtlMs, this.reservationTtlMs);
      state.drafts[draft.id] = clone(draft);
      state.lastDraftByUser[String(draft.ownerId)] = draft.id;
    });
  }

  updateDraft(id, updater) {
    return this.mutate(state => {
      const draft = state.drafts[id];
      if (!draft) throw new Error('Черновик не найден или уже устарел.');
      updater(draft);
      return clone(draft);
    });
  }

  reservePair(practitionerNo, practiceNo, userId) {
    const key = `${practitionerNo}:${practiceNo}`;
    return this.mutate(state => {
      cleanup(state, this.draftTtlMs, this.reservationTtlMs);
      const current = state.pairReservations[key];
      if (current) throw new Error(`Эта пара уже рассчитывается пользователем ${current.userId}.`);
      const token = crypto.randomUUID();
      state.pairReservations[key] = { token, userId: String(userId), createdAt: Date.now() };
      return { key, token };
    });
  }

  releasePair(reservation) {
    if (!reservation) return Promise.resolve();
    return this.mutate(state => {
      if (state.pairReservations[reservation.key]?.token === reservation.token) {
        delete state.pairReservations[reservation.key];
      }
    });
  }

  mutate(operation) {
    const result = this.queue.then(async () => {
      const returnValue = operation(this.state);
      await this.persist();
      return returnValue;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(temporary, this.filename);
  }
}

function cleanup(state, draftTtlMs, reservationTtlMs) {
  const now = Date.now();
  for (const [id, draft] of Object.entries(state.drafts || {})) {
    if (now - Number(draft.createdAt) > draftTtlMs) delete state.drafts[id];
  }
  for (const [userId, id] of Object.entries(state.lastDraftByUser || {})) {
    if (!state.drafts[id]) delete state.lastDraftByUser[userId];
  }
  for (const [key, reservation] of Object.entries(state.pairReservations || {})) {
    if (now - Number(reservation.createdAt) > reservationTtlMs) delete state.pairReservations[key];
  }
}

function clone(value) { return value == null ? value : structuredClone(value); }
