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

// ── ffmpeg 確認（Raspberry Pi / ARM環境でのデバッグ用）──────────────────────
(function checkFfmpeg() {
  try {
    const p = require("ffmpeg-static");
    if (p) {
      console.log(`[VCHandler] ffmpeg-static: ${p}`);
    } else {
      console.warn("[VCHandler] ffmpeg-static からパスを取得できません。システムffmpegを使用します。");
      console.warn("[VCHandler]   → sudo apt install ffmpeg  を実行してください。");
    }
  } catch {
    console.warn("[VCHandler] ffmpeg-staticが使用不可。システムffmpegを使用します。");
    console.warn("[VCHandler]   → sudo apt install ffmpeg  を実行してください。");
  }
})();

// ── prism-media の遅延ロード（Opusデコード用）────────────────────────────
let prism = null;
try {
  prism = require(path.resolve(__dirname, "node_modules/@discordjs/voice/node_modules/prism-media"));
  console.log("[VCHandler] prism-media ロード成功");
} catch {
  try {
    prism = require("prism-media");
    console.log("[VCHandler] prism-media ロード成功（トップレベル）");
  } catch {
    console.warn("[VCHandler] prism-media が見つかりません。音声認識機能は無効です。");
  }
}

// ── PCM ダウンサンプリング（48kHz ステレオ → 16kHz モノラル）─────────────
// STT に必要な品質は 16kHz モノラルで十分。送信データが 1/6 になる
function downsamplePcm(pcmBuffer, fromRate = 48000, toRate = 16000, channels = 2) {
  const ratio = fromRate / toRate;
  const inSamplesPerCh = Math.floor(pcmBuffer.length / (channels * 2));
  const outSamples = Math.floor(inSamplesPerCh / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = Math.floor(i * ratio);
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcmBuffer.readInt16LE((src * channels + c) * 2);
    }
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

// ── PCM → WAV 変換 ────────────────────────────────────────────────────────
function pcmToWav(pcmBuffer, sampleRate = 48000, channels = 2, bitDepth = 16) {
  const header = Buffer.alloc(44);
  const dataSize = pcmBuffer.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitDepth / 8, 28);
  header.writeUInt16LE(channels * bitDepth / 8, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// ① 独り言に適した短めのサウンド名リスト
const MUTTER_SOUND_NAMES = ["溜息", "ふ…", "ふん", "笑い声3", "ん？"];

// ── サウンドボード定義 ────────────────────────────────────────────────────
const SOUND_BOARD = [
  { name: "いや、ないだろう",         file: "いや、ないだろう.mp3",               tags: ["否定", "反論", "ありえない", "驚き"] },
  { name: "おっと、すまない",         file: "おっと、すまない.mp3",               tags: ["謝罪", "失礼", "すまない", "軽い謝り"] },
  { name: "やられ",                   file: "ぐあああああッ！！！(やられ).mp3",   tags: ["やられ", "敗北", "ダメージ", "絶叫"] },
  { name: "ぐおおおおっ（被ダメ２）", file: "ぐおおおおおっ…！！(被ダメ２).mp3", tags: ["叫び", "ダメージ", "驚愕", "怒り"] },
  { name: "ぐおおっ（被ダメ１）",     file: "ぐおおおっ！！(被ダメ１).mp3",      tags: ["叫び", "ダメージ", "衝撃"] },
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
  { name: "そうかもしれないな",        file: "そうかもしれないな.mp3",            tags: ["同意", "曖昧", "考える", "余裕"] },
  { name: "そうだな",                  file: "そうだな.mp3",                      tags: ["同意", "肯定", "落ち着き", "余裕"] },
  { name: "そう思うか",                file: "そう思うか.mp3",                    tags: ["疑問", "考える", "聞き返し", "興味"] },
  { name: "なるほど",                  file: "なるほど.mp3",                      tags: ["納得", "興味", "なるほど", "反応"] },
  { name: "ふっ",                      file: "ふっ.mp3",                          tags: ["笑", "鼻で笑う", "軽蔑", "余裕"] },
  { name: "安心するといい",            file: "安心するといい.mp3",                tags: ["安心", "余裕", "上から目線", "慰め"] },
  { name: "無音",                      file: "無音.mp3",                          tags: ["無音", "沈黙", "無反応", "間"] },
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

  const allEntries = [...SOUND_BOARD, ...VC_JOIN_SOUNDS, ...VC_LEAVE_SOUNDS];
  for (const entry of allEntries) {
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

// ── VC入室・退出専用サウンド ─────────────────────────────────────────────
const VC_JOIN_SOUNDS = [
  { name: "ごきげんよう（入室）",         file: "start_ごきげんよう。.mp3" },
  { name: "ひさしぶりだな（入室）",       file: "start_ひさしぶりだな.mp3" },
];

const VC_LEAVE_SOUNDS = [
  { name: "さようならと言わなくては（退出）", file: "end_さようならと言わなくては.mp3" },
  { name: "終了だ（退出）",                   file: "end_終了だ.mp3" },
];

checkSoundFiles();

class VCHandler {
  constructor(config) {
    this.config = config;
    this.connection = null;
    this.player = null;
    this.isPlaying = false;
    this.vcAvailable = voiceLib !== null;
    this._activeStreams = new Map(); // userId -> { pcmChunks, opusStream, decoder }
    this._recentlyPlayed = false;
    this._transcriptCallback = null;
    this._speakingHandler = null;
    this._lastResponseTime = 0;
    this._cooldownMs = config.ai?.listenCooldownMs ?? 30000;
    this._userLastSttTime = new Map(); // userId -> 最終STT時刻（ユーザーごとのレート制限）
    this._userSttCooldownMs = config.ai?.sttUserCooldownMs ?? 20000;
    this._preFilter = null; // (userId) => boolean — true なら STT スキップ

    if (this.vcAvailable) {
      const { createAudioPlayer, AudioPlayerStatus } = voiceLib;
      this.player = createAudioPlayer();
      this.player.on(AudioPlayerStatus.Idle, () => {
        this.isPlaying = false;
        this._recentlyPlayed = true;
        setTimeout(() => { this._recentlyPlayed = false; }, 800);
      });
      this.player.on("error", (err) => {
        console.error("[VCHandler] AudioPlayer error:", err.message);
        this.isPlaying = false;
        this._recentlyPlayed = false;
      });
    }
  }

  // ── 外部切断の検知・自動クリーンアップ ──────────────────────────────────
  _setupConnectionListeners() {
    if (!this.connection || !voiceLib) return;
    const { VoiceConnectionStatus, entersState } = voiceLib;

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // 5秒以内に Signalling/Connecting に戻れば再接続中なので待つ
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // 再接続できなければ本当の切断として扱う
        console.log("[VCHandler] 外部切断を検知。接続をクリーンアップします。");
        this.stopListening();
        try { this.connection.destroy(); } catch (_) {}
        this.connection = null;
        this.isPlaying = false;
      }
    });

    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.stopListening();
      this.connection = null;
      this.isPlaying = false;
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

      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
      if (this.player) this.connection.subscribe(this.player);
      // Ready 確認後にリスナーを登録（初期接続中の Disconnected を誤検知しない）
      this._setupConnectionListeners();
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
      this.stopListening();
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

  // ── AIによる音声選択 ─────────────────────────────────────────────────────
  async selectSound(userMessage) {
    const soundList = SOUND_BOARD
      .map((s, i) => `${i}: ${s.name} (タグ: ${s.tags.join(", ")})`)
      .join("\n");

    const prompt = `あなたはDiscordボット「ドットーレ」の音声選択AIです。
ユーザーのメッセージに対して、ドットーレが反応として最もふさわしい音声を1つ選んでください。

【ユーザーのメッセージ】
${userMessage}

【選択可能な音声一覧】
${soundList}

以下の形式で返してください（例: 3|うれしそうだ）：
インデックス|ドットーレが今何を考えているか一言（括弧なし・日本語・10文字以内）

他の文字は含めないでください。数字・縦棒・日本語のみです。`;

    const callGrok = async (model) => {
      const apiKey = this.config.grok.apiKey;
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 30,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const msg = data.error?.message ?? res.statusText;
        const code = res.status;
        if (code === 503 || code === 429) throw new Error(`${code}: ${msg}`);
        console.error(`[VCHandler] API エラー: ${code} - ${msg}`);
        return null;
      }

      return data;
    };

    const parseResponse = (data) => {
      const raw = (data.choices?.[0]?.message?.content ?? "").trim();
      console.log(`[VCHandler] AI生応答: "${raw}"`);

      const [indexPart, thought = ""] = raw.split("|");
      const index = parseInt(indexPart.trim(), 10);
      if (!isNaN(index) && index >= 0 && index < SOUND_BOARD.length) {
        const chosen = SOUND_BOARD[index];
        console.log(`[VCHandler] AI選択音声: ${chosen.name} / 思考: "${thought}"`);
        return { sounds: [chosen], thought: thought.trim() };
      }
      console.warn(`[VCHandler] AI応答パース失敗: "${raw}" → ランダム選択`);
      return { sounds: [this._randomFallback()], thought: "" };
    };

    try {
      const primaryModel = this.config.grok.model;
      let data = null;

      try {
        data = await callGrok(primaryModel);
      } catch (primaryErr) {
        const fallbackModel = this.config.grok.fallbackModel;
        if (fallbackModel) {
          console.warn(`[VCHandler] プライマリモデル失敗。フォールバック: ${fallbackModel}`);
          data = await callGrok(fallbackModel);
        }
      }

      if (!data) return { sounds: [this._randomFallback()], thought: "" };
      return parseResponse(data);
    } catch (err) {
      console.error("[VCHandler] AI音声選択エラー:", err.message);
      return { sounds: [this._randomFallback()], thought: "" };
    }
  }

  _randomFallback() {
    return SOUND_BOARD[Math.floor(Math.random() * SOUND_BOARD.length)];
  }

  // タグのキーワードマッチングでサウンドをローカル選択（API呼び出しなし）
  selectSoundLocal(userMessage) {
    const msg = userMessage.toLowerCase();
    const scored = SOUND_BOARD
      .filter((s) => s.name !== "無音")
      .map((sound) => ({
        sound,
        score: sound.tags.filter((tag) => msg.includes(tag.toLowerCase())).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      console.log(`[VCHandler] ローカル音声選択: ${scored[0].sound.name} (スコア:${scored[0].score})`);
      return { sounds: [scored[0].sound], thought: "" };
    }
    return { sounds: [this.mutter()], thought: "" };
  }

  // ① 独り言用：短くて自然なサウンドをランダム選択
  mutter() {
    const candidates = SOUND_BOARD.filter((s) => MUTTER_SOUND_NAMES.includes(s.name));
    if (candidates.length === 0) return this._randomFallback();
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  async playMutter() {
    if (!this.isConnected()) return false;
    return this.playSound(this.mutter());
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

  // ── VC入室・退出サウンド ─────────────────────────────────────────────────
  async playJoinSound() {
    const entry = VC_JOIN_SOUNDS[Math.floor(Math.random() * VC_JOIN_SOUNDS.length)];
    console.log(`[VCHandler] 入室サウンド: ${entry.name}`);
    return Promise.race([
      this.playSound(entry),
      new Promise((r) => setTimeout(() => r(false), 10000)),
    ]);
  }

  async playLeaveSound() {
    const entry = VC_LEAVE_SOUNDS[Math.floor(Math.random() * VC_LEAVE_SOUNDS.length)];
    console.log(`[VCHandler] 退出サウンド: ${entry.name}`);
    return Promise.race([
      this.playSound(entry),
      new Promise((r) => setTimeout(() => r(false), 10000)),
    ]);
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

    // ④ 二連反応：15%の確率で短い間を置いてもう一音
    if (results.length > 0 && Math.random() < 0.15) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
      const extra = this.mutter();
      const played = await this.playSound(extra);
      if (played) {
        results.push(extra);
        console.log(`[VCHandler] 二連反応: ${extra.name}`);
      }
    }

    if (results.length > 0) return { sounds: results, thought };

    const silent = SOUND_BOARD.find((s) => s.file === "無音.mp3");
    if (silent) {
      const played = await this.playSound(silent);
      if (played) return { sounds: [silent], thought: "" };
    }
    return null;
  }

  isListening() {
    return this._transcriptCallback !== null;
  }

  // ── 音声受信・文字起こし開始 ──────────────────────────────────────────────
  startListening(onTranscript) {
    if (!this.vcAvailable || !this.connection || !prism) {
      if (!prism) console.warn("[VCHandler] prism-media 未ロードのため音声認識不可");
      return false;
    }
    // 既存リスナーを先に解除（重複防止）
    if (this._speakingHandler) {
      this.connection.receiver.speaking.off("start", this._speakingHandler);
      this._speakingHandler = null;
    }
    this._transcriptCallback = onTranscript;
    const { EndBehaviorType } = voiceLib;
    const receiver = this.connection.receiver;

    this._speakingHandler = (userId) => {
      if (this.isPlaying || this._recentlyPlayed) return;
      if (this._activeStreams.size > 0) return;
      if (Date.now() - this._lastResponseTime < this._cooldownMs) return;
      if (!this._transcriptCallback) return;
      if (this._preFilter && this._preFilter(userId)) return; // 集中モード・無視中をSTT前に排除
      const userLastStt = this._userLastSttTime.get(userId) || 0;
      if (Date.now() - userLastStt < this._userSttCooldownMs) return;

      const pcmChunks = [];
      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

      this._activeStreams.set(userId, { pcmChunks, opusStream, decoder });
      opusStream.pipe(decoder);

      // 'end'が発火せずdecoderが強制destroyされた場合のセーフネット
      let streamDone = false;
      const forceCleanup = () => {
        if (streamDone) return;
        streamDone = true;
        const e = this._activeStreams.get(userId);
        if (e) {
          e.pcmChunks.length = 0;
          try { e.opusStream.destroy(); } catch (_) {}
        }
        this._activeStreams.delete(userId);
      };

      decoder.on("data", (chunk) => {
        const entry = this._activeStreams.get(userId);
        if (entry) entry.pcmChunks.push(chunk);
      });

      decoder.on("end", async () => {
        if (streamDone) return;
        streamDone = true; // 'close'のセーフネットより先にマーク

        const entry = this._activeStreams.get(userId);
        if (!entry) return;

        const MAX_PCM = 48000 * 2 * 2 * 30; // 30秒上限
        let pcm = Buffer.concat(entry.pcmChunks);
        entry.pcmChunks.length = 0; // キャッシュを即時クリア

        if (pcm.length < 48000 * 2 * 2 * 1.5) { // 1.5秒未満は無音・ノイズとして破棄
          this._activeStreams.delete(userId);
          return;
        }
        if (pcm.length > MAX_PCM) pcm = pcm.subarray(0, MAX_PCM);

        try {
          // 48kHz ステレオ → 16kHz モノラルにダウンサンプリングしてから STT
          const pcm16 = downsamplePcm(pcm);
          const wav = pcmToWav(pcm16, 16000, 1, 16);
          const text = await this._transcribeAudio(wav);
          if (text && text.trim() && this._transcriptCallback) {
            console.log(`[VCHandler] 音声認識 [${userId}]: ${text.trim()}`);
            await this._transcriptCallback(userId, text.trim());
          }
        } catch (err) {
          console.error("[VCHandler] 音声認識エラー:", err.message);
        } finally {
          this._activeStreams.delete(userId);
          this._lastResponseTime = Date.now(); // SILENT 含め常にリセット（バースト防止）
          this._userLastSttTime.set(userId, Date.now());
        }
      });

      // 'end'なしでdecoderがdestroyされたとき（エラー後の自動破棄など）に発火
      decoder.once("close", forceCleanup);

      decoder.on("error", (err) => {
        if (err.message.includes("Invalid packet") || err.message.includes("Decode error")) {
          // 無効パケットはスキップ。destroyされた場合は'close'が後処理する
          return;
        }
        console.error("[VCHandler] Opusデコードエラー（致命的）:", err.message);
        const entry = this._activeStreams.get(userId);
        if (entry) {
          entry.pcmChunks.length = 0;
          try { entry.opusStream.destroy(); } catch (_) {}
        }
        this._activeStreams.delete(userId);
      });
    };

    receiver.speaking.on("start", this._speakingHandler);
    console.log("[VCHandler] 音声受信開始");
    return true;
  }

  stopListening() {
    if (this._speakingHandler && this.connection) {
      this.connection.receiver.speaking.off("start", this._speakingHandler);
    }
    this._speakingHandler = null;
    this._transcriptCallback = null;
    this._userLastSttTime.clear();

    for (const [, entry] of this._activeStreams) {
      entry.pcmChunks.length = 0;
      try { entry.opusStream.destroy(); } catch (_) {}
      try { entry.decoder.destroy(); } catch (_) {}
    }
    this._activeStreams.clear();
  }

  // ── Gemini API による文字起こし ──────────────────────────────────────────
  async _transcribeAudio(wavBuffer, maxRetries = 2) {
    const apiKey = this.config.gemini.apiKey;
    const model = this.config.gemini.sttModel || "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const bodyJson = JSON.stringify({
      contents: [{
        parts: [
          { text: "この音声を日本語でそのまま文字起こしして。音声がない場合はSILENTとだけ返して。" },
          { inline_data: { mime_type: "audio/wav", data: wavBuffer.toString("base64") } },
        ],
      }],
    });

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: bodyJson,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const data = await res.json();
      if (!res.ok) {
        const msg = data.error?.message ?? res.statusText;
        const is503 = res.status === 503;
        const is429 = res.status === 429 ||
          msg.includes("high demand") || msg.includes("rate") || msg.includes("quota");
        lastError = new Error(`Gemini STT error: ${msg}`);
        // 503はサービス障害なのでスキップ、429はレート制限なので指数バックオフ
        const shouldRetry = !is503 && is429 && attempt < maxRetries;
        if (shouldRetry) {
          const waitMs = (2 ** attempt) * 1000 + Math.random() * 500;
          console.warn(`[VCHandler] STTリトライ ${attempt + 1} (429, ${Math.round(waitMs)}ms後)`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw lastError;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text || text.toUpperCase() === "SILENT") return null;
      return text;
    }
    throw lastError;
  }
}

module.exports = { VCHandler, SOUND_BOARD };