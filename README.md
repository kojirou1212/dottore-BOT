# Discord AI Bot

Gemini AIを使った対話型Discordボットです。

## ファイル構成

```
├── bot.js          # メインエントリーポイント
├── ai-handler.js   # Gemini API 通信・会話履歴管理
├── vc-handler.js   # VC接続・音声再生・AI音声選択
├── config.json     # 設定ファイル（トークン・プロンプト等）
├── package.json    # 依存パッケージ定義
└── sounds/         # 音声ファイル置き場（mp3/ogg）
    └── README.md   # 配置するファイル一覧
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
    "targetChannelIds": ["YOUR_CHANNEL_ID"],
    "voiceChannelId": "YOUR_VOICE_CHANNEL_ID"
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
- **Bot Permissions**: Send Messages, Read Message History, **Connect, Speak**（VC機能に必要）
- **Privileged Gateway Intents**: Message Content Intent

### 4. 音声ファイルの配置

`sounds/` ディレクトリに音声ファイルを配置してください。  
詳細は `sounds/README.md` を参照。

### 5. 起動
```bash
npm start
```

## コマンド一覧

| コマンド | 説明 |
|----------|------|
| `!reset` | 自分の会話履歴をリセット |
| `!okusuri` | 薬を投与してもらう |
| `!sleep` | 就寝前、管理下で休む |
| `!pain` | 痛み・不調を報告する |
| `!work` | 作業・勉強を開始する |
| `!observe` | 観察してほしいとき |
| `!reward` | 成功・達成を報告する |
| `!kanshi [VC名]` | ドットーレをVCに召喚（引数なしで自分のVCに参加） |
| `!hakase [メッセージ]` | VCでドットーレに反応させる（AI選択で音声再生） |
| `!owari` | ドットーレをVCから退出させる |
| `!help` | ヘルプを表示 |
| （その他） | AIが対話形式で回答 |

## VC機能の使い方

```
1. !kanshi          → botが自分のいるVCに参加
   !kanshi 雑談      → 「雑談」という名前のVCに参加（部分一致OK）
   !kanshi 123456789 → チャンネルIDで直接指定して参加
2. !hakase 溜息ついて  → AIが最適な音声（溜息.mp3）を選んで再生
3. !hakase 笑って      → 笑い声系の音声を再生
4. !owari           → botがVCから退出
```

- 1セッション中に同じ音声は使用されません（重複なし）
- 全音声を使い切るとメッセージで通知されます
- `!owari` でセッションをリセットすれば再度使用可能

## 環境変数（Railway等）

| 変数名 | 説明 |
|--------|------|
| `DISCORD_TOKEN` | Discord Bot トークン |
| `TARGET_CHANNEL_IDS` | 監視チャンネルID（カンマ区切り） |
| `VOICE_CHANNEL_ID` | 参加するVCのチャンネルID |
| `GEMINI_API_KEY` | Gemini API キー |
| `GEMINI_MODEL` | モデル名（デフォルト: gemini-2.5-flash） |
| `MAX_TOKENS` | 最大トークン数（デフォルト: 1000） |
| `MAX_HISTORY_LENGTH` | 会話履歴最大件数（デフォルト: 20） |
| `SYSTEM_PROMPT` | システムプロンプト |
| `ERROR_MESSAGE` | エラーメッセージ |
| `TYPING_INDICATOR` | タイピング表示（true/false） |