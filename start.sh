#!/bin/bash
# Raspberry Pi 用起動スクリプト
set -e

echo "[Bot] 環境チェック中..."

# Node.js バージョン確認
NODE_VER=$(node -e "process.stdout.write(process.versions.node)" 2>/dev/null || echo "")
if [ -z "$NODE_VER" ]; then
  echo "[Bot] Node.js が見つかりません。インストール: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi
echo "[Bot] Node.js: v$NODE_VER"

# ffmpeg 確認（@discordjs/voice の音声再生に必要）
if ! command -v ffmpeg &>/dev/null; then
  echo "[Bot] ffmpeg が見つかりません。インストール中..."
  sudo apt-get install -y ffmpeg
fi
echo "[Bot] ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

# 依存パッケージインストール（初回のみ）
if [ ! -d "node_modules" ]; then
  echo "[Bot] npm install を実行中..."
  npm install
fi

# config.json 確認
if [ ! -f "config.json" ] && [ -z "$DISCORD_TOKEN" ]; then
  echo "[Bot] config.json が見つかりません。作成するか DISCORD_TOKEN 環境変数を設定してください。"
  exit 1
fi

echo "[Bot] 起動します..."
while true; do
  node bot.js
  echo "[Bot] プロセスが終了しました。5秒後に再起動します..."
  sleep 5
done
