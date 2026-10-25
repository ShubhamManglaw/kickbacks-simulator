const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'default';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const { Pool } = require('pg');

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5, // Small pool size per instance to stay safely below Render free Postgres connection limit
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  pool.on('error', (err) => {
    console.error('DATABASE: Unexpected error on idle client', err.message);
  });
}

async function runPgQuery(query, params = [], retries = 3, delay = 1000) {
  if (!pool) {
    throw new Error("PostgreSQL pool is not initialized (DATABASE_URL missing).");
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await pool.query(query, params);
      return res;
    } catch (err) {
      console.error(`DATABASE: PostgreSQL query error (Attempt ${attempt}/${retries}):`, err.message);
      if (attempt === retries) {
        throw err;
      }
      await sleep(delay);
      delay *= 2; // Exponential backoff
    }
  }
}

async function getPgClient() {
  if (!pool) throw new Error("PostgreSQL pool is not initialized.");
  return await pool.connect();
}

async function loadConfig() {
  // 1. If DATABASE_URL is provided, try PostgreSQL
  if (process.env.DATABASE_URL) {
    try {
      await runPgQuery('CREATE TABLE IF NOT EXISTS kickbacks_config (id VARCHAR(50) PRIMARY KEY, data JSONB);');
      await runPgQuery('CREATE TABLE IF NOT EXISTS revenue_history (timestamp TIMESTAMPTZ DEFAULT NOW(), profile_name VARCHAR(100), today_usd NUMERIC(10, 6), lifetime_usd NUMERIC(10, 6));');
      
      await runPgQuery(`
        CREATE TABLE IF NOT EXISTS client_stats (
          client_name VARCHAR(100) PRIMARY KEY,
          instance_name VARCHAR(50),
          client_id VARCHAR(50),
          ad_title VARCHAR(255),
          ad_id VARCHAR(100),
          ticks INTEGER DEFAULT 0,
          billing_count INTEGER DEFAULT 0,
          revenue_usd NUMERIC(10, 6) DEFAULT 0,
          last_status VARCHAR(50),
          last_tick_time VARCHAR(50),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Revenue attribution deduplication table
      await runPgQuery(`
        CREATE TABLE IF NOT EXISTS revenue_attribution (
          profile_name VARCHAR(100) PRIMARY KEY,
          last_distributed_lifetime_micros BIGINT DEFAULT 0,
          last_distributed_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await runPgQuery('ALTER TABLE revenue_history ADD COLUMN IF NOT EXISTS instance_name VARCHAR(50) DEFAULT \'default\';');
      
      const res = await runPgQuery('SELECT data FROM kickbacks_config WHERE id = $1;', ['default']);
      if (res.rows && res.rows.length > 0 && Array.isArray(res.rows[0].data) && res.rows[0].data.length > 0) {
        console.log(`SYSTEM: Config loaded from Render PostgreSQL (using default row for unified token rotation).`);
        return res.rows[0].data;
      }

      // If database is empty, check for INITIAL_CONFIG env var to self-seed
      if (process.env.INITIAL_CONFIG) {
        try {
          const initialData = typeof process.env.INITIAL_CONFIG === 'string' ? JSON.parse(process.env.INITIAL_CONFIG) : process.env.INITIAL_CONFIG;
          if (Array.isArray(initialData) && initialData.length > 0) {
            console.log(`SYSTEM: Postgres empty. Self-seeding with INITIAL_CONFIG...`);
            await runPgQuery('INSERT INTO kickbacks_config (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;', ['default', JSON.stringify(initialData)]);
            return initialData;
          }
        } catch (parseErr) {
          console.error("SYSTEM: Error parsing INITIAL_CONFIG for DB:", parseErr.message);
        }
      }
    } catch (err) {
      console.error("SYSTEM: Render PostgreSQL load error (falling back to config.json/env):", err.message);
    }
  }

  // 2. Check local config.json
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (Array.isArray(fileData)) {
        return fileData;
      }
    }
    const defaultPath = path.join(__dirname, 'config.default.json');
    if (fs.existsSync(defaultPath)) {
      const fileData = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      if (Array.isArray(fileData) && fileData.length > 0) {
        try {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(fileData, null, 2), 'utf8');
        } catch (_) {}
        console.log("SYSTEM: Config loaded from config.default.json template.");
        return fileData;
      }
    }
  } catch (err) {
    console.error("SYSTEM: Local config load failed:", err.message);
  }

  // 3. Fallback: INITIAL_CONFIG env var (for standalone cloud deployments like Render without Postgres)
  if (process.env.INITIAL_CONFIG) {
    try {
      const initialData = typeof process.env.INITIAL_CONFIG === 'string' ? JSON.parse(process.env.INITIAL_CONFIG) : process.env.INITIAL_CONFIG;
      if (Array.isArray(initialData) && initialData.length > 0) {
        console.log("SYSTEM: Config loaded from INITIAL_CONFIG env variable.");
        try {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(initialData, null, 2), 'utf8');
        } catch (writeErr) {
          // Ignore read-only fs error
        }
        return initialData;
      }
    } catch (parseErr) {
      console.error("SYSTEM: Error parsing INITIAL_CONFIG env var:", parseErr.message);
    }
  }

  return [];
}

async function saveConfig(config) {
  if (process.env.DATABASE_URL) {
    try {
      await runPgQuery('CREATE TABLE IF NOT EXISTS kickbacks_config (id VARCHAR(50) PRIMARY KEY, data JSONB);');
      await runPgQuery('INSERT INTO kickbacks_config (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;', ['default', JSON.stringify(config)]);
      console.log(`SYSTEM: Config saved to Render PostgreSQL (unified default row).`);
    } catch (err) {
      console.error("SYSTEM: Render PostgreSQL save error:", err.message);
    }
  }

  // Fallback: Local config.json
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    console.log("SYSTEM: Config saved to local config.json fallback.");
  } catch (err) {
    console.error("SYSTEM: Local config save failed:", err.message);
  }
}

let localClientStats = {};
let localRevenueHistory = [];

async function saveRevenueHistory(profileName, todayUsd, lifetimeUsd) {
  if (process.env.DATABASE_URL) {
    try {
      // Get the sum of client revenue for this instance
      const clientRes = await runPgQuery(
        'SELECT COALESCE(SUM(revenue_usd), 0) as total FROM client_stats WHERE instance_name = $1;',
        [INSTANCE_NAME]
      );
      const instanceRevenue = parseFloat(clientRes.rows[0]?.total || 0);

      await runPgQuery(
        'INSERT INTO revenue_history (instance_name, profile_name, today_usd, lifetime_usd) VALUES ($1, $2, $3, $4);',
        [INSTANCE_NAME, profileName, instanceRevenue, instanceRevenue]
      );
      console.log(`SYSTEM: Saved revenue snapshot for instance ${INSTANCE_NAME} ($${instanceRevenue}) (profile: ${profileName}).`);
      
      // Auto-prune data older than 5 days
      await runPgQuery("DELETE FROM revenue_history WHERE timestamp < NOW() - INTERVAL '5 days';");
      await runPgQuery("DELETE FROM client_stats WHERE updated_at < NOW() - INTERVAL '5 days';");
      console.log("SYSTEM: Pruned records older than 5 days from DB.");
    } catch (err) {
      console.error("SYSTEM: Render PostgreSQL saveRevenueHistory error:", err.message);
    }
  } else {
    const clientRevenueSum = Object.values(localClientStats).reduce((acc, c) => acc + (parseFloat(c.revenue_usd) || 0), 0);
    const effectiveToday = clientRevenueSum > 0 ? clientRevenueSum : (parseFloat(todayUsd) || 0);
    const effectiveLifetime = (parseFloat(lifetimeUsd) || 0) + clientRevenueSum;

    localRevenueHistory.push({
      timestamp: new Date().toISOString(),
      profile_name: profileName,
      today_usd: effectiveToday,
      lifetime_usd: effectiveLifetime
    });
    if (localRevenueHistory.length > 200) localRevenueHistory.shift();
  }
}

async function getRevenueHistory(limitHours = 24) {
  if (process.env.DATABASE_URL) {
    try {
      const res = await runPgQuery(
        `SELECT timestamp, profile_name, today_usd, lifetime_usd 
         FROM revenue_history 
         WHERE instance_name = $1 AND timestamp >= NOW() - $2 * INTERVAL '1 hour' 
         ORDER BY timestamp ASC;`,
        [INSTANCE_NAME, limitHours]
      );
      return res.rows || [];
    } catch (err) {
      console.error("SYSTEM: Render PostgreSQL getRevenueHistory error:", err.message);
      return [];
    }
  }

  const clientRevenueSum = Object.values(localClientStats).reduce((acc, c) => acc + (parseFloat(c.revenue_usd) || 0), 0);
  if (localRevenueHistory.length === 0) {
    const now = Date.now();
    return [
      {
        timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
        profile_name: INSTANCE_NAME,
        today_usd: 0,
        lifetime_usd: 0
      },
      {
        timestamp: new Date().toISOString(),
        profile_name: INSTANCE_NAME,
        today_usd: clientRevenueSum,
        lifetime_usd: clientRevenueSum
      }
    ];
  } else if (localRevenueHistory.length === 1) {
    const pt = localRevenueHistory[0];
    return [
      {
        timestamp: new Date(new Date(pt.timestamp).getTime() - 5 * 60 * 1000).toISOString(),
        profile_name: pt.profile_name,
        today_usd: 0,
        lifetime_usd: pt.lifetime_usd
      },
      pt,
      {
        timestamp: new Date().toISOString(),
        profile_name: pt.profile_name,
        today_usd: clientRevenueSum > pt.today_usd ? clientRevenueSum : pt.today_usd,
        lifetime_usd: clientRevenueSum > pt.today_usd ? clientRevenueSum : pt.lifetime_usd
      }
    ];
  }

  return localRevenueHistory;
}

function clearLocalClientStats(instanceName) {
  if (instanceName) {
    Object.keys(localClientStats).forEach(key => {
      if (localClientStats[key].instance_name === instanceName) {
        delete localClientStats[key];
      }
    });
    if (process.env.DATABASE_URL) {
      runPgQuery('DELETE FROM client_stats WHERE instance_name = $1;', [instanceName]).catch(() => {});
    }
  } else {
    localClientStats = {};
    if (process.env.DATABASE_URL) {
      runPgQuery('DELETE FROM client_stats;').catch(() => {});
    }
  }
}

async function getClientStats(instanceName = 'default') {
  if (process.env.DATABASE_URL) {
    try {
      const res = await runPgQuery(
        'SELECT * FROM client_stats WHERE instance_name = $1 ORDER BY client_name ASC;',
        [instanceName]
      );
      return res.rows || [];
    } catch (err) {
      console.error("SYSTEM: getClientStats error:", err.message);
      return [];
    }
  }
  return Object.values(localClientStats).filter(c => c.instance_name === instanceName);
}

async function updateClientTick(clientName, instanceName, clientId, adId, adTitle, status, lastTickTime) {
  if (process.env.DATABASE_URL) {
    try {
      const query = `
        INSERT INTO client_stats (client_name, instance_name, client_id, ad_id, ad_title, ticks, last_status, last_tick_time, updated_at)
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7, NOW())
        ON CONFLICT (client_name) DO UPDATE SET
          instance_name = EXCLUDED.instance_name,
          client_id = EXCLUDED.client_id,
          ad_id = EXCLUDED.ad_id,
          ad_title = EXCLUDED.ad_title,
          ticks = client_stats.ticks + 1,
          last_status = EXCLUDED.last_status,
          last_tick_time = EXCLUDED.last_tick_time,
          updated_at = NOW();
      `;
      await runPgQuery(query, [clientName, instanceName, clientId, adId, adTitle, status, lastTickTime]);
    } catch (err) {
      console.error("SYSTEM: updateClientTick DB error:", err.message);
    }
  } else {
    if (!localClientStats[clientName]) {
      localClientStats[clientName] = {
        client_name: clientName,
        instance_name: instanceName,
        client_id: clientId,
        ad_id: adId,
        ad_title: adTitle,
        ticks: 1,
        billing_count: 0,
        revenue_usd: 0,
        last_status: status,
        last_tick_time: lastTickTime,
        updated_at: new Date().toISOString()
      };
    } else {
      const c = localClientStats[clientName];
      c.instance_name = instanceName;
      c.client_id = clientId;
      c.ad_id = adId;
      c.ad_title = adTitle;
      c.ticks = (c.ticks || 0) + 1;
      c.last_status = status;
      c.last_tick_time = lastTickTime;
      c.updated_at = new Date().toISOString();
    }
  }
}

async function updateClientAd(clientName, instanceName, clientId, adId, adTitle, status) {
  if (process.env.DATABASE_URL) {
    try {
      const query = `
        INSERT INTO client_stats (client_name, instance_name, client_id, ad_id, ad_title, ticks, last_status, updated_at)
        VALUES ($1, $2, $3, $4, $5, 0, $6, NOW())
        ON CONFLICT (client_name) DO UPDATE SET
          instance_name = EXCLUDED.instance_name,
          client_id = EXCLUDED.client_id,
          ad_id = EXCLUDED.ad_id,
          ad_title = EXCLUDED.ad_title,
          last_status = CASE 
            WHEN client_stats.last_status = 'Stopped' OR client_stats.last_status = 'inactive' OR client_stats.last_status IS NULL THEN EXCLUDED.last_status
            ELSE client_stats.last_status
          END,
          updated_at = NOW();
      `;
      await runPgQuery(query, [clientName, instanceName, clientId, adId, adTitle, status]);
    } catch (err) {
      console.error("SYSTEM: updateClientAd DB error:", err.message);
    }
  } else {
    if (!localClientStats[clientName]) {
      localClientStats[clientName] = {
        client_name: clientName,
        instance_name: instanceName,
        client_id: clientId,
        ad_id: adId,
        ad_title: adTitle,
        ticks: 0,
        billing_count: 0,
        revenue_usd: 0,
        last_status: status,
        last_tick_time: 'Never',
        updated_at: new Date().toISOString()
      };
    } else {
      const c = localClientStats[clientName];
      c.instance_name = instanceName;
      c.client_id = clientId;
      c.ad_id = adId;
      c.ad_title = adTitle;
      if (c.last_status === 'Stopped' || c.last_status === 'inactive' || !c.last_status) {
        c.last_status = status;
      }
      c.updated_at = new Date().toISOString();
    }
  }
}

async function updateClientStatus(clientName, instanceName, clientId, adId, adTitle, status, lastTickTime) {
  if (process.env.DATABASE_URL) {
    try {
      const query = `
        INSERT INTO client_stats (client_name, instance_name, client_id, ad_id, ad_title, ticks, last_status, last_tick_time, updated_at)
        VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NOW())
        ON CONFLICT (client_name) DO UPDATE SET
          instance_name = EXCLUDED.instance_name,
          client_id = COALESCE(EXCLUDED.client_id, client_stats.client_id),
          ad_id = COALESCE(EXCLUDED.ad_id, client_stats.ad_id),
          ad_title = COALESCE(EXCLUDED.ad_title, client_stats.ad_title),
          last_status = EXCLUDED.last_status,
          last_tick_time = EXCLUDED.last_tick_time,
          updated_at = NOW();
      `;
      await runPgQuery(query, [clientName, instanceName, clientId, adId, adTitle, status, lastTickTime]);
    } catch (err) {
      console.error("SYSTEM: updateClientStatus DB error:", err.message);
    }
  } else {
    if (!localClientStats[clientName]) {
      localClientStats[clientName] = {
        client_name: clientName,
        instance_name: instanceName,
        client_id: clientId,
        ad_id: adId,
        ad_title: adTitle,
        ticks: 0,
        billing_count: 0,
        revenue_usd: 0,
        last_status: status,
        last_tick_time: lastTickTime,
        updated_at: new Date().toISOString()
      };
    } else {
      const c = localClientStats[clientName];
      if (clientId) c.client_id = clientId;
      if (adId) c.ad_id = adId;
      if (adTitle) c.ad_title = adTitle;
      c.last_status = status;
      c.last_tick_time = lastTickTime;
      c.updated_at = new Date().toISOString();
    }
  }
}

async function updateClientBilling(clientName, instanceName, status, isSuccess, billRevenue = 0.0001) {
  if (process.env.DATABASE_URL) {
    try {
      const incrementBilling = isSuccess ? 1 : 0;
      const revToAdd = isSuccess ? billRevenue : 0;
      const query = `
        INSERT INTO client_stats (client_name, instance_name, billing_count, revenue_usd, last_status, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (client_name) DO UPDATE SET
          instance_name = COALESCE(client_stats.instance_name, EXCLUDED.instance_name),
          billing_count = client_stats.billing_count + $3,
          revenue_usd = client_stats.revenue_usd + $4,
          last_status = EXCLUDED.last_status,
          updated_at = NOW();
      `;
      await runPgQuery(query, [clientName, instanceName, incrementBilling, revToAdd, status]);
    } catch (err) {
      console.error("SYSTEM: updateClientBilling DB error:", err.message);
    }
  } else {
    if (localClientStats[clientName]) {
      if (isSuccess) {
        localClientStats[clientName].billing_count = (localClientStats[clientName].billing_count || 0) + 1;
        localClientStats[clientName].revenue_usd = (localClientStats[clientName].revenue_usd || 0) + billRevenue;
      }
      localClientStats[clientName].last_status = status;
      localClientStats[clientName].updated_at = new Date().toISOString();
    }
  }
}

async function distributeClientRevenue(clientNames, amountUsd) {
  if (clientNames.length > 0 && amountUsd > 0) {
    if (process.env.DATABASE_URL) {
      try {
        const share = amountUsd / clientNames.length;
        const query = `
          UPDATE client_stats 
          SET revenue_usd = revenue_usd + $1, updated_at = NOW()
          WHERE client_name = ANY($2);
        `;
        await runPgQuery(query, [share, clientNames]);
        console.log(`SYSTEM: Distributed $${amountUsd} revenue to clients:`, clientNames);
      } catch (err) {
        console.error("SYSTEM: distributeClientRevenue DB error:", err.message);
      }
    } else {
      const share = amountUsd / clientNames.length;
      clientNames.forEach(name => {
        if (localClientStats[name]) {
          localClientStats[name].revenue_usd = (localClientStats[name].revenue_usd || 0) + share;
        }
      });
      console.log(`SYSTEM: Distributed $${amountUsd} revenue in-memory to clients:`, clientNames);
    }
  }
}

// Revenue attribution deduplication helpers
async function getLastDistributedMicros(profileName) {
  if (process.env.DATABASE_URL) {
    try {
      const res = await runPgQuery(
        'SELECT last_distributed_lifetime_micros FROM revenue_attribution WHERE profile_name = $1;',
        [profileName]
      );
      if (res.rows && res.rows.length > 0) {
        return parseInt(res.rows[0].last_distributed_lifetime_micros, 10) || 0;
      }
    } catch (err) {
      console.error("SYSTEM: getLastDistributedMicros error:", err.message);
    }
  }
  return 0;
}

async function setLastDistributedMicros(profileName, micros) {
  if (process.env.DATABASE_URL) {
    try {
      await runPgQuery(
        `INSERT INTO revenue_attribution (profile_name, last_distributed_lifetime_micros, last_distributed_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (profile_name) DO UPDATE SET
           last_distributed_lifetime_micros = EXCLUDED.last_distributed_lifetime_micros,
           last_distributed_at = NOW();`,
        [profileName, micros]
      );
    } catch (err) {
      console.error("SYSTEM: setLastDistributedMicros error:", err.message);
    }
  }
}

module.exports = { 
  loadConfig, 
  saveConfig, 
  saveRevenueHistory, 
  getRevenueHistory,
  getClientStats,
  updateClientTick,
  updateClientStatus,
  updateClientAd,
  updateClientBilling,
  distributeClientRevenue,
  clearLocalClientStats,
  runPgQuery,
  getPgClient,
  getLastDistributedMicros,
  setLastDistributedMicros
};
