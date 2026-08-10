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

const EMPTY_STATE = () => ({ sentCount: 0, lastActivityAt: 0, transcript: [] });

class InterBotState {
  constructor() {
    this.state = EMPTY_STATE();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(STATE_PATH)) {
        this.state = { ...EMPTY_STATE(), ...JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) };
      }
    } catch (err) {
      console.error("[InterBot] 状態読み込み失敗:", err.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      console.error("[InterBot] 状態保存失敗:", err.message);
    }
  }

  // 定時トリガーによる新規セッション開始時に呼ぶ（強制リセット）
  startSession() {
    this.state = EMPTY_STATE();
    this.state.lastActivityAt = Date.now();
    this.save();
  }

  // 相手からのメッセージ受信時、処理前に呼ぶ。間隔が空きすぎていれば別セッションとみなす。
  ensureFreshSession() {
    if (!this.state.lastActivityAt || Date.now() - this.state.lastActivityAt > SESSION_GAP_MS) {
      this.state = EMPTY_STATE();
    }
  }

  // このBot自身が、今回のセッションであと送信してよいか（計4往復＝自分の送信は4回まで）
  canSend() {
    return this.state.sentCount < 4;
  }

  getTranscript() {
    return this.state.transcript;
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
