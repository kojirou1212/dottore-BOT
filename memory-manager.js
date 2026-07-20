// memory-manager.js
const fs = require("fs");
const path = require("path");

const MEMORIES_PATH = path.join(__dirname, "user-memories.json");

class MemoryManager {
  constructor() {
    // { userId: { entries: [{text, timestamp}] }, _meta: { lastRefresh: "YYYY/MM/DD" } }
    this.data = {};
    this.load();
    this.checkAndRefresh();
    // 6時間ごとにリフレッシュ確認
    setInterval(() => this.checkAndRefresh(), 6 * 60 * 60 * 1000);
  }

  load() {
    try {
      if (fs.existsSync(MEMORIES_PATH)) {
        this.data = JSON.parse(fs.readFileSync(MEMORIES_PATH, "utf-8"));
        const userCount = Object.keys(this.data).filter(k => k !== "_meta").length;
        console.log(`[Memories] ${userCount}ユーザー分読み込み`);
      }
    } catch (err) {
      console.error("[Memories] 読み込み失敗:", err.message);
      this.data = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(MEMORIES_PATH, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("[Memories] 保存失敗:", err.message);
    }
  }

  addMemory(userId, text) {
    if (!this.data[userId]) this.data[userId] = { entries: [] };
    this.data[userId].entries.push({ text: text.trim(), timestamp: Date.now() });
    if (this.data[userId].entries.length > 40) {
      this.data[userId].entries = this.data[userId].entries.slice(-40);
    }
    this.save();
  }

  getMemories(userId) {
    return (this.data[userId]?.entries ?? []).slice();
  }

  clearMemories(userId) {
    if (!this.data[userId]) return false;
    this.data[userId].entries = [];
    this.save();
    return true;
  }

  formatForContext(userId) {
    const entries = this.getMemories(userId);
    if (entries.length === 0) return "";
    const lines = entries.slice(-10).map(e => `・${e.text}`).join("\n");
    return `【会話から得た記憶】\n${lines}`;
  }

  formatForDisplay(userId) {
    const entries = this.getMemories(userId);
    if (entries.length === 0) return null;
    return entries.map((e, i) => {
      const d = new Date(e.timestamp).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
      return `${i + 1}. [${d}] ${e.text}`;
    }).join("\n");
  }

  // ─── 明示的な記録（!oboete）─────────────────────────────────────────────
  // ドットーレが自動抽出する entries とは別枠。週次リフレッシュの対象外＝ユーザーが
  // 明示的に消去するまで残り続ける（ChatGPTの「記憶」機能に近い動作）
  addSavedMemory(userId, text) {
    if (!this.data[userId]) this.data[userId] = { entries: [] };
    if (!this.data[userId].saved) this.data[userId].saved = [];
    this.data[userId].saved.push({ text: text.trim(), timestamp: Date.now() });
    if (this.data[userId].saved.length > 50) {
      this.data[userId].saved = this.data[userId].saved.slice(-50);
    }
    this.save();
  }

  getSavedMemories(userId) {
    return (this.data[userId]?.saved ?? []).slice();
  }

  clearSavedMemories(userId) {
    if (!this.data[userId]?.saved || this.data[userId].saved.length === 0) return false;
    this.data[userId].saved = [];
    this.save();
    return true;
  }

  formatSavedForContext(userId) {
    const saved = this.getSavedMemories(userId);
    if (saved.length === 0) return "";
    const lines = saved.map(e => `・${e.text}`).join("\n");
    return `【被検体自身が明示的に記録を指示した事項（自動抽出とは別枠・恒久保存）】\n${lines}`;
  }

  formatSavedForDisplay(userId) {
    const saved = this.getSavedMemories(userId);
    if (saved.length === 0) return null;
    return saved.map((e, i) => {
      const d = new Date(e.timestamp).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
      return `${i + 1}. [${d}] ${e.text}`;
    }).join("\n");
  }

  // 毎週水曜日に古い記憶を間引く（保持期間は RETENTION_DAYS）
  // 週1回長期記憶を刈り取る一方、1ヶ月分の関係性は失われないようにする
  static RETENTION_DAYS = 30;

  checkAndRefresh() {
    const jst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    if (jst.getDay() !== 3) return false; // 水曜日のみ

    const lastRefresh = this.data._meta?.lastRefresh;
    if (lastRefresh) {
      const last = new Date(lastRefresh);
      const daysSince = (jst.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) return false;
    }

    // RETENTION_DAYS より古いエントリーを削除
    const cutoff = Date.now() - MemoryManager.RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let cleared = 0;
    for (const [userId, userData] of Object.entries(this.data)) {
      if (userId === "_meta") continue;
      const before = userData.entries.length;
      userData.entries = userData.entries.filter(e => e.timestamp > cutoff);
      cleared += before - userData.entries.length;
    }

    this.data._meta = {
      lastRefresh: jst.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
    };
    this.save();
    console.log(`[Memories] 週次リフレッシュ完了 (${cleared}件削除)`);
    return true;
  }
}

module.exports = MemoryManager;
