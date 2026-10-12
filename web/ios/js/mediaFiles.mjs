export function mediaKind(value, mime = '') {
  const name = String(value || '').split(/[?#]/)[0];
  if (/^image\//i.test(mime) || /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(name)) return 'image';
  if (/^video\//i.test(mime) || /\.(mp4|mov|avi|webm|mkv|3gp|m4v)$/i.test(name)) return 'video';
  return 'other';
}

export function jpegName(name) {
  return (String(name || '照片').replace(/\.[^.]+$/, '') || '照片') + '.jpg';
}

export function checkAborted(signal) {
  if (signal?.aborted) throw new Error('__ABORTED__');
}

// Bound decoded image/canvas memory on Safari, even when foreground and preload overlap.
let preparation = Promise.resolve();
export function prepareImageFile(file, { signal, maxEdge = 1920 } = {}) {
  const task = preparation.catch(() => {}).then(async () => {
    checkAborted(signal);
    const image = new Image();
    const url = URL.createObjectURL(file);
    const canvas = document.createElement('canvas');
    try {
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          clearTimeout(timer); image.onload = image.onerror = null;
          signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve();
        };
        const abort = () => finish(new Error('__ABORTED__'));
        image.onload = () => finish();
        image.onerror = () => finish(new Error('无法读取照片，请从相册选择兼容图片，或将 HEIC 照片导出为 JPEG 后重试'));
        timer = setTimeout(() => finish(new Error('读取照片超时，请重新选择照片')), 20000);
        signal?.addEventListener('abort', abort, { once: true });
        image.src = url;
      });
      checkAborted(signal);
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('照片尺寸无效');
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('图片处理内存不足，请减少所选照片数量');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // Safari's image decoder applies EXIF orientation. Baking pixels into JPEG
      // makes the phone preview and classroom image use identical orientation.
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('照片转换超时')), 20000);
        canvas.toBlob(result => { clearTimeout(timer); result ? resolve(result) : reject(new Error('照片转换失败')); }, 'image/jpeg', 0.85);
      });
      checkAborted(signal);
      return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
    } finally {
      image.removeAttribute('src'); URL.revokeObjectURL(url);
      canvas.width = canvas.height = 0;
    }
  });
  preparation = task.catch(() => {});
  return task;
}

// Shared by foreground selection and background preparation: one upload per item.
export function ensureMediaUploaded(item, client, onProgress) {
  if (onProgress) item.onUploadProgress = onProgress;
  if (item.url) return Promise.resolve(item);
  if (item.uploadTask) return item.uploadTask;
  item.controller = new AbortController();
  const signal = item.controller.signal;
  item.status = 'uploading';
  item.uploadTask = (async () => {
    try {
      const file = item.preparedFile || (item.kind === 'image' ? await prepareImageFile(item.file, { signal }) : item.file);
      checkAborted(signal);
      item.preparedFile = file;
      item.uploadId ||= `ios-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await client.upload(file, ratio => item.onUploadProgress?.(ratio), signal, item.uploadId);
      checkAborted(signal);
      Object.assign(item, { status: 'ready', url: result.url, title: result.title || item.name, id: result.id || null });
      return item;
    } catch (error) { item.status = 'failed'; throw error; }
    finally { item.uploadTask = null; item.controller = null; item.onUploadProgress = null; }
  })();
  return item.uploadTask;
}
