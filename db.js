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
  const legacyPath = resolve(process.cwd(), "studybot.sqlite");

  if (!existsSync(dbPath) && filename === "studybot-data.json" && existsSync(legacyPath)) {
    console.warn(`Database file ${dbPath} not found. Falling back to legacy database file ${legacyPath}.`);
    dbPath = legacyPath;
  }

  if (existsSync(dbPath)) {
    try {
      const raw = readFileSync(dbPath, "utf8");
      data = JSON.parse(raw);
      data.users = data.users || {};
      data.sessions = data.sessions || [];
      data.achievements = data.achievements || [];
      data.nextSessionId = data.nextSessionId || 1;

      if (
        filename === "studybot-data.json" &&
        dbPath === resolve(process.cwd(), "studybot-data.json") &&
        Object.keys(data.users).length === 0 &&
        data.sessions.length === 0 &&
        data.achievements.length === 0 &&
        existsSync(legacyPath)
      ) {
        const legacyRaw = readFileSync(legacyPath, "utf8");
        const legacyData = JSON.parse(legacyRaw);
        if (
          legacyData &&
          Object.keys(legacyData.users || {}).length > 0 ||
          (legacyData.sessions || []).length > 0 ||
          (legacyData.achievements || []).length > 0
        ) {
          console.warn(`Default database file ${dbPath} is empty. Loading legacy database ${legacyPath} instead.`);
          dbPath = legacyPath;
          data = legacyData;
          data.users = data.users || {};
          data.sessions = data.sessions || [];
          data.achievements = data.achievements || [];
          data.nextSessionId = data.nextSessionId || 1;
        }
      }
    } catch (error) {
      console.error(`Failed to parse database file at ${dbPath}: ${error.message}`);
      console.error("DATABASE_FILE must point to a valid JSON database file.");
      process.exit(1);
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

function sessionMatchesGuild(session, guildId) {
  if (!guildId) return true;
  return session.guild_id === guildId || session.guild_id == null;
}

function getFamilyIds(discordId) {
  const family = getAccountFamily(discordId);
  if (!family) return [discordId];
  if (family.memberType === "sub") {
    return [family.main.discord_id, family.sub.discord_id];
  }
  return [family.main.discord_id, ...family.subs.map((sub) => sub.discord_id)];
}

function sumSessions(userIds, options = {}) {
  const { guildId = null, startTs = 0 } = options;
  return data.sessions
    .filter((session) =>
      userIds.includes(session.user_id) &&
      session.end_ts &&
      session.end_ts >= startTs &&
      sessionMatchesGuild(session, guildId)
    )
    .reduce((sum, session) => sum + (session.duration_seconds || 0), 0);
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

export function startSession(discordId, guildId = null, note = null) {
  const session = {
    id: data.nextSessionId++,
    user_id: discordId,
    guild_id: guildId,
    start_ts: Math.floor(Date.now() / 1000),
    end_ts: null,
    duration_seconds: null,
    accumulated_seconds: 0,
    paused_at: null,
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
  let seconds = session.accumulated_seconds || 0;
  if (session.paused_at == null) {
    seconds += now - session.start_ts;
  }
  session.end_ts = now;
  session.duration_seconds = seconds;
  session.accumulated_seconds = seconds;
  session.paused_at = null;
  const user = getUserRow(discordId);
  if (user) {
    user.total_seconds += seconds;
    user.updated_at = now;
  }
  saveDb();
  return session;
}

export function pauseSession(discordId) {
  const session = getActiveSession(discordId);
  if (!session || session.paused_at != null) return null;
  const now = Math.floor(Date.now() / 1000);
  session.accumulated_seconds = (session.accumulated_seconds || 0) + (now - session.start_ts);
  session.paused_at = now;
  saveDb();
  return session;
}

export function resumeSession(discordId) {
  const session = getActiveSession(discordId);
  if (!session || session.paused_at == null) return null;
  session.start_ts = Math.floor(Date.now() / 1000);
  session.paused_at = null;
  saveDb();
  return session;
}

export function getSessionElapsedSeconds(session) {
  if (!session) return 0;
  const base = session.accumulated_seconds || 0;
  if (session.paused_at != null) return base;
  return base + (Math.floor(Date.now() / 1000) - session.start_ts);
}

export function editUserTime(discordId, secondsDelta, note = "edited by admin", guildId = null) {
  const row = getUserRow(discordId);
  if (!row) return null;
  row.total_seconds += secondsDelta;
  row.updated_at = Math.floor(Date.now() / 1000);
  data.sessions.push({
    id: data.nextSessionId++,
    user_id: discordId,
    guild_id: guildId,
    start_ts: Math.floor(Date.now() / 1000),
    end_ts: Math.floor(Date.now() / 1000),
    duration_seconds: secondsDelta,
    note,
    created_at: Math.floor(Date.now() / 1000),
  });
  saveDb();
  return row;
}

export function getUserTotalSeconds(discordId, guildId = null) {
  const ids = getFamilyIds(discordId);
  return sumSessions(ids, { guildId });
}

function getWeekStartTs(timestamp) {
  const date = new Date(timestamp * 1000);
  const day = date.getUTCDay();
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
  date.setUTCDate(diff);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function getWeeklySeconds(discordId, guildId = null) {
  const ids = getFamilyIds(discordId);
  const weekStart = getWeekStartTs(Math.floor(Date.now() / 1000));
  return sumSessions(ids, { guildId, startTs: weekStart });
}

export function getLeaderboard(limit = 10, guildId = null) {
  const aggregated = [];
  const mainUsers = Object.values(data.users).filter((user) => !user.linked_main);
  for (const user of mainUsers) {
    const subs = Object.values(data.users).filter((sub) => sub.linked_main === user.discord_id);
    const ids = [user.discord_id, ...subs.map((sub) => sub.discord_id)];
    aggregated.push({
      discord_id: user.discord_id,
      username: user.username,
      total_seconds: sumSessions(ids, { guildId }),
    });
  }
  return aggregated
    .sort((a, b) => b.total_seconds - a.total_seconds)
    .slice(0, limit)
    .map((user, index) => ({ position: index + 1, ...user }));
}

export function listAchievements(discordId, guildId = null) {
  return data.achievements.filter((item) => item.user_id === discordId && (guildId ? item.guild_id === guildId || item.guild_id == null : true));
}

export function unlockAchievement(discordId, key, name, description, guildId = null) {
  if (data.achievements.some((item) => item.user_id === discordId && item.key === key && item.guild_id === guildId)) {
    return false;
  }
  data.achievements.push({ user_id: discordId, key, name, description, guild_id: guildId, unlocked_at: Math.floor(Date.now() / 1000) });
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

export function getSessionsForChart(discordId, days = 14, guildId = null) {
  const ids = getFamilyIds(discordId);
  const now = Math.floor(Date.now() / 1000);
  const earliest = now - days * 86400;
  const totals = {};
  for (const session of data.sessions) {
    if (!ids.includes(session.user_id)) continue;
    if (!session.end_ts || session.end_ts < earliest) continue;
    if (!sessionMatchesGuild(session, guildId)) continue;
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

export function awardSessionXpAndAchievements(discordId, durationSeconds, guildId = null) {
  const earnedXp = Math.max(1, Math.floor(durationSeconds / 300)) + 5;
  const result = addXp(discordId, earnedXp);
  const totalSeconds = getUserTotalSeconds(discordId, guildId);
  const unlocks = getAchievementsToUnlock(totalSeconds);
  const unlocked = [];
  for (const [key, name, description] of unlocks) {
    if (unlockAchievement(discordId, key, name, description, guildId)) {
      unlocked.push({ key, name, description });
    }
  }
  return { earnedXp, xp: result?.xp ?? 0, level: result?.level ?? 1, unlocked };
}
