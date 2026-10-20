const fs = require('node:fs/promises');
const multer = require('multer');
const { MAX_FONT_BYTES } = require('./fontStore');

function mountFontRoutes(app, { prefix, requireAuth, store, tempRoot }) {
  const upload = multer({ dest: tempRoot, limits: { fileSize: MAX_FONT_BYTES, files: 1, fields: 0 } });
  app.get(`${prefix}/api/fonts`, requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await store.list()); } catch (error) { next(error); }
  });
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
