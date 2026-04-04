// vc-handler.js
// ボイスチャンネル接続・音声再生・AI音声選択ロジック

const { GoogleGenAI } = require("@google/genai");
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
  { name: "やられ",                   file: "ぐあああああっ！！！(やられ).mp3",   tags: ["やられ", "敗北", "ダメージ", "絶叫"] },
  { name: "ぐおおおおっ（被ダメ２）", file: "ぐおおおおっ...！！(被ダメ２).mp3", tags: ["叫び", "ダメージ", "驚愕", "怒り"] },
  { name: "ぐおおっ（被ダメ１）",     file: "ぐおおっ！！(被ダメ１).mp3",        tags: ["叫び", "ダメージ", "衝撃"] },
  { name: "ごきげんよう",             file: "ごきげんよう。.mp3",                 tags: ["挨拶", "上機嫌", "余裕", "去り際"] },
  { name: "さようならと言わなくては", file: "さようならと言わなくては.mp3",       tags: ["別れ", "去り際", "皮肉", "余裕"] },
  { name: "耐える声",                 file: "ぬあああああああっ...！！(耐え).mp3", tags: ["耐える", "苦しい", "我慢", "痛み"] },
  { name: "溜息",                     file: "はぁ...(溜息).mp3",                  tags: ["ため息", "呆れ", "疲れ", "落胆"] },
  { name: "笑い声1",                  file: "はっはっはっは....mp3",              tags: ["笑", "高笑い", "嘲笑", "面白い"] },
  { name: "笑い声2",                  file: "ははは....mp3",                      tags: ["笑", "面白い", "可笑しい"] },
  { name: "笑い声3",                  file: "ふふ....mp3",                        tags: ["笑", "含み笑い", "余裕", "皮肉"] },
  { name: "ふ...",                    file: "ふ....mp3",                          tags: ["呆れ", "鼻で笑う", "軽蔑", "余裕"] },
  { name: "ふん...",                  file: "ふん.mp3",                           tags: ["呆れ", "無視", "ため息", "興味なし"] },
  { name: "ほう？",                   file: "ほう？.mp3",                         tags: ["興味", "驚き", "なるほど", "反応"] },
  { name: "ん？",                     file: "ん？.mp3",                           tags: ["疑問", "聞き返し", "確認", "怪訝"] },
  { name: "絶対に後悔するよ！",       file: "絶対に後悔するよ！.mp3",             tags: ["脅し", "警告", "怒り", "後悔"] },
  { name: "動くな。",                 file: "動くな。.mp3",                       tags: ["制止", "命令", "威圧", "止まれ"] },
];

class VCHandler {
  constructor(config) {
    this.config = config;
    this.connection = null;
    this.player = null;
    this.isPlaying = false;
    this.usedSounds = new Set();
    this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    this.vcAvailable = voiceLib !== null;
    this.playAvailable = false;

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

      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
      if (this.player) this.connection.subscribe(this.player);
      this.usedSounds.clear();
      console.log(`[VCHandler] VC参加完了: ${voiceChannel.name}`);
      return true;
    } catch (err) {
      console.error("[VCHandler] VC参加失敗:", err.message);
      this.connection?.destroy();
      this.connection = null;
      return false;
    }
  }

  // ── VC からの退出 ────────────────────────────────────────────────────────
  leave() {
    if (this.connection) {
      this.player.stop();
      this.connection.destroy();
      this.connection = null;
      this.usedSounds.clear();
      console.log("[VCHandler] VC退出完了");
      return true;
    }
    return false;
  }

  isConnected() {
    if (!this.vcAvailable || !this.connection) return false;
    const { VoiceConnectionStatus } = voiceLib;
    return this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  // ── AIによる音声選択 ─────────────────────────────────────────────────────
  async selectSound(userMessage) {
    const available = SOUND_BOARD.filter((s) => !this.usedSounds.has(s.file));
    if (available.length === 0) {
      console.log("[VCHandler] 全音声使用済み");
      return null;
    }

    const soundList = available
      .map((s, i) => `${i}: ${s.name} (タグ: ${s.tags.join(", ")})`)
      .join("\n");

    const prompt = `あなたはDiscordボット「ドットーレ」の音声選択AIです。
ユーザーのメッセージに対して、ドットーレが反応として最もふさわしい音声を1つ選んでください。

【ユーザーのメッセージ】
${userMessage}

【選択可能な音声一覧】
${soundList}

上記リストの番号（0始まりのインデックス）だけを1つ返してください。
他の文字は一切含めないでください。数字のみです。`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.config.gemini.model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 10 },
      });

      // response.text は関数の場合と文字列の場合がある
      const rawText = typeof response.text === "function"
        ? response.text()
        : response.text;
      const raw = (rawText ?? "").toString().trim();
      const index = parseInt(raw, 10);

      if (!isNaN(index) && index >= 0 && index < available.length) {
        const chosen = available[index];
        this.usedSounds.add(chosen.file);
        console.log(`[VCHandler] AI選択音声: ${chosen.name} (index=${index})`);
        return chosen;
      }

      console.warn(`[VCHandler] AI応答パース失敗: "${raw}" → ランダム選択`);
      return this._randomFallback(available);
    } catch (err) {
      console.error("[VCHandler] AI音声選択エラー:", err.message);
      return this._randomFallback(available);
    }
  }

  _randomFallback(available) {
    const chosen = available[Math.floor(Math.random() * available.length)];
    this.usedSounds.add(chosen.file);
    return chosen;
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
    const filePath = path.join(soundsDir, soundEntry.file);

    if (!fs.existsSync(filePath)) {
      console.warn(`[VCHandler] 音声ファイルが見つかりません（スキップ）: ${soundEntry.file}`);
      return false;
    }

    try {
      const { createAudioResource } = voiceLib;
      const resource = createAudioResource(filePath);
      this.player.play(resource);
      this.isPlaying = true;
      console.log(`[VCHandler] 再生開始: ${soundEntry.name}`);
      return true;
    } catch (err) {
      console.error("[VCHandler] 再生エラー:", err.message);
      return false;
    }
  }

  // ── メッセージに応じて音声を選択して再生（統合メソッド）─────────────────
  async respondToMessage(userMessage) {
    const sound = await this.selectSound(userMessage);
    if (!sound) return null;

    const played = await this.playSound(sound);
    return played ? sound : null;
  }
}

module.exports = { VCHandler, SOUND_BOARD };