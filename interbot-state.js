// interbot-state.js
// パンタローネ・ドットーレ直接対話チャンネル用のセッション状態の永続化。
// 各Botプロセスが自分自身の送信回数・会話ログを個別に保持する
// （dottore-server-a と pantalone-server は別ファイル。詳細は他ファイルの *_FILE 環境変数と同じ方式）。
const fs = require("fs");
const path = require("path");

const STATE_PATH = process.env.INTERBOT_STATE_FILE
  ? path.resolve(__dirname, process.env.INTERBOT_STATE_FILE)
  : path.join(__dirname, "interbot-state.json");

// この時間以上、送受信が無ければ「別セッション」とみなし送信回数をリセットする
const SESSION_GAP_MS = 60 * 60 * 1000;

// このBot自身が1セッションで送信してよい上限（＝往復数の上限）。
// 両Botとも同じ定数を参照することで、別プロセス・別状態ファイルでも終了タイミングが揃う。
const MAX_ROUNDS = 6;

const EMPTY_STATE = () => ({ sentCount: 0, lastActivityAt: 0, transcript: [], mentionedUserIds: [], isFirstSession: false, debugMode: false, topicSwitched: false });

class InterBotState {
  constructor() {
    // everMet はセッションをまたいで永続する（startSession/ensureFreshSessionでリセットされない）。
    // 「初回セッションかどうか」の唯一の判定材料。
    this.everMet = false;
    this.state = EMPTY_STATE();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
        this.everMet = raw.everMet ?? false;
        this.state = { ...EMPTY_STATE(), ...(raw.state ?? {}) };
      }
    } catch (err) {
      console.error("[InterBot] 状態読み込み失敗:", err.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify({ everMet: this.everMet, state: this.state }, null, 2), "utf-8");
    } catch (err) {
      console.error("[InterBot] 状態保存失敗:", err.message);
    }
  }

  _beginSession() {
    const isFirstSession = !this.everMet;
    this.state = EMPTY_STATE();
    this.state.isFirstSession = isFirstSession;
    this.state.lastActivityAt = Date.now();
    this.everMet = true;
    this.save();
  }

  // 定時トリガーによる新規セッション開始時に呼ぶ（強制リセット）
  startSession() {
    this._beginSession();
  }

  // !kaiwaデバッグコマンド用：出会い直しシナリオ（初回演出）を消費せず、常に通常セッションとして
  // 強制リセットする。everMetには触れない（本物の初回演出は、スケジューラ経由の本当に最初の1回の
  // ためにそのまま温存される）。debugMode=trueの間、送受信はリビングチャンネルではなくデバッグ
  // チャンネル内で完結する（sendInterBotMessageの送信先切り替え、messageCreateの検知条件を参照）。
  startDebugSession() {
    this.state = EMPTY_STATE();
    this.state.debugMode = true;
    this.state.lastActivityAt = Date.now();
    this.save();
  }

  isDebugMode() {
    return this.state.debugMode === true;
  }

  // 話題の切り替え（実験の話／直近の相手の話への飛躍）をセッション中1回だけに制限するためのフラグ。
  hasSwitchedTopic() {
    return this.state.topicSwitched === true;
  }

  markTopicSwitched() {
    this.state.topicSwitched = true;
    this.save();
  }

  // 相手からのメッセージ受信時、処理前に呼ぶ。間隔が空きすぎていれば別セッションとみなす。
  ensureFreshSession() {
    if (!this.state.lastActivityAt || Date.now() - this.state.lastActivityAt > SESSION_GAP_MS) {
      this._beginSession();
    }
  }

  // 今回のセッションが、このチャンネルでの初回の顔合わせかどうか
  isFirstSession() {
    return this.state.isFirstSession === true;
  }

  // このBot自身が、今回のセッションであと送信してよいか
  canSend() {
    return this.state.sentCount < MAX_ROUNDS;
  }

  getTranscript() {
    return this.state.transcript;
  }

  // 「直近の相手についての話題」で、同一セッション内に同じ人物が重複して選ばれるのを防ぐ
  getMentionedUserIds() {
    return this.state.mentionedUserIds ?? [];
  }

  markUserMentioned(userId) {
    if (!this.state.mentionedUserIds) this.state.mentionedUserIds = [];
    if (!this.state.mentionedUserIds.includes(userId)) this.state.mentionedUserIds.push(userId);
    this.save();
  }

  recordReceived(speaker, text) {
    this.state.transcript.push({ speaker, text });
    this.state.lastActivityAt = Date.now();
    this.save();
  }

  recordSent(speaker, text) {
    this.state.transcript.push({ speaker, text });
    this.state.sentCount++;
    this.state.lastActivityAt = Date.now();
    this.save();
  }
}

module.exports = InterBotState;
