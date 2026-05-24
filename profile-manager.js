// profile-manager.js
const fs = require("fs");
const path = require("path");

const PROFILES_PATH = path.join(__dirname, "user-profiles.json");

// 日本語フィールド名 → 内部キー
const FIELD_MAP = {
  "呼び名": "name",
  "年齢":   "age",
  "状態":   "status",
  "備考":   "memo",
};

const FIELD_LABELS = {
  name:   "呼び名",
  age:    "年齢",
  status: "現在の状態",
  memo:   "備考",
};

class ProfileManager {
  constructor() {
    this.profiles = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(PROFILES_PATH)) {
        this.profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf-8"));
        console.log(`[Profiles] ${Object.keys(this.profiles).length}件読み込み完了`);
      }
    } catch (err) {
      console.error("[Profiles] 読み込み失敗:", err.message);
      this.profiles = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(PROFILES_PATH, JSON.stringify(this.profiles, null, 2), "utf-8");
    } catch (err) {
      console.error("[Profiles] 保存失敗:", err.message);
    }
  }

  _getOrCreate(userId, displayName) {
    if (!this.profiles[userId]) {
      const now = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
      this.profiles[userId] = {
        displayName,
        userFields: { name: null, age: null, status: null, memo: null },
        botRecord: {
          firstSeen: now,
          lastSeen: now,
          messageCount: 0,
          negativeCount: 0,
          survivalCount: 0,
        },
      };
    }
    return this.profiles[userId];
  }

  // メッセージ受信時に呼ぶ（カウント・最終観測更新）
  onMessage(userId, displayName) {
    const p = this._getOrCreate(userId, displayName);
    p.displayName = displayName;
    p.botRecord.lastSeen = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
    p.botRecord.messageCount++;
    this.save();
  }

  onNegative(userId) {
    const p = this.profiles[userId];
    if (p) { p.botRecord.negativeCount++; this.save(); }
  }

  onSurvival(userId) {
    const p = this.profiles[userId];
    if (p) { p.botRecord.survivalCount++; this.save(); }
  }

  // フィールドをセット（日本語キーまたは内部キーどちらでも可）
  setField(userId, rawField, value) {
    const p = this.profiles[userId];
    if (!p) return false;
    const field = FIELD_MAP[rawField] ?? (Object.prototype.hasOwnProperty.call(FIELD_LABELS, rawField) ? rawField : null);
    if (!field) return false;
    p.userFields[field] = value.trim();
    this.save();
    return true;
  }

  // フィールドをクリア
  clearField(userId, rawField) {
    const p = this.profiles[userId];
    if (!p) return false;
    const field = FIELD_MAP[rawField] ?? (Object.prototype.hasOwnProperty.call(FIELD_LABELS, rawField) ? rawField : null);
    if (!field) return false;
    p.userFields[field] = null;
    this.save();
    return true;
  }

  // 記入欄をすべてリセット（観察記録は保持）
  resetUserFields(userId) {
    const p = this.profiles[userId];
    if (!p) return false;
    p.userFields = { name: null, age: null, status: null, memo: null };
    this.save();
    return true;
  }

  // プロフィールシートを文字列で返す
  format(userId) {
    const p = this.profiles[userId];
    if (!p) return null;

    const lines = [`……被検体「${p.displayName}」の記録を開示する。\n`];

    lines.push("【識別情報】");
    lines.push(`ID: ${p.displayName}`);
    lines.push(`初観測: ${p.botRecord.firstSeen}`);
    lines.push(`最終観測: ${p.botRecord.lastSeen}`);

    lines.push("\n【被検体記入欄】");
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
      lines.push(`${label}: ${p.userFields[field] ?? "未記入"}`);
    }

    lines.push("\n【観察記録（ドットーレ記入）】");
    lines.push(`観測回数: ${p.botRecord.messageCount}回`);
    lines.push(`ネガティブ反応: ${p.botRecord.negativeCount > 0 ? `${p.botRecord.negativeCount}回検知` : "なし"}`);
    lines.push(`心配発言: ${p.botRecord.survivalCount > 0 ? `${p.botRecord.survivalCount}回検知` : "なし"}`);

    lines.push("\n── 記入コマンド ──");
    lines.push("`!profile set 呼び名 [名前]`");
    lines.push("`!profile set 年齢 [年齢]`");
    lines.push("`!profile set 状態 [現在の状態]`");
    lines.push("`!profile set 備考 [メモ]`");
    lines.push("`!profile clear [フィールド名]` … 特定フィールドを消去");
    lines.push("`!profile reset` … 記入欄をすべてリセット");

    return lines.join("\n");
  }

  // AI応答へのコンテキストヒント（systemHintに追記する用）
  getContextHint(userId) {
    const p = this.profiles[userId];
    if (!p) return "";
    const parts = [];
    if (p.userFields.name)   parts.push(`呼び名「${p.userFields.name}」`);
    if (p.userFields.age)    parts.push(`年齢${p.userFields.age}`);
    if (p.userFields.status) parts.push(`本人申告の状態「${p.userFields.status}」`);
    if (p.userFields.memo)   parts.push(`本人備考「${p.userFields.memo}」`);
    if (p.botRecord.negativeCount > 0) {
      parts.push(`過去にネガティブ反応${p.botRecord.negativeCount}回観測済み`);
    }
    if (p.botRecord.survivalCount > 0) {
      parts.push(`ドットーレの生存を心配する発言${p.botRecord.survivalCount}回観測済み`);
    }
    if (parts.length === 0) return "";
    return `【この被検体の記録】${parts.join("、")}。`;
  }
}

module.exports = ProfileManager;
