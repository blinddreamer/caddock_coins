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
  Events,
  MessageFlags,
} = require("discord.js");

const mysql = require("mysql2/promise");
const express = require("express");
const fs = require("fs");
const path = require("path");
const util = require("util");

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const REQUIRED_ROLE = process.env.REQUIRED_ROLE;
const ADMIN_ROLE = process.env.ADMIN_ROLE;
const LOG_CHANNEL_ID = process.env.CHANNEL_ID;

const WEB_PORT = process.env.WEB_PORT || 3000;

const INACTIVE_DAYS = 60;
const PURCHASE_COOLDOWN_DAYS = 30;

// ===== FILE LOGGING =====
const LOG_FILE = path.join(__dirname, "logs", "bot.log");
const MAX_LOG_LINES = 1000;

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

let logLineCount = fs.existsSync(LOG_FILE)
  ? fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).length
  : 0;

function appendLog(line) {
  fs.appendFileSync(LOG_FILE, line + "\n");
  logLineCount++;

  // Trim with headroom so we rewrite the file once per MAX_LOG_LINES lines,
  // not on every single line once the cap is reached.
  if (logLineCount > MAX_LOG_LINES * 2) {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const trimmed = lines.slice(-MAX_LOG_LINES);
    fs.writeFileSync(LOG_FILE, trimmed.join("\n") + "\n");
    logLineCount = trimmed.length;
  }
}

const rawConsoleLog = console.log.bind(console);
const rawConsoleError = console.error.bind(console);

console.log = (...args) => {
  rawConsoleLog(...args);
  appendLog(`[${new Date().toISOString()}] ${util.format(...args)}`);
};

console.error = (...args) => {
  rawConsoleError(...args);
  appendLog(`[${new Date().toISOString()}] ERROR: ${util.format(...args)}`);
};

const REQUIRED_ENV = ["TOKEN", "CLIENT_ID", "GUILD_ID", "REQUIRED_ROLE", "ADMIN_ROLE", "CHANNEL_ID", "DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

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

  // Safe migration: adds username column if it doesn't exist yet
  try {
    await db.execute(`ALTER TABLE users ADD COLUMN username VARCHAR(100)`);
  } catch (e) {
    if (e.errno !== 1060) throw e; // 1060 = column already exists, ignore
  }

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
  return member.roles.cache.some((r) => r.name.toLowerCase() === roleName.toLowerCase());
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function daysSince(date) {
  return (new Date() - new Date(date)) / (1000 * 60 * 60 * 24);
}

async function getOrCreateUser(discordId) {
  const [rows] = await db.execute(`SELECT * FROM users WHERE discord_id = ?`, [
    discordId,
  ]);

  if (rows.length) return rows[0];

  // IGNORE: two concurrent first interactions must not crash on the UNIQUE key
  await db.execute(
    `INSERT IGNORE INTO users (discord_id, points, last_earned) VALUES (?, 0, NOW())`,
    [discordId],
  );

  const [newUser] = await db.execute(
    `SELECT * FROM users WHERE discord_id = ?`,
    [discordId],
  );

  return newUser[0];
}

function logReset(message) {
  console.log(message);
  const channel = client.channels.cache.get(LOG_CHANNEL_ID);
  if (channel) channel.send(message).catch((e) => console.error("Failed to send log message:", e));
}

async function checkInactivityAndRoles(member, user) {
  const name = user.username || user.discord_id;

  if (user.last_earned) {
    if (daysSince(user.last_earned) >= INACTIVE_DAYS && user.points > 0) {
      await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
        user.discord_id,
      ]);
      logReset(`🔄 Reset ${name} — inactive for ${INACTIVE_DAYS}+ days (had ${user.points} coins)`);
      user.points = 0;
    }
  }

  if (!hasRole(member, REQUIRED_ROLE) && user.points > 0) {
    await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
      user.discord_id,
    ]);
    logReset(`🔄 Reset ${name} — missing required role (had ${user.points} coins)`);
    user.points = 0;
  }

  return user;
}

// ===== USERNAME SYNC =====
async function syncUsernames(members) {
  const [users] = await db.execute(`SELECT discord_id FROM users`);

  let synced = 0;
  for (const user of users) {
    const member = members.get(user.discord_id);
    if (!member) continue;
    await db.execute(`UPDATE users SET username = ? WHERE discord_id = ?`, [
      member.displayName,
      user.discord_id,
    ]);
    synced++;
  }
  console.log(`✅ Synced usernames for ${synced}/${users.length} users`);
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
  } catch (e) {
    console.error("Failed to update status:", e);
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
      opt.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder().setName("shop").setDescription("Open shop"),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }
})();

// ===== INTERACTIONS =====
client.on("interactionCreate", async (interaction) => {
  const member = interaction.member;

  // ===== BUTTONS =====
  if (interaction.isButton()) {
    // ===== BUY =====
    if (interaction.customId.startsWith("buy_")) {
      try {
        const itemId = parseInt(interaction.customId.split("_")[1], 10);
        if (isNaN(itemId)) return interaction.reply({ content: "⛔ Invalid item.", flags: MessageFlags.Ephemeral });

        // Ack within Discord's 3s window before the DB work; otherwise a slow
        // transaction can charge the user while they see "interaction failed".
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let user = await getOrCreateUser(interaction.user.id);
        user = await checkInactivityAndRoles(member, user);

        const [items] = await db.execute(`SELECT * FROM items WHERE id = ?`, [
          itemId,
        ]);

        const item = items[0];
        if (!item) return interaction.editReply("⛔ Item not found.");

        // All eligibility checks + the debit happen inside one locked
        // transaction so two concurrent clicks can't both pass the checks
        // (double-spend / double-claim a lifetime item).
        const conn = await db.getConnection();
        let outcome;
        try {
          await conn.beginTransaction();

          const [lockedRows] = await conn.execute(
            `SELECT * FROM users WHERE discord_id = ? FOR UPDATE`,
            [user.discord_id],
          );
          const lockedUser = lockedRows[0];

          // 30-DAY COOLDOWN CHECK
          if (lockedUser.last_purchase) {
            const diffDays = daysSince(lockedUser.last_purchase);
            if (diffDays < PURCHASE_COOLDOWN_DAYS) {
              await conn.rollback();
              outcome = {
                reply: `⛔ You can make one purchase every ${PURCHASE_COOLDOWN_DAYS} days.\nPlease wait ${Math.ceil(
                  PURCHASE_COOLDOWN_DAYS - diffDays,
                )} more day(s).`,
              };
            }
          }

          // LIFETIME CHECK
          if (!outcome && item.lifetime === 1) {
            const [existing] = await conn.execute(
              `SELECT purchases.id
               FROM purchases
               JOIN items ON purchases.item_id = items.id
               WHERE purchases.user_id = ?
               AND items.category = ?
               AND items.lifetime = 1
               LIMIT 1
               FOR UPDATE`,
              [lockedUser.id, item.category],
            );

            if (existing.length > 0) {
              await conn.rollback();
              outcome = { reply: `⛔ You already claimed your one-off ${item.category}.` };
            }
          }

          if (!outcome) {
            const [updateResult] = await conn.execute(
              `UPDATE users SET points = points - ?, last_purchase = NOW() WHERE discord_id = ? AND points >= ?`,
              [item.cost, lockedUser.discord_id, item.cost],
            );

            if (updateResult.affectedRows === 0) {
              await conn.rollback();
              outcome = { reply: "Not enough coins" };
            } else {
              const [inserted] = await conn.execute(
                `INSERT INTO purchases (user_id, item_id, date) VALUES (?, ?, NOW())`,
                [lockedUser.id, item.id],
              );
              await conn.commit();
              outcome = {
                success: true,
                remaining: lockedUser.points - item.cost,
                purchaseId: inserted.insertId,
              };
            }
          }
        } catch (txErr) {
          await conn.rollback();
          throw txErr;
        } finally {
          conn.release();
        }

        if (!outcome.success) return interaction.editReply(outcome.reply);

        console.log(`🛒 ${interaction.user.username} bought "${item.name}" for ${item.cost} coins (remaining: ${outcome.remaining})`);

        await interaction.editReply(`✅ Purchased ${item.name}`);

        // ===== LOG CHANNEL =====
        const channel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (channel) {
          const rowBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`delivered_${outcome.purchaseId}`)
              .setLabel("Mark Delivered")
              .setStyle(ButtonStyle.Success),
          );

          await channel.send({
            content: `📦 ${item.name} purchased by <@${user.discord_id}>`,
            components: [rowBtn],
          }).catch((e) => console.error("Failed to send log message:", e));
        }
      } catch (e) {
        console.error(e);
        const msg = "❌ Something broke.";
        await (interaction.deferred
          ? interaction.editReply(msg)
          : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })
        ).catch(() => {});
      }
    }

    // ===== MARK DELIVERED =====
    if (interaction.customId.startsWith("delivered_")) {
      if (!hasRole(member, ADMIN_ROLE))
        return interaction.reply({ content: "Nope.", flags: MessageFlags.Ephemeral });

      try {
        const ids = interaction.customId.split("_").slice(1).map((n) => parseInt(n, 10));
        if (!ids.length || ids.some((n) => isNaN(n)))
          return interaction.reply({ content: "⛔ Invalid data.", flags: MessageFlags.Ephemeral });

        // New buttons carry the purchase id. Old buttons still in the log
        // channel carry user_id + item_id: mark only the oldest undelivered
        // match, not every purchase of that item by that user.
        const [result] = ids.length === 1
          ? await db.execute(
              `UPDATE purchases SET delivered = 1 WHERE id = ? AND delivered = 0`,
              ids,
            )
          : await db.execute(
              `UPDATE purchases SET delivered = 1
               WHERE user_id = ? AND item_id = ? AND delivered = 0
               ORDER BY id LIMIT 1`,
              ids.slice(0, 2),
            );

        if (result.affectedRows === 0)
          return interaction.reply({ content: "Already delivered.", flags: MessageFlags.Ephemeral });

        // EDIT LOG MESSAGE
        if (interaction.message) {
          await interaction.message.edit({
            content: `${interaction.message.content} ✅ Delivered`,
            components: [],
          });
        }

        await interaction.reply({ content: "Marked delivered", flags: MessageFlags.Ephemeral });
      } catch (e) {
        console.error(e);
        await interaction.reply({ content: "❌ Something broke.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ===== ADD COINS =====
  if (interaction.commandName === "addcoins") {
    if (!hasRole(member, ADMIN_ROLE))
      return interaction.reply({ content: "⛔ Not allowed.", flags: MessageFlags.Ephemeral });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const target = interaction.options.getMember("user");
      const amount = interaction.options.getInteger("amount");
      if (!target) return interaction.editReply("⛔ That user isn't in this server.");

      // One atomic upsert: creates the user if new, otherwise adds to balance.
      await db.execute(
        `INSERT INTO users (discord_id, username, points, last_earned)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username = ?, points = points + ?, last_earned = NOW()`,
        [target.id, target.displayName, amount, target.displayName, amount],
      );

      const [updated] = await db.execute(`SELECT points FROM users WHERE discord_id = ?`, [target.id]);
      const newBalance = updated[0]?.points ?? "?";
      console.log(`💰 ${interaction.user.username} gave ${amount} coins to ${target.displayName} (new balance: ${newBalance})`);

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
   try {
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
        desc += `• ${i.name} — ${i.cost}\n`;
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

    await interaction.reply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
   } catch (e) {
     console.error(e);
     await interaction.reply({ content: "❌ Something broke.", flags: MessageFlags.Ephemeral }).catch(() => {});
   }
  }

});

// ===== INACTIVITY AUDIT =====
async function auditAllUsers(members) {
  const [users] = await db.execute(`SELECT * FROM users WHERE points > 0`);
  let reset = 0;

  for (const user of users) {
    const member = members.get(user.discord_id);
    if (member) {
      const before = user.points;
      await checkInactivityAndRoles(member, user);
      if (user.points !== before) reset++;
    } else {
      // Member left the server — reset their points
      const name = user.username || user.discord_id;
      logReset(`🔄 Reset ${name} — left the server (had ${user.points} coins)`);
      await db.execute(`UPDATE users SET points = 0 WHERE discord_id = ?`, [
        user.discord_id,
      ]);
      reset++;
    }
  }

  console.log(`🔍 Inactivity audit complete — reset ${reset}/${users.length} users`);
}

// ===== MEMBER-BACKED MAINTENANCE =====
// Both syncUsernames and auditAllUsers need the full member list; sharing a
// single fetch keeps us to one gateway "request guild members" call instead
// of tripping Discord's rate limit with back-to-back requests.
async function runMemberMaintenance() {
  const guild = client.guilds.cache.get(GUILD_ID);
  let members;
  try {
    members = await guild.members.fetch();
  } catch (e) {
    console.error("Failed to fetch guild members:", e);
    return;
  }

  await syncUsernames(members);
  await auditAllUsers(members);
}

// ===== START =====
client.once(Events.ClientReady, () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
  updateStatus();
  setInterval(updateStatus, 1800000);
  runMemberMaintenance();
  setInterval(runMemberMaintenance, 86400000);
});

// ===== WEB SERVER =====
const app = express();
app.disable("x-powered-by");

const leaderboardTemplate = fs.readFileSync(
  path.join(__dirname, "leaderboard.html"),
  "utf8",
);

app.get("/", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT username, discord_id, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT 25`,
    );

    const medal = ["gold", "silver", "bronze"];

    const rowsHtml = rows.length
      ? rows
          .map(
            (r, i) => `
        <tr>
          <td><span class="rank ${medal[i] || ""}">${String(i + 1).padStart(2, "0")}</span></td>
          <td class="name">${escapeHtml(r.username || "Unknown Pilot")}</td>
          <td class="points-cell"><span class="points">${r.points.toLocaleString("en-US")}</span></td>
        </tr>`,
          )
          .join("")
      : `<tr><td colspan="3" class="empty">No coins earned yet.</td></tr>`;

    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.send(leaderboardTemplate.replace("{{ROWS}}", rowsHtml));
  } catch (e) {
    console.error(e);
    res.status(500).send("Error loading leaderboard");
  }
});

app.get("/logo.png", (_req, res) =>
  res.sendFile(path.join(__dirname, "assets", "logo.png")),
);

app.get("/favicon.png", (_req, res) =>
  res.sendFile(path.join(__dirname, "assets", "favicon.png")),
);

app.listen(WEB_PORT, () =>
  console.log(`🌐 Leaderboard at http://localhost:${WEB_PORT}`),
);

// ===== PROCESS SAFETY =====
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// SIGTERM is what `docker stop` sends; as PID 1, node ignores it unless handled.
async function shutdown() {
  console.log("🛑 Shutting down...");
  try {
    await db.end();
  } catch (e) {
    console.error("Error closing DB pool:", e);
  }
  client.destroy();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

initDB().then(() => client.login(TOKEN));
