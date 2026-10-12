const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY = 86400000;
const METRICS = ['logins', 'connections', 'presentations', 'realtime', 'uploads', 'rolls', 'uploadBytes'];
const emptyCounts = () => Object.fromEntries(METRICS.map(key => [key, 0]));
const chinaDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);

function dateRange(from, to, now = Date.now()) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to || to > chinaDay(now) ||
      (Date.parse(to) - Date.parse(from)) / DAY >= 366) {
    throw Object.assign(new Error('请选择有效日期范围，最多 366 天，结束日期不能晚于今天'), { status: 400 });
  }
  const days = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += DAY) days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}

// Daily aggregates, not raw messages. No tokens, URLs, IPs or student data are stored.
// Serialize writes and replace files atomically; a restart never resets past totals.
function createUsageStore(root, { now = Date.now } = {}) {
  let queue = Promise.resolve();
  let ready;
  async function read(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  async function write(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  function initialize() {
    if (!ready) ready = (async () => {
      await fs.mkdir(root, { recursive: true });
      const file = path.join(root, 'meta.json');
      let meta = await read(file, null);
      if (!meta) { meta = { schema: 1, startedAt: new Date(now()).toISOString() }; await write(file, meta); }
      return meta;
    })().catch(error => { ready = null; throw error; });
    return ready;
  }
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function record(user, metric, { bytes = 0, uniqueId = '' } = {}) {
    if (!METRICS.includes(metric) || metric === 'uploadBytes') return Promise.reject(new Error('Invalid usage metric'));
    const at = now();
    // Snapshot trusted identity now; don't hold live user objects or credentials.
    const id = user?.id || '__anonymous__';
    const username = user?.username || '未登录设备';
    return serial(async () => {
      await initialize();
      const date = chinaDay(at);
      const file = path.join(root, `${date}.json`);
      const daily = await read(file, { date, users: [], seen: [] });
      const dedup = uniqueId ? crypto.createHash('sha256').update(`${id}:${metric}:${uniqueId}`).digest('hex') : '';
      if (dedup && daily.seen.includes(dedup)) return;
      let row = daily.users.find(item => item.id === id);
      if (!row) { row = { id, username, ...emptyCounts(), lastAt: '' }; daily.users.push(row); }
      row.username = username;
      row[metric]++;
      if (metric === 'uploads' && Number.isFinite(bytes) && bytes > 0) row.uploadBytes += bytes;
      row.lastAt = new Date(at).toISOString();
      if (dedup) daily.seen.push(dedup);
      await write(file, daily);
    });
  }
  function report({ from, to, users = [] }) {
    const days = dateRange(from, to, now());
    return serial(async () => {
      const meta = await initialize();
      const current = new Map(users.map(user => [user.id, user]));
      const rows = new Map(users.map(user => [user.id, {
        id: user.id, username: user.username, role: user.role || (user.username === 'admin' ? 'admin' : 'user'),
        ...emptyCounts(), activeDays: 0, lastAt: null
      }]));
      const totals = emptyCounts();
      const daily = [];
      for (const date of days) {
        const data = await read(path.join(root, `${date}.json`), { users: [] });
        const day = { date, ...emptyCounts(), activeUsers: 0 };
        for (const item of data.users) {
          let row = rows.get(item.id);
          if (!row) {
            row = { id: item.id, username: item.username, role: item.id === '__anonymous__' ? 'anonymous' : 'deleted',
              ...emptyCounts(), activeDays: 0, lastAt: null };
            rows.set(item.id, row);
          }
          for (const key of METRICS) { row[key] += item[key]; day[key] += item[key]; totals[key] += item[key]; }
          row.activeDays++;
          row.lastAt = item.lastAt;
          if (item.id !== '__anonymous__') day.activeUsers++;
        }
        daily.push(day);
      }
      return { from, to, timeZone: 'Asia/Shanghai', startedAt: meta.startedAt,
        generatedAt: new Date(now()).toISOString(), totals: { ...totals,
          activeUsers: [...rows.values()].filter(row => row.activeDays && row.role !== 'anonymous').length,
          registeredUsers: current.size }, daily,
        users: [...rows.values()].sort((a, b) => b.activeDays - a.activeDays || b.presentations - a.presentations || a.username.localeCompare(b.username, 'zh-CN')) };
    });
  }
  return { record, report, initialize };
}

module.exports = { createUsageStore, chinaDay, dateRange };
