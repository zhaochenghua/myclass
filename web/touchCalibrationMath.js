(function (root) {
  'use strict';
  const targets = [{ x: .12, y: .18 }, { x: .88, y: .18 }, { x: .88, y: .82 }, { x: .12, y: .82 }, { x: .5, y: .5 }];
  function validateProfile(p) {
    if (!p || p.version !== 1 || !Array.isArray(p.matrix) || p.matrix.length !== 6 ||
        !p.matrix.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 4)) return false;
    const [a, b, c, d, e, f] = p.matrix;
    return a >= .5 && a <= 2 && e >= .5 && e <= 2 && Math.abs(b) <= .5 && Math.abs(d) <= .5 &&
      Math.abs(c) <= .4 && Math.abs(f) <= .4 && a * e - b * d >= .25 &&
      Number.isInteger(p.width) && p.width >= 200 && p.width <= 16384 &&
      Number.isInteger(p.height) && p.height >= 200 && p.height <= 16384 && typeof p.fullscreen === 'boolean';
  }
  function apply(matrix, point) {
    const [a, b, c, d, e, f] = matrix;
    return { x: a * point.x + b * point.y + c, y: d * point.x + e * point.y + f };
  }
  function fit(samples, viewport) {
    if (samples.length !== targets.length || samples.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('请完成五点校准');
    const rows = samples.map(p => [p.x, p.y, 1]);
    const matrix = [0, 1, 2].map(i => [0, 1, 2].map(j => rows.reduce((s, r) => s + r[i] * r[j], 0))
      .concat(['x', 'y'].map(axis => rows.reduce((s, r, k) => s + r[i] * targets[k][axis], 0))));
    for (let i = 0; i < 3; i++) {
      let pivot = i;
      for (let j = i + 1; j < 3; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
      [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
      const divisor = matrix[i][i];
      if (Math.abs(divisor) < 1e-8) throw new Error('触点过于集中，请依次点击十字中心');
      matrix[i] = matrix[i].map(n => n / divisor);
      for (let j = 0; j < 3; j++) if (j !== i) {
        const factor = matrix[j][i];
        matrix[j] = matrix[j].map((n, k) => n - factor * matrix[i][k]);
      }
    }
    const profile = { version: 1, ...viewport, matrix: [matrix[0][3], matrix[1][3], matrix[2][3], matrix[0][4], matrix[1][4], matrix[2][4]] };
    if (!validateProfile(profile)) throw new Error('偏差过大或点击顺序错误，请重新校准');
    const maxError = Math.max(...samples.map((p, i) => {
      const q = apply(profile.matrix, p);
      return Math.hypot((q.x - targets[i].x) * viewport.width, (q.y - targets[i].y) * viewport.height);
    }));
    if (maxError > Math.max(12, Math.min(viewport.width, viewport.height) * .015)) throw new Error('触点不一致，请用同一支笔或手指重新校准');
    return profile;
  }
  const api = { targets, fit, apply, validateProfile };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TouchCalibrationMath = api;
})(typeof globalThis === 'object' ? globalThis : this);
