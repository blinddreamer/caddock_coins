require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} = require("discord.js");

const mysql = require("mysql2/promise");

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const REQUIRED_ROLE = process.env.REQUIRED_ROLE;
const ADMIN_ROLE = process.env.ADMIN_ROLE;
const LOG_CHANNEL_ID = process.env.CHANNEL_ID;

const INACTIVE_DAYS = 60;
const PURCHASE_COOLDOWN_DAYS = 30;
const MIN_DAYS_IN_CORP = 30;

// ===== MYSQL =====
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ===== INIT DB =====
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(50) UNIQUE,
      points INT DEFAULT 0,
      last_earned DATETIME,
      last_purchase DATETIME
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100),
      cost INT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      item_id INT,
      date DATETIME,
      delivered TINYINT DEFAULT 0
    )
  `);

  const [rows] = await db.execute(`SELECT COUNT(*) as count FROM items`);

  if (rows[0].count === 0) {
    await db.execute(`INSERT INTO items (name, cost) VALUES (?, ?)`, [
      "Example Ship",
      10,
    ]);
    console.log("🟡 Inserted default example item");
  }
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName("addcoins")
    .setDescription("Add coins")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("User").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Amount").setRequired(true),
    ),

  new SlashCommandBuilder().setName("shop").setDescription("Open shop"),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Top users"),
].map((c) => c.toJSON());

// ===== REGISTER =====
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });
})();

// ===== HELPERS =====
function hasRole(member, roleName) {
  return member.roles.cache.some((r) => r.name === roleName);
}

function daysSince(date) {
  return (new Date() - new Date(date)) / (1000 * 60 * 60 * 24);
}

function formatISK(value) {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (value >= 1_000_000) return (value / 1_000).toFixed(1) + "K";
  return value.toString();
}

async function getOrCreateUser(discordId) {
  const [rows] = await db.execute(`SELECT * FROM users WHERE discord_id = ?`, [
    discordId,
  ]);

  if (rows.length) return rows[0];

  await db.execute(
    `INSERT INTO users (discord_id, points, last_earned) VALUES (?, 0, NOW())`,
    [discordId],
  );

  const [newUser] = await db.execute(
    `SELECT * FROM users WHERE discord_id = ?`,
    [discordId],
  );

  return newUser[0];
}

async function checkInactivity(user) {
  if (!user.last_earned) return user;

  const diffDays = daysSince(user.last_earned);

  if (diffDays >= INACTIVE_DAYS && user.points > 0) {
    await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
      user.discord_id,
    ]);
    user.points = 0;
  }

  return user;
}

// ===== STATUS =====
async function updateStatus() {
  const [pending] = await db.execute(
    `SELECT COUNT(*) as count FROM purchases WHERE delivered = 0`,
  );

  const [isk] = await db.execute(`
    SELECT COALESCE(SUM(items.cost), 0) as total
    FROM purchases
    JOIN items ON purchases.item_id = items.id
    WHERE MONTH(purchases.date) = MONTH(NOW())
    AND YEAR(purchases.date) = YEAR(NOW())
  `);

  const formattedISK = formatISK(isk[0].total);

  const statuses = [
    { name: "for cheap dreads", type: ActivityType.Watching },
    {
      name: `gave away ${formattedISK} ISK this month`,
      type: ActivityType.Watching,
    },
    {
      name: `${pending[0].count} pending deliveries queue`,
      type: ActivityType.Watching,
    },
  ];

  const random = statuses[Math.floor(Math.random() * statuses.length)];

  client.user.setPresence({
    activities: [random],
    status: "online",
  });
}

// ===== ROLE LOSS CHECK =====
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const hadRole = hasRole(oldMember, REQUIRED_ROLE);
  const hasNow = hasRole(newMember, REQUIRED_ROLE);

  // lost role
  if (hadRole && !hasNow) {
    await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
      newMember.id,
    ]);

    console.log(`💀 ${newMember.user.tag} lost role → coins wiped`);
  }
});

// ===== INTERACTIONS =====
client.on("interactionCreate", async (interaction) => {
  const member = interaction.member;

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("buy_")) {
      const daysInCorp = daysSince(member.joinedAt);

      if (daysInCorp < MIN_DAYS_IN_CORP) {
        return interaction.reply({
          content: `⛔ You can make purchases after ${MIN_DAYS_IN_CORP} days in corp.\nCurrent: ${Math.floor(daysInCorp)} days.`,
          ephemeral: true,
        });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (
    interaction.commandName !== "addcoins" &&
    interaction.commandName !== "leaderboard" &&
    !hasRole(member, REQUIRED_ROLE)
  ) {
    return interaction.reply({ content: "D-SCO only", ephemeral: true });
  }

  if (interaction.commandName === "addcoins") {
    if (!hasRole(member, ADMIN_ROLE))
      return interaction.reply({ content: "Nope", ephemeral: true });

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");

    if (target.bot)
      return interaction.reply({ content: "No bots.", ephemeral: true });

    const targetMember = await interaction.guild.members
      .fetch(target.id)
      .catch(() => null);

    if (!targetMember || !hasRole(targetMember, REQUIRED_ROLE)) {
      return interaction.reply({
        content: "⛔ That pilot is not part of D-SCO.",
        ephemeral: true,
      });
    }

    await getOrCreateUser(target.id);

    await db.execute(
      `UPDATE users SET points = points + ?, last_earned = NOW() WHERE discord_id = ?`,
      [amount, target.id],
    );

    return interaction.reply({
      content: `💰 +${amount} coins to ${target.username}`,
    });
  }
});

// ===== START =====
client.once("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
  updateStatus();
  setInterval(updateStatus, 1800000);
});

initDB().then(() => client.login(TOKEN));
