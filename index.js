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
  getAnyActiveSession,
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
const dbFile = process.env.DATABASE_FILE || "studybot.sqlite";

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
    .addSubcommand((sub) => sub.setName("start").setDescription("勉強を開始します"))
    .addSubcommand((sub) => sub.setName("stop").setDescription("勉強を終了します"))
    .addSubcommand((sub) =>
      sub.setName("stats").setDescription("自分の学習記録を確認します")
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
        .setName("achievements")
        .setDescription("実績を確認します")
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
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "study") return;

  const subcommand = interaction.options.getSubcommand();
  const author = interaction.user;
  ensureUser(author.id, author.username);

  switch (subcommand) {
    case "start": {
      const active = getAnyActiveSession(author.id);
      if (active) {
        return interaction.reply({ content: "すでに学習中です。先に`/study stop`で終了してください。", ephemeral: false });
      }
      startSession(author.id);
      return interaction.reply({ content: "勉強を開始しました！📚", ephemeral: false });
    }
    case "stop": {
      const session = getAnyActiveSession(author.id);
      if (!session) {
        return interaction.reply({ content: "現在進行中の学習が見つかりません。", ephemeral: false });
      }
      if (session.user_id !== author.id && session.user_id !== getAccountFamily(author.id)?.main?.discord_id) {
        return interaction.reply({ content: "別アカウントのセッションが進行中のようです。先に停止してください。", ephemeral: true });
      }
      const stopped = stopSession(session.user_id);
      const award = awardSessionXpAndAchievements(session.user_id, stopped.duration_seconds);
      let response = `勉強を終了しました！所要時間: **${formatDuration(stopped.duration_seconds)}**\n`;
      response += `経験値 +${award.earnedXp}、現在のレベル: **${award.level}**\n`;
      if (award.unlocked.length > 0) {
        response += `🎉 新しい実績を獲得しました: ${award.unlocked.map((item) => item.name).join("、")}\n`;
      }
      return interaction.reply({ content: response, ephemeral: false });
    }
    case "stats": {
      const user = getUser(author.id);
      const total = getUserTotalSeconds(author.id);
      const weekly = getWeeklySeconds(author.id);
      const title = getTitleForWeeklySeconds(weekly);
      const family = getAccountFamily(author.id);
      const linked = family.memberType === "sub" ? `メインアカウント: <@${family.main.discord_id}>` : family.subs.length ? `紐付け済みサブアカウント: ${family.subs.map((s) => `<@${s.discord_id}>`).join("、")}` : "紐付けなし";
      const embed = new EmbedBuilder()
        .setTitle(`${author.username} さんの学習記録`)
        .addFields(
          { name: "累計学習時間", value: formatDuration(total), inline: false },
          { name: "今週の学習時間", value: formatDuration(weekly), inline: false },
          { name: "週間称号", value: title, inline: true },
          { name: "レベル", value: `${user.level} (XP: ${user.xp})`, inline: true },
          { name: "アカウント状況", value: linked, inline: false }
        )
        .setColor(0x3b82f6)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: false });
    }
    case "leaderboard": {
      const top = getLeaderboard(10);
      const description = top.map((entry, idx) => `${idx + 1}. ${entry.username} - ${formatDuration(entry.total_seconds)}`).join("\n");
      const embed = new EmbedBuilder()
        .setTitle("学習ランキング")
        .setDescription(description || "記録がまだありません。")
        .setColor(0x22c55e);
      return interaction.reply({ embeds: [embed] });
    }
    case "graph": {
      const days = interaction.options.getInteger("days") ?? 14;
      const sessions = getSessionsForChart(author.id, days);
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
      return interaction.reply({ embeds: [embed] });
    }
    case "achievements": {
      const achievements = listAchievements(author.id);
      if (achievements.length === 0) {
        return interaction.reply({ content: "まだ実績はありません。継続して学習しましょう！", ephemeral: true });
      }
      const description = achievements.map((item) => `• **${item.name}** - ${item.description}`).join("\n");
      const embed = new EmbedBuilder()
        .setTitle(`${author.username} さんの実績`)        
        .setDescription(description)
        .setColor(0xf59e0b);
      return interaction.reply({ embeds: [embed] });
    }
    case "link": {
      const main = interaction.options.getUser("main", true);
      const sub = interaction.options.getUser("sub", true);
      if (main.id === sub.id) {
        return interaction.reply({ content: "メインアカウントとサブアカウントは別のユーザーである必要があります。", ephemeral: true });
      }
      ensureUser(main.id, main.username);
      ensureUser(sub.id, sub.username);
      if (!linkSubAccount(main.id, sub.id)) {
        return interaction.reply({ content: "紐付けに失敗しました。すでに紐付け済みか、対象がメインアカウントとして使用できない可能性があります。", ephemeral: true });
      }
      return interaction.reply({ content: `<@${sub.id}> を <@${main.id}> のサブアカウントとして紐付けました。`, ephemeral: false });
    }
    case "unlink": {
      const sub = interaction.options.getUser("sub", true);
      if (!unlinkSubAccount(sub.id)) {
        return interaction.reply({ content: "紐付け解除に失敗しました。対象はサブアカウントではない可能性があります。", ephemeral: true });
      }
      return interaction.reply({ content: `<@${sub.id}> の紐付けを解除しました。`, ephemeral: false });
    }
    case "admin_edit": {
      const member = interaction.options.getUser("user", true);
      const seconds = interaction.options.getInteger("seconds", true);
      const reason = interaction.options.getString("reason") ?? "管理者による修正";
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "このコマンドを実行するには管理者権限が必要です。", ephemeral: true });
      }
      ensureUser(member.id, member.username);
      const updated = editUserTime(member.id, seconds, reason);
      if (!updated) {
        return interaction.reply({ content: "指定したユーザーが見つかりませんでした。", ephemeral: true });
      }
      return interaction.reply({ content: `<@${member.id}> の学習時間を ${seconds >= 0 ? `+${formatDuration(seconds)}` : `-${formatDuration(Math.abs(seconds))}`} で修正しました。理由: ${reason}`, ephemeral: false });
    }
    default:
      return interaction.reply({ content: "不明なサブコマンドです。", ephemeral: true });
  }
});

client.login(token);
