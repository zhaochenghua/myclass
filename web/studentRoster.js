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
    if (!classItem) return Array.from({ length: count }, (_, i) => ({ text: String(i + 1).padStart(2, '0'), detail: '' }));
    if (!classItem.students.length) throw new Error('这个班级还没有学生，请先在管理界面录入名单');
    return classItem.students.map(student => ({
      text: mode === 'number' ? student.number : student.name,
      detail: `${classItem.name} · ${mode === 'number' ? student.name : `学号 ${student.number}`}`
    }));
  }
  const api = { parse, candidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StudentRoster = api;
})(typeof window === 'undefined' ? globalThis : window);
