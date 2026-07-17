import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

let data = {
  users: {},
  sessions: [],
  achievements: [],
  nextSessionId: 1,
};
let dbPath = "studybot-data.json";

function saveDb() {
  writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

export function initDatabase(filename = "studybot-data.json") {
  dbPath = resolve(process.cwd(), filename);
  if (existsSync(dbPath)) {
    try {
      data = JSON.parse(readFileSync(dbPath, "utf8"));
      data.users = data.users || {};
      data.sessions = data.sessions || [];
      data.achievements = data.achievements || [];
      data.nextSessionId = data.nextSessionId || 1;
    } catch (error) {
      data = { users: {}, sessions: [], achievements: [], nextSessionId: 1 };
    }
  }
  saveDb();
}

function getUserRow(discordId) {
  return data.users[discordId] || null;
}

export function ensureUser(discordId, username) {
  const row = getUserRow(discordId);
  if (row) {
    if (row.username !== username) {
      row.username = username;
      row.updated_at = Math.floor(Date.now() / 1000);
      saveDb();
    }
    return row;
  }
  data.users[discordId] = {
    discord_id: discordId,
    username,
    xp: 0,
    level: 1,
    total_seconds: 0,
    linked_main: null,
    updated_at: Math.floor(Date.now() / 1000),
  };
  saveDb();
  return data.users[discordId];
}

export function getUser(discordId) {
  return getUserRow(discordId);
}

export function getAccountFamily(discordId) {
  const own = getUserRow(discordId);
  if (!own) return null;
  if (own.linked_main) {
    const main = getUserRow(own.linked_main);
    return { memberType: "sub", main, sub: own };
  }
  const subs = Object.values(data.users).filter((user) => user.linked_main === discordId);
  return { memberType: "main", main: own, subs };
}

export function getActiveSession(discordId) {
  return data.sessions.find((session) => session.user_id === discordId && session.end_ts == null) || null;
}

export function getAnyActiveSession(discordId) {
  const family = getAccountFamily(discordId);
  if (!family) return null;
  if (family.memberType === "sub") {
    return getActiveSession(family.sub.discord_id) || getActiveSession(family.main.discord_id);
  }
  const activeMain = getActiveSession(family.main.discord_id);
  if (activeMain) return activeMain;
  return family.subs.find((sub) => getActiveSession(sub.discord_id)) || null;
}

export function startSession(discordId, note = null) {
  const session = {
    id: data.nextSessionId++,
    user_id: discordId,
    start_ts: Math.floor(Date.now() / 1000),
    end_ts: null,
    duration_seconds: null,
    note,
    created_at: Math.floor(Date.now() / 1000),
  };
  data.sessions.push(session);
  saveDb();
  return session;
}

export function stopSession(discordId) {
  const session = getActiveSession(discordId);
  if (!session) return null;
  const now = Math.floor(Date.now() / 1000);
  const seconds = now - session.start_ts;
  session.end_ts = now;
  session.duration_seconds = seconds;
  const user = getUserRow(discordId);
  if (user) {
    user.total_seconds += seconds;
    user.updated_at = now;
  }
  saveDb();
  return session;
}

export function editUserTime(discordId, secondsDelta, note = "edited by admin") {
  const row = getUserRow(discordId);
  if (!row) return null;
  row.total_seconds += secondsDelta;
  row.updated_at = Math.floor(Date.now() / 1000);
  data.sessions.push({
    id: data.nextSessionId++,
    user_id: discordId,
    start_ts: Math.floor(Date.now() / 1000),
    end_ts: Math.floor(Date.now() / 1000),
    duration_seconds: secondsDelta,
    note,
    created_at: Math.floor(Date.now() / 1000),
  });
  saveDb();
  return row;
}

export function getUserTotalSeconds(discordId) {
  const family = getAccountFamily(discordId);
  if (!family) return 0;
  if (family.memberType === "sub") {
    return 0;
  }
  return family.main.total_seconds + family.subs.reduce((sum, sub) => sum + sub.total_seconds, 0);
}

function getWeekStartTs(timestamp) {
  const date = new Date(timestamp * 1000);
  const day = date.getUTCDay();
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
  date.setUTCDate(diff);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function getWeeklySeconds(discordId) {
  const family = getAccountFamily(discordId);
  if (!family) return 0;
  if (family.memberType === "sub") return 0;
  const ids = [family.main.discord_id, ...family.subs.map((sub) => sub.discord_id)];
  const weekStart = getWeekStartTs(Math.floor(Date.now() / 1000));
  return data.sessions
    .filter((session) => session.end_ts && ids.includes(session.user_id) && session.end_ts >= weekStart)
    .reduce((sum, session) => sum + (session.duration_seconds || 0), 0);
}

export function getLeaderboard(limit = 10) {
  const aggregated = {};
  for (const user of Object.values(data.users)) {
    if (user.linked_main) continue;
    aggregated[user.discord_id] = {
      discord_id: user.discord_id,
      username: user.username,
      total_seconds: user.total_seconds,
    };
  }
  for (const user of Object.values(data.users)) {
    if (!user.linked_main) continue;
    const main = aggregated[user.linked_main];
    if (main) {
      main.total_seconds += user.total_seconds;
    }
  }
  return Object.values(aggregated)
    .sort((a, b) => b.total_seconds - a.total_seconds)
    .slice(0, limit)
    .map((user, index) => ({ position: index + 1, ...user }));
}

export function listAchievements(discordId) {
  return data.achievements.filter((item) => item.user_id === discordId);
}

export function unlockAchievement(discordId, key, name, description) {
  if (data.achievements.some((item) => item.user_id === discordId && item.key === key)) {
    return false;
  }
  data.achievements.push({ user_id: discordId, key, name, description, unlocked_at: Math.floor(Date.now() / 1000) });
  saveDb();
  return true;
}

export function addXp(discordId, xp) {
  const row = getUserRow(discordId);
  if (!row) return null;
  row.xp += xp;
  row.level = Math.max(1, Math.floor(Math.sqrt(row.xp / 50)) + 1);
  row.updated_at = Math.floor(Date.now() / 1000);
  saveDb();
  return { xp: row.xp, level: row.level };
}

export function getSessionsForChart(discordId, days = 14) {
  const family = getAccountFamily(discordId);
  if (!family) return [];
  if (family.memberType === "sub") return [];
  const now = Math.floor(Date.now() / 1000);
  const earliest = now - days * 86400;
  const ids = [family.main.discord_id, ...family.subs.map((sub) => sub.discord_id)];
  const totals = {};
  for (const session of data.sessions) {
    if (!ids.includes(session.user_id)) continue;
    if (!session.end_ts || session.end_ts < earliest) continue;
    const day = new Date(session.end_ts * 1000).toISOString().slice(0, 10);
    totals[day] = (totals[day] || 0) + (session.duration_seconds || 0);
  }
  return Object.entries(totals).map(([day, total_seconds]) => ({ day, total_seconds }));
}

export function getTitleForWeeklySeconds(seconds) {
  if (seconds >= 120 * 3600) return "伝説の学習者";
  if (seconds >= 96 * 3600) return "プラチナ学習者";
  if (seconds >= 72 * 3600) return "ゴールド学習者";
  if (seconds >= 48 * 3600) return "シルバー学習者";
  if (seconds >= 24 * 3600) return "ブロンズ学習者";
  return "チャレンジャー";
}

export function linkSubAccount(mainId, subId) {
  if (mainId === subId) return false;
  const main = getUserRow(mainId);
  const sub = getUserRow(subId);
  if (!main || !sub) return false;
  if (sub.linked_main) return false;
  if (main.linked_main) return false;
  sub.linked_main = mainId;
  saveDb();
  return true;
}

export function unlinkSubAccount(subId) {
  const sub = getUserRow(subId);
  if (!sub || !sub.linked_main) return false;
  sub.linked_main = null;
  saveDb();
  return true;
}

export function getAchievementsToUnlock(totalSeconds) {
  const achievements = [];
  if (totalSeconds >= 3600) achievements.push(["first_hour", "最初の1時間", "学習1時間達成！"]);
  if (totalSeconds >= 36000) achievements.push(["ten_hours", "10時間突破", "学習10時間達成！"]);
  if (totalSeconds >= 86400) achievements.push(["one_day", "24時間学習", "学習24時間突破！"]);
  if (totalSeconds >= 360000) achievements.push(["hundred_hours", "100時間達成", "学習100時間突破！"]);
  return achievements;
}

export function awardSessionXpAndAchievements(discordId, durationSeconds) {
  const earnedXp = Math.max(1, Math.floor(durationSeconds / 300)) + 5;
  const result = addXp(discordId, earnedXp);
  const totalSeconds = getUserTotalSeconds(discordId);
  const unlocks = getAchievementsToUnlock(totalSeconds);
  const unlocked = [];
  for (const [key, name, description] of unlocks) {
    if (unlockAchievement(discordId, key, name, description)) {
      unlocked.push({ key, name, description });
    }
  }
  return { earnedXp, xp: result?.xp ?? 0, level: result?.level ?? 1, unlocked };
}
