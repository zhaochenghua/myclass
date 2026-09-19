const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const fail = (status, message) => Object.assign(new Error(message), { status });

function textField(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail(400, `${label}不能为空，且不能超过 ${maxLength} 个字符`);
  }
  return value.trim();
}

function validateStudents(students) {
  if (!Array.isArray(students) || students.length > 500) throw fail(400, '每个班级最多录入 500 名学生');
  const numbers = new Set();
  return students.map(student => {
    const number = textField(student?.number, '学号', 24);
    const name = textField(student?.name, '姓名', 40);
    if (!/^[\p{L}\p{N}_-]+$/u.test(number)) throw fail(400, '学号仅支持文字、数字、下划线和短横线');
    if (numbers.has(number)) throw fail(400, `学号 ${number} 重复，请核对名单`);
    numbers.add(number);
    return { number, name };
  });
}

function createClassStore(filename) {
  let writes = Promise.resolve();
  async function load() {
    try {
      const items = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (!Array.isArray(items)) throw new Error('班级数据格式错误，请从备份恢复');
      return items;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function save(items) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(items, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  function change(operation) {
    const result = writes.then(async () => {
      const items = await load();
      const result = operation(items);
      await save(items);
      return result;
    });
    writes = result.catch(() => {});
    return result;
  }
  function find(items, ownerId, id) {
    const item = items.find(item => item.id === id && item.ownerId === ownerId);
    if (!item) throw fail(404, '班级不存在或无权访问');
    return item;
  }
  return {
    async list(ownerId) { return (await load()).filter(item => item.ownerId === ownerId); },
    async get(ownerId, id) { return find(await load(), ownerId, id); },
    create(ownerId, body) {
      const name = textField(body?.name, '班级名称', 40);
      return change(items => {
        if (items.filter(item => item.ownerId === ownerId).length >= 100) throw fail(400, '最多创建 100 个任教班级');
        if (items.some(item => item.ownerId === ownerId && item.name === name)) throw fail(409, '已存在同名班级');
        const item = { id: randomUUID(), ownerId, name, students: [], revision: 1, updatedAt: new Date().toISOString() };
        items.push(item);
        return item;
      });
    },
    update(ownerId, id, body) {
      const name = textField(body?.name, '班级名称', 40);
      const students = validateStudents(body?.students);
      return change(items => {
        const item = find(items, ownerId, id);
        if (body.revision !== item.revision) throw fail(409, '班级已在其他页面修改，请刷新后重新编辑');
        if (items.some(other => other.id !== id && other.ownerId === ownerId && other.name === name)) throw fail(409, '已存在同名班级');
        Object.assign(item, { name, students, revision: item.revision + 1, updatedAt: new Date().toISOString() });
        return item;
      });
    },
    remove(ownerId, id, revision) {
      return change(items => {
        const item = find(items, ownerId, id);
        if (revision !== item.revision) throw fail(409, '班级已修改，请刷新确认后再删除');
        items.splice(items.indexOf(item), 1);
      });
    },
    removeOwner(ownerId) {
      return change(items => {
        for (let i = items.length - 1; i >= 0; i--) if (items[i].ownerId === ownerId) items.splice(i, 1);
      });
    }
  };
}

module.exports = { createClassStore, validateStudents };
