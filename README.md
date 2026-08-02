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
"ohayou": [
  "【9:00】「起きろ、被検体。……飲み込め。」",
  "【9:00】「新しいセリフをここに追加できる。」"
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

---

# X (Twitter) Bot（ドットーレ Twitter版）

Discord版と同じGrok(xAI) APIでキャラクターとしての文章を生成し、X（旧Twitter）に投稿する追加コンポーネントです。`twitter-bot.js` / `twitter-handler.js` として独立したpm2プロセスで動作します。

## 前提・注意事項

- **X APIは2026年2月に無料枠が廃止され、従量課金制**になっています（投稿$0.015/件、読み取り$0.005/件、目安で月数ドル程度）。支払い方法の登録が必須です。
- **鍵垢（非公開アカウント）にする設定はAPIではなくXのアカウント設定側**で行います（下記手順4）。APIキー自体に鍵垢/公開の区別はありません。
- 現状はリプライの送信者がフォロワーかどうかに関わらず、メンションされたら反応します。鍵垢運用なら実質フォロワー以外は絡んでこない想定ですが、絞りたい場合は今後 `getMentions` 側でフォロー関係を確認する処理を追加できます。

## セットアップ手順

### 1. X (Twitter) アカウントの用意
Botとして動かす用のXアカウントを作成（または既存アカウントを利用）してください。

### 2. Developer Portalでアプリを作成
1. https://developer.x.com/ にアクセスし、Bot用アカウントでログインして開発者登録
2. 「Projects & Apps」から新しいAppを作成
3. App の **User authentication settings** で以下を設定
   - App permissions: **Read and Write**（リプライ・投稿に必須）
   - Type of App: Web App / Native App など任意（OAuth1.0aのKey/Secret発行が目的）
4. **Keys and tokens** タブで以下を発行・控える
   - API Key / API Key Secret
   - Access Token / Access Token Secret
   - ⚠️ **Read and Write に権限変更した後は、Access Token/Secretを再発行**しないと権限が反映されず投稿がエラーになります

### 3. 支払い方法の登録
Developer Portalの請求設定から支払い方法を登録してください（従量課金のため必須）。

### 4. アカウントを鍵垢に設定
X本体の「設定 → プライバシーと安全 → 投稿を非公開にする」をON（Bot用アカウントにログインして手動設定）。

### 5. twitter-config.json の作成
プロジェクト直下の `twitter-config.json` に取得したキーを設定してください（雛形は作成済み）。

```json
{
  "twitter": {
    "appKey": "YOUR_TWITTER_API_KEY",
    "appSecret": "YOUR_TWITTER_API_KEY_SECRET",
    "accessToken": "YOUR_TWITTER_ACCESS_TOKEN",
    "accessSecret": "YOUR_TWITTER_ACCESS_TOKEN_SECRET"
  },
  "grok": {
    "apiKey": "xai-YOUR_XAI_API_KEY",
    "model": "grok-3",
    "fallbackModel": "grok-3-mini",
    "maxTokens": 300,
    "maxHistoryLength": 10
  },
  "ai": {
    "systemPromptFile": "system-prompt.txt",
    "errorMessage": "……エラーだ。少し待て。"
  },
  "schedule": {
    "hours": [9, 12, 15, 18, 21, 0],
    "maxTweetLength": 280
  },
  "mentions": {
    "enabled": true,
    "pollIntervalMs": 300000,
    "stateFile": "twitter-state.json"
  }
}
```

| キー | 説明 |
|------|------|
| `twitter.*` | X Developer Portalで取得したOAuth1.0aキー一式 |
| `grok.*` | Discord版と同じくGrok(xAI)の設定。既存の`config.json`のキーを流用可 |
| `ai.systemPromptFile` | キャラクター設定（既存の`system-prompt.txt`をそのまま使用） |
| `schedule.hours` | 定時つぶやきを行う時刻（JST・0〜23の配列） |
| `schedule.maxTweetLength` | 1投稿の最大文字数（Xの標準上限は280） |
| `mentions.enabled` | メンションへの自動リプライのON/OFF |
| `mentions.pollIntervalMs` | メンション確認の間隔（ミリ秒）。読み取り課金を抑えるため頻度を上げすぎないこと |
| `mentions.stateFile` | 最終処理済みメンションIDなどを保存する状態ファイル |

### 6. 依存パッケージのインストール
```bash
npm install
```
（`twitter-api-v2` は追加済み）

### 7. 起動
単体起動:
```bash
node twitter-bot.js
```

pm2で他Botと合わせて起動（`ecosystem.config.js`に`dottore-twitter`として登録済み）:
```bash
pm2 start ecosystem.config.js
pm2 logs dottore-twitter
```

## 機能

- **定時つぶやき**: `schedule.hours`で指定した時刻(JST)に、Grokがキャラクターの独り言として新規ツイートを生成・投稿
- **メンションへの自動リプライ**: 一定間隔でメンションを確認し、`since_id`による差分取得（読み取り課金の抑制）でリプライ生成・返信
- ユーザーごとの直近の会話履歴はDiscord版と同様プロセス内メモリで保持（プロセス再起動でリセット）

---

# パンタローネ Bot（第二のキャラクター）

`bot.js` をフォークせず共用したまま、ドットーレとは別のキャラクター「パンタローネ」（Genshin Impact、第九席「調停者」）を3つ目のpm2プロセスとして動かす構成です。設定ファイルとシステムプロンプトを差し替えるだけで、`dottore-server-a`/`dottore-server-b`と全く同じ仕組みの上で動作します。

## 現在の範囲（フェーズ1）

- 対象は指定した1チャンネルのみ、テキストチャットの人間ユーザーとの会話に限定。
- VC・Twitter・ドットーレBotとの直接会話は今回未対応（次フェーズで検討）。
- ドットーレとはプロフィール・記憶・知識ベースを完全に分離したファイルで管理（`*-pantalone.json`）。同一人物でも、ドットーレ側の観察データがパンタローネ側に漏れることはない。

## セットアップ手順

### 1. Discord Developer Portalで新規アプリを作成

1. https://discord.com/developers/applications にアクセスし、新規Applicationを作成（Bot Userも追加）
2. **Privileged Gateway Intents** で `Message Content Intent` を有効化
3. Bot Permissions: `Send Messages` / `Read Message History` のみで良い（VCは今回使わないため `Connect`/`Speak` は不要）
4. OAuth2 URL Generatorで招待リンクを作成し、対象チャンネル（`1532711099319849100`）が属するサーバーへ招待

### 2. config-pantalone.json の設定

雛形は作成済み。以下を記入してください。

| キー | 説明 |
|------|------|
| `discord.token` | 上記で発行したパンタローネ専用のBotトークン |
| `discord.targetChannelIds` | パンタローネが応答する対象チャンネル（雛形では専用チャンネル1つのみ） |
| `grok.apiKey` / `gemini.apiKey` | 既存のドットーレ用キーを流用可（別キーにしても問題なし） |
| `ai.systemPromptFile` | `system-prompt-pantalone.txt`（パンタローネのキャラクター設定） |
| `character.name` | `"パンタローネ"` — 定時挨拶・観察記録表示など、bot.js内の呼称表示に使われる |
| `features.*` | フェーズ1では全項目 `false`。VC自動参加・定時つぶやき・記念日メッセージ等をすべて無効化するため |

### 3. pm2で起動

`ecosystem.config.js`に`pantalone-server`として登録済み。

```bash
pm2 start ecosystem.config.js --only pantalone-server
pm2 logs pantalone-server
```

## 今後の予定（フェーズ2以降）

- ドットーレBotとパンタローネBotの直接会話（ループ防止・頻度制御の実装が必要）
- VC音声対応（専用音声素材の用意が必要）
- Twitter展開

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