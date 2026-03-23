// bot.js
// Discord Bot メインエントリーポイント

const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const path = require("path");
const AIHandler = require("./ai-handler");

// ─── 設定の読み込み（環境変数優先、なければ config.json）─────────────────
let config;

if (process.env.DISCORD_TOKEN) {
  // Railway などの環境変数から読み込む
  config = {
    discord: {
      token: process.env.DISCORD_TOKEN,
      targetChannelIds: process.env.TARGET_CHANNEL_IDS
        ? process.env.TARGET_CHANNEL_IDS.split(",").map((s) => s.trim())
        : [],
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      maxTokens: parseInt(process.env.MAX_TOKENS || "1000", 10),
      maxHistoryLength: parseInt(process.env.MAX_HISTORY_LENGTH || "20", 10),
    },
    ai: {
      systemPrompt: process.env.SYSTEM_PROMPT || "You are a helpful assistant.",
      errorMessage: process.env.ERROR_MESSAGE || "(頭を抱え)",
      typingIndicator: process.env.TYPING_INDICATOR !== "false",
    },
  };
} else {
  // ローカル開発用: config.json から読み込む
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("[Bot] config.json が見つかりません。環境変数 DISCORD_TOKEN を設定するか、config.json を作成してください。");
    process.exit(1);
  }
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

// 必須項目のバリデーション
if (!config.discord.token) {
  console.error("[Bot] Discord トークンが設定されていません。");
  process.exit(1);
}
if (!config.gemini.apiKey) {
  console.error("[Bot] Gemini API キーが設定されていません。");
  process.exit(1);
}

// ─── クライアントの初期化 ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const aiHandler = new AIHandler(config);

// 対象チャンネルIDを Set に変換（高速ルックアップ用）
const targetChannelIds = new Set(config.discord.targetChannelIds);

// ─── イベントハンドラー ────────────────────────────────────────────────────

client.once("clientReady", () => {
  console.log(`[Bot] ログイン完了: ${client.user.tag}`);
  console.log(`[Bot] 監視チャンネル数: ${targetChannelIds.size}`);
  console.log(`[Bot] 使用モデル: ${config.gemini.model}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!targetChannelIds.has(message.channelId)) return;

  const userId = message.author.id;
  const userTag = message.author.tag;
  const content = message.content.trim();

  if (!content) return;

  if (content === "!reset") {
    aiHandler.clearHistory(userId);
    await message.reply("気が変わった。記憶操作の薬だ、飲め。今すぐ");
    console.log(`[Bot] 履歴リセット: ${userTag}`);
    return;
  }

  if (content === "!okusuri") {
    const okusuriList = [
    "口を開けろ。……抵抗は無意味だ。反応速度の測定に入る。飲み込め。",
    "投与する。内分泌への影響を観察する段階だ。……飲め。遅延は誤差になる。",
    "新規調合だ。安全性は理論上担保している。……理論上だがな。飲め。",
    "嚥下しろ。……神経反応と心拍の変動を記録する。興味深い結果を期待している。",
    "躊躇するな。判断力が鈍っている証拠だ。……私が補正する。飲め。",
    "その表情、拒否反応か。いい兆候だ。……データが取れる。口を開けろ。",
    "投与開始。血中濃度の推移を観察する。……安心しろ、致命的ではない。たぶんな。",
    "飲め。……苦味は調整していない。反応の純度が落ちるからな。",
    "摂取しろ。お前の選択は不要だ。……結果だけが必要だ。",
    "その震え、予測通りだ。……いい。続けろ。今の状態を維持したまま飲み込め。",
    "投与する。逃げるな。……この個体差、記録する価値がある。",
    "口を開けろ。……従順だな。だがその理由は後で解析する。今は飲め。",
    "飲み込め。……副作用？気にするな。観察対象としてはむしろ好都合だ。",
    "遅い。処理効率が落ちる。……私の指示に従え。飲め。",
    "その反応、実に興味深い。……いい、もっと見せろ。飲み込め。"
    ];
    const reply = okusuriList[Math.floor(Math.random() * okusuriList.length)];
    await message.reply(reply);
    console.log(`[Bot] おくすり投与 [${userTag}]`);
    return;
  }

  if (content === "!help") {
    await message.reply(
      "【コマンド一覧】\n" +
      "!reset   … 会話履歴をリセットします\n" +
      "!okusuri … おくすりを飲ませてもらえます\n" +
      "!help    … このヘルプを表示します\n\n" +
      "それ以外のメッセージはドットーレが回答します。"
    );
    return;
  }

  console.log(`[Bot] メッセージ受信 [${userTag}]: ${content.slice(0, 80)}`);

  if (config.ai.typingIndicator) {
    await message.channel.sendTyping();
  }

  try {
    const reply = await aiHandler.generateResponse(userId, content);
    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
    console.log(`[Bot] 返答送信完了 [${userTag}]`);
  } catch (error) {
    console.error(`[Bot] エラー [${userTag}]:`, error.message);
    await message.reply(config.ai.errorMessage);
  }
});

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

client.login(config.discord.token).catch((err) => {
  console.error("[Bot] ログインに失敗しました:", err.message);
  process.exit(1);
});