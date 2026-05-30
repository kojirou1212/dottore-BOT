// knowledge-base.js
const fs = require("fs");
const path = require("path");

const KB_PATH = path.join(__dirname, "knowledge-base.json");

class KnowledgeBase {
  constructor() {
    this.data = { lore: {}, userBase: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(KB_PATH)) {
        this.data = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));
        this.data.lore ??= {};
        this.data.userBase ??= {};
        const loreCount = Object.keys(this.data.lore).length;
        const baseCount = Object.keys(this.data.userBase).length;
        console.log(`[KnowledgeBase] ロア${loreCount}件、ユーザーベース${baseCount}件`);
      }
    } catch (err) {
      console.error("[KnowledgeBase] 読み込み失敗:", err.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(KB_PATH, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("[KnowledgeBase] 保存失敗:", err.message);
    }
  }

  // ── Lore（ソース元：原作情報・永久保存）────────────────────────────────

  setLore(category, content) {
    this.data.lore[category] = {
      content,
      updatedAt: new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
    };
    this.save();
  }

  getLore(category) {
    return this.data.lore[category] ?? null;
  }

  deleteLore(category) {
    if (!this.data.lore[category]) return false;
    delete this.data.lore[category];
    this.save();
    return true;
  }

  listLoreCategories() {
    return Object.keys(this.data.lore);
  }

  // ── User base（ユーザー基本ステータス：プロフィールチャンネル投稿・永久保存）──

  setUserBase(userId, displayName, profileText) {
    this.data.userBase[userId] = {
      displayName,
      postedProfile: profileText,
      updatedAt: new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
    };
    this.save();
  }

  getUserBase(userId) {
    return this.data.userBase[userId] ?? null;
  }

  // ── AI コンテキスト用フォーマット ────────────────────────────────────────

  getLoreContextHint() {
    const entries = Object.entries(this.data.lore);
    if (entries.length === 0) return "";
    const lines = entries.map(([cat, { content }]) => `[${cat}] ${content}`).join("\n");
    return `【登録済みの知識】\n${lines}`;
  }

  getUserBaseHint(userId) {
    const u = this.data.userBase[userId];
    if (!u || !u.postedProfile) return "";
    return `【${u.displayName}の基本情報（自己申告）】\n${u.postedProfile}`;
  }
}

module.exports = KnowledgeBase;
