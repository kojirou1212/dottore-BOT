// daily-streak.js
// パンタローネ・博士の「両方」に同じ日に話しかけてくれたユーザーの連続日数を追跡する。
// 他のデータファイルとは逆に、キャラごとの分離をせず意図的に1ファイルを
// dottore-server-a / dottore-server-b / pantalone-server の3プロセスで共有する
// （どちらにも同日中に話したかどうかは、片方のプロセスだけでは判定できないため）。
const fs = require("fs");
const path = require("path");

const STREAK_PATH = path.join(__dirname, "daily-streak.json");

const MILESTONES = [3, 7, 14, 30, 60, 100];

// JSTは夏時間なしなので固定+9時間で扱ってよい
function jstDateStr(offsetDays = 0) {
  const t = Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

function load() {
  try {
    if (fs.existsSync(STREAK_PATH)) {
      return JSON.parse(fs.readFileSync(STREAK_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("[DailyStreak] 読み込み失敗:", err.message);
  }
  return {};
}

function save(data) {
  try {
    fs.writeFileSync(STREAK_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[DailyStreak] 保存失敗:", err.message);
  }
}

// character: "dottore" | "pantalone"
// 戻り値：その日、両方への連続日数が新たなマイルストーンへ到達していればその日数。それ以外は null。
function recordContact(userId, character) {
  const data = load();
  const today = jstDateStr();
  const yesterday = jstDateStr(-1);

  const entry = data[userId] ?? { dottore: null, pantalone: null, streak: 0, streakDate: null, lastMilestone: 0 };
  entry[character] = today;

  let milestone = null;
  if (entry.dottore === today && entry.pantalone === today && entry.streakDate !== today) {
    entry.streak = entry.streakDate === yesterday ? entry.streak + 1 : 1;
    entry.streakDate = today;
    if (MILESTONES.includes(entry.streak) && entry.lastMilestone !== entry.streak) {
      milestone = entry.streak;
      entry.lastMilestone = entry.streak;
    }
  }

  data[userId] = entry;
  save(data);
  return milestone;
}

module.exports = { recordContact, MILESTONES };
