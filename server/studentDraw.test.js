const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, createRoundDraw } = require('../web/studentRoster');

test('each round covers the whole class once, then starts a fresh round', () => {
  for (const count of [1, 2, 50, 80, 500]) {
    const items = candidates(null, 'number', count);
    const rounds = createRoundDraw();
    for (let round = 1; round <= 3; round++) {
      const seen = new Set();
      for (let i = 0; i < count; i++) {
        const result = rounds.draw('class-a', items);
        assert.equal(result.round, round);
        assert.equal(result.remaining, count - i - 1);
        assert.ok(!seen.has(result.candidate.id));
        seen.add(result.candidate.id);
      }
      assert.equal(seen.size, count);
    }
  }
});

test('class and teacher scopes remain independent when switching back and forth', () => {
  const rounds = createRoundDraw(() => 0);
  const items = candidates(null, 'number', 3);
  for (const scope of ['alice/a', 'alice/b', 'bob/a']) {
    assert.equal(rounds.draw(scope, items).candidate.id, '1');
  }
  assert.equal(rounds.draw('alice/a', items).candidate.id, '2');
  assert.equal(rounds.draw('alice/b', items).candidate.id, '2');
});

test('names, order and display mode do not reset a round; equal names are distinct students', () => {
  const rounds = createRoundDraw(() => 0);
  const roster = { name: '一班', students: [{ number: '01', name: '王同学' }, { number: '09', name: '王同学' }] };
  assert.equal(rounds.draw('a', candidates(roster, 'name')).candidate.id, '01');
  roster.students.reverse();
  roster.students[0].name = '新姓名';
  const result = rounds.draw('a', candidates(roster, 'number'));
  assert.equal(result.candidate.id, '09');
  assert.equal(result.remaining, 0);
  assert.equal(result.round, 1);
});

test('preview never consumes a draw; new students join the round and removed students do not block it', () => {
  const rounds = createRoundDraw(() => 0);
  const items = candidates(null, 'number', 3);
  for (let i = 0; i < 100; i++) assert.equal(rounds.preview('a', items).length, 3);
  assert.equal(rounds.draw('a', items).candidate.id, '1');
  const revised = [items[0], items[2], { id: '4', text: '04', detail: '' }];
  assert.equal(rounds.draw('a', revised).candidate.id, '3');
  assert.equal(rounds.draw('a', revised).candidate.id, '4');
  for (let i = 0; i < 100; i++) rounds.preview('a', revised);
  assert.equal(rounds.draw('a', revised).round, 2);
  assert.throws(() => rounds.draw('empty', []), /没有可抽取/);
});
