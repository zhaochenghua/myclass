const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(
  repoRoot,
  'android',
  'AndroidStudioProject',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk'
);
const targetDir = path.join(repoRoot, 'web', 'public');
const target = path.join(targetDir, 'myclass.apk');

if (!fs.existsSync(source)) {
  console.error(`未找到 APK：${source}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`已复制 APK 到：${target}`);
