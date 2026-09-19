import crypto from 'node:crypto';

export function calculateDistribution(problem, seed, randomMax = 997, solvedPriorityPower = 0.5) {
  const openTasks = problem.tasks.filter(task => !task.covered);
  if (!openTasks.length) return emptyResult();

  const taskIndexByKey = new Map(openTasks.map((task, index) => [task.key, index]));
  const students = problem.students.filter(student =>
    student.slots > 0 && student.candidateTaskKeys.some(key => taskIndexByKey.has(key))
  );
  const slots = [];
  for (const student of students) {
    for (let index = 0; index < student.slots; index++) {
      slots.push({ student, ordinal: student.existingOnes + index + 1 });
    }
  }

  const source = 0;
  const slotStart = 1;
  const taskStart = slotStart + slots.length;
  const sink = taskStart + openTasks.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const flowBound = openTasks.length;
  const priorityCosts = new Map(students.map(student => [
    student.id,
    weightedPriorityCost(seed, student, solvedPriorityPower)
  ]));
  const maxPriorityCost = Math.max(0, ...priorityCosts.values());
  // Этот штраф больше любой возможной суммы остальных стоимостей. Поэтому
  // первые выходы разных студентов по-прежнему строго важнее вторых.
  const secondSlotPenalty = flowBound * (maxPriorityCost + randomMax) + 1;
  const assignmentEdges = [];

  slots.forEach((slot, slotIndex) => {
    const slotNode = slotStart + slotIndex;
    const secondCost = slot.ordinal >= 2 ? secondSlotPenalty : 0;
    addFlowEdge(graph, source, slotNode, 1,
      secondCost + priorityCosts.get(slot.student.id));

    for (const taskKey of slot.student.candidateTaskKeys) {
      const taskIndex = taskIndexByKey.get(taskKey);
      if (taskIndex == null) continue;
      const edge = addFlowEdge(
        graph,
        slotNode,
        taskStart + taskIndex,
        1,
        seededInt(seed, `${slot.student.id}|${slot.ordinal}|${taskKey}`, randomMax + 1),
        { student: slot.student, task: openTasks[taskIndex] }
      );
      assignmentEdges.push(edge);
    }
  });
  openTasks.forEach((_, index) => addFlowEdge(graph, taskStart + index, sink, 1, 0));

  const flowResult = minCostMaxFlow(graph, source, sink);
  const byStudent = new Map();
  const assignedTaskKeys = [];
  for (const edge of assignmentEdges) {
    if (edge.initialCap !== 1 || edge.cap !== 0 || !edge.meta) continue;
    const { student, task } = edge.meta;
    if (!byStudent.has(student.id)) {
      byStudent.set(student.id, {
        id: student.id,
        name: student.name,
        telegram: student.telegram || '',
        semesterSolved: student.semesterSolved,
        tasks: []
      });
    }
    byStudent.get(student.id).tasks.push(task);
    assignedTaskKeys.push(task.key);
  }

  const assignments = [...byStudent.values()];
  assignments.forEach(item => item.tasks.sort(compareTasks));
  assignments.sort((left, right) =>
    String(left.name).localeCompare(String(right.name), 'ru', { numeric: true })
  );
  const assigned = new Set(assignedTaskKeys);
  return {
    flow: flowResult.flow,
    cost: flowResult.cost,
    assignments,
    assignedTaskKeys,
    unmatchedTaskKeys: openTasks.filter(task => !assigned.has(task.key)).map(task => task.key)
  };
}

export function formatDistribution(problem, result, maxLength = 3900) {
  const lines = [`<b>Практика ${problem.practiceNo} — ${escapeHtml(problem.practitioner)}</b>`, ''];
  if (!result.assignments.length) {
    lines.push('Новых назначений нет.');
  } else {
    for (const item of result.assignments) {
      const person = item.telegram
        ? escapeHtml(item.telegram)
        : `${escapeHtml(item.name)} <i>(TG не указан)</i>`;
      const labels = item.tasks.map(task => escapeHtml(task.label));
      lines.push(`${person} — ${labels.length === 1 ? 'задача' : 'задачи'} ${labels.join(', ')}`);
    }
  }

  const alreadyCovered = problem.tasks.filter(task => task.covered).length;
  lines.push('', `Назначено сейчас: <b>${result.flow}</b>`);
  lines.push(`Покрыто после распределения: <b>${alreadyCovered + result.flow} из ${problem.tasks.length}</b>`);

  const noCandidateSet = new Set(problem.noCandidateTasks);
  const noCandidate = tasksByKeys(problem, problem.noCandidateTasks);
  const constrained = tasksByKeys(problem,
    result.unmatchedTaskKeys.filter(key => !noCandidateSet.has(key)));
  if (noCandidate.length) lines.push(`Без подходящего кандидата: ${escapeHtml(noCandidate.join(', '))}`);
  if (constrained.length) lines.push(`Не хватило свободных выходов: ${escapeHtml(constrained.join(', '))}`);

  return limitMessage(lines, maxLength);
}

export function problemFingerprint(problem) {
  const compact = {
    practitionerNo: problem.practitionerNo,
    practiceNo: problem.practiceNo,
    tasks: problem.tasks.map(task => [task.key, task.covered]),
    students: problem.students.map(student => [
      student.id, student.existingOnes, student.slots,
      student.semesterSolved, student.candidateTaskKeys
    ])
  };
  return crypto.createHash('sha256').update(JSON.stringify(compact))
    .digest('base64url').slice(0, 20);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emptyResult() {
  return { flow: 0, cost: 0, assignments: [], assignedTaskKeys: [], unmatchedTaskKeys: [] };
}

function addFlowEdge(graph, from, to, capacity, cost, meta = null) {
  const forward = { to, rev: graph[to].length, cap: capacity, initialCap: capacity, cost, meta };
  const reverse = { to: from, rev: graph[from].length, cap: 0, initialCap: 0, cost: -cost, meta: null };
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function minCostMaxFlow(graph, source, sink) {
  let flow = 0;
  let cost = 0;
  while (true) {
    const distance = Array(graph.length).fill(Infinity);
    const previousNode = Array(graph.length).fill(-1);
    const previousEdge = Array(graph.length).fill(-1);
    const inQueue = Array(graph.length).fill(false);
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
    if (!Number.isFinite(distance[sink])) break;
    let node = sink;
    while (node !== source) {
      const from = previousNode[node];
      const edge = graph[from][previousEdge[node]];
      edge.cap--;
      graph[node][edge.rev].cap++;
      node = from;
    }
    flow++;
    cost += distance[sink];
  }
  return { flow, cost };
}

function seededInt(seed, key, modulo) {
  let hash = 2166136261;
  const text = `${seed}|${key}`;
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

function weightedPriorityCost(seed, student, power) {
  const solved = Math.max(0, Number(student.semesterSolved) || 0);
  // Экспоненциальная гонка: шанс победить пропорционален
  // (1 + solved)^power. При power=0 получается чистый рандом,
  // при 0.5 решившие больше получают заметный, но не абсолютный приоритет.
  const discrete = seededInt(seed, `student-priority|${student.id}`, 1000000);
  const uniform = (discrete + 0.5) / 1000000;
  const score = -Math.log(uniform) / Math.pow(1 + solved, power);
  return Math.min(1000000000, Math.round(score * 10000));
}

function compareTasks(left, right) {
  return String(left.label).localeCompare(String(right.label), 'ru', { numeric: true });
}

function tasksByKeys(problem, keys) {
  const wanted = new Set(keys);
  return problem.tasks.filter(task => wanted.has(task.key)).sort(compareTasks).map(task => task.label);
}

function limitMessage(lines, maximum) {
  const accepted = [];
  for (const line of lines) {
    if (accepted.concat(line).join('\n').length > maximum) {
      accepted.push('<i>Часть диагностики сокращена из-за ограничения Telegram.</i>');
      break;
    }
    accepted.push(line);
  }
  return accepted.join('\n');
}
