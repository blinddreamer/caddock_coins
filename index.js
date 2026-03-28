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
      cost INT,
      category VARCHAR(50) DEFAULT 'normal',
      lifetime TINYINT DEFAULT 0
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
    await db.execute(
      `INSERT INTO items (name, cost, category, lifetime) VALUES (?, ?, ?, ?)`,
      ["Example Ship", 10, "normal", 0],
    );
  }
}

// ===== CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ===== HELPERS =====
function hasRole(member, roleName) {
  return member.roles.cache.some((r) => r.name === roleName);
}

function daysSince(date) {
  return (new Date() - new Date(date)) / (1000 * 60 * 60 * 24);
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

async function checkInactivityAndRoles(member, user) {
  if (user.last_earned) {
    if (daysSince(user.last_earned) >= INACTIVE_DAYS && user.points > 0) {
      await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
        user.discord_id,
      ]);
      user.points = 0;
    }
  }

  if (!hasRole(member, REQUIRED_ROLE) && user.points > 0) {
    await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
      user.discord_id,
    ]);
    user.points = 0;
  }

  return user;
}

// ===== STATUS =====
async function updateStatus() {
  try {
    const [pending] = await db.execute(
      `SELECT COUNT(*) as count FROM purchases WHERE delivered = 0`,
    );

    const statuses = [
      { name: "buying cheap dreads", type: ActivityType.Watching },
      {
        name: `${pending[0].count} pending deliveries`,
        type: ActivityType.Watching,
      },
    ];

    const random = statuses[Math.floor(Math.random() * statuses.length)];

    client.user.setPresence({
      activities: [random],
      status: "online",
    });
  } catch {}
}

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

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });
})();

// ===== INTERACTIONS =====
client.on("interactionCreate", async (interaction) => {
  const member = interaction.member;

  // ===== BUTTONS =====
  if (interaction.isButton()) {
    // BUY
    if (interaction.customId.startsWith("buy_")) {
      try {
        const itemId = interaction.customId.split("_")[1];

        let user = await getOrCreateUser(interaction.user.id);
        user = await checkInactivityAndRoles(member, user);

        const [items] = await db.execute(`SELECT * FROM items WHERE id = ?`, [
          itemId,
        ]);

        const item = items[0];

        // lifetime check
        if (item.lifetime === 1) {
          const [existing] = await db.execute(
            `SELECT id FROM purchases 
             JOIN items ON purchases.item_id = items.id
             WHERE user_id = ? AND category = ? AND lifetime = 1 LIMIT 1`,
            [user.id, item.category],
          );

          if (existing.length) {
            return interaction.reply({
              content: `⛔ One-time ${item.category} already used.`,
              ephemeral: true,
            });
          }
        }

        if (user.points < item.cost)
          return interaction.reply({
            content: "Not enough coins",
            ephemeral: true,
          });

        await db.execute(
          `UPDATE users SET points = points - ?, last_purchase = NOW() WHERE discord_id = ?`,
          [item.cost, user.discord_id],
        );

        await db.execute(
          `INSERT INTO purchases (user_id, item_id, date) VALUES (?, ?, NOW())`,
          [user.id, item.id],
        );

        interaction.reply({
          content: `✅ Purchased ${item.name}`,
          ephemeral: true,
        });
      } catch (e) {
        console.error(e);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ===== SHOP =====
  if (interaction.commandName === "shop") {
    let user = await getOrCreateUser(interaction.user.id);
    user = await checkInactivityAndRoles(member, user);

    const [items] = await db.execute(`SELECT * FROM items ORDER BY category`);

    // group
    const grouped = {};
    items.forEach((i) => {
      if (!grouped[i.category]) grouped[i.category] = [];
      grouped[i.category].push(i);
    });

    // embed
    let desc = `You have **${user.points} coins**\n\n`;

    for (const cat in grouped) {
      desc += `**${cat.toUpperCase()}**\n`;
      grouped[cat].forEach((i) => {
        desc += `• ${i.name} — ${i.cost}${i.lifetime ? " 🔒" : ""}\n`;
      });
      desc += "\n";
    }

    const embed = {
      title: "🛒 Shop",
      description: desc,
      color: 0xf1c40f,
    };

    // buttons grouped 4 per row per category
    const rows = [];

    for (const cat in grouped) {
      let row = new ActionRowBuilder();
      let count = 0;

      grouped[cat].forEach((item) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`buy_${item.id}`)
            .setLabel(item.name)
            .setStyle(ButtonStyle.Primary),
        );

        count++;

        if (count === 4) {
          rows.push(row);
          row = new ActionRowBuilder();
          count = 0;
        }
      });

      if (row.components.length > 0) rows.push(row);
    }

    interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
  }
});

// ===== START =====
client.once("ready", () => {
  updateStatus();
  setInterval(updateStatus, 1800000);
});

initDB().then(() => client.login(TOKEN));
