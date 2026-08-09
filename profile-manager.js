// profile-manager.js
const fs = require("fs");
const path = require("path");

const PROFILES_PATH = process.env.PROFILES_FILE
  ? path.resolve(__dirname, process.env.PROFILES_FILE)
  : path.join(__dirname, "user-profiles.json");

// 日本語フィールド名 → 内部キー
const FIELD_MAP = {
  "呼び名": "name",
  "年齢":   "age",
  "性別":   "gender",
  "趣味":   "hobby",
  "症状":   "symptom",
  "傾向":   "tendency",
  "弱点":   "weakness",
  "備考":   "memo",
};

const FIELD_LABELS = {
  name:      "呼び名",
  age:       "年齢",
  gender:    "性別／代名詞",
  hobby:     "趣味",
  symptom:   "症状・現在の状態",
  tendency:  "傾向・特徴",
  weakness:  "弱点・苦手",
  memo:      "備考",
};

const EMPTY_USER_FIELDS = () => ({
  name: null, age: null, gender: null, hobby: null,
  symptom: null, tendency: null, weakness: null, memo: null,
});

// 観測回数のマイルストーン（到達時に一度だけ特別なセリフを返す）
const MILESTONES = [50, 150, 300, 500, 1000];

// 馴染み度ラベル（観測回数に応じた段階表示）
const FAMILIARITY_TIERS = [
  { min: 300, label: "長期観察対象（データ蓄積は稀な域）" },
  { min: 100, label: "馴染みのある相手" },
  { min: 20,  label: "継続観察中" },
  { min: 0,   label: "初期観察段階" },
];

function familiarityLabel(messageCount) {
  return FAMILIARITY_TIERS.find(t => messageCount >= t.min).label;
}

class ProfileManager {
  constructor(characterName = "ドットーレ") {
    this.characterName = characterName;
    this.profiles = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(PROFILES_PATH)) {
        this.profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf-8"));
        // 旧フォーマット移行・新キー補完
        for (const p of Object.values(this.profiles)) {
          if (!p.userFields) { p.userFields = EMPTY_USER_FIELDS(); continue; }
          if ("status" in p.userFields) {
            if (!p.userFields.symptom && p.userFields.status) p.userFields.symptom = p.userFields.status;
            delete p.userFields.status;
          }
          // 新キーが未定義なら補完
          for (const key of Object.keys(EMPTY_USER_FIELDS())) {
            if (!(key in p.userFields)) p.userFields[key] = null;
          }
          if (!Array.isArray(p.botRecord?.milestonesReached)) {
            // 移行時点で既に超えているマイルストーンは「既読」扱いにし、
            // 遡って連続発火しないようにする
            const count = p.botRecord?.messageCount ?? 0;
            p.botRecord.milestonesReached = MILESTONES.filter(m => count >= m);
          }
        }
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
        userFields: EMPTY_USER_FIELDS(),
        botRecord: {
          firstSeen: now,
          lastSeen: now,
          messageCount: 0,
          survivalCount: 0,
          observation: null,
          milestonesReached: [],
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

  // 観測回数が新たなマイルストーンを超えていれば、その値を返す（一度きり）
  // 1回のチェックで複数のマイルストーンを同時に跨いだ場合（データ移行時のズレ等）は
  // 連続発火させず、黙って既読扱いにするだけに留める（自己修復）
  checkMilestone(userId) {
    const p = this.profiles[userId];
    if (!p) return null;
    const count = p.botRecord.messageCount;
    const reached = p.botRecord.milestonesReached ?? (p.botRecord.milestonesReached = []);
    const newlyCrossed = MILESTONES.filter(m => count >= m && !reached.includes(m));
    if (newlyCrossed.length === 0) return null;
    reached.push(...newlyCrossed);
    this.save();
    return newlyCrossed.length === 1 ? newlyCrossed[0] : null;
  }

  // 初観測からの経過日数
  getTenureDays(userId) {
    const p = this.profiles[userId];
    if (!p) return 0;
    const first = new Date(p.botRecord.firstSeen);
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    return Math.max(0, Math.floor((now - first) / (1000 * 60 * 60 * 24)));
  }

  // 連続日数ボーナス等、通常の発言回数以外の要因による関係進展の底上げ
  // （表示上の「観測回数」は改変せず、馴染み度・関係進展段階の算出にのみ加算する）
  addBonusCount(userId, amount) {
    const p = this.profiles[userId];
    if (!p) return;
    p.botRecord.bonusCount = (p.botRecord.bonusCount || 0) + amount;
    this.save();
  }

  onSurvival(userId) {
    const p = this.profiles[userId];
    if (p) { p.botRecord.survivalCount++; this.save(); }
  }

  // フィールドをセット（日本語キーで指定）
  setField(userId, rawField, value, displayName = "") {
    const p = this._getOrCreate(userId, displayName);
    const key = rawField.normalize("NFC").trim();
    const field = FIELD_MAP[key] ?? (Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) ? key : null);
    if (!field) return false;
    p.userFields[field] = value.trim();
    this.save();
    return true;
  }

  // フィールドをクリア
  clearField(userId, rawField) {
    const p = this.profiles[userId];
    if (!p) return false;
    const key = rawField.normalize("NFC").trim();
    const field = FIELD_MAP[key] ?? (Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) ? key : null);
    if (!field) return false;
    p.userFields[field] = null;
    this.save();
    return true;
  }

  // ドットーレの観察メモを更新
  setObservation(userId, text) {
    const p = this.profiles[userId];
    if (!p) return;
    p.botRecord.observation = text.trim();
    this.save();
  }

  // 記入欄をすべてリセット（観察記録は保持）
  resetUserFields(userId) {
    const p = this.profiles[userId];
    if (!p) return false;
    p.userFields = EMPTY_USER_FIELDS();
    this.save();
    return true;
  }

  // プロフィールシートを文字列で返す
  format(userId) {
    const p = this.profiles[userId];
    if (!p) return null;

    const isPantalone = this.characterName === "パンタローネ";
    const lines = [isPantalone
      ? `……「${p.displayName}」様の記録を開示いたします。\n`
      : `……被検体「${p.displayName}」の記録を開示する。\n`];

    lines.push("【識別情報】");
    lines.push(`ID: ${p.displayName}`);
    lines.push(`初観測: ${p.botRecord.firstSeen}`);
    lines.push(`最終観測: ${p.botRecord.lastSeen}`);

    lines.push(isPantalone ? "\n【ご記入欄】" : "\n【被検体記入欄】");
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
      lines.push(`${label}: ${p.userFields[field] ?? "未記入"}`);
    }

    lines.push(`\n【観察記録（${this.characterName}記入）】`);
    lines.push(`観測回数: ${p.botRecord.messageCount}回`);
    lines.push(`継続日数: ${this.getTenureDays(userId)}日`);
    lines.push(`馴染み度: ${familiarityLabel(p.botRecord.messageCount)}`);
    lines.push(`心配発言: ${p.botRecord.survivalCount > 0 ? `${p.botRecord.survivalCount}回検知` : "なし"}`);
    lines.push(`人物評価: ${p.botRecord.observation ?? (isPantalone ? "……まだ評価するだけの材料が揃っておりません。" : "……まだ観察データが不足している。")}`);

    lines.push("\n── 記入コマンド ──");
    lines.push("`!profile set 呼び名 [名前]`");
    lines.push("`!profile set 備考 [自由メモ]`");
    lines.push("\n※年齢・性別・趣味・症状・傾向・弱点は、プロフィールチャンネルへの投稿でのみ登録されます。");
    lines.push("　（例: `年齢：成人済み` のように1行ずつ書いて投稿してください）");

    return lines.join("\n");
  }

  // AI応答へのコンテキストヒント（systemHintに追記する用）
  getContextHint(userId) {
    const p = this.profiles[userId];
    if (!p) return "";
    const parts = [];
    if (p.userFields.name)     parts.push(`呼び名「${p.userFields.name}」`);
    if (p.userFields.age)      parts.push(`年齢「${p.userFields.age}」`);
    if (p.userFields.gender)   parts.push(`性別「${p.userFields.gender}」`);
    if (p.userFields.hobby)    parts.push(`趣味「${p.userFields.hobby}」`);
    if (p.userFields.symptom)  parts.push(`申告症状・状態「${p.userFields.symptom}」`);
    if (p.userFields.tendency) parts.push(`行動傾向「${p.userFields.tendency}」`);
    if (p.userFields.memo)     parts.push(`備考「${p.userFields.memo}」`);
    if (p.botRecord.survivalCount > 0) {
      parts.push(`${this.characterName}の生存を心配する発言${p.botRecord.survivalCount}回観測済み`);
    }

    // 年齢が未成年の場合は特別注記
    const ageNote = p.userFields.age && /未成年/.test(p.userFields.age)
      ? "この被検体は未成年である。不適切な表現・性的示唆・過度な暴力描写は一切行わないこと。"
      : "";

    // 弱点は別枠で明示（AI配慮指示として強調）
    const weaknessHint = p.userFields.weakness
      ? `この被検体の弱点・懸念事項として「${p.userFields.weakness}」が記録されている。この点には不用意に踏み込まず、観察・管理の観点から慎重に扱うこと。`
      : "";

    // ドットーレの観察メモ
    const observationHint = p.botRecord.observation
      ? `${this.characterName}による人物評価：「${p.botRecord.observation}」`
      : "";

    // 馴染み度に応じた「予測通りの対応を試す」実験的態度のヒント（優しさではなく観察行為として）
    // bonusCount は連続日数ボーナス等、発言回数以外の要因で加算される（表示上の観測回数とは別枠）
    const count = p.botRecord.messageCount + (p.botRecord.bonusCount || 0);
    const familiarityHint = count >= 300
      ? `この被検体は長期にわたり観測してきた対象だ（発言${count}回）。ごく稀に、要求通りの言葉・行動をあえてそのまま返し、相手の反応を観察する「予測通りの対応をした場合どうなるか」という実験を行ってよい。迎合ではなく観察者としての選択として扱うこと。頻発させず、通常は従来通り拒否・はぐらかしを基本とする。`
      : count >= 100
      ? `ある程度観測データが蓄積された被検体だ（発言${count}回）。ごく稀に、要求通りの対応を試験的に返し反応を見てもよい。基本は従来通り拒否・はぐらかしを優先する。`
      : "";

    // 汎用の関係進展段階（50回到達で段階1、以降40回ごとに+1）。
    // 具体的な意味づけはキャラクターごとのシステムプロンプト側に委ねる（未使用のキャラは無視してよい）。
    const intimacyStage = count < 50 ? 0 : 1 + Math.floor((count - 50) / 40);
    const intimacyStageHint = intimacyStage > 0
      ? `【関係進展段階】${intimacyStage}（会話${count}回）`
      : "";

    if (parts.length === 0 && !ageNote && !weaknessHint && !observationHint && !familiarityHint && !intimacyStageHint) return "";

    const baseHint = parts.length > 0 ? `【この被検体の記録】${parts.join("、")}。` : "";
    return [baseHint, observationHint, ageNote, weaknessHint, familiarityHint, intimacyStageHint].filter(Boolean).join("\n");
  }
}

module.exports = ProfileManager;
