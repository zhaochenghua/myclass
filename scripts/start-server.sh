#!/bin/bash
# MyClass 服务端启动脚本
# 用途：开机自启 / 手动重启，防重复启动，日志持久化
set -u
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

APP_DIR="/opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass"
LOG_FILE="/home/zch/myclass-server.log"
PORT="${PORT:-3000}"

# 已在监听则跳过（防重复启动）
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "[$(date '+%F %T')] Port $PORT already listening, skip start." >> "$LOG_FILE"
  exit 0
fi

cd "$APP_DIR" || { echo "[$(date '+%F %T')] ERROR: cd $APP_DIR failed" >> "$LOG_FILE"; exit 1; }

# 清理可能残留的旧日志过大问题：保留 5MB 内
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv "$LOG_FILE" "$LOG_FILE.old"
fi

nohup node server/server.js >> "$LOG_FILE" 2>&1 &
PID=$!
echo "[$(date '+%F %T')] MyClass server started, PID=$PID, port=$PORT" >> "$LOG_FILE"

# 等待 2 秒确认真的起来了（避免端口被占/启动即崩）
sleep 2
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "[$(date '+%F %T')] OK: listening on :$PORT" >> "$LOG_FILE"
else
  echo "[$(date '+%F %T')] WARN: not listening on :$PORT yet, check log tail:" >> "$LOG_FILE"
  tail -20 "$LOG_FILE" >> "$LOG_FILE"
fi
