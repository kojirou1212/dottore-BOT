// twitter-bot.js
const fs = require("fs");
const path = require("path");
const AIHandler = require("./ai-handler");
const TwitterHandler = require("./twitter-handler");

const CONFIG_PATH = process.env.CONFIG_PATH || "twitter-config.json";
const configPath = path.join(__dirname, CONFIG_PATH);
if (!fs.existsSync(configPath)) {
  console.error(`[TwitterBot] 設定ファイルが見つかりません: ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// systemPromptFile が指定されていればファイルから読み込む
if (config.ai.systemPromptFile) {
  const promptPath = path.join(__dirname, config.ai.systemPromptFile);
  if (!fs.existsSync(promptPath)) {
    console.error(`[TwitterBot] systemPromptFile が見つかりません: ${promptPath}`);
    process.exit(1);
  }
  config.ai.systemPrompt = fs.readFileSync(promptPath, "utf-8").trim();
  console.log(`[TwitterBot] システムプロンプト読み込み完了: ${config.ai.systemPromptFile}`);
}

if (!config.grok?.apiKey || config.grok.apiKey.startsWith("xai-YOUR_")) {
  console.error("[TwitterBot] grok.apiKey が未設定です。twitter-config.json を確認してください");
  process.exit(1);
}
if (!config.twitter?.appKey || config.twitter.appKey.startsWith("YOUR_")) {
  console.error("[TwitterBot] twitter の認証情報が未設定です。twitter-config.json を確認してください");
  process.exit(1);
}

const aiHandler = new AIHandler(config);
const twitterHandler = new TwitterHandler(config.twitter);

// ─── 状態の永続化（最終投稿時刻・最終メンションID） ──────────────────────
const STATE_PATH = path.join(__dirname, config.mentions?.stateFile || "twitter-state.json");
const DEFAULT_STATE = { lastSentHour: -1, lastSentDate: "", lastMentionId: null };

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const state = loadState();

function jstNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

// ─── 定時つぶやき ───────────────────────────────────────────────
async function postScheduledTweet(hour) {
  const now = jstNow();
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  const maxLen = config.schedule?.maxTweetLength || 280;
  const prompt =
    `${config.ai.systemPrompt}\n\n現在の日時：${dateStr} ${hour}時（JST）\n\n` +
    `【指示】\n` +
    `上記の人格として、X（旧Twitter）に投稿する独り言・観測記録のような短いポストを1件生成しろ。\n` +
    `誰かへの返信ではなく、被検体たちの反応を記録した独白として書くこと。\n\n` +
    `制約：\n` +
    `・${maxLen}文字以内\n` +
    `・前置きや説明は不要。投稿本文のみを出力すること\n` +
    `・ハッシュタグ・絵文字は基本的に使わないこと\n` +
    `・（動作描写）を使ってもよいが、必ず発言（セリフ）を含めること\n` +
    `・直近の投稿と内容や言い回しが重複しないよう変化をつけること`;

  try {
    const text = await aiHandler.generateSimple(prompt, 200);
    if (!text) return;
    await twitterHandler.postTweet(text);
  } catch (err) {
    console.error(`[TwitterBot] 定時投稿エラー (hour=${hour}):`, err.message);
  }
}

function startScheduler() {
  const hours = config.schedule?.hours || [];
  if (hours.length === 0) {
    console.log("[TwitterBot] スケジュール未設定のため定時つぶやきは無効");
    return;
  }
  console.log(`[TwitterBot] 定時つぶやきスケジューラー起動 (hours=${hours.join(",")})`);

  setInterval(async () => {
    const now = jstNow();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dateKey = now.toISOString().slice(0, 10);
    if (minute !== 0) return;
    if (state.lastSentHour === hour && state.lastSentDate === dateKey) return;
    if (!hours.includes(hour)) return;

    state.lastSentHour = hour;
    state.lastSentDate = dateKey;
    saveState();

    console.log(`[TwitterBot] 定時つぶやき生成中 (hour=${hour})`);
    await postScheduledTweet(hour);
  }, 60 * 1000);
}

// ─── メンションへのリプライ ─────────────────────────────────────
function stripMentions(text) {
  return (text || "").replace(/^(@\w+\s*)+/, "").trim();
}

async function pollMentions() {
  try {
    const mentions = await twitterHandler.getMentions(state.lastMentionId);
    if (mentions.length === 0) return;

    const myUserId = await twitterHandler.getUserId();
    const sorted = [...mentions].sort((a, b) => a.id.localeCompare(b.id));

    for (const mention of sorted) {
      state.lastMentionId = mention.id;
      saveState();

      if (mention.author_id === myUserId) continue; // 自分自身の投稿は無視

      const cleanedText = stripMentions(mention.text) || "（名前を呼ばれた）";
      try {
        const reply = await aiHandler.generateResponse(mention.author_id, cleanedText, {
          systemHint: "ここはXでのリプライ返信である。280文字以内で簡潔に応答すること。",
        });
        await twitterHandler.replyTweet(reply, mention.id);
      } catch (err) {
        console.error(`[TwitterBot] リプライ生成エラー (mention=${mention.id}):`, err.message);
      }
    }
  } catch (err) {
    console.error("[TwitterBot] メンション取得エラー:", err.message);
  }
}

function startMentionPolling() {
  if (config.mentions?.enabled === false) {
    console.log("[TwitterBot] リプライ監視は無効化されています");
    return;
  }
  const intervalMs = config.mentions?.pollIntervalMs || 5 * 60 * 1000;
  console.log(`[TwitterBot] メンション監視開始 (${intervalMs / 1000}秒間隔)`);
  setInterval(pollMentions, intervalMs);
  pollMentions(); // 起動直後に1回実行
}

// ─── 起動 ───────────────────────────────────────────────────
console.log("[TwitterBot] 起動");
startScheduler();
startMentionPolling();

process.on("unhandledRejection", (err) => {
  console.error("[TwitterBot] 未処理のPromise拒否:", err);
});
