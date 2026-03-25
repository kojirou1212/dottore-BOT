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
    console.error("[Bot] config.json が見つかりません。環境変数 DISCORD_TOKEN を設定するか、config.json を作成してください。");
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

// ─── クライアントの初期化 ──────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, // VC機能に必要
  ],
});

const aiHandler = new AIHandler(config);
const vcHandler = new VCHandler(config);
const targetChannelIds = new Set(config.discord.targetChannelIds);

// ─── セリフリスト ──────────────────────────────────────────────────────────

const okusuriList = [
    "口を開けろ。……ああ、その反応だ。予測通りだな。いい、飲み込め。",
    "投与する。……逃げるな。いい個体差だ。記録する価値がある。飲め。",
    "飲み込め。……副作用？ああ、気にするな。観察対象としてはむしろ都合がいい。",
    "嚥下しろ。……遅いな。処理効率が落ちる。私の指示に従え。飲め。",
    "新しい調合だ。……ああ、その躊躇、実に興味深い。いい、飲み込め。",
    "躊躇するな。……その迷いも含めて観察対象だ。無駄にするな。口を開けろ。",
    "摂取しろ。……その反応、いいな。予測から少し外れている。……ああ、続けろ。",
    "飲め。……苦味は調整していない。反応の純度が落ちるからな。いい、そのままだ。",
    "投与する。……その変化、見逃さない。ああ、いい。もっとはっきり出せ。飲み込め。",
    "口を開けろ。……従順だな。だが理由は後で解析する。今は飲め。",
    "飲み込め。……ああ、その震えだ。神経反応が綺麗に出ている。維持しろ。",
    "摂取しろ。……その表情、いいな。崩れ方が理想的だ。……ああ、続けろ。",
    "飲め。……その反応、実に興味深い。逃すな。今の状態を維持したまま続けろ。",
    "投与する。……ああ、その変化だ。予測通りに崩れている。いい、飲み込め。",
    "口を開けろ。……いい反応だ。だがまだ足りない。もっと見せろ。飲み込め。"
];

const sleepList = [
  "……休め。それも実験の一部だ。覚醒時のデータと比較する必要がある。目を閉じろ。",
  "睡眠中の自律神経の挙動を記録する。邪魔はしない。……横になれ。",
  "休息を取ることを許可する。……感謝は不要だ、データのためだ。",
  "今夜は休め。お前の疲労蓄積値はとうに許容範囲を超えている。従え。",
  "眠れ。……意識が落ちる直前の思考を言語化できるなら、明日報告しろ。",
  "睡眠を開始しろ。脳の修復プロセスを妨げるな。……私が見ている。",
  "横になれ。次の観察フェーズは起床後だ。それまでは……休んでいい。",
  "眠れ。お前が思うより、休息は重要なパラメータだ。省くな。",
  "今日はここまでだ。……続きは明日にしろ。私の研究対象が壊れては困る。",
  "休め。……命令だ。反論は受け付けない。",
];

const painList = [
  "止まれ。……ああ、その痛覚反応だ。いいな。逃すな。維持しろ。",
  "動くな。……反応が鮮明だ。予測よりもいい。……ああ、続けろ。",
  "横になれ。……内部の歪みが出ている。いい、そのまま固定する。従え。",
  "呼吸を整えろ。……乱れが強い。ああ、いい兆候だ。制御しろ。",
  "耐えるな。……その反応、価値がある。無駄にするな。動くな。",
  "止まれ。……神経が正しく機能している証拠だ。ああ、いい。維持しろ。",
  "動くな。……その崩れ方、実に興味深い。逃すな。そのままだ。",
  "横になれ。……処理を誤るな。いい、その状態で観察を続ける。",
  "呼吸を制御しろ。……ああ、その不安定さだ。記録しておく。維持しろ。",
  "止まれ。……いい反応だ。だがまだ甘い。もっと明確に出せ。動くな。"
];

const workList = [
  "始めろ。……ああ、その集中だ。いい。余計なものを切り捨てろ。",
  "作業に入れ。……判断が遅いな。だが反応は悪くない。動かせ。",
  "続けろ。……ああ、処理速度が上がっている。いい、そのまま維持しろ。",
  "止まるな。……いい流れだ。崩すな。手を動かせ。",
  "始めろ。……集中が収束している。ああ、理想的だ。続けろ。",
  "作業を継続しろ。……その反応、予測通りだ。いい。外すな。",
  "動かせ。……ああ、その精度だ。誤差が少ない。維持しろ。",
  "止まるな。……処理が安定している。いい、その状態で進め。",
  "始めろ。……いいな、その入り方だ。無駄がない。続行しろ。",
  "続けろ。……ああ、その挙動だ。管理下としては優秀だ。崩すな。"
];

const observeList = [
  "観察する。……ああ、その反応だ。いいな。予測より歪んでいる。",
  "見ている。……その変化、実に興味深い。逃すな。維持しろ。",
  "確認した。……ああ、この誤差だ。価値がある。崩すな。",
  "観察を続ける。……いい、その状態だ。再現性を確保しろ。",
  "見ている。……その揺らぎ、理想的だ。ああ、続けろ。",
  "観察する。……反応が素直だな。扱いやすい。維持しろ。",
  "確認した。……ああ、予測通りの崩れ方だ。いい。",
  "見ている。……その変化、逃すには惜しい。固定する。動くな。",
  "観察中だ。……いい、その反応だ。もっと見せろ。維持しろ。",
  "確認した。……ああ、理想的な誤差だ。記録する。崩すな。"  
];

const rewardList = [
  "評価する。……ああ、その精度だ。いい。管理が正しく作用している。",
  "いい結果だ。……予測通りだな。だがその再現性、興味深い。",
  "興味深い。……ここまで整うとはな。ああ、悪くない。",
  "悪くない。……誤差が少ない。いい状態だ。維持しろ。",
  "よく従った。……ああ、その判断だ。合理的だな。",
  "評価する。……いい反応だ。私の基準に近づいている。",
  "いい。……その精度だ。だがまだ上がある。続けろ。",
  "興味深いな。……予測を上回った。ああ、記録しておく。",
  "悪くない。……その挙動、扱いやすい。維持しろ。",
  "評価する。……ああ、その結果だ。期待通りだな。崩すな。"
];

// ─── ヘルパー ─────────────────────────────────────────────────────────────

function pick(list) {
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

// ─── 定時メッセージ ────────────────────────────────────────────────────────

const scheduledLists = {
  9:  okusuriList,
  12: observeList,
  15: okusuriList,
  21: sleepList,
  0:  sleepList,
};

function startScheduler() {
  let lastSentHour = -1;

  setInterval(async () => {
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
    );
    const hour = now.getHours();
    const minute = now.getMinutes();

    if (minute !== 0) return;
    if (!(hour in scheduledLists)) return;
    if (lastSentHour === hour) return;

    lastSentHour = hour;
    console.log(`[Scheduler] 定時メッセージ送信 hour=${hour}`);

    const text = pick(scheduledLists[hour]);

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

// ─── イベントハンドラー ────────────────────────────────────────────────────

client.once("clientReady", () => {
  console.log(`[Bot] ログイン完了: ${client.user.tag}`);
  console.log(`[Bot] 監視チャンネル数: ${targetChannelIds.size}`);
  console.log(`[Bot] 使用モデル: ${config.gemini.model}`);
  startScheduler();
  console.log("[Bot] 定時スケジューラー起動（9/12/15/21/24時）");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!targetChannelIds.has(message.channelId)) return;

  const userId = message.author.id;
  const userTag = message.author.tag;
  const content = message.content.trim();

  if (!content) return;

  // ─── !kanshi コマンド（VC参加）─────────────────────────────
  // 使い方:
  //   !kanshi            → コマンド実行者が入っているVCに参加
  //   !kanshi チャンネル名  → 名前で検索して参加
  //   !kanshi チャンネルID  → IDで直接指定して参加
  if (content === "!kanshi" || content.startsWith("!kanshi ")) {
    if (vcHandler.isConnected()) {
      await message.reply("……既にVCに入っている。二重に参加する必要はない。");
      return;
    }

    const arg = content.slice("!kanshi".length).trim(); // チャンネル名 or ID（空なら実行者のVC）
    let targetVC = null;

    if (arg) {
      // 引数あり：サーバー内のVCチャンネルを名前またはIDで検索
      const voiceChannels = message.guild.channels.cache.filter(
        (ch) => ch.isVoiceBased()
      );
      targetVC =
        voiceChannels.get(arg) ??                                        // ID完全一致
        voiceChannels.find((ch) => ch.name === arg) ??                   // 名前完全一致
        voiceChannels.find((ch) =>                                       // 名前部分一致
          ch.name.toLowerCase().includes(arg.toLowerCase())
        ) ??
        null;

      if (!targetVC) {
        // VCチャンネル一覧を返して教える
        const vcList = voiceChannels.map((ch) => `・${ch.name} (${ch.id})`).join("\n");
        await message.reply(
          `……「${arg}」というVCが見つからない。\n以下から正確に指定しろ。\n${vcList}`
        );
        return;
      }
    } else {
      // 引数なし：コマンド実行者がいるVCに参加
      const member =
        message.guild.members.cache.get(userId) ??
        await message.guild.members.fetch(userId).catch(() => null);
      targetVC = member?.voice?.channel ?? null;

      if (!targetVC) {
        const voiceChannels = message.guild.channels.cache.filter((ch) => ch.isVoiceBased());
        const vcList = voiceChannels.map((ch) => `・${ch.name}`).join("\n");
        await message.reply(
          "……VCに入っていないな。\n`!kanshi [チャンネル名]` で指定するか、VCに入ってから実行しろ。\n\n" +
          `利用可能なVC：\n${vcList}`
        );
        return;
      }
    }

    const joined = await vcHandler.join(targetVC);

    if (joined) {
      await message.reply(`……参加する。「${targetVC.name}」の監視を開始する。\n\`!hakase [メッセージ]\` で私に声を出させろ。終わるなら \`!owari\` だ。`);
      console.log(`[Bot] VC参加完了 [${userTag}] → ${targetVC.name}`);
    } else if (!vcHandler.vcAvailable) {
      await message.reply("……VC参加には `@discordjs/voice` が必要だ。`npm install @discordjs/voice ffmpeg-static opusscript` を実行してから再起動しろ。");
    } else {
      await message.reply("……VC参加に失敗した。権限を確認しろ。");
    }
    return;
  }

  // ─── !hakase コマンド（VCへの音声応答）──────────────────────
  if (content.startsWith("!hakase ") || content === "!hakase") {
    const userText = content.slice("!hakase".length).trim();

    if (!vcHandler.isConnected()) {
      await message.reply("……VCに入っていない。まず `!kanshi` を実行しろ。");
      return;
    }
    if (!userText) {
      await message.reply("……何か言え。 `!hakase [メッセージ]` の形式で使え。");
      return;
    }

    console.log(`[Bot] !hakase受信 [${userTag}]: ${userText.slice(0, 80)}`);

    // タイピングインジケーター
    if (config.ai.typingIndicator) {
      await message.channel.sendTyping();
    }

    const sound = await vcHandler.respondToMessage(userText);
    if (sound) {
      await message.reply(`……${sound.name}。`);
    } else {
      await message.reply("……もう音は残っていない。全て使い切った。");
    }
    return;
  }

  // ─── コマンド処理 ────────────────────────────────────────────
  switch (content) {
    // VC退出
    case "!owari": {
      if (!vcHandler.isConnected()) {
        await message.reply("……VCには入っていない。");
        return;
      }
      vcHandler.leave();
      await message.reply("……退出する。観察記録は保存した。");
      console.log(`[Bot] VC退出 [${userTag}]`);
      return;
    }

    case "!reset":
      aiHandler.clearHistory(userId);
      await message.reply("気が変わった。記憶操作の薬だ、飲め。今すぐ");
      console.log(`[Bot] 履歴リセット: ${userTag}`);
      return;

    case "!okusuri":
      await message.reply(pick(okusuriList));
      console.log(`[Bot] おくすり投与 [${userTag}]`);
      return;

    case "!sleep":
      await message.reply(pick(sleepList));
      console.log(`[Bot] 睡眠管理 [${userTag}]`);
      return;

    case "!pain":
      await message.reply(pick(painList));
      console.log(`[Bot] 痛み・不調 [${userTag}]`);
      return;

    case "!work":
      await message.reply(pick(workList));
      console.log(`[Bot] 作業開始 [${userTag}]`);
      return;

    case "!observe":
      await message.reply(pick(observeList));
      console.log(`[Bot] 観察要求 [${userTag}]`);
      return;

    case "!reward":
      await message.reply(pick(rewardList));
      console.log(`[Bot] 褒め [${userTag}]`);
      return;

    case "!help":
      await message.reply(
        "【コマンド一覧】\n" +
        "!reset         … 会話履歴をリセット\n" +
        "!okusuri       … 薬を投与してもらう\n" +
        "!sleep         … 就寝前、管理下で休む\n" +
        "!pain          … 痛み・不調を報告する\n" +
        "!work          … 作業・勉強を開始する\n" +
        "!observe       … 観察してほしいとき\n" +
        "!reward        … 成功・達成を報告する\n" +
        "!kanshi [VC名] … ドットーレをVCに召喚（引数なしで自分のVCに参加）\n" +
        "!hakase [msg]  … VCでドットーレに反応させる（AI選択で音声再生）\n" +
        "!owari         … ドットーレをVCから退出させる\n" +
        "!help          … このヘルプを表示\n\n" +
        "それ以外のメッセージはドットーレが回答します。"
      );
      return;
  }

  // ─── AI 応答 ─────────────────────────────────────────────────
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

client.login(config.discord.token).catch((err) => {
  console.error("[Bot] ログインに失敗しました:", err.message);
  process.exit(1);
});