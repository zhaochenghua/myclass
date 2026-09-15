// One bounded snapshot per classroom, updated even while the viewer is offline.
class PresentationState {
  constructor() { this.reset(); }
  reset() {
    this.open = null;
    this.page = 1;
    this.viewport = null;
    this.strokes = [];
    this.active = new Map();
    this.points = 0;
    this.truncated = false;
    this.pageCount = 0;
  }
  apply(message, role) {
    const type = message.type;
    if (['courseware.close', 'viewer.courseware.close', 'teacher.stop', 'webrtc.offer'].includes(type)) {
      this.reset();
      return;
    }
    if (type === 'courseware.open' || type === 'viewer.courseware.open') {
      if (this.open?.url !== message.url) this.reset();
      this.open = { ...message, type: 'courseware.open' };
      this.page = Math.max(1, Number(message.page) || 1);
      return;
    }
    if (!this.open) return;
    if (type === 'courseware.page' || (type === 'courseware.state' && role === 'viewer')) {
      if (message.url && message.url !== this.open.url) return;
      if (type === 'courseware.state') this.pageCount = Math.max(0, Number(message.pageCount) || 0);
      const page = Math.min(this.pageCount || Infinity, Math.max(1, Math.floor(Number(message.page) || 1)));
      if (this.page !== page) this.viewport = null;
      this.page = page;
    }
    if (type === 'courseware.navigate') {
      this.page = Math.min(this.pageCount || Infinity, Math.max(1, this.page + (Number(message.delta) < 0 ? -1 : 1)));
      this.viewport = null;
    }
    if (type === 'courseware.image.viewport') {
      if (Number(message.page) > 0 && Number(message.page) !== this.page) return;
      this.viewport = { ...message };
    }
    if (!['courseware.annotation', 'viewer.annotation'].includes(type)) return;
    const page = Number(message.page) || this.page;
    const id = `${role}:${message.strokeId}`;
    const points = Array.isArray(message.points) ? message.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
    switch (message.action) {
      case 'begin': {
        if (this.active.has(id)) return;
        const stroke = { ...message, page, points: points.slice(), key: id };
        this.active.set(id, stroke);
        this.points += points.length;
        break;
      }
      case 'points': {
        const stroke = this.active.get(id);
        if (stroke) { for (const point of points) stroke.points.push(point); this.points += points.length; }
        break;
      }
      case 'end': {
        const stroke = this.active.get(id);
        if (stroke) { this.strokes.push(stroke); this.active.delete(id); }
        break;
      }
      case 'clear':
        this.strokes = this.strokes.filter(s => s.page !== page);
        for (const [key, stroke] of this.active) if (stroke.page === page) this.active.delete(key);
        this.recount();
        break;
      case 'undo': {
        // Commit partial strokes before undo, just as the viewer does.
        for (const [key, stroke] of this.active) {
          if (stroke.page === page) { this.strokes.push(stroke); this.active.delete(key); }
        }
        const index = this.strokes.findLastIndex(s => s.page === page);
        if (index >= 0) this.strokes.splice(index, 1);
        this.recount();
        break;
      }
    }
    // Keep memory bounded; evict whole oldest strokes rather than corrupting JSON.
    while (this.points > 500000 && this.strokes.length) {
      this.points -= this.strokes.shift().points.length;
      this.truncated = true;
    }
    if (this.points > 500000) {
      this.active.clear();
      this.truncated = true;
      this.recount();
    }
  }
  recount() { this.points = [...this.strokes, ...this.active.values()].reduce((n, s) => n + s.points.length, 0); }
  snapshot() {
    return this.open ? {
      open: { ...this.open, page: this.page }, viewport: this.viewport,
      strokes: this.strokes, active: [...this.active.values()], truncated: this.truncated
    } : null;
  }
}
module.exports = { PresentationState };
