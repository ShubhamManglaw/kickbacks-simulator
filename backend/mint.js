const crypto = require('crypto');
const path = require('path');
const { exec } = require('child_process');

const BACKEND_BASE = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";
const clientId = crypto.randomBytes(12).toString("hex");
const targetEmail = process.argv[2] || process.env.LOGIN_EMAIL || "shubhammanglaw@gmail.com";

async function mint() {
  console.log("1. Starting login session...");
  // Manual redirect handling is required so we don't automatically follow to Google Accounts HTML page.
  const startRes = await fetch(`${BACKEND_BASE}/v1/auth/extension/start?client_id=${clientId}`, {
    redirect: 'manual'
  });
  
  const loginUrl = startRes.headers.get('location');
  if (!loginUrl) {
    console.error("Failed to retrieve redirect URL from headers");
    process.exit(1);
  }

  const urlObj = new URL(loginUrl);
  const state = urlObj.searchParams.get("state");
  if (!state) {
    console.error("Failed to parse state from redirect URL");
    process.exit(1);
  }

  let finalLoginUrl = loginUrl;
  if (targetEmail && !loginUrl.includes('login_hint=')) {
    finalLoginUrl += `&login_hint=${encodeURIComponent(targetEmail)}`;
  }

  console.log(`\n👉 OPEN THIS LINK IN YOUR BROWSER AND SIGN IN AS ${targetEmail}:\n\n${finalLoginUrl}\n`);
  
  if (process.platform === 'darwin') {
    try {
      exec(`open "${finalLoginUrl}"`);
      console.log(`🌐 Automatically opened Google Sign-In in your browser.`);
    } catch (_) {}
  }

  console.log("Waiting for authorization (polling every 3s)...");

  const interval = setInterval(async () => {
    try {
      const pollRes = await fetch(`${BACKEND_BASE}/v1/auth/extension/poll?state=${encodeURIComponent(state)}&client_id=${clientId}`);
      if (pollRes.status === 200) {
        const credentials = await pollRes.json();
        clearInterval(interval);
        
        console.log("\n🎉 Authorization Successful!");
        console.log("-----------------------------------------");
        console.log(`Name: client_${clientId.slice(0, 6)}`);
        console.log(`clientId: ${clientId}`);
        console.log(`refreshToken: ${credentials.refresh_token}`);
        console.log("-----------------------------------------");

        // 1. Auto-accept Terms of Service & Boosted Mode
        try {
          let tosVersion = "2026-05-17";
          try {
            const getRes = await fetch(`${BACKEND_BASE}/v1/me/consent`, {
              headers: { authorization: `Bearer ${credentials.access_token}`, accept: "application/json" }
            });
            if (getRes.ok) {
              const getData = await getRes.json();
              if (getData?.current_tos_version) tosVersion = getData.current_tos_version;
            }
          } catch (_) {}

          await fetch(`${BACKEND_BASE}/v1/me/consent`, {
            method: "POST",
            headers: { "authorization": `Bearer ${credentials.access_token}`, "content-type": "application/json" },
            body: JSON.stringify({ tos_accepted_version: tosVersion, accepted: true, telemetry_opt_in: true })
          });
          await fetch(`${BACKEND_BASE}/v1/me/consent/scopes`, {
            method: "POST",
            headers: { "authorization": `Bearer ${credentials.access_token}`, "content-type": "application/json" },
            body: JSON.stringify({
              scopes: { kickbacks_consent: true, boosted_ack: true },
              boosted_ack: { accepted: true, version: "v2-scopes-3" }
            })
          });
          console.log(`✅ TOS (${tosVersion}) & Boosted Consent Auto-Accepted.`);
        } catch (e) {
          console.log(`⚠️ Consent setup error: ${e.message}`);
        }

        // 2. Auto-save to config.json and PostgreSQL
        try {
          const { loadConfig, saveConfig } = require('./db');
          const currentConfig = await loadConfig();

          const getEmail = (tok) => {
            try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()).email; } catch { return null; }
          };
          const newEmail = getEmail(credentials.access_token);

          let matchIdx = -1;
          if (newEmail) {
            matchIdx = currentConfig.findIndex(a => a.accessToken && getEmail(a.accessToken) === newEmail);
          }
          if (matchIdx === -1 && currentConfig.length === 1) {
            matchIdx = 0;
          }

          const accountName = newEmail ? newEmail.split('@')[0] : (targetEmail ? targetEmail.split('@')[0] : `client_${clientId.slice(0, 6)}`);

          if (matchIdx >= 0) {
            console.log(`\n🔄 Updating account: ${accountName} (${newEmail || 'index ' + matchIdx})`);
            currentConfig[matchIdx].name = accountName;
            currentConfig[matchIdx].clientId = clientId;
            currentConfig[matchIdx].refreshToken = credentials.refresh_token;
            currentConfig[matchIdx].accessToken = credentials.access_token;
            currentConfig[matchIdx].scale = currentConfig[matchIdx].scale || 10;
          } else {
            currentConfig.push({
              name: accountName,
              clientId: clientId,
              refreshToken: credentials.refresh_token,
              scale: 10,
              accessToken: credentials.access_token
            });
          }

          await saveConfig(currentConfig);

          console.log(`\n🚀 Account '${accountName}' successfully saved to config.json!`);
          console.log(`Total Active Accounts in Fleet: ${currentConfig.length}`);

          const startScript = path.resolve(__dirname, '..', 'start.sh');
          console.log(`\n⚡ Automatically launching simulator fleet via ${startScript}...`);
          exec(`bash "${startScript}"`, (startErr, startOut) => {
            if (startErr) console.error("Fleet launch error:", startErr.message);
            if (startOut) console.log(startOut);
            process.exit(0);
          });
          return;
        } catch (saveErr) {
          console.error("Failed to auto-save config:", saveErr.message);
          process.exit(1);
        }
      } else if (pollRes.status !== 202) {
        console.log(`Polling status: ${pollRes.status}. Retrying...`);
      }
    } catch (err) {
      // Ignore network blips
    }
  }, 3000);
}

mint();
