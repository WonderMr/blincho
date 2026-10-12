const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const repository = path.resolve(__dirname, "..");
const compiledDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "myeyes-medical-"));
process.on("exit", () => fs.rmSync(compiledDirectory, { recursive: true, force: true }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), "--ignoreConfig", "--resolveJsonModule", "--target", "ES2022", "--module", "commonjs", "--jsx", "react", "--esModuleInterop", "--skipLibCheck", "--rootDir", path.join(repository, "src"), "--outDir", compiledDirectory, ...["src/data/medicalTechniques.ts", "src/data/cvsQuestions.ts", "src/components/CVSSurvey.tsx", "src/utils/notifications.ts"].map(file => path.join(repository, file))], { stdio: "inherit" });

function load(file, imports = {}) {
  const sandbox = { exports: {}, require: (id) => imports[id] || {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(compiledDirectory, file), 'utf8'), sandbox, { filename: file });
  return sandbox.exports;
}

const { CVS_SURVEY_QUESTIONS: questions } = load('data/cvsQuestions.js');
const { calculateSymptomResult } = load('components/CVSSurvey.js', {
  '../data/cvsQuestions': { CVS_SURVEY_QUESTIONS: questions },
});
assert.equal(calculateSymptomResult({}, '2026-10-11'), null);
for (const bad of [undefined, -1, 4, NaN, '3', Infinity]) {
  const answers = Object.fromEntries(questions.map(q => [q.id, 0]));
  answers[questions[0].id] = bad;
  assert.equal(calculateSymptomResult(answers, '2026-10-11'), null);
}
for (let combination = 0; combination < 4096; combination++) {
  let value = combination;
  const answers = {};
  let expected = 0;
  for (const question of questions) {
    const score = value % 4;
    answers[question.id] = score;
    expected += score;
    value = Math.floor(value / 4);
  }
  answers.unrelated = 1000;
  const result = calculateSymptomResult(answers, '2026-10-11');
  assert.equal(result.score, expected);
  assert.equal(result.maxScore, 18);
  assert.equal(result.level, 'self-check');
  assert.equal(result.title, 'Самопроверка симптомов');
  assert.equal(result.date, '2026-10-11');
  assert(!result.recommendations.some(rec => /гиалурон|0\.15|диагноз установлен|низкий риск|спазм аккомодации/i.test(rec)));
}
const { MEDICAL_TECHNIQUES: techniques } = load('data/medicalTechniques.js');
for (const technique of techniques) {
  assert.equal(technique.steps.reduce((sum, step) => sum + step.durationSeconds, 0), technique.durationSeconds);
  assert(technique.steps.every(step => Number.isInteger(step.durationSeconds) && step.durationSeconds > 0));
}
assert.equal(new Set(techniques.map(t => t.id)).size, 7);
for (const id of ['figure-8-pursuit', 'orbital-circle-tracking']) {
  assert.deepEqual(Array.from(techniques.find(t => t.id === id).steps, step => step.direction), [1, -1]);
}
assert.deepEqual(Array.from(techniques.find(t => t.id === 'near-far-tromboning').steps, step => step.focus), ['near', 'far', 'near', 'far']);
console.log('PASS: 4096 self-check answer combinations; invalid answers; foreign keys; neutral semantics; seven technique duration totals and animation metadata.');
