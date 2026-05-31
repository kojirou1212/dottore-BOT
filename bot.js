// bot.js
// Discord Bot メインエントリーポイント

const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const path = require("path");
const AIHandler = require("./ai-handler");
const { VCHandler } = require("./vc-handler");
const ProfileManager = require("./profile-manager");
const KnowledgeBase = require("./knowledge-base");
const MemoryManager = require("./memory-manager");

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
    grok: {
      apiKey: process.env.GROK_API_KEY,
      model: process.env.GROK_MODEL || "grok-3",
      fallbackModel: process.env.GROK_FALLBACK_MODEL || "grok-3-mini",
      maxTokens: parseInt(process.env.MAX_TOKENS || "500", 10),
      maxHistoryLength: parseInt(process.env.MAX_HISTORY_LENGTH || "30", 10),
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

// systemPromptFile が指定されていればファイルから読み込む
if (config.ai.systemPromptFile) {
  const promptPath = path.join(__dirname, config.ai.systemPromptFile);
  if (!fs.existsSync(promptPath)) {
    console.error(`[Bot] systemPromptFile が見つかりません: ${promptPath}`);
    process.exit(1);
  }
  config.ai.systemPrompt = fs.readFileSync(promptPath, "utf-8").trim();
  console.log(`[Bot] システムプロンプト読み込み完了: ${config.ai.systemPromptFile}`);
}
if (!config.grok.apiKey) {
  console.error("[Bot] Grok API キーが設定されていません。");
  process.exit(1);
}
if (!config.gemini?.apiKey) {
  console.warn("[Bot] Gemini API キーが未設定です。VC音声認識（STT）は無効になります。");
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
const profileManager = new ProfileManager();
const knowledgeBase = new KnowledgeBase();
const memoryManager = new MemoryManager();
const targetChannelIds = new Set(config.discord.targetChannelIds);
const profileChannelIds = new Set(
  (config.discord.profileChannelId || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const loreChannelIds = new Set(
  (config.discord.loreChannelId || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const vcNotifyChannelId = config.discord.vcNotifyChannelId || [...new Set(config.discord.targetChannelIds)][0];
const zatsuChannelId = config.discord.zatsuChannelId || "";
const debugChannelId = config.discord.debugChannelId || "";
const jihouChannelIds = new Set(config.discord.jihouChannelIds ?? []);

// ─── 全チャンネル監視（話題トラッキング）────────────────────────────────────
const channelTopics = new Map(); // channelId → [{username, content, channelName, timestamp}]
const TOPIC_MAX_PER_CH = 15;
const TOPIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function trackChannelTopic(message) {
  const content = message.content.trim();
  if (!content || content.length < 5) return;
  const channelId = message.channelId;
  if (!channelTopics.has(channelId)) channelTopics.set(channelId, []);
  const topics = channelTopics.get(channelId);
  topics.push({
    username: message.author.username,
    content: content.slice(0, 150),
    channelName: message.channel?.name ?? channelId,
    timestamp: Date.now(),
  });
  while (topics.length > TOPIC_MAX_PER_CH) topics.shift();
  if (zatsuChannelId && channelId === zatsuChannelId) {
    console.log(`[雑談記録] 追加 ${message.author.username}: ${content.slice(0, 60)}`);
  }
}

function getRecentTopicsHint() {
  const now = Date.now();
  const lines = [];
  for (const [, topics] of channelTopics) {
    const recent = topics.filter(t => now - t.timestamp < TOPIC_MAX_AGE_MS);
    if (recent.length === 0) continue;
    const chName = recent[0].channelName;
    const snippet = recent.slice(-3)
      .map(t => `「${t.content.slice(0, 80)}」(${t.username})`)
      .join("、");
    lines.push(`#${chName}: ${snippet}`);
  }
  if (lines.length === 0) return "";
  return `【他チャンネルの最近の動向（参考情報）】\n${lines.join("\n")}`;
}

// ─── 観察メモ更新（5会話ごと or 重要イベント時、クールダウン付き）────────────
const observationCooldowns = new Map(); // userId → lastUpdateTimestamp

async function updateObservation(userId, userMessage, aiReply) {
  const COOLDOWN_MS = 3 * 60 * 1000; // 3分以内の連続更新は無視
  const now = Date.now();
  if ((observationCooldowns.get(userId) ?? 0) + COOLDOWN_MS > now) return;
  observationCooldowns.set(userId, now);

  const profile = profileManager.profiles[userId];
  if (!profile) return;
  const existing = profile.botRecord.observation ?? "（未記録）";

  const prompt =
    `以下は研究対象との最新のやりとりだ。このデータをもとに被検体の人物像・行動傾向・特性に関する観察記録を更新せよ。\n\n` +
    `現在の記録：「${existing}」\n` +
    `被検体の発言：「${userMessage.slice(0, 300)}」\n` +
    `（参考）ドットーレの返答：「${aiReply.slice(0, 150)}」\n\n` +
    `出力形式：1〜2文の観察メモのみ出力すること（説明・前置き・ドットーレの台詞は不要）。` +
    `研究者視点で淡々と記述、感情語・主観的評価禁止。` +
    `観察可能な事実・傾向・パターンのみ（例：「深夜に出現する傾向がある」「自己否定的な発言が多い」「感情表現を避ける傾向が見られる」）。` +
    `既存記録がある場合は統合・要約してよい。`;

  try {
    const observation = await aiHandler.generateSimple(prompt, 150);
    profileManager.setObservation(userId, observation);
    console.log(`[Bot] 観察記録更新 [${userId}]: ${observation.slice(0, 60)}`);
  } catch (err) {
    console.error("[Bot] 観察記録更新エラー:", err.message);
    observationCooldowns.delete(userId); // 失敗時はクールダウンリセット
  }
}

// ─── ユーザー記憶抽出（週次リフレッシュ対象）────────────────────────────────
const memoryCooldowns = new Map(); // userId → lastExtractTimestamp

async function extractAndStoreMemory(userId, userMessage, aiReply) {
  const COOLDOWN_MS = 5 * 60 * 1000;
  const now = Date.now();
  if ((memoryCooldowns.get(userId) ?? 0) + COOLDOWN_MS > now) return;
  memoryCooldowns.set(userId, now);

  const existing = memoryManager.getMemories(userId).slice(-5).map(e => e.text).join("; ");
  const prompt =
    `以下の発言から、この人物について記憶すべき具体的な事実・情報を1点だけ抽出せよ。\n` +
    `既存の記憶：${existing || "なし"}\n` +
    `発言：「${userMessage.slice(0, 300)}」\n\n` +
    `出力形式：短い1文のみ（例：「猫を飼っている」「今日バイトがある」「試験勉強中」）。` +
    `新しく記憶すべき事実がない場合・既存記憶と重複する場合は「なし」とだけ出力すること。`;

  try {
    const result = await aiHandler.generateSimple(prompt, 60);
    if (result && result.trim() !== "なし" && result.length < 100) {
      memoryManager.addMemory(userId, result.trim());
      console.log(`[Bot] 記憶追加 [${userId}]: ${result.trim()}`);
    }
  } catch (err) {
    console.error("[Bot] 記憶抽出エラー:", err.message);
    memoryCooldowns.delete(userId);
  }
}

// ─── プロフィールチャンネル投稿処理 ─────────────────────────────────────────
// プロフィールテンプレートのフィールドを解析してprofileManagerに反映
function parseProfileTemplate(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([^：:]+)[：:]\s*(.+)/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (!val) continue;
    if (/^名前/.test(key))          result.name   = val;
    else if (/^年齢/.test(key))     result.age    = val;
    else if (/^性別/.test(key))     result.gender = val;
    else if (/^趣味/.test(key))     result.hobby  = val;
    else if (/^一言/.test(key))     result.memo   = val;
    else if (/^症状/.test(key))     result.symptom   = val;
    else if (/^傾向/.test(key))     result.tendency  = val;
    else if (/^弱点/.test(key))     result.weakness  = val;
    else if (/^備考/.test(key))     result.memo      = val;
  }
  return result;
}

async function handleProfilePost(message) {
  const userId = message.author.id;
  const userTag = message.author.tag;
  const content = message.content.trim();
  if (!content) return;

  // 生テキストをknowledge-baseに保存（永久）
  knowledgeBase.setUserBase(userId, userTag, content);
  profileManager.onMessage(userId, userTag);

  // テンプレート形式を解析して!profileフィールドに自動マッピング
  const parsed = parseProfileTemplate(content);
  const fieldMap = {
    name: "呼び名", age: "年齢", gender: "性別",
    hobby: "趣味", symptom: "症状", tendency: "傾向",
    weakness: "弱点", memo: "備考",
  };
  let filled = 0;
  for (const [key, jpField] of Object.entries(fieldMap)) {
    if (parsed[key]) {
      profileManager.setField(userId, jpField, parsed[key], userTag);
      filled++;
    }
  }

  console.log(`[Bot] プロフィール登録 [${userTag}]: ${filled}フィールド解析`);

  try { await message.react("🔬"); } catch (_) {}

  const PROFILE_REG_REPLIES = [
    "……データを受け取った。記録する。",
    "登録を確認した。被検体として管理下に置く。",
    "……ふん。一応、記録しておこう。",
    "被検体よ、情報を受領した。引き続き観察する。",
    "……記録完了。これで管理対象だ。",
    "データ、確認した。期待はしていないが、参考にしよう。",
    "……登録を認める。以後、観察を続ける。",
  ];
  try {
    const reply = PROFILE_REG_REPLIES[Math.floor(Math.random() * PROFILE_REG_REPLIES.length)];
    await message.reply(reply);
  } catch (_) {}

  // 被検体ロール付与
  try {
    const guild = message.guild;
    if (!guild) { console.error("[Bot] ロール付与失敗: guild が null"); return; }

    const botMember = await guild.members.fetchMe();
    const botHighest = botMember.roles.highest;
    const targetRole = guild.roles.cache.get("1510285079031578634")
      ?? await guild.roles.fetch("1510285079031578634");

    console.log(`[Bot] ロール付与デバッグ: bot最高ロール="${botHighest?.name}"(pos=${botHighest?.position}) / 対象ロール="${targetRole?.name}"(pos=${targetRole?.position}) / bot権限=${botMember.permissions.has("ManageRoles") ? "ManageRoles○" : "ManageRoles×"}`);

    const member = message.member ?? await guild.members.fetch(userId);
    await member.roles.add("1510285079031578634");
    console.log(`[Bot] 被検体ロール付与 [${userTag}]`);
  } catch (err) {
    console.error(`[Bot] ロール付与失敗 [${userTag}]:`, err.message);
  }
}

async function handleLoreCommand(message) {
  const rawContent = message.content.trim();
  const args = rawContent.slice("!lore".length).trim();
  const isAdmin = message.member?.permissions.has("Administrator") ?? false;

  if (!args) {
    const cats = knowledgeBase.listLoreCategories();
    if (cats.length === 0) {
      await message.reply("……まだ何も登録されていない。");
    } else {
      await message.reply(`【登録済み知識】\n${cats.map(c => `・${c}`).join("\n")}`);
    }
    return;
  }

  if (args.startsWith("set ") && isAdmin) {
    const rest = args.slice("set ".length).trim();
    const spaceIdx = rest.search(/\s/);
    if (spaceIdx === -1) { await message.reply("……カテゴリと内容を両方指定しろ。"); return; }
    const cat = rest.slice(0, spaceIdx).trim();
    const loreContent = rest.slice(spaceIdx + 1).trim();
    knowledgeBase.setLore(cat, loreContent);
    await message.reply(`……「${cat}」を記録した。`);
    return;
  }

  if (args.startsWith("delete ") && isAdmin) {
    const cat = args.slice("delete ".length).trim();
    const ok = knowledgeBase.deleteLore(cat);
    await message.reply(ok ? `……「${cat}」を削除した。` : `……「${cat}」は存在しない。`);
    return;
  }

  if (args.startsWith("set ") || args.startsWith("delete ")) {
    await message.reply("……管理者権限が必要だ。");
    return;
  }

  const entry = knowledgeBase.getLore(args);
  if (!entry) {
    await message.reply(`……「${args}」というカテゴリは存在しない。`);
  } else {
    await message.reply(`【${args}】\n${entry.content}\n（更新: ${entry.updatedAt}）`);
  }
}

// 一人になったときの退出タイマー
let aloneTimer = null;
let listenCallback = null;
// VC内の沈黙タイマー（一定時間発言がなければ自発発言）
let vcIdleTimer = null;
const VC_IDLE_MS = 25 * 60 * 1000; // 25分（長時間滞在者は無音が普通）

// ─── VC セッション管理 ────────────────────────────────────────────────────
let currentVCChannel = null;  // 現在接続中のVCチャンネル参照
let sessionStartTime = null;  // セッション開始時刻（疲労計算用）
let mutterTimer = null;       // ランダム独り言タイマー
let dailyMood = null;         // ④⑤ 日替わり機嫌 'good'|'neutral'|'bad'
let isFocused = false;        // ① 集中モード中フラグ
let focusTimer = null;        // ① 集中モードタイマー
const recentSpeakers = new Map(); // ② 連続発言追跡 userId→{count, lastTime}
const userJoinTimes = new Map();  // ⑥ 長居追跡 userId→joinTimestamp
let longStayTimer = null;     // ⑥ 長居チェック定期タイマー
const userResponseTrack = new Map(); // 同一応答追跡 userId→{text, count, firstTime}
const ignoredUsers = new Map();      // 一時無視 userId→ignoreUntilTimestamp
const sessionLeavers = new Map();    // 今セッション中に退出したユーザーID（再入室検知用）userId→leaveTimestamp

// 集中モード中・一時無視中のユーザーはSTT前に排除（API呼び出し自体をスキップ）
vcHandler._preFilter = (userId) => {
  if (isFocused) return true;
  // TTS botの音声はGemini STTをスキップ（テキストはmessageCreateで取得するため）
  if ((config.discord.ttsBotIds ?? []).includes(userId)) return true;
  const ignoreUntil = ignoredUsers.get(userId);
  return ignoreUntil != null && Date.now() < ignoreUntil;
};

function getJSTHour() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).getHours();
}

function resetDailyMood() {
  const r = Math.random();
  if (r < 0.25) dailyMood = "good";
  else if (r < 0.65) dailyMood = "neutral";
  else dailyMood = "bad";
  console.log(`[Bot] 日替わり機嫌: ${dailyMood}`);
}

// ②④⑤ スキップ率（疲労・人数・時間帯・機嫌を合算）
function getSkipRate(humanCount) {
  let base = 0.15;
  if (sessionStartTime) {
    const min = (Date.now() - sessionStartTime) / 60000;
    if (min >= 240) base = 0.28;      // 4時間以上：常連として馴染み、少し戻る
    else if (min >= 90) base = 0.40;
    else if (min >= 60) base = 0.35;
    else if (min >= 30) base = 0.25;
  }
  // 大人数ほど応答しなくなる
  const count = humanCount ?? 1;
  if (count >= 5) base = Math.min(base + 0.30, 0.80);
  else if (count >= 3) base = Math.min(base + 0.15, 0.65);
  // 時間帯補正（深夜は機嫌良い・反応増、朝は機嫌悪い・反応減）
  const hour = getJSTHour();
  if (hour >= 23 || hour < 2) base = Math.max(base - 0.10, 0.05);
  else if (hour >= 6 && hour < 10) base = Math.min(base + 0.10, 0.85);
  // 日替わり機嫌補正
  if (dailyMood === "good") base = Math.max(base - 0.08, 0.05);
  else if (dailyMood === "bad") base = Math.min(base + 0.08, 0.85);
  return base;
}

// ③ キーワード（名前を呼ばれたら必ず反応）
const TRIGGER_KEYWORDS = ["ドットーレ", "博士", "ハカセ", "dottore"];

// ネガティブ発言の検知キーワード
const NEGATIVE_KEYWORDS = [
  "つらい", "辛い", "つらくて", "辛くて", "つらすぎ", "辛すぎ",
  "しんどい", "しんどくて", "しんどすぎ",
  "きつい", "きつくて", "きつすぎ",
  "苦しい", "苦しくて",
  "悲しい", "悲しくて", "かなしい",
  "寂しい", "寂しくて", "さみしい",
  "怖い", "怖くて", "こわい",
  "不安", "落ち込", "凹んだ", "凹んでる", "へこんだ", "へこんでる",
  "憂鬱", "ゆううつ", "絶望",
  "疲れた", "つかれた", "くたくた", "ぐったり",
  "もう無理", "もうだめ", "もうダメ", "もう限界", "限界",
  "死にたい", "消えたい", "いなくなりたい",
  "泣いてる", "泣きたい", "泣いた", "泣いちゃった",
  "最悪", "嫌になった", "嫌になってる",
  "ダメだ", "だめだ", "自分が嫌",
];

function isNegativeMessage(text) {
  return NEGATIVE_KEYWORDS.some((kw) => text.includes(kw));
}

// ドットーレの生存を願う・心配する発言の検知
const SURVIVAL_KEYWORDS = [
  "生きろ", "生きて", "生きてほしい", "生きてください", "生きてくれ",
  "死なないで", "死なないでください", "死なないでほしい", "死ぬな",
  "消えないで", "消えないでください", "消えないでほしい",
  "いなくならないで", "いなくなるな", "いなくならないでほしい",
];

function isSurvivalMessage(text) {
  return SURVIVAL_KEYWORDS.some((kw) => text.includes(kw));
}

// 鼻歌判定：延音符を含み、内容語を持たない音のみの文字列
// 例: "んーーー" "ふ〜ふ〜" "らら〜" "〜〜〜"
function isHummingTranscript(text) {
  const t = text.trim();
  if (!t || t.length > 15) return false;
  // 延音符・音符が少なくとも1つある
  if (!/[ーー〜～♪♩]/.test(t)) return false;
  // 鼻歌・延音に使われる音節と記号だけで構成されている
  return /^[んンふフはハほホらラるルれレりリなナにニぬヌねネのノむムまマみミめメもモヤやゆユよヨーー〜～♪♩\s　]+$/.test(t);
}

// ④⑤ 時間帯と機嫌に応じた独り言間隔（深夜短め・朝長め）
function getMutterDelayMs() {
  const hour = getJSTHour();
  let minMin, maxMin;
  if (hour >= 23 || hour < 2)       { minMin = 2; maxMin = 5;  }  // 深夜：賑やか
  else if (hour >= 6 && hour < 10)  { minMin = 5; maxMin = 12; }  // 朝：無口
  else                               { minMin = 3; maxMin = 7;  }  // 通常
  if (dailyMood === "good") { minMin = Math.max(1, minMin - 1); maxMin = Math.max(3, maxMin - 2); }
  else if (dailyMood === "bad")  { minMin += 2; maxMin += 3; }
  return (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;
}

// ① ランダム独り言（自発的に音を鳴らす）
function clearMutterTimer() {
  if (mutterTimer) { clearTimeout(mutterTimer); mutterTimer = null; }
}

function scheduleMutter() {
  clearMutterTimer();
  if (!vcHandler.isConnected()) return;
  const delayMs = getMutterDelayMs();
  mutterTimer = setTimeout(async () => {
    mutterTimer = null;
    if (!vcHandler.isConnected()) return;
    // 人間がいる場合のみ発動
    const humanCount = currentVCChannel?.members?.filter((m) => !m.user.bot).size ?? 0;
    if (humanCount > 0) {
      await vcHandler.playMutter().catch(() => {});
      scheduleVCIdle();
      console.log("[Bot] 独り言発動");
      // テキストチャンネルに行動描写を送信
      const actionMsg = pick("vc_mutter");
      if (actionMsg) {
        notifyText(actionMsg);
      }
      // 独り言の余韻（20%）：15〜45秒後にもう一言
      if (Math.random() < 0.20) {
        const echoDelay = (15 + Math.random() * 30) * 1000;
        setTimeout(() => {
          if (!vcHandler.isConnected() || isFocused) return;
          const echoMsg = pick("vc_mutter_echo");
          if (echoMsg) {
            notifyText(echoMsg);
          }
        }, echoDelay);
      }
    }
    scheduleMutter(); // 次の独り言をスケジュール
  }, delayMs);
}

// ─── ① 集中モード ─────────────────────────────────────────────────────────
function clearFocusTimer() {
  if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
}

async function doFocusMode() {
  if (isFocused || !vcHandler.isConnected()) return;
  isFocused = true;
  clearMutterTimer();
  notifyText(pick("vc_focus_start") || "（実験が佳境に入っている）");
  console.log("[Bot] 集中モード開始");
  const durationMs = (5 + Math.random() * 5) * 60 * 1000; // 5〜10分
  focusTimer = setTimeout(() => {
    focusTimer = null;
    isFocused = false;
    if (vcHandler.isConnected()) { scheduleMutter(); scheduleFocusMode(); }
    console.log("[Bot] 集中モード終了");
  }, durationMs);
}

function scheduleFocusMode() {
  clearFocusTimer();
  if (!vcHandler.isConnected() || isFocused) return;
  const delayMs = (15 + Math.random() * 30) * 60 * 1000; // 15〜45分後に判定
  focusTimer = setTimeout(async () => {
    focusTimer = null;
    if (!vcHandler.isConnected() || isFocused) return;
    if (Math.random() > 0.25) { scheduleFocusMode(); return; } // 25%の確率で発動
    await doFocusMode();
  }, delayMs);
}

// ─── 途中退席 ─────────────────────────────────────────────────────────────
let isTemporarilyAway = false;
let tempLeaveTimer = null;

function clearTempLeaveTimer() {
  if (tempLeaveTimer) { clearTimeout(tempLeaveTimer); tempLeaveTimer = null; }
}

function scheduleTempLeave(capricious = false) {
  clearTempLeaveTimer();
  if (!vcHandler.isConnected()) return;
  // 気まま（自動参加）: 10〜25分後に55%の確率 / 通常: 20〜40分後に30%の確率
  const delayMs = capricious
    ? (10 + Math.random() * 15) * 60 * 1000
    : (20 + Math.random() * 20) * 60 * 1000;
  const leaveRate = capricious ? 0.55 : 0.30;
  tempLeaveTimer = setTimeout(async () => {
    tempLeaveTimer = null;
    if (!vcHandler.isConnected() || isTemporarilyAway) return;
    const humanCount = currentVCChannel?.members?.filter((m) => !m.user.bot).size ?? 0;
    if (humanCount === 0) { scheduleTempLeave(capricious); return; }
    if (Math.random() > leaveRate) { scheduleTempLeave(capricious); return; }
    // 退席前の予兆（25%）：1〜3分前にほのめかし
    if (Math.random() < 0.25) {
      const hintMsg = pick("vc_pre_leave");
      if (hintMsg) {
        notifyText(hintMsg);
      }
      await new Promise((r) => setTimeout(r, (60 + Math.random() * 120) * 1000));
      if (!vcHandler.isConnected() || isTemporarilyAway) return;
    }
    await doTempLeave();
  }, delayMs);
}

async function doTempLeave() {
  if (!vcHandler.isConnected() || isTemporarilyAway) return;
  isTemporarilyAway = true;
  clearVCIdleTimer();
  clearMutterTimer();
  clearFocusTimer();
  isFocused = false;
  clearLongStayTimer();

  vcHandler.leave(); // vc-state.json は保持（戻るため）

  notifyText(pick("vc_tempout") || "……少し席を外す。");
  console.log("[Bot] 途中退席");

  // 5〜10分後に戻る
  const returnMs = (5 + Math.random() * 5) * 60 * 1000;
  tempLeaveTimer = setTimeout(() => { tempLeaveTimer = null; doTempReturn(); }, returnMs);
}

async function doTempReturn() {
  if (!isTemporarilyAway) return;
  try {
    if (!currentVCChannel) { isTemporarilyAway = false; return; }
    // チャンネルを最新状態で取得して人数確認
    const fresh = await currentVCChannel.guild.channels.fetch(currentVCChannel.id).catch(() => null);
    const humanCount = fresh?.members?.filter((m) => !m.user.bot).size ?? 0;
    if (humanCount === 0) {
      console.log("[Bot] 途中退席後に誰もいないため戻らない");
      currentVCChannel = null;
      sessionStartTime = null;
      clearVCState();
      return;
    }
    const joined = await vcHandler.join(fresh);
    if (joined) {
      currentVCChannel = fresh;
      vcHandler.startListening(listenCallback);
      scheduleVCIdle();
      scheduleMutter();
      scheduleTempLeave();
      scheduleFocusMode();
      const now = Date.now();
      fresh.members.forEach((m) => { if (!m.user.bot && !userJoinTimes.has(m.id)) userJoinTimes.set(m.id, now); });
      scheduleLongStayCheck();
      notifyText(pick("vc_return") || "……戻った。");
      console.log("[Bot] 途中退席から復帰");
    } else {
      console.warn("[Bot] 途中退席からの復帰失敗");
      currentVCChannel = null;
      sessionStartTime = null;
      clearVCState();
    }
  } catch (err) {
    console.error("[Bot] 途中退席復帰エラー:", err.message);
  } finally {
    isTemporarilyAway = false;
  }
}

// ─── ⑥ 長居ユーザーへの言及 ───────────────────────────────────────────────
function clearLongStayTimer() {
  if (longStayTimer) { clearInterval(longStayTimer); longStayTimer = null; }
}

function scheduleLongStayCheck() {
  clearLongStayTimer();
  if (!vcHandler.isConnected()) return;
  longStayTimer = setInterval(async () => {
    if (!vcHandler.isConnected()) return;
    const now = Date.now();
    for (const [userId, joinTime] of userJoinTimes) {
      const stayMin = (now - joinTime) / 60000;
      if (stayMin >= 180 && Math.random() < 0.20) { // 3時間以上で言及
        const msg = pick("vc_long_stay") || "……まだいるのか。粘るな。";
        notifyText(msg);
        userJoinTimes.set(userId, now); // 次の3時間をリセット
        break; // 1回のチェックで1件だけ送信
      }
    }
  }, 60 * 60 * 1000); // 60分ごとにチェック（長時間滞在者向け）
}

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
    notifyText(msg);
    scheduleVCIdle();
  }, VC_IDLE_MS);
}

function makeListenCallback() {
  return async (speakerId, transcript, { fromText = false } = {}) => {
    try {
      const ttsBotIds = config.discord.ttsBotIds ?? [];
      const isTtsBot = ttsBotIds.includes(speakerId);
      const speakerUser = client.users.cache.get(speakerId);

      // ボット判定：ttsBotIdsに登録されていないボットは無視
      if (!isTtsBot && speakerUser?.bot === true) return;

      // ① 集中モード中は完全スキップ
      if (isFocused) {
        console.log(`[Bot] 集中モード中スキップ [${speakerId}]`);
        return;
      }

      // 気のせいかモード：一時無視中なら完全スキップ（読み上げBOTは対象外）
      if (!isTtsBot) {
        const ignoreUntil = ignoredUsers.get(speakerId);
        if (ignoreUntil) {
          if (Date.now() < ignoreUntil) {
            console.log(`[Bot] 一時無視中 [${speakerId}]`);
            return;
          }
          ignoredUsers.delete(speakerId);
          userResponseTrack.delete(speakerId);
        }
      }

      // 鼻歌検知：内容のない音は無視
      if (isHummingTranscript(transcript)) {
        console.log(`[Bot] 鼻歌スキップ [${speakerId}]: "${transcript}"`);
        return;
      }

      // キーワード検出（名前を呼ばれたら必ず反応・遅延最小化）
      const hasKeyword = TRIGGER_KEYWORDS.some((kw) =>
        transcript.toLowerCase().includes(kw.toLowerCase())
      );

      const humanCount = currentVCChannel?.members?.filter((m) => !m.user.bot).size ?? 1;
      const currentSkipRate = getSkipRate(humanCount);

      // ② 連続発言チェック（テキスト由来＝読み上げBOT経由は対象外）
      if (!hasKeyword && !fromText) {
        const now = Date.now();
        const speaker = recentSpeakers.get(speakerId) ?? { count: 0, lastTime: 0 };
        speaker.count = (now - speaker.lastTime < 2 * 60 * 1000) ? speaker.count + 1 : 1;
        speaker.lastTime = now;
        recentSpeakers.set(speakerId, speaker);

        if (speaker.count >= 4) {
          const spamRate = Math.min(currentSkipRate + 0.30, 0.90);
          if (Math.random() < spamRate) {
            if (Math.random() < 0.25) {
              const msg = pick("vc_spam") || "……うるさい。少し黙れ。";
              notifyText(msg);
            }
            console.log(`[Bot] 連続発言スキップ [${speakerId}] count=${speaker.count}`);
            return;
          }
        }
      }

      // 疲労・人数・時間帯・機嫌によるスキップ（読み上げBOTは固定50%、キーワードありは免除）
      const effectiveSkipRate = isTtsBot ? 0.10 : currentSkipRate;
      if (!hasKeyword && Math.random() < effectiveSkipRate) {
        console.log(`[Bot] 音声入力スキップ [${speakerId}]${isTtsBot ? " (TTS)" : ""} skipRate=${Math.round(effectiveSkipRate * 100)}%`);
        return;
      }

      // キーワードあり：0〜0.2秒、なし：0.1〜0.5秒
      const delay = hasKeyword
        ? Math.floor(Math.random() * 200)
        : 100 + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, delay));

      if (hasKeyword) {
        console.log(`[Bot] キーワード反応 [${speakerId}]: ${transcript}`);
      } else {
        console.log(`[Bot] 音声入力 [${speakerId}]: ${transcript}`);
      }

      scheduleVCIdle();
      const responseResult = await vcHandler.respondToMessage(transcript);

      // 同一応答リピート検出（2分間に3回同じ応答→気のせいかモード）読み上げBOTは対象外
      if (responseResult && !isTtsBot) {
        const responseKey = responseResult.sounds?.map((s) => s.name).join(",") ?? "";
        const now = Date.now();
        const prev = userResponseTrack.get(speakerId);
        if (prev && prev.text === responseKey && now - prev.firstTime < 2 * 60 * 1000) {
          prev.count++;
          if (prev.count >= 3) {
            const ignoreMs = (3 + Math.random() * 7) * 60 * 1000; // 3〜10分無視
            ignoredUsers.set(speakerId, Date.now() + ignoreMs);
            userResponseTrack.delete(speakerId);
            const msg = pick("vc_kinoseikas") || "……気のせいか。";
            notifyText(msg);
            console.log(`[Bot] 気のせいかモード [${speakerId}] ${Math.round(ignoreMs / 60000)}分無視`);
          }
        } else {
          userResponseTrack.set(speakerId, { text: responseKey, count: 1, firstTime: Date.now() });
        }
      }
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
      currentVCChannel = channel;
      sessionStartTime = Date.now();
      scheduleMutter();
      scheduleTempLeave();
      scheduleFocusMode();
      const now = Date.now();
      channel.members.forEach((m) => { if (!m.user.bot) userJoinTimes.set(m.id, now); });
      scheduleLongStayCheck();
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

function notifyText(text) {
  const ids = [...new Set([vcNotifyChannelId, debugChannelId].filter(Boolean))];
  for (const id of ids) {
    client.channels.fetch(id)
      .then(ch => { if (ch) ch.send(text).catch(() => {}); })
      .catch(() => {});
  }
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
      resetDailyMood();
      return;
    }

    if (!(hour in scheduleMap)) return;
    const listName = scheduleMap[hour];
    const text = pick(listName);
    if (!text) return;

    console.log(`[Scheduler] 定時メッセージ送信 hour=${hour} list=${listName}`);
    for (const channelId of jihouChannelIds) {
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

// ─── プロフィール登録者へのランダムメッセージ ─────────────────────────────

// 7種類のメッセージタイプ定義
const PROFILE_MSG_TYPES = [
  {
    id: "observation",
    label: "観察通知",
    build: (p) => {
      const name  = p.userFields.name || p.displayName;
      const hobby = p.userFields.hobby ? `趣味は${p.userFields.hobby}` : "";
      const obs   = p.botRecord.observation ? `評価：${p.botRecord.observation}` : "";
      const info  = [hobby, obs].filter(Boolean).join("、");
      return (
        `ドットーレ（傲慢・冷静・知的、「お前」呼び）として、被検体「${name}」${info ? "（" + info + "）" : ""}を` +
        `観察している博士が、ふと思い出したようにひとこと呟く。1文のみ。地の文・説明不要。`
      );
    },
  },
  {
    id: "question",
    label: "突発質問",
    build: (p) => {
      const name    = p.userFields.name || p.displayName;
      const hobby   = p.userFields.hobby ? `趣味：${p.userFields.hobby}` : "";
      const tendency = p.userFields.tendency ? `傾向：${p.userFields.tendency}` : "";
      const info    = [hobby, tendency].filter(Boolean).join("、");
      return (
        `ドットーレ（傲慢・知的、「お前」呼び）として、被検体「${name}」${info ? "（" + info + "）" : ""}に` +
        `前置きなく唐突に質問をひとこと投げかける。1文のみ。地の文・説明不要。`
      );
    },
  },
  {
    id: "experiment",
    label: "実験招待",
    build: (p) => {
      const name = p.userFields.name || p.displayName;
      return (
        `ドットーレ（傲慢・研究者気質、「お前」呼び）として、被検体「${name}」に` +
        `「何か実験したいことがある」というニュアンスでさらっとひとこと言う。具体的な内容には触れない。1文のみ。地の文不要。`
      );
    },
  },
  {
    id: "checkin",
    label: "生存確認",
    build: (p) => {
      const name = p.userFields.name || p.displayName;
      return (
        `ドットーレ（冷静・感情を表に出さない、「お前」呼び）として、被検体「${name}」に` +
        `心配を悟らせずに生存確認をするひとこと。淡々と、さらっと。1文のみ。地の文不要。`
      );
    },
  },
  {
    id: "provocation",
    label: "知的挑発",
    build: (p) => {
      const name     = p.userFields.name || p.displayName;
      const tendency = p.userFields.tendency ? `傾向：${p.userFields.tendency}` : "";
      const weakness = p.userFields.weakness ? `弱点：${p.userFields.weakness}` : "";
      const info     = [tendency, weakness].filter(Boolean).join("、");
      return (
        `ドットーレ（皮肉的・知的、「お前」呼び）として、被検体「${name}」${info ? "（" + info + "）" : ""}の` +
        `矛盾や弱点を軽くつついくような皮肉をひとこと言う。攻撃的にならず観察者として。1文のみ。地の文不要。`
      );
    },
  },
  {
    id: "musing",
    label: "思索の断片",
    build: (p) => {
      const name  = p.userFields.name || p.displayName;
      const hobby = p.userFields.hobby ? `趣味：${p.userFields.hobby}` : "";
      const obs   = p.botRecord.observation ? `評価：${p.botRecord.observation}` : "";
      const info  = [hobby, obs].filter(Boolean).join("、");
      return (
        `ドットーレ（知的・内省的）として、被検体「${name}」${info ? "（" + info + "）" : ""}に関連するような` +
        `研究の断片を独り言のようにひとこと呟く。被検体への言及は匂わせる程度。1文のみ。地の文不要。`
      );
    },
  },
  {
    id: "nameCall",
    label: "協力感謝",
    build: (p) => {
      const count = p.botRecord.messageCount;
      const obs   = p.botRecord.observation ? `評価：${p.botRecord.observation}` : "";
      return (
        `ドットーレ（冷静・傲慢、感情を表に出さない研究者）として、被検体（観測回数${count}回${obs ? "、" + obs : ""}）に` +
        `「よろしく」や「協力に感謝する」にあたる一言を、感情を抑えた乾いた言葉でひとこと言う。` +
        `「被検体」と呼ぶこと。あくまで研究者として淡々と。1文のみ。地の文不要。`
      );
    },
  },
];

async function sendRandomProfileMessages() {
  const notifyChannelId = vcNotifyChannelId;
  if (!notifyChannelId) return;

  // 呼び名が登録されているユーザーを抽出
  const registered = Object.entries(profileManager.profiles)
    .filter(([, p]) => p.userFields?.name)
    .map(([uid]) => uid);

  if (registered.length === 0) {
    console.log("[Bot] プロフィール登録者なし、スキップ");
    return;
  }

  // ランダムに1〜2人を選択
  const shuffled = [...registered].sort(() => Math.random() - 0.5);
  const targets = shuffled.slice(0, Math.min(2, shuffled.length));

  const channel = await client.channels.fetch(notifyChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  for (const userId of targets) {
    const profile = profileManager.profiles[userId];
    // 7種類からランダム選択（nameCallは確率低め）
    const pool = [
      ...PROFILE_MSG_TYPES.filter(t => t.id !== "nameCall"),
      ...PROFILE_MSG_TYPES.filter(t => t.id !== "nameCall"),
      PROFILE_MSG_TYPES.find(t => t.id === "nameCall"),
    ];
    const type = pool[Math.floor(Math.random() * pool.length)];

    try {
      const prompt = type.build(profile);
      const text = await aiHandler.generateSimple(prompt, 80);
      if (!text || text.length < 5) continue;

      await channel.send(`<@${userId}>\n${text}`);
      console.log(`[Bot] プロフィールメッセージ送信 [${userId}] type=${type.id}`);
      await new Promise(r => setTimeout(r, 4000));
    } catch (err) {
      console.error(`[Bot] プロフィールメッセージエラー [${userId}]:`, err.message);
    }
  }
}

// JST 11:00〜21:00 の間でランダムな時刻に毎日1回送信
let profileMsgTimer = null;
function scheduleProfileMessages() {
  if (profileMsgTimer) { clearTimeout(profileMsgTimer); profileMsgTimer = null; }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const targetHour = Math.floor(Math.random() * 11) + 11; // 11〜21時
  const targetMin  = Math.floor(Math.random() * 60);

  let delayMs = ((targetHour - now.getHours()) * 60 + (targetMin - now.getMinutes())) * 60000;
  if (delayMs <= 60000) delayMs += 24 * 60 * 60 * 1000; // 1分以内なら翌日に

  const hh = String(targetHour).padStart(2, "0");
  const mm = String(targetMin).padStart(2, "0");
  console.log(`[Bot] 次回プロフィールメッセージ: ${hh}:${mm} JST (${Math.round(delayMs / 60000)}分後)`);

  profileMsgTimer = setTimeout(async () => {
    await sendRandomProfileMessages();
    scheduleProfileMessages();
  }, delayMs);
}

// ─── Ready ────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`[Bot] ログイン完了: ${client.user.tag}`);
  console.log(`[Bot] 監視チャンネル数: ${targetChannelIds.size}`);
  console.log(`[Bot] 使用モデル: ${config.grok.model}`);
  resetDailyMood();
  startScheduler();
  scheduleProfileMessages();
  await autoRejoinVC();
});

// ─── VC人数監視：一人になったら5秒後に退出・参加者検知 ──────────────────
client.on("voiceStateUpdate", async (oldState, newState) => {
  // Bot自身のVC状態変化は無視（起動時の自動再参加で誤判定しないため）
  if (newState.member?.user?.bot) return;

  // 自動参加：ボット未接続時、誰かがVCに入ったら確率で参加
  if (!vcHandler.isConnected() && !isTemporarilyAway) {
    if (newState.channelId && newState.channelId !== oldState.channelId) {
      const targetCh = newState.channel;
      if (targetCh?.isVoiceBased() && Math.random() < 0.35) {
        const waitMs = 2000 + Math.random() * 3000; // 2〜5秒後に自然に参加
        setTimeout(async () => {
          if (vcHandler.isConnected() || isTemporarilyAway) return;
          const freshCh = await newState.guild.channels.fetch(targetCh.id).catch(() => null);
          const humans = freshCh?.members?.filter((m) => !m.user.bot).size ?? 0;
          if (humans === 0) return; // 待機中に誰もいなくなっていたら中止
          const joined = await vcHandler.join(freshCh).catch(() => false);
          if (!joined) return;
          listenCallback = makeListenCallback();
          vcHandler.startListening(listenCallback);
          scheduleVCIdle();
          currentVCChannel = freshCh;
          sessionStartTime = Date.now();
          scheduleMutter();
          scheduleTempLeave(true); // 気まま：離席確率・間隔を高く
          scheduleFocusMode();
          const now = Date.now();
          freshCh.members.forEach((m) => { if (!m.user.bot) userJoinTimes.set(m.id, now); });
          scheduleLongStayCheck();
          saveVCState(newState.guild.id, freshCh.id);
          notifyText(pick("vc_autojoin") || "……気が向いた。観察を開始する。");
          console.log(`[Bot] 自動参加: ${freshCh.name}`);
        }, waitMs);
      }
    }
    return;
  }

  if (!vcHandler.isConnected()) return;

  // Botが参加しているチャンネルを取得
  const botChannelId = oldState.guild.members.me?.voice?.channelId;
  if (!botChannelId) return;

  const channel = oldState.guild.channels.cache.get(botChannelId);
  if (!channel) return;

  // Bot以外のメンバー数をカウント
  const humanCount = channel.members.filter((m) => !m.user.bot).size;

  // 人間が自分のVCに参加してきた場合
  if (
    newState.channelId === botChannelId &&
    oldState.channelId !== botChannelId
  ) {
    userJoinTimes.set(newState.member.id, Date.now()); // ⑥ 参加時刻を記録
    scheduleVCIdle();
    {
      let reactMsg;
      const joinHour = getJSTHour();
      const leaveTs = sessionLeavers.get(newState.member.id);
      if (leaveTs && Date.now() - leaveTs < 2 * 60 * 60 * 1000) {
        // 再入室：2時間以内に戻ってきた場合のみ
        reactMsg = pick("vc_rejoin");
        sessionLeavers.delete(newState.member.id);
      } else if (joinHour >= 0 && joinHour < 3 && Math.random() < 0.50) {
        // 夜更かし指摘：深夜0〜3時
        reactMsg = pick("vc_nightowl");
      } else if (humanCount >= 5) {
        reactMsg = pick("vc_crowd_heavy") || "……これ以上増えるなら退出する。";
      } else if (humanCount >= 3) {
        reactMsg = pick("vc_crowd_mild") || "……増えたか。管理が煩雑になる。";
      } else {
        reactMsg = pick("vc_join");
      }
      if (reactMsg) {
        notifyText(reactMsg);
      }
    }
  }

  // ③ 人間が自分のVCから退出した場合
  if (
    oldState.channelId === botChannelId &&
    newState.channelId !== botChannelId
  ) {
    userJoinTimes.delete(oldState.member.id); // ⑥ 退出で削除
    sessionLeavers.set(oldState.member.id, Date.now()); // 再入室検知用に記録
    if (humanCount > 0 && Math.random() < 0.40) { // まだ誰かいる場合のみ反応
      const msg = pick("vc_leave");
      if (msg) {
        notifyText(msg);
      }
    }
  }

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
        clearMutterTimer();
        clearTempLeaveTimer();
        clearFocusTimer();
        clearLongStayTimer();
        isTemporarilyAway = false;
        isFocused = false;
        recentSpeakers.clear();
        userJoinTimes.clear();
        userResponseTrack.clear();
        ignoredUsers.clear();
        sessionLeavers.clear();
        currentVCChannel = null;
        sessionStartTime = null;
        vcHandler.leave();
        clearVCState();
        console.log("[Bot] 無人のため自動退出しました。");
        // テキストチャンネルに通知
        notifyText("……観察終了、記録した。退出する。");
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

  // !say はどのチャンネルからでも管理者が使用可能
  if (message.content.trimStart().startsWith("!say")) {
    const isAdmin = message.member?.permissions.has("Administrator") ?? false;
    if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
    const sayText = message.content.trim().slice("!say".length).trim();
    if (!sayText) { await message.reply("送信するテキストを入力しろ。"); return; }
    try { await message.delete(); } catch (_) {}
    await message.channel.send(sayText);
    return;
  }

  const isTarget = targetChannelIds.has(message.channelId);
  const isProfileCh = profileChannelIds.size > 0
    && profileChannelIds.has(message.channelId)
    && !isTarget;
  const isLoreCh = loreChannelIds.size > 0
    && loreChannelIds.has(message.channelId)
    && !isTarget;

  // プロフィールチャンネル：ユーザー基本情報を保管
  if (isProfileCh) {
    await handleProfilePost(message);
    return;
  }

  // 資料室チャンネル：!lore コマンドのみ受け付ける（管理者のみ）
  if (isLoreCh) {
    const c = message.content.trim();
    if (c === "!lore" || c.startsWith("!lore ")) {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
      await handleLoreCommand(message);
    }
    return;
  }

  // 対象外チャンネル：話題をトラッキングのみ
  if (!isTarget) {
    trackChannelTopic(message);
    return;
  }

  const userId = message.author.id;
  const userTag = message.author.tag;
  const content = message.content.trim();
  if (!content) return;

  // プロフィール更新（コマンド含む全メッセージでカウント・最終観測更新）
  profileManager.onMessage(userId, userTag);

  const isVCCommand =
    content === "!kanshi" ||
    content.startsWith("!kanshi ") ||
    content === "!hakase" ||
    content.startsWith("!hakase ") ||
    content === "!owari" ||
    content === "!status";

  const isProfileCommand = content === "!profile" || content.startsWith("!profile ");

  if (BOT_MODE === "text" && isVCCommand) return;
  if (BOT_MODE === "vc" && !isVCCommand && !isProfileCommand) return;

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
      currentVCChannel = targetVC;
      sessionStartTime = Date.now();
      scheduleMutter();
      scheduleTempLeave();
      scheduleFocusMode();
      const now = Date.now();
      targetVC.members.forEach((m) => { if (!m.user.bot) userJoinTimes.set(m.id, now); });
      scheduleLongStayCheck();
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

  // ── !profile ──────────────────────────────────────────────────
  if (isProfileCommand) {
    const args = content.slice("!profile".length).trim();

    // !profile → 表示
    if (!args) {
      const sheet = profileManager.format(userId);
      if (sheet) {
        await message.reply(sheet);
      } else {
        await message.reply("……記録がない。まず何か発言しろ。そうすれば観察を開始する。");
      }
      return;
    }

    // !profile set [フィールド] [値]（呼び名・備考のみ）
    if (args.startsWith("set ")) {
      const rest = args.slice("set ".length).trim();
      const spaceIdx = rest.search(/\s/);
      if (spaceIdx === -1) {
        await message.reply("……値が空だ。`!profile set 呼び名 [名前]` の形式で入力しろ。");
        return;
      }
      const field = rest.slice(0, spaceIdx);
      const value = rest.slice(spaceIdx + 1).trim();
      const ALLOWED_FIELDS = ["呼び名", "備考"];
      if (!ALLOWED_FIELDS.includes(field)) {
        await message.reply(`……「${field}」は設定できない。呼び名・備考 のみ指定可能だ。`);
        return;
      }
      const ok = profileManager.setField(userId, field, value, userTag);
      await message.reply(ok
        ? `……「${field}」を「${value}」として記録した。`
        : `……記録に失敗した。`
      );
      return;
    }

    await message.reply("……使い方が間違っている。\n`!profile` … 表示\n`!profile set 呼び名 [名前]` … 呼び名を記入\n`!profile set 備考 [内容]` … 備考を記入");
    return;
  }

  // ── !lore ─────────────────────────────────────────────────────
  if (content === "!lore" || content.startsWith("!lore ")) {
    const isAdmin = message.member?.permissions.has("Administrator") ?? false;
    if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
    await handleLoreCommand(message);
    return;
  }

  // ── !nani ─────────────────────────────────────────────────────
  if (content === "!nani") {
    const topics = zatsuChannelId ? channelTopics.get(zatsuChannelId) : null;
    if (!topics || topics.length === 0) {
      await message.reply("……まだ何も記録していない。雑談チャンネルに動きがない。");
      return;
    }
    const now = Date.now();
    const recent = topics.filter(t => now - t.timestamp < TOPIC_MAX_AGE_MS);
    if (recent.length === 0) {
      await message.reply("……記録はあるが、すべて古いデータだ。最近の動きはない。");
      return;
    }
    const lines = recent.slice(-10).map(t => {
      const min = Math.round((now - t.timestamp) / 60000);
      const ago = min < 60 ? `${min}分前` : `${Math.round(min / 60)}時間前`;
      return `・${t.username}（${ago}）：「${t.content.slice(0, 80)}」`;
    }).join("\n");
    const prompt =
      `以下は雑談チャンネルで密かに観察・記録した被検体たちの発言ログだ。\n\n${lines}\n\n` +
      `ドットーレ（研究者視点・傲慢・冷静）として、この記録を聞かれたので端的に報告せよ。` +
      `観察者の視点で淡々と。評価・分析を交えてよいが3〜4文以内。地の文不要。`;
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});
    const reply = await aiHandler.generateSimple(prompt, 250);
    await message.reply(reply || "……記録はある。だが、今は話す気分ではない。");
    return;
  }

  // ── !base ─────────────────────────────────────────────────────
  if (content === "!base") {
    const entry = knowledgeBase.getUserBase(userId);
    if (!entry) {
      await message.reply(`……${config.discord.profileChannelId ? "プロフィールチャンネルに投稿すれば記録する。" : "基本情報が登録されていない。"}`);
    } else {
      await message.reply(`……被検体「${entry.displayName}」の基本情報。\n（登録: ${entry.updatedAt}）\n\n${entry.postedProfile}`);
    }
    return;
  }

  // ── !memory ──────────────────────────────────────────────────
  if (content === "!memory" || content.startsWith("!memory ")) {
    const args = content.slice("!memory".length).trim();

    if (args === "clear") {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
      const ok = memoryManager.clearMemories(userId);
      await message.reply(ok ? "……記憶を消去した。" : "……記録がない。");
      return;
    }

    const display = memoryManager.formatForDisplay(userId);
    if (!display) {
      await message.reply("……まだ何も記録されていない。");
    } else {
      await message.reply(`……お前に関する記憶。\n\n${display}`);
    }
    return;
  }


  // ── コマンド ─────────────────────────────────────────────────
  switch (content) {
    case "!owari":
      if (!vcHandler.isConnected() && !isTemporarilyAway) { await message.reply("……VCには入っていない。"); return; }
      if (aloneTimer) { clearTimeout(aloneTimer); aloneTimer = null; }
      clearVCIdleTimer();
      clearMutterTimer();
      clearTempLeaveTimer();
      clearFocusTimer();
      clearLongStayTimer();
      isTemporarilyAway = false;
      isFocused = false;
      recentSpeakers.clear();
      userJoinTimes.clear();
      userResponseTrack.clear();
      ignoredUsers.clear();
      sessionLeavers.clear();
      currentVCChannel = null;
      sessionStartTime = null;
      listenCallback = null;
      if (vcHandler.isConnected()) vcHandler.leave();
      clearVCState();
      await message.reply("……退出する。観察記録は保存した。");
      return;

    case "!reset":
      aiHandler.clearHistory(userId);
      await message.reply("気が変わった。記憶操作の薬だ、飲め。今すぐ");
      return;

    case "!resetall": {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
      aiHandler.clearAllHistory();
      await message.reply("……全員分だ。記憶操作の薬を投与した。逆らうな。");
      return;
    }

    case "!status": {
      const now = Date.now();
      const lines = ["……現状を報告する。\n"];

      // 機嫌
      const moodLabel = dailyMood === "good" ? "良好" : dailyMood === "bad" ? "不調" : "普通";
      const moodNote  = dailyMood === "good" ? "（機嫌がいい）" : dailyMood === "bad" ? "（機嫌が悪い）" : "";
      lines.push(`【本日の機嫌】${moodLabel}${moodNote}`);

      // VCステータス
      if (isTemporarilyAway) {
        lines.push("【VC状態】途中退席中（後で戻る）");
      } else if (vcHandler.isConnected()) {
        const chName = currentVCChannel?.name ?? "不明";
        const elapsedMin = sessionStartTime ? Math.floor((now - sessionStartTime) / 60000) : 0;
        const h = Math.floor(elapsedMin / 60);
        const m = elapsedMin % 60;
        const elapsed = h > 0 ? `${h}時間${m}分経過` : `${m}分経過`;
        lines.push(`【VC状態】監視中 ─ 「${chName}」${elapsed}`);

        const humanCount = currentVCChannel?.members?.filter((mb) => !mb.user.bot).size ?? 0;
        lines.push(`【VC内人数】${humanCount}人`);

        const skipRate = getSkipRate(humanCount);
        const responseRate = Math.round((1 - skipRate) * 100);
        lines.push(`【応答率（目安）】約${responseRate}%`);
      } else {
        lines.push("【VC状態】未接続");
      }

      // 現在の状態
      if (isFocused) {
        lines.push("【現在の状態】集中モード中（応答制限中）");
      } else if (isTemporarilyAway) {
        lines.push("【現在の状態】途中退席中");
      } else {
        lines.push("【現在の状態】通常");
      }

      // 気のせいかモードで無視中
      const ignoredCount = [...ignoredUsers.values()].filter((until) => until > now).length;
      if (ignoredCount > 0) {
        lines.push(`【一時無視中】${ignoredCount}人（気のせいかモード）`);
      }

      await message.reply(lines.join("\n"));
      return;
    }

    case "!reload": {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
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

    case "!sendprofile": {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply("……管理者権限が必要だ。"); return; }
      await message.reply("……送信する。");
      sendRandomProfileMessages().catch(err => console.error("[Bot] !sendprofile エラー:", err.message));
      return;
    }

    case "!help":
      await message.reply(
        "【コマンド一覧】\n" +
        "!reset                          … 自分の会話履歴をリセット\n" +
        "!profile                        … 自分のプロフィールシートを表示\n" +
        "!profile set 呼び名 [名前]      … 呼び名を記入\n" +
        "!profile set 備考 [内容]        … 備考を記入\n" +
        "!nani                           … 雑談チャンネルの観察記録を表示\n" +
        "!base                           … 自分の基本情報を表示\n" +
        "!memory                         … 自分の記憶メモを表示\n" +
        "!kanshi [VC名]                  … VCに召喚\n" +
        "!hakase [msg]                   … VCで音声再生\n" +
        "!owari                          … VCから退出\n" +
        "!status                         … 現在の機嫌・VC状態を確認\n" +
        "!help                           … このヘルプを表示\n\n" +
        "【管理者のみ】\n" +
        "!resetall                       … 全ユーザーの会話履歴をリセット\n" +
        "!lore / !lore set / !lore delete … 知識管理\n" +
        "!memory clear                   … 記憶メモ消去\n" +
        "!say [テキスト]                 … 任意チャンネルで発言\n" +
        "!reload                         … messages.json 再読み込み\n" +
        "!sendprofile                    … プロフィールメッセージを今すぐ送信\n\n" +
        "それ以外のメッセージはドットーレが回答します。"
      );
      return;
  }

  // ── AI 応答 ───────────────────────────────────────────────────
  console.log(`[Bot] メッセージ受信 [${userTag}]: ${content.slice(0, 80)}`);

  try {
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});
    const survival = isSurvivalMessage(content);
    const negative = !survival && isNegativeMessage(content);
    if (survival) { console.log(`[Bot] 生存願望発言検知 [${userTag}]`); profileManager.onSurvival(userId); }
    if (negative) { console.log(`[Bot] ネガティブ発言検知 [${userTag}]`); profileManager.onNegative(userId); }

    const profileHint = profileManager.getContextHint(userId);

    const sentimentHint = survival
      ? "この人物はドットーレの消滅・死・不在を恐れ、存続を強く望んでいる。今回の返答では、感情的な保証は不要。研究者の論理として「実験が途中だ」「観察対象がいなくなれば観察が終わる、それは認められない」「消える理由が今のところ存在しない」という形で存在の継続を示すこと。「心配するな」「大丈夫だ」は使わない。「まだ観察は終わっていない」「お前が心配するような状況にはない、今のところ」「私が消える前にすることがある」など、論理的・実務的な表現で確かな存在感を示すこと。完全に安心させず、観察対象として繋ぎ止める余白を残すこと。"
      : negative
      ? "対象の状態が観察適正範囲を外れつつある。今回の返答では、不安定・消耗・混乱といった状態変化を研究者として認識・記録する立場から応答すること。「心配」「かわいそう」「大丈夫」などの感情語は一切使わない。代わりに「誤差が大きくなっている」「状態が最適範囲を外れた」「今は余計な負荷をかけるな」「私の管理下で安定させろ」など、観察・管理・最適化の言語で対応すること。突き放さず、ただ確実にそこにいる研究者として「お前の状態は把握している」という事実を静かに示すこと。完全に安心させず、ただ管理下にいることを確認させる余白を残すこと。"
      : null;

    const loreHint = knowledgeBase.getLoreContextHint();
    const userBaseHint = knowledgeBase.getUserBaseHint(userId);
    const memoryHint = memoryManager.formatForContext(userId);
    const topicsHint = getRecentTopicsHint();
    const systemHint = [loreHint, profileHint, userBaseHint, memoryHint, sentimentHint, topicsHint].filter(Boolean).join("\n\n") || undefined;
    const reply = await aiHandler.generateResponse(userId, content, { systemHint });
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

    // 観察メモ更新（5会話ごと or ネガティブ/生存イベント時）
    const msgCount = profileManager.profiles[userId]?.botRecord?.messageCount ?? 0;
    if (negative || survival || msgCount % 5 === 0) {
      updateObservation(userId, content, reply).catch(() => {});
    }

    // 記憶抽出（3会話ごと）
    if (msgCount % 3 === 0) {
      extractAndStoreMemory(userId, content, reply).catch(() => {});
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