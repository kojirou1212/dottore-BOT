# Discord AI Bot

Gemini AIを使った対話型Discordボットです。

## ファイル構成

```
├── bot.js          # メインエントリーポイント
├── ai-handler.js   # Gemini API 通信・会話履歴管理
├── config.json     # 設定ファイル（トークン・プロンプト等）
└── package.json    # 依存パッケージ定義
```

## セットアップ

### 1. 依存パッケージのインストール
```bash
npm install
```

### 2. config.json の作成

`config.json` を以下の内容で作成してください。

```json
{
  "discord": {
    "token": "YOUR_DISCORD_BOT_TOKEN",
    "targetChannelIds": ["YOUR_CHANNEL_ID"]
  },
  "gemini": {
    "apiKey": "YOUR_GEMINI_API_KEY",
    "model": "gemini-2.0-flash",
    "maxTokens": 1000,
    "maxHistoryLength": 20
  },
  "ai": {
    "systemPrompt": "あなたは親切なアシスタントです。",
    "errorMessage": "エラーが発生しました。しばらくしてからもう一度お試しください。",
    "typingIndicator": true
  }
}
```

| キー | 説明 |
|------|------|
| `discord.token` | Discord Bot のトークン |
| `discord.targetChannelIds` | 監視するチャンネルID（複数可） |
| `gemini.apiKey` | Gemini API キー（[Google AI Studio](https://aistudio.google.com/apikey) で取得） |
| `gemini.model` | 使用するモデル名（例: `gemini-2.0-flash`, `gemini-2.5-pro`） |
| `gemini.maxTokens` | 1回の返答の最大トークン数 |
| `gemini.maxHistoryLength` | 保持する会話履歴の最大件数 |
| `ai.systemPrompt` | AIへのシステムプロンプト（キャラクター設定など） |
| `ai.errorMessage` | エラー時にDiscordへ送信するメッセージ |
| `ai.typingIndicator` | 返答中のタイピング表示 ON/OFF |

### 3. Discord Bot の権限設定
Discord Developer Portal で以下を有効化してください。
- **Bot Permissions**: Send Messages, Read Message History
- **Privileged Gateway Intents**: Message Content Intent

### 4. 起動
```bash
npm start
```

## コマンド一覧

| コマンド | 説明 |
|----------|------|
| `!reset` | 自分の会話履歴をリセット |
| `!help` | ヘルプを表示 |
| （その他） | AIが対話形式で回答 |

## カスタマイズ例

### システムプロンプトの変更（config.json）
```json
"ai": {
  "systemPrompt": "あなたはゲームサーバーのサポート担当です。ゲームのルールや操作方法を丁寧に教えてください。"
}
```

### モデルの変更
```json
"gemini": {
  "model": "gemini-2.5-pro"
}
```

### 監視チャンネルの追加
```json
"discord": {
  "targetChannelIds": ["123456789", "987654321"]
}
```