const fs = require('node:fs/promises');

// Merge only fields changed since a read. A concurrent activity timestamp update
// must never restore an old password/token or erase a newly registered account.
function createUserStore(filename) {
  const snapshots = new WeakMap();
  let writes = Promise.resolve();
  async function load() {
    try {
      const users = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (!Array.isArray(users)) throw new Error('Invalid users database');
      return users;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function readUsers() {
    await writes;
    const users = await load();
    snapshots.set(users, structuredClone(users));
    return users;
  }
  function writeUsers(users) {
    const before = snapshots.get(users);
    if (!before) return Promise.reject(new Error('Users must be read before writing'));
    const after = structuredClone(users);
    const operation = writes.then(async () => {
      const current = await load();
      const oldById = new Map(before.map(user => [user.id, user]));
      const newById = new Map(after.map(user => [user.id, user]));
      const merged = current.filter(user => !oldById.has(user.id) || newById.has(user.id));
      for (const user of after) {
        const old = oldById.get(user.id);
        const latest = merged.find(item => item.id === user.id);
        if (!old) {
          if (latest || merged.some(item => item.username === user.username)) {
            throw new Error('User already exists');
          }
          merged.push(user);
          continue;
        }
        if (!latest) continue; // A concurrent deletion must not be undone.
        for (const key of new Set([...Object.keys(old), ...Object.keys(user)])) {
          if (JSON.stringify(old[key]) === JSON.stringify(user[key])) continue;
          if (key === 'lastLoginAt' && latest[key] > user[key]) continue;
          if (key === 'token' || key === 'passwordHash') {
            if (latest[key] !== old[key] && latest[key] !== user[key]) {
              throw new Error('Credentials changed concurrently; retry login');
            }
          }
          if (Object.hasOwn(user, key)) latest[key] = user[key];
          else delete latest[key];
        }
      }
      const temporary = `${filename}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(merged, null, 2), { mode: 0o600 });
      await fs.rename(temporary, filename);
      snapshots.set(users, after);
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return { readUsers, writeUsers };
}

module.exports = { createUserStore };
