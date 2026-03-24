// vc-handler.js
// ボイスチャンネル接続・音声再生・AI音声選択ロジック

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const { GoogleGenAI } = require("@google/genai");
const path = require("path");
const fs = require("fs");

// ── サウンドボード定義 ────────────────────────────────────────────────────
// 2枚目の画像のサウンドボード一覧に対応するファイル名を定義
// sounds/ ディレクトリに同名の音声ファイル（mp3 or ogg）を置くこと
const SOUND_BOARD = [
  { name: "3秒数えてくれるドットーレ", file: "3seconds.mp3",  tags: ["カウント", "数える", "待て", "3秒"] },
  { name: "ふん...",                   file: "fun.mp3",       tags: ["呆れ", "無視", "ため息", "興味なし"] },
  { name: "笑い声1",                   file: "laugh1.mp3",    tags: ["笑", "面白", "可笑しい", "嬉しい"] },
  { name: "笑い声2",                   file: "laugh2.mp3",    tags: ["笑", "面白", "可笑しい"] },
  { name: "笑い声3",                   file: "laugh3.mp3",    tags: ["笑", "高笑い", "嘲笑"] },
  { name: "笑い声4",                   file: "laugh4.mp3",    tags: ["笑", "低い笑い"] },
  { name: "絶対に後悔するよ！",         file: "regret.mp3",   tags: ["脅し", "警告", "怒り", "後悔"] },
  { name: "溜息",                      file: "sigh.mp3",      tags: ["ため息", "呆れ", "疲れ", "落胆"] },
  { name: "ぐはっ",                    file: "guha.mp3",      tags: ["ダメージ", "驚き", "衝撃", "痛み"] },
  { name: "ぐわーっ！1",               file: "guwa1.mp3",     tags: ["叫び", "驚愕", "怒り", "絶叫"] },
  { name: "ぐわーっ！2",               file: "guwa2.mp3",     tags: ["叫び", "驚愕", "怒り"] },
  { name: "耐える声",                  file: "endure.mp3",    tags: ["耐える", "苦しい", "我慢", "痛み"] },
  { name: "やられ",                    file: "yarareru.mp3",  tags: ["やられ", "敗北", "ダメージ", "倒れる"] },
  { name: "相槌1",                     file: "aizuchi1.mp3",  tags: ["相槌", "了解", "ふむ", "なるほど"] },
  { name: "相槌2",                     file: "aizuchi2.mp3",  tags: ["相槌", "了解", "ふむ"] },
  { name: "謝罪",                      file: "apology.mp3",   tags: ["謝り", "すまない", "失礼", "申し訳"] },
  { name: "反語構文",                  file: "hango.mp3",     tags: ["反論", "皮肉", "逆説", "そんなわけない"] },
];

class VCHandler {
  constructor(config) {
    this.config = config;
    this.connection = null;
    this.player = createAudioPlayer();
    this.isPlaying = false;
    this.usedSounds = new Set(); // 1セッション中に使用済みの音声
    this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
    });

    this.player.on("error", (err) => {
      console.error("[VCHandler] AudioPlayer error:", err.message);
      this.isPlaying = false;
    });
  }

  // ── VC への参加 ─────────────────────────────────────────────────────────
  async join(voiceChannel) {
    try {
      this.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
      this.connection.subscribe(this.player);
      this.usedSounds.clear(); // セッション開始時にリセット
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
    return (
      this.connection !== null &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    );
  }

  // ── AIによる音声選択 ─────────────────────────────────────────────────────
  async selectSound(userMessage) {
    // 未使用の音声のみを候補にする
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

      const raw = response.text?.trim?.() ?? String(response.text).trim();
      const index = parseInt(raw, 10);

      if (!isNaN(index) && index >= 0 && index < available.length) {
        const chosen = available[index];
        this.usedSounds.add(chosen.file);
        console.log(`[VCHandler] AI選択音声: ${chosen.name} (index=${index})`);
        return chosen;
      }

      // パース失敗時はランダムフォールバック
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
    if (!this.isConnected()) {
      console.warn("[VCHandler] VC未接続のため再生スキップ");
      return false;
    }

    const soundsDir = path.join(__dirname, "sounds");
    const filePath = path.join(soundsDir, soundEntry.file);

    if (!fs.existsSync(filePath)) {
      console.warn(`[VCHandler] 音声ファイルが見つかりません: ${filePath}`);
      return false;
    }

    try {
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