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
      errorMessage: process.env.ERROR_MESSAGE || "エラーが発生しました。しばらくしてからもう一度お試しください。",
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

client.once("ready", () => {
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
    await message.reply("会話履歴をリセットしました。新しい会話を始めましょう！");
    console.log(`[Bot] 履歴リセット: ${userTag}`);
    return;
  }

  if (content === "!help") {
    await message.reply(
      "【コマンド一覧】\n" +
      "!reset … 会話履歴をリセットします\n" +
      "!help  … このヘルプを表示します\n\n" +
      "それ以外のメッセージはAIが回答します。"
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