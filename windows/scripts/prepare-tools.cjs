const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const extract = require('extract-zip');

(async () => {
  const root = path.resolve(__dirname, '..');
  const archive = path.join(root, 'third_party', 'gInk_v1.1.1.zip');
  const checksum = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (checksum !== '59dc0b93d5cfafd627f15b54a5000034fa0ed16ff48b88e85aa63f1aa7fa1a36') throw new Error('gInk archive checksum mismatch');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  await extract(archive, { dir: tools });
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  // Official gInk and Microsoft.Ink are 32-bit; the host must use the same CLR bitness.
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x86', '/optimize+', `/out:${tools}/MyClassDesktopTools.exe`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', path.join(root, 'native', 'DesktopTools.cs')], { stdio: 'inherit', windowsHide: true });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
