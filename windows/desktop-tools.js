const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

class NativeTool extends EventEmitter {
  constructor(executable, args, cwd) {
    super();
    this.pending = [];
    this.closed = false;
    this.child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', data => console.warn('[DesktopTools]', String(data).trim()));
    this.child.stdin.on('error', () => {});
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('桌面工具启动超时')); this.stop(); }, 10000);
      let buffer = '';
      this.child.stdout.on('data', data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === 'ready') { clearTimeout(timeout); resolve(); }
          else if (message.type === 'ack') this.pending.shift()?.resolve();
          else if (message.type === 'error') {
            const error = new Error(message.message);
            clearTimeout(timeout); reject(error);
            this.pending.shift()?.reject(error);
            this.emit('tool-error', error);
          } else this.emit('message', message);
        }
      });
      const close = error => {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(timeout);
        reject(error);
        this.pending.splice(0).forEach(item => item.reject(error));
        this.emit('closed');
      };
      this.child.on('error', close);
      this.child.on('exit', () => close(new Error('桌面工具已退出')));
    });
  }
  async command(command) {
    await this.ready;
    if (this.closed) throw new Error('桌面工具已退出');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('桌面工具没有响应')); this.stop(); }, 10000);
      this.pending.push({ resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(command + '\n');
    });
  }
  stop() {
    this.child.stdin.end('quit\n');
    const timer = setTimeout(() => { if (!this.closed) this.child.kill(); }, 1500);
    timer.unref();
  }
}

function createDesktopTools({ app, onInkState, onError }) {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'desktop-tools') : path.join(__dirname, 'tools');
  const executable = path.join(root, 'MyClassDesktopTools.exe');
  let cursor = null, ink = null;
  let cursorGeneration = 0;
  const create = (mode, args = [], cwd) => {
    if (!fs.existsSync(executable)) throw new Error('缺少桌面工具，请运行 npm run prepare-tools 后重新打包');
    const tool = new NativeTool(executable, [mode, String(process.pid), ...args], cwd);
    tool.on('tool-error', onError);
    return tool;
  };
  const prepareInk = () => {
    const directory = path.join(app.getPath('userData'), 'gink', '1.1.1');
    const source = path.join(root, 'gInk_v1.1.1');
    fs.mkdirSync(directory, { recursive: true });
    // Keep user preferences across upgrades; binaries always come from the pinned bundle.
    for (const name of fs.readdirSync(source)) {
      const destination = path.join(directory, name);
      if (name.endsWith('.ini') && fs.existsSync(destination)) continue;
      fs.cpSync(path.join(source, name), destination, { recursive: true });
    }
    const configFile = path.join(directory, 'config.ini');
    if (!fs.existsSync(path.join(directory, '.myclass-configured'))) {
      const config = fs.readFileSync(configFile, 'utf8')
        .replace(/Language_File\s*=.*$/m, 'Language_File = zh-cn')
        .replace(/^Allow_Dragging_Toolbar\s*=.*$/m, 'Allow_Dragging_Toolbar = True');
      fs.writeFileSync(configFile, config);
      fs.writeFileSync(path.join(directory, '.myclass-configured'), '1');
    }
    const hotkeys = path.join(directory, 'hotkeys.ini');
    fs.writeFileSync(hotkeys, fs.readFileSync(hotkeys, 'utf8').replace(/^Hotkey_Global\s*=.*$/m, 'Hotkey_Global = None'));
    return { directory, assembly: path.join(directory, 'gInk.exe') };
  };
  return {
    async setCursor(enabled) {
      const generation = ++cursorGeneration;
      if (!enabled) { cursor?.stop(); cursor = null; return; }
      if (!cursor || cursor.closed) cursor = create('cursor');
      const tool = cursor;
      await tool.ready;
      if (generation === cursorGeneration) await tool.command('on');
    },
    async setInk(enabled) {
      if (!enabled) { if (ink && !ink.closed) await ink.command('off'); return; }
      if (!ink || ink.closed) {
        const prepared = prepareInk();
        const tool = create('ink', [prepared.assembly], prepared.directory);
        ink = tool;
        tool.on('message', message => { if (ink === tool && message.type === 'ink-state') onInkState(message.active); });
        tool.on('closed', () => { if (ink === tool) onInkState(false); });
      }
      await ink.command('on');
    },
    async toggleInkPointer() { if (ink && !ink.closed) await ink.command('pointer'); },
    stopInk() { ink?.stop(); ink = null; onInkState(false); },
    dispose() { cursorGeneration++; cursor?.stop(); ink?.stop(); cursor = ink = null; }
  };
}

module.exports = { createDesktopTools, NativeTool };
