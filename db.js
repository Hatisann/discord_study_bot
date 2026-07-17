import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import initSqlJs from "sql.js";

const SQL = await initSqlJs({
  locateFile: (filename) => new URL(`./node_modules/sql.js/dist/${filename}`, import.meta.url).href,
});

let data = {
  users: {},
  sessions: [],
  achievements: [],
  nextSessionId: 1,
};
let dbPath = "studybot-data.json";
let sqliteDb = null;
let useSqlite = false;

function saveDb() {
  if (useSqlite) return;
  writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

function saveSqlite() {
  const bytes = sqliteDb.export();
  writeFileSync(dbPath, Buffer.from(bytes));
}

function normalizeSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    guild_id: row.guild_id,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    duration_seconds: row.duration_seconds,
    accumulated_seconds: row.accumulated_seconds,
    paused_at: row.paused_at,
    note: row.note,
    created_at: row.created_at,
  };
}

function initSqliteSchema() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      xp INTEGER NOT NULL,
      level INTEGER NOT NULL,
      total_seconds INTEGER NOT NULL,
      linked_main TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      guild_id TEXT,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER,
      duration_seconds INTEGER,
      accumulated_seconds INTEGER NOT NULL,
      paused_at INTEGER,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      guild_id TEXT,
      unlocked_at INTEGER NOT NULL,
      UNIQUE(user_id, key, guild_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(end_ts);
    CREATE INDEX IF NOT EXISTS idx_users_linked_main ON users(linked_main);
  `);
}

function migrateJsonToSqlite(legacyData) {
  const insertUser = sqliteDb.prepare(`
    INSERT OR REPLACE INTO users (discord_id, username, xp, level, total_seconds, linked_main, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSession = sqliteDb.prepare(`
    INSERT INTO sessions (id, user_id, guild_id, start_ts, end_ts, duration_seconds, accumulated_seconds, paused_at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAchievement = sqliteDb.prepare(`
    INSERT OR IGNORE INTO achievements (user_id, key, name, description, guild_id, unlocked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  sqliteDb.exec("BEGIN;");
  for (const user of Object.values(legacyData.users || {})) {
    insertUser.run([
      user.discord_id,
      user.username,
      user.xp ?? 0,
      user.level ?? 1,
      user.total_seconds ?? 0,
      user.linked_main ?? null,
      user.updated_at ?? Math.floor(Date.now() / 1000),
    ]);
  }
  for (const session of legacyData.sessions || []) {
    insertSession.run([
      session.id,
      session.user_id,
      session.guild_id ?? null,
      session.start_ts,
      session.end_ts ?? null,
      session.duration_seconds ?? null,
      session.accumulated_seconds ?? 0,
      session.paused_at ?? null,
      session.note ?? null,
      session.created_at,
    ]);
  }
  for (const achievement of legacyData.achievements || []) {
    insertAchievement.run([
      achievement.user_id,
      achievement.key,
      achievement.name,
      achievement.description,
      achievement.guild_id ?? null,
      achievement.unlocked_at,
    ]);
  }
  sqliteDb.exec("COMMIT;");
}

function openSqliteDatabase(path) {
  let legacyData = null;
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    const firstChar = raw.trimStart().slice(0, 1);
    if (firstChar === "{") {
      const backupPath = `${path}.legacy.json`;
      writeFileSync(backupPath, raw, "utf8");
      legacyData = JSON.parse(raw);
      unlinkSync(path);
    }
  }

  if (existsSync(path)) {
    const bytes = new Uint8Array(readFileSync(path));
    sqliteDb = new SQL.Database(bytes);
  } else {
    sqliteDb = new SQL.Database();
  }
  initSqliteSchema();
  if (legacyData) {
    migrateJsonToSqlite(legacyData);
    saveSqlite();
  }
}

export function initDatabase(filename = "studybot-data.json") {
  const defaultJsonPath = resolve(process.cwd(), "studybot-data.json");
  const legacyPath = resolve(process.cwd(), "studybot.sqlite");
  dbPath = resolve(process.cwd(), filename);
  useSqlite = dbPath.endsWith(".sqlite");

  if (useSqlite) {
    if (!existsSync(dbPath) && existsSync(defaultJsonPath)) {
      const raw = readFileSync(defaultJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      openSqliteDatabase(dbPath);
      migrateJsonToSqlite(parsed);
      saveSqlite();
      return;
    }
    openSqliteDatabase(dbPath);
    saveSqlite();
    return;
  }

  if (filename === "studybot-data.json") {
    if (!existsSync(dbPath) && existsSync(legacyPath)) {
      console.warn(`Database file ${dbPath} not found. Migrating legacy data from ${legacyPath} to ${defaultJsonPath}.`);
      const legacyRaw = readFileSync(legacyPath, "utf8");
      data = JSON.parse(legacyRaw);
      data.users = data.users || {};
      data.sessions = data.sessions || [];
      data.achievements = data.achievements || [];
      data.nextSessionId = data.nextSessionId || 1;
      dbPath = defaultJsonPath;
      saveDb();
      return;
    }

    if (existsSync(defaultJsonPath)) {
      try {
        const raw = readFileSync(defaultJsonPath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          (!parsed.users || Object.keys(parsed.users).length === 0) &&
          (!parsed.sessions || parsed.sessions.length === 0) &&
          (!parsed.achievements || parsed.achievements.length === 0) &&
          existsSync(legacyPath)
        ) {
          console.warn(`Default database file ${defaultJsonPath} is empty. Migrating legacy data from ${legacyPath}.`);
          const legacyRaw = readFileSync(legacyPath, "utf8");
          data = JSON.parse(legacyRaw);
          data.users = data.users || {};
          data.sessions = data.sessions || [];
          data.achievements = data.achievements || [];
          data.nextSessionId = data.nextSessionId || 1;
          dbPath = defaultJsonPath;
          saveDb();
          return;
        }
      } catch (error) {
        console.error(`Failed to parse default database file at ${defaultJsonPath}: ${error.message}`);
        process.exit(1);
      }
    }
  }

  if (existsSync(dbPath)) {
    try {
      const raw = readFileSync(dbPath, "utf8");
      data = JSON.parse(raw);
      data.users = data.users || {};
      data.sessions = data.sessions || [];
      data.achievements = data.achievements || [];
      data.nextSessionId = data.nextSessionId || 1;
    } catch (error) {
      console.error(`Failed to parse database file at ${dbPath}: ${error.message}`);
      console.error("DATABASE_FILE must point to a valid JSON database file.");
      process.exit(1);
    }
  }
  saveDb();
}

function getUserRow(discordId) {
  if (useSqlite) {
    return sqliteDb.prepare("SELECT * FROM users WHERE discord_id = ?").get([discordId]) || null;
  }
  return data.users[discordId] || null;
}

export function ensureUser(discordId, username) {
  if (useSqlite) {
    const row = getUserRow(discordId);
    const now = Math.floor(Date.now() / 1000);
    if (row) {
      if (row.username !== username) {
        sqliteDb.prepare("UPDATE users SET username = ?, updated_at = ? WHERE discord_id = ?").run([username, now, discordId]);
        saveSqlite();
      }
      return getUserRow(discordId);
    }
    sqliteDb.prepare(
      "INSERT INTO users (discord_id, username, xp, level, total_seconds, linked_main, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run([discordId, username, 0, 1, 0, null, now]);
    saveSqlite();
    return getUserRow(discordId);
  }

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
  if (useSqlite) {
    const own = getUserRow(discordId);
    if (!own) return null;
    if (own.linked_main) {
      const main = getUserRow(own.linked_main);
      return { memberType: "sub", main, sub: own };
    }
    const subs = sqliteDb.prepare("SELECT * FROM users WHERE linked_main = ?").all([discordId]);
    return { memberType: "main", main: own, subs };
  }

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
  if (useSqlite) {
    const placeholders = userIds.map(() => "?").join(",");
    let sql = `SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM sessions WHERE user_id IN (${placeholders}) AND end_ts IS NOT NULL AND end_ts >= ?`;
    const params = [...userIds, startTs];
    if (guildId) {
      sql += " AND (guild_id = ? OR guild_id IS NULL)";
      params.push(guildId);
    }
    const row = sqliteDb.prepare(sql).get(params);
    return row?.total ?? 0;
  }

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
  if (useSqlite) {
    return normalizeSessionRow(sqliteDb.prepare("SELECT * FROM sessions WHERE user_id = ? AND end_ts IS NULL LIMIT 1").get([discordId]));
  }
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
  if (useSqlite) {
    const now = Math.floor(Date.now() / 1000);
    sqliteDb
      .prepare(
        "INSERT INTO sessions (user_id, guild_id, start_ts, end_ts, duration_seconds, accumulated_seconds, paused_at, note, created_at) VALUES (?, ?, ?, NULL, NULL, 0, NULL, ?, ?)"
      )
      .run([discordId, guildId, now, note, now]);
    saveSqlite();
    const row = sqliteDb.prepare("SELECT * FROM sessions WHERE id = last_insert_rowid()").get();
    return normalizeSessionRow(row);
  }

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
  if (useSqlite) {
    const session = getActiveSession(discordId);
    if (!session) return null;
    const now = Math.floor(Date.now() / 1000);
    let seconds = session.accumulated_seconds || 0;
    if (session.paused_at == null) {
      seconds += now - session.start_ts;
    }
    sqliteDb
      .prepare(
        "UPDATE sessions SET end_ts = ?, duration_seconds = ?, accumulated_seconds = ?, paused_at = NULL WHERE id = ?"
      )
      .run([now, seconds, seconds, session.id]);
    sqliteDb.prepare("UPDATE users SET total_seconds = total_seconds + ?, updated_at = ? WHERE discord_id = ?").run([seconds, now, discordId]);
    saveSqlite();
    return normalizeSessionRow(sqliteDb.prepare("SELECT * FROM sessions WHERE id = ?").get([session.id]));
  }

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
  if (useSqlite) {
    const session = getActiveSession(discordId);
    if (!session || session.paused_at != null) return null;
    const now = Math.floor(Date.now() / 1000);
    const newAccumulated = (session.accumulated_seconds || 0) + (now - session.start_ts);
    sqliteDb.prepare("UPDATE sessions SET accumulated_seconds = ?, paused_at = ? WHERE id = ?").run([newAccumulated, now, session.id]);
    saveSqlite();
    return normalizeSessionRow(sqliteDb.prepare("SELECT * FROM sessions WHERE id = ?").get([session.id]));
  }

  const session = getActiveSession(discordId);
  if (!session || session.paused_at != null) return null;
  const now = Math.floor(Date.now() / 1000);
  session.accumulated_seconds = (session.accumulated_seconds || 0) + (now - session.start_ts);
  session.paused_at = now;
  saveDb();
  return session;
}

export function resumeSession(discordId) {
  if (useSqlite) {
    const session = getActiveSession(discordId);
    if (!session || session.paused_at == null) return null;
    const now = Math.floor(Date.now() / 1000);
    sqliteDb.prepare("UPDATE sessions SET start_ts = ?, paused_at = NULL WHERE id = ?").run([now, session.id]);
    saveSqlite();
    return normalizeSessionRow(sqliteDb.prepare("SELECT * FROM sessions WHERE id = ?").get([session.id]));
  }

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
  if (useSqlite) {
    const user = getUserRow(discordId);
    if (!user) return null;
    const now = Math.floor(Date.now() / 1000);
    sqliteDb.prepare("UPDATE users SET total_seconds = total_seconds + ?, updated_at = ? WHERE discord_id = ?").run([secondsDelta, now, discordId]);
    sqliteDb
      .prepare(
        "INSERT INTO sessions (user_id, guild_id, start_ts, end_ts, duration_seconds, accumulated_seconds, paused_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run([discordId, guildId, now, now, secondsDelta, secondsDelta, null, note, now]);
    saveSqlite();
    return getUserRow(discordId);
  }

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
    accumulated_seconds: secondsDelta,
    paused_at: null,
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
  if (useSqlite) {
    const aggregated = [];
    const mainUsers = sqliteDb.prepare("SELECT * FROM users WHERE linked_main IS NULL").all();
    for (const user of mainUsers) {
      const subs = sqliteDb.prepare("SELECT discord_id FROM users WHERE linked_main = ?").all([user.discord_id]);
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
  if (useSqlite) {
    if (guildId) {
      return sqliteDb
        .prepare("SELECT * FROM achievements WHERE user_id = ? AND (guild_id = ? OR guild_id IS NULL)")
        .all([discordId, guildId]);
    }
    return sqliteDb.prepare("SELECT * FROM achievements WHERE user_id = ?").all([discordId]);
  }
  return data.achievements.filter((item) => item.user_id === discordId && (guildId ? item.guild_id === guildId || item.guild_id == null : true));
}

export function unlockAchievement(discordId, key, name, description, guildId = null) {
  if (useSqlite) {
    const exists = sqliteDb
      .prepare("SELECT 1 FROM achievements WHERE user_id = ? AND key = ? AND guild_id IS ?")
      .get([discordId, key, guildId]);
    if (exists) return false;
    sqliteDb
      .prepare(
        "INSERT INTO achievements (user_id, key, name, description, guild_id, unlocked_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run([discordId, key, name, description, guildId, Math.floor(Date.now() / 1000)]);
    saveSqlite();
    return true;
  }

  if (data.achievements.some((item) => item.user_id === discordId && item.key === key && item.guild_id === guildId)) {
    return false;
  }
  data.achievements.push({ user_id: discordId, key, name, description, guild_id: guildId, unlocked_at: Math.floor(Date.now() / 1000) });
  saveDb();
  return true;
}

export function addXp(discordId, xp) {
  if (useSqlite) {
    const row = getUserRow(discordId);
    if (!row) return null;
    const newXp = row.xp + xp;
    const newLevel = Math.max(1, Math.floor(Math.sqrt(newXp / 50)) + 1);
    const now = Math.floor(Date.now() / 1000);
    sqliteDb.prepare("UPDATE users SET xp = ?, level = ?, updated_at = ? WHERE discord_id = ?").run([newXp, newLevel, now, discordId]);
    saveSqlite();
    return { xp: newXp, level: newLevel };
  }

  const row = getUserRow(discordId);
  if (!row) return null;
  row.xp += xp;
  row.level = Math.max(1, Math.floor(Math.sqrt(row.xp / 50)) + 1);
  row.updated_at = Math.floor(Date.now() / 1000);
  saveDb();
  return { xp: row.xp, level: row.level };
}

export function getSessionsForChart(discordId, days = 14, guildId = null) {
  if (useSqlite) {
    const ids = getFamilyIds(discordId);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const earliest = Math.floor(Date.now() / 1000) - days * 86400;
    let sql = `SELECT strftime('%Y-%m-%d', datetime(end_ts, 'unixepoch')) AS day, SUM(duration_seconds) AS total_seconds FROM sessions WHERE user_id IN (${placeholders}) AND end_ts IS NOT NULL AND end_ts >= ?`;
    const params = [...ids, earliest];
    if (guildId) {
      sql += " AND (guild_id = ? OR guild_id IS NULL)";
      params.push(guildId);
    }
    sql += " GROUP BY day";
    return sqliteDb.prepare(sql).all(params).map((row) => ({ day: row.day, total_seconds: row.total_seconds }));
  }

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
  if (useSqlite) {
    const main = getUserRow(mainId);
    const sub = getUserRow(subId);
    if (!main || !sub) return false;
    if (sub.linked_main) return false;
    if (main.linked_main) return false;
    sqliteDb.prepare("UPDATE users SET linked_main = ? WHERE discord_id = ?").run([mainId, subId]);
    saveSqlite();
    return true;
  }
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
  if (useSqlite) {
    const sub = getUserRow(subId);
    if (!sub || !sub.linked_main) return false;
    sqliteDb.prepare("UPDATE users SET linked_main = NULL WHERE discord_id = ?").run([subId]);
    saveSqlite();
    return true;
  }
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
