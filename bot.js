// bot.js
// Discord Bot メインエントリーポイント

const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const path = require("path");
const AIHandler = require("./ai-handler");
const { VCHandler } = require("./vc-handler");

// ─── 設定の読み込み（環境変数優先、なければ config.json）─────────────────
let config;

if (process.env.DISCORD_TOKEN) {
  config = {
    discord: {
      token: process.env.DISCORD_TOKEN,
      targetChannelIds: process.env.TARGET_CHANNEL_IDS
        ? process.env.TARGET_CHANNEL_IDS.split(",").map((s) => s.trim())
        : [],
      voiceChannelId: process.env.VOICE_CHANNEL_ID || "",
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
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("[Bot] config.json が見つかりません。");
    process.exit(1);
  }
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

if (!config.discord.token) {
  console.error("[Bot] Discord トークンが設定されていません。");
  process.exit(1);
}
if (!config.gemini.apiKey) {
  console.error("[Bot] Gemini API キーが設定されていません。");
  process.exit(1);
}

// ─── 動作モード ────────────────────────────────────────────────────────────
const BOT_MODE = (process.env.BOT_MODE || "all").trim();
console.log(`[Bot] 動作モード: ${BOT_MODE}`);

// ─── メッセージリストの読み込み ───────────────────────────────────────────
const MESSAGES_PATH = path.join(__dirname, "messages.json");
let messageLists = {};
let scheduleMap = {};

function loadMessages() {
  try {
    const raw = fs.readFileSync(MESSAGES_PATH, "utf-8");
    const data = JSON.parse(raw);
    const newSchedule = {};
    for (const [hourStr, listName] of Object.entries(data.schedule || {})) {
      if (hourStr.startsWith("_")) continue;
      const hour = parseInt(hourStr, 10);
      if (!isNaN(hour) && typeof listName === "string") newSchedule[hour] = listName;
    }
    const newLists = {};
    for (const [key, val] of Object.entries(data)) {
      if (key === "schedule" || key.startsWith("_")) continue;
      if (Array.isArray(val) && val.length > 0) newLists[key] = val;
    }
    scheduleMap = newSchedule;
    messageLists = newLists;
    const listSummary = Object.entries(newLists).map(([k, v]) => `${k}(${v.length}件)`).join(", ");
    console.log(`[Messages] 読み込み完了 → ${listSummary}`);
    console.log(`[Messages] スケジュール → ${JSON.stringify(newSchedule)}`);
    return true;
  } catch (err) {
    console.error("[Messages] 読み込み失敗:", err.message);
    return false;
  }
}

if (!fs.existsSync(MESSAGES_PATH)) {
  console.error(`[Messages] ${MESSAGES_PATH} が見つかりません。`);
  process.exit(1);
}
loadMessages();

// ─── クライアントの初期化 ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const aiHandler = new AIHandler(config);
const vcHandler = new VCHandler(config);
const targetChannelIds = new Set(config.discord.targetChannelIds);

// 一人になったときの退出タイマー
let aloneTimer = null;

function pick(listName) {
  const list = messageLists[listName];
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

// ─── 定時スケジューラー ───────────────────────────────────────────────────
function startScheduler() {
  if (BOT_MODE === "vc") {
    console.log("[Bot] VCモード：スケジューラーは起動しません");
    return;
  }

  console.log("[Bot] 定時スケジューラー起動");
  let lastSentHour = -1;

  setInterval(async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (minute !== 0) return;
    if (lastSentHour === hour) return;
    lastSentHour = hour;

    if (hour === 4) {
      console.log("[Scheduler] 定期再起動 (04:00 JST)...");
      try { aiHandler.clearAllHistory(); } finally {
        setTimeout(() => process.exit(0), 3000);
      }
      return;
    }

    if (!(hour in scheduleMap)) return;
    const listName = scheduleMap[hour];
    const text = pick(listName);
    if (!text) return;

    console.log(`[Scheduler] 定時メッセージ送信 hour=${hour} list=${listName}`);
    for (const channelId of targetChannelIds) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) continue;
        await channel.send(text);
      } catch (chErr) {
        console.error(`[Scheduler] チャンネル ${channelId} への送信失敗:`, chErr.message);
      }
    }
  }, 60 * 1000);
}

// ─── Ready ────────────────────────────────────────────────────────────────
client.once("clientReady", () => {
  console.log(`[Bot] ログイン完了: ${client.user.tag}`);
  console.log(`[Bot] 監視チャンネル数: ${targetChannelIds.size}`);
  console.log(`[Bot] 使用モデル: ${config.gemini.model}`);
  startScheduler();
});

// ─── VC人数監視：一人になったら5秒後に退出 ───────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  if (!vcHandler.isConnected()) return;

  // Botが参加しているチャンネルを取得
  const botChannelId = oldState.guild.members.me?.voice?.channelId;
  if (!botChannelId) return;

  const channel = oldState.guild.channels.cache.get(botChannelId);
  if (!channel) return;

  // Bot以外のメンバー数をカウント
  const humanCount = channel.members.filter((m) => !m.user.bot).size;

  if (humanCount === 0) {
    // 一人（Bot以外いない）→ 5秒後に退出
    if (aloneTimer) return; // すでにタイマー起動中
    console.log("[Bot] VC内が無人になりました。5秒後に退出します。");
    aloneTimer = setTimeout(() => {
      aloneTimer = null;
      if (!vcHandler.isConnected()) return;
      // 退出前に再確認
      const ch = oldState.guild.channels.cache.get(botChannelId);
      const stillAlone = ch?.members.filter((m) => !m.user.bot).size === 0;
      if (stillAlone) {
        vcHandler.leave();
        console.log("[Bot] 無人のため自動退出しました。");
        // テキストチャンネルに通知（最初の監視チャンネル）
        const notifyChannelId = [...targetChannelIds][0];
        if (notifyChannelId) {
          client.channels.fetch(notifyChannelId)
            .then((ch) => ch?.send("……観察終了、記録した。退出する。"))
            .catch(() => {});
        }
      }
    }, 5000);
  } else {
    // 誰かが入ってきた → タイマーキャンセル
    if (aloneTimer) {
      clearTimeout(aloneTimer);
      aloneTimer = null;
      console.log("[Bot] メンバーが戻ったため退出タイマーをキャンセルしました。");
    }
  }
});

// ─── メッセージ受信 ────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!targetChannelIds.has(message.channelId)) return;

  const userId = message.author.id;
  const userTag = message.author.tag;
  const content = message.content.trim();
  if (!content) return;

  const isVCCommand =
    content === "!kanshi" ||
    content.startsWith("!kanshi ") ||
    content === "!hakase" ||
    content.startsWith("!hakase ") ||
    content === "!owari";

  if (BOT_MODE === "text" && isVCCommand) return;
  if (BOT_MODE === "vc" && !isVCCommand) return;

  // ── !kanshi ───────────────────────────────────────────────────
  if (content === "!kanshi" || content.startsWith("!kanshi ")) {
    if (vcHandler.isConnected()) {
      await message.reply("……既にVCに入っている。二重に参加する必要はない。");
      return;
    }
    const arg = content.slice("!kanshi".length).trim();
    let targetVC = null;
    if (arg) {
      const vcs = message.guild.channels.cache.filter((ch) => ch.isVoiceBased());
      targetVC =
        vcs.get(arg) ??
        vcs.find((ch) => ch.name === arg) ??
        vcs.find((ch) => ch.name.toLowerCase().includes(arg.toLowerCase())) ??
        null;
      if (!targetVC) {
        const vcList = vcs.map((ch) => `・${ch.name} (${ch.id})`).join("\n");
        await message.reply(`……「${arg}」というVCが見つからない。\n以下から正確に指定しろ。\n${vcList}`);
        return;
      }
    } else {
      const member = message.guild.members.cache.get(userId) ??
        await message.guild.members.fetch(userId).catch(() => null);
      targetVC = member?.voice?.channel ?? null;
      if (!targetVC) {
        const vcs = message.guild.channels.cache.filter((ch) => ch.isVoiceBased());
        const vcList = vcs.map((ch) => `・${ch.name}`).join("\n");
        await message.reply(
          "……VCに入っていないな。\n`!kanshi [チャンネル名]` で指定するか、VCに入ってから実行しろ。\n\n" +
          `利用可能なVC：\n${vcList}`
        );
        return;
      }
    }
    if (!vcHandler.vcAvailable) {
      await message.reply("……VC参加には `@discordjs/voice` が必要だ。");
      return;
    }
    const joined = await vcHandler.join(targetVC);
    if (joined) {
      await message.reply(`……参加する。「${targetVC.name}」の監視を開始する。\n\`!hakase [メッセージ]\` で私に声を出させろ。終わるなら \`!owari\` だ。`);
    } else {
      await message.reply("……VC参加に失敗した。権限を確認しろ。");
    }
    return;
  }

  // ── !hakase ───────────────────────────────────────────────────
  if (content.startsWith("!hakase ") || content === "!hakase") {
    const userText = content.slice("!hakase".length).trim();
    if (!vcHandler.isConnected()) {
      await message.reply("……VCに入っていない。まず `!kanshi` を実行しろ。");
      return;
    }
    if (!userText) {
      await message.reply("……何か言え。`!hakase [メッセージ]` の形式で使え。");
      return;
    }
    if (config.ai.typingIndicator) await message.channel.sendTyping();
    const sound = await vcHandler.respondToMessage(userText);
    await message.reply(sound ? `……${sound.name}。` : "……今は声が出ない。");
    return;
  }

  // ── コマンド ─────────────────────────────────────────────────
  switch (content) {
    case "!owari":
      if (!vcHandler.isConnected()) { await message.reply("……VCには入っていない。"); return; }
      if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null; }
      vcHandler.leave();
      await message.reply("……退出する。観察記録は保存した。");
      return;

    case "!reset":
      aiHandler.clearHistory(userId);
      await message.reply("気が変わった。記憶操作の薬だ、飲め。今すぐ");
      return;

    case "!resetall":
      aiHandler.clearAllHistory();
      await message.reply("……全員分だ。記憶操作の薬を投与した。逆らうな。");
      return;

    case "!okusuri": { const t = pick("okusuri"); if (t) await message.reply(t); return; }
    case "!sleep":   { const t = pick("sleep");   if (t) await message.reply(t); return; }
    case "!pain":    { const t = pick("pain");    if (t) await message.reply(t); return; }
    case "!work":    { const t = pick("work");    if (t) await message.reply(t); return; }
    case "!observe": { const t = pick("observe"); if (t) await message.reply(t); return; }
    case "!reward":  { const t = pick("reward");  if (t) await message.reply(t); return; }

    case "!reload": {
      const ok = loadMessages();
      if (ok) {
        const summary = Object.entries(messageLists).map(([k, v]) => `${k}: ${v.length}件`).join("\n");
        const scheduleSummary = Object.entries(scheduleMap).sort((a, b) => a[0] - b[0]).map(([h, l]) => `${h}時 → ${l}`).join(" / ");
        await message.reply(`……再読み込み完了。\n\n【リスト】\n${summary}\n\n【スケジュール】\n${scheduleSummary}`);
      } else {
        await message.reply("……読み込みに失敗した。messages.json の構文を確認しろ。");
      }
      return;
    }

    case "!help":
      await message.reply(
        "【コマンド一覧】\n" +
        "!reset         … 自分の会話履歴をリセット\n" +
        "!resetall      … 全ユーザーの会話履歴をリセット\n" +
        "!okusuri       … 薬を投与してもらう\n" +
        "!sleep         … 就寝前、管理下で休む\n" +
        "!pain          … 痛み・不調を報告する\n" +
        "!work          … 作業・勉強を開始する\n" +
        "!observe       … 観察してほしいとき\n" +
        "!reward        … 成功・達成を報告する\n" +
        "!kanshi [VC名] … VCに召喚\n" +
        "!hakase [msg]  … VCで音声再生\n" +
        "!owari         … VCから退出\n" +
        "!reload        … messages.json を再読み込み\n" +
        "!help          … このヘルプを表示\n\n" +
        "それ以外のメッセージはドットーレが回答します。"
      );
      return;
  }

  // ── AI 応答 ───────────────────────────────────────────────────
  console.log(`[Bot] メッセージ受信 [${userTag}]: ${content.slice(0, 80)}`);
  if (config.ai.typingIndicator) await message.channel.sendTyping();

  try {
    const reply = await aiHandler.generateResponse(userId, content);
    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) await message.channel.send(chunk);
    }
    console.log(`[Bot] 返答送信完了 [${userTag}]`);
  } catch (error) {
    console.error(`[Bot] エラー [${userTag}]:`, error.message);
    await message.reply(config.ai.errorMessage);
  }
});

client.login(config.discord.token).catch((err) => {
  console.error("[Bot] ログインに失敗しました:", err.message);
  process.exit(1);
});