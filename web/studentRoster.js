// Shared roster rules for the admin editor and classroom draw UI.
(function (root) {
  function parse(text) {
    const numbers = new Set();
    const students = [];
    String(text).split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      const match = line.trim().match(/^([^\s,，]+)[\s,，]+(.+)$/);
      if (!match) throw new Error(`第 ${index + 1} 行：请填写“学号 姓名”`);
      const number = match[1];
      const name = match[2].trim();
      if (students.length === 0 && number === '学号' && name === '姓名') return;
      if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(number)) throw new Error(`第 ${index + 1} 行：学号格式不正确`);
      if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`第 ${index + 1} 行：姓名需为 1–40 个字符`);
      if (numbers.has(number)) throw new Error(`学号 ${number} 重复，请核对名单`);
      numbers.add(number);
      students.push({ number, name });
    });
    if (students.length > 500) throw new Error('每个班级最多录入 500 名学生');
    return students;
  }
  function candidates(classItem, mode, count) {
    if (!classItem) return Array.from({ length: count }, (_, i) => ({ id: String(i + 1), text: String(i + 1).padStart(2, '0'), detail: '' }));
    if (!classItem.students.length) throw new Error('这个班级还没有学生，请先在管理界面录入名单');
    return classItem.students.map(student => ({
      id: student.number,
      text: mode === 'number' ? student.number : student.name,
      detail: `${classItem.name} · ${mode === 'number' ? student.name : `学号 ${student.number}`}`
    }));
  }
  // Store identities only, so changing names/order/display mode preserves progress.
  function nextDraw(items, state = {}, random = Math.random) {
    if (!items.length) throw new Error('没有可抽取的学生');
    const ids = new Set(items.map(item => item.id));
    let drawn = new Set((state.drawn || []).filter(id => ids.has(id)));
    let number = state.number || 1;
    const recent = (state.recent || []).filter(id => ids.has(id)).slice(-Math.max(1, Math.floor(items.length / 2)));
    let pool = items.filter(item => !drawn.has(item.id));
    if (!pool.length) { drawn = new Set(); number++; pool = items; }
    // Across round boundaries, prefer students outside the most recent half-class.
    const rested = pool.filter(item => !recent.includes(item.id));
    const eligible = rested.length ? rested : pool;
    const candidate = eligible[Math.floor(random() * eligible.length)];
    drawn.add(candidate.id);
    recent.push(candidate.id);
    return {
      candidate, round: number, remaining: pool.length - 1, total: items.length,
      state: { drawn: [...drawn], number, recent: recent.slice(-Math.max(1, Math.floor(items.length / 2))) }
    };
  }
  function createRoundDraw(random = Math.random, storage = null) {
    const rounds = new Map();
    function load(scope) {
      if (!rounds.has(scope)) rounds.set(scope, storage?.load(scope) || {});
      return rounds.get(scope);
    }
    return {
      // Animation previews must not consume a student or start a new round.
      preview(scope, items) {
        if (!items.length) throw new Error('没有可抽取的学生');
        const drawn = new Set(load(scope).drawn || []);
        const pool = items.filter(item => !drawn.has(item.id));
        return pool.length ? pool : items;
      },
      draw(scope, items) {
        const { state, ...outcome } = nextDraw(items, load(scope), random);
        rounds.set(scope, state);
        storage?.save(scope, state);
        return outcome;
      }
    };
  }
  const api = { parse, candidates, nextDraw, createRoundDraw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StudentRoster = api;
})(typeof window === 'undefined' ? globalThis : window);
