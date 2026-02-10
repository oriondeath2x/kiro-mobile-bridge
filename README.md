# Antigravity Mobile Bridge

A lightweight mobile interface that lets you monitor and control Antigravity IDE agent sessions from your phone over LAN, with a live preview of chat, tasks, and code via Chrome DevTools Protocol.

<img width="1829" height="1065" alt="Untitled design (4)" src="https://github.com/user-attachments/assets/d548c43b-4501-4d66-aed7-ad021a44f9cb" />


## Features

- 📱 Mobile-optimized web interface with tab navigation
- 💬 **Chat** - View and send messages to Antigravity's agent
- 📝 **Code** - Browse file explorer and view files with syntax highlighting
- 📋 **Tasks** - View and navigate Antigravity spec task files
- 🔄 Real-time updates via WebSocket with adaptive polling

## Prerequisites

- **Node.js** 18+ (uses ES modules)
- **Antigravity IDE**

## Quick Start

### 1. Enable CDP in Antigravity

Start Antigravity with the remote debugging port enabled:

**Run Antigravity with debugging port on CMD/Terminal:**
```bash
antigravity --remote-debugging-port=9000
```

**Important:** Your project must be open in Antigravity before you close it - the bridge needs an active session to detect and connect to. After that, start Antigravity from the terminal with the remote debugging port enabled.

### 2. Run with npx (Recommended)

Start Server

```bash
npx antigravity-bridge
```

#### Alternative: Clone and Run

```bash
git clone 
cd antigravity-bridge
npm install
npm start
```

You'll see output like:

```
Antigravity Mobile Bridge
─────────────────────
Local:   http://localhost:3000
Network: http://192.168.16.106:3000
Open the Network URL on your phone to monitor Antigravity.
```

### 3. Open on Your Phone

1. Make sure your phone is on the **same WiFi network** as your computer
2. Open the **Network URL** (e.g., `http://192.168.1.100:3000`) in your phone's browser
3. The interface will automatically connect and show your Antigravity session
4. Use the tabs to switch between Chat, Code, and Tasks panels


#### How It Works

```
┌─────────────────┐     CDP      ┌─────────────────┐
│ Antigravity IDE │◄────────────►│  Bridge Server  │
│ (port 9000-9003)│              │   (port 3000)   │
└─────────────────┘              └────────┬────────┘
                                          │
                                   HTTP + WebSocket
                                          │
                                 ┌────────▼────────┐
                                 │  Mobile Client  │
                                 │   (browser)     │
                                 └─────────────────┘
```

1. **Discovery**: Server scans ports 9000-9003, 9222, 9229 for Antigravity instances (adaptive: 10s → 30s when stable)
2. **Connection**: Connects to Antigravity via CDP WebSocket
3. **Snapshots**: Captures chat, editor, and tasks with adaptive polling (1s active → 3s idle)
4. **Messages**: Injects text into Antigravity's chat input via CDP

## Troubleshooting

#### "No sessions available"

- Make sure Antigravity is running with `--remote-debugging-port=9000`
- Check that Antigravity has a chat/agent session open
- Wait a few seconds for discovery 

#### Can't connect from phone

- Ensure phone and computer are on the **same network**
- Check your firewall allows connections on port 3000
- Try the IP address shown in the server output (not `localhost`)

#### Windows: Works on your computer but not on mobile, even on same WiFi.

**Root Cause:** Node.js firewall rule only allows **Public** networks by default. If your network is set to **Private**, mobile devices can't connect.

**Quick Fix - Option 1: Change Network to Public (Easiest)**
1. Open **Settings** → **Network & Internet**
2. Click your connection (WiFi or Ethernet)
3. Under "Network profile type", select **Public network (Recommended)**
4. Try accessing from mobile again

**Quick Fix - Option 2: Update Firewall Rule (Better for home networks)**

Run this command **as Administrator** (Win + X → Terminal Admin):
```cmd
netsh advfirewall firewall set rule name="Node.js JavaScript Runtime" new profile=private,public
```

#### Linux: Firewall blocking connections

If you're on Linux and can't connect from your phone, your firewall may be blocking port 3000. Allow it with:

```bash
# UFW (Ubuntu, Arch, etc.)
sudo ufw allow 3000/tcp

# Or with iptables directly
sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

## Security Notes

#### Designed for home and trusted networks.
- No authentication - just open the URL on your phone and start monitoring
- No HTTPS - keeps setup simple and fast
- Works instantly on any device connected to your WiFi

Best for trusted networks where you control the devices. If you're on public WiFi, anyone on that network could access the interface.


## License

MIT
