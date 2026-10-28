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
const HOMEWORK_STATUS_LIMIT = 8;
const HOMEWORK_STATUS_TONES = ['green', 'orange', 'yellow', 'red', 'blue', 'purple', 'gray'];
const HOMEWORK_STATUS_TONE_SET = new Set(HOMEWORK_STATUS_TONES);
const HOMEWORK_STATUS_RESERVED_LABELS = new Set(['未登记', '已登记', '合计']);
const DEFAULT_HOMEWORK_STATUSES = [
  { id: 'excellent', label: '优秀', tone: 'green', archived: false },
  { id: 'copy', label: '涉抄', tone: 'orange', archived: false },
  { id: 'wrong', label: '错多', tone: 'yellow', archived: false },
  { id: 'missing', label: '未交', tone: 'red', archived: false }
];

function textField(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail(400, `${label}不能为空，且不能超过 ${maxLength} 个字符`);
  }
  return value.trim();
}

function statusLabelField(value) {
  const label = textField(value, '状态名称', 12);
  if (HOMEWORK_STATUS_RESERVED_LABELS.has(label)) throw fail(400, '该名称是系统保留列名，请换一个');
  return label;
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

function validStatusLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (!label || label.length > 12 || /[\x00-\x1f\x7f]/.test(label)) return null;
  return label;
}

function cloneStatus(status) {
  return { id: status.id, label: status.label, tone: status.tone, archived: Boolean(status.archived) };
}

function defaultHomeworkStatuses() {
  return DEFAULT_HOMEWORK_STATUSES.map(cloneStatus);
}

// Status lists are stored per class. Older classes have no list and keep the
// four original buttons; malformed entries fall back to the defaults rather
// than leaving the registration UI without any button.
function statusDefinitions(item) {
  const stored = Array.isArray(item?.homeworkStatuses) ? item.homeworkStatuses : [];
  const statuses = [];
  const ids = new Set();
  const labels = new Set();
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(entry.id)) continue;
    if (['recorded', 'unmarked', 'total', '__proto__', 'constructor', 'prototype'].includes(entry.id) || ids.has(entry.id)) continue;
    const label = validStatusLabel(entry.label);
    if (!label || labels.has(label) || HOMEWORK_STATUS_RESERVED_LABELS.has(label) || !HOMEWORK_STATUS_TONE_SET.has(entry.tone)) continue;
    ids.add(entry.id);
    labels.add(label);
    statuses.push({ id: entry.id, label, tone: entry.tone, archived: Boolean(entry.archived) });
  }
  if (!statuses.length) return defaultHomeworkStatuses();
  if (!statuses.some(status => !status.archived)) statuses[0].archived = false;
  return statuses;
}

function activeHomeworkStatuses(item) {
  return statusDefinitions(item).filter(status => !status.archived);
}

function homeworkStatusUsage(item, statusId) {
  let used = 0;
  for (const homework of homeworkEntries(item)) {
    for (const status of Object.values(homework.records && typeof homework.records === 'object' ? homework.records : {})) {
      if (status === statusId) used++;
    }
  }
  return used;
}

function statusesForClient(item) {
  return statusDefinitions(item).map(status => ({ ...status, usage: homeworkStatusUsage(item, status.id) }));
}

function sanitizeRecords(records, statuses) {
  const ids = new Set(statuses.map(status => status.id));
  const clean = {};
  for (const [number, status] of Object.entries(records && typeof records === 'object' && !Array.isArray(records) ? records : {})) {
    if (ids.has(status)) setRecord(clean, number, status);
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

function homeworkCounts(students, records, statuses) {
  const counts = { recorded: 0, unmarked: 0, total: students.length };
  for (const status of statuses) counts[status.id] = 0;
  const numbers = new Set(students.map(student => student.number));
  const ids = new Set(statuses.map(status => status.id));
  for (const [number, status] of Object.entries(records && typeof records === 'object' && !Array.isArray(records) ? records : {})) {
    if (!numbers.has(number) || !ids.has(status)) continue;
    counts[status]++;
    counts.recorded++;
  }
  counts.unmarked = counts.total - counts.recorded;
  return counts;
}

function homeworkSummary(homework, students, statuses) {
  return {
    id: homework.id, title: homework.title, date: homework.date,
    createdAt: homework.createdAt, updatedAt: homework.updatedAt,
    counts: homeworkCounts(students, homework.records, statuses)
  };
}

function homeworkDetail(homework, statuses) {
  return {
    id: homework.id, title: homework.title, date: homework.date,
    createdAt: homework.createdAt, updatedAt: homework.updatedAt,
    records: sanitizeRecords(homework.records, statuses)
  };
}

function newHomeworkStatusId(statuses) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `s${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    if (!statuses.some(status => status.id === id)) return id;
  }
  throw fail(500, '无法生成新的作业状态，请重试');
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
    const { drawLog, homework, homeworkStatuses, ...rest } = item;
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
        const statuses = statusDefinitions(item);
        const entries = sortedHomework(item, true);
        return {
          items: entries.map(entry => homeworkSummary(entry, item.students, statuses)),
          total: entries.length,
          statuses: statusesForClient(item)
        };
      });
    },
    homeworkStatusList(ownerId, id) {
      return inspect(items => ({ items: statusesForClient(find(items, ownerId, id)) }));
    },
    createHomeworkStatus(ownerId, id, body) {
      return change(items => {
        const item = find(items, ownerId, id);
        const statuses = statusDefinitions(item);
        if (statuses.filter(status => !status.archived).length >= HOMEWORK_STATUS_LIMIT) {
          throw fail(400, `最多同时启用 ${HOMEWORK_STATUS_LIMIT} 个作业状态`);
        }
        const label = statusLabelField(body?.label);
        const tone = body?.tone === undefined ? 'blue' : body.tone;
        if (!HOMEWORK_STATUS_TONE_SET.has(tone)) throw fail(400, '状态颜色无效');
        if (statuses.some(status => status.label === label)) throw fail(409, '已存在同名作业状态');
        const status = { id: newHomeworkStatusId(statuses), label, tone, archived: false };
        item.homeworkStatuses = [...statuses, status];
        return { items: statusesForClient(item), status: cloneStatus(status) };
      });
    },
    updateHomeworkStatus(ownerId, id, statusId, body) {
      return change(items => {
        const item = find(items, ownerId, id);
        const statuses = statusDefinitions(item);
        const status = statuses.find(entry => entry.id === statusId);
        if (!status) throw fail(404, '作业状态不存在或已删除');
        if (body?.label !== undefined) {
          const label = statusLabelField(body.label);
          if (statuses.some(entry => entry.id !== status.id && entry.label === label)) {
            throw fail(409, '已存在同名作业状态');
          }
          status.label = label;
        }
        if (body?.tone !== undefined) {
          if (!HOMEWORK_STATUS_TONE_SET.has(body.tone)) throw fail(400, '状态颜色无效');
          status.tone = body.tone;
        }
        if (body?.archived !== undefined) {
          const archived = Boolean(body.archived);
          if (archived !== status.archived) {
            if (archived && statuses.filter(entry => !entry.archived).length <= 1) {
              throw fail(400, '至少保留一个可用的作业状态');
            }
            if (!archived && statuses.filter(entry => !entry.archived).length >= HOMEWORK_STATUS_LIMIT) {
              throw fail(400, `最多同时启用 ${HOMEWORK_STATUS_LIMIT} 个作业状态`);
            }
            status.archived = archived;
          }
        }
        item.homeworkStatuses = statuses;
        return { items: statusesForClient(item), status: cloneStatus(status) };
      });
    },
    removeHomeworkStatus(ownerId, id, statusId) {
      return change(items => {
        const item = find(items, ownerId, id);
        const statuses = statusDefinitions(item);
        const status = statuses.find(entry => entry.id === statusId);
        if (!status) throw fail(404, '作业状态不存在或已删除');
        if (!status.archived && statuses.filter(entry => !entry.archived).length <= 1) {
          throw fail(400, '至少保留一个可用的作业状态');
        }
        // A status already used by history is archived instead of removed so
        // past assignments keep a readable label and count.
        const used = homeworkStatusUsage(item, statusId);
        if (used) status.archived = true;
        else statuses.splice(statuses.indexOf(status), 1);
        item.homeworkStatuses = statuses;
        return { items: statusesForClient(item), archived: Boolean(used), used };
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
        return homeworkDetail(entry, statusDefinitions(item));
      });
    },
    homeworkGet(ownerId, id, homeworkId) {
      return inspect(items => {
        const item = find(items, ownerId, id);
        return homeworkDetail(findHomework(item, homeworkId), statusDefinitions(item));
      });
    },
    setHomeworkRecords(ownerId, id, homeworkId, body) {
      return change(items => {
        const item = find(items, ownerId, id);
        const homework = findHomework(item, homeworkId);
        const statuses = statusDefinitions(item);
        const activeIds = new Set(activeHomeworkStatuses(item).map(status => status.id));
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
          if (status !== null && !activeIds.has(status)) throw fail(400, '作业状态无效或已停用');
        }
        const records = homework.records && typeof homework.records === 'object' && !Array.isArray(homework.records)
          ? homework.records : {};
        for (const [number, status] of entries) setRecord(records, number, status);
        homework.records = records;
        homework.updatedAt = new Date().toISOString();
        return {
          id: homework.id, updatedAt: homework.updatedAt,
          counts: homeworkCounts(item.students, records, statuses)
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
        const statuses = statusDefinitions(item);
        const statusIds = new Set(statuses.map(status => status.id));
        const entries = sortedHomework(item, false);
        const assignments = entries.map(entry => homeworkSummary(entry, item.students, statuses));
        const totals = { recorded: 0, unmarked: 0, total: entries.length * item.students.length };
        for (const status of statuses) totals[status.id] = 0;
        const students = item.students.map(student => {
          const records = entries.map(entry => {
            const status = ownRecord(entry.records, student.number);
            return statusIds.has(status) ? status : null;
          });
          const studentTotals = { recorded: 0, unmarked: 0, total: entries.length };
          for (const status of statuses) studentTotals[status.id] = 0;
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
        return { statuses: statusesForClient(item), assignments, students, totals };
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
