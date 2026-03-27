# Discord AI Bot（ドットーレBot）

Gemini AIを使った対話型Discordボットです。

## ファイル構成

```
├── bot.js          # メインエントリーポイント
├── ai-handler.js   # Gemini API 通信・会話履歴管理
├── vc-handler.js   # VC接続・音声再生・AI音声選択
├── messages.json   # 定時メッセージ・コマンドセリフの設定ファイル
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
    "model": "gemini-2.5-flash",
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
| `gemini.model` | 使用するモデル名（例: `gemini-2.0-flash`, `gemini-2.5-flash`） |
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

---

## コマンド一覧

### 会話・履歴

| コマンド | 説明 |
|----------|------|
| `!reset` | 自分の会話履歴をリセット |
| `!resetall` | 全ユーザーの会話履歴を一括リセット |
| （その他メッセージ） | AIが対話形式で回答 |

### セリフ系

| コマンド | 説明 |
|----------|------|
| `!okusuri` | 薬を投与してもらう |
| `!sleep` | 就寝前、管理下で休む |
| `!pain` | 痛み・不調を報告する |
| `!work` | 作業・勉強を開始する |
| `!observe` | 観察してほしいとき |
| `!reward` | 成功・達成を報告する |

### VC（ボイスチャンネル）

| コマンド | 説明 |
|----------|------|
| `!kanshi [VC名]` | ドットーレをVCに召喚（引数なしで自分のVCに参加） |
| `!hakase [メッセージ]` | VCでドットーレに反応させる（AI選択で音声再生） |
| `!owari` | ドットーレをVCから退出させる |

### 管理

| コマンド | 説明 |
|----------|------|
| `!reload` | `messages.json` を再読み込み（再起動不要） |
| `!help` | ヘルプを表示 |

---

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

---

## メッセージ・セリフのカスタマイズ（messages.json）

コードを変更せずに、`messages.json` を編集するだけでセリフの追加・削除・変更ができます。

### セリフの編集

各リストに文字列を追加・削除するだけです。

```json
"okusuri": [
  "口を開けろ。……飲み込め。",
  "新しいセリフをここに追加できる。"
]
```

### 定時スケジュールの変更

`schedule` セクションのキー（時刻）と値（リスト名）を書き換えます。

```json
"schedule": {
  "9":  "ohayou",
  "12": "gokigenyou",
  "15": "kansatu",
  "18": "yorugohan",
  "21": "oyasumi",
  "0":  "nero"
}
```

新しいリスト名を追加する場合は、同じファイル内に対応するリストも追加してください。

```json
"newlist": [
  "セリフ1",
  "セリフ2"
]
```

### 反映方法

| 方法 | 手順 |
|------|------|
| 即時反映 | `!reload` コマンドを送信（再起動不要） |
| 再起動時 | botを再起動すると自動で読み込まれる |

---

## 自動処理（毎日 04:00 JST）

以下の処理が毎朝4時に自動実行されます。

1. 全ユーザーの会話履歴をリセット
2. botを自動再起動

Railway の `restartPolicyType = "always"` により、終了後に自動で再起動されます。

---

## 環境変数（Railway等）

| 変数名 | 説明 |
|--------|------|
| `DISCORD_TOKEN` | Discord Bot トークン |
| `TARGET_CHANNEL_IDS` | 監視チャンネルID（カンマ区切り） |
| `VOICE_CHANNEL_ID` | 参加するVCのチャンネルID |
| `GEMINI_API_KEY` | Gemini API キー |
| `GEMINI_MODEL` | モデル名（デフォルト: `gemini-2.5-flash`） |
| `MAX_TOKENS` | 最大トークン数（デフォルト: `1000`） |
| `MAX_HISTORY_LENGTH` | 会話履歴最大件数（デフォルト: `20`） |
| `SYSTEM_PROMPT` | システムプロンプト |
| `ERROR_MESSAGE` | エラーメッセージ |
| `TYPING_INDICATOR` | タイピング表示（`true` / `false`） |