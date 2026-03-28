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
    console.log("🟡 Inserted default example item");
  }
}

// ===== DISCORD CLIENT =====
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

function formatAmount(value) {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1) + "B";
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "K";
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

async function checkInactivityAndRoles(member, user) {
  if (user.last_earned) {
    const diffDays = daysSince(user.last_earned);
    if (diffDays >= INACTIVE_DAYS && user.points > 0) {
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

    const [coins] = await db.execute(`
      SELECT COALESCE(SUM(items.cost), 0) as total
      FROM purchases
      JOIN items ON purchases.item_id = items.id
      WHERE MONTH(purchases.date) = MONTH(NOW())
      AND YEAR(purchases.date) = YEAR(NOW())
    `);

    const formattedCoins = formatAmount(coins[0].total);

    const statuses = [
      { name: "buying cheap dreads", type: ActivityType.Watching },
      {
        name: `gave away ${formattedCoins} coins this month`,
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
  } catch (err) {
    console.error("Status update failed:", err);
  }
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
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("✅ Commands registered");
  } catch (err) {
    console.error(err);
  }
})();

// ===== INTERACTIONS =====
client.on("interactionCreate", async (interaction) => {
  const member = interaction.member;

  // ===== BUTTONS =====
  if (interaction.isButton()) {
    // Delivered
    if (interaction.customId.startsWith("delivered_")) {
      if (!hasRole(member, ADMIN_ROLE))
        return interaction.reply({ content: "Nope.", ephemeral: true });

      const [, userId, itemId] = interaction.customId.split("_");

      await db.execute(
        `UPDATE purchases SET delivered = 1 WHERE user_id = ? AND item_id = ?`,
        [userId, itemId],
      );

      return interaction.update({
        content: "✅ Delivered",
        components: [],
      });
    }

    // ===== BUY =====
    if (interaction.customId.startsWith("buy_")) {
      try {
        const daysInCorp = daysSince(member.joinedAt);

        if (daysInCorp < MIN_DAYS_IN_CORP) {
          return interaction.reply({
            content: `⛔ You need ${MIN_DAYS_IN_CORP} days.\nCurrent: ${Math.floor(
              daysInCorp,
            )}`,
            ephemeral: true,
          });
        }

        const itemId = interaction.customId.split("_")[1];

        let user = await getOrCreateUser(interaction.user.id);
        user = await checkInactivityAndRoles(member, user);

        const [items] = await db.execute(`SELECT * FROM items WHERE id = ?`, [
          itemId,
        ]);

        if (!items.length)
          return interaction.reply({
            content: "Item not found",
            ephemeral: true,
          });

        const item = items[0];

        // ===== LIFETIME CATEGORY CHECK =====
        if (item.lifetime === 1) {
          const [existing] = await db.execute(
            `SELECT purchases.id 
             FROM purchases
             JOIN items ON purchases.item_id = items.id
             WHERE purchases.user_id = ? 
             AND items.category = ?
             AND items.lifetime = 1
             LIMIT 1`,
            [user.id, item.category],
          );

          if (existing.length > 0) {
            return interaction.reply({
              content: `⛔ You already claimed your one-time **${item.category}** reward.`,
              ephemeral: true,
            });
          }
        }

        // cooldown
        if (user.last_purchase) {
          const diffDays = daysSince(user.last_purchase);

          if (diffDays < PURCHASE_COOLDOWN_DAYS) {
            return interaction.reply({
              content: `⛔ Wait ${Math.ceil(
                PURCHASE_COOLDOWN_DAYS - diffDays,
              )} days.`,
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
          `UPDATE users SET points = points - ?, last_earned = NOW(), last_purchase = NOW() WHERE discord_id = ?`,
          [item.cost, user.discord_id],
        );

        await db.execute(
          `INSERT INTO purchases (user_id, item_id, date) VALUES (?, ?, NOW())`,
          [user.id, item.id],
        );

        await interaction.reply({
          content: `✅ Purchased **${item.name}**`,
          ephemeral: true,
        });

        const channel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (channel) {
          const rowBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`delivered_${user.id}_${item.id}`)
              .setLabel("Mark Delivered")
              .setStyle(ButtonStyle.Success),
          );

          channel.send({
            content: `📦 ${item.name} for <@${user.discord_id}>`,
            components: [rowBtn],
          });
        }
      } catch (err) {
        console.error(err);
        interaction.reply({ content: "Error", ephemeral: true });
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

  // ===== ADD COINS =====
  if (interaction.commandName === "addcoins") {
    if (!hasRole(member, ADMIN_ROLE))
      return interaction.reply({ content: "Nope", ephemeral: true });

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");

    const targetMember = await interaction.guild.members.fetch(target.id);

    if (!hasRole(targetMember, REQUIRED_ROLE)) {
      return interaction.reply({
        content: `❌ ${target.username} missing role.`,
        ephemeral: true,
      });
    }

    await getOrCreateUser(target.id);

    await db.execute(
      `UPDATE users SET points = points + ?, last_earned = NOW() WHERE discord_id = ?`,
      [amount, target.id],
    );

    return interaction.reply({
      content: `+${amount} coins to ${target.username}`,
    });
  }

  // ===== SHOP =====
  if (interaction.commandName === "shop") {
    let user = await getOrCreateUser(interaction.user.id);
    user = await checkInactivityAndRoles(member, user);

    const [items] = await db.execute(`SELECT * FROM items`);

    const embed = {
      title: "🛒 Caddock Shop",
      description:
        `You have **${user.points} coins**\n\n` +
        items
          .map(
            (i) =>
              `• ${i.name} — ${i.cost}${
                i.lifetime ? ` 🔒 (one-time ${i.category})` : ""
              }`,
          )
          .join("\n"),
      color: 0xf1c40f,
    };

    const rows = [];
    let row = new ActionRowBuilder();

    items.forEach((item, i) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(item.name)
          .setStyle(ButtonStyle.Primary),
      );

      if (row.components.length === 5 || i === items.length - 1) {
        rows.push(row);
        row = new ActionRowBuilder();
      }
    });

    interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
  }

  // ===== LEADERBOARD =====
  if (interaction.commandName === "leaderboard") {
    const [rows] = await db.execute(
      `SELECT discord_id, points FROM users ORDER BY points DESC LIMIT 10`,
    );

    let text = "**🏆 Leaderboard**\n";
    rows.forEach(
      (r, i) => (text += `${i + 1}. <@${r.discord_id}> — ${r.points}\n`),
    );

    interaction.reply({ content: text });
  }
});

// ===== START =====
client.once("ready", () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);

  updateStatus();
  setInterval(updateStatus, 1800000);
});

initDB().then(() => client.login(TOKEN));
