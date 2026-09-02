#!/bin/bash
# 生成 MyClass HTTPS 自签证书，供 iPhone 网页版（iOS 摄像头需要安全上下文）使用。
#
# 用法：
#   SERVER_IP=10.30.13.1 bash scripts/generate-selfsigned-cert.sh
#
# 生成位置：server/data/tls/server.key 与 server/data/tls/server.crt
# 之后用 HTTPS_PORT=443 重启服务端即可：
#   HTTPS_PORT=443 PORT=3000 node server/server.js
#
# iPhone 首次访问 https://<SERVER_IP>/myclass/ios/ 时，Safari 会提示证书不受信任，
# 点“显示详细信息”->“访问此网站”即可；之后摄像头权限就能正常授予。
set -eu

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_IP="${SERVER_IP:-10.30.13.1}"
EXTRA_DNS="${EXTRA_DNS:-}"
OUT_DIR="${TLS_DIR:-$APP_DIR/server/data/tls}"
DAYS="${DAYS:-3650}"

mkdir -p "$OUT_DIR"
KEY_FILE="$OUT_DIR/server.key"
CRT_FILE="$OUT_DIR/server.crt"

if ! command -v openssl >/dev/null 2>&1; then
  echo "未找到 openssl，请先安装：apt install openssl / yum install openssl"
  exit 1
fi

SAN="IP:$SERVER_IP,DNS:localhost"
if [ -n "$EXTRA_DNS" ]; then
  IFS=',' read -ra DNS_LIST <<< "$EXTRA_DNS"
  for dns in "${DNS_LIST[@]}"; do
    dns="$(echo "$dns" | xargs)"
    [ -n "$dns" ] && SAN="$SAN,DNS:$dns"
  done
fi

echo "生成自签证书：CN=$SERVER_IP  SAN=$SAN"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY_FILE" \
  -out "$CRT_FILE" \
  -days "$DAYS" \
  -subj "/CN=$SERVER_IP/O=MyClass" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

chmod 600 "$KEY_FILE"
chmod 644 "$CRT_FILE"

echo "已生成："
echo "  $KEY_FILE"
echo "  $CRT_FILE"
echo
echo "启动服务端（HTTPS 供 iPhone 使用，HTTP 供教室大屏使用）："
echo "  HTTPS_PORT=443 PORT=3000 node $APP_DIR/server/server.js"
echo
echo "iPhone 访问地址：https://$SERVER_IP/myclass/ios/"
