// 课件 HTTP 接口（与 Android 端 ExternalFileReceiver / MainActivity 使用同一组接口）。

export class CoursewareClient {
  constructor({ apiBase, token }) {
    this.apiBase = apiBase; // 例如 http://host/myclass/api
    this.token = token;
  }

  setToken(token) {
    this.token = token;
  }

  async list() {
    const data = await this.#request('/courseware', { method: 'GET' });
    return Array.isArray(data?.items) ? data.items : [];
  }

  /**
   * 上传课件（multipart：file + displayNameBase64）。
   * @param {File} file
   * @param {(percent:number)=>void} onProgress
   * @param {AbortSignal} signal
   */
  upload(file, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('displayNameBase64', toBase64Utf8(file.name));
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.apiBase}/courseware`);
      xhr.responseType = 'text';
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && typeof onProgress === 'function') {
          onProgress(event.loaded / event.total);
        }
      };

      xhr.onload = () => {
        let payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload?.url) {
          resolve(payload);
          return;
        }
        reject(new Error(payload?.error || `课件上传失败：HTTP ${xhr.status}`));
      };

      xhr.onerror = () => reject(new Error('网络连接中断，请确认手机和服务器网络正常后重试'));
      xhr.onabort = () => reject(new Error('__ABORTED__'));
      xhr.ontimeout = () => reject(new Error('课件上传超时，请重试'));

      if (signal) {
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  }

  async rename(id, title) {
    return this.#request(`/courseware/${encodeURIComponent(id)}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ title })
    });
  }

  async remove(id) {
    return this.#request(`/courseware/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async #request(path, { method = 'GET', body = null } = {}) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== null) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body === null ? undefined : body,
      cache: 'no-store'
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(payload?.error || `请求失败：HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }
}

/** 中文课件名需要 UTF-8 -> base64，服务端用 decodeBase64Utf8 还原 */
function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function coursewareFormatLabel(item) {
  if (item?.linkUrl) return '链接';
  const source = item?.originalUrl || item?.url || '';
  const ext = String(source).split('?')[0].split('.').pop();
  return ext && ext.length <= 5 ? ext.toUpperCase() : '文件';
}
