---
title: systemd service
order: 15
---

# systemd service

NeuroClaw runs as `neuroclaw-dashboard.service` — a managed systemd service with automatic restarts and log collection via journald. The unit file lives at `/etc/systemd/system/neuroclaw-dashboard.service`.

## Current unit file

`/etc/systemd/system/neuroclaw-dashboard.service`:

```ini
[Unit]
Description=NeuroClaw Dashboard Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/neuroclaw-v1
ExecStartPre=-/bin/fuser -k 3141/tcp
ExecStart=/home/neuroclaw-v1/node_modules/.bin/tsx src/dashboard/server.ts
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=neuroclaw-dashboard

[Install]
WantedBy=multi-user.target
```

## Reference unit file (hardened production variant)

If you want to tighten the service for a clean production deploy, here is a hardened version. Create `/etc/systemd/system/neuroclaw-dashboard.service`:

```ini
[Unit]
Description=NeuroClaw Dashboard Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/neuroclaw-v1
ExecStartPre=-/bin/fuser -k 3141/tcp
ExecStart=/home/neuroclaw-v1/node_modules/.bin/tsx src/dashboard/server.ts
Restart=always
RestartSec=3
TimeoutStartSec=30
TimeoutStopSec=30

# Log to journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=neuroclaw-dashboard

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Initial setup (if starting fresh)

```bash
# Create the unit file (see above), then:

sudo systemctl daemon-reload

# Enable auto-start at boot
sudo systemctl enable neuroclaw-dashboard

# Enable AND start in one command
sudo systemctl enable --now neuroclaw-dashboard
```

---

> The sections below use `neuroclaw-dashboard` — the actual service name on this machine.

```ini
[Unit]
Description=NeuroClaw Multi-Agent System
Documentation=https://neuroclaw.local/dashboard
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=neuroclaw
Group=neuroclaw
WorkingDirectory=/opt/neuroclaw
ExecStart=/usr/bin/node dist/dashboard/server.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30

# Log to journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=neuroclaw

# Environment
Environment=NODE_ENV=production
EnvironmentFile=/opt/neuroclaw/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/neuroclaw
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Setup commands

```bash
# Reload systemd after creating or editing the unit file
sudo systemctl daemon-reload

# Enable auto-start at boot
sudo systemctl enable neuroclaw

# Start the service now
sudo systemctl start neuroclaw

# Enable AND start in one command
sudo systemctl enable --now neuroclaw
```

## Day-to-day management

```bash
# Start
sudo systemctl start neuroclaw-dashboard

# Stop
sudo systemctl stop neuroclaw-dashboard

# Restart (picks up code changes)
sudo systemctl restart neuroclaw-dashboard

# Status overview
sudo systemctl status neuroclaw-dashboard

# Check if enabled at boot
sudo systemctl is-enabled neuroclaw-dashboard

# Check if currently running
sudo systemctl is-active neuroclaw-dashboard
```

## Disable / remove

```bash
# Stop and disable auto-start
sudo systemctl disable --now neuroclaw-dashboard

# Remove the unit file entirely
sudo rm /etc/systemd/system/neuroclaw-dashboard.service
sudo systemctl daemon-reload
sudo systemctl reset-failed
```

## Logs (journald)

```bash
# Follow live output
sudo journalctl -u neuroclaw-dashboard -f

# Last 100 lines
sudo journalctl -u neuroclaw-dashboard -n 100

# Errors only (priority: err and above)
sudo journalctl -u neuroclaw-dashboard -p err

# Since last boot
sudo journalctl -u neuroclaw-dashboard -b

# Time range
sudo journalctl -u neuroclaw-dashboard --since "2024-01-01 00:00" --until "2024-01-02 00:00"

# Today only
sudo journalctl -u neuroclaw-dashboard --since today

# JSON output (useful for piping to jq)
sudo journalctl -u neuroclaw-dashboard -o json-pretty | head -40

# Disk usage for this unit's logs
sudo journalctl --disk-usage -u neuroclaw-dashboard
```

## Watching for crashes

```bash
# List recent failed units
sudo systemctl --failed

# Show crash details
sudo journalctl -u neuroclaw-dashboard -p err -b

# Reset a failed state so restart triggers again
sudo systemctl reset-failed neuroclaw-dashboard
```

## Editing the unit file

```bash
# Open unit file in $EDITOR and replace it entirely
sudo systemctl edit --full neuroclaw-dashboard

# Add an override snippet without replacing the whole file
sudo systemctl edit neuroclaw-dashboard
# This creates /etc/systemd/system/neuroclaw-dashboard.service.d/override.conf

# Reload after any edit
sudo systemctl daemon-reload

# View the final merged unit
sudo systemctl cat neuroclaw-dashboard
```

## Environment updates

When you change `/home/neuroclaw-v1/.env`:

```bash
# Restart to pick up new env vars
sudo systemctl restart neuroclaw-dashboard

# Verify the running environment
sudo systemctl show neuroclaw-dashboard --property=Environment
```

## Boot timing

```bash
# See how long NeuroClaw took to start at boot
systemd-analyze blame | grep neuroclaw

# Full boot waterfall
systemd-analyze plot > boot.svg
```

## Optional: CLI loop as a second service

If you want a persistent CLI loop alongside the dashboard, create `/etc/systemd/system/neuroclaw-cli.service`:

```ini
[Unit]
Description=NeuroClaw CLI loop
After=neuroclaw-dashboard.service
Requires=neuroclaw-dashboard.service

[Service]
Type=simple
User=root
WorkingDirectory=/home/neuroclaw-v1
ExecStart=/home/neuroclaw-v1/node_modules/.bin/tsx src/index.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=neuroclaw-cli

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now neuroclaw-cli
```

## Quick reference card

| Command | What it does |
|---|---|
| `systemctl start neuroclaw-dashboard` | Start the service |
| `systemctl stop neuroclaw-dashboard` | Stop the service |
| `systemctl restart neuroclaw-dashboard` | Stop then start |
| `systemctl status neuroclaw-dashboard` | Show status + last log lines |
| `systemctl enable neuroclaw-dashboard` | Auto-start at boot |
| `systemctl disable neuroclaw-dashboard` | Remove auto-start |
| `systemctl is-active neuroclaw-dashboard` | Print active/inactive |
| `systemctl is-enabled neuroclaw-dashboard` | Print enabled/disabled |
| `journalctl -u neuroclaw-dashboard -f` | Tail live logs |
| `journalctl -u neuroclaw-dashboard -n 100` | Last 100 log lines |
| `journalctl -u neuroclaw-dashboard -p err` | Errors only |
| `systemctl daemon-reload` | Reload unit files after edits |
| `systemctl reset-failed neuroclaw-dashboard` | Clear failed state |
| `systemctl cat neuroclaw-dashboard` | Print merged unit file |
