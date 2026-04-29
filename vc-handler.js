// vc-handler.js
// ボイスチャンネル接続・音声再生・AI音声選択ロジック

const path = require("path");
const fs = require("fs");

// ── @discordjs/voice の遅延ロード ─────────────────────────────────────────
let voiceLib = null;
try {
  voiceLib = require("@discordjs/voice");
  console.log("[VCHandler] @discordjs/voice ロード成功");
} catch {
  console.warn("[VCHandler] @discordjs/voice が見つかりません。VC機能は無効です。");
  console.warn("[VCHandler] 有効にするには: npm install @discordjs/voice ffmpeg-static opusscript");
}

// ── サウンドボード定義 ────────────────────────────────────────────────────
const SOUND_BOARD = [
  { name: "いや、ないだろう",         file: "いや、ないだろう.mp3",               tags: ["否定", "反論", "ありえない", "驚き"] },
  { name: "おっと、すまない",         file: "おっと、すまない.mp3",               tags: ["謝罪", "失礼", "すまない", "軽い謝り"] },
  { name: "やられ",                   file: "ぐあああああッ！！！(やられ).mp3",   tags: ["やられ", "敗北", "ダメージ", "絶叫"] },
  { name: "ぐおおおおっ（被ダメ２）", file: "ぐおおおおおっ…！！(被ダメ２).mp3", tags: ["叫び", "ダメージ", "驚愕", "怒り"] },
  { name: "ぐおおっ（被ダメ１）",     file: "ぐおおおっ！！(被ダメ１).mp3",      tags: ["叫び", "ダメージ", "衝撃"] },
  { name: "ごきげんよう",             file: "ごきげんよう。.mp3",                 tags: ["挨拶", "上機嫌", "余裕", "去り際"] },
  { name: "さようならと言わなくては", file: "さようならと言わなくては.mp3",       tags: ["別れ", "去り際", "皮肉", "余裕"] },
  { name: "耐える声",                 file: "ぬあああああああっ…！！(耐え).mp3",  tags: ["耐える", "苦しい", "我慢", "痛み"] },
  { name: "溜息",                     file: "はぁ…(溜息).mp3",                   tags: ["ため息", "呆れ", "疲れ", "落胆"] },
  { name: "笑い声1",                  file: "はっはっはっは….mp3",               tags: ["笑", "高笑い", "嘲笑", "面白い"] },
  { name: "笑い声2",                  file: "ははは….mp3",                       tags: ["笑", "面白い", "可笑しい"] },
  { name: "笑い声3",                  file: "ふふ….mp3",                         tags: ["笑", "含み笑い", "余裕", "皮肉"] },
  { name: "ふ…",                     file: "ふ….mp3",                           tags: ["呆れ", "鼻で笑う", "軽蔑", "余裕"] },
  { name: "ふん",                     file: "ふん.mp3",                          tags: ["呆れ", "無視", "ため息", "興味なし"] },
  { name: "ほう？",                   file: "ほう？.mp3",                        tags: ["興味", "驚き", "なるほど", "反応"] },
  { name: "ん？",                     file: "ん？.mp3",                          tags: ["疑問", "聞き返し", "確認", "怪訝"] },
  { name: "絶対に後悔するよ！",       file: "絶対に後悔するよ！.mp3",            tags: ["脅し", "警告", "怒り", "後悔"] },
  { name: "動くな。",                 file: "動くな。.mp3",                      tags: ["制止", "命令", "威圧", "止まれ"] },
  { name: "おっと、これは褒め言葉ではないぞ？",                 file: "おっと、これは褒め言葉ではないぞ？.mp3",                      tags: ["呆れ", "軽蔑", "興味なし", "余裕"] },
  { name: "ここの看板メニューを食べないのか？",                 file: "ここの看板メニューを食べないのか？.mp3",                      tags: ["空腹", "興味", "提案", "余裕"] },
];

// ── ファジー正規化 ─────────────────────────────────────────────────────────
function fuzzyNormalize(filename) {
  let s = filename.normalize("NFC");
  s = s.replace(/[\u3041-\u3096]/g, (c) =>
    String.fromCodePoint(c.codePointAt(0) + 0x60)
  );
  s = s.replace(/\.{2,}|\u2026/g, "\u2026");
  s = s.replace(/[(（\uff08]/g, "\uff08");
  s = s.replace(/[)）\uff09]/g, "\uff09");
  return s;
}

function findActualFile(targetFileName, actualFiles) {
  const exact = actualFiles.find(
    (f) => f.normalize("NFC") === targetFileName.normalize("NFC")
  );
  if (exact) return exact;
  const targetFuzzy = fuzzyNormalize(targetFileName);
  const fuzzy = actualFiles.find((f) => fuzzyNormalize(f) === targetFuzzy);
  return fuzzy ?? null;
}

// ── 起動時ファイル確認 ────────────────────────────────────────────────────
function checkSoundFiles() {
  const soundsDir = path.join(__dirname, "sounds");
  if (!fs.existsSync(soundsDir)) {
    console.warn("[VCHandler] sounds/ フォルダが存在しません。");
    return;
  }
  const actualFiles = fs.readdirSync(soundsDir);
  let okCount = 0;
  let ngCount = 0;

  for (const entry of SOUND_BOARD) {
    const matched = findActualFile(entry.file, actualFiles);
    if (matched) {
      if (matched !== entry.file) {
        console.log(`[VCHandler] ファジーマッチ: "${entry.file}" → "${matched}"`);
      }
      okCount++;
    } else {
      console.warn(`[VCHandler] NG (マッチなし): "${entry.file}"`);
      ngCount++;
    }
  }
  console.log(`[VCHandler] ファイル確認: ${okCount}件OK / ${ngCount}件NG`);
}

checkSoundFiles();

class VCHandler {
  constructor(config) {
    this.config = config;
    this.connection = null;
    this.player = null;
    this.isPlaying = false;
    this.vcAvailable = voiceLib !== null;

    if (this.vcAvailable) {
      const { createAudioPlayer, AudioPlayerStatus } = voiceLib;
      this.player = createAudioPlayer();
      this.player.on(AudioPlayerStatus.Idle, () => { this.isPlaying = false; });
      this.player.on("error", (err) => {
        console.error("[VCHandler] AudioPlayer error:", err.message);
        this.isPlaying = false;
      });
    }
  }

  // ── 外部切断の検知・自動クリーンアップ ──────────────────────────────────
  // Discord側でBotをVCから切断した場合に connection を null にする
  _setupConnectionListeners() {
    if (!this.connection || !voiceLib) return;
    const { VoiceConnectionStatus } = voiceLib;

    this.connection.on("stateChange", (oldState, newState) => {
      const oldStatus = oldState.status;
      const newStatus = newState.status;

      // Disconnected になったら破棄して null に
      if (newStatus === VoiceConnectionStatus.Disconnected) {
        console.log(`[VCHandler] 外部切断を検知 (${oldStatus} → ${newStatus})。接続をクリーンアップします。`);
        try {
          this.connection.destroy();
        } catch (_) { /* すでに破棄済みの場合は無視 */ }
        this.connection = null;
        this.isPlaying = false;
      }

      // Destroyed になった場合も null に
      if (newStatus === VoiceConnectionStatus.Destroyed) {
        this.connection = null;
        this.isPlaying = false;
      }
    });
  }

  // ── VC への参加 ─────────────────────────────────────────────────────────
  async join(voiceChannel) {
    if (!this.vcAvailable) {
      console.warn("[VCHandler] @discordjs/voice 未インストールのため参加不可");
      return false;
    }
    const { joinVoiceChannel, VoiceConnectionStatus, entersState } = voiceLib;
    try {
      this.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      // 外部切断を自動検知するリスナーを登録
      this._setupConnectionListeners();

      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
      if (this.player) this.connection.subscribe(this.player);
      console.log(`[VCHandler] VC参加完了: ${voiceChannel.name}`);
      return true;
    } catch (err) {
      console.error("[VCHandler] VC参加失敗:", err.message);
      try { this.connection?.destroy(); } catch (_) {}
      this.connection = null;
      return false;
    }
  }

  // ── VC からの退出 ────────────────────────────────────────────────────────
  leave() {
    if (this.connection) {
      this.player.stop();
      try { this.connection.destroy(); } catch (_) {}
      this.connection = null;
      this.isPlaying = false;
      console.log("[VCHandler] VC退出完了");
      return true;
    }
    return false;
  }

  isConnected() {
    if (!this.vcAvailable || !this.connection) return false;
    const { VoiceConnectionStatus } = voiceLib;
    return (
      this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      this.connection.state.status !== VoiceConnectionStatus.Disconnected
    );
  }

  // ── AIによる音声選択（毎回全音声から2つ選択）───────────────────────────
  async selectSound(userMessage) {
    const soundList = SOUND_BOARD
      .map((s, i) => `${i}: ${s.name} (タグ: ${s.tags.join(", ")})`)
      .join("\n");

    const prompt = `あなたはDiscordボット「ドットーレ」の音声選択AIです。
ユーザーのメッセージに対して、ドットーレが反応として最もふさわしい音声を2つ選んでください。

【ユーザーのメッセージ】
${userMessage}

【選択可能な音声一覧】
${soundList}

以下の形式で返してください（例: 3,7|うれしそうだ）：
インデックス1,インデックス2|ドットーレが今何を考えているか一言（括弧なし・日本語・10文字以内）

他の文字は含めないでください。数字・カンマ・縦棒・日本語のみです。`;

    const callGemini = async (model) => {
      const apiKey = this.config.gemini.apiKey;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 500,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });

      const data = await res.json();

      if (data.error) {
        const code = data.error.code;
        const msg = data.error.message ?? "";
        if (code === 503 || msg.includes("high demand") || msg.includes("UNAVAILABLE")) {
          throw new Error(`503: ${msg}`);
        }
        console.error(`[VCHandler] API エラー: ${code} - ${msg}`);
        return null;
      }

      return data;
    };

    const parseResponse = (data) => {
      const candidate = data.candidates?.[0];
      const raw = (candidate?.content?.parts?.[0]?.text ?? "").trim();
      console.log(`[VCHandler] finishReason: ${candidate?.finishReason ?? "不明"} / AI生応答: "${raw}"`);

      const [indicesPart, thought = ""] = raw.split("|");
      const indices = indicesPart.split(",").map(s => parseInt(s.trim(), 10));
      const valid = indices.filter(i => !isNaN(i) && i >= 0 && i < SOUND_BOARD.length);
      if (valid.length >= 2) {
        const chosen = [SOUND_BOARD[valid[0]], SOUND_BOARD[valid[1]]];
        console.log(`[VCHandler] AI選択音声: ${chosen.map(c => c.name).join(", ")} / 思考: "${thought}"`);
        return { sounds: chosen, thought: thought.trim() };
      }
      if (valid.length === 1) {
        const chosen = SOUND_BOARD[valid[0]];
        return { sounds: [chosen, this._randomFallback()], thought: thought.trim() };
      }
      console.warn(`[VCHandler] AI応答パース失敗: "${raw}" → ランダム選択`);
      return { sounds: this._randomFallback(2), thought: "" };
    };

    try {
      const primaryModel = this.config.gemini.model;
      let data = null;

      try {
        data = await callGemini(primaryModel);
      } catch (primaryErr) {
        const fallbackModel = this.config.gemini.fallbackModel;
        if (fallbackModel) {
          console.warn(`[VCHandler] プライマリモデル失敗。フォールバック: ${fallbackModel}`);
          data = await callGemini(fallbackModel);
        }
      }

      if (!data) return { sounds: this._randomFallback(2), thought: "" };
      return parseResponse(data);
    } catch (err) {
      console.error("[VCHandler] AI音声選択エラー:", err.message);
      return { sounds: this._randomFallback(2), thought: "" };
    }
  }

  _randomFallback(count = 1) {
    if (count === 2) {
      const i1 = Math.floor(Math.random() * SOUND_BOARD.length);
      let i2 = Math.floor(Math.random() * SOUND_BOARD.length);
      if (i2 === i1) i2 = (i2 + 1) % SOUND_BOARD.length;
      return [SOUND_BOARD[i1], SOUND_BOARD[i2]];
    }
    return SOUND_BOARD[Math.floor(Math.random() * SOUND_BOARD.length)];
  }

  // ── 音声ファイルの再生 ────────────────────────────────────────────────────
  async playSound(soundEntry) {
    if (!this.vcAvailable || !this.player) {
      console.warn("[VCHandler] 音声再生不可（@discordjs/voice 未インストール）");
      return false;
    }
    if (!this.isConnected()) {
      console.warn("[VCHandler] VC未接続のため再生スキップ");
      return false;
    }

    const soundsDir = path.join(__dirname, "sounds");
    const actualFiles = fs.readdirSync(soundsDir);
    const matched = findActualFile(soundEntry.file, actualFiles);

    if (!matched) {
      console.warn(`[VCHandler] 音声ファイルが見つかりません: ${soundEntry.file}`);
      return false;
    }

    const filePath = path.join(soundsDir, matched);
    try {
      const { createAudioResource, AudioPlayerStatus } = voiceLib;
      const resource = createAudioResource(filePath);
      this.player.play(resource);
      this.isPlaying = true;
      console.log(`[VCHandler] 再生開始: ${soundEntry.name}`);

      await new Promise((resolve) => {
        const onIdle = () => { this.player.off("error", onError); resolve(); };
        const onError = () => { this.player.off(AudioPlayerStatus.Idle, onIdle); resolve(); };
        this.player.once(AudioPlayerStatus.Idle, onIdle);
        this.player.once("error", onError);
      });

      return true;
    } catch (err) {
      console.error("[VCHandler] 再生エラー:", err.message);
      return false;
    }
  }

  // ── メッセージに応じて音声を選択して再生（統合メソッド）─────────────────
  async respondToMessage(userMessage) {
    const { sounds, thought } = await this.selectSound(userMessage);
    const results = [];
    for (const sound of sounds) {
      if (!sound) continue;
      const played = await this.playSound(sound);
      if (played) results.push(sound);
    }
    return results.length > 0 ? { sounds: results, thought } : null;
  }
}

module.exports = { VCHandler, SOUND_BOARD };