require('dotenv').config();
const express = require('express');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const KICKBACKS_BASE = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";

async function syncAccountConsent(accessToken) {
  if (!accessToken) return;
  try {
    let tosVersion = "2026-05-17";
    try {
      const getRes = await fetch(`${KICKBACKS_BASE}/v1/me/consent`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        if (getData?.current_tos_version) {
          tosVersion = getData.current_tos_version;
        }
      }
    } catch (_) {}

    await fetch(`${KICKBACKS_BASE}/v1/me/consent`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ tos_accepted_version: tosVersion, accepted: true, telemetry_opt_in: true })
    });

    await fetch(`${KICKBACKS_BASE}/v1/me/consent/scopes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        scopes: {
          kickbacks_consent: true,
          boosted_ack: true,
          ephemeral_targeting: true,
          third_party_sharing: true,
          profile_retention: true
        },
        boosted_ack: { accepted: true, version: "v2-scopes-3" }
      })
    });
    console.log(`SYSTEM: Account consent synchronized (TOS: ${tosVersion}, telemetry_opt_in: true).`);
  } catch (consentErr) {
    console.warn("SYSTEM: Consent auto-accept warning:", consentErr.message);
  }
}
const loginSessions = new Map();

// Periodic cleanup of sessions older than 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of loginSessions.entries()) {
    if (now - session.createdAt > 15 * 60 * 1000) {
      loginSessions.delete(sessionId);
    }
  }
}, 60 * 1000);
const { 
  loadConfig, 
  saveRevenueHistory, 
  getRevenueHistory,
  getClientStats,
  updateClientTick,
  updateClientStatus,
  updateClientAd,
  updateClientBilling,
  distributeClientRevenue,
  clearLocalClientStats,
  getLastDistributedMicros,
  setLastDistributedMicros
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Ankitsin';

// OpenAPI 3.0 Document Specification
const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "Kickbacks API",
    version: "1.0.0"
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer"
      }
    }
  },
  security: [
    {
      BearerAuth: []
    }
  ],
  paths: {
    "/": {
      get: {
        summary: "Check backend status",
        security: [],
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/login": {
      post: {
        summary: "Verify dashboard password",
        security: [],
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/status": {
      get: {
        summary: "Retrieve aggregated simulator state",
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/start": {
      post: {
        summary: "Start simulator process",
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/stop": {
      post: {
        summary: "Stop simulator process",
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/clear-logs": {
      post: {
        summary: "Clear backend logs buffer",
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/config": {
      get: {
        summary: "Get configuration JSON profiles list",
        responses: {
          200: {
            description: "Success"
          }
        }
      },
      post: {
        summary: "Save configuration JSON profiles list",
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    },
    "/api/revenue-history": {
      get: {
        summary: "Get revenue history snapshots",
        responses: {
          200: {
            description: "Success"
          }
        }
      }
    }
  }
};

// Authentication Middleware
function checkAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  if (token !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(express.json());

// Global CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Production Security Headers
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  next();
});

let simulatorProcess = null;
let logs = [];
let profiles = {};
let billedClients = []; // In-memory queue to attribute actual revenue
const IS_ATTRIBUTION_INSTANCE = (process.env.INSTANCE_NAME || 'instance_1') === 'instance_1';

function appendLog(message) {
  const logLine = {
    time: new Date().toLocaleTimeString(),
    message: message.trim()
  };
  logs.push(logLine);
  if (logs.length > 500) logs.shift();
}

// --- DYNAMIC FLEET SCALER: FULL HARVEST -> 2 BOTS/ACC AFTER $1.12 -> 6 AM RETRIGGER ---
const CAP_THRESHOLD_USD = process.env.DAILY_CAP_THRESHOLD ? parseFloat(process.env.DAILY_CAP_THRESHOLD) : 1.12;
const LOW_POWER_BOTS_PER_ACCOUNT = 2;

let isLowPowerMode = false;
let lowPowerTriggeredAt = 0;
let autoRetriggerTimer = null;
let isDailyCapped = false;

function getMsUntilNext6AM() {
  const now = new Date();
  // IST is UTC+5:30. 6:00 AM IST is 00:30 UTC.
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 30, 0, 0
  ));
  if (now.getTime() >= nextReset.getTime()) {
    nextReset.setUTCDate(nextReset.getUTCDate() + 1);
  }
  return nextReset.getTime() - now.getTime();
}

function scheduleRetriggerAt6AM() {
  if (autoRetriggerTimer) clearTimeout(autoRetriggerTimer);

  const msUntilRetrigger = getMsUntilNext6AM();
  const hours = (msUntilRetrigger / 3600000).toFixed(2);
  const targetDate = new Date(Date.now() + msUntilRetrigger);
  const targetTimeStr = targetDate.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

  appendLog(`[Auto-Scheduler] ⏰ Fleet scheduled to retrigger to FULL SCALE at 06:00 AM IST (in ${hours} hrs at ${targetTimeStr} IST).`);
  console.log(`[Auto-Scheduler] ⏰ Fleet scheduled to retrigger to FULL SCALE at 06:00 AM IST (in ${hours} hrs).`);

  autoRetriggerTimer = setTimeout(() => {
    retriggerFullScaleFleet();
  }, msUntilRetrigger);
}

function retriggerFullScaleFleet() {
  appendLog(`[Auto-Scheduler] 🌅 06:00 AM IST reached! UTC day has reset. Retriggering fleet to FULL SCALE (fast harvest mode)...<br/>`);
  console.log(`[Auto-Scheduler] 🌅 06:00 AM IST reached! Retriggering fleet to FULL SCALE...`);
  
  isLowPowerMode = false;
  // Reset today initial counters for fresh UTC tracking
  for (const key of Object.keys(profiles)) {
    profiles[key].initialTodayMicros = 0;
    profiles[key].earnedTodayRun = 0;
  }
  
  stopSimulator();
  setTimeout(() => {
    startSimulator();
  }, 2000);
}

// Backup interval check every 60 seconds for 6:00 AM IST
setInterval(() => {
  if (isLowPowerMode) {
    const now = new Date();
    // 6:00 AM IST = 00:30 UTC
    const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
    const istMinutes = (now.getUTCMinutes() + 30) % 60;
    
    // If between 6:00 AM and 6:05 AM IST, and has been in low power mode for at least 20 minutes
    if (istHours === 6 && istMinutes <= 5 && (Date.now() - lowPowerTriggeredAt > 20 * 60 * 1000)) {
      retriggerFullScaleFleet();
    }
  }
}, 60 * 1000);

async function checkDailyPayoutCap() {
  if (isLowPowerMode || !simulatorProcess) return;

  let configuredCount = 7;
  try {
    const rawConfig = await loadConfig();
    if (Array.isArray(rawConfig) && rawConfig.length > 0) {
      configuredCount = rawConfig.length;
    }
  } catch (_) {}

  const profList = Object.values(profiles);
  if (profList.length < configuredCount) return;

  // Count how many accounts have reached $1.12
  const cappedCount = profList.filter(p => (p.currentTodayUsd || 0) >= CAP_THRESHOLD_USD).length;
  const totalToday = profList.reduce((sum, p) => sum + (p.currentTodayUsd || 0), 0);
  const targetThresholdTotal = configuredCount * CAP_THRESHOLD_USD;

  // If all accounts are >= 1.12 OR total fleet today is >= configuredCount * 1.12:
  if (cappedCount >= configuredCount || totalToday >= targetThresholdTotal) {
    isLowPowerMode = true;
    lowPowerTriggeredAt = Date.now();

    const banner = `\n========================================================================\n⚡ $1.12 DAILY THRESHOLD REACHED: Accounts reached ~$1.12+ today ($${totalToday.toFixed(2)} total).\n📉 Reducing fleet to 2 BOTS PER ACCOUNT (low-power trickle mode to save 90% bandwidth while capturing $1.30+ tail bonuses).\n⏰ Fleet will automatically retrigger to FULL SCALE at 06:00 AM IST.\n========================================================================`;
    console.log(banner);
    appendLog(banner);

    // Restart simulator in low-power mode (2 bots per account)
    stopSimulator();
    scheduleRetriggerAt6AM();

    setTimeout(() => {
      startSimulator();
    }, 2000);
  }
}

function startSimulator() {
  isDailyCapped = false;
  if (autoRetriggerTimer) { clearTimeout(autoRetriggerTimer); autoRetriggerTimer = null; }
  if (simulatorProcess) return false;

  clearLocalClientStats(process.env.INSTANCE_NAME || 'default');
  appendLog("SYSTEM: Starting simulator process...");
  
  appendLog(`SYSTEM: Starting simulator process (mode: ${isLowPowerMode ? 'Low-Power 2 bots/account' : 'Full Scale'})...`);
  
  const env = {
    ...process.env,
    ACTIVE_BOTS_OVERRIDE: isLowPowerMode ? String(LOW_POWER_BOTS_PER_ACCOUNT) : ''
  };

  // Fork simulator.js located in the same directory
  simulatorProcess = fork(path.join(__dirname, 'simulator.js'), [], {
    silent: true,
    env
  });

  simulatorProcess.stdout.on('data', (data) => {
    const line = data.toString();
    appendLog(line);
  });

  simulatorProcess.stderr.on('data', (data) => {
    const line = data.toString();
    appendLog(`ERROR: ${line}`);
  });

  simulatorProcess.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'earnings') {
      const { profileName, todayUsd, lifetimeUsd, todayMicros, lifetimeMicros, blocked } = msg;
      
      const lastTodayMicros = profiles[profileName]?.currentTodayMicros;
      const lastLifetimeMicros = profiles[profileName]?.currentLifetimeMicros;

      const currentTodayUsdCalc = (todayMicros || 0) / 1000000;
      const currentLifetimeUsdCalc = (lifetimeMicros || 0) / 1000000;

      if (!profiles[profileName]) {
        profiles[profileName] = {
          name: profileName,
          initialTodayUsd: currentTodayUsdCalc,
          initialLifetimeUsd: currentLifetimeUsdCalc,
          initialTodayMicros: todayMicros,
          initialLifetimeMicros: lifetimeMicros,
          currentTodayUsd: currentTodayUsdCalc,
          currentLifetimeUsd: currentLifetimeUsdCalc,
          currentTodayMicros: todayMicros,
          currentLifetimeMicros: lifetimeMicros,
          blocked,
          earnedTodayRun: 0,
          earnedLifetimeRun: 0
        };
      } else {
        const prof = profiles[profileName];
        prof.currentTodayUsd = currentTodayUsdCalc;
        prof.currentLifetimeUsd = currentLifetimeUsdCalc;
        prof.currentTodayMicros = todayMicros;
        prof.currentLifetimeMicros = lifetimeMicros;
        prof.blocked = blocked;
        
        prof.earnedTodayRun = Math.max(0, (todayMicros - prof.initialTodayMicros) / 1000000);
        prof.earnedLifetimeRun = Math.max(0, (lifetimeMicros - prof.initialLifetimeMicros) / 1000000);
      }

      const nowTime = Date.now();
      const prof = profiles[profileName];
      if (prof && (!prof.lastLoggedDbTime || (nowTime - prof.lastLoggedDbTime >= 60 * 1000))) {
        prof.lastLoggedDbTime = nowTime;
        saveRevenueHistory(profileName, currentTodayUsdCalc, currentLifetimeUsdCalc).catch(err => {
          console.error("SYSTEM: Error logging revenue history snapshot:", err.message);
        });
      }

      checkDailyPayoutCap();
    } else if (msg.type === 'client_ad') {
      const { clientName, clientId, adId, adTitle } = msg;
      updateClientAd(clientName, process.env.INSTANCE_NAME || 'default', clientId, adId, adTitle, 'Success').catch(err => {
        console.error("SYSTEM: Error updating client ad in DB:", err.message);
      });
    } else if (msg.type === 'client_tick') {
      const { clientName, clientId, adId, adTitle, status } = msg;
      const lastTickTime = new Date().toLocaleTimeString();
      let statusStr = 'Success';
      if (typeof status === 'string') {
        statusStr = status;
      } else if (status === 200 || status === 204) {
        statusStr = 'Success';
      } else if (status) {
        statusStr = `HTTP Error (${status})`;
      }

      const isStatusOnly = statusStr.includes('Next prompt') || statusStr.includes('Rotating') || statusStr.includes('cooldown') || statusStr.includes('Waiting');
      if (isStatusOnly) {
        updateClientStatus(clientName, process.env.INSTANCE_NAME || 'default', clientId, adId, adTitle, statusStr, lastTickTime).catch(err => {
          console.error("SYSTEM: Error updating client status in DB:", err.message);
        });
      } else {
        updateClientTick(clientName, process.env.INSTANCE_NAME || 'default', clientId, adId, adTitle, statusStr, lastTickTime).catch(err => {
          console.error("SYSTEM: Error updating client tick in DB:", err.message);
        });
      }
    } else if (msg.type === 'client_billing') {
      const { clientName, status, billed, measurement } = msg;
      const isHttpSuccess = (status === 200 || status === 204);
      const isActuallyBilled = Boolean((billed || measurement === 'measured' || measurement === 'accepted') && isHttpSuccess);
      const statusStr = isActuallyBilled 
        ? 'Billed (Confirmed)'
        : (isHttpSuccess ? 'Measured (Accepted)' : `Billing Error (${status})`);
      const instanceName = process.env.INSTANCE_NAME || 'default';
      
      updateClientBilling(clientName, instanceName, statusStr, isActuallyBilled, 0.0001).catch(err => {
        console.error("SYSTEM: Error updating client billing in DB:", err.message);
      });

      const nowTime = Date.now();
      const profName = Object.keys(profiles)[0] || process.env.INSTANCE_NAME || 'default';
      const prof = profiles[profName];
      if (prof && (!prof.lastLoggedDbTime || (nowTime - prof.lastLoggedDbTime >= 60 * 1000))) {
        prof.lastLoggedDbTime = nowTime;
        saveRevenueHistory(profName, prof.currentTodayUsd || 0, prof.currentLifetimeUsd || 0).catch(() => {});
      }

      if (isActuallyBilled) {
        if (!billedClients.includes(clientName)) {
          billedClients.push(clientName);
        }
      }
    }
  });

  simulatorProcess.on('exit', (code, signal) => {
    appendLog(`SYSTEM: Simulator process exited (code: ${code}, signal: ${signal})`);
    simulatorProcess = null;
    
    // Reset client statuses in DB
    const { runPgQuery } = require('./db');
    const exitStatus = isDailyCapped ? 'Capped (Auto-resumes at 06:00 AM)' : 'Stopped';
    runPgQuery(
      "UPDATE client_stats SET last_status = $1, updated_at = NOW() WHERE instance_name = $2;",
      [exitStatus, process.env.INSTANCE_NAME || 'default']
    ).catch(err => {
      console.error("SYSTEM: Error updating exit statuses in DB:", err.message);
    });
  });

  return true;
}

function stopSimulator() {
  if (!simulatorProcess) return false;
  appendLog("SYSTEM: Stopping simulator process...");
  simulatorProcess.kill('SIGINT');
  return true;
}

// Auto-start is handled after DB/config initialization in app.listen


// Reset this instance's clients in DB to Stopped on boot in case of crash
loadConfig().then(() => {
  const { runPgQuery } = require('./db');
  runPgQuery(
    "UPDATE client_stats SET last_status = 'Stopped', updated_at = NOW() WHERE instance_name = $1;",
    [process.env.INSTANCE_NAME || 'default']
  ).catch(err => {
    // Ignore error
  });
});

const frontendDist = path.join(__dirname, '../frontend/dist');
const hasFrontendDist = fs.existsSync(path.join(frontendDist, 'index.html'));

if (hasFrontendDist) {
  app.use(express.static(frontendDist));
}

// Health/Status API Check
app.get('/api/health', (req, res) => {
  res.json({
    status: "online",
    message: "Kickbacks Simulator Backend API is running.",
    instanceName: process.env.INSTANCE_NAME || 'default',
    running: simulatorProcess !== null
  });
});

app.get('/', (req, res) => {
  if (hasFrontendDist) {
    return res.sendFile(path.join(frontendDist, 'index.html'));
  }
  res.json({
    status: "online",
    message: "Kickbacks Simulator Backend API is running.",
    instanceName: process.env.INSTANCE_NAME || 'default',
    running: simulatorProcess !== null
  });
});

// Swagger UI Docs handler (CDN backed)
app.get(['/docs', '/dos'], (req, res) => {
  const specJsonStr = JSON.stringify(openApiSpec);
  const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        spec: ${specJsonStr},
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(swaggerHtml);
});

// Authentication checks
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/status', checkAuth, async (req, res) => {
  let configProfiles = [];
  try {
    configProfiles = await loadConfig();
  } catch (err) {
    // Ignore error
  }

  let dbClients = [];
  try {
    dbClients = await getClientStats(process.env.INSTANCE_NAME || 'default');
  } catch (err) {
    console.error("SYSTEM: Failed to load client stats from DB:", err.message);
  }

  // Aggregate totals
  const clientRevenueTotal = dbClients.reduce((sum, c) => sum + (parseFloat(c.revenue_usd) || 0), 0);
  const totalBillingCount = dbClients.reduce((sum, c) => sum + (parseInt(c.billing_count) || 0), 0);

  // Real earnings from Kickbacks /v1/earnings API (the OFFICIAL numbers)
  let realTodayUsd = 0;
  let realLifetimeUsd = 0;
  let realTodayMicros = 0;
  let realLifetimeMicros = 0;

  // Session-earned delta (real earnings gained since this run started)
  let sessionEarnedToday = 0;
  let sessionEarnedLifetime = 0;

  const enhancedProfiles = Object.values(profiles).map(p => {
    realTodayUsd += (p.currentTodayUsd || 0);
    realLifetimeUsd += (p.currentLifetimeUsd || 0);
    realTodayMicros += (p.currentTodayMicros || 0);
    realLifetimeMicros += (p.currentLifetimeMicros || 0);
    sessionEarnedToday += (p.earnedTodayRun || 0);
    sessionEarnedLifetime += (p.earnedLifetimeRun || 0);
    return {
      ...p,
      // Keep real values, don't inflate with fake estimates
      earnedTodayRun: p.earnedTodayRun || 0,
      currentTodayUsd: p.currentTodayUsd || 0,
      currentLifetimeUsd: p.currentLifetimeUsd || 0
    };
  });

  res.json({
    running: simulatorProcess !== null,
    instanceName: process.env.INSTANCE_NAME || 'default',
    configProfiles,
    profiles: enhancedProfiles,
    // Real earnings from Kickbacks official API
    realEarnings: {
      todayUsd: realTodayUsd,
      lifetimeUsd: realLifetimeUsd,
      todayMicros: realTodayMicros,
      lifetimeMicros: realLifetimeMicros,
      sessionEarnedToday,
      sessionEarnedLifetime
    },
    // Local estimated revenue (billing_count * $0.0001 — NOT real money)
    estimatedRevenue: {
      total: clientRevenueTotal,
      totalBillingCount
    },
    clients: dbClients.map(c => ({
      name: c.client_name,
      instanceName: c.instance_name,
      clientId: c.client_id,
      adTitle: c.ad_title,
      adId: c.ad_id,
      ticks: c.ticks,
      billing_count: c.billing_count,
      revenue_usd: c.revenue_usd,
      lastStatus: c.last_status,
      lastTickTime: c.last_tick_time,
      updatedAt: c.updated_at
    })),
    totals: {
      realTodayUsd: realTodayUsd.toFixed(6),
      realLifetimeUsd: realLifetimeUsd.toFixed(6),
      sessionEarnedToday: sessionEarnedToday.toFixed(6),
      sessionEarnedLifetime: sessionEarnedLifetime.toFixed(6),
      estimatedRevenue: clientRevenueTotal.toFixed(6),
      totalBillingCount
    },
    isLowPowerMode,
    isDailyCapped: isLowPowerMode,
    fleetMode: {
      isLowPowerMode,
      activeBotsPerAccount: isLowPowerMode ? LOW_POWER_BOTS_PER_ACCOUNT : 'Full Scale',
      thresholdUsd: CAP_THRESHOLD_USD,
      nextRetriggerAt: '06:00 AM IST',
      msUntilRetrigger: getMsUntilNext6AM()
    },
    logs
  });
});

app.post('/api/start', checkAuth, (req, res) => {
  try {
    if (req.body?.forceFullScale || req.query?.force === 'true') {
      isLowPowerMode = false;
      appendLog("SYSTEM: User forced FULL SCALE fleet mode.");
    }
    const success = startSimulator();
    res.json({ success, isLowPowerMode });
  } catch (err) {
    console.error("SYSTEM: Error in /api/start:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop', checkAuth, (req, res) => {
  const success = stopSimulator();
  res.json({ success });
});

app.post('/api/clear-logs', checkAuth, (req, res) => {
  logs = [];
  res.json({ success: true });
});

app.get('/api/config', checkAuth, async (req, res) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', checkAuth, async (req, res) => {
  try {
    const newConfig = req.body;
    if (!Array.isArray(newConfig)) {
      return res.status(400).json({ error: 'Config must be an array' });
    }
    const { saveConfig } = require('./db');
    await saveConfig(newConfig);
    
    // Automatically restart simulator to apply config changes
    appendLog("SYSTEM: Configuration updated via settings panel. Restarting simulator...");
    stopSimulator();
    setTimeout(() => {
      startSimulator();
    }, 1000);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/revenue-history', checkAuth, async (req, res) => {
  try {
    const history = await getRevenueHistory(24);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kickbacks Interactive Frontend Authentication & Account Management
app.post('/api/auth/start-login', checkAuth, async (req, res) => {
  try {
    const clientId = crypto.randomBytes(12).toString("hex");
    const startRes = await fetch(`${KICKBACKS_BASE}/v1/auth/extension/start?client_id=${clientId}`, {
      redirect: 'manual'
    });
    
    const loginUrl = startRes.headers.get('location');
    if (!loginUrl) {
      return res.status(502).json({ error: 'Failed to retrieve redirect URL from Kickbacks' });
    }

    const urlObj = new URL(loginUrl);
    const state = urlObj.searchParams.get("state");
    if (!state) {
      return res.status(502).json({ error: 'Failed to parse OAuth state from Kickbacks redirect' });
    }

    const { scale = 10 } = req.body || {};
    const sessionId = crypto.randomUUID();
    loginSessions.set(sessionId, {
      clientId,
      state,
      loginUrl,
      status: 'pending',
      scale: Math.max(1, parseInt(scale, 10) || 10),
      createdAt: Date.now()
    });

    res.json({
      sessionId,
      loginUrl,
      clientId
    });
  } catch (err) {
    console.error('SYSTEM: Error in start-login:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/poll-login/:sessionId', checkAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = loginSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.status === 'completed') {
    return res.json({ status: 'success', account: session.account });
  }

  try {
    const pollRes = await fetch(`${KICKBACKS_BASE}/v1/auth/extension/poll?state=${encodeURIComponent(session.state)}&client_id=${session.clientId}`);
    if (pollRes.status === 200) {
      const credentials = await pollRes.json();
      
      // 1. Auto-accept Terms of Service & Boosted Mode
      await syncAccountConsent(credentials.access_token);

      // 2. Append to fleet config
      const { saveConfig } = require('./db');
      const currentConfig = await loadConfig();
      const accountName = `account_${currentConfig.length + 1}_${session.clientId.slice(0, 6)}`;
      
      const newAccount = {
        name: accountName,
        clientId: session.clientId,
        refreshToken: credentials.refresh_token,
        scale: session.scale || 10,
        accessToken: credentials.access_token
      };

      currentConfig.push(newAccount);
      await saveConfig(currentConfig);

      session.status = 'completed';
      session.account = newAccount;

      // 3. Hot-restart simulator fleet
      appendLog(`SYSTEM: New Kickbacks account '${accountName}' successfully authenticated! Restarting fleet...`);
      stopSimulator();
      setTimeout(() => startSimulator(), 1000);

      return res.json({ status: 'success', account: newAccount });
    } else if (pollRes.status === 425 || pollRes.status === 202) {
      return res.json({ status: 'pending' });
    } else {
      return res.json({ status: 'waiting', code: pollRes.status });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/add-account', checkAuth, async (req, res) => {
  try {
    const { name, refreshToken, scale = 10, isSimulated } = req.body;
    const { saveConfig } = require('./db');
    const currentConfig = await loadConfig();

    let cleanToken = refreshToken ? refreshToken.trim() : '';
    let clientId = crypto.randomBytes(12).toString("hex");
    let accessToken = null;
    let isSim = Boolean(isSimulated || req.body.type === 'simulated' || !cleanToken || cleanToken === 'simulated');

    if (isSim) {
      cleanToken = cleanToken || `simulated_refresh_${clientId}`;
      accessToken = `simulated_access_${clientId}`;
    } else {
      // Verify real refresh token with Kickbacks API
      const refRes = await fetch(`${KICKBACKS_BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: cleanToken })
      });

      if (!refRes.ok) {
        return res.status(400).json({
          error: `Kickbacks rejected token (HTTP ${refRes.status}). Token may be invalid or expired. You can also toggle 'Simulated Account' to test without an active token.`
        });
      }

      const tokenData = await refRes.json();
      cleanToken = tokenData.refresh_token || cleanToken;
      accessToken = tokenData.access_token || null;

      // Auto-accept consent with fresh access token
      if (accessToken) {
        await syncAccountConsent(accessToken);
      }
    }

    const accountName = (name && name.trim()) || `${isSim ? 'sim_bot' : 'account'}_${currentConfig.length + 1}_${clientId.slice(0, 6)}`;
    
    // Check if account name already exists
    const existingIdx = currentConfig.findIndex(c => c.name === accountName);
    const newAccount = {
      name: accountName,
      clientId,
      refreshToken: cleanToken,
      scale: Math.max(1, parseInt(scale, 10) || 10),
      minPromptWait: Math.max(1, parseInt(req.body.minPromptWait, 10) || 8),
      maxPromptWait: Math.max(1, parseInt(req.body.maxPromptWait, 10) || 15),
      sessionDuration: Math.max(15, parseInt(req.body.sessionDuration, 10) || 60),
      accessToken,
      isSimulated: isSim
    };

    if (existingIdx >= 0) {
      currentConfig[existingIdx] = newAccount;
    } else {
      currentConfig.push(newAccount);
    }

    await saveConfig(currentConfig);

    appendLog(`SYSTEM: Account '${accountName}' (${isSim ? 'Simulated' : 'Real Kickbacks'}) saved with ${newAccount.scale} bots. Restarting simulator fleet...`);
    stopSimulator();
    setTimeout(() => startSimulator(), 1000);

    res.json({ success: true, account: newAccount, totalAccounts: currentConfig.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/account/:accountName/scale', checkAuth, async (req, res) => {
  try {
    const { accountName } = req.params;
    const { scale } = req.body;
    const parsedScale = parseInt(scale, 10);
    if (isNaN(parsedScale) || parsedScale < 1) {
      return res.status(400).json({ error: 'scale must be a positive integer (minimum 1)' });
    }
    const { saveConfig } = require('./db');
    const currentConfig = await loadConfig();
    const accIdx = currentConfig.findIndex(c => c.name === accountName);
    if (accIdx < 0) {
      return res.status(404).json({ error: `Account '${accountName}' not found` });
    }

    currentConfig[accIdx].scale = parsedScale;
    await saveConfig(currentConfig);

    appendLog(`SYSTEM: Scaled account '${accountName}' to ${parsedScale} bots. Restarting fleet...`);
    stopSimulator();
    setTimeout(() => startSimulator(), 1000);

    res.json({ success: true, scale: parsedScale, account: currentConfig[accIdx], config: currentConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/fleet-scale', checkAuth, async (req, res) => {
  try {
    const { scale } = req.body;
    const parsedScale = parseInt(scale, 10);
    if (isNaN(parsedScale) || parsedScale < 1) {
      return res.status(400).json({ error: 'scale must be a positive integer (minimum 1)' });
    }
    const { saveConfig } = require('./db');
    const currentConfig = await loadConfig();

    currentConfig.forEach(acc => {
      acc.scale = parsedScale;
    });

    await saveConfig(currentConfig);

    appendLog(`SYSTEM: Scaled ALL ${currentConfig.length} accounts to ${parsedScale} bots each (${currentConfig.length * parsedScale} total bots). Restarting fleet...`);
    stopSimulator();
    setTimeout(() => startSimulator(), 1000);

    res.json({ success: true, scale: parsedScale, totalBots: currentConfig.length * parsedScale, config: currentConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/account/:accountName/settings', checkAuth, async (req, res) => {
  try {
    const { accountName } = req.params;
    const { scale, minPromptWait, maxPromptWait, sessionDuration } = req.body;
    const { saveConfig } = require('./db');
    const currentConfig = await loadConfig();
    const accIdx = currentConfig.findIndex(c => c.name === accountName);
    if (accIdx < 0) {
      return res.status(404).json({ error: `Account '${accountName}' not found` });
    }

    if (scale !== undefined) {
      const parsedScale = parseInt(scale, 10);
      if (!isNaN(parsedScale) && parsedScale > 0) {
        currentConfig[accIdx].scale = parsedScale;
      }
    }
    if (minPromptWait !== undefined) {
      const parsedMin = parseInt(minPromptWait, 10);
      if (!isNaN(parsedMin) && parsedMin >= 1) {
        currentConfig[accIdx].minPromptWait = parsedMin;
      }
    }
    if (maxPromptWait !== undefined) {
      const parsedMax = parseInt(maxPromptWait, 10);
      if (!isNaN(parsedMax) && parsedMax >= 1) {
        currentConfig[accIdx].maxPromptWait = parsedMax;
      }
    }
    if (sessionDuration !== undefined) {
      const parsedDuration = parseInt(sessionDuration, 10);
      if (!isNaN(parsedDuration) && parsedDuration >= 10) {
        currentConfig[accIdx].sessionDuration = parsedDuration;
      }
    }

    await saveConfig(currentConfig);

    appendLog(`SYSTEM: Settings updated for account '${accountName}' (scale: ${currentConfig[accIdx].scale}, wait: ${currentConfig[accIdx].minPromptWait || 8}-${currentConfig[accIdx].maxPromptWait || 15}s, session: ${currentConfig[accIdx].sessionDuration || 60}s). Restarting fleet...`);
    stopSimulator();
    setTimeout(() => startSimulator(), 1000);

    res.json({ success: true, account: currentConfig[accIdx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/fleet-settings', checkAuth, async (req, res) => {
  try {
    const { scale, minPromptWait, maxPromptWait, sessionDuration } = req.body;
    const { saveConfig } = require('./db');
    const currentConfig = await loadConfig();

    currentConfig.forEach(acc => {
      if (scale !== undefined && parseInt(scale, 10) > 0) acc.scale = parseInt(scale, 10);
      if (minPromptWait !== undefined && parseInt(minPromptWait, 10) >= 1) acc.minPromptWait = parseInt(minPromptWait, 10);
      if (maxPromptWait !== undefined && parseInt(maxPromptWait, 10) >= 1) acc.maxPromptWait = parseInt(maxPromptWait, 10);
      if (sessionDuration !== undefined && parseInt(sessionDuration, 10) >= 10) acc.sessionDuration = parseInt(sessionDuration, 10);
    });

    await saveConfig(currentConfig);

    appendLog(`SYSTEM: Fleet-wide settings updated across all ${currentConfig.length} accounts. Restarting fleet...`);
    stopSimulator();
    setTimeout(() => startSimulator(), 1000);

    res.json({ success: true, config: currentConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/auth/account/:accountName', checkAuth, async (req, res) => {
  try {
    const { accountName } = req.params;
    const { saveConfig } = require('./db');
    const currentConfig = await loadConfig();
    const updated = currentConfig.filter(c => c.name !== accountName);
    
    if (updated.length === currentConfig.length) {
      return res.status(404).json({ error: `Account '${accountName}' not found` });
    }

    await saveConfig(updated);
    delete profiles[accountName];
    clearLocalClientStats(process.env.INSTANCE_NAME || 'default');
    appendLog(`SYSTEM: Account '${accountName}' deleted. Fleet reset.`);
    stopSimulator();
    if (updated.length > 0) {
      setTimeout(() => startSimulator(), 1000);
    }

    res.json({ success: true, totalAccounts: updated.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Production Error Handlers
process.on('uncaughtException', (err) => {
  console.error('SYSTEM: Uncaught Exception:', err.stack || err);
  appendLog(`ERROR: Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('SYSTEM: Unhandled Rejection:', reason);
  appendLog(`ERROR: Unhandled Rejection: ${reason}`);
});

// Graceful Shutdown Handler
function gracefulShutdown(signal) {
  console.log(`\nSYSTEM: Received ${signal}. Starting graceful shutdown...`);
  appendLog(`SYSTEM: Received ${signal}. Stopping server...`);
  
  if (simulatorProcess) {
    console.log('SYSTEM: Stopping simulator subprocess...');
    simulatorProcess.kill('SIGINT');
  }
  
  setTimeout(() => {
    console.log('SYSTEM: Shutdown complete.');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Fallback for SPA routing
if (hasFrontendDist) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/docs') || req.path.startsWith('/dos')) {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, async () => {
  console.log(`\n🚀 Kickbacks Simulator Backend is live at http://localhost:${PORT}\n`);

  // Auto-start simulator on boot if config has accounts
  try {
    const config = await loadConfig();
    if (Array.isArray(config) && config.length > 0) {
      console.log(`SYSTEM: Auto-starting simulator with ${config.length} account(s)...`);
      startSimulator();
    } else {
      console.log('SYSTEM: No accounts configured. Use POST /api/start to begin.');
    }
  } catch (err) {
    console.error('SYSTEM: Auto-start check failed:', err.message);
  }
});
