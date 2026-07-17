import dotenv from "dotenv";
import express from "express";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import {
  initDatabase,
  ensureUser,
  getUser,
  getUserTotalSeconds,
  getWeeklySeconds,
  getTitleForWeeklySeconds,
  startSession,
  stopSession,
  pauseSession,
  resumeSession,
  getActiveSession,
  getAnyActiveSession,
  getSessionElapsedSeconds,
  editUserTime,
  getLeaderboard,
  listAchievements,
  getSessionsForChart,
  awardSessionXpAndAchievements,
  getAccountFamily,
  linkSubAccount,
  unlinkSubAccount
} from "./db.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

app.get("/", (req, res) => {
  res.send("StudyBot is running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
});

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const dbFile = process.env.DATABASE_FILE || "studybot-data.json";

if (!token) {
  console.error("DISCORD_TOKEN is required in .env");
  process.exit(1);
}

initDatabase(dbFile);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName("study")
    .setDescription("学習時間を記録・確認するコマンド")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("勉強を開始します")
        .addUserOption((opt) => opt.setName("user").setDescription("自分または紐付けたアカウント").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("stop")
        .setDescription("勉強を終了します")
        .addUserOption((opt) => opt.setName("user").setDescription("自分または紐付けたアカウント").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("stats")
        .setDescription("自分または指定したユーザーの学習記録を確認します")
        .addUserOption((opt) => opt.setName("user").setDescription("対象ユーザー").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub.setName("leaderboard").setDescription("サーバーの学習ランキングを表示します")
    )
    .addSubcommand((sub) =>
      sub
        .setName("graph")
        .setDescription("学習時間の推移グラフを表示します")
        .addIntegerOption((opt) =>
          opt.setName("days").setDescription("何日分のグラフを表示するか(最大30)").setMinValue(1).setMaxValue(30)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("current")
        .setDescription("現在の学習タイマーを表示します")
        .addUserOption((opt) => opt.setName("user").setDescription("自分または紐付けたアカウント").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("pause")
        .setDescription("現在の学習を一時停止します")
        .addUserOption((opt) => opt.setName("user").setDescription("自分または紐付けたアカウント").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("resume")
        .setDescription("一時停止中の学習を再開します")
        .addUserOption((opt) => opt.setName("user").setDescription("自分または紐付けたアカウント").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("achievements")
        .setDescription("自分または指定したユーザーの実績を確認します")
        .addUserOption((opt) => opt.setName("user").setDescription("対象ユーザー").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("link")
        .setDescription("サブアカウントをメインに紐付けます")
        .addUserOption((opt) => opt.setName("main").setDescription("メインアカウント").setRequired(true))
        .addUserOption((opt) => opt.setName("sub").setDescription("サブアカウント").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlink")
        .setDescription("サブアカウントの紐付けを解除します")
        .addUserOption((opt) => opt.setName("sub").setDescription("解除するサブアカウント").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("admin_edit")
        .setDescription("管理者が学習時間を修正します")
        .addUserOption((opt) => opt.setName("user").setDescription("対象ユーザー").setRequired(true))
        .addIntegerOption((opt) => opt.setName("seconds").setDescription("追加/減算する秒数").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("修正理由").setRequired(false))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(token);

async function registerCommands() {
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`Registered guild commands for ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log("Registered global commands");
    }
  } catch (error) {
    console.error("Failed to register commands", error);
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}時間 ${m}分 ${s}秒`;
}

function getAuthorizedTargetId(actorId, targetId) {
  if (!targetId || targetId === actorId) return actorId;
  const family = getAccountFamily(actorId);
  if (!family) return null;
  if (family.memberType === "main") {
    if (family.subs.some((sub) => sub.discord_id === targetId)) return targetId;
  } else {
    if (family.main.discord_id === targetId) return targetId;
  }
  return null;
}

function createChartUrl(labels, values, username) {
  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `${username}さんの学習時間(分)`,
          data: values,
          backgroundColor: "rgba(54, 162, 235, 0.7)",
          borderColor: "rgba(54, 162, 235, 1)",
          borderWidth: 1,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${username}さんの学習履歴`,
          font: { size: 18 },
        },
      },
      scales: {
        y: {
          title: { display: true, text: "分" },
          beginAtZero: true,
        },
      },
    },
  };
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&backgroundColor=white&width=800&height=450`;
}

client.once("ready", async () => {
  console.log(`Ready as ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "study") return;

    const subcommand = interaction.options.getSubcommand();
    console.log(`[interaction] ${interaction.user.tag} ${interaction.commandName} ${subcommand} guild=${interaction.guildId}`);
    const author = interaction.user;
    ensureUser(author.id, author.username);

    switch (subcommand) {
    case "start": {
      const targetUser = interaction.options.getUser("user");
      const targetId = targetUser?.id ?? author.id;
      const authorizedTargetId = getAuthorizedTargetId(author.id, targetId);
      if (!authorizedTargetId) {
        return await interaction.reply({ content: "指定したユーザーの操作は許可されていません。", flags: 64 });
      }
      const active = getActiveSession(authorizedTargetId);
      if (active) {
        return await interaction.reply({ content: `${targetUser ? targetUser.username : "対象"} はすでに学習中です。先に /study stop してください。` });
      }
      startSession(authorizedTargetId, interaction.guildId);
      return await interaction.reply({ content: `${targetUser ? `${targetUser.username} の` : "学習"}開始しました！📚` });
    }
    case "stop": {
      const targetUser = interaction.options.getUser("user");
      const targetId = targetUser?.id ?? author.id;
      const authorizedTargetId = getAuthorizedTargetId(author.id, targetId);
      if (!authorizedTargetId) {
        return await interaction.reply({ content: "指定したユーザーの操作は許可されていません。", flags: 64 });
      }
      const session = getActiveSession(authorizedTargetId);
      if (!session) {
        return await interaction.reply({ content: "現在進行中の学習が見つかりません。" });
      }
      const stopped = stopSession(session.user_id);
      const award = awardSessionXpAndAchievements(session.user_id, stopped.duration_seconds, session.guild_id);
      let response = `${targetUser ? `${targetUser.username} の` : "勉強"}終了しました！所要時間: **${formatDuration(stopped.duration_seconds)}**\n`;
      response += `経験値 +${award.earnedXp}、現在のレベル: **${award.level}**\n`;
      if (award.unlocked.length > 0) {
        response += `🎉 新しい実績を獲得しました: ${award.unlocked.map((item) => item.name).join("、")}\n`;
      }
      return await interaction.reply({ content: response });
    }
    case "current": {
      const targetUser = interaction.options.getUser("user");
      const targetId = targetUser?.id ?? author.id;
      const authorizedTargetId = getAuthorizedTargetId(author.id, targetId);
      if (!authorizedTargetId) {
        return await interaction.reply({ content: "指定したユーザーの操作は許可されていません。", flags: 64 });
      }
      const session = getActiveSession(authorizedTargetId);
      if (!session) {
        return await interaction.reply({ content: "現在進行中の学習が見つかりません。" });
      }
      const elapsed = getSessionElapsedSeconds(session);
      const status = session.paused_at != null ? "一時停止中" : "進行中";
      return await interaction.reply({ content: `${targetUser ? `${targetUser.username} の` : "現在の"}学習: **${status}**\n経過時間: **${formatDuration(elapsed)}**` });
    }
    case "pause": {
      const targetUser = interaction.options.getUser("user");
      const targetId = targetUser?.id ?? author.id;
      const authorizedTargetId = getAuthorizedTargetId(author.id, targetId);
      if (!authorizedTargetId) {
        return await interaction.reply({ content: "指定したユーザーの操作は許可されていません。", flags: 64 });
      }
      const session = getActiveSession(authorizedTargetId);
      if (!session) {
        return await interaction.reply({ content: "現在進行中の学習が見つかりません。" });
      }
      if (session.paused_at != null) {
        return await interaction.reply({ content: "すでに一時停止中です。/study resume で再開できます。" });
      }
      const paused = pauseSession(session.user_id);
      const elapsed = getSessionElapsedSeconds(paused);
      return await interaction.reply({ content: `${targetUser ? `${targetUser.username} の` : "学習"}を一時停止しました。経過時間: **${formatDuration(elapsed)}**` });
    }
    case "resume": {
      const targetUser = interaction.options.getUser("user");
      const targetId = targetUser?.id ?? author.id;
      const authorizedTargetId = getAuthorizedTargetId(author.id, targetId);
      if (!authorizedTargetId) {
        return await interaction.reply({ content: "指定したユーザーの操作は許可されていません。", flags: 64 });
      }
      const session = getActiveSession(authorizedTargetId);
      if (!session) {
        return await interaction.reply({ content: "再開する一時停止中の学習が見つかりません。" });
      }
      if (session.paused_at == null) {
        return await interaction.reply({ content: "現在、停止中のセッションはありません。" });
      }
      resumeSession(session.user_id);
      return await interaction.reply({ content: `${targetUser ? `${targetUser.username} の` : "学習"}を再開しました！📚` });
    }
    case "stats": {
      const targetUser = interaction.options.getUser("user") ?? author;
      ensureUser(targetUser.id, targetUser.username);
      const user = getUser(targetUser.id);
      const total = getUserTotalSeconds(targetUser.id, interaction.guildId);
      const weekly = getWeeklySeconds(targetUser.id, interaction.guildId);
      const globalTotal = interaction.guildId ? getUserTotalSeconds(targetUser.id, null) : total;
      const title = getTitleForWeeklySeconds(weekly);
      const family = getAccountFamily(targetUser.id);
      const linked = family.memberType === "sub"
        ? `メインアカウント: ${family.main.username}`
        : family.subs.length
          ? `紐付け済みサブアカウント: ${family.subs.map((s) => s.username).join("、")}`
          : "紐付けなし";
      const fields = [
        { name: "累計学習時間", value: formatDuration(total), inline: false },
        { name: "今週の学習時間", value: formatDuration(weekly), inline: false },
      ];
      if (interaction.guildId && globalTotal !== total) {
        fields.push({ name: "全体累計学習時間", value: formatDuration(globalTotal), inline: false });
      }
      fields.push(
        { name: "週間称号", value: title, inline: true },
        { name: "レベル", value: `${user.level} (XP: ${user.xp})`, inline: true },
        { name: "アカウント状況", value: linked, inline: false }
      );
      const embed = new EmbedBuilder()
        .setTitle(`${targetUser.username} さんの学習記録`)
        .addFields(fields)
        .setColor(0x3b82f6)
        .setTimestamp();
      return await interaction.reply({ embeds: [embed] });
    }
    case "leaderboard": {
      const top = getLeaderboard(10, interaction.guildId);
      const description = top.map((entry, idx) => `${idx + 1}. ${entry.username} - ${formatDuration(entry.total_seconds)}`).join("\n");
      const embed = new EmbedBuilder()
        .setTitle("学習ランキング")
        .setDescription(description || "記録がまだありません。")
        .setColor(0x22c55e);
      return await interaction.reply({ embeds: [embed] });
    }
    case "graph": {
      const days = interaction.options.getInteger("days") ?? 14;
      const sessions = getSessionsForChart(author.id, days, interaction.guildId);
      const labels = [];
      const values = [];
      const now = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 86400000);
        const label = `${date.getMonth() + 1}/${date.getDate()}`;
        labels.push(label);
        const row = sessions.find((item) => item.day === date.toISOString().slice(0, 10));
        values.push(row ? Math.round(row.total_seconds / 60) : 0);
      }
      const chartUrl = createChartUrl(labels, values, author.username);
      const embed = new EmbedBuilder()
        .setTitle(`${author.username} さんの学習グラフ`)
        .setImage(chartUrl)
        .setColor(0x6366f1);
      return await interaction.reply({ embeds: [embed] });
    }
    case "achievements": {
      const targetUser = interaction.options.getUser("user") ?? author;
      ensureUser(targetUser.id, targetUser.username);
      const achievements = listAchievements(targetUser.id, interaction.guildId);
      if (achievements.length === 0) {
        return await interaction.reply({ content: "まだ実績はありません。継続して学習しましょう！", flags: 64 });
      }
      const description = achievements.map((item) => `• **${item.name}** - ${item.description}`).join("\n");
      const embed = new EmbedBuilder()
        .setTitle(`${targetUser.username} さんの実績`)
        .setDescription(description)
        .setColor(0xf59e0b);
      return await interaction.reply({ embeds: [embed] });
    }
    case "link": {
      const main = interaction.options.getUser("main", true);
      const sub = interaction.options.getUser("sub", true);
      if (main.id === sub.id) {
        return await interaction.reply({ content: "メインアカウントとサブアカウントは別のユーザーである必要があります。", flags: 64 });
      }
      ensureUser(main.id, main.username);
      ensureUser(sub.id, sub.username);
      if (!linkSubAccount(main.id, sub.id)) {
        return await interaction.reply({ content: "紐付けに失敗しました。すでに紐付け済みか、対象がメインアカウントとして使用できない可能性があります。", flags: 64 });
      }
      return await interaction.reply({ content: `${sub.username} を ${main.username} のサブアカウントとして紐付けました。` });
    }
    case "unlink": {
      const sub = interaction.options.getUser("sub", true);
      if (!unlinkSubAccount(sub.id)) {
        return await interaction.reply({ content: "紐付け解除に失敗しました。対象はサブアカウントではない可能性があります。", flags: 64 });
      }
      return await interaction.reply({ content: `${sub.username} の紐付けを解除しました。` });
    }
    case "admin_edit": {
      const member = interaction.options.getUser("user", true);
      const seconds = interaction.options.getInteger("seconds", true);
      const reason = interaction.options.getString("reason") ?? "管理者による修正";
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return await interaction.reply({ content: "このコマンドを実行するには管理者権限が必要です。", flags: 64 });
      }
      ensureUser(member.id, member.username);
      const updated = editUserTime(member.id, seconds, reason, interaction.guildId);
      if (!updated) {
        return await interaction.reply({ content: "指定したユーザーが見つかりませんでした。", flags: 64 });
      }
      return await interaction.reply({ content: `${member.username} の学習時間を ${seconds >= 0 ? `+${formatDuration(seconds)}` : `-${formatDuration(Math.abs(seconds))}`} で修正しました。理由: ${reason}` });
    }
    default:
      return await interaction.reply({ content: "不明なサブコマンドです。", flags: 64 });
  }
  } catch (error) {
    console.error("interaction error:", error);
    if (error?.code === 10062 || error?.code === 40060) {
      // Unknown interaction or already-acknowledged interaction.
      return;
    }
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "エラーが発生しました。管理者に確認してください。", flags: 64 });
      } else {
        await interaction.reply({ content: "エラーが発生しました。管理者に確認してください。", flags: 64 });
      }
    } catch (replyError) {
      console.error("failed to send error reply:", replyError);
    }
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

client.login(token);
