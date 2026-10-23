#!/usr/bin/env bash

# Kickbacks Fleet - Universal Boot Autostart Configuration Manager
# Supports macOS (launchd LaunchAgents), Linux (systemd user services), and Crontab fallback

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ACTION="${1:---enable}"

OS_NAME="$(uname -s)"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_FILE="$LAUNCH_AGENT_DIR/com.kickbacks.fleet.plist"

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/kickbacks-fleet.service"

CRON_MARKER="# kickbacks-fleet-autostart"
CRON_CMD="@reboot sleep 15 && $DIR/start.sh >> $DIR/logs/autostart.log 2>&1 $CRON_MARKER"

mkdir -p "$DIR/logs"

case "$ACTION" in
  --enable|enable)
    echo "========================================================"
    echo "⚙️  Configuring Boot Autostart for Kickbacks Fleet..."
    echo "========================================================"

    # 1. macOS LaunchAgent (Native, 100% reliable on macOS reboot/login)
    if [ "$OS_NAME" = "Darwin" ]; then
      mkdir -p "$LAUNCH_AGENT_DIR"
      
      # Unload previous instance if present
      launchctl unload "$LAUNCH_AGENT_FILE" >/dev/null 2>&1 || true

      cat > "$LAUNCH_AGENT_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kickbacks.fleet</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$DIR/start.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DIR/logs/autostart.log</string>
    <key>StandardErrorPath</key>
    <string>$DIR/logs/autostart.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
      launchctl load "$LAUNCH_AGENT_FILE" >/dev/null 2>&1 || true
      echo "✅ Enabled macOS LaunchAgent: $LAUNCH_AGENT_FILE"
    fi

    # 2. Linux Systemd User Service
    if command -v systemctl >/dev/null 2>&1; then
      mkdir -p "$SERVICE_DIR"
      cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Kickbacks Fleet Simulator and Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
WorkingDirectory=$DIR
ExecStart=$DIR/start.sh
ExecStop=$DIR/stop.sh
StandardOutput=append:$DIR/logs/autostart.log
StandardError=append:$DIR/logs/autostart.log

[Install]
WantedBy=default.target
EOF

      systemctl --user daemon-reload >/dev/null 2>&1 || true
      systemctl --user enable kickbacks-fleet.service >/dev/null 2>&1 || true
      echo "✅ Enabled Linux systemd user service: kickbacks-fleet.service"

      if command -v loginctl >/dev/null 2>&1; then
        loginctl enable-linger "$(whoami)" >/dev/null 2>&1 || true
        echo "✅ Enabled user lingering via loginctl"
      fi
    fi

    # 3. Crontab @reboot fallback
    if command -v crontab >/dev/null 2>&1; then
      CURRENT_CRON=$(crontab -l 2>/dev/null || true)
      if ! echo "$CURRENT_CRON" | grep -Fq "$CRON_MARKER"; then
        (echo "$CURRENT_CRON"; echo "$CRON_CMD") | grep -v "^\$" | crontab -
        echo "✅ Configured universal crontab @reboot fallback"
      else
        echo "ℹ️  Crontab @reboot entry already present"
      fi
    fi

    echo "========================================================"
    echo "🎉 Fleet will now automatically start on every PC restart/boot!"
    echo "   Logs will be written to: $DIR/logs/autostart.log"
    echo "========================================================"
    ;;

  --disable|disable)
    echo "========================================================"
    echo "🛑 Disabling Boot Autostart for Kickbacks Fleet..."
    echo "========================================================"

    # 1. macOS LaunchAgent
    if [ -f "$LAUNCH_AGENT_FILE" ]; then
      launchctl unload "$LAUNCH_AGENT_FILE" >/dev/null 2>&1 || true
      rm -f "$LAUNCH_AGENT_FILE"
      echo "✅ Removed macOS LaunchAgent: $LAUNCH_AGENT_FILE"
    fi

    # 2. Linux Systemd user service
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable kickbacks-fleet.service >/dev/null 2>&1 || true
      rm -f "$SERVICE_FILE"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      echo "✅ Removed Linux systemd user service"
    fi

    # 3. Crontab entry
    if command -v crontab >/dev/null 2>&1; then
      CURRENT_CRON=$(crontab -l 2>/dev/null || true)
      if echo "$CURRENT_CRON" | grep -Fq "$CRON_MARKER"; then
        echo "$CURRENT_CRON" | grep -v "$CRON_MARKER" | crontab -
        echo "✅ Removed crontab entry"
      fi
    fi

    echo "========================================================"
    echo "✅ Boot autostart disabled."
    echo "========================================================"
    ;;

  --status|status)
    echo "========================================================"
    echo "📊 Boot Autostart Status"
    echo "========================================================"
    if [ "$OS_NAME" = "Darwin" ]; then
      if [ -f "$LAUNCH_AGENT_FILE" ]; then
        echo "macOS LaunchAgent: Active ($LAUNCH_AGENT_FILE)"
      else
        echo "macOS LaunchAgent: Inactive"
      fi
    fi

    if command -v systemctl >/dev/null 2>&1 && [ -f "$SERVICE_FILE" ]; then
      echo "Systemd Service: Installed ($SERVICE_FILE)"
      systemctl --user is-enabled kickbacks-fleet.service 2>/dev/null || echo "Systemd Status: Disabled"
    elif [ "$OS_NAME" != "Darwin" ]; then
      echo "Systemd Service: Not installed"
    fi

    if command -v crontab >/dev/null 2>&1; then
      if crontab -l 2>/dev/null | grep -Fq "$CRON_MARKER"; then
        echo "Crontab @reboot: Active"
      else
        echo "Crontab @reboot: Inactive"
      fi
    fi
    echo "========================================================"
    ;;

  *)
    echo "Usage: $0 [--enable | --disable | --status]"
    exit 1
    ;;
esac
