import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDistribution, formatDistribution, problemFingerprint } from '../src/distribution.js';

const task = (number, covered = false) => ({ key: `t${number}`, label: String(number), covered });
const student = (name, candidates, options = {}) => ({
  id: name.toLowerCase(), name, telegram: '', existingOnes: options.existingOnes || 0,
  slots: options.slots == null ? 2 : options.slots,
  semesterSolved: options.semesterSolved || 0,
  candidateTaskKeys: candidates.map(number => `t${number}`)
});
const problem = (tasks, students) => ({
  practitionerNo: 1, practitioner: 'Артём', practiceNo: 1,
  tasks, students, noCandidateTasks: [],
  diagnostics: { missingCentral: [], wrongPractitioner: [], inactive: [], absent: [], full: [], missingPracticeSheets: [] }
});

function mapping(result) {
  return Object.fromEntries(result.assignments.map(item =>
    [item.name, item.tasks.map(value => value.label).sort()]));
}

function assertValid(result, input) {
  const seen = new Set();
  const students = new Map(input.students.map(item => [item.id, item]));
  for (const assignment of result.assignments) {
    const source = students.get(assignment.id);
    assert.ok(source);
    assert.ok(assignment.tasks.length <= source.slots);
    for (const assigned of assignment.tasks) {
      assert.ok(!seen.has(assigned.key), 'task assigned twice');
      assert.ok(source.candidateTaskKeys.includes(assigned.key), 'assignment without plus');
      seen.add(assigned.key);
    }
  }
  assert.equal(seen.size, result.flow);
}

function bruteMaximumCoverage(input) {
  const open = input.tasks.filter(item => !item.covered);
  const capacity = input.students.map(item => item.slots);
  let best = 0;
  function visit(index, covered) {
    if (index === open.length) { best = Math.max(best, covered); return; }
    if (covered + open.length - index <= best) return;
    visit(index + 1, covered);
    input.students.forEach((item, studentIndex) => {
      if (!capacity[studentIndex] || !item.candidateTaskKeys.includes(open[index].key)) return;
      capacity[studentIndex]--;
      visit(index + 1, covered + 1);
      capacity[studentIndex]++;
    });
  }
  visit(0, 0);
  return best;
}

test('covers a greedy trap optimally', () => {
  const input = problem([task(1), task(2)], [
    student('A', [1, 2], { slots: 1 }), student('B', [1], { slots: 1 })
  ]);
  const result = calculateDistribution(input, 'trap');
  assert.equal(result.flow, 2);
  assert.deepEqual(mapping(result), { A: ['2'], B: ['1'] });
});

test('uses first slots before a second slot', () => {
  const input = problem([task(1), task(2)], [student('A', [1, 2]), student('B', [2])]);
  const result = calculateDistribution(input, 'involvement');
  assert.equal(result.flow, 2);
  assert.equal(result.assignments.length, 2);
});

test('usually but not always prefers the student with fewer semester solutions', () => {
  const input = problem([task(1)], [
    student('Мало', [1], { semesterSolved: 4 }), student('Много', [1], { semesterSolved: 24 })
  ]);
  let lessSolvedWins = 0;
  const trials = 2000;
  for (let index = 0; index < trials; index++) {
    if (calculateDistribution(input, `priority-${index}`).assignments[0].name === 'Мало') {
      lessSolvedWins++;
    }
  }
  const rate = lessSolvedWins / trials;
  assert.ok(rate > 0.62 && rate < 0.76, `unexpected weighted-random rate: ${rate}`);
});

test('priority power zero produces an approximately fair lottery', () => {
  const input = problem([task(1)], [
    student('Мало', [1], { semesterSolved: 0 }), student('Много', [1], { semesterSolved: 100 })
  ]);
  let firstWins = 0;
  const trials = 2000;
  for (let index = 0; index < trials; index++) {
    if (calculateDistribution(input, `fair-${index}`, 997, 0).assignments[0].name === 'Мало') firstWins++;
  }
  const rate = firstWins / trials;
  assert.ok(rate > 0.43 && rate < 0.57, `unexpected fair-random rate: ${rate}`);
});

test('existing one consumes the first slot', () => {
  const input = problem([task(1)], [
    student('Уже выходил', [1], { existingOnes: 1, slots: 1 }),
    student('Не выходил', [1], { slots: 2, semesterSolved: 50 })
  ]);
  assert.equal(calculateDistribution(input, 'ones').assignments[0].name, 'Не выходил');
});

test('covered tasks are never assigned and seed is deterministic', () => {
  const input = problem([task(1, true), task(2), task(3)], [student('A', [1, 2, 3]), student('B', [2, 3])]);
  const left = calculateDistribution(input, 'stable');
  const right = calculateDistribution(input, 'stable');
  assert.deepEqual(mapping(left), mapping(right));
  assert.ok(!left.assignedTaskKeys.includes('t1'));
});

test('fingerprint and formatted message are stable', () => {
  const input = problem([task(1)], [student('А', [1])]);
  const result = calculateDistribution(input, 'format');
  assert.equal(problemFingerprint(input), problemFingerprint(structuredClone(input)));
  assert.match(formatDistribution(input, result), /Практика 1/);
});

test('300 random graphs reach brute-force maximum coverage', () => {
  let state = 0x51f15e;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
    const taskCount = 1 + Math.floor(random() * 6);
    const studentCount = 1 + Math.floor(random() * 5);
    const input = problem(
      Array.from({ length: taskCount }, (_, index) => task(index + 1)),
      Array.from({ length: studentCount }, (_, studentIndex) => {
        const candidates = [];
        for (let number = 1; number <= taskCount; number++) if (random() < 0.55) candidates.push(number);
        return student(`S${studentIndex}`, candidates, {
          slots: 1 + Math.floor(random() * 2), semesterSolved: Math.floor(random() * 30)
        });
      })
    );
    const result = calculateDistribution(input, `random-${caseIndex}`);
    assertValid(result, input);
    assert.equal(result.flow, bruteMaximumCoverage(input), `case ${caseIndex}`);
  }
});
