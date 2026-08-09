// status-manager.js
// 「普段やってること」＋気分・感情・体調が具体的な行動を左右する、という推測に基づく
// ドットーレ／パンタローネの日々のステータス。プロフィールと違いユーザーごとではなく
// キャラクター1体につき1状態（dottore-server-a/bはデフォルトで同じファイルを共有し、
// 同一人物として一貫した状態になる。詳細は他ファイルの *_FILE 環境変数と同じ方式）。
const fs = require("fs");
const path = require("path");

const STATUS_PATH = process.env.STATUS_FILE
  ? path.resolve(__dirname, process.env.STATUS_FILE)
  : path.join(__dirname, "bot-status.json");

// 1日3回（9/15/21時JST）の定時チェックで「やること」を選び直す
const TICK_HOURS = [9, 15, 21];

// キャラクターごとの「やること」8パターン。type はストレス・集中度の増減方向づけに使う
// （labor=仕事寄りで上がる、rest=休息寄りで下がる）
const ACTIVITY_POOL = {
  "ドットーレ": [
    { name: "実験中", type: "labor" },
    { name: "経費明細書作成中", type: "labor" },
    { name: "論文執筆中", type: "labor" },
    { name: "被検体データ整理中", type: "labor" },
    { name: "装置の調整中", type: "labor" },
    { name: "休憩中", type: "rest" },
    { name: "睡眠中", type: "rest" },
    { name: "食事中", type: "rest" },
  ],
  "パンタローネ": [
    { name: "経費明細書の承認中", type: "labor" },
    { name: "資産運用の検討中", type: "labor" },
    { name: "契約書の確認中", type: "labor" },
    { name: "商談帰り", type: "rest" },
    { name: "飲酒中", type: "rest" },
    { name: "喫煙中", type: "rest" },
    { name: "睡眠中", type: "rest" },
    { name: "食事中", type: "rest" },
  ],
};

const EMOTION_POOL = {
  "ドットーレ": ["無関心", "苛立ち", "興味", "満足", "高揚", "倦怠"],
  "パンタローネ": ["平静", "上機嫌", "苛立ち", "警戒", "愉悦", "退屈"],
};

const MOOD_LABELS = ["悪い", "普通", "良い"];

function jstDateStr() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function gaugeLabel(v, labels) {
  for (const l of labels) if (v <= l.max) return l.text;
  return labels[labels.length - 1].text;
}

const HUNGER_LABELS = [
  { max: 0,  text: "空腹の限界" }, { max: 3,  text: "小腹が空いている" },
  { max: 6,  text: "普通" },       { max: 9,  text: "満たされている" }, { max: 10, text: "満腹" },
];
const STAMINA_LABELS = [
  { max: 0,  text: "限界（睡眠が必要）" }, { max: 3,  text: "疲労気味" },
  { max: 6,  text: "普通" },               { max: 9,  text: "元気" }, { max: 10, text: "絶好調" },
];
const SLEEPINESS_LABELS = [
  { max: 1,  text: "覚醒している" }, { max: 4,  text: "普通" },
  { max: 7,  text: "やや眠い" },     { max: 10, text: "強い眠気" },
];
const STRESS_LABELS = [
  { max: 2,  text: "リラックスしている" }, { max: 5,  text: "普通" },
  { max: 7,  text: "やや張り詰めている" }, { max: 10, text: "強いストレス下" },
];
const FOCUS_LABELS = [
  { max: 2,  text: "散漫" },         { max: 5,  text: "普通" },
  { max: 7,  text: "集中している" }, { max: 10, text: "極めて集中している" },
];

class StatusManager {
  constructor(characterName = "ドットーレ") {
    this.characterName = characterName;
    this.activities = ACTIVITY_POOL[characterName] ?? ACTIVITY_POOL["ドットーレ"];
    this.emotions = EMOTION_POOL[characterName] ?? EMOTION_POOL["ドットーレ"];
    this.state = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(STATUS_PATH)) {
        this.state = JSON.parse(fs.readFileSync(STATUS_PATH, "utf-8"));
      }
    } catch (err) {
      console.error("[Status] 読み込み失敗:", err.message);
    }
    if (!this.state) this.state = this._initState();
  }

  save() {
    try {
      fs.writeFileSync(STATUS_PATH, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      console.error("[Status] 保存失敗:", err.message);
    }
  }

  _initState() {
    const laborActivities = this.activities.filter(a => a.type === "labor");
    return {
      mood: 1,
      emotion: pick(this.emotions),
      activity: pick(laborActivities).name,
      hunger: randInt(6, 9),
      stamina: randInt(6, 9),
      sleepiness: randInt(0, 2),
      stress: randInt(2, 4),
      focus: randInt(4, 6),
      lastTickKey: null,
    };
  }

  // 1日3回（TICK_HOURS）の定時チェックから呼ぶ。dottore-server-a/bは同じ状態ファイルを
  // 共有しているため、同じ時間帯に両方から呼ばれても二重更新にならないよう鍵で防ぐ。
  tick(hour) {
    const key = `${jstDateStr()}-${hour}`;
    if (this.state.lastTickKey === key) return;
    this.state.lastTickKey = key;

    const s = this.state;

    // 機嫌・感情：変化は緩め（毎回ではなく、たまに1段階／1種類だけ動く）
    if (Math.random() < 0.35) s.mood = clamp(s.mood + (Math.random() < 0.5 ? -1 : 1), 0, 2);
    if (Math.random() < 0.35) s.emotion = pick(this.emotions.filter(e => e !== s.emotion));

    // 空腹度・体力：時間経過で減っていく。0だったターンは食事／睡眠を取って回復する。
    const ate = s.hunger <= 0;
    const slept = s.stamina <= 0;
    s.hunger = ate ? randInt(7, 10) : clamp(s.hunger - randInt(2, 4), 0, 10);
    s.stamina = slept ? randInt(7, 10) : clamp(s.stamina - randInt(2, 4), 0, 10);
    if (slept) s.sleepiness = 0;

    // やること：睡眠・食事が最優先。それ以外は8パターンからランダムに選定
    if (slept) {
      s.activity = this.activities.find(a => a.name === "睡眠中")?.name ?? this.activities[0].name;
    } else if (ate) {
      s.activity = this.activities.find(a => a.name === "食事中")?.name ?? this.activities[0].name;
    } else {
      s.activity = pick(this.activities).name;
    }

    // 眠気：夜（21時チェック）ほど溜まりやすく、朝（9時チェック）に大きく回復する
    if (!slept) {
      const drift = hour === 21 ? randInt(1, 3) : hour === 9 ? -randInt(1, 3) : randInt(-1, 1);
      s.sleepiness = clamp(s.sleepiness + drift, 0, 10);
    }

    // ストレス・集中度：選ばれた「やること」が仕事寄りか休息寄りかで増減
    const activityType = this.activities.find(a => a.name === s.activity)?.type ?? "rest";
    const delta = activityType === "labor" ? randInt(1, 2) : -randInt(1, 2);
    s.stress = clamp(s.stress + delta, 0, 10);
    s.focus = clamp(s.focus + delta, 0, 10);

    this.save();
  }

  // AIへのシステムヒントとして注入する自然文
  getHint() {
    const s = this.state;
    return (
      `【${this.characterName}の現在の状態（会話の背景として自然に滲ませること。数値や「ステータス」という言葉自体を持ち出したり、逐一自己申告したりはしない）】\n` +
      `機嫌：${MOOD_LABELS[s.mood]}\n` +
      `感情：${s.emotion}\n` +
      `やること：${s.activity}\n` +
      `空腹度：${gaugeLabel(s.hunger, HUNGER_LABELS)}\n` +
      `体力：${gaugeLabel(s.stamina, STAMINA_LABELS)}\n` +
      `眠気：${gaugeLabel(s.sleepiness, SLEEPINESS_LABELS)}\n` +
      `集中度：${gaugeLabel(s.focus, FOCUS_LABELS)}\n` +
      `ストレス：${gaugeLabel(s.stress, STRESS_LABELS)}`
    );
  }

  // !status コマンド表示用
  format() {
    const s = this.state;
    const isPantalone = this.characterName === "パンタローネ";
    return [
      isPantalone ? "……現在の状態を開示いたします。" : "……現在の状態を開示する。",
      "",
      `機嫌：${MOOD_LABELS[s.mood]}`,
      `感情：${s.emotion}`,
      `やること：${s.activity}`,
      `空腹度：${gaugeLabel(s.hunger, HUNGER_LABELS)}`,
      `体力：${gaugeLabel(s.stamina, STAMINA_LABELS)}`,
      `眠気：${gaugeLabel(s.sleepiness, SLEEPINESS_LABELS)}`,
      `集中度：${gaugeLabel(s.focus, FOCUS_LABELS)}`,
      `ストレス：${gaugeLabel(s.stress, STRESS_LABELS)}`,
    ].join("\n");
  }
}

StatusManager.TICK_HOURS = TICK_HOURS;
module.exports = StatusManager;
