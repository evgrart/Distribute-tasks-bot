import crypto from 'node:crypto';

export class SheetsBridgeClient {
  constructor(url, secret, cacheMs = 15000) {
    this.url = url;
    this.secret = secret;
    this.cacheMs = cacheMs;
    this.cache = new Map();
  }

  async getProblem(practitionerNo, practiceNo, { fresh = false } = {}) {
    const key = `${practitionerNo}:${practiceNo}`;
    const cached = this.cache.get(key);
    if (!fresh && cached && Date.now() - cached.createdAt < this.cacheMs) return structuredClone(cached.value);

    const action = 'problem';
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(12).toString('hex');
    const canonical = [ts, nonce, action, practitionerNo, practiceNo].join('\n');
    const signature = crypto.createHmac('sha256', this.secret).update(canonical).digest('hex');
    const requestUrl = new URL(this.url);
    Object.entries({ action, practitioner: practitionerNo, practice: practiceNo, ts, nonce, signature })
      .forEach(([name, value]) => requestUrl.searchParams.set(name, String(value)));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(requestUrl, { redirect: 'follow', signal: controller.signal });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch { throw new Error(`Мост таблиц вернул не JSON (HTTP ${response.status}).`); }
      if (!response.ok || !result?.ok) throw new Error(result?.error || `Мост таблиц: HTTP ${response.status}.`);
      validateProblem(result.problem, practitionerNo, practiceNo);
      this.cache.set(key, { createdAt: Date.now(), value: result.problem });
      return structuredClone(result.problem);
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Мост таблиц не ответил за 60 секунд.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  clear(practitionerNo, practiceNo) {
    this.cache.delete(`${practitionerNo}:${practiceNo}`);
  }
}

function validateProblem(problem, practitionerNo, practiceNo) {
  if (!problem || !Array.isArray(problem.tasks) || !Array.isArray(problem.students)) {
    throw new Error('Мост таблиц вернул повреждённую структуру задачи.');
  }
  if (Number(problem.practitionerNo) !== Number(practitionerNo) ||
      Number(problem.practiceNo) !== Number(practiceNo)) {
    throw new Error('Мост таблиц вернул данные другой практики.');
  }
}
