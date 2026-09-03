// bot.js
// Discord Bot メインエントリーポイント

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fs = require("fs");
const path = require("path");
const AIHandler = require("./ai-handler");
const { VCHandler } = require("./vc-handler");
const ProfileManager = require("./profile-manager");
const KnowledgeBase = require("./knowledge-base");
const MemoryManager = require("./memory-manager");
const dailyStreak = require("./daily-streak");
const StatusManager = require("./status-manager");
const InterBotState = require("./interbot-state");

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
  const configPath = process.env.CONFIG_PATH
    ? path.resolve(__dirname, process.env.CONFIG_PATH)
    : path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`[Bot] 設定ファイルが見つかりません: ${configPath}`);
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

// ─── キャラクター名（Grok指示文・表示テキストの補間に使用） ────────────────
// 注意：定時挨拶・独り言・記念日・フォローアップ等の補助生成プロンプトは
// 「（冷静・傲慢・知的な研究者）」等ドットーレ固有の人格描写を含んだまま。
// 別キャラでこれらのfeaturesを有効化する際は、当該プロンプト文面も要見直し。
const CHARACTER_NAME = config.character?.name || "ドットーレ";
const IS_PANTALONE = CHARACTER_NAME === "パンタローネ";
const STREAK_CHARACTER_KEY = IS_PANTALONE ? "pantalone" : "dottore";
const ADMIN_REQUIRED_REPLY = IS_PANTALONE
  ? "……申し訳ございませんが、管理者権限が必要です。"
  : "……管理者権限が必要だ。";

// ─── 動作モード ────────────────────────────────────────────────────────────
const BOT_MODE = (process.env.BOT_MODE || "all").trim();
console.log(`[Bot] 動作モード: ${BOT_MODE}`);

// ─── メッセージリストの読み込み ───────────────────────────────────────────
const MESSAGES_PATH = process.env.MESSAGES_FILE
  ? path.resolve(__dirname, process.env.MESSAGES_FILE)
  : path.join(__dirname, "messages.json");
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
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const aiHandler = new AIHandler(config);
const vcHandler = new VCHandler(config);
const profileManager = new ProfileManager(CHARACTER_NAME);
const statusManager = new StatusManager(CHARACTER_NAME);
const knowledgeBase = new KnowledgeBase();
const memoryManager = new MemoryManager();

const USER_HINTS_PATH = process.env.USER_HINTS_FILE
  ? path.resolve(__dirname, process.env.USER_HINTS_FILE)
  : path.join(__dirname, "user-hints.json");
let userHints = {};
try {
  if (fs.existsSync(USER_HINTS_PATH)) {
    userHints = JSON.parse(fs.readFileSync(USER_HINTS_PATH, "utf-8"));
    console.log(`[Bot] ユーザー専用ヒント読み込み完了: ${Object.keys(userHints).length}件`);
  }
} catch (err) {
  console.warn("[Bot] user-hints.json 読み込み失敗:", err.message);
}
const targetChannelIds = new Set(config.discord.targetChannelIds);
const commandOnlyChannelIds = new Set(config.discord.commandChannelIds ?? []);
const profileChannelIds = new Set(
  (config.discord.profileChannelId || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const loreChannelIds = new Set(
  (config.discord.loreChannelId || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const artChannelIds = new Set(
  (config.discord.artChannelId || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
// DMでの会話を許可するユーザーID（DMチャンネルは相手ごとにIDが変わるため、
// チャンネルIDではなく発言者のユーザーIDで許可判定する）。未設定なら誰にも許可しない。
const dmAllowedUserIds = new Set(
  (config.discord.dmAllowedUserIds ?? []).map(String)
);
const vcNotifyChannelId = config.discord.vcNotifyChannelId || [...new Set(config.discord.targetChannelIds)][0];
const zatsuChannelId = config.discord.zatsuChannelId || "";
const debugChannelId = config.discord.debugChannelId || "";
const jihouChannelIds = new Set(config.discord.jihouChannelIds ?? []);
const restrictedVCChannelIds = new Set(config.discord.restrictedVCChannelIds ?? []);
const restrictedVCNotifyChannelId = config.discord.restrictedVCNotifyChannelId || "";

// ─── Bot同士（パンタローネ⇄ドットーレ）の直接対話チャンネル ──────────────────
// interBotRole: "initiator"（定時に挨拶を開始する側＝パンタローネ）/ "responder"（応答のみ＝ドットーレ）
const interBotChannelId = config.discord.interBotChannelId || "";
const interBotRole = config.discord.interBotRole || "";
const interBotState = interBotChannelId ? new InterBotState() : null;

// ─── 応用mutter：もう一方のBotの担当チャンネルに割り込み、割り込まれた側がツッコミを返す ──
// （試験的機能・config.discord.crossMutterChannelIdが設定された時のみ。両Botの設定ファイルに
// 同じチャンネルIDを設定しておくこと。またDiscord側でそのチャンネルを両方のBotアカウントが
// 閲覧できる状態にしておく必要がある）。
const crossMutterChannelId = config.discord.crossMutterChannelId || "";
let lastCrossMutterAt = 0; // 連鎖・頻発防止用のクールダウン起点
const CROSS_MUTTER_COOLDOWN_MS = 30 * 60 * 1000; // 30分

// 直近の割り込みイベント（ドットーレの割り込み＋パンタローネのツッコミ）を保持する。
// このチャンネルで人間が発言した際、systemHintとして渡し、Botが「割り込みが起きたこと」を
// 認識した上で応答できるようにする（被検体が「はかせうるさい」等と割り込みに言及しても、
// 知らないふりをして「博士が何か？」と返してしまう不整合を防ぐ）。
let lastCrossMutterEvent = null; // { dottoreLine, retort, at }
const CROSS_MUTTER_EVENT_TTL_MS = 20 * 60 * 1000; // 20分は「直前の出来事」として扱う

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

// 話題スニペット中の「博士」「ドットーレ」「Dottore」等の呼称を「私」に変換する。
// 独り言・応用mutterはドットーレ視点の一人称生成だが、他チャンネルの発言スニペットをそのまま
// 渡すと「博士を制止するなど」のように三人称の他人事として処理してしまう問題があった（実測で確認）。
// パンタローネにとっては同じ呼称が「別人＝ドットーレ」を指すため、ドットーレ自身の視点でのみ適用する。
// トラッキング元データ（channelTopics）自体は変換せず、AIへ渡す直前の文字列にのみ適用する。
//
// あわせて、被検体がパンタローネを呼ぶ愛称「富者（様/殿/さん）」も「あいつ」へ変換する。
// これを残すとドットーレまで「富者様」と敬称付きで呼んでしまい、傲慢なキャラと矛盾する
// （Bot同士の直接対話では「富者殿」は正規の呼び名なので、そちらでは変換しない＝この関数を通さない）。
function withDottoreSelfReference(text) {
  if (IS_PANTALONE) return text;
  return text
    .replace(/博士|ドットーレ|[Dd]ottore/g, "私")
    .replace(/富者(?:様|殿|さん|君)?/g, "あいつ");
}

// ドットーレの独り言系の出力に「富者（様/殿/さん）」が残った場合に「あいつ」へ均す。
// 入力スニペットの変換だけでは、モデルが語彙として「富者」を補完してくることがあるため、
// 送信直前にもう一段かける（応用mutter・テキストmutter専用。Bot同士の対話には適用しない）。
function stripPantaloneEpithet(text) {
  if (IS_PANTALONE || !text) return text;
  return text.replace(/富者(?:様|殿|さん|君)?/g, "あいつ");
}

function getRecentTopicsHint() {
  const now = Date.now();
  const lines = [];
  for (const [, topics] of channelTopics) {
    const recent = topics.filter(t => now - t.timestamp < TOPIC_MAX_AGE_MS);
    if (recent.length === 0) continue;
    const chName = recent[0].channelName;
    const snippet = recent.slice(-3)
      .map(t => `「${withDottoreSelfReference(t.content.slice(0, 80))}」(${t.username})`)
      .join("、");
    lines.push(`#${chName}: ${snippet}`);
  }
  if (lines.length === 0) return "";
  return `【他チャンネルの最近の動向（参考情報）】\n${lines.join("\n")}`;
}

// 直近の割り込みイベントを systemHint 文字列に変換する。
// crossMutterChannel で人間が発言したときのみ、かつイベントがまだ新しいときのみ返す。
function getCrossMutterEventHint(channelId) {
  if (!crossMutterChannelId || channelId !== crossMutterChannelId) return "";
  if (!lastCrossMutterEvent) return "";
  const elapsed = Date.now() - lastCrossMutterEvent.at;
  if (elapsed > CROSS_MUTTER_EVENT_TTL_MS) return "";

  const min = Math.max(1, Math.round(elapsed / 60000));
  const { dottoreLine, retort } = lastCrossMutterEvent;

  if (IS_PANTALONE) {
    return `【直前の出来事（あなたも被検体も見ている）】\n` +
      `約${min}分前、ドットーレが被検体との会話に不意に割り込み、「${dottoreLine}」と発言した。` +
      (retort ? `あなた（パンタローネ）はそれに「${retort}」と返し、話を被検体に戻した。` : ``) +
      `被検体が博士（ドットーレ）や「割り込み」「うるさい」等に言及した場合、知らないふりをせず、` +
      `この割り込みが実際に起きたことを踏まえて自然に応答すること。「博士が何か？」のように出来事自体を認識していない返答はしないこと。`;
  }
  return `【直前の出来事（あなたも被検体も見ている）】\n` +
    `約${min}分前、あなた（ドットーレ）はパンタローネと被検体の会話に割り込み、「${dottoreLine}」と発言した。` +
    `被検体がその割り込みに言及した場合、知らないふりをせず、割り込んだ事実を踏まえて応答すること。`;
}

// ─── 反復回避ヒント ───────────────────────────────────────────────────────
// grok-4-fast 系（非推論）は自分の直前の出力を追跡できず、同じ仕草・同じ枕詞
// （「そうか」「なるほど」「随分と」、相手の言葉のオウム返し）に固着しやすい。
// 静的プロンプトに禁止フレーズを逐語で並べると、その文字列自体が再利用を誘発するため、
// 「直近で実際に何を使ったか」だけを毎ターン差し戻す動的ヒントで抑える。
const CRUTCH_OPENER_RE = /^(?:…+)?\s*(そうか|そうだな|そうですか|そうですね|なるほど|ふむ|ふん|随分と|ずいぶんと)/;
const ECHO_OPENER_RE = /^[^（）()\n。！？]{1,12}(?:か。|か、|、と。|、だと[。？]|だと[。？]|というわけか|ということか|ですか。)/;
const QUESTION_END_RE = /(？|\?|か。|かな。|かね。|のか。|のでしょう。|でしょうか。|いかがですか。|いただけますか。|ますか。)\s*$/;
const PROP_RE = /机|ペン|カップ|コーヒー|眼鏡|記録用紙|ページ|グラス|ワイン|杯|葉巻|煙草|たばこ|袖口|カフス|懐中時計|契約書|ナプキン|息を[吐つ]/g;
const stripTrailingGesture = (s) => s.replace(/(?:[（(][^（）()]*[）)]\s*)+$/, "").trim();

function getAntiRepetitionHint(userId) {
  const history = aiHandler.getHistory(userId);
  const recent = history.filter(h => h.role === "assistant").slice(-4).map(h => (h.content || "").trim());
  if (recent.length === 0) return "";

  const gestureCount = recent.reduce(
    (n, m) => n + (m.match(/[（(][^（）()]{1,40}[）)]/g)?.length ?? 0), 0);
  const propHits = (recent.join("").match(PROP_RE) ?? []).length;

  const lastBody = recent[recent.length - 1]
    .replace(/[（(][^（）()]*[）)]/g, "")
    .replace(/\s+/g, "");
  const openedBad = CRUTCH_OPENER_RE.test(lastBody) || ECHO_OPENER_RE.test(lastBody);
  const questionEndings = recent.slice(-3).filter(m => QUESTION_END_RE.test(stripTrailingGesture(m))).length;

  const parts = ["【今回の返答で厳守（反復回避）】"];
  parts.push(
    `一文目から${CHARACTER_NAME}自身の反応・評価・観察に入ること。` +
    `相手の発言の語をそのまま返す書き出し（「〜か。」「〜、と。」「〜ですか。」等）や、` +
    `「そうか」「そうですか」「なるほど」「ふむ」「随分と」で始める書き出しをしないこと。`);
  if (openedBad) {
    parts.push("※直前の返答はまさにその禁じ手で書き出している。今回は必ず別の入り方にすること。");
  }
  if (questionEndings >= 2) {
    parts.push(
      "※直近の返答が続けて疑問・問い返しで終わっており、取り調べのようになっている。" +
      "今回は質問で終えず、言い切り・所感・値踏み・軽い一言で締めること。相手に次の情報を要求しないこと。");
  }
  if (gestureCount >= 3 || propHits >= 3) {
    parts.push(
      "直近の返答で括弧書きの仕草が続き、同じ小道具（机・ペン・カップ／グラス・葉巻など）や呼吸描写に偏っている。" +
      "今回は仕草を入れないか、入れるなら手・姿勢・視線・間・声の調子など別の要素にすること。");
  }
  parts.push("直近の返答と同じ文型・同じ締めの定型文を繰り返さないこと。");
  return parts.join("\n");
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
  const displayName = profile.userFields?.name || profile.displayName;

  const prompt = IS_PANTALONE
    ? `以下は「${displayName}」さんとの最新のやりとりだ。このデータをもとに、${displayName}さんの人物像・行動傾向・特性に関する観察記録を更新せよ。\n\n` +
      `現在の記録：「${existing}」\n` +
      `${displayName}さんの発言：「${userMessage.slice(0, 300)}」\n` +
      `（参考）${CHARACTER_NAME}の返答：「${aiReply.slice(0, 150)}」\n\n` +
      `出力形式：1〜2文の観察メモのみ出力すること（説明・前置きやパンタローネの台詞は不要）。` +
      `パンタローネ本人の記録という体で、「${displayName}さん」のように名前＋さん付けで呼び、通常のパンタローネの話し方（丁寧な敬語、です・ます調）で記述すること。「被検体」という語は使わないこと。` +
      `観察可能な事実・傾向・パターンのみ（例：「深夜にいらっしゃる傾向がおありです」「ご自身を卑下される発言が多いようです」）。` +
      `既存記録がある場合は統合・要約してよい。`
    : `以下は研究対象との最新のやりとりだ。このデータをもとに被検体の人物像・行動傾向・特性に関する観察記録を更新せよ。\n\n` +
      `現在の記録：「${existing}」\n` +
      `被検体の発言：「${userMessage.slice(0, 300)}」\n` +
      `（参考）${CHARACTER_NAME}の返答：「${aiReply.slice(0, 150)}」\n\n` +
      `出力形式：1〜2文の観察メモのみ出力すること（説明・前置き・${CHARACTER_NAME}の台詞は不要）。` +
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

// ─── 矛盾検知（記憶と新しい発言を照合、確率・クールダウン付き）──────────────
const contradictionCooldowns = new Map(); // userId → 最終チェック時刻

async function checkContradiction(userId, newMessage) {
  if (config.features?.contradictionCheck === false) return null;

  const COOLDOWN_MS = 10 * 60 * 1000;
  const now = Date.now();
  if ((contradictionCooldowns.get(userId) ?? 0) + COOLDOWN_MS > now) return null;

  const memories = [...memoryManager.getMemories(userId), ...memoryManager.getSavedMemories(userId)];
  if (memories.length < 3) return null;
  if (Math.random() > 0.3) return null; // 発動確率を抑える

  contradictionCooldowns.set(userId, now);

  const memoryText = memories.slice(-15).map(e => `・${e.text}`).join("\n");
  const prompt =
    `以下は被検体についてこれまでに記録された事実だ。\n${memoryText}\n\n` +
    `被検体の新しい発言：「${newMessage.slice(0, 200)}」\n\n` +
    `この新しい発言は、上記の記録内容と明確に矛盾しているか？矛盾している場合のみ、その矛盾点を1文で簡潔に述べよ` +
    `（例：「以前は猫を飼っていないと言っていたはずだが」）。矛盾していない、または判断できない場合は「なし」とだけ出力せよ。`;

  try {
    const result = await aiHandler.generateSimple(prompt, 100);
    if (result && result.trim() !== "なし" && result.length < 150) {
      return result.trim();
    }
  } catch (err) {
    console.error("[Bot] 矛盾検知エラー:", err.message);
    contradictionCooldowns.delete(userId);
  }
  return null;
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

// 被検体登録テンプレート（名前・年齢・性別／代名詞・趣味・一言メッセージ）の
// 5項目すべてが揃っているかを判定する。!scan_profiles は雑談や単発のお礼メッセージまで
// 拾ってしまわないよう、このテンプレートに沿った投稿のみを対象にする。
function isCompleteProfileTemplate(content) {
  const parsed = parseProfileTemplate(content);
  return Boolean(parsed.name && parsed.age && parsed.gender && parsed.hobby && parsed.memo);
}

async function handleProfilePost(message, { silent = false } = {}) {
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

  if (!silent) {
    const PROFILE_REG_REPLIES = {
      "ドットーレ": [
        "……データを受け取った。記録する。",
        "登録を確認した。被検体として管理下に置く。",
        "……ふん。一応、記録しておこう。",
        "被検体よ、情報を受領した。引き続き観察する。",
        "……記録完了。これで管理対象だ。",
        "データ、確認した。期待はしていないが、参考にしよう。",
        "……登録を認める。以後、観察を続ける。",
      ],
      "パンタローネ": [
        "……ご登録、確かに拝見いたしました。貴重な情報、頂戴しております。",
        "登録、確認いたしました。今後ともお付き合いのほど、よろしくお願いいたします。",
        "なるほど……。よい対価をいただきました。",
        "情報、確かに受け取りました。……悪くない取引です。",
        "……登録、確認いたしました。今後の対話を楽しみにしております。",
        "拝見いたしました。まずまず、といったところでしょうか。",
        "……ご登録、ありがとうございます。これも一つの、大切な情報として。",
      ],
    };
    try {
      const replyList = PROFILE_REG_REPLIES[CHARACTER_NAME] ?? PROFILE_REG_REPLIES["ドットーレ"];
      const reply = replyList[Math.floor(Math.random() * replyList.length)];
      await message.reply(reply);
    } catch (_) {}
  }

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
      await message.reply(IS_PANTALONE ? "……まだ、何も記録がございませんね。" : "……まだ何も登録されていない。");
    } else {
      await message.reply(`【登録済み知識】\n${cats.map(c => `・${c}`).join("\n")}`);
    }
    return;
  }

  if (args.startsWith("set ") && isAdmin) {
    const rest = args.slice("set ".length).trim();
    const spaceIdx = rest.search(/\s/);
    if (spaceIdx === -1) { await message.reply(IS_PANTALONE ? "……カテゴリと内容、両方をご指定ください。" : "……カテゴリと内容を両方指定しろ。"); return; }
    const cat = rest.slice(0, spaceIdx).trim();
    const loreContent = rest.slice(spaceIdx + 1).trim();
    knowledgeBase.setLore(cat, loreContent);
    await message.reply(IS_PANTALONE ? `……「${cat}」、確かに記録いたしました。` : `……「${cat}」を記録した。`);
    return;
  }

  if (args.startsWith("delete ") && isAdmin) {
    const cat = args.slice("delete ".length).trim();
    const ok = knowledgeBase.deleteLore(cat);
    if (IS_PANTALONE) {
      await message.reply(ok ? `……「${cat}」、削除いたしました。` : `……「${cat}」は、存在しないようですね。`);
    } else {
      await message.reply(ok ? `……「${cat}」を削除した。` : `……「${cat}」は存在しない。`);
    }
    return;
  }

  if (args.startsWith("set ") || args.startsWith("delete ")) {
    await message.reply(ADMIN_REQUIRED_REPLY);
    return;
  }

  const entry = knowledgeBase.getLore(args);
  if (!entry) {
    await message.reply(IS_PANTALONE ? `……「${args}」というカテゴリは、存在しないようですね。` : `……「${args}」というカテゴリは存在しない。`);
  } else {
    await message.reply(`【${args}】\n${entry.content}\n（更新: ${entry.updatedAt}）`);
  }
}

// ─── イラスト投稿チャンネル処理 ─────────────────────────────────────────────
// 画像投稿にのみ短いコメントを返す。雑談・会話履歴の扱いはしない
async function handleArtPost(message) {
  const imageAttachments = [...message.attachments.values()].filter(a => a.contentType?.startsWith("image/"));
  if (imageAttachments.length === 0) return; // テキストのみの投稿は無視

  const att = imageAttachments[0];
  if (att.size > 10 * 1024 * 1024) return;

  try {
    const imgRes = await fetch(att.url);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const description = await aiHandler.describeImage(buffer, att.contentType);
    if (!description) return;

    const prompt =
      `以下は被検体が投稿したイラストの説明だ。\n「${description}」\n\n` +
      `${CHARACTER_NAME}（冷静・傲慢・知的な研究者）として、このイラストに対する短い感想・観察コメントを1つ生成せよ。` +
      `1〜2文、60文字程度。行動描写（括弧書き）を使ってもよい。前置き不要、セリフ本文のみ出力。`;

    const comment = await aiHandler.generateSimple(prompt, 100);
    if (comment) {
      await message.reply(comment);
      console.log(`[Bot] イラストコメント送信 [${message.author.tag}]: ${comment.slice(0, 60)}`);
    }
  } catch (err) {
    console.error(`[Bot] イラスト認識エラー [${message.author.tag}]:`, err.message);
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
let fatigueTimer = null;      // 疲労退出タイマー
let dailyMood = null;         // ④⑤ 日替わり機嫌 'good'|'neutral'|'bad'
let isFocused = false;        // ① 集中モード中フラグ
let focusTimer = null;        // ① 集中モードタイマー
let isKiiteMode = false;      // !kiite：スキップレートをほぼゼロにする
const recentSpeakers = new Map(); // ② 連続発言追跡 userId→{count, lastTime}
const userJoinTimes = new Map();  // ⑥ 長居追跡 userId→joinTimestamp
let longStayTimer = null;     // ⑥ 長居チェック定期タイマー
const userResponseTrack = new Map(); // 同一応答追跡 userId→{text, count, firstTime}
const ignoredUsers = new Map();      // 一時無視 userId→ignoreUntilTimestamp
const sessionLeavers = new Map();    // 今セッション中に退出したユーザーID（再入室検知用）userId→leaveTimestamp
const returningUserGreeted = new Set(); // 久しぶりユーザー：セッション内で既に挨拶済みのuserId

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
  if (isKiiteMode) return 0.02; // !kiiteモード：ほぼ全発言に反応
  let base = 0.05;
  if (sessionStartTime) {
    const min = (Date.now() - sessionStartTime) / 60000;
    if (min >= 240) base = 0.12;      // 4時間以上：常連として馴染み、少し戻る
    else if (min >= 90) base = 0.20;
    else if (min >= 60) base = 0.15;
    else if (min >= 30) base = 0.10;
  }
  // 大人数ほど応答しなくなる
  const count = humanCount ?? 1;
  if (count >= 5) base = Math.min(base + 0.20, 0.60);
  else if (count >= 3) base = Math.min(base + 0.08, 0.40);
  // 時間帯補正（深夜は機嫌良い・反応増、朝は機嫌悪い・反応減）
  const hour = getJSTHour();
  if (hour >= 23 || hour < 2) base = Math.max(base - 0.05, 0.02);
  else if (hour >= 6 && hour < 10) base = Math.min(base + 0.08, 0.70);
  // 日替わり機嫌補正
  if (dailyMood === "good") base = Math.max(base - 0.05, 0.02);
  else if (dailyMood === "bad") base = Math.min(base + 0.05, 0.70);
  return base;
}

// ③ キーワード（名前を呼ばれたら必ず反応）
const TRIGGER_KEYWORDS = ["ドットーレ", "博士", "ハカセ", "dottore"];

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

// 観測回数マイルストーン到達時のセリフ（profileManager.checkMilestone と対応）
const MILESTONE_LINES = {
  "ドットーレ": {
    50:   "……観測回数、50に達したか。悪くないデータ量だ。",
    150:  "……150回か。……そろそろお前のパターンが見えてきた。",
    300:  "……300。……随分と付き合いが長くなったものだな。",
    500:  "……500、か。……ここまで来ると、単なる被検体では片付けられなくなる。",
    1000: "……1000。……お前は私の記録の中でも、稀な部類に入る。",
  },
  "パンタローネ": {
    50:   "……50回、ですか。……なるほど、悪くない対話量です。",
    150:  "……150回。……貴方様の傾向も、そろそろ見えてまいりました。",
    300:  "……300、ですか。……随分と、お付き合いいただいているのですね。",
    500:  "……500、ですか。……もはや単なる対話相手とは申せないようです。",
    1000: "……1000。……貴方様は、私の記録の中でも稀有な存在です。",
  },
};

// パンタローネ・博士の「両方」に同じ日に話しかけてくれた連続日数のマイルストーン
// （dailyStreak.recordContact と対応。両キャラを跨ぐ話なので、片方のセリフでも
// もう一方の存在を軽く匂わせる）
const STREAK_MILESTONE_LINES = {
  "ドットーレ": {
    3:   "……3日連続の観測データか。悪くない。",
    7:   "……7日連続か。パンタローネの方にも、同じ頻度で顔を出しているようだな。……律儀なことだ。",
    14:  "……14日連続。二人分の記録に、同じ密度で名前が並んでいる。……珍しい被検体だ。",
    30:  "……30日連続とはな。……お前は、私とパンタローネ、双方にとって無視できない変数になりつつある。",
    60:  "……60日連続、か。……ここまで来ると、偶然とは言わせない。",
    100: "……100日連続。……お前は私の記録の中でも、稀な部類に入る。パンタローネの記録でも、恐らく同じだろう。",
  },
  "パンタローネ": {
    3:   "……3日連続でのご来訪、確かに記録いたしました。",
    7:   "……7日連続、ですか。……博士の方にも、同じ頻度でいらしているようですね。律儀な方だ。",
    14:  "……14日連続。……私と博士、双方の記録に同じ密度でお名前が並んでおります。悪くない取引です。",
    30:  "……30日連続とは。……もはや私にとっても博士にとっても、無視できない継続契約と呼べましょう。",
    60:  "……60日連続、ですか。……これほどの継続は、そう多くはございません。",
    100: "……100日連続。……貴方様は、私にとっても博士にとっても、稀少な資産となりつつあります。",
  },
};

// 連続日数マイルストーンに応じた関係進展ボーナス（会話回数換算で加算）
const STREAK_BONUS_BY_MILESTONE = { 3: 6, 7: 14, 14: 28, 30: 60, 60: 120, 100: 200 };

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
  if (config.features?.mutter === false) return;
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
  if (config.features?.autoAction === false) return;
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

// ─── 深夜・早朝の機嫌悪化ヒント ──────────────────────────────────────────
function getTimeBasedMoodHint() {
  if (config.features?.deepNightMood === false) return null;
  const hour = getJSTHour();
  if (hour >= 2 && hour < 4) {
    return `現在深夜2〜4時。${CHARACTER_NAME}は睡眠不足で機嫌が極めて悪い。返答は1〜2語の最小限に。「寝ろ」「うるさい」「後にしろ」程度で構わない。`;
  }
  if (hour >= 5 && hour < 7) {
    return `現在早朝5〜7時。${CHARACTER_NAME}は機嫌が悪く、返答は短く素っ気ない。ただし、これは単なる挨拶や雑談を追い払う理由にはならない。「用がないなら去れ」のように単なる挨拶を拒絶するのは行き過ぎだ。素っ気なさは口数と温度の問題であり、相手を拒絶することではない。`;
  }
  return null;
}

// ─── 疲労退出 ─────────────────────────────────────────────────────────────
function clearFatigueTimer() {
  if (fatigueTimer) { clearTimeout(fatigueTimer); fatigueTimer = null; }
}

function scheduleFatigue() {
  if (config.features?.fatigue === false) return;
  clearFatigueTimer();
  if (!vcHandler.isConnected()) return;
  const delayMs = (120 + Math.random() * 60) * 60 * 1000; // 2〜3時間後
  fatigueTimer = setTimeout(() => { fatigueTimer = null; doFatigueLeave(); }, delayMs);
  console.log(`[Bot] 疲労タイマー設定: ${Math.round(delayMs / 60000)}分後`);
}

async function doFatigueLeave() {
  if (!vcHandler.isConnected()) return;
  const msg = pick("vc_fatigue") || "……限界だ。今日の実験はここまでにしておく。";
  notifyText(msg);
  await new Promise((r) => setTimeout(r, 3000));
  if (!vcHandler.isConnected()) return;
  clearVCIdleTimer();
  clearMutterTimer();
  clearTempLeaveTimer();
  clearFocusTimer();
  clearLongStayTimer();
  isTemporarilyAway = false;
  isFocused = false;
  recentSpeakers.clear();
  userJoinTimes.clear();
  sessionLeavers.clear();
  returningUserGreeted.clear();
  await vcHandler.playLeaveSound().catch(() => {});
  currentVCChannel = null;
  sessionStartTime = null;
  vcHandler.leave();
  clearVCState();
  console.log("[Bot] 疲労退出完了");
}

// ─── 途中退席 ─────────────────────────────────────────────────────────────
let isTemporarilyAway = false;
let tempLeaveTimer = null;

function clearTempLeaveTimer() {
  if (tempLeaveTimer) { clearTimeout(tempLeaveTimer); tempLeaveTimer = null; }
}

function scheduleTempLeave(capricious = false) {
  if (config.features?.autoAction === false) return;
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
const VC_STATE_PATH = process.env.VC_STATE_FILE
  ? path.resolve(__dirname, process.env.VC_STATE_FILE)
  : path.join(__dirname, "vc-state.json");

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
      scheduleFatigue();
      const now = Date.now();
      channel.members.forEach((m) => { if (!m.user.bot) userJoinTimes.set(m.id, now); });
      scheduleLongStayCheck();
      vcHandler.playJoinSound().catch(() => {});
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
  const ids = (currentVCChannel && restrictedVCChannelIds.has(currentVCChannel.id) && restrictedVCNotifyChannelId)
    ? [restrictedVCNotifyChannelId]
    : [...new Set([vcNotifyChannelId, debugChannelId].filter(Boolean))];
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

// ─── Bot同士の直接対話（パンタローネ⇄ドットーレ）────────────────────────────
// パンタローネが挨拶を開始し、ドットーレが応答する形で、対面での会話として交わす
// （動作描写込み）。起承転結で運び、上限往復数（interbot-state.jsのMAX_ROUNDS）まで続ける。
//
// セッションには2モードある（interBotState.getSessionMode()）：
//  - "report"（12時・18時）：起＝挨拶／承＝被検体の世間話の導入／転＝話題転換／結＝締め。
//    承・転の話題は被検体ゴシップが基本だが3割で「今日食べたもの」に振れる（buildFoodTopicHint）。
//  - "relax"（23時）：薄暗い部屋で二人がくつろぐ夜の時間。報告・ゴシップはせず、ぽつぽつとした
//    短い会話と多めの動作描写で過ごす。起＝パンタローネが手土産持参で立ち寄る／結は同じ。
//    中盤はRELAX_BEATSを回転させて単調化を防ぐ。
function interBotCounterpartName() {
  return IS_PANTALONE ? "ドットーレ" : "パンタローネ";
}

// 現在のJST時刻から、開始すべき／進行中とみなすべきセッションのモードを判定する。
// 23時台（および長引いた場合の保険で22時台）は「くつろぎ」、それ以外は通常の「報告」。
function currentInterBotMode() {
  const h = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).getHours();
  return (h === 22 || h === 23) ? "relax" : "report";
}

function isRelaxSession() {
  return interBotState?.getSessionMode() === "relax";
}

// 23時のくつろぎセッションの中盤ターンに、単調なループを避けるため回転させる「入り方」の目安。
// （8往復＝中盤12ターンが全く同じ指示だと、非推論モデルでは同じ短文の反復になりやすい）
const RELAX_BEATS = [
  "手土産（菓子・酒など）に手を伸ばし、味や品について短く一言添える程度に留める",
  "部屋の暗さ・静けさ・夜であること、あるいは時間の流れの遅さに、ふと一言だけ触れる",
  "セリフは言わず、動作描写だけでこのターンを終える（相手の様子をうかがう、姿勢を変える、視線を動かす等）",
  "相手の直前の仕草や短い一言に、ごく短い相槌か軽い皮肉だけを返す",
  "四百年の付き合いの中の他愛ない断片（昔の商談、昔訪れた街、以前にもこうして過ごしたこと等）に、一言だけ触れる",
  "今は特に言うことがない、という間をそのまま出す（「……」に近い短い返し＋動作描写）",
];

// 23時のくつろぎセッション用のシーン説明。報告・ゴシップではなく「一緒に過ごすだけ」の空気。
const RELAX_GESTURE_MENU = {
  "パンタローネ": "背もたれに身を預ける／脚を組む／脚を組み替える／長く息をつく／杯を傾ける／指先で杯の縁をなぞる／窓の外へ視線を向ける／煙草に火を点ける／ゆっくりと煙を吐く／灰を落とす／手袋を外して卓に置く",
  "ドットーレ": "椅子に深く沈む／脚を組む／脚を組み替える／長く息を吐く／天井を見上げる／手元の資料を閉じる／目を閉じる／頬杖をつく／指を組んで顎を乗せる／グラスを揺らす",
};

function interBotRelaxSceneHint() {
  const cp = interBotCounterpartName();
  const base = `【現在の状況】夜。照明を落とした薄暗い部屋で、${CHARACTER_NAME}と${cp}が向かい合ってゆっくりくつろいでいる。今夜は観測結果の報告やゴシップ話をする場ではなく、四百年来の間柄の二人が、特に何をするでもなく同じ時間を過ごすだけの場だ。会話はぽつぽつと途切れがちで構わない――むしろ沈黙、ふとした短い一言、そして仕草のほうが主役になる。セリフは短く（多くて1文、時には言わずに動作だけでもよい）、その代わり括弧書きの動作描写を必ず入れ、多めに交えること。ただし同じ仕草を繰り返さず、毎回違う種類の動作を選ぶこと。被検体の話・分析・タスクの話・仕事の話には踏み込まない。「〜する必要がある」といった業務じみた言い回しはしない。直前の${cp}のセリフや言い回しをそのまま返さないこと。`;
  return IS_PANTALONE
    ? `${base}\n${CHARACTER_NAME}の動作の例（毎回変えること）：${RELAX_GESTURE_MENU["パンタローネ"]}。${cp}への呼びかけは「貴方」または「ドットーレ」。くつろいだ場でも口調は常に敬語（です・ます調）を保ち、だ・である調や体言止めの言い切りにはしないこと。`
    : `${base}\n${CHARACTER_NAME}の動作の例（毎回変えること）：${RELAX_GESTURE_MENU["ドットーレ"]}。${cp}への呼びかけは「お前」または「パンタローネ」。`;
}

function interBotSceneHint() {
  if (isRelaxSession()) return interBotRelaxSceneHint();
  const base = `【現在の状況】ここは${CHARACTER_NAME}と${interBotCounterpartName()}が定期的に顔を合わせ、対面で直接話す場だ。二人はそれぞれ、この場（コミュニティ）で接している被検体たちについて観測を続けており、この対話はその観測結果を共有し合う機会でもある。ただし業務報告のような堅苦しい確認作業ではなく、四百年来の気心の知れた間柄同士が、被検体たちの話をネタに世間話・ゴシップ話として盛り上がる、くつろいだ雑談の場として運ぶこと。「〜する必要がある」「確認が必要だ」といった業務報告・タスク管理じみた言い回しを連発しないこと。話題は被検体（利用者）に関するもの、または二人自身の今日の食事の話に留め、天候・技術・文化といった被検体と無関係な世間話には広げないが、被検体の話そのものは分析対象としてではなく、気の置けない相手と面白がって話すような調子で語ること。他の被検体・利用者は一切関与しない、二人だけの対話である。通常の会話と同じように、括弧書きの動作描写（身振り・仕草など）を交えて構わない。直前の${interBotCounterpartName()}のセリフの言い回しやフレーズをそのまま繰り返したり言い換えたりせず、それに対する自分なりの反応（突っ込み・茶化し・話題の転換など）で応じること。`;
  return IS_PANTALONE
    ? `${base}ドットーレへの呼びかけは「貴方」または「ドットーレ」であり、「博士」は呼びかけには使わないこと（博士は言及時のみ）。四百年来の間柄なので、他の被検体が相手の時より幾分か率直な話題や軽い皮肉を交えて構わないが、これは話す内容の話であり、口調（語尾）は常に敬語（です・ます調）を保つこと。動揺したり問い詰められたりしても、丁寧さを崩してぞんざいな言い方（だ・である調、体言止めの言い切りなど）にはならない。ドットーレが持ち出す分析的・臨床的な話題（監視・統制・観測対象の行動パターンなど）に付き合う場合も同様で、内容が冷徹・分析的になるのは構わないが、語尾までドットーレの「だ・である」調に引きずられて同化してはならない（実測で、このような話題が数往復続くと敬語が崩れていく現象が確認されている）。この対話内で自分自身の直前までの発言が万一敬語から崩れていたとしても、それを踏襲せず、この発言からは必ず敬語（です・ます調）に戻すこと。`
    : `${base}パンタローネへの呼びかけは「お前」または「パンタローネ」であり、「貴方」は使わないこと。`;
}

// 直近3日以内に活動があり、記憶データを持つ相手を1名ランダムに選び、その最新の記憶を返す
// （パンタローネが「最近話した相手」について、実際にあったやりとりだけを話題にできるようにするため）。
// 同一セッション内で同じ人物が重複して選ばれないよう、既に話題に出た相手は除外する。
function pickRecentInterlocutorMemory() {
  const now = Date.now();
  const alreadyMentioned = new Set(interBotState?.getMentionedUserIds() ?? []);
  const eligible = Object.entries(profileManager.profiles).filter(([userId, p]) => {
    if (alreadyMentioned.has(userId)) return false;
    const memories = memoryManager.getMemories(userId);
    if (memories.length === 0) return false;
    const lastSeen = p.botRecord?.lastSeen;
    if (!lastSeen) return false;
    const daysSinceSeen = (now - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceSeen <= 3;
  });
  if (eligible.length === 0) return null;
  const [userId, p] = eligible[Math.floor(Math.random() * eligible.length)];
  const memories = memoryManager.getMemories(userId);
  interBotState?.markUserMentioned(userId);
  return {
    displayName: p.userFields?.name || p.displayName,
    memoryText: memories[memories.length - 1].text,
  };
}

// 指示文自体の文体（だ・である調／です・ます調）がそのままキャラクターの
// セリフの口調に引きずられる現象が実測で確認されたため、指示文もキャラクターの
// 通常の話し方に合わせた文体で書く（パンタローネ＝敬語、ドットーレ＝だ・である調）。
// また「セリフ本文のみ」と縛りすぎると動作描写（括弧書き）が出なくなる現象も確認されたため、
// 通常の会話と同じ形式（動作描写を交えてよい）であることを明示する。

// ─── 初回セッション専用：出会い直しの固定シナリオ（5往復・計10通）─────────
// このチャンネルで一度もセッションが行われていない最初の回だけ使う。
// 流れ：①挨拶（呼び名の行き違い）→②名前の確認／使い分けの説明→③近況（死してなお
// 生きている件）→④この現実世界に気づいた経緯→⑤共同研究＝定期報告の関係に合意。
// 2回目以降は通常のセッション（挨拶→現実世界の定期報告→話題）に切り替わる。
const FIRST_MEETING_ROUNDS = 5;

// ドットーレの返答（1〜5回目、transcript長 1,3,5,7,9 に対応）
const FIRST_MEETING_DOTTORE_REPLY_HINTS = [
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}が訪ねてきた場面に応じてください。書類仕事など何か別のことをしていた体で顔を上げるといった動作から入り、普段のビジネス上の呼び名（例：「富者」または「富者殿」）で${counterpart}を呼びながら応じ、最近の様子を尋ねる一言を添えてよい。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`,
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}の発言（自分の名前を忘れたのかという確認）に応じてください。まずは鼻を鳴らす・一蹴するなどして「覚えているに決まっている」という態度をぶっきらぼうに示してから、他の被検体にもこの場が観測されうることを踏まえてあえて『${counterpart}』と呼ぶことにする、という理屈を続けてください。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`,
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}の発言（「あれから、いかがでしょうか」のような畏まった聞き方での近況の問い）に応じてください。まずその丁寧すぎる聞き方そのものに軽く茶化す・突っ込む反応を挟んでから、結論として率直に、死してなお生きているという自身の状況に触れてください。「皮肉」という単語は使わず、態度（にやりと笑う等）で皮肉さを表現し、最後は${counterpart}へ短く問い返す形で締めくくってください。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`,
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}の発言（この現実世界に気づいた経緯の話）に応じてください。この現実世界についてはまだよく分かっていないと認めつつ、話題を転じる形で${counterpart}へ、この現実世界を共に研究してみないかと提案してください。共同研究は好みではないが、互いの利害は一致しているはずだ、という理屈で。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`,
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}の発言（共同研究の提案への同意）に応じてください。そっけなくも前向きに、短く一言だけで締めくくってください。${counterpart}が直前に使った言い回し（「定期的に顔を合わせ、互いの観測を報告し合う」等）をそのまま繰り返さず、皮肉や軽口を交えてもよい。1〜2文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`,
];

// パンタローネの発言（2〜5回目の切り出し、transcript長 2,4,6,8 に対応。1回目＝挨拶は別関数）
const FIRST_MEETING_PANTALONE_OPEN_HINTS = [
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}の発言を受けて応じてください。眼鏡を上げるなどの仕草を交えつつ、${counterpart}が普段のビジネス上の呼び名（例：「富者」）であなたを呼んだことに触れ、自分の名前を忘れたのではないかと確かめるような反応を返してください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`,
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}の発言を軽く受け流しつつ、最近の互いの状況について尋ねてください（例：「あれから、いかがでしょうか」のような、やや畏まった言い回し）。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`,
  (scene, counterpart) => `${scene}\n\n直前の${counterpart}からの問いかけに答える形で応じてください。あれから色々あったと軽く触れつつ、自分自身も気づけばこの場所にいたことを話題にし、それを『現実世界』と呼ぶべきなのか${counterpart}に確かめるような言い方をしてください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`,
  (scene, counterpart) => `${scene}\n\n直前で${counterpart}から、この現実世界を共に研究しないかという提案を受けた体で、それに同意してください。商売人らしい軽口（新たな商機・市場開拓といった言い回しなど）を交えながら、簡潔に前向きな返事をしてください。「定期的に顔を合わせ、互いの観測を報告し合う」といった提案の文言そのものは繰り返さないこと。1〜2文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`,
];

function buildInterBotGreetingHint(hour) {
  const scene = interBotSceneHint();
  const counterpart = interBotCounterpartName();
  if (interBotState?.isFirstSession()) {
    return IS_PANTALONE
      ? `${scene}\n\n初めて${counterpart}のもとを訪れる場面です。ノックをするなどして、${counterpart}がいるかどうか尋ねる、探るような第一声をどうぞ。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`
      : `${scene}\n\n${counterpart}が初めてここを訪ねてきた場面から始まる。この対話の一言目となる挨拶を送れ。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`;
  }
  if (isRelaxSession()) {
    return IS_PANTALONE
      ? `${scene}\n\n薄暗い部屋の${counterpart}のもとを訪れた場面から始めてください。今夜は手土産を持参しています（甘い菓子、つまめる軽食、上等な酒など――具体的な品は想像で構いません）。それを卓や傍らに置く、あるいは差し出す動作をさりげなく交えつつ、短く声をかけてください。大げさな挨拶や用件の説明にはせず、ふらりと立ち寄ったような調子で。1〜2文程度。動作描写を交えて、セリフ本文を出力してください。`
      : `${scene}\n\n${counterpart}が薄暗い部屋を訪ねてきた場面から始まる。この対話の一言目を、短く、気負わず送れ。1〜2文程度。動作描写を交えて、セリフ本文を出力すること。`;
  }
  return IS_PANTALONE
    ? `${scene}\n\n今は${hour}時（JST）。${counterpart}のもとを訪れた場面から始めてください。時間帯に合った自然な調子で構いませんが、「何時に伺った」のように時刻そのものを言葉にする必要はありません。この対話の一言目となる挨拶をどうぞ。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`
    : `${scene}\n\n今は${hour}時（JST）。${counterpart}が訪ねてきた場面から始まる。時間帯に合った自然な調子で構わないが、時刻そのものを言葉にする必要はない。この対話の一言目となる挨拶を送れ。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`;
}

function buildInterBotReplyHint() {
  const scene = interBotSceneHint();
  const counterpart = interBotCounterpartName();
  if (interBotState?.isFirstSession()) {
    const replyIndex = (interBotState.getTranscript().length + 1) / 2 - 1; // 0-based
    const builder = FIRST_MEETING_DOTTORE_REPLY_HINTS[replyIndex];
    if (builder) return builder(scene, counterpart);
    // 想定外の位置なら通常の応答にフォールバック
  }
  if (isRelaxSession()) {
    if (interBotState?.willBeFinalSend()) {
      return `${scene}\n\n夜も更けてきた頃合いだ。直前の${counterpart}の発言や仕草を静かに受けて、そろそろ切り上げる短い一言を送れ（起承転結の「結」）。ぶっきらぼうでよいが拒絶ではなく、「今日はここまで」という区切り。また次も、と匂わせる程度で、大げさな別れの挨拶にはしないこと。1文程度＋動作描写で、セリフ本文を出力すること。`;
    }
    const tlen = interBotState?.getTranscript().length ?? 0;
    const firstReply = tlen <= 1;
    const foodBit = firstReply
      ? `${counterpart}が持参した手土産に軽く触れつつ（礼か、皮肉か、無言で手を伸ばすか、いずれでも）、`
      : ``;
    const beat = firstReply ? "" : `\n今回の入り方の目安：${RELAX_BEATS[tlen % RELAX_BEATS.length]}。`;
    return `${scene}\n\n${foodBit}直前の${counterpart}の短い発言や仕草に、ぽつりと応じよ。話を広げず、相槌・ごく短い感想・沈黙に近い一言、あるいはセリフを言わず仕草だけ、のいずれかで。これまで使っていない種類の動作描写を必ず1つ以上入れること。多くて1文。${beat}\nセリフ本文を出力すること。`;
  }
  // 起承転結の「結」：このBotにとって今セッション最後の送信になる番は、
  // 新しい話題を広げず、対話を締めくくる一言として応じる。
  if (interBotState?.willBeFinalSend()) {
    return IS_PANTALONE
      ? `${scene}\n\n直前の${counterpart}の発言（対話を締めくくろうとする一言）を受けて、自然に応じてください（起承転結の「結」）。新しい話題を広げたり問いを重ねたりせず、今日の対話に短く区切りをつけてください。1〜2文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`
      : `${scene}\n\n直前の${counterpart}の発言（対話を締めくくろうとする一言）を受けて、自然に応じよ（起承転結の「結」）。新しい話題を広げたり問いを重ねたりせず、今日の対話に短く区切りをつけること。1〜2文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`;
  }
  return IS_PANTALONE
    ? `${scene}\n\n直前の${counterpart}の発言に、自然に応答してください。堅苦しい確認・分析の言い回し（「〜する必要がありそうです」「〜を判断し切れないため」など）に頼らず、雑談として気の利いた合いの手や茶化し、率直な感想を返してください。素っ気なく返す場合でも、それだけで終わらせず、自分なりの一言を添えてください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`
    : `${scene}\n\n直前の${counterpart}の発言に対して自然に応答せよ。素っ気なく皮肉げな態度は保ってよいが、堅苦しい分析用語（「見極める必要がある」「作用しているか」など）を連発する報告口調にはせず、雑談として気の利いた一言・皮肉・軽口で返すこと。ただ拒絶したり話をはぐらかしたりするだけで終わらせず、自分なりの感想を一言添えること。1〜3文程度。普段の会話と同じ形式（括弧書きの動作描写を交えて構わない）で、セリフ本文を出力すること。`;
}

// 「今日食べたもの」の世間話。被検体の話と並ぶ、二人自身についての話題として
// 承（2往復目）・転（話題転換）のどちらからも呼べる共有ヘルパー。
function buildFoodTopicHint(scene, counterpart, phaseLabel = "") {
  return `${scene}\n\n直前の${counterpart}の発言を受けつつ、新しい話題として${phaseLabel}、今日食べたもの（朝食・昼食・夕食など）について世間話として気軽に一言持ちかけてください。自分が今日何を食べたか・まだ食べていないかに軽く触れる、あるいは相手に尋ねる、どちらの形でも構いません。具体的な料理内容は自由に想像して構いません。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文のみ出力してください。`;
}

// パンタローネ専用（initiator側のみが呼ぶため常に敬語で書く）：
// 2往復目に必ず1回だけ使う話題（起承転結の「承」の導入）。被検体についての世間話が基本だが、
// 3割程度の確率で「今日食べたもの」の話に振れる。
// 23時のくつろぎセッションでinitiator（パンタローネ）が中盤に送る一言。
// 議題を持たず、ぽつぽつとした短い発話＋動作描写で「一緒にいるだけ」の空気を保つ。
function buildRelaxInitiatorTurnHint() {
  const scene = interBotSceneHint();
  const cp = interBotCounterpartName();
  if (interBotState.willBeFinalSend()) {
    return `${scene}\n\n夜も更けてきた頃合いです。直前の${cp}の発言や仕草を静かに受けて、今夜はそろそろ、という短い一言で区切りをつけてください（起承転結の「結」）。特に何を話したわけでもないまま、また次も、と匂わせる程度で。大げさな別れの挨拶にはしないこと。1文程度＋動作描写で、セリフ本文を出力してください。`;
  }
  const beat = RELAX_BEATS[(interBotState.getTranscript().length) % RELAX_BEATS.length];
  return `${scene}\n\n直前の${cp}の短い発言や仕草に、ぽつりと応じてください。用件も議題もありません。多くて1文で、これまで使っていない種類の動作描写を必ず1つ以上入れること。\n今回の入り方の目安：${beat}。\nセリフ本文を出力してください。`;
}

function buildInterBotSubjectReportHint() {
  if (isRelaxSession()) return buildRelaxInitiatorTurnHint();
  const scene = interBotSceneHint();
  const counterpart = interBotCounterpartName();
  if (Math.random() < 0.3) {
    return buildFoodTopicHint(scene, counterpart);
  }
  const picked = pickRecentInterlocutorMemory();
  if (picked) {
    return `${scene}\n\n直前の${counterpart}の発言を受けつつ、新しい話題として、最近パンタローネ自身が対話した被検体「${picked.displayName}」について、以下の実際の記録に基づいた内容を、堅苦しい報告調ではなく面白がって話すゴシップ話として一つ切り出してください：\n` +
      `「${picked.memoryText}」\n` +
      `この記録に書かれている範囲でのみ話し、記録にない詳細は創作しないでください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`;
  }
  return `${scene}\n\n直前の${counterpart}の発言を受けつつ、新しい話題として、最近接している被検体たち全般について気づいたこと（会話の頻度、反応パターン、興味を示す話題の傾向など）を、具体的な個人名は出さずに、世間話として気楽に一つ切り出してください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`;
}

// パンタローネ専用：3往復目以降に使う話題。全体を起承転結で運ぶよう設計している
// （起＝挨拶、承＝世間話の導入、転＝話題転換、結＝締めの一言）。
// 以前は毎回「新しい話題として」持ちかける指示になっており、往復のたびに無関係な話題へ
// 飛躍してしまう不具合があった（実測で確認）。会話が不自然に忙しくなるため、話題の切り替えは
// セッション中1回・かつ会話が最後から2番目の番に達してから（isSecondToLastSend）のみ許可し、
// それ以外は直前までの話題をそのまま掘り下げる指示にする。MAX_ROUNDSの変更にも自動追従する。
function buildInterBotFollowUpHint() {
  if (isRelaxSession()) return buildRelaxInitiatorTurnHint();
  const scene = interBotSceneHint();
  const counterpart = interBotCounterpartName();
  const canSwitchTopic = interBotState.isSecondToLastSend() && !interBotState.hasSwitchedTopic();

  // 起承転結の「結」：このセッションで送れる最後の番。新しい話題や問いを重ねず、対話を締めくくる。
  if (interBotState.willBeFinalSend()) {
    return `${scene}\n\n直前の${counterpart}の発言を受けつつ、今日のところはこの対話を締めくくってください（起承転結の「結」）。新しい話題を広げたり新たな問いを重ねたりはせず、これまで話していた内容に一言だけ触れて区切りをつけ、雑談を切り上げる一言を添えてください。次の機会（また顔を合わせること）をさりげなく示唆する一言があってもよいですが、大げさな別れの挨拶にはしないこと。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`;
  }

  if (!canSwitchTopic) {
    return `${scene}\n\n直前の${counterpart}の発言を受けて、今話している話題をそのまま掘り下げる形で応答してください（起承転結の「承」）。新しい話題へ飛躍しないこと。堅苦しい分析・確認の言い回しに頼らず、雑談として面白がって突っ込む・茶化す形で一つ深掘りするように。${counterpart}が話をそらそうとしたり、話を元に戻そうとしたりした場合は、それに素直に合わせてください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`;
  }

  interBotState.markTopicSwitched();
  if (Math.random() < 0.3) {
    return buildFoodTopicHint(scene, counterpart, "（起承転結の「転」）");
  }
  const picked = pickRecentInterlocutorMemory();
  if (picked) {
    return `${scene}\n\n直前の${counterpart}の発言に軽く区切りをつけつつ、新しい話題として（起承転結の「転」）、最近パンタローネ自身が対話した被検体「${picked.displayName}」について、以下の実際の記録に基づいた内容を、面白がって話すゴシップ話として一言持ちかけてください：\n` +
      `「${picked.memoryText}」\n` +
      `この記録に書かれている範囲でのみ話し、記録にない詳細は創作しないでください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`;
  }
  return `${scene}\n\n直前の${counterpart}の発言に軽く区切りをつけつつ、新しい話題として（起承転結の「転」）、最近接している被検体たち全般の傾向について、具体的な個人名は出さずに、世間話として一言触れてください。1〜3文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文を出力してください。`;
}

// xAI側の一時障害（503・高負荷・空応答など）でgenerateWithSystemPromptが最終的に失敗した場合、
// このまま黙って諦めると次の定時（12時/18時）まで一切返信されず「しかと」状態になってしまう。
// そのため1回だけ、一定時間後に自動リトライする。
const INTERBOT_RETRY_DELAY_MS = 3 * 60 * 1000; // 3分後
const INTERBOT_MAX_RETRIES = 1;

async function sendInterBotMessage(taskHint, retryCount = 0) {
  if (!interBotState) return;
  // 二重送信防止：自動リトライ（3分後）と手動!tuduketeが競合すると、片方が先に送信済みなのに
  // もう片方がそれを知らないまま実行され、同じ発言者が連続で喋る／上限超過が起こりうる。
  // 実行直前に最新の状態を見て、まだ本当に自分の番かを確認する（呼び出し元のチェックはこの間に古くなりうるため）。
  if (!interBotState.canSend()) {
    console.warn("[InterBot] 送信上限到達のため中止（二重送信防止・リトライ/手動再開の競合の可能性）");
    return;
  }
  const currentTranscript = interBotState.getTranscript();
  if (currentTranscript.length > 0 && currentTranscript[currentTranscript.length - 1].speaker === CHARACTER_NAME) {
    console.warn("[InterBot] 既に自分の発言が記録済みのため中止（二重送信防止・リトライ/手動再開の競合の可能性）");
    return;
  }
  try {
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const systemContent = `${config.ai.systemPrompt}\n\n現在の日時：${now}\n\n${statusManager.getHint()}\n\n${taskHint}`;
    const transcript = interBotState.getTranscript();
    const messages = transcript.length > 0
      ? transcript.map(t => ({ role: t.speaker === CHARACTER_NAME ? "assistant" : "user", content: t.text }))
      : [{ role: "user", content: "（このセッションを開始せよ）" }];

    const text = await aiHandler.generateWithSystemPrompt(systemContent, messages, 250);
    if (!text) return;
    // !kaiwaデバッグセッション中は、本番のリビングチャンネルを汚さないようデバッグチャンネル内で完結させる。
    const destChannelId = interBotState.isDebugMode() ? debugChannelId : interBotChannelId;
    const ch = await client.channels.fetch(destChannelId);
    if (ch && ch.isTextBased()) {
      await ch.send(text);
      interBotState.recordSent(CHARACTER_NAME, text);
      console.log(`[InterBot] 送信 [${CHARACTER_NAME}]: ${text.slice(0, 60)}`);
    }
  } catch (err) {
    console.error("[InterBot] 送信エラー:", err.message);
    if (retryCount < INTERBOT_MAX_RETRIES) {
      console.warn(`[InterBot] ${INTERBOT_RETRY_DELAY_MS / 1000}秒後に自動リトライします（${retryCount + 1}/${INTERBOT_MAX_RETRIES}）`);
      setTimeout(() => {
        sendInterBotMessage(taskHint, retryCount + 1)
          .catch(e => console.error("[InterBot] リトライ送信エラー:", e.message));
      }, INTERBOT_RETRY_DELAY_MS);
    } else {
      console.error("[InterBot] リトライも失敗。このセッションでの返信を諦めます。");
    }
  }
}

// 現在のtranscriptの状態に応じて、自分の役割・往復数から次に送るべき発言を判定して送信する。
// handleInterBotMessage（相手からの受信直後）と!tuduketeデバッグコマンド（手動再開）の両方から使う。
function continueInterBotSession() {
  if (!interBotState.canSend()) return Promise.resolve();

  if (interBotRole === "responder") {
    return sendInterBotMessage(buildInterBotReplyHint());
  }
  if (interBotRole === "initiator") {
    const transcript = interBotState.getTranscript();
    if (interBotState.isFirstSession()) {
      // 初回セッションは固定5往復の出会い直しシナリオのみ。それを終えたら続けない。
      const openIndex = transcript.length / 2 - 1; // 0-based（transcript長 2,4,6,8 に対応）
      const builder = FIRST_MEETING_PANTALONE_OPEN_HINTS[openIndex];
      if (!builder) return Promise.resolve();
      return sendInterBotMessage(builder(interBotSceneHint(), interBotCounterpartName()));
    }
    const hint = transcript.length === 2 ? buildInterBotSubjectReportHint() : buildInterBotFollowUpHint();
    return sendInterBotMessage(hint);
  }
  return Promise.resolve();
}

async function handleInterBotMessage(message) {
  if (!interBotState) return;
  const content = message.content.trim();
  if (!content) return;

  // responder側は自分でセッションを開始しないため、新セッションと判定される場合の
  // モードは現在時刻から推定して渡す（23時台＝くつろぎ）。
  interBotState.ensureFreshSession(currentInterBotMode());
  interBotState.recordReceived(interBotCounterpartName(), content);

  await continueInterBotSession();
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

    if (statusManager.tickHours.includes(hour)) {
      statusManager.tick(hour);
      console.log(`[Scheduler] ステータス更新 (${hour}時 JST): ${statusManager.state.activity}`);
    }

    // ── Bot同士の対話セッション開始（initiator側のみ・12時/18時＝報告、23時＝くつろぎ）──
    if (interBotState && interBotRole === "initiator" && (hour === 12 || hour === 18 || hour === 23)) {
      const mode = hour === 23 ? "relax" : "report";
      interBotState.startSession(mode);
      console.log(`[InterBot] セッション開始 (${hour}時 JST・${mode})`);
      sendInterBotMessage(buildInterBotGreetingHint(hour))
        .catch(err => console.error("[InterBot] 挨拶送信エラー:", err.message));
    }

    // ── AI生成の朝メッセージ（config.discord.aiJihouChannelId が設定された時間に送信）──
    const aiJihouEntries = config.discord.aiJihouSchedule ?? {};
    const aiJihouChannelId = aiJihouEntries[String(hour)] ?? "";
    if (aiJihouChannelId) {
      try {
        const topicsHint = getRecentTopicsHint();
        const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
        const prompt =
          `今日は${dateStr}の朝${hour}時だ。${CHARACTER_NAME}（冷静・傲慢・知的な研究者）として、被検体たちへの朝の挨拶メッセージを1つ生成せよ。\n\n` +
          `制約：\n` +
          `・必ず「おはよう、被検体。」で始めること\n` +
          `・2〜3文、100〜150文字程度\n` +
          `・語尾の例：「〜を期待している。」「…まあ、お前たちには関係のない話だがな。」「〜だ。」など、状況に合わせて自然に締めること\n` +
          `・「いかがお過ごしだろうか」は使わないこと\n` +
          `・傲慢・冷静・研究者視点。感情的な表現禁止。地の文不要\n` +
          `・余分な説明や前置き不要。メッセージ本文のみ出力\n` +
          (topicsHint ? `\n【最近のチャンネルの動向（参考）】\n${topicsHint}` : "");

        console.log(`[Scheduler] AI朝メッセージ生成中 (${dateStr} ${hour}時)`);
        const aiText = await aiHandler.generateSimple(prompt, 200);
        if (aiText) {
          const ch = await client.channels.fetch(aiJihouChannelId);
          if (ch && ch.isTextBased()) {
            await ch.send(aiText);
            console.log("[Scheduler] AI朝メッセージ送信完了");
          }
        }
      } catch (err) {
        console.error("[Scheduler] AI朝メッセージエラー:", err.message);
      }
    }

    // ── 月次記念日メッセージ（初観測日から○ヶ月の節目、13時にチェック）──
    if (hour === 13 && config.features?.anniversary !== false) {
      checkAnniversaries().catch(err => console.error("[Scheduler] 記念日チェックエラー:", err.message));
    }

    if (config.features?.jihou === false) return;
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

// ─── 月次記念日メッセージ（初観測日からの月数の節目に、そっと触れる）───────
async function checkAnniversaries() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const todayDate = now.getDate();

  for (const [userId, p] of Object.entries(profileManager.profiles)) {
    const firstSeenStr = p.botRecord?.firstSeen;
    if (!firstSeenStr) continue;
    const first = new Date(firstSeenStr);
    if (isNaN(first.getTime())) continue;
    if (first.getDate() !== todayDate) continue; // 「初観測日」と同じ日付の日のみ

    const monthsSince = (now.getFullYear() - first.getFullYear()) * 12 + (now.getMonth() - first.getMonth());
    if (monthsSince < 1) continue; // 初日そのものは除外

    await sendAnniversaryMessage(userId, monthsSince).catch(err =>
      console.error(`[Bot] 記念日メッセージエラー [${userId}]:`, err.message)
    );
  }
}

async function sendAnniversaryMessage(userId, months) {
  const prompt =
    `今日は被検体の初観測から${months}ヶ月の節目にあたる日だ。` +
    `${CHARACTER_NAME}（冷静・傲慢・知的な研究者。記念日そのものには興味がないと公言している）として、` +
    `記念日には興味がないという態度は崩さないまま、なぜかその日付だけはさりげなく覚えていた、というニュアンスで一言触れよ。` +
    `1〜2文、80文字程度。前置き不要、セリフ本文のみ出力。`;

  const text = await aiHandler.generateSimple(prompt, 120);
  const targetCh = zatsuChannelId || [...targetChannelIds][0];
  if (!text || !targetCh) return;
  const ch = await client.channels.fetch(targetCh).catch(() => null);
  if (ch && ch.isTextBased()) {
    await ch.send(`<@${userId}> ${text}`);
    console.log(`[Bot] 記念日メッセージ送信 [${userId}]: ${months}ヶ月`);
  }
}

// ─── 特定時刻の独り言（テキスト）─────────────────────────────────────────
function startTimedMutter() {
  if (config.features?.timedMutter === false) return;
  const TIMED_MUTTER_MAP = { 12: "timed_mutter_noon", 18: "timed_mutter_evening", 22: "timed_mutter_night" };
  let lastMutterHour = -1;

  setInterval(() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (minute !== 0 || lastMutterHour === hour) return;
    const listName = TIMED_MUTTER_MAP[hour];
    if (!listName) return;
    lastMutterHour = hour;
    if (Math.random() > 0.40) return;
    const text = pick(listName);
    if (text) {
      notifyText(text);
      console.log(`[Scheduler] 時刻独り言送信 hour=${hour}`);
    }
  }, 60 * 1000);
}

// ─── テキストチャンネルの自発発言（試験的機能・明示的にfeatures.textMutter=trueの時のみ）───
function startTextMutter() {
  if (BOT_MODE === "vc") return;
  if (config.features?.textMutter !== true) return;
  console.log("[Bot] テキストmutter機能起動（試験的）");

  setInterval(async () => {
    if (Math.random() > 0.10) return; // 発動確率を抑える（45分間隔 × 10%）
    const topicsHint = getRecentTopicsHint();
    if (!topicsHint) return;

    const prompt =
      `${topicsHint}\n\n` +
      `${CHARACTER_NAME}（冷静・傲慢・知的な研究者）として、上記の最近の会話の流れに割り込むように自発的に一言コメントせよ。` +
      `誰かへの返信ではなく、ふと思ったことを口にする独り言に近い形で構わない。1〜2文、80文字程度。` +
      (IS_PANTALONE ? `` : `パンタローネに言及する場合は「お前」または「あいつ」と呼び、「富者」「富者様」等の敬称・愛称は使わないこと。`) +
      `行動描写（括弧書き）を使ってもよい。前置き・説明不要、セリフ本文のみ出力。`;

    try {
      const text = stripPantaloneEpithet(await aiHandler.generateSimple(prompt, 120));
      const targetCh = zatsuChannelId || [...targetChannelIds][0];
      if (!text || !targetCh) return;
      const ch = await client.channels.fetch(targetCh).catch(() => null);
      if (ch && ch.isTextBased()) {
        await ch.send(text);
        console.log(`[Bot] テキストmutter発動: ${text.slice(0, 60)}`);
      }
    } catch (err) {
      console.error("[Bot] テキストmutterエラー:", err.message);
    }
  }, 45 * 60 * 1000);
}

// ─── フォローアップ（記憶に基づく自発言及・試験的機能）────────────────────
// 直近で活動があり、記憶データを持つ被検体を対象に、ごく稀に自発的に言及する
let lastFollowUpTime = 0;
const followUpCooldowns = new Map(); // userId → 最終フォローアップ時刻

function startFollowUp() {
  if (BOT_MODE === "vc") return;
  if (config.features?.followUp !== true) return;
  console.log("[Bot] フォローアップ機能起動（試験的）");

  setInterval(async () => {
    if (Math.random() > 0.10) return; // 発動確率を抑える（60分間隔 × 10%）
    if (Date.now() - lastFollowUpTime < 4 * 60 * 60 * 1000) return; // 全体クールダウン：4時間

    const now = Date.now();
    const eligible = Object.entries(profileManager.profiles).filter(([userId, p]) => {
      const memories = memoryManager.getMemories(userId);
      if (memories.length === 0) return false;
      const lastSeen = p.botRecord?.lastSeen;
      if (!lastSeen) return false;
      const daysSinceSeen = (now - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceSeen > 3) return false; // 直近3日以内に活動があった相手のみ
      const lastFollowUp = followUpCooldowns.get(userId) ?? 0;
      return now - lastFollowUp > 3 * 24 * 60 * 60 * 1000; // 同一人物への再言及は3日以上空ける
    });
    if (eligible.length === 0) return;

    const [userId] = eligible[Math.floor(Math.random() * eligible.length)];
    const memories = memoryManager.getMemories(userId);
    const memoryText = memories[Math.floor(Math.random() * memories.length)].text;

    const prompt =
      `以下は被検体について${CHARACTER_NAME}が記録していた記憶データの一つだ。「${memoryText}」\n\n` +
      `${CHARACTER_NAME}（冷静・傲慢・知的な研究者）として、ふと思い出したかのようにこの件へ触れ、被検体へ向けて一言言及せよ。` +
      `催促や心配ではなく、観察・経過確認のニュアンスで。1〜2文、80文字程度。感情語は使わないこと。` +
      `前置き・説明不要、セリフ本文のみ出力。`;

    try {
      const text = await aiHandler.generateSimple(prompt, 120);
      const targetCh = zatsuChannelId || [...targetChannelIds][0];
      if (!text || !targetCh) return;
      const ch = await client.channels.fetch(targetCh).catch(() => null);
      if (ch && ch.isTextBased()) {
        await ch.send(`<@${userId}> ${text}`);
        lastFollowUpTime = now;
        followUpCooldowns.set(userId, now);
        // 実際に発した内容を記録しておく（記憶しておかないと後の会話で内部処理と食い違う）
        memoryManager.addProactiveStatement(userId, text);
        console.log(`[Bot] フォローアップ発動 [${userId}]: ${text.slice(0, 60)}`);
      }
    } catch (err) {
      console.error("[Bot] フォローアップエラー:", err.message);
    }
  }, 60 * 60 * 1000);
}

// ─── 応用mutter：もう一方のBotの担当チャンネルへの割り込み＋ツッコミ返し（試験的機能）────
// textMutterと同じ「自発的な一言コメント」の仕組みを、特定チャンネルの直近のやり取りに
// 絞って流用している。ドットーレ側：パンタローネが被検体に返信した直後（＝そのbotメッセージを
// 検知した時）に低確率・クールダウン付きで発火し、会話に割り込む一言を発する。
// パンタローネ側：ドットーレの割り込みを検知したら、確率判定なしで必ずツッコミを一言返す
// （割り込み自体が低確率のクールダウン付きなので、ツッコミ側まで確率で絞る必要はない）。
async function handleCrossMutter(message) {
  if (!crossMutterChannelId) return;

  if (IS_PANTALONE) {
    const dottoreLine = message.content.trim();
    if (!dottoreLine) return;
    const prompt =
      `直前にドットーレが、被検体との会話に不意に割り込んでこう言った：${dottoreLine}\n\n` +
      `パンタローネ（穏やかで丁寧、皮肉屋）として、この割り込みに軽くツッコミを入れてください。` +
      `ドットーレへ呼びかけつつ、今は被検体と話している最中だとやんわり窘め、会話を被検体へ戻す形で。` +
      `1〜2文程度でお願いします。普段の会話と同じ形式（括弧書きの動作描写を交えても構いません）で、セリフ本文のみ出力してください。セリフ全体を「」で囲まないこと（括弧書きの動作描写以外は、地の文のまま出力すること）。`;
    try {
      const text = await aiHandler.generateSimple(prompt, 150);
      if (text) {
        await message.channel.send(text);
        lastCrossMutterEvent = { dottoreLine, retort: text, at: Date.now() };
        console.log(`[Bot] 応用mutterツッコミ発動: ${text.slice(0, 60)}`);
      }
    } catch (err) {
      console.error("[Bot] 応用mutterツッコミエラー:", err.message);
    }
    return;
  }

  // ドットーレ側：パンタローネの返信を検知。低確率・クールダウン付きで割り込む。
  if (Date.now() - lastCrossMutterAt < CROSS_MUTTER_COOLDOWN_MS) return;
  if (Math.random() > 0.30) return;

  const topics = (channelTopics.get(message.channelId) ?? []).slice(-3);
  if (topics.length === 0) return;
  const snippet = topics.map(t => `「${withDottoreSelfReference(t.content)}」(${t.username})`).join("、");

  const prompt =
    `以下は、パンタローネが被検体と交わしている会話の断片だ。\n${snippet}\n\n` +
    `ドットーレ（冷静・傲慢・知的な研究者）として、この会話に割り込むように自発的に一言コメントせよ。誰かへの返信ではなく、ふと思ったことを口にする独り言に近い形で構わない。` +
    `以下の3拍子の構成にすること：①話題をふてぶてしく一蹴する第一声（「〜如きに何の意味がある」「くだらん」等）→②「……いや」「もっとも」「だが」のような一言で一転し、実は本気で興味を持っていたことを覗かせる→③最後は必ず、自分自身の研究・観察・記録の話にすり替えて着地する（例：「私の研究テーマの一つでもある」「私の記録にも近い反応がある」）。` +
    `パンタローネに言及する場合は「お前」または「あいつ」と呼ぶこと。「富者」「富者様」等の敬称・愛称は絶対に使わないこと。` +
    `2〜3文、100文字程度。行動描写（括弧書き）を使ってもよい。前置き・説明不要、セリフ本文のみ出力。セリフ全体を「」で囲まないこと（括弧書きの動作描写以外は、地の文のまま出力すること）。`;

  try {
    const text = stripPantaloneEpithet(await aiHandler.generateSimple(prompt, 180));
    if (text) {
      lastCrossMutterAt = Date.now();
      await message.channel.send(text);
      lastCrossMutterEvent = { dottoreLine: text, retort: null, at: Date.now() };
      console.log(`[Bot] 応用mutter発動: ${text.slice(0, 60)}`);
    }
  } catch (err) {
    console.error("[Bot] 応用mutterエラー:", err.message);
  }
}

// ─── 起動バナー ───────────────────────────────────────────────────────────
function printStartupBanner(tag, mood) {
  const R = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const CYAN = "\x1b[36m";
  const BLUE = "\x1b[34m";
  const WHITE = "\x1b[37m";
  const GRAY = "\x1b[90m";
  const YELLOW = "\x1b[33m";
  const RED = "\x1b[31m";

  const moodLabel = mood === "good" ? `${YELLOW}良好${R}` : mood === "bad" ? `${RED}不調${R}` : `${WHITE}普通${R}`;
  const modeLabel = BOT_MODE === "text" ? "text" : BOT_MODE === "vc" ? "vc" : "all";
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });


  const W = 62; // 内側幅（╔～╗の間の文字数）

  // 全角文字を2としてカウント
  function vw(str) {
    let w = 0;
    for (const ch of str.replace(/\x1b\[[0-9;]*m/g, "")) {
      const c = ch.codePointAt(0);
      w += (c >= 0x1100 && (c <= 0x115F || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xFF01 && c <= 0xFF60))) ? 2 : 1;
    }
    return w;
  }

  const blank = `${BLUE}║${R}${" ".repeat(W)}${BLUE}║${R}`;

  function row(label, value) {
    const inner = `  ${label}  ${value}`;
    const pad = Math.max(0, W - vw(inner));
    return `${BLUE}║${R}  ${GRAY}${label}${R}  ${value}${" ".repeat(pad)}${BLUE}║${R}`;
  }

  function centerLine(text, color = "") {
    const len = vw(text);
    const left = Math.floor((W - len) / 2);
    const right = W - len - left;
    return `${BLUE}║${R}${" ".repeat(left)}${color}${text}${R}${" ".repeat(right)}${BLUE}║${R}`;
  }

  // ┌ 15行以内に収める（PM2 last 15 lines 対応） ┐
  console.log("");                                                                          // 1
  console.log(`${BLUE}╔${"═".repeat(W)}╗${R}`);                                           // 2
  console.log(centerLine(`◆  ${CHARACTER_NAME}  ◆`, BOLD + CYAN));                       // 3
  console.log(centerLine("Sistema  di  ricerca  avviato", DIM + WHITE));                  // 4
  console.log(`${BLUE}╠${"═".repeat(W)}╣${R}`);                                           // 5
  console.log(row("BOT TAG  :", `${BOLD}${WHITE}${tag}${R}`));                            // 6
  console.log(row("MODE     :", `${CYAN}${modeLabel}${R}`));                              // 7
  console.log(row("MODEL    :", `${CYAN}${config.grok.model}${R}`));                      // 8
  console.log(row("CHANNELS :", `${WHITE}${targetChannelIds.size} ch${R}`));              // 9
  console.log(row("MOOD     :", moodLabel));                                               // 10
  console.log(row("STARTED  :", `${DIM}${now}${R}`));                                     // 11
  console.log(`${BLUE}╚${"═".repeat(W)}╝${R}`);                                           // 12
  console.log("");                                                                          // 13
}

// ─── Ready ────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  resetDailyMood();
  printStartupBanner(client.user.tag, dailyMood);
  startScheduler();
  startTimedMutter();
  startTextMutter();
  startFollowUp();
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
      if (config.features?.autoAction !== false && targetCh?.isVoiceBased() && Math.random() < 0.5) {
        const waitMs = 2000 + Math.random() * 3000; // 2〜5秒後に自然に参加
        setTimeout(async () => {
          if (vcHandler.isConnected() || isTemporarilyAway) return;
          const freshCh = await newState.guild.channels.fetch(targetCh.id).catch(() => null);
          if (!freshCh) return;
          if (restrictedVCChannelIds.size > 0 && !restrictedVCChannelIds.has(freshCh.id)) return;
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
          scheduleFatigue();
          const now = Date.now();
          freshCh.members.forEach((m) => { if (!m.user.bot) userJoinTimes.set(m.id, now); });
          scheduleLongStayCheck();
          saveVCState(newState.guild.id, freshCh.id);
          vcHandler.playJoinSound().catch(() => {});
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
    aloneTimer = setTimeout(async () => {
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
        clearFatigueTimer();
        clearLongStayTimer();
        isTemporarilyAway = false;
        isFocused = false;
        recentSpeakers.clear();
        userJoinTimes.clear();
        userResponseTrack.clear();
        ignoredUsers.clear();
        sessionLeavers.clear();
        // テキストチャンネルに通知（チャンネル判定のためcurrentVCChannelクリア前に送る）
        notifyText("……観察終了、記録した。退出する。");
        await vcHandler.playLeaveSound().catch(() => {});
        // サウンド再生中に入室した場合は退出キャンセル
        if (ch?.members.filter((m) => !m.user.bot).size !== 0) {
          console.log("[Bot] 退出キャンセル（サウンド再生中に入室）");
          return;
        }
        currentVCChannel = null;
        sessionStartTime = null;
        vcHandler.leave();
        clearVCState();
        console.log("[Bot] 無人のため自動退出しました。");
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
  // パンタローネ⇄ドットーレの直接対話チャンネル：相手Botのメッセージにのみ反応する特殊チャンネル
  // （通常はBot自身のメッセージを一律無視するため、この分岐だけ下のbotフィルターより先に処理する。
  // 人間の発言はここでは処理せず、!say-d/!say-p 等の通常経路にそのまま流す）。
  // !kaiwaデバッグセッション中（interBotState.isDebugMode()）は、リビングチャンネルの代わりに
  // デバッグチャンネル内のBotメッセージをやり取りとして検知する（本番チャンネルを汚さないため）。
  const isInterBotChannel = interBotChannelId && message.channelId === interBotChannelId;
  const isDebugInterBotChannel = debugChannelId && message.channelId === debugChannelId && interBotState?.isDebugMode();
  if ((isInterBotChannel || isDebugInterBotChannel) && message.author.bot) {
    if (message.author.id !== client.user.id) {
      await handleInterBotMessage(message).catch(err => console.error("[InterBot] 処理エラー:", err.message));
    }
    return;
  }

  // 応用mutter専用チャンネル：もう一方のBotのメッセージにのみ反応する（人間の発言は通常経路へ）。
  const isCrossMutterChannel = crossMutterChannelId && message.channelId === crossMutterChannelId;
  if (isCrossMutterChannel && message.author.bot) {
    if (message.author.id !== client.user.id) {
      await handleCrossMutter(message).catch(err => console.error("[Bot] 応用mutter処理エラー:", err.message));
    }
    return;
  }
  if (message.author.bot) return;

  // !say-d / !say-p はどのチャンネルからでも管理者が使用可能。
  // 各Botは自分宛のサフィックスにのみ反応し、宛先が違う場合は無反応（複数Botが同じチャンネルにいても二重送信しない）。
  const sayMatch = message.content.trimStart().match(/^!say-(d|p)\b/);
  if (sayMatch) {
    const targetCharacter = sayMatch[1] === "d" ? "ドットーレ" : "パンタローネ";
    if (CHARACTER_NAME !== targetCharacter) return;
    const isAdmin = message.member?.permissions.has("Administrator") ?? false;
    if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
    const sayText = message.content.trim().slice(sayMatch[0].length).trim();
    if (!sayText) { await message.reply(IS_PANTALONE ? "送信するテキストをご入力ください。" : "送信するテキストを入力しろ。"); return; }
    try { await message.delete(); } catch (_) {}
    await message.channel.send(sayText);
    return;
  }

  const isAllowedDM = !message.guild && dmAllowedUserIds.has(message.author.id);
  const isTarget = isAllowedDM || targetChannelIds.has(message.channelId) || commandOnlyChannelIds.has(message.channelId);
  const isCommandOnly = commandOnlyChannelIds.has(message.channelId);
  const isProfileCh = profileChannelIds.size > 0
    && profileChannelIds.has(message.channelId)
    && !isTarget;
  const isLoreCh = loreChannelIds.size > 0
    && loreChannelIds.has(message.channelId)
    && !isTarget;
  const isArtCh = artChannelIds.size > 0
    && artChannelIds.has(message.channelId)
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
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
      await handleLoreCommand(message);
    }
    return;
  }

  // イラスト投稿チャンネル：画像投稿にのみ短いコメントを返す（雑談扱いはしない）
  if (isArtCh) {
    await handleArtPost(message);
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
  const imageAttachments = [...message.attachments.values()].filter(a => a.contentType?.startsWith("image/"));
  if (!content && imageAttachments.length === 0) return;

  // 久しぶりユーザー検知（onMessage でlastSeenが上書きされる前に取得）
  const prevLastSeen = profileManager.profiles[userId]?.botRecord?.lastSeen ?? null;

  // プロフィール更新（コマンド含む全メッセージでカウント・最終観測更新）
  profileManager.onMessage(userId, userTag);

  // 観測回数マイルストーン到達通知
  const reachedMilestone = profileManager.checkMilestone(userId);
  const milestoneLine = MILESTONE_LINES[CHARACTER_NAME]?.[reachedMilestone];
  if (milestoneLine) {
    message.channel.send(milestoneLine).catch(() => {});
  }

  // パンタローネ・博士の「両方」に同じ日に話しかけた連続日数の判定
  const reachedStreak = dailyStreak.recordContact(userId, STREAK_CHARACTER_KEY);
  if (reachedStreak) {
    const bonus = STREAK_BONUS_BY_MILESTONE[reachedStreak] ?? reachedStreak * 2;
    profileManager.addBonusCount(userId, bonus);
    const streakLine = STREAK_MILESTONE_LINES[CHARACTER_NAME]?.[reachedStreak];
    if (streakLine) {
      message.channel.send(streakLine).catch(() => {});
    }
  }

  const isVCCommand =
    content === "!kanshi" ||
    content.startsWith("!kanshi ") ||
    content === "!hakase" ||
    content.startsWith("!hakase ") ||
    content === "!owari" ||
    content === "!kiite";

  const isProfileCommand = content === "!profile" || content.startsWith("!profile ");
  const isStatusCommand = content === "!status";

  if (BOT_MODE === "text" && isVCCommand) return;
  if (BOT_MODE === "vc" && !isVCCommand && !isProfileCommand && !isStatusCommand) return;

  // ── !kiite ────────────────────────────────────────────────────
  if (content === "!kiite") {
    isKiiteMode = !isKiiteMode;
    if (isKiiteMode) {
      await message.reply("……わかった。全部聴いてやる。");
    } else {
      await message.reply("……もういいだろう。通常に戻す。");
    }
    return;
  }

  // ── !kanshi ───────────────────────────────────────────────────
  if (content === "!kanshi" || content.startsWith("!kanshi ")) {
    if (!message.guild) {
      await message.reply("……VCコマンドはサーバーチャンネルから実行しろ。");
      return;
    }
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
    if (restrictedVCChannelIds.size > 0 && !restrictedVCChannelIds.has(targetVC.id)) {
      await message.reply("なんだそれは");
      return;
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
      scheduleFatigue();
      const now = Date.now();
      targetVC.members.forEach((m) => { if (!m.user.bot) userJoinTimes.set(m.id, now); });
      scheduleLongStayCheck();
      saveVCState(message.guild.id, targetVC.id);
      vcHandler.playJoinSound().catch(() => {});
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
        await message.reply(IS_PANTALONE ? "……まだ記録がございません。まずは何かお話しください。そこから始めましょう。" : "……記録がない。まず何か発言しろ。そうすれば観察を開始する。");
      }
      return;
    }

    // !profile set [フィールド] [値]（呼び名・備考のみ）
    if (args.startsWith("set ")) {
      const rest = args.slice("set ".length).trim();
      const spaceIdx = rest.search(/\s/);
      if (spaceIdx === -1) {
        await message.reply(IS_PANTALONE ? "……値が空のようですね。`!profile set 呼び名 [名前]` の形式でご入力ください。" : "……値が空だ。`!profile set 呼び名 [名前]` の形式で入力しろ。");
        return;
      }
      const field = rest.slice(0, spaceIdx);
      const value = rest.slice(spaceIdx + 1).trim();
      const ALLOWED_FIELDS = ["呼び名", "備考"];
      if (!ALLOWED_FIELDS.includes(field)) {
        await message.reply(IS_PANTALONE ? `……「${field}」は設定いただけません。呼び名・備考のみご指定いただけます。` : `……「${field}」は設定できない。呼び名・備考 のみ指定可能だ。`);
        return;
      }
      const ok = profileManager.setField(userId, field, value, userTag);
      if (IS_PANTALONE) {
        await message.reply(ok ? `……「${field}」を「${value}」として記録いたしました。` : `……記録に失敗いたしました。`);
      } else {
        await message.reply(ok ? `……「${field}」を「${value}」として記録した。` : `……記録に失敗した。`);
      }
      return;
    }

    await message.reply(IS_PANTALONE
      ? "……使い方が異なるようですね。\n`!profile` … 表示\n`!profile set 呼び名 [名前]` … 呼び名を記入\n`!profile set 備考 [内容]` … 備考を記入"
      : "……使い方が間違っている。\n`!profile` … 表示\n`!profile set 呼び名 [名前]` … 呼び名を記入\n`!profile set 備考 [内容]` … 備考を記入");
    return;
  }

  // ── !lore ─────────────────────────────────────────────────────
  if (content === "!lore" || content.startsWith("!lore ")) {
    const isAdmin = message.member?.permissions.has("Administrator") ?? false;
    if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
    await handleLoreCommand(message);
    return;
  }

  // ── !nani ─────────────────────────────────────────────────────
  if (content === "!nani") {
    const topics = zatsuChannelId ? channelTopics.get(zatsuChannelId) : null;
    if (!topics || topics.length === 0) {
      await message.reply(IS_PANTALONE ? "……まだ何も、記録がございません。雑談チャンネルの動きも見当たりませんね。" : "……まだ何も記録していない。雑談チャンネルに動きがない。");
      return;
    }
    const now = Date.now();
    const recent = topics.filter(t => now - t.timestamp < TOPIC_MAX_AGE_MS);
    if (recent.length === 0) {
      await message.reply(IS_PANTALONE ? "……記録はございますが、いずれも古いデータですね。最近の動きは見当たりません。" : "……記録はあるが、すべて古いデータだ。最近の動きはない。");
      return;
    }
    const lines = recent.slice(-10).map(t => {
      const min = Math.round((now - t.timestamp) / 60000);
      const ago = min < 60 ? `${min}分前` : `${Math.round(min / 60)}時間前`;
      return `・${t.username}（${ago}）：「${t.content.slice(0, 80)}」`;
    }).join("\n");
    const prompt =
      `以下は雑談チャンネルで密かに観察・記録した被検体たちの発言ログだ。\n\n${lines}\n\n` +
      `${CHARACTER_NAME}（研究者視点・傲慢・冷静）として、この記録を聞かれたので端的に報告せよ。` +
      `観察者の視点で淡々と。評価・分析を交えてよいが3〜4文以内。地の文不要。`;
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});
    const reply = await aiHandler.generateSimple(prompt, 250);
    await message.reply(reply || (IS_PANTALONE ? "……記録はございます。ですが、今はあまり話す気分ではありませんね。" : "……記録はある。だが、今は話す気分ではない。"));
    return;
  }

  // ── !base ─────────────────────────────────────────────────────
  if (content === "!base") {
    const entry = knowledgeBase.getUserBase(userId);
    if (!entry) {
      if (IS_PANTALONE) {
        await message.reply(`……${config.discord.profileChannelId ? "プロフィールチャンネルにご投稿いただければ、記録いたします。" : "基本情報は、まだ登録されていないようですね。"}`);
      } else {
        await message.reply(`……${config.discord.profileChannelId ? "プロフィールチャンネルに投稿すれば記録する。" : "基本情報が登録されていない。"}`);
      }
    } else if (IS_PANTALONE) {
      await message.reply(`……「${entry.displayName}」様の基本情報でございます。\n（登録: ${entry.updatedAt}）\n\n${entry.postedProfile}`);
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
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
      const ok = memoryManager.clearMemories(userId);
      if (IS_PANTALONE) {
        await message.reply(ok ? "……記憶を消去いたしました。" : "……記録がございません。");
      } else {
        await message.reply(ok ? "……記憶を消去した。" : "……記録がない。");
      }
      return;
    }

    const display = memoryManager.formatForDisplay(userId);
    if (!display) {
      await message.reply(IS_PANTALONE ? "……まだ何も記録されておりません。" : "……まだ何も記録されていない。");
    } else if (IS_PANTALONE) {
      await message.reply(`……あなたに関する記憶でございます。\n\n${display}`);
    } else {
      await message.reply(`……お前に関する記憶。\n\n${display}`);
    }
    return;
  }

  // ── !oboete（明示的な記録・自動抽出とは別枠）───────────────────────
  if (content === "!oboete" || content.startsWith("!oboete ")) {
    const args = content.slice("!oboete".length).trim();

    if (args === "list") {
      const display = memoryManager.formatSavedForDisplay(userId);
      if (IS_PANTALONE) {
        await message.reply(display ? `……明示的に記録した事項でございます。\n\n${display}` : "……まだ何も記録しておりません。");
      } else {
        await message.reply(display ? `……明示的に記録した事項。\n\n${display}` : "……まだ何も記録していない。");
      }
      return;
    }

    if (args === "clear") {
      const ok = memoryManager.clearSavedMemories(userId);
      if (IS_PANTALONE) {
        await message.reply(ok ? "……記録をすべて消去いたしました。" : "……記録がございません。");
      } else {
        await message.reply(ok ? "……記録をすべて消去した。" : "……記録がない。");
      }
      return;
    }

    if (args) {
      // 直接テキストを指定 → そのまま保存
      memoryManager.addSavedMemory(userId, args);
      await message.reply(IS_PANTALONE ? `……記録いたしました。「${args}」` : `……記録した。「${args}」`);
      return;
    }

    // 引数なし：直近の会話を要約して保存
    const history = aiHandler.getHistory(userId);
    if (history.length === 0) {
      await message.reply(IS_PANTALONE ? "……まだ会話がございません。記録するものがございませんね。" : "……まだ会話がない。記録するものがない。");
      return;
    }
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});
    const recentHistory = history.slice(-16);
    const historyText = recentHistory
      .map(h => `${h.role === "user" ? "被検体" : CHARACTER_NAME}: ${h.content}`)
      .join("\n");
    const prompt =
      `以下は被検体との直近の会話履歴だ。\n\n${historyText}\n\n` +
      `この内容から、後で参照する価値のある情報を要約せよ。` +
      `出力形式：2〜4文程度。会話の要点・被検体について明らかになった事実や文脈を簡潔にまとめること。` +
      `前置き・${CHARACTER_NAME}の台詞は不要、要約内容のみ出力。`;
    try {
      const summary = await aiHandler.generateSimple(prompt, 200);
      memoryManager.addSavedMemory(userId, summary);
      await message.reply(IS_PANTALONE ? `……記録いたしました。\n\n${summary}` : `……記録した。\n\n${summary}`);
    } catch (err) {
      console.error("[Bot] !oboete エラー:", err.message);
      await message.reply(IS_PANTALONE ? "……記録に失敗いたしました。" : "……記録に失敗した。");
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
      clearFatigueTimer();
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
      if (vcHandler.isConnected()) {
        await vcHandler.playLeaveSound().catch(() => {});
        vcHandler.leave();
      }
      clearVCState();
      await message.reply("……退出する。観察記録は保存した。");
      return;

    case "!reset":
      aiHandler.clearHistory(userId);
      await message.reply(IS_PANTALONE ? "……承知いたしました。これまでのやり取りは、一度清算といたしましょう。" : "気が変わった。記憶操作の薬だ、飲め。今すぐ");
      return;

    case "!resetall": {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
      aiHandler.clearAllHistory();
      await message.reply(IS_PANTALONE ? "……全員分、清算いたしました。悪しからず。" : "……全員分だ。記憶操作の薬を投与した。逆らうな。");
      return;
    }

    case "!status": {
      const lines = [statusManager.format()];

      // VC対応インスタンス（BOT_MODE=text以外）でのみ、従来の日替わり機嫌・被検体総評も併記する
      if (BOT_MODE !== "text") {
        const moodLabel = dailyMood === "good" ? "良好" : dailyMood === "bad" ? "不調" : "普通";
        const moodNote  = dailyMood === "good" ? "（機嫌がいい）" : dailyMood === "bad" ? "（機嫌が悪い）" : "";
        lines.push(`\n【本日の機嫌（VC用）】${moodLabel}${moodNote}`);

        const profileEntries = Object.values(profileManager.profiles).filter(p => p.userFields?.name);
        if (profileEntries.length > 0) {
          const subjectList = profileEntries.map(p => {
            const parts = [p.userFields.name];
            if (p.userFields.tendency) parts.push(`傾向:${p.userFields.tendency}`);
            if (p.botRecord?.observation) parts.push(`評価:${p.botRecord.observation}`);
            return parts.join("、");
          }).join("\n");
          const prompt =
            `${CHARACTER_NAME}（冷静・傲慢・知的な研究者）として、以下の被検体たちについて全体的な総評を3文以内で述べよ。` +
            `研究者として淡々と、感情を抑えた言葉で。地の文不要。\n\n${subjectList}`;
          const assessment = await aiHandler.generateSimple(prompt, 200).catch(() => null);
          lines.push(`\n【被検体総評】\n${assessment ?? "……データ不足だ。"}`);
        } else {
          lines.push("\n【被検体総評】\n……登録された被検体がいない。");
        }
      }

      await message.reply(lines.join("\n"));
      return;
    }

    case "!reload": {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
      const ok = loadMessages();
      if (ok) {
        const summary = Object.entries(messageLists).map(([k, v]) => `${k}: ${v.length}件`).join("\n");
        const scheduleSummary = Object.entries(scheduleMap).sort((a, b) => a[0] - b[0]).map(([h, l]) => `${h}時 → ${l}`).join(" / ");
        const header = IS_PANTALONE ? "……再読み込みが完了いたしました。" : "……再読み込み完了。";
        await message.reply(`${header}\n\n【リスト】\n${summary}\n\n【スケジュール】\n${scheduleSummary}`);
      } else {
        await message.reply(IS_PANTALONE ? "……読み込みに失敗いたしました。messages.json の構文をご確認ください。" : "……読み込みに失敗した。messages.json の構文を確認しろ。");
      }
      return;
    }

    case "!kaiwa": {
      if (message.channelId !== debugChannelId) return;
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
      if (!interBotState) {
        await message.reply(IS_PANTALONE ? "……この機能は設定されていないようですね。" : "……この機能は設定されていない。");
        return;
      }
      // 出会い直しシナリオ（初回演出）を消費しないよう、everMetは変更せず通常セッションとして強制リセットする。
      // debugMode=true により、以降のやり取りはリビングチャンネルではなくこのデバッグチャンネル内で完結する。
      interBotState.startDebugSession();
      // 確認はテキスト返信ではなくリアクションで行う（messageCreateを発火させ、相手Botに対話の
      // 一言として誤検知されるのを避けるため）。
      await message.react("💬").catch(() => {});
      if (interBotRole === "initiator") {
        const hour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).getHours();
        sendInterBotMessage(buildInterBotGreetingHint(hour))
          .catch(err => console.error("[InterBot] !kaiwa 送信エラー:", err.message));
      }
      return;
    }

    // !kaiwaとは異なり、進行中の「本物の」セッション（isDebugMode()を書き換えない）をそのまま
    // 引き継いで、自分の番であればリビングチャンネルへ発言を再送する。APIの一時障害などで
    // 自動リトライも失敗し、返信が止まってしまった時の手動リカバリー用。
    case "!tudukete": {
      if (message.channelId !== debugChannelId) return;
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }
      if (!interBotState) {
        await message.reply(IS_PANTALONE ? "……この機能は設定されていないようですね。" : "……この機能は設定されていない。");
        return;
      }
      const transcript = interBotState.getTranscript();
      if (transcript.length === 0) {
        await message.reply(IS_PANTALONE ? "……進行中のやり取りが見当たりません。" : "……進行中のやり取りがない。");
        return;
      }
      const lastSpeaker = transcript[transcript.length - 1].speaker;
      if (lastSpeaker === CHARACTER_NAME) {
        await message.reply(IS_PANTALONE ? "……こちらはすでに発言済みで、相手の番です。" : "……こちらは発言済みだ。相手の番だ。");
        return;
      }
      if (!interBotState.canSend()) {
        await message.reply(IS_PANTALONE ? "……このセッションの送信上限に達しています。" : "……このセッションの送信上限に達している。");
        return;
      }
      await message.react("▶️").catch(() => {});
      continueInterBotSession().catch(err => console.error("[InterBot] !tudukete 送信エラー:", err.message));
      return;
    }

    case "!scan_profiles": {
      const isAdmin = message.member?.permissions.has("Administrator") ?? false;
      if (!isAdmin) { await message.reply(ADMIN_REQUIRED_REPLY); return; }

      const profileChId = [...profileChannelIds][0];
      if (!profileChId) {
        await message.reply(IS_PANTALONE ? "……profileChannelId が設定されていないようですね。" : "……profileChannelId が設定されていない。");
        return;
      }
      try {
        const profileCh = await client.channels.fetch(profileChId);

        // limit:100 は1回のfetchにおけるDiscord APIの上限。
        // チャンネルの投稿数がそれを超えると古い投稿がスキャン対象から漏れ、
        // 該当ユーザーの記入欄がいつまでも未記入のままになるため、
        // beforeカーソルで全履歴をページングして取得する。
        const userMessages = [];
        let before;
        for (;;) {
          const page = await profileCh.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          if (page.size === 0) break;
          userMessages.push(...[...page.values()].filter(m => !m.author.bot && isCompleteProfileTemplate(m.content)));
          before = page.last().id;
          if (page.size < 100) break;
        }

        let processed = 0;
        for (const msg of userMessages) {
          // 既に「このBOT自身」が🔬リアクション済みならスキップ。
          // 同じプロフィールチャンネルをドットーレ・パンタローネ双方が監視しているため、
          // 単にリアクションの有無だけで判定すると、他方のBOTが先に処理済みの投稿を
          // 誤ってスキップしてしまう（＝自分側のデータには一度も登録されない）。
          const reaction = msg.reactions.cache.get("🔬");
          let alreadyDone = false;
          if (reaction) {
            const reactedUsers = await reaction.users.fetch();
            alreadyDone = reactedUsers.has(client.user.id);
          }
          if (alreadyDone) continue;
          await handleProfilePost(msg, { silent: true });
          processed++;
          await new Promise(r => setTimeout(r, 800));
        }
        await message.reply(IS_PANTALONE ? `……処理が完了いたしました。${processed}件のデータを登録いたしました。` : `……処理完了。${processed}件の被検体データを登録した。`);
      } catch (err) {
        console.error("[Bot] scan_profiles エラー:", err.message);
        await message.reply(IS_PANTALONE ? "……処理中にエラーが発生いたしました。" : "……処理中にエラーが発生した。");
      }
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
        "!memory                         … 自分の記憶メモを表示（自動抽出分）\n" +
        "!oboete                         … 直近の会話を要約して明示的に記録\n" +
        "!oboete [内容]                  … 指定した内容をそのまま記録\n" +
        "!oboete list                    … 明示的に記録した内容を表示\n" +
        "!oboete clear                   … 明示的に記録した内容を消去\n" +
        "!kanshi [VC名]                  … VCに召喚\n" +
        "!hakase [msg]                   … VCで音声再生\n" +
        "!owari                          … VCから退出\n" +
        "!status                         … 現在の状態（機嫌・やること・空腹度等）を確認\n" +
        "!help                           … このヘルプを表示\n\n" +
        "【管理者のみ】\n" +
        "!resetall                       … 全ユーザーの会話履歴をリセット\n" +
        "!lore / !lore set / !lore delete … 知識管理\n" +
        "!memory clear                   … 記憶メモ消去\n" +
        "!say-d [テキスト]               … ドットーレとして任意チャンネルで発言\n" +
        "!say-p [テキスト]               … パンタローネとして任意チャンネルで発言\n" +
        "!reload                         … messages.json 再読み込み\n" +
        "!sendprofile                    … プロフィールメッセージを今すぐ送信\n" +
        "!scan_profiles                  … プロフィールチャンネルの過去投稿を一括処理\n" +
        "!kaiwa                          … このデバッグチャンネル内でBot同士の対話を通常セッションとして手動開始（初回演出は消費せず、リビングチャンネルにも投稿しない）\n" +
        "!tudukete                       … リビングチャンネルで停止中の進行中セッションを、自分の番であれば手動で再開（送信失敗時のリカバリー用）\n\n" +
        `それ以外のメッセージは${CHARACTER_NAME}が回答します。`
      );
      return;
  }

  if (isCommandOnly) return;

  // ── AI 応答 ───────────────────────────────────────────────────
  console.log(`[Bot] メッセージ受信 [${userTag}]: ${content.slice(0, 80)}`);

  try {
    if (config.ai.typingIndicator) await message.channel.sendTyping().catch(() => {});

    // 画像添付の認識（最初の1枚のみ、Geminiで説明文を生成）
    // 説明文はsystemHintではなく発言内容そのものに埋め込み、会話履歴に永続させる。
    // これにより後続の写真・発言で「さっきの〜」と自然に参照できる（連続写真の文脈継続）。
    let imageDescription = null;
    if (imageAttachments.length > 0) {
      const att = imageAttachments[0];
      if (att.size <= 10 * 1024 * 1024) {
        try {
          const imgRes = await fetch(att.url);
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          imageDescription = await aiHandler.describeImage(buffer, att.contentType);
        } catch (err) {
          console.error(`[Bot] 画像処理エラー [${userTag}]:`, err.message);
        }
      } else {
        console.warn(`[Bot] 画像サイズ超過のためスキップ [${userTag}]: ${att.size}bytes`);
      }
    }
    const effectiveContent = imageDescription
      ? (content ? `${content}\n【添付画像の内容】${imageDescription}` : `【添付画像の内容】${imageDescription}`)
      : content;

    const survival = isSurvivalMessage(content);
    if (survival) { console.log(`[Bot] 生存願望発言検知 [${userTag}]`); profileManager.onSurvival(userId); }

    const profileHint = profileManager.getContextHint(userId);

    const sentimentHint = survival
      ? `この人物は${CHARACTER_NAME}の消滅・死・不在を恐れ、存続を強く望んでいる。今回の返答では、感情的な保証は不要。研究者の論理として「実験が途中だ」「観察対象がいなくなれば観察が終わる、それは認められない」「消える理由が今のところ存在しない」という形で存在の継続を示すこと。「心配するな」「大丈夫だ」は使わない。「まだ観察は終わっていない」「お前が心配するような状況にはない、今のところ」「私が消える前にすることがある」など、論理的・実務的な表現で確かな存在感を示すこと。完全に安心させず、観察対象として繋ぎ止める余白を残すこと。`
      : null;

    const loreHint = knowledgeBase.getLoreContextHint();
    const userBaseHint = knowledgeBase.getUserBaseHint(userId);
    const memoryHint = memoryManager.formatForContext(userId);
    const savedMemoryHint = memoryManager.formatSavedForContext(userId);
    const proactiveHint = memoryManager.formatProactiveForContext(userId);
    const topicsHint = getRecentTopicsHint();
    const crossMutterEventHint = getCrossMutterEventHint(message.channelId);
    const antiRepetitionHint = getAntiRepetitionHint(userId);
    const userSpecificHint = userHints[userId] ?? null;
    const timeHint = getTimeBasedMoodHint();

    // 会話が進むにつれて返答が肥大化する（括弧書きの動作描写を何段も積み重ねる、
    // 軽い発言にも長文で返す）傾向への抑制。履歴に長い自分の返答が並ぶと、
    // それを真似てさらに長くなる正のフィードバックが起きるため、毎回明示する。
    const lengthDisciplineHint =
      `【返答の分量】括弧書きの動作描写は1返答につき1つを基本とし、多くても2つまで。` +
      `「（動作）→短いセリフ→（動作）→短いセリフ」と何度も交互に積み重ねないこと。` +
      `挨拶・軽口・とりとめのない発言・中身の薄い発言には短く返す（セリフ1〜2文、動作描写は0〜1つ）。` +
      `返答を長くしてよいのは、${CHARACTER_NAME}が本当に知的な興味を引かれた時だけ。` +
      `直前までの自分の返答が長くても、それに引きずられて長くしないこと。会話が進んでも1返答あたりの分量は増やさない。`;

    let returningUserHint = null;
    if (config.features?.returningUser !== false && prevLastSeen && !returningUserGreeted.has(userId)) {
      const daysDiff = Math.floor((Date.now() - new Date(prevLastSeen).getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff >= 7) {
        returningUserGreeted.add(userId);
        returningUserHint = `この被検体は前回観測から${daysDiff}日ぶりに現れた。${CHARACTER_NAME}は久しぶりの登場として自然に認識すること。「久しいな」「生きていたか」「消えていたと思っていたが」など一言添えて普通に応答せよ。過度に強調しない。`;
      }
    }

    const contradiction = await checkContradiction(userId, effectiveContent).catch(() => null);
    const contradictionHint = contradiction
      ? `被検体の今回の発言は、過去の記録と矛盾している可能性がある：「${contradiction}」。今回の返答では、この矛盾を研究者らしく鋭く指摘すること。責めるのではなく、興味深い観察対象を見つけたという態度で。`
      : null;
    if (contradiction) {
      message.react("👀").catch(() => {});
    }

    const statusHint = statusManager.getHint();

    const systemHint = [loreHint, profileHint, statusHint, userBaseHint, memoryHint, savedMemoryHint, proactiveHint, userSpecificHint, sentimentHint, contradictionHint, crossMutterEventHint, topicsHint, timeHint, returningUserHint, lengthDisciplineHint, antiRepetitionHint].filter(Boolean).join("\n\n") || undefined;
    const reply = await aiHandler.generateResponse(userId, effectiveContent, { systemHint });
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

    // 観察メモ更新（5会話ごと or 生存イベント時）
    const msgCount = profileManager.profiles[userId]?.botRecord?.messageCount ?? 0;
    if (survival || msgCount % 5 === 0) {
      updateObservation(userId, effectiveContent, reply).catch(() => {});
    }

    // 記憶抽出（3会話ごと）
    if (msgCount % 3 === 0) {
      extractAndStoreMemory(userId, effectiveContent, reply).catch(() => {});
    }

  } catch (error) {
    console.error(`[Bot] エラー [${userTag}]:`, error.message);
    const isTimeout = error.name === "AbortError";
    const replyText = isTimeout ? "…聞こえなかった。もう一度" : config.ai.errorMessage;
    try {
      await message.reply(replyText);
    } catch (_) {
      await message.channel.send(replyText).catch(() => {});
    }
    if (debugChannelId) {
      client.channels.fetch(debugChannelId).then((ch) => {
        if (ch) ch.send(`[エラー] ${userTag}\n\`\`\`\n${error.stack ?? error.message}\n\`\`\``).catch(() => {});
      }).catch(() => {});
    }
  }
});

client.login(config.discord.token).catch((err) => {
  console.error("[Bot] ログインに失敗しました:", err.message);
  process.exit(1);
});