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
    // ===== BUY =====
    if (interaction.customId.startsWith("buy_")) {
      try {
        const itemId = interaction.customId.split("_")[1];

        let user = await getOrCreateUser(interaction.user.id);
        user = await checkInactivityAndRoles(member, user);

        const [items] = await db.execute(`SELECT * FROM items WHERE id = ?`, [
          itemId,
        ]);

        const item = items[0];

        // LIFETIME CHECK
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
              content: `⛔ You already claimed your one-off ${item.category}.`,
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

        await interaction.reply({
          content: `✅ Purchased ${item.name}`,
          ephemeral: true,
        });

        // ===== LOG CHANNEL =====
        const channel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (channel) {
          const rowBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`delivered_${user.id}_${item.id}`)
              .setLabel("Mark Delivered")
              .setStyle(ButtonStyle.Success),
          );

          channel.send({
            content: `📦 ${item.name} purchased by <@${user.discord_id}>`,
            components: [rowBtn],
          });
        }
      } catch (e) {
        console.error(e);
      }
    }

    // ===== MARK DELIVERED =====
    if (interaction.customId.startsWith("delivered_")) {
      if (!hasRole(member, ADMIN_ROLE))
        return interaction.reply({ content: "Nope.", ephemeral: true });

      const [, userId, itemId] = interaction.customId.split("_");

      await db.execute(
        `UPDATE purchases SET delivered = 1 WHERE user_id = ? AND item_id = ?`,
        [userId, itemId],
      );

      // EDIT LOG MESSAGE
      if (interaction.message) {
        await interaction.message.edit({
          content: `${interaction.message.content} ✅ Delivered`,
          components: [],
        });
      }

      await interaction.reply({ content: "Marked delivered", ephemeral: true });
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ===== ADD COINS =====
  if (interaction.commandName === "addcoins") {
    if (!hasRole(member, ADMIN_ROLE))
      return interaction.reply({ content: "⛔ Not allowed.", ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    try {
      const target = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");

      let user = await getOrCreateUser(target.id);

      await db.execute(
        `UPDATE users SET points = points + ?, last_earned = NOW() WHERE discord_id = ?`,
        [amount, target.id],
      );

      await interaction.editReply(
        `✅ Added **${amount} coins** to <@${target.id}>`,
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply("❌ Something broke.");
    }
    return;
  }

  // ===== SHOP =====
  if (interaction.commandName === "shop") {
    let user = await getOrCreateUser(interaction.user.id);
    user = await checkInactivityAndRoles(member, user);

    const [items] = await db.execute(`SELECT * FROM items ORDER BY category`);

    const grouped = {};
    items.forEach((i) => {
      if (!grouped[i.category]) grouped[i.category] = [];
      grouped[i.category].push(i);
    });

    // CHECK USED LIFETIME
    const usedLifetime = {};
    for (const cat in grouped) {
      const hasLifetime = grouped[cat].some((i) => i.lifetime === 1);
      if (!hasLifetime) {
        usedLifetime[cat] = false;
        continue;
      }

      const [rows] = await db.execute(
        `SELECT purchases.id 
         FROM purchases
         JOIN items ON purchases.item_id = items.id
         WHERE purchases.user_id = ?
         AND items.category = ?
         AND items.lifetime = 1
         LIMIT 1`,
        [user.id, cat],
      );

      usedLifetime[cat] = rows.length > 0;
    }

    // EMBED
    let desc = `You have **${user.points} coins**\n\n`;
    for (const cat in grouped) {
      if (usedLifetime[cat]) continue;

      const isLifetimeCategory = grouped[cat].some((i) => i.lifetime === 1);
      desc += `**${cat.toUpperCase()}${isLifetimeCategory ? " (ONE OFF)" : ""}**\n`;

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

    // BUTTONS
    const rows = [];
    for (const cat in grouped) {
      if (usedLifetime[cat]) continue;

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
