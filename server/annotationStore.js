const fs = require('node:fs/promises');
const path = require('node:path');
const { PresentationState } = require('./presentationState');

// Append-only journal: a stroke update writes only its new points. Each append
// is synced before acknowledgement; closing a lesson never removes its journal.
class AnnotationStore {
  constructor(root) { this.root = root; this.cache = new Map(); }
  file(id) { return path.join(this.root, `${id}.jsonl`); }
  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const notes = new PresentationState({ maxPoints: Infinity });
    notes.apply({ type: 'courseware.open', url: id, page: 1 });
    let raw = '';
    try { raw = await fs.readFile(this.file(id), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A power loss can leave one incomplete final record. Keep all committed
    // records and remove only that tail before the next append.
    const end = raw.lastIndexOf('\n') + 1;
    if (end !== raw.length) await fs.truncate(this.file(id), Buffer.byteLength(raw.slice(0, end)));
    for (const line of raw.slice(0, end).split('\n')) {
      if (!line) continue;
      const { message, role } = JSON.parse(line);
      notes.apply(message, role);
    }
    this.cache.set(id, notes);
    // Bound cached documents, never their saved strokes.
    if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
    return notes;
  }
  async apply(id, message, role) {
    const notes = await this.load(id);
    await fs.mkdir(this.root, { recursive: true });
    const file = await fs.open(this.file(id), 'a', 0o600);
    try { await file.writeFile(JSON.stringify({ message, role }) + '\n'); await file.sync(); }
    catch (error) { this.cache.delete(id); throw error; }
    finally { await file.close(); }
    notes.apply(message, role);
    return notes;
  }
  async remove(id) { this.cache.delete(id); await fs.rm(this.file(id), { force: true }); }
}

function normalizeAnnotation(message, page) {
  if (!['begin', 'points', 'end', 'clear', 'undo'].includes(message.action)) throw new Error('无效笔迹动作');
  const result = { type: 'courseware.annotation', action: message.action,
    page: Number(message.page) || page || 1 };
  if (!Number.isInteger(result.page) || result.page < 1 || result.page > 100000) throw new Error('无效笔迹页码');
  if (['begin', 'points', 'end'].includes(message.action)) {
    if (typeof message.strokeId !== 'string' || message.strokeId.length > 160 || !message.strokeId) throw new Error('无效笔迹编号');
    result.strokeId = message.strokeId;
  }
  if (['begin', 'points'].includes(message.action)) {
    if (!Array.isArray(message.points) || message.points.length > 10000 ||
        message.points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('无效笔迹坐标');
    result.points = message.points.map(p => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }));
  }
  if (message.action === 'begin') {
    result.color = /^#[\da-f]{6}$/i.test(message.color || message.colorHex) ? (message.color || message.colorHex) : '#ff4d6d';
    result.width = Math.max(1, Math.min(200, Number(message.width) || 4));
    result.isEraser = message.isEraser === true;
    result.lineMode = message.lineMode === true;
    result.mode = ['solid', 'dashed', 'dashdot', 'highlighter'].includes(message.mode) ? message.mode : 'solid';
  }
  return result;
}
module.exports = { AnnotationStore, normalizeAnnotation };
