// 构建后自动把 Android 的 versionName 同步写入 server/data/versions.json 的 appVersion，
// 确保 web 大屏主页显示的版本号与 APK 永远一致（无需手动维护）。
const fs = require('fs');
const path = require('path');

const here = __dirname;
const gradlePath = path.join(here, 'app', 'build.gradle.kts');
const versionsPath = path.join(here, '..', '..', 'server', 'data', 'versions.json');

const gradleText = fs.readFileSync(gradlePath, 'utf8');
const m = gradleText.match(/versionName\s*=\s*"([^"]+)"/);
if (!m) {
  console.error('[update-apk-version] 未在 build.gradle.kts 找到 versionName');
  process.exit(1);
}
const version = m[1];

const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
if (versions.appVersion !== version) {
  versions.appVersion = version;
  fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');
  console.log('[update-apk-version] 已更新 versions.json appVersion -> ' + version);
} else {
  console.log('[update-apk-version] versions.json appVersion 已是 ' + version + '，无需更新');
}
