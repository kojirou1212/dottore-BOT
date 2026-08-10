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

// 「やること」のランダム選定用の定時チェック（食事・就寝とは別枠）
const ACTIVITY_TICK_HOURS = [9, 15, 21];

// キャラクターごとの食事時刻（JST時）。この時刻は空腹度に関わらず必ず食事を取る「ルーティン」になる。
const MEAL_HOURS = {
  "ドットーレ":   { breakfast: 8, lunch: 14, dinner: 21 },
  "パンタローネ": { breakfast: 7, lunch: 12, dinner: 19 },
};

// キャラクターごとの就寝時刻（JST時。24:00は0時として扱う）。
// 体力切れでこれより早く寝ることはあるが、これより遅くまで起きていることはない上限。
const BEDTIME_HOUR = {
  "ドットーレ":   3,
  "パンタローネ": 0,
};

// キャラクターごとの「やること」パターン。
// type はストレス・集中度の増減方向づけに使う（labor=仕事寄りで上がる、rest=休息寄りで下がる）。
// hours はランダム選定の対象になり得る時間帯（ACTIVITY_TICK_HOURSのサブセット）。
// auto:true の項目（睡眠中・朝食中/昼食中/夕食中）はランダム抽選の対象にせず、
// 就寝時刻・食事時刻という完全に固定のルーティンとしてのみ選ばれる（体力・空腹度による早期発生はしない）。
// meal: "breakfast"|"lunch"|"dinner" は、どの食事時刻に対応するかを示す。
function buildActivityPool(characterName, laborRestList) {
  const meals = MEAL_HOURS[characterName] ?? MEAL_HOURS["ドットーレ"];
  const bedtime = BEDTIME_HOUR[characterName] ?? BEDTIME_HOUR["ドットーレ"];
  return [
    ...laborRestList,
    { name: "朝食中", type: "rest", hours: [meals.breakfast], auto: true, meal: "breakfast" },
    { name: "昼食中", type: "rest", hours: [meals.lunch],     auto: true, meal: "lunch" },
    { name: "夕食中", type: "rest", hours: [meals.dinner],    auto: true, meal: "dinner" },
    { name: "睡眠中", type: "rest", hours: [bedtime],         auto: true, sleep: true },
  ];
}

const ACTIVITY_POOL = {
  "ドットーレ": buildActivityPool("ドットーレ", [
    { name: "実験中",                 type: "labor", hours: [9, 15, 21] },
    { name: "経費明細書作成中",       type: "labor", hours: [9, 15] },
    { name: "論文執筆中",             type: "labor", hours: [15, 21] },
    { name: "被検体データ整理中",     type: "labor", hours: [9, 15, 21] },
    { name: "装置の調整中",           type: "labor", hours: [9, 15] },
    { name: "解剖記録の作成中",       type: "labor", hours: [9, 15] },
    { name: "培養槽の点検中",         type: "labor", hours: [9, 15, 21] },
    { name: "新種の合成実験中",       type: "labor", hours: [9, 15, 21] },
    { name: "被検体の選定中",         type: "labor", hours: [9, 15] },
    { name: "上層部への報告書作成中", type: "labor", hours: [9, 15] },
    { name: "実験動物の観察",         type: "labor", hours: [9, 15] },
    { name: "部下への指示出し中",     type: "labor", hours: [9, 15] },
    { name: "過去のデータ再検証中",   type: "labor", hours: [15, 21] },
    { name: "薬品の調合中",           type: "labor", hours: [9, 15, 21] },
    { name: "顕微鏡での観察中",       type: "labor", hours: [9, 15, 21] },
    { name: "論文の査読中",           type: "labor", hours: [15, 21] },
    { name: "機材の発注手続き中",     type: "labor", hours: [9, 15] },
    { name: "標本の保存処理中",       type: "labor", hours: [9, 15] },
    { name: "資料への目通し中",       type: "labor", hours: [9, 15, 21] },
    { name: "苛立たしげに書類へ署名中", type: "labor", hours: [9, 15] },
    { name: "新たな被検体候補の物色中", type: "labor", hours: [15, 21] },
    { name: "休憩中",                 type: "rest",  hours: [9, 15, 21] },
    { name: "読書中",                 type: "rest",  hours: [15, 21] },
    { name: "散歩中",                 type: "rest",  hours: [9, 15] },
    { name: "コーヒーを飲んでいる",   type: "rest",  hours: [9, 15, 21] },
    { name: "仮眠中",                 type: "rest",  hours: [15, 21] },
  ]),
  "パンタローネ": buildActivityPool("パンタローネ", [
    { name: "経費明細書の承認中",     type: "labor", hours: [9, 15] },
    { name: "資産運用の検討中",       type: "labor", hours: [9, 15, 21] },
    { name: "契約書の確認中",         type: "labor", hours: [9, 15] },
    { name: "帳簿の照合中",           type: "labor", hours: [9, 15] },
    { name: "為替相場の確認中",       type: "labor", hours: [9, 15, 21] },
    { name: "新規融資案件の審査中",   type: "labor", hours: [9, 15] },
    { name: "株主総会の資料作成中",   type: "labor", hours: [9, 15] },
    { name: "投資家との電話対応中",   type: "labor", hours: [9, 15] },
    { name: "北国の銀行への報告書作成中", type: "labor", hours: [15, 21] },
    { name: "部下からの報告を受けている", type: "labor", hours: [9, 15] },
    { name: "商談の準備中",           type: "labor", hours: [9, 15] },
    { name: "契約条件の再交渉中",     type: "labor", hours: [9, 15, 21] },
    { name: "資産価値の査定中",       type: "labor", hours: [9, 15, 21] },
    { name: "顧客名簿の整理中",       type: "labor", hours: [15, 21] },
    { name: "手紙の返信中",           type: "labor", hours: [9, 15, 21] },
    { name: "会議に出席中",           type: "labor", hours: [9, 15] },
    { name: "手帳にメモを取っている", type: "labor", hours: [9, 15, 21] },
    { name: "商談帰り",               type: "rest",  hours: [15, 21] },
    { name: "飲酒中",                 type: "rest",  hours: [21] },
    { name: "喫煙中",                 type: "rest",  hours: [9, 15, 21] },
    { name: "仕立て直しの相談中",     type: "rest",  hours: [15, 21] },
    { name: "高級レストランでの会食中", type: "rest",  hours: [21] },
    { name: "腕時計の手入れ中",       type: "rest",  hours: [9, 15, 21] },
    { name: "読書中",                 type: "rest",  hours: [15, 21] },
    { name: "散歩中",                 type: "rest",  hours: [9, 15] },
    { name: "紅茶を飲んでいる",       type: "rest",  hours: [9, 15, 21] },
  ]),
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
function uniqueSorted(arr) { return [...new Set(arr)].sort((a, b) => a - b); }

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
    this.mealHours = MEAL_HOURS[characterName] ?? MEAL_HOURS["ドットーレ"];
    this.bedtimeHour = BEDTIME_HOUR[characterName] ?? BEDTIME_HOUR["ドットーレ"];
    // このキャラが定時チェックの対象になる時刻（やることの抽選 + 食事3回 + 就寝1回、重複除去）
    this.tickHours = uniqueSorted([
      ...ACTIVITY_TICK_HOURS,
      this.mealHours.breakfast, this.mealHours.lunch, this.mealHours.dinner,
      this.bedtimeHour,
    ]);
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
    const laborActivities = this.activities.filter(a => a.type === "labor" && !a.auto);
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

  // this.tickHours に含まれる時刻の定時チェックから呼ぶ。
  // 状態はファイルに永続化され、この鍵（日付+時刻）で二重更新を防ぐため、
  // pm2再起動を挟んでも同じ時刻に再度tickが走るだけで内容は変わらない
  // （＝就寝中に再起動しても、次の定時チェック時刻が来るまでステータスは一切変化しない）。
  // dottore-server-a/bが同じ状態ファイルを共有している場合の二重更新防止も兼ねる。
  tick(hour) {
    const key = `${jstDateStr()}-${hour}`;
    if (this.state.lastTickKey === key) return;
    this.state.lastTickKey = key;

    const s = this.state;

    // 機嫌・感情：変化は緩め（毎回ではなく、たまに1段階／1種類だけ動く）
    if (Math.random() < 0.35) s.mood = clamp(s.mood + (Math.random() < 0.5 ? -1 : 1), 0, 2);
    if (Math.random() < 0.35) s.emotion = pick(this.emotions.filter(e => e !== s.emotion));

    // 就寝：就寝時刻（固定）に達したら体力に関わらず必ず寝る、完全なルーティン。
    // 体力が0になっても就寝時刻でなければ寝ない（ランダム/突発的な就寝はしない）。
    const isBedtime = hour === this.bedtimeHour;
    const slept = isBedtime;

    // 食事：朝食・昼食・夕食の時刻は空腹度に関わらず必ず食事を取る、完全なルーティン。
    // それ以外の時刻では、空腹度が0になっても食事は発生しない（ランダム/突発的な食事はしない）。
    const mealEntry = this.activities.find(a => a.meal && a.hours[0] === hour);
    const ate = !slept && mealEntry != null;

    s.hunger = ate ? randInt(7, 10) : clamp(s.hunger - randInt(2, 4), 0, 10);
    s.stamina = slept ? randInt(7, 10) : clamp(s.stamina - randInt(2, 4), 0, 10);
    if (slept) s.sleepiness = 0;

    if (slept) {
      s.activity = this.activities.find(a => a.sleep)?.name ?? this.activities[0].name;
    } else if (ate) {
      s.activity = mealEntry?.name ?? this.activities.find(a => a.meal)?.name ?? this.activities[0].name;
    } else {
      const candidates = this.activities.filter(a => !a.auto && a.hours.includes(hour));
      const pool = candidates.length > 0 ? candidates : this.activities.filter(a => !a.auto);
      s.activity = pick(pool).name;
    }

    // 眠気：朝食の時刻に大きく回復し、それ以外は少しずつ溜まっていく（就寝時は0にリセット済み）
    if (!slept) {
      const isWake = hour === this.mealHours.breakfast;
      const drift = isWake ? -randInt(2, 4) : randInt(0, 2);
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

module.exports = StatusManager;
