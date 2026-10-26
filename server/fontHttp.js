const fs = require('node:fs/promises');
const multer = require('multer');
const { MAX_FONT_BYTES } = require('./fontStore');

function mountFontRoutes(app, { prefix, requireAuth, store, tempRoot, missingState, regenerate }) {
  const upload = multer({ dest: tempRoot, limits: { fileSize: MAX_FONT_BYTES, files: 1, fields: 0 } });
  app.get(`${prefix}/api/fonts`, requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const list = await store.list();
      // Missing-font state must never prevent browsing the installed fonts.
      const state = missingState
        ? await missingState(req.user).catch(error => {
          console.warn('缺少字体统计不可用:', error.message);
          return null;
        })
        : null;
      res.json(state ? { ...list, ...state } : list);
    } catch (error) { next(error); }
  });
  if (regenerate) {
    // Called by the admin page after a batch of uploads; re-converts the
    // courseware whose missing fonts were just installed.
    app.post(`${prefix}/api/fonts/regenerate`, requireAuth, async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try { res.json(await regenerate({ force: req.query.force === '1' })); }
      catch (error) { next(error); }
    });
  }
  app.post(`${prefix}/api/fonts`, requireAuth, (req, res, next) => {
    upload.single('file')(req, res, async error => {
      try {
        if (error) {
          const tooLarge = error.code === 'LIMIT_FILE_SIZE';
          return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? '单个字体不能超过 64MB' : '每次请求只能上传一个字体文件' });
        }
        if (!req.file) return res.status(400).json({ error: '请选择字体文件' });
        const result = await store.install(req.file.path, req.file.originalname);
        res.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) { next(error); }
      finally { if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {}); }
    });
  });
}

module.exports = { mountFontRoutes };
