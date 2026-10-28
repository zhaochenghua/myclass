const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateProfile } = require('../web/touchCalibrationMath');
const { candidates, nextDraw } = require('../web/studentRoster');

const fail = (status, message) => Object.assign(new Error(message), { status });
// Keep enough history to review a whole term without letting a long-lived
// class file grow without bound.
const DRAW_LOG_LIMIT = 500;
const DRAW_LOG_DEFAULT_LIMIT = 100;
// Homework sessions are small (one status per student) but classes.json is
// rewritten on every save, so keep the worst case bounded while leaving enough
// room for a full school year of assignments.
const HOMEWORK_LIMIT = 200;
const HOMEWORK_STATUSES = ['excellent', 'copy', 'wrong', 'missing'];
const HOMEWORK_STATUS_SET = new Set(HOMEWORK_STATUSES);

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

// ---- Homework registration ----
function homeworkDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(400, '作业日期格式无效');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw fail(400, '作业日期无效');
  }
  return value;
}

// Student numbers are user supplied and may be "__proto__", so never assign
// them as plain properties on the records object.
function setRecord(records, number, status) {
  if (status === null) { delete records[number]; return; }
  Object.defineProperty(records, number, { value: status, enumerable: true, configurable: true, writable: true });
}

function ownRecord(records, number) {
  return records && Object.prototype.hasOwnProperty.call(records, number) ? records[number] : null;
}

function sanitizeRecords(records) {
  const clean = {};
  for (const [number, status] of Object.entries(records && typeof records === 'object' && !Array.isArray(records) ? records : {})) {
    if (HOMEWORK_STATUS_SET.has(status)) setRecord(clean, number, status);
  }
  return clean;
}

function homeworkEntries(item) {
  return Array.isArray(item.homework) ? item.homework : [];
}

function findHomework(item, homeworkId) {
  const homework = homeworkEntries(item).find(entry => entry.id === homeworkId);
  if (!homework) throw fail(404, '作业记录不存在或已删除');
  return homework;
}

function homeworkCounts(students, records) {
  const counts = { excellent: 0, copy: 0, wrong: 0, missing: 0, recorded: 0, unmarked: 0, total: students.length };
  const numbers = new Set(students.map(student => student.number));
  for (const [number, status] of Object.entries(records && typeof records === 'object' && !Array.isArray(records) ? records : {})) {
    if (!numbers.has(number) || !HOMEWORK_STATUS_SET.has(status)) continue;
    counts[status]++;
    counts.recorded++;
  }
  counts.unmarked = counts.total - counts.recorded;
  return counts;
}

function homeworkSummary(homework, students) {
  return {
    id: homework.id, title: homework.title, date: homework.date,
    createdAt: homework.createdAt, updatedAt: homework.updatedAt,
    counts: homeworkCounts(students, homework.records)
  };
}

function homeworkDetail(homework) {
  return {
    id: homework.id, title: homework.title, date: homework.date,
    createdAt: homework.createdAt, updatedAt: homework.updatedAt,
    records: sanitizeRecords(homework.records)
  };
}

function sortedHomework(item, newestFirst) {
  const entries = homeworkEntries(item).slice().sort((left, right) => {
    const byDate = String(left.date || '').localeCompare(String(right.date || ''));
    return byDate || String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  });
  return newestFirst ? entries.reverse() : entries;
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
  // Read-only access still waits for pending writes, so a draw that just
  // happened is visible without rewriting classes.json for every GET.
  async function inspect(operation) {
    await writes;
    return operation(await load());
  }
  function find(items, ownerId, id) {
    const item = items.find(item => item.id === id && item.ownerId === ownerId);
    if (!item) throw fail(404, '班级不存在或无权访问');
    return item;
  }
  // Draw history can hold 500 entries per class; homework can hold 200
  // sessions. List/detail responses only need roster metadata, so both have
  // their own endpoints and the class payload stays small.
  function publicItem(item) {
    if (!item || typeof item !== 'object') return item;
    const { drawLog, homework, ...rest } = item;
    return { ...rest, homeworkCount: Array.isArray(homework) ? homework.length : 0 };
  }
  return {
    async list(ownerId) { return (await load()).filter(item => item.ownerId === ownerId).map(publicItem); },
    async get(ownerId, id) { return publicItem(find(await load(), ownerId, id)); },
    draw(ownerId, id, mode) {
      if (!['name', 'number'].includes(mode)) throw fail(400, '抽取方式无效');
      return change(items => {
        const item = find(items, ownerId, id);
        if (!item.students.length) throw fail(400, '这个班级还没有学生，请先在管理界面录入名单');
        const { state, ...outcome } = nextDraw(candidates(item, mode), item.studentDraw);
        item.studentDraw = state;
        const student = item.students.find(entry => entry.number === outcome.candidate.id);
        item.drawLog = [...(Array.isArray(item.drawLog) ? item.drawLog : []), {
          number: String(outcome.candidate.id),
          name: student?.name || String(outcome.candidate.text || ''),
          mode, round: outcome.round, remaining: outcome.remaining, total: outcome.total,
          at: new Date().toISOString()
        }].slice(-DRAW_LOG_LIMIT);
        return outcome;
      });
    },
    drawLog(ownerId, id, { limit = DRAW_LOG_DEFAULT_LIMIT } = {}) {
      const size = Number.isSafeInteger(limit) ? Math.min(DRAW_LOG_LIMIT, Math.max(1, limit)) : DRAW_LOG_DEFAULT_LIMIT;
      return inspect(items => {
        const item = find(items, ownerId, id);
        const entries = Array.isArray(item.drawLog) ? item.drawLog : [];
        return { items: entries.slice(-size).reverse(), total: entries.length };
      });
    },
    clearDrawLog(ownerId, id) {
      return change(items => {
        const item = find(items, ownerId, id);
        const cleared = Array.isArray(item.drawLog) ? item.drawLog.length : 0;
        item.drawLog = [];
        return { cleared };
      });
    },
    homeworkList(ownerId, id) {
      return inspect(items => {
        const item = find(items, ownerId, id);
        const entries = sortedHomework(item, true);
        return { items: entries.map(entry => homeworkSummary(entry, item.students)), total: entries.length };
      });
    },
    createHomework(ownerId, id, body) {
      return change(items => {
        const item = find(items, ownerId, id);
        const title = textField(body?.title, '作业名称', 60);
        const date = homeworkDate(body?.date);
        if (!item.students.length) throw fail(400, '这个班级还没有学生，请先录入并保存名单');
        const homework = homeworkEntries(item);
        if (homework.length >= HOMEWORK_LIMIT) {
          throw fail(400, `每个班级最多保留 ${HOMEWORK_LIMIT} 次作业记录，请先删除不需要的记录`);
        }
        if (homework.some(entry => entry.date === date && entry.title === title)) {
          throw fail(409, '同一天已有同名作业，请直接选择该作业或换个名称');
        }
        const now = new Date().toISOString();
        const entry = { id: randomUUID(), title, date, records: {}, createdAt: now, updatedAt: now };
        item.homework = [...homework, entry];
        return homeworkDetail(entry);
      });
    },
    homeworkGet(ownerId, id, homeworkId) {
      return inspect(items => homeworkDetail(findHomework(find(items, ownerId, id), homeworkId)));
    },
    setHomeworkRecords(ownerId, id, homeworkId, body) {
      return change(items => {
        const item = find(items, ownerId, id);
        const homework = findHomework(item, homeworkId);
        const raw = body?.records;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, '请提供要登记的作业状态');
        const entries = Object.entries(raw);
        if (!entries.length) throw fail(400, '没有需要保存的作业登记');
        if (entries.length > 1000) throw fail(400, '一次提交的登记过多，请稍后重试');
        const numbers = new Set(item.students.map(student => student.number));
        // Validate the whole batch first so a bad entry cannot leave a
        // half-applied registration behind.
        for (const [number, status] of entries) {
          if (!numbers.has(number)) throw fail(400, '学生不在当前班级名单中，请刷新页面后重试');
          if (status !== null && !HOMEWORK_STATUS_SET.has(status)) throw fail(400, '作业状态无效');
        }
        const records = homework.records && typeof homework.records === 'object' && !Array.isArray(homework.records)
          ? homework.records : {};
        for (const [number, status] of entries) setRecord(records, number, status);
        homework.records = records;
        homework.updatedAt = new Date().toISOString();
        return {
          id: homework.id, updatedAt: homework.updatedAt,
          counts: homeworkCounts(item.students, records)
        };
      });
    },
    removeHomework(ownerId, id, homeworkId) {
      return change(items => {
        const item = find(items, ownerId, id);
        const homework = homeworkEntries(item);
        const index = homework.findIndex(entry => entry.id === homeworkId);
        if (index === -1) throw fail(404, '作业记录不存在或已删除');
        homework.splice(index, 1);
        item.homework = homework;
        return { ok: true, id: homeworkId };
      });
    },
    homeworkStats(ownerId, id) {
      return inspect(items => {
        const item = find(items, ownerId, id);
        const entries = sortedHomework(item, false);
        const assignments = entries.map(entry => homeworkSummary(entry, item.students));
        const totals = { excellent: 0, copy: 0, wrong: 0, missing: 0, recorded: 0, unmarked: 0, total: entries.length * item.students.length };
        const students = item.students.map(student => {
          const records = entries.map(entry => {
            const status = ownRecord(entry.records, student.number);
            return HOMEWORK_STATUS_SET.has(status) ? status : null;
          });
          const studentTotals = { excellent: 0, copy: 0, wrong: 0, missing: 0, recorded: 0, unmarked: 0, total: entries.length };
          for (const status of records) {
            if (status === null) continue;
            studentTotals[status]++;
            studentTotals.recorded++;
            totals[status]++;
            totals.recorded++;
          }
          studentTotals.unmarked = entries.length - studentTotals.recorded;
          return { number: student.number, name: student.name, records, totals: studentTotals };
        });
        totals.unmarked = totals.total - totals.recorded;
        return { assignments, students, totals };
      });
    },
    setCalibration(ownerId, id, body) {
      if (!body || (body.profile !== null && !validateProfile(body.profile))) throw fail(400, '校准数据无效，请重新校准');
      return change(items => {
        const item = find(items, ownerId, id);
        const revision = item.touchCalibrationRevision || 0;
        if (body.revision !== revision) throw fail(409, '校准已在其他大屏修改，请关闭后重新打开校准');
        const p = body.profile;
        item.touchCalibration = p === null ? null : { version: 1, matrix: [...p.matrix], width: p.width, height: p.height, fullscreen: p.fullscreen };
        item.touchCalibrationRevision = revision + 1;
        return { profile: item.touchCalibration, revision: item.touchCalibrationRevision };
      });
    },
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
        return publicItem(item);
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
