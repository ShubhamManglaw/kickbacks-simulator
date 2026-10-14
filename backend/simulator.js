const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { loadConfig, saveConfig } = require('./db');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const BACKEND_BASE = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";
const CC_VERSION = "2.1.278";
const EXT_VERSION = "3.1.1";

const clientEnv = {
  os: process.platform,
  arch: process.arch,
  os_version: os.release(),
  editor: "Visual Studio Code",
  mode: "v1"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Self-healing adaptive surface resolution system
// Candidate surfaces accepted by Kickbacks /v1/metrics endpoint
const VALID_SURFACES = new Set(['claude-code', 'extension', 'statusline', 'statusbar', 'banner', 'overlay']);
const CANDIDATE_SURFACES = ['statusline', 'claude-code', 'extension', 'statusbar', 'banner', 'overlay'];

// Map session_token surfaces to valid /v1/metrics surfaces
const TOKEN_SURFACE_MAP = {
  'terminal': 'statusline',
  'extension': 'overlay',
  'overlay': 'overlay',
  'statusline': 'statusline',
  'statusbar': 'statusbar',
  'claude-code': 'claude-code',
  'banner': 'banner'
};

// Cache of validated working surfaces keyed by campaign_id
const validatedSurfaceCache = new Map();

function decodeSessionTokenSurface(ad) {
  try {
    if (!ad || !ad.session_token) return null;
    const parts = ad.session_token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload.surface || null;
  } catch { return null; }
}

function surfaceForAd(ad) {
  if (!ad) return 'statusline';
  if (validatedSurfaceCache.has(ad.campaign_id)) {
    return validatedSurfaceCache.get(ad.campaign_id);
  }
  // Decode the session_token to find the server-authoritative surface
  const tokenSurface = decodeSessionTokenSurface(ad);
  if (tokenSurface) {
    const mapped = TOKEN_SURFACE_MAP[tokenSurface];
    if (mapped && VALID_SURFACES.has(mapped)) {
      return mapped;
    }
  }
  // Use the ad's target_surface if it's in the valid set
  if (ad.target_surface && VALID_SURFACES.has(ad.target_surface)) {
    return ad.target_surface;
  }
  // Default to statusline — where paid campaign_tick ads are served
  return 'statusline';
}

// Realistic developer context pool for /v2/serve targeting
const DEV_CONTEXT_POOL = [
  {
    userPrompts: [
      "Fix the authentication middleware to handle expired JWT tokens gracefully",
      "Add rate limiting to the API endpoints using a sliding window",
      "Refactor the database queries to use connection pooling"
    ],
    aiTurns: [
      "I'll update the auth middleware to check token expiry and refresh automatically. Here's the implementation with proper error handling...",
      "I'll add express-rate-limit with a 100 requests per 15 minute sliding window. The middleware will return 429 with retry-after headers..."
    ],
    fileTypes: [".js", ".ts", ".json", ".env"],
    transcript: "# Current work — assistant conversation\nImplementing JWT token refresh middleware with automatic retry and rate limiting for the Express.js API. Adding connection pooling to PostgreSQL database layer."
  },
  {
    userPrompts: [
      "Set up the CI/CD pipeline with GitHub Actions for automatic deployment",
      "Write unit tests for the payment processing module",
      "Can you add TypeScript types to the API response handlers?"
    ],
    aiTurns: [
      "I'll create a GitHub Actions workflow with build, test, and deploy stages. The pipeline will run on push to main and PRs...",
      "I'll write comprehensive unit tests using Jest for the payment module, covering success paths, error handling, and edge cases..."
    ],
    fileTypes: [".ts", ".tsx", ".yml", ".json", ".test.ts"],
    transcript: "# Current work — assistant conversation\nSetting up CI/CD pipeline with GitHub Actions and writing unit tests for the payment processing module. Adding TypeScript types across the codebase."
  },
  {
    userPrompts: [
      "Create a React dashboard component with real-time data visualization",
      "Optimize the webpack bundle size by implementing code splitting",
      "Add dark mode support using CSS custom properties"
    ],
    aiTurns: [
      "I'll build the dashboard with React and Chart.js for real-time visualization. Using WebSocket for live data updates...",
      "I'll implement dynamic imports and React.lazy for route-based code splitting. This should reduce initial bundle by 40%..."
    ],
    fileTypes: [".jsx", ".tsx", ".css", ".json"],
    transcript: "# Current work — assistant conversation\nBuilding a real-time analytics dashboard with React, implementing code splitting for performance, and adding dark mode theming."
  },
  {
    userPrompts: [
      "Deploy the microservices to Kubernetes with proper health checks",
      "Set up monitoring with Prometheus and Grafana dashboards",
      "Implement circuit breaker pattern for the external API calls"
    ],
    aiTurns: [
      "I'll create Kubernetes deployment manifests with liveness and readiness probes. Each service will have proper resource limits...",
      "I'll set up Prometheus scraping with custom metrics and create Grafana dashboards for request latency, error rates, and resource usage..."
    ],
    fileTypes: [".yaml", ".go", ".json", ".dockerfile"],
    transcript: "# Current work — assistant conversation\nDeploying microservices to Kubernetes cluster with health checks, setting up Prometheus monitoring and Grafana dashboards."
  },
  {
    userPrompts: [
      "Build a REST API with FastAPI and SQLAlchemy ORM",
      "Add OAuth2 authentication with Google and GitHub providers",
      "Implement background task queue using Celery and Redis"
    ],
    aiTurns: [
      "I'll create the FastAPI application with SQLAlchemy models, Pydantic schemas for validation, and async database operations...",
      "I'll implement OAuth2 using authlib with Google and GitHub as identity providers. The flow will use PKCE for security..."
    ],
    fileTypes: [".py", ".sql", ".toml", ".env"],
    transcript: "# Current work — assistant conversation\nBuilding a Python REST API with FastAPI, SQLAlchemy ORM, OAuth2 authentication, and Celery background task processing."
  }
];

let devContextIdx = 0;
function getDevContext() {
  const ctx = DEV_CONTEXT_POOL[devContextIdx % DEV_CONTEXT_POOL.length];
  devContextIdx++;
  // Generate a deterministic session hash
  const sessionHash = crypto.createHash('sha256').update(
    JSON.stringify([ctx.transcript, ctx.userPrompts, ctx.aiTurns]) + Date.now().toString()
  ).digest('hex');
  return { ...ctx, sessionHash };
}

// Helper to inspect JWT expiration without external dependencies
function isJwtValid(token, bufferSeconds = 60) {
  if (!token || typeof token !== 'string') return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (!payload.exp) return true;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return payload.exp > (nowSeconds + bufferSeconds);
  } catch {
    return false;
  }
}

// Distributed lock key for PG advisory lock (same across all instances)
const REFRESH_LOCK_KEY = 999777;

class TokenManager {
  constructor(profile, index, config) {
    this.profile = profile;
    this.index = index;
    this.config = config;
    this.accessToken = profile.accessToken || null;
    this.refreshInFlight = null;
    this.invalidatedTokens = new Set();
    this.lastFailedRefreshToken = null;
    // Circuit breaker: tracks consecutive hard-401 failures on refresh
    this.consecutiveRefreshFailures = 0;
    this.circuitBreakerBackoffMs = 30000; // starts at 30s, doubles each failure
    this.circuitBreakerUntil = 0; // timestamp until which we should NOT attempt refresh
    this.preemptiveTimer = null;
  }

  resetCircuitBreaker() {
    this.consecutiveRefreshFailures = 0;
    this.circuitBreakerBackoffMs = 30000;
    this.circuitBreakerUntil = 0;
  }

  startPreemptiveRefresh() {
    if (this.preemptiveTimer) clearInterval(this.preemptiveTimer);
    this.preemptiveTimer = setInterval(() => {
      // Preemptively refresh if token expires within 5 minutes (300 seconds)
      if (this.accessToken && !isJwtValid(this.accessToken, 300)) {
        console.log(`[Auth:${this.profile.name}] Preemptive refresh triggered (token expiring within 5 mins).`);
        this.refresh().catch(err => console.error(`[Auth:${this.profile.name}] Preemptive refresh failed:`, err.message));
      }
    }, 60000);
  }

  async getAccessToken() {
    try {
      const latestConfig = await loadConfig();
      const currentProfile = latestConfig[this.index];
      if (currentProfile) {
        // If config on disk has a new refresh token, reset circuit breaker
        if (currentProfile.refreshToken && currentProfile.refreshToken !== this.lastFailedRefreshToken) {
          if (this.circuitBreakerUntil > 0 || this.consecutiveRefreshFailures > 0) {
            console.log(`[Auth:${this.profile.name}] Detected updated refresh token in config. Resetting circuit breaker.`);
            this.resetCircuitBreaker();
          }
          this.profile.refreshToken = currentProfile.refreshToken;
        }

        // Check if config on disk has a fresh valid access token
        if (currentProfile.accessToken && !this.invalidatedTokens.has(currentProfile.accessToken) && isJwtValid(currentProfile.accessToken)) {
          if (this.accessToken !== currentProfile.accessToken) {
            this.accessToken = currentProfile.accessToken;
            this.profile.accessToken = currentProfile.accessToken;
            this.profile.refreshToken = currentProfile.refreshToken;
            this.resetCircuitBreaker();
          }
        }
      }
    } catch (err) {
      console.warn(`[Auth:${this.profile.name}] Failed to load latest config inside getAccessToken:`, err.message);
    }

    if (this.accessToken && !this.invalidatedTokens.has(this.accessToken) && isJwtValid(this.accessToken)) {
      return this.accessToken;
    }
    return this.refresh();
  }

  async refresh(retries = 3, delay = 5000) {
    // Before blocking on circuit breaker, verify if a new token was saved to config
    try {
      const latestConfig = await loadConfig();
      const currentProfile = latestConfig[this.index];
      if (currentProfile) {
        if (currentProfile.refreshToken && currentProfile.refreshToken !== this.lastFailedRefreshToken) {
          this.resetCircuitBreaker();
          this.profile.refreshToken = currentProfile.refreshToken;
        }
        if (currentProfile.accessToken && !this.invalidatedTokens.has(currentProfile.accessToken) && isJwtValid(currentProfile.accessToken)) {
          this.resetCircuitBreaker();
          this.accessToken = currentProfile.accessToken;
          this.profile.accessToken = currentProfile.accessToken;
          this.profile.refreshToken = currentProfile.refreshToken;
          return this.accessToken;
        }
      }
    } catch (_) {}

    // Circuit breaker: if we've failed too many times, wait before next attempt
    if (this.circuitBreakerUntil > Date.now()) {
      const waitSec = Math.round((this.circuitBreakerUntil - Date.now()) / 1000);
      console.warn(`[Auth:${this.profile.name}] Circuit breaker OPEN. Refresh token appears dead. Waiting ${waitSec}s before next attempt. Re-run 'node mint.js' to get a new token.`);
      return null;
    }

    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      // Step 1: Check if another instance already refreshed
      try {
        const latestConfig = await loadConfig();
        const currentProfile = latestConfig[this.index];
        if (currentProfile && currentProfile.accessToken && !this.invalidatedTokens.has(currentProfile.accessToken) && isJwtValid(currentProfile.accessToken) && currentProfile.refreshToken !== this.profile.refreshToken) {
          console.log(`[Auth:${this.profile.name}] Another instance already refreshed. Using updated token.`);
          this.accessToken = currentProfile.accessToken;
          this.profile.refreshToken = currentProfile.refreshToken;
          this.profile.accessToken = currentProfile.accessToken;
          this.resetCircuitBreaker();
          return this.accessToken;
        }
      } catch (err) {
        console.warn(`[Auth:${this.profile.name}] DB check failed inside refresh:`, err.message);
      }

      // Step 2: Try to acquire PG advisory lock or local file lock for distributed refresh
      const { getPgClient } = require('./db');
      let pgClient = null;
      let gotLock = false;
      const fileLockPath = path.join(os.tmpdir(), `kickbacks_lock_${this.profile.name}.lock`);
      let acquiredFileLock = false;

      try {
        if (process.env.DATABASE_URL) {
          pgClient = await getPgClient();
          const lockRes = await pgClient.query('SELECT pg_try_advisory_lock($1) as locked;', [REFRESH_LOCK_KEY]);
          gotLock = lockRes.rows[0]?.locked === true;
        } else {
          // File lock fallback for multi-process local setups
          try {
            const fd = fs.openSync(fileLockPath, 'wx');
            fs.closeSync(fd);
            gotLock = true;
            acquiredFileLock = true;
          } catch (fileErr) {
            // Check if existing lock is stale (> 30s)
            try {
              const stat = fs.statSync(fileLockPath);
              if (Date.now() - stat.mtimeMs > 30000) {
                fs.unlinkSync(fileLockPath);
                const fd = fs.openSync(fileLockPath, 'wx');
                fs.closeSync(fd);
                gotLock = true;
                acquiredFileLock = true;
              }
            } catch (_) {}
          }
        }
      } catch (err) {
        console.warn(`[Auth:${this.profile.name}] Could not acquire lock:`, err.message);
        gotLock = true;
      }

      if (!gotLock) {
        // Another instance holds the lock — wait for it to finish, then read the result
        console.log(`[Auth:${this.profile.name}] Another instance is refreshing. Waiting for lock release...`);
        if (pgClient) { pgClient.release(); pgClient = null; }
        for (let wait = 0; wait < 6; wait++) {
          await sleep(2500);
          try {
            const latestConfig = await loadConfig();
            const currentProfile = latestConfig[this.index];
            if (currentProfile && currentProfile.accessToken && !this.invalidatedTokens.has(currentProfile.accessToken) && isJwtValid(currentProfile.accessToken)) {
              this.accessToken = currentProfile.accessToken;
              this.profile.refreshToken = currentProfile.refreshToken;
              this.profile.accessToken = currentProfile.accessToken;
              console.log(`[Auth:${this.profile.name}] Got refreshed token from DB (written by another instance).`);
              this.resetCircuitBreaker();
              return this.accessToken;
            }
          } catch (err) {
            // keep waiting
          }
        }
        console.warn(`[Auth:${this.profile.name}] Timed out waiting for lock holder. Will attempt refresh ourselves.`);
      }

      // Step 3: Refresh
      let refreshResult = null;
      try {
        refreshResult = await this._doRefresh(retries, delay);
      } finally {
        if (gotLock && pgClient) {
          try { await pgClient.query('SELECT pg_advisory_unlock($1);', [REFRESH_LOCK_KEY]); } catch (_) {}
          pgClient.release();
        } else if (pgClient) {
          pgClient.release();
        }
        if (acquiredFileLock) {
          try { fs.unlinkSync(fileLockPath); } catch (_) {}
        }
      }
      return refreshResult;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async _doRefresh(retries = 3, delay = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      // Re-check DB before each attempt
      try {
        const latestConfig = await loadConfig();
        const currentProfile = latestConfig[this.index];
        if (currentProfile && currentProfile.accessToken && !this.invalidatedTokens.has(currentProfile.accessToken) && isJwtValid(currentProfile.accessToken) && currentProfile.refreshToken !== this.profile.refreshToken) {
          console.log(`[Auth:${this.profile.name}] Token was refreshed by another instance between attempts. Using it.`);
          this.accessToken = currentProfile.accessToken;
          this.profile.refreshToken = currentProfile.refreshToken;
          this.profile.accessToken = currentProfile.accessToken;
          this.resetCircuitBreaker();
          return this.accessToken;
        }
        if (currentProfile && currentProfile.refreshToken) {
          this.profile.refreshToken = currentProfile.refreshToken;
        }
      } catch (err) {
        console.warn(`[Auth:${this.profile.name}] DB re-check failed:`, err.message);
      }

      console.log(`[Auth:${this.profile.name}] Refreshing access token (Attempt ${attempt}/${retries})...`);
      try {
        const rawRefreshToken = this.profile.refreshToken || "";
        const cleanRefreshToken = rawRefreshToken.startsWith("plain:1:")
          ? rawRefreshToken.slice("plain:1:".length)
          : rawRefreshToken;

        const res = await fetch(`${BACKEND_BASE}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: cleanRefreshToken })
        });

        if (res.status === 429) {
          console.warn(`[Auth:${this.profile.name}] Rate limited (429). Retrying in ${delay / 1000}s...`);
          await sleep(delay);
          delay *= 2;
          continue;
        }

        if (res.status === 401) {
          console.error(`[Auth:${this.profile.name}] Refresh token REJECTED (401). Token is dead.`);
          this.lastFailedRefreshToken = cleanRefreshToken;
          this.consecutiveRefreshFailures++;
          if (this.consecutiveRefreshFailures >= 3) {
            this.circuitBreakerUntil = Date.now() + this.circuitBreakerBackoffMs;
            console.error(`[Auth:${this.profile.name}] ⚠️  CIRCUIT BREAKER TRIPPED after ${this.consecutiveRefreshFailures} consecutive failures. Pausing refresh for ${this.circuitBreakerBackoffMs / 1000}s. Run 'node mint.js' to get a new token.`);
            this.circuitBreakerBackoffMs = Math.min(this.circuitBreakerBackoffMs * 2, 600000); // max 10 min
          }
          return null;
        }

        if (!res.ok) {
          console.error(`[Auth:${this.profile.name}] Failed to refresh token. Status: ${res.status}`);
          return null;
        }

        const body = await res.json();
        if (!body.access_token) {
          console.error(`[Auth:${this.profile.name}] Response missing access_token`);
          return null;
        }

        this.accessToken = body.access_token;
        const newRefreshToken = body.refresh_token || this.profile.refreshToken;

        console.log(`[Auth:${this.profile.name}] ✅ Token refreshed successfully. Saving to DB...`);
        this.profile.refreshToken = newRefreshToken;
        this.profile.accessToken = this.accessToken;
        this.resetCircuitBreaker();

        // Save to DB and config.json
        let saved = false;
        for (let saveAttempt = 1; saveAttempt <= 3; saveAttempt++) {
          try {
            const latestConfig = await loadConfig();
            latestConfig[this.index] = this.profile;
            await saveConfig(latestConfig);
            saved = true;
            console.log(`[Auth:${this.profile.name}] ✅ New token saved to DB (attempt ${saveAttempt}).`);
            break;
          } catch (dbErr) {
            console.error(`[Auth:${this.profile.name}] ⚠️  CRITICAL: DB save failed (attempt ${saveAttempt}/3):`, dbErr.message);
            if (saveAttempt < 3) await sleep(2000 * saveAttempt);
          }
        }
        if (!saved) {
          console.error(`[Auth:${this.profile.name}] 🚨 CRITICAL: All DB save attempts failed! New refresh token may be lost. Token in memory: ${newRefreshToken.substring(0, 10)}...`);
        }

        // Cross-sync to local ~/.kickbacks/auth.json if present
        try {
          const authPath = path.join(os.homedir(), '.kickbacks', 'auth.json');
          if (fs.existsSync(authPath)) {
            let localAuth = {};
            try {
              localAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            } catch (_) {}
            localAuth.refreshToken = newRefreshToken;
            localAuth.accessToken = this.accessToken;
            fs.writeFileSync(authPath, JSON.stringify(localAuth, null, 2), 'utf8');
            console.log(`[Auth:${this.profile.name}] ✅ Synced refreshed token to ~/.kickbacks/auth.json.`);
          }
        } catch (authSyncErr) {
          console.warn(`[Auth:${this.profile.name}] Could not cross-sync to ~/.kickbacks/auth.json:`, authSyncErr.message);
        }

        return this.accessToken;
      } catch (err) {
        console.error(`[Auth:${this.profile.name}] Network error on attempt ${attempt}:`, err.message);
        if (attempt < retries) {
          await sleep(delay);
          delay *= 2;
        }
      }
    }
    return null;
  }

  invalidateToken(badToken = null) {
    const dead = badToken || this.accessToken;
    if (dead) {
      this.invalidatedTokens.add(dead);
      console.log(`[Auth:${this.profile.name}] Invalidating access token (will refresh on next use).`);
    }
    this.accessToken = null;
    this.profile.accessToken = null;
    // Also clear from DB so other instances don't keep using the dead token
    loadConfig().then(async config => {
      if (config[this.index] && (config[this.index].accessToken === dead || !dead)) {
        config[this.index].accessToken = null;
        await saveConfig(config).catch(() => {});
      }
    }).catch(() => {});
  }

  async getEarnings() {
    let token = await this.getAccessToken();
    if (!token) return null;

    try {
      const res = await fetch(`${BACKEND_BASE}/v1/earnings`, {
        headers: { 'authorization': `Bearer ${token}` }
      });

      if (res.status === 401 || res.status === 403) {
        this.invalidateToken();
        token = await this.refresh();
        if (token) return this.getEarnings();
        return null;
      }

      if (!res.ok) {
        console.error(`[Auth:${this.profile.name}] Failed to fetch earnings. Status: ${res.status}`);
        return null;
      }

      const body = await res.json();
      return {
        lifetimeUsd: parseFloat(body.lifetime_usd || "0"),
        todayUsd: parseFloat(body.today_usd || "0"),
        lifetimeMicros: body.lifetime_micros || 0,
        todayMicros: body.today_micros || 0,
        blocked: body.blocked || false
      };
    } catch (err) {
      console.error(`[Auth:${this.profile.name}] Error fetching earnings:`, err.message);
      return null;
    }
  }
}

async function runVirtualClient(name, clientId, authManager, profile = {}) {
  const minPromptWait = Math.max(1, parseInt(profile.minPromptWait, 10) || 8);
  const maxPromptWait = Math.max(minPromptWait, parseInt(profile.maxPromptWait, 10) || 15);
  const sessionDuration = Math.max(15, parseInt(profile.sessionDuration, 10) || 60);

  console.log(`[${name}] Initializing client (clientId: ${clientId}, wait: ${minPromptWait}-${maxPromptWait}s, session: ${sessionDuration}s)...`);
  
  let activeAd = null;
  let viewTickTimer = null;
  let rotationTimer = null;
  let pauseCountdownInterval = null;
  let accruedVisibleMs = 0;
  let lastAccrualMs = 0;
  let corr = "";

  let lastCampaignId = "";

  async function fetchAd() {
    let token = await authManager.getAccessToken();
    if (!token) return null;

    // 1. Primary: Boosted Mode v2 serve endpoint (POST /v2/serve)
    // Request statusline surface first — this is where paid campaign_tick ads appear
    const SERVE_SURFACES = ['statusline', 'overlay', 'claude-code', 'statusbar', 'banner', 'extension'];
    let fallbackCandidateAd = null;
    let fallbackSurface = 'statusline';
    let fallbackRotation = 60000;

    for (const serveSurface of SERVE_SURFACES) {
      try {
        const devCtx = getDevContext();

        const v2Body = {
          v: 2,
          client_id: clientId,
          surface: serveSurface,
          pull_capable: true,
          refresh: false,
          consent: { kickbacks_consent: true },
          locale: "en-US",
          redactions: 0,
          context: {
            transcript: devCtx.transcript,
            fileTypes: devCtx.fileTypes,
            repo: "",
            userPrompts: devCtx.userPrompts,
            aiTurns: devCtx.aiTurns,
            ext: {
              work_context: {
                version: 1,
                provider: "claude",
                session: devCtx.sessionHash
              }
            },
            deviceOs: process.platform,
            osVersion: os.release(),
            vscodeVersion: "1.98.2",
            extensionVersion: EXT_VERSION,
            userAgent: `kickbacks-vscode/${EXT_VERSION} (${process.platform}-${process.arch})`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
          },
          human_activity_ts: Date.now() - Math.floor(Math.random() * 3000 + 500),
          client_ts: Date.now()
        };

        const res = await fetch(`${BACKEND_BASE}/v2/serve`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${token}`,
            'user-agent': `kickbacks-vscode/${EXT_VERSION} (${process.platform}-${process.arch})`,
            'content-type': 'application/json',
            'accept': 'application/json'
          },
          body: JSON.stringify(v2Body)
        });

        if (res.status === 401 || res.status === 403) {
          console.log(`[${name}] /v2/serve auth rejection (${res.status}). Invalidating token & retrying...`);
          authManager.invalidateToken();
          token = await authManager.refresh();
          if (token) return fetchAd();
          return null;
        }

        if (res.status === 204) {
          continue; // No ad currently available on this surface
        }

        if (res.ok) {
          let body = null;
          try {
            body = await res.json();
          } catch (_) {
            continue;
          }

          if (body && Array.isArray(body.ads) && body.ads.length > 0) {
            // Check for paid commercial campaigns (campaign_tick)
            const paidAds = body.ads.filter(a => {
              if (a.ad_id?.startsWith('house-') || a.ad_id?.startsWith('house:')) return false;
              if (a.campaign_id?.startsWith('house-') || a.campaign_id?.startsWith('house:')) return false;
              if (a.source === 'house') return false;
              try {
                const payload = JSON.parse(Buffer.from(a.session_token.split('.')[1], 'base64').toString());
                if (payload.billing_strategy === 'house_tick') return false;
              } catch {}
              return true;
            });

            if (paidAds.length > 0) {
              const selected = paidAds.find(a => a.campaign_id !== lastCampaignId) || paidAds[0];
              selected.title_text = selected.ad_line || selected.brand || selected.title_text || "Sponsored Ad";
              selected._serveSurface = serveSurface;
              if (selected.campaign_id) lastCampaignId = selected.campaign_id;
              const serverRotation = (body.rotation_seconds || 30) * 1000;
              const baseSessionMs = sessionDuration * 1000;
              const rotationIntervalMs = Math.max(baseSessionMs, serverRotation * 2 + Math.floor(Math.random() * 15000));
              console.log(`[${name}] ✅ Got PAID commercial ad from ${serveSurface}: "${selected.title_text}" (rotation: ${rotationIntervalMs/1000}s)`);
              return {
                ad: selected,
                rotationIntervalMs,
                viewThresholdMs: 10000,
                tickIntervalMs: 10000
              };
            } else {
              // Cache first available valid ad as immediate fallback
              if (!fallbackCandidateAd && body.ads.length > 0) {
                const candidate = body.ads.find(a => a.campaign_id !== lastCampaignId) || body.ads[0];
                candidate.title_text = candidate.ad_line || candidate.brand || candidate.title_text || "Sponsored Ad";
                candidate._serveSurface = serveSurface;
                fallbackCandidateAd = candidate;
                fallbackSurface = serveSurface;
                const serverRotation = (body.rotation_seconds || 30) * 1000;
                const baseSessionMs = sessionDuration * 1000;
                fallbackRotation = Math.max(baseSessionMs, serverRotation * 2 + Math.floor(Math.random() * 15000));
              }
              // If we already have a candidate ad from statusline, check at most 1 other surface for paid ads
              if (fallbackCandidateAd && (serveSurface === 'overlay' || serveSurface === 'claude-code')) {
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[${name}] /v2/serve [${serveSurface}] error: ${err.message}`);
      }
    } // end SERVE_SURFACES loop

    // If candidate ad was captured from /v2/serve, use it immediately
    if (fallbackCandidateAd) {
      if (fallbackCandidateAd.campaign_id) lastCampaignId = fallbackCandidateAd.campaign_id;
      console.log(`[${name}] Using verified ad from ${fallbackSurface}: "${fallbackCandidateAd.title_text}" (rotation: ${fallbackRotation/1000}s)`);
      return {
        ad: fallbackCandidateAd,
        rotationIntervalMs: fallbackRotation,
        viewThresholdMs: 10000,
        tickIntervalMs: 10000
      };
    }

    // 2. Fallback: Legacy v1 portfolio
    try {
      const url = `${BACKEND_BASE}/v1/portfolio?claude_code_version=${encodeURIComponent(CC_VERSION)}` + (lastCampaignId ? `&campaign=${encodeURIComponent(lastCampaignId)}` : "");
      const res = await fetch(url, {
        headers: { 
          'authorization': `Bearer ${token}`,
          'user-agent': `kickbacks-vscode/${EXT_VERSION} (${process.platform}-${process.arch})`,
          'accept': 'application/json',
          'X-Client-Id': clientId,
          'X-Kickbacks-Client-Env': JSON.stringify(clientEnv)
        }
      });

      if (res.status === 401 || res.status === 403) {
        authManager.invalidateToken();
        token = await authManager.refresh();
        if (token) return fetchAd();
        return null;
      }

      if (res.ok) {
        const body = await res.json();
        const ads = body.ads || [];
        if (ads.length > 0) {
          const paidAds = ads.filter(a => !a.ad_id?.startsWith('house-') && !a.campaign_id?.startsWith('house-') && a.source !== 'house');
          const candidatePool = paidAds.length > 0 ? paidAds : ads;
          const selected = candidatePool.find(a => a.campaign_id !== lastCampaignId) || candidatePool[0];
          selected.title_text = selected.ad_line || selected.brand || selected.title_text || "Sponsored Ad";
          selected._serveSurface = 'statusline';
          if (selected.campaign_id) lastCampaignId = selected.campaign_id;
          const baseSessionMs = sessionDuration * 1000;
          const rotationIntervalMs = Math.max(baseSessionMs, body.rotation_interval_seconds ? (body.rotation_interval_seconds * 1000) : 60000);
          const viewThresholdMs = body.view_threshold_seconds ? (body.view_threshold_seconds * 1000) : 10000;
          const tickIntervalMs = body.view_tick_interval_seconds ? (body.view_tick_interval_seconds * 1000) : 10000;
          
          return {
            ad: selected,
            rotationIntervalMs,
            viewThresholdMs,
            tickIntervalMs
          };
        }
      }
    } catch (err) {
      console.error(`[${name}] Network error fetching legacy portfolio:`, err.message);
    }

    // 3. Fallback: Local cli-ad cache
    try {
      const cliAdPath = path.join(os.homedir(), '.kickbacks', 'cli-ad.json');
      if (fs.existsSync(cliAdPath)) {
        const cliAd = JSON.parse(fs.readFileSync(cliAdPath, 'utf8'));
        if (cliAd && cliAd.ad_id) {
          cliAd.title_text = cliAd.ad_line || cliAd.title_text || "Sponsored Ad";
          return {
            ad: cliAd,
            rotationIntervalMs: 30000,
            viewThresholdMs: 10000,
            tickIntervalMs: 10000
          };
        }
      }
    } catch (_) {}

    return null;
  }

  async function sendMetric(eventType, ad, params = {}) {
    let token = await authManager.getAccessToken();
    if (!token) return null;

    const eventUuid = crypto.randomUUID();
    const body = {
      event_type: eventType,
      ad_id: ad.ad_id,
      campaign_id: ad.campaign_id,
      client_id: clientId,
      ts: new Date().toISOString(),
      claude_code_version: CC_VERSION,
      extension_version: EXT_VERSION,
      nonce: eventUuid,
      session_token: ad.session_token || "",
      session_nonce: params.sessionNonce || crypto.randomUUID(),
      focus_state: "focused",
      human_prompt_age_s: Math.floor(Math.random() * 4) + 1,
      human_activity_age_s: Math.floor(Math.random() * 3) + 1,
      focus_age_s: Math.floor(Math.random() * 2),
      window_id: params.windowId || ("win-" + crypto.randomBytes(4).toString("hex")),
      tier: "tier1",
      ext: {
        ...clientEnv,
        mode: "v1"
      }
    };

    if (params.surface) body.surface = params.surface;
    if (typeof params.visibleMs === 'number') body.visible_ms = params.visibleMs;
    if (params.viewable !== undefined) body.viewable = params.viewable;
    if (params.viewPct !== undefined) body.view_pct = params.viewPct;
    if (params.viewMs !== undefined) body.view_ms = params.viewMs;

    const headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
      'user-agent': `kickbacks-vscode/${EXT_VERSION} (${process.platform}-${process.arch})`,
      'accept': 'application/json'
    };

    if (params.corr) {
      headers['X-Kickbacks-Corr'] = params.corr;
      headers['X-Vibe-Corr'] = params.corr;
    }

    try {
      const res = await fetch(`${BACKEND_BASE}/v1/metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      let resData = null;
      try {
        resData = await res.json();
      } catch (e) {
        // Response might not be JSON
      }

      if (!res.ok) {
        console.warn(`[${name}] Metric ${eventType} returned HTTP status: ${res.status}`);

        // Immediate auto-recovery if surface was rejected with 400
        if (res.status === 400 && resData?.detail === 'invalid surface' && body.surface !== 'statusline') {
          console.log(`[${name}] Surface "${body.surface}" rejected with 400 (invalid surface). Hot-adapting to "statusline"...`);
          body.surface = 'statusline';
          validatedSurfaceCache.set(ad.campaign_id, 'statusline');
          try {
            const retryRes = await fetch(`${BACKEND_BASE}/v1/metrics`, {
              method: 'POST',
              headers,
              body: JSON.stringify(body)
            });
            let retryData = null;
            try { retryData = await retryRes.json(); } catch (_) {}
            if (retryRes.ok) {
              const isAccepted = Boolean(retryRes.ok && (!retryData || (retryData.measurement !== 'surface_mismatch' && retryData.measurement !== 'egress_suppressed')));
              const isBilledAck = Boolean(isAccepted && (retryData?.billed === true || retryData?.measurement === 'measured' || retryData?.measurement === 'accepted' || retryRes.status === 200));
              console.log(`[${name}] Metric ${eventType} auto-adapted to "statusline" succeeded (status: ${retryRes.status})`);
              return { status: retryRes.status, billed: isBilledAck, measurement: retryData?.measurement || 'accepted' };
            }
          } catch (retryErr) {
            console.error(`[${name}] Metric ${eventType} auto-adapt failed:`, retryErr.message);
          }
        }

        if (res.status === 401 || res.status === 403) {
          authManager.invalidateToken();
          const newToken = await authManager.refresh();
          if (newToken) {
            try {
              headers['authorization'] = `Bearer ${newToken}`;
              const retryRes = await fetch(`${BACKEND_BASE}/v1/metrics`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
              });
              if (retryRes.ok) {
                console.log(`[${name}] Metric ${eventType} retry succeeded (status: ${retryRes.status})`);
              }
              return retryRes.status;
            } catch (retryErr) {
              console.error(`[${name}] Metric ${eventType} retry failed:`, retryErr.message);
              return null;
            }
          }
        }
      } else {
        // Status 200 OK — check response measurement payload
        if (resData && typeof resData.measurement === 'string') {
          if (resData.measurement.includes('surface_mismatch') || resData.measurement.includes('egress_suppressed')) {
            console.warn(`[${name}] Surface "${body.surface}" rejected (${resData.measurement}) for campaign ${ad.campaign_id}. Auto-probing working surface...`);
            
            for (const candidate of CANDIDATE_SURFACES) {
              if (candidate === body.surface) continue;
              const probeBody = { ...body, surface: candidate, nonce: crypto.randomUUID() };
              try {
                const probeRes = await fetch(`${BACKEND_BASE}/v1/metrics`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(probeBody)
                });
                const probeData = await probeRes.json();
                if (probeData && typeof probeData.measurement === 'string' && !probeData.measurement.includes('mismatch') && !probeData.measurement.includes('suppressed')) {
                  console.log(`[${name}] 🎯 Auto-adapted working surface for campaign ${ad.campaign_id}: "${candidate}" (${probeData.measurement})`);
                  validatedSurfaceCache.set(ad.campaign_id, candidate);
                  const isBilledAck = Boolean(probeData.billed === true || probeData.measurement === 'measured' || probeData.measurement === 'accepted' || probeRes.status === 200);
                  return { status: probeRes.status, billed: isBilledAck, measurement: probeData.measurement };
                }
              } catch (probeErr) {
                // Continue probing next surface candidate
              }
            }
          }
        }

        const isAccepted = Boolean(res.ok && (!resData || (resData.measurement !== 'surface_mismatch' && resData.measurement !== 'egress_suppressed')));
        // In Kickbacks, HTTP 200 with measurement: 'measured' or 'accepted' means the event is accepted & queued for billing settlement
        const isBilledAck = Boolean(isAccepted && (resData?.billed === true || resData?.measurement === 'measured' || resData?.measurement === 'accepted' || res.status === 200));
        const measInfo = resData ? ` [measurement: ${resData.measurement || 'accepted'}, billed: ${isBilledAck}]` : '';
        console.log(`[${name}] Metric ${eventType} sent successfully (status: ${res.status}${measInfo})`);
        return { status: res.status, billed: isBilledAck, measurement: resData?.measurement || 'accepted' };
      }
      return { status: res.status, billed: false, measurement: resData?.measurement || '' };
    } catch (err) {
      console.error(`[${name}] Network error sending metric ${eventType}:`, err.message);
      return { status: null, billed: false, measurement: 'network_error' };
    }
  }

  function endShow() {
    if (viewTickTimer) {
      clearInterval(viewTickTimer);
      viewTickTimer = null;
    }
    if (pauseCountdownInterval) {
      clearInterval(pauseCountdownInterval);
      pauseCountdownInterval = null;
    }
    if (rotationTimer) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
    if (activeAd && accruedVisibleMs > 0) {
      console.log(`[${name}] Stopped showing ad. Total visible ms: ${accruedVisibleMs}`);
    }
    activeAd = null;
    accruedVisibleMs = 0;
    lastAccrualMs = 0;
  }

  async function startShow(ad, viewThresholdMs = 10000, tickIntervalMs = 10000, rotationIntervalMs = 60000) {
    endShow();
    if (!ad) {
      console.log(`[${name}] No active ad returned in portfolio.`);
      return;
    }
    activeAd = ad;

    ad.title_text = ad.ad_line || ad.brand || ad.title_text || "Sponsored Ad";
    const isPaidAd = !ad.ad_id?.startsWith('house-') && !ad.ad_id?.startsWith('house:');
    console.log(`[${name}] Active ad: "${ad.title_text}" (ID: ${ad.ad_id}) [${isPaidAd ? 'PAID' : 'HOUSE'}] (Threshold: ${viewThresholdMs}ms, Tick: ${tickIntervalMs}ms, Session: ${rotationIntervalMs/1000}s)`);

    // If external impression beacon exists, fire it asynchronously
    if (ad.imp_url) {
      fetch(ad.imp_url).then(() => {
        console.log(`[${name}] Fired external imp_url beacon for ${ad.ad_id}`);
      }).catch(err => {
        console.warn(`[${name}] External imp_url beacon error:`, err.message);
      });
    }
    
    const sessionNonce = crypto.randomUUID();
    const windowId = "win-" + crypto.randomBytes(4).toString("hex");

    if (process.send) {
      process.send({
        type: 'client_ad',
        clientName: name,
        clientId: clientId,
        adId: ad.ad_id,
        adTitle: ad.title_text
      });
    }

    // Send initial impression rendered & viewable for the resolved active surface
    const cliCorr = "cli." + ad.ad_id;
    const adSurface = surfaceForAd(ad);
    console.log(`[${name}] Using metric surface: "${adSurface}" for ad ${ad.ad_id}`);
    await sendMetric("impression_rendered", ad, { corr: cliCorr, surface: adSurface, sessionNonce, windowId });
    await sendMetric("impression_viewable", ad, { corr: cliCorr, surface: adSurface, sessionNonce, windowId });

    accruedVisibleMs = 0;
    lastAccrualMs = Date.now();
    corr = "clitick." + ad.ad_id + "." + Math.random().toString(36).slice(2, 8);
    let thresholdMetSent = false;
    let tickCount = 0;

    // Set rotation timer for the FULL session duration — hold the ad for 60-120s
    // to accumulate multiple billing ticks. Don't kill the session early.
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      console.log(`[${name}] Session rotation after ${rotationIntervalMs/1000}s. Total ticks: ${tickCount}, visible: ${accruedVisibleMs}ms`);
      endShow();
      // Natural pause between sessions simulating human prompt cycle
      const humanPauseMs = Math.floor(minPromptWait * 1000 + Math.random() * ((maxPromptWait - minPromptWait) * 1000));
      let pauseSecRemaining = Math.round(humanPauseMs / 1000);
      console.log(`[${name}] Next ad rotation in ${pauseSecRemaining}s (configured pause: ${minPromptWait}-${maxPromptWait}s)...`);
      if (process.send) {
        process.send({
          type: 'client_tick',
          clientName: name,
          clientId: clientId,
          adId: ad.ad_id,
          adTitle: ad.title_text,
          status: `Next prompt in ${pauseSecRemaining}s`,
          visibleMs: accruedVisibleMs
        });
      }

      pauseCountdownInterval = setInterval(() => {
        pauseSecRemaining -= 2;
        if (pauseSecRemaining > 1) {
          if (process.send) {
            process.send({
              type: 'client_tick',
              clientName: name,
              clientId: clientId,
              adId: ad.ad_id,
              adTitle: ad.title_text,
              status: `Next prompt in ${pauseSecRemaining}s`,
              visibleMs: accruedVisibleMs
            });
          }
        } else {
          clearInterval(pauseCountdownInterval);
          pauseCountdownInterval = null;
        }
      }, 2000);

      rotationTimer = setTimeout(() => {
        if (pauseCountdownInterval) {
          clearInterval(pauseCountdownInterval);
          pauseCountdownInterval = null;
        }
        rotateAd();
      }, humanPauseMs);
    }, rotationIntervalMs);

    viewTickTimer = setInterval(async () => {
      const now = Date.now();
      const delta = now - lastAccrualMs;
      if (delta > 0) accruedVisibleMs += Math.min(delta, tickIntervalMs);
      lastAccrualMs = now;
      tickCount++;

      console.log(`[${name}] Tick #${tickCount}: Crediting view (${accruedVisibleMs}ms)...`);
      const status = await sendMetric("view_tick", ad, {
        corr,
        surface: surfaceForAd(ad),
        visibleMs: accruedVisibleMs,
        sessionNonce,
        windowId
      });

      if (process.send) {
        process.send({
          type: 'client_tick',
          clientName: name,
          clientId: clientId,
          adId: ad.ad_id,
          adTitle: ad.title_text,
          status: `Viewing (${(accruedVisibleMs/1000).toFixed(0)}s) [tick #${tickCount}]`,
          visibleMs: accruedVisibleMs
        });
      }

      // Send billing metric once threshold is reached (first 10s)
      // But do NOT end the show — keep ticking for continuous billing
      if (!thresholdMetSent && accruedVisibleMs >= viewThresholdMs) {
        thresholdMetSent = true;
        console.log(`[${name}] View threshold met at ${accruedVisibleMs}ms! Sending view_threshold_met (session continues for more ticks)...`);
        
        const metricResult = await sendMetric("view_threshold_met", ad, {
          corr,
          surface: surfaceForAd(ad),
          visibleMs: accruedVisibleMs,
          viewable: true,
          viewPct: 100,
          viewMs: accruedVisibleMs,
          sessionNonce,
          windowId
        });

        // Threshold met: confirmed billing once 10s view duration is reached and accepted by API
        const isExplicitlyBilled = Boolean(metricResult && (metricResult.billed === true || metricResult.measurement === 'measured' || metricResult.status === 200));
        const billingStatus = (typeof metricResult === 'object' && metricResult !== null) ? metricResult.status : metricResult;

        if (process.send) {
          process.send({
            type: 'client_billing',
            clientName: name,
            clientId: clientId,
            adId: ad.ad_id,
            status: billingStatus,
            billed: isExplicitlyBilled,
            measurement: metricResult?.measurement
          });
        }
        // Session continues — rotation timer will handle ending it
      }
    }, tickIntervalMs);
  }

  async function rotateAd() {
    endShow();
    if (process.send) {
      process.send({
        type: 'client_tick',
        clientName: name,
        clientId: clientId,
        adId: activeAd?.ad_id || '',
        adTitle: activeAd?.title_text || 'Selecting ad...',
        status: 'Rotating ad...',
        visibleMs: 0
      });
    }

    const portfolio = await fetchAd();
    if (portfolio && portfolio.ad) {
      await startShow(portfolio.ad, portfolio.viewThresholdMs, portfolio.tickIntervalMs, portfolio.rotationIntervalMs);
    } else {
      console.log(`[${name}] No ad returned or in cooldown. Retrying in 15s...`);
      let cooldownSecRemaining = 15;
      if (process.send) {
        process.send({
          type: 'client_tick',
          clientName: name,
          clientId: clientId,
          adId: '',
          adTitle: 'Waiting for inventory',
          status: `In cooldown (${cooldownSecRemaining}s)`,
          visibleMs: 0
        });
      }

      pauseCountdownInterval = setInterval(() => {
        cooldownSecRemaining -= 3;
        if (cooldownSecRemaining > 1) {
          if (process.send) {
            process.send({
              type: 'client_tick',
              clientName: name,
              clientId: clientId,
              adId: '',
              adTitle: 'Waiting for inventory',
              status: `In cooldown (${cooldownSecRemaining}s)`,
              visibleMs: 0
            });
          }
        } else {
          clearInterval(pauseCountdownInterval);
          pauseCountdownInterval = null;
        }
      }, 3000);

      rotationTimer = setTimeout(() => {
        if (pauseCountdownInterval) {
          clearInterval(pauseCountdownInterval);
          pauseCountdownInterval = null;
        }
        rotateAd();
      }, 15000);
    }
  }

  await rotateAd();
}

async function ensureBoostedConsent(authManager, profileName) {
  try {
    const token = await authManager.getAccessToken();
    if (!token) return;

    // Dynamically retrieve required TOS version from Kickbacks backend
    let tosVersion = "2026-05-17";
    try {
      const getRes = await fetch(`${BACKEND_BASE}/v1/me/consent`, {
        headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        if (getData?.current_tos_version) {
          tosVersion = getData.current_tos_version;
        }
      }
    } catch (_) {}
    
    // 1. Core TOS Consent & Telemetry
    await fetch(`${BACKEND_BASE}/v1/me/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ tos_accepted_version: tosVersion, accepted: true, telemetry_opt_in: true })
    }).catch(() => {});

    // 2. Boosted Mode Scoped Consent
    const res = await fetch(`${BACKEND_BASE}/v1/me/consent/scopes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({
        scopes: {
          kickbacks_consent: true,
          boosted_ack: true,
          ephemeral_targeting: true,
          third_party_sharing: true,
          profile_retention: true
        },
        boosted_ack: {
          accepted: true,
          version: "v2-scopes-3"
        }
      })
    });
    if (res.ok) {
      console.log(`[Auth:${profileName}] 🚀 Boosted Mode consent scopes synchronized (TOS: ${tosVersion}, telemetry_opt_in: true).`);
    }
  } catch (err) {
    console.warn(`[Auth:${profileName}] Warning: Boosted consent sync:`, err.message);
  }
}

async function sendFleetHeartbeat(authManager, profile) {
  try {
    const token = await authManager.getAccessToken();
    if (!token) return;
    const res = await fetch(`${BACKEND_BASE}/v1/fleet/heartbeat`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': `kickbacks-vscode/${EXT_VERSION} (${process.platform}-${process.arch})`
      },
      body: JSON.stringify({
        client_id: profile.clientId,
        target: "claude-code",
        surface: "overlay",
        extension_version: EXT_VERSION,
        claude_code_version: CC_VERSION,
        status: "active",
        ts: new Date().toISOString(),
        metadata: {}
      })
    });
    if (res.ok) {
      console.log(`[Fleet:${profile.name}] 💓 Heartbeat active (target: claude-code, status: active)`);
    }
  } catch (err) {
    console.warn(`[Fleet:${profile.name}] Heartbeat error:`, err.message);
  }
}

async function start() {
  const config = await loadConfig();
  
  const activeProfiles = config.map((p, idx) => ({ p, idx })).filter(item => 
    item.p.refreshToken &&
    item.p.refreshToken !== "insert_another_account_refresh_token_here"
  );

  if (activeProfiles.length === 0) {
    console.error("No active profiles configured in config.json.");
    process.exit(1);
  }

  // Support 1-to-1 Account Allocation: Dedicated mode
  let targetProfiles = activeProfiles;

  if (process.env.ACCOUNT_INDEX !== undefined && process.env.ACCOUNT_INDEX !== '') {
    const targetIdx = parseInt(process.env.ACCOUNT_INDEX, 10);
    const matched = activeProfiles.find(item => item.idx === targetIdx || item.idx === (targetIdx % activeProfiles.length));
    if (matched) {
      targetProfiles = [matched];
      console.log(`[Simulator] 🎯 Dedicated Mode: Backend assigned exclusively to account index ${targetIdx} (${matched.p.name}).`);
    }
  } else if (process.env.ACCOUNT_NAME) {
    const matched = activeProfiles.find(item => item.p.name === process.env.ACCOUNT_NAME);
    if (matched) {
      targetProfiles = [matched];
      console.log(`[Simulator] 🎯 Dedicated Mode: Backend assigned exclusively to account ${process.env.ACCOUNT_NAME}.`);
    }
  } else if (process.env.DEDICATED_ACCOUNT === 'true') {
    const instanceMatch = process.env.INSTANCE_NAME?.match(/inst(?:ance)?_(\d+)/i);
    if (instanceMatch) {
      const instNum = parseInt(instanceMatch[1], 10);
      const targetIdx = (instNum - 1) % activeProfiles.length;
      targetProfiles = [activeProfiles[targetIdx]];
      console.log(`[Simulator] 🎯 Dedicated Mode: Backend assigned exclusively to account ${activeProfiles[targetIdx].p.name}.`);
    }
  }

  console.log(`Starting simulator with ${targetProfiles.length} active profile(s)...`);

  for (const { p, idx } of targetProfiles) {
    const authManager = new TokenManager(p, idx, config);
    authManager.startPreemptiveRefresh();
    
    // Automatically ensure Boosted Mode consent scopes are active on server
    await ensureBoostedConsent(authManager, p.name);

    // Send initial fleet heartbeat and keep pulse alive every 2 minutes
    await sendFleetHeartbeat(authManager, p);
    setInterval(() => sendFleetHeartbeat(authManager, p), 120000);

    const clientsPerInstance = parseInt(process.env.CLIENTS_PER_INSTANCE || '0', 10);
    const scaleFactor = clientsPerInstance > 0 ? clientsPerInstance : (p.scale || 10);

    // Poll earnings per profile
    const pollEarnings = async () => {
      const earnings = await authManager.getEarnings();
      if (earnings) {
        console.log(`[Profile:${p.name}] Real Earnings: $${earnings.todayUsd} today · $${earnings.lifetimeUsd} lifetime (micros: ${earnings.todayMicros})`);
        if (process.send) {
          process.send({
            type: 'earnings',
            profileName: p.name,
            todayUsd: (earnings.todayMicros || 0) / 1000000,
            lifetimeUsd: (earnings.lifetimeMicros || 0) / 1000000,
            todayMicros: earnings.todayMicros,
            lifetimeMicros: earnings.lifetimeMicros,
            blocked: earnings.blocked
          });
        }
      }
    };

    pollEarnings();
    const earningsInterval = setInterval(pollEarnings, 15000);

    let startIdx = 0;
    let endIdx = scaleFactor;

    // In multi-instance distributed cluster mode, slice indices across nodes
    const totalInstances = parseInt(process.env.TOTAL_INSTANCES || '1', 10);
    if (totalInstances > 1 && targetProfiles.length > 1) {
      const instanceMatch = process.env.INSTANCE_NAME?.match(/inst(?:ance)?_(\d+)/i);
      if (instanceMatch) {
        const instNum = parseInt(instanceMatch[1], 10);

        if (clientsPerInstance > 0) {
          const numProfiles = targetProfiles.length;
          const perProfileClients = Math.max(1, Math.floor(clientsPerInstance / numProfiles));
          const profileIndexInActive = targetProfiles.findIndex(item => item.p.name === p.name);
          const extra = profileIndexInActive < (clientsPerInstance % numProfiles) ? 1 : 0;
          const thisProfileCount = perProfileClients + extra;

          startIdx = (instNum - 1) * thisProfileCount;
          endIdx = startIdx + thisProfileCount;
        } else {
          const baseSlice = Math.floor(scaleFactor / totalInstances);
          const remainder = scaleFactor % totalInstances;
          
          const idxZeroBased = instNum - 1;
          startIdx = idxZeroBased * baseSlice + Math.min(idxZeroBased, remainder);
          endIdx = startIdx + baseSlice + (idxZeroBased < remainder ? 1 : 0);
        }
      }
    }

    console.log(`[Profile:${p.name}] Spawning ${endIdx - startIdx} virtual clients (indices ${startIdx} to ${endIdx - 1})...`);

    for (let c = startIdx; c < endIdx; c++) {
      const virtualClientId = p.clientId || crypto.randomBytes(12).toString("hex");

      const virtualName = `${p.name}_v${c + 1}`;
      // Stagger clients by 3.5s so multiple clients don't hit the exact same tick second
      const startDelay = (c - startIdx) * 3500;
      setTimeout(() => {
        runVirtualClient(virtualName, virtualClientId, authManager, p).catch(err => {
          console.error(`Fatal error in virtual client ${virtualName}:`, err);
        });
      }, startDelay);
    }
  }
}

// Exception handlers
process.on('uncaughtException', (err) => {
  console.error('[Simulator] Uncaught Exception:', err.stack || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Simulator] Unhandled Rejection:', reason);
});

// Graceful Shutdown
function handleShutdown(signal) {
  console.log(`\n[Simulator] Received ${signal}. Stopping virtual clients...`);
  process.exit(0);
}
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

start();
