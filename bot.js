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
let listenCallback = null;
// VC内の沈黙タイマー（一定時間発言がなければ自発発言）
let vcIdleTimer = null;
const VC_IDLE_MS = 8 * 60 * 1000; // 8分

// ─── VC状態の永続化（再起動後に自動再参加するため）─────────────────────────
const VC_STATE_PATH = path.join(__dirname, "vc-state.json");

function saveVCState(guildId, channelId) {
  try {
    fs.writeFileSync(VC_STATE_PATH, JSON.stringify({ guildId, channelId }), "utf-8");
  } catch (err) {
    console.error("[Bot] VC状態保存失敗:", err.message);
  }
}

function clearVCState() {
  try {
    if (fs.existsSync(VC_STATE_PATH)) fs.unlinkSync(VC_STATE_PATH);
  } catch (_) {}
}

function clearVCIdleTimer() {
  if (vcIdleTimer) { clearTimeout(vcIdleTimer); vcIdleTimer = null; }
}

function scheduleVCIdle() {
  clearVCIdleTimer();
  if (!vcHandler.isConnected()) return;
  vcIdleTimer = setTimeout(async () => {
    vcIdleTimer = null;
    if (!vcHandler.isConnected()) return;
    const msg = pick("vc_idle");
    if (!msg) return;
    const notifyChannelId = [...targetChannelIds][0];
    if (!notifyChannelId) return;
    try {
      const ch = await client.channels.fetch(notifyChannelId);
      if (ch?.isTextBased()) await ch.send(msg);
    } catch (_) {}
    scheduleVCIdle();
  }, VC_IDLE_MS);
}

function makeListenCallback() {
  return async (speakerId, transcript) => {
    try {
      // 15%の確率でスルー
      if (Math.random() < 0.15) {
        console.log(`[Bot] 音声入力スキップ [${speakerId}]`);
        return;
      }
      // 0.5〜2秒のランダム遅延
      const delay = 500 + Math.floor(Math.random() * 1500);
      await new Promise((r) => setTimeout(r, delay));
      console.log(`[Bot] 音声入力 [${speakerId}]: ${transcript}`);
      scheduleVCIdle();
      await vcHandler.respondToMessage(transcript);
    } catch (err) {
      console.error("[Bot] 音声応答エラー:", err.message);
    }
  };
}

async function autoRejoinVC() {
  if (!fs.existsSync(VC_STATE_PATH)) return;
  try {
    const { guildId, channelId } = JSON.parse(fs.readFileSync(VC_STATE_PATH, "utf-8"));
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) { clearVCState(); return; }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) { clearVCState(); return; }
    // 誰もいないVCには再参加しない
    const humanCount = channel.members?.filter((m) => !m.user.bot).size ?? 0;
    if (humanCount === 0) {
      console.log("[Bot] VC自動再参加スキップ：誰もいません");
      clearVCState();
      return;
    }
    const joined = await vcHandler.join(channel);
    if (joined) {
      listenCallback = makeListenCallback();
      vcHandler.startListening(listenCallback);
      scheduleVCIdle();
      console.log(`[Bot] VC自動再参加完了: ${channel.name}`);
    } else {
      console.warn("[Bot] VC自動再参加失敗（権限または接続エラー）");
    }
  } catch (err) {
    console.error("[Bot] VC自動再参加エラー:", err.message);
  }
}

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
      console.log("[Scheduler] 定期履歴クリア (04:00 JST)");
      aiHandler.clearAllHistory();
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
client.once("clientReady", async () => {
  console.log(`[Bot] ログイン完了: ${client.user.tag}`);
  console.log(`[Bot] 監視チャンネル数: ${targetChannelIds.size}`);
  console.log(`[Bot] 使用モデル: ${config.gemini.model}`);
  startScheduler();
  await autoRejoinVC();
});

// ─── VC人数監視：一人になったら5秒後に退出・参加者検知 ──────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  if (!vcHandler.isConnected()) return;
  // Bot自身のVC状態変化は無視（起動時の自動再参加で誤判定しないため）
  if (newState.member.user.bot) return;

  // Botが参加しているチャンネルを取得
  const botChannelId = oldState.guild.members.me?.voice?.channelId;
  if (!botChannelId) return;

  // 人間が自分のVCに参加してきた場合
  if (
    newState.channelId === botChannelId &&
    oldState.channelId !== botChannelId
  ) {
    scheduleVCIdle();
    const joinMsg = pick("vc_join");
    const notifyChannelId = [...targetChannelIds][0];
    if (joinMsg && notifyChannelId) {
      client.channels.fetch(notifyChannelId)
        .then((ch) => ch?.send(joinMsg))
        .catch(() => {});
    }
  }

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
        clearVCIdleTimer();
        vcHandler.leave();
        clearVCState();
        console.log("[Bot] 無人のため自動退出しました。");
        // テキストチャンネルに通知
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
      listenCallback = makeListenCallback();
      vcHandler.startListening(listenCallback);
      scheduleVCIdle();
      saveVCState(message.guild.id, targetVC.id);
      await message.reply(`……参加する。「${targetVC.name}」の監視を開始する。声も聴いている。終わるなら \`!owari\` だ。`);
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
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});
    const result = await vcHandler.respondToMessage(userText);
    if (result) {
      const names = result.sounds.map(s => s.name).join("、");
      const thoughtPart = result.thought ? `(${result.thought})` : "";
      await message.reply(`……${names}。${thoughtPart}`);
    } else {
      await message.reply("……今は声が出ない。");
    }
    return;
  }

  // ── コマンド ─────────────────────────────────────────────────
  switch (content) {
    case "!owari":
      if (!vcHandler.isConnected()) { await message.reply("……VCには入っていない。"); return; }
      if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null; }
      clearVCIdleTimer();
      listenCallback = null;
      vcHandler.leave();
      clearVCState();
      await message.reply("……退出する。観察記録は保存した。");
      return;

    case "!kike":
      if (!vcHandler.isConnected()) { await message.reply("……VCに入っていない。まず `!kanshi` を実行しろ。"); return; }
      if (vcHandler.isListening()) { await message.reply("……もう聴いている。"); return; }
      if (!listenCallback) { await message.reply("……`!kanshi` で参加し直せ。"); return; }
      vcHandler.startListening(listenCallback);
      await message.reply("……聴く。");
      return;

    case "!kikanai":
      if (!vcHandler.isConnected()) { await message.reply("……VCに入っていない。"); return; }
      if (!vcHandler.isListening()) { await message.reply("……もう聴いていない。"); return; }
      vcHandler.stopListening();
      await message.reply("……無視する。");
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
        "!kanshi [VC名] … VCに召喚（音声聴き取りON）\n" +
        "!hakase [msg]  … VCで音声再生\n" +
        "!kike          … 音声聴き取りON\n" +
        "!kikanai       … 音声聴き取りOFF\n" +
        "!owari         … VCから退出\n" +
        "!reload        … messages.json を再読み込み\n" +
        "!help          … このヘルプを表示\n\n" +
        "それ以外のメッセージはドットーレが回答します。"
      );
      return;
  }

  // ── AI 応答 ───────────────────────────────────────────────────
  console.log(`[Bot] メッセージ受信 [${userTag}]: ${content.slice(0, 80)}`);

  try {
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});
    const reply = await aiHandler.generateResponse(userId, content);
    const chunks = reply.length <= 2000 ? [reply] : splitMessage(reply, 2000);
    for (let i = 0; i < chunks.length; i++) {
      try {
        if (i === 0) {
          await message.reply(chunks[i]);
        } else {
          await message.channel.send(chunks[i]);
        }
      } catch (sendErr) {
        console.error(`[Bot] reply失敗、channel.sendで再試行: ${sendErr.message}`);
        await message.channel.send(chunks[i]);
      }
    }
    console.log(`[Bot] 返答送信完了 [${userTag}]`);

    // VCに接続中なら音声も再生（非同期・応答は待たない）
    if (vcHandler.isConnected()) {
      vcHandler.respondToMessage(content).catch((err) =>
        console.error("[Bot] テキスト→VC音声エラー:", err.message)
      );
    }
  } catch (error) {
    console.error(`[Bot] エラー [${userTag}]:`, error.message);
    try {
      await message.reply(config.ai.errorMessage);
    } catch (_) {
      await message.channel.send(config.ai.errorMessage).catch(() => {});
    }
  }
});

client.login(config.discord.token).catch((err) => {
  console.error("[Bot] ログインに失敗しました:", err.message);
  process.exit(1);
});