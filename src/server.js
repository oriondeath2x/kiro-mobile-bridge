#!/usr/bin/env node
/**
 * Antigravity Mobile Bridge Server
 * A mobile web interface for monitoring Antigravity IDE agent sessions from your phone over LAN.
 * Captures snapshots of the chat interface via CDP and lets you send messages remotely.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Services
import { fetchCDPTargets, connectToCDP } from './services/cdp.js';
import { captureMetadata, captureCSS, captureSnapshot, captureEditor } from './services/snapshot.js';

// Utils
import { generateId, computeHash } from './utils/hash.js';
import { getLocalIP } from './utils/network.js';
import {
  CDP_PORTS,
  DISCOVERY_INTERVAL_ACTIVE,
  DISCOVERY_INTERVAL_STABLE,
  SNAPSHOT_INTERVAL_ACTIVE,
  SNAPSHOT_INTERVAL_IDLE,
  SNAPSHOT_IDLE_THRESHOLD
} from './utils/constants.js';

// Routes
import { createApiRouter } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

const PORT = process.env.PORT || 3000;

// =============================================================================
// State Management
// =============================================================================

const cascades = new Map(); // cascadeId -> { id, cdp, metadata, snapshot, css, snapshotHash, editor, editorHash }
const mainWindowCDP = { connection: null, id: null };

const pollingState = {
  lastCascadeCount: 0,
  lastMainWindowConnected: false,
  discoveryInterval: null,
  discoveryIntervalMs: DISCOVERY_INTERVAL_ACTIVE,
  stableCount: 0,
  snapshotInterval: null,
  snapshotIntervalMs: SNAPSHOT_INTERVAL_ACTIVE,
  lastSnapshotChange: Date.now(),
  idleThreshold: SNAPSHOT_IDLE_THRESHOLD
};

// =============================================================================
// Discovery Service
// =============================================================================

async function discoverTargets() {
  const foundCascadeIds = new Set();
  let foundMainWindow = false;
  let stateChanged = false;
  
  const portResults = await Promise.allSettled(
    CDP_PORTS.map(port => fetchCDPTargets(port).then(targets => ({ port, targets })))
  );
  
  for (const result of portResults) {
    if (result.status !== 'fulfilled') continue;
    const { port, targets } = result.value;
    
    try {
      // Find main VS Code / Antigravity window
      const mainWindowTarget = targets.find(target => {
        const url = (target.url || '').toLowerCase();
        const title = (target.title || '').toLowerCase();
        return target.type === 'page' && 
               (url.startsWith('vscode-file://') || url.includes('workbench') || url.includes('antigravity') || title.includes('antigravity')) &&
               target.webSocketDebuggerUrl;
      });
      
      if (mainWindowTarget && !mainWindowCDP.connection) {
        console.log(`[Discovery] Found main window: ${mainWindowTarget.title}`);
        try {
          const cdp = await connectToCDP(mainWindowTarget.webSocketDebuggerUrl);
          mainWindowCDP.connection = cdp;
          mainWindowCDP.id = generateId(mainWindowTarget.webSocketDebuggerUrl);
          foundMainWindow = true;
          stateChanged = true;
          
          cdp.ws.on('close', () => {
            console.log(`[Discovery] Main window disconnected`);
            mainWindowCDP.connection = null;
            mainWindowCDP.id = null;
            adjustDiscoveryInterval(true);
          });
        } catch (err) {
          console.error(`[Discovery] Failed to connect to main window: ${err.message}`);
        }
      } else if (mainWindowTarget) {
        foundMainWindow = true;
      }
      
      // Find Antigravity Agent webviews
      const kiroAgentTargets = targets.filter(target => {
        const url = (target.url || '').toLowerCase();
        const title = (target.title || '').toLowerCase();

        // Check for Antigravity specific agent panels
        const isAntigravityAgent = url.includes('workbench-jetski-agent.html') ||
                                   url.includes('cascade-panel.html') ||
                                   title.includes('launchpad');

        // Legacy/Fallback check
        const isLegacyAgent = (url.includes('kiroagent') || url.includes('vscode-webview'));

        // Relax type check for Antigravity agent panels as they might appear as pages
        const isValidType = target.type !== 'page' || isAntigravityAgent;

        return (isAntigravityAgent || isLegacyAgent) &&
               target.webSocketDebuggerUrl && isValidType;
      });
      
      for (const target of kiroAgentTargets) {
        const wsUrl = target.webSocketDebuggerUrl;
        const cascadeId = generateId(wsUrl);
        foundCascadeIds.add(cascadeId);
        
        if (!cascades.has(cascadeId)) {
          stateChanged = true;
          
          try {
            const cdp = await connectToCDP(wsUrl);
            
            cascades.set(cascadeId, {
              id: cascadeId,
              cdp,
              metadata: { windowTitle: target.title || 'Unknown', chatTitle: '', isActive: true },
              snapshot: null,
              css: null,
              snapshotHash: null,
              editor: null,
              editorHash: null
            });
            
            cdp.ws.on('close', () => {
              console.log(`[Discovery] Cascade disconnected: ${cascadeId}`);
              cascades.delete(cascadeId);
              broadcastCascadeList();
              adjustDiscoveryInterval(true);
            });
            
            broadcastCascadeList();
          } catch (err) {
            console.error(`[Discovery] Failed to connect to ${cascadeId}: ${err.message}`);
          }
        } else {
          cascades.get(cascadeId).metadata.windowTitle = target.title || cascades.get(cascadeId).metadata.windowTitle;
        }
      }
    } catch (err) {
      // Log port scanning errors for debugging
      console.debug(`[Discovery] Error scanning port ${port}: ${err.message}`);
    }
  }

  // Fallback: If no dedicated agent targets found, use Main Window as fallback
  // This supports cases where the agent is an iframe within the main window (not a separate target)
  const FALLBACK_ID = 'main-window-fallback';
  if (foundCascadeIds.size === 0 && mainWindowCDP.connection) {
    foundCascadeIds.add(FALLBACK_ID);
    if (!cascades.has(FALLBACK_ID)) {
      console.log('[Discovery] No agent targets found. Falling back to Main Window.');
      stateChanged = true;
      cascades.set(FALLBACK_ID, {
        id: FALLBACK_ID,
        cdp: mainWindowCDP.connection, // Share connection
        metadata: { windowTitle: 'Main Window (Fallback)', chatTitle: 'Antigravity', isActive: true },
        snapshot: null,
        css: null,
        snapshotHash: null,
        editor: null,
        editorHash: null,
        isFallback: true // Mark as fallback to prevent closing shared connection
      });
      broadcastCascadeList();
    }
  }
  
  // Clean up disconnected targets
  for (const [cascadeId, cascade] of cascades) {
    if (!foundCascadeIds.has(cascadeId)) {
      console.log(`[Discovery] Target no longer available: ${cascadeId}`);
      stateChanged = true;

      // Only close connection if it's NOT a fallback (shared) connection
      if (!cascade.isFallback) {
        try {
          cascade.cdp.close();
        } catch (e) {
          console.debug(`[Discovery] Error closing cascade ${cascadeId}: ${e.message}`);
        }
      }

      cascades.delete(cascadeId);
      broadcastCascadeList();
    }
  }
  
  const mainWindowChanged = foundMainWindow !== pollingState.lastMainWindowConnected;
  const cascadeCountChanged = cascades.size !== pollingState.lastCascadeCount;
  
  if (stateChanged || mainWindowChanged || cascadeCountChanged) {
    console.log(`[Discovery] Active cascades: ${cascades.size}${foundMainWindow ? ' (main window connected)' : ''}`);
    pollingState.lastCascadeCount = cascades.size;
    pollingState.lastMainWindowConnected = foundMainWindow;
    adjustDiscoveryInterval(true);
  } else {
    adjustDiscoveryInterval(false);
  }
}

// =============================================================================
// Snapshot Polling
// =============================================================================

async function pollSnapshots() {
  let anyChanges = false;
  
  for (const [cascadeId, cascade] of cascades) {
    try {
      const cdp = cascade.cdp;
      
      // Capture CSS once
      if (cascade.css === null) {
        cascade.css = await captureCSS(cdp);
      }
      
      // Capture metadata
      const metadata = await captureMetadata(cdp);
      cascade.metadata.chatTitle = metadata.chatTitle || cascade.metadata.chatTitle;
      cascade.metadata.isActive = metadata.isActive;
      
      // Capture chat snapshot
      const snapshot = await captureSnapshot(cdp);
      if (snapshot) {
        const newHash = computeHash(snapshot.html);
        if (newHash !== cascade.snapshotHash) {
          cascade.snapshot = snapshot;
          cascade.snapshotHash = newHash;
          broadcastSnapshotUpdate(cascadeId, 'chat');
          anyChanges = true;
        }
      }
      
      // Capture editor from main window
      // Store rootContextId locally to avoid race conditions during async operations
      const mainCDP = mainWindowCDP.connection;
      const contextId = mainCDP?.rootContextId;
      if (mainCDP && contextId) {
        const editor = await captureEditor(mainCDP);
        if (editor?.hasContent) {
          const editorHash = computeHash(editor.content + editor.fileName);
          if (editorHash !== cascade.editorHash) {
            cascade.editor = editor;
            cascade.editorHash = editorHash;
            broadcastSnapshotUpdate(cascadeId, 'editor');
            anyChanges = true;
          }
        } else if (cascade.editor?.hasContent) {
          cascade.editor = { hasContent: false, fileName: '', content: '' };
          cascade.editorHash = '';
          broadcastSnapshotUpdate(cascadeId, 'editor');
          anyChanges = true;
        }
      }
    } catch (err) {
      console.error(`[Snapshot] Error polling cascade ${cascadeId}:`, err.message);
    }
  }
  
  adjustSnapshotInterval(anyChanges);
}

// =============================================================================
// Adaptive Polling
// =============================================================================

function adjustDiscoveryInterval(hasChanges) {
  if (hasChanges) {
    pollingState.stableCount = 0;
    if (pollingState.discoveryIntervalMs !== DISCOVERY_INTERVAL_ACTIVE) {
      pollingState.discoveryIntervalMs = DISCOVERY_INTERVAL_ACTIVE;
      restartDiscoveryInterval();
    }
  } else {
    pollingState.stableCount++;
    if (pollingState.stableCount >= 3 && pollingState.discoveryIntervalMs !== DISCOVERY_INTERVAL_STABLE) {
      pollingState.discoveryIntervalMs = DISCOVERY_INTERVAL_STABLE;
      restartDiscoveryInterval();
      console.log('[Discovery] Stable state, slowing to 30s interval');
    }
  }
}

function restartDiscoveryInterval() {
  if (pollingState.discoveryInterval) clearInterval(pollingState.discoveryInterval);
  pollingState.discoveryInterval = setInterval(discoverTargets, pollingState.discoveryIntervalMs);
}

function adjustSnapshotInterval(hasChanges) {
  const now = Date.now();
  if (hasChanges) {
    pollingState.lastSnapshotChange = now;
    if (pollingState.snapshotIntervalMs !== SNAPSHOT_INTERVAL_ACTIVE) {
      pollingState.snapshotIntervalMs = SNAPSHOT_INTERVAL_ACTIVE;
      restartSnapshotInterval();
    }
  } else {
    const idleTime = now - pollingState.lastSnapshotChange;
    if (idleTime > pollingState.idleThreshold && pollingState.snapshotIntervalMs !== SNAPSHOT_INTERVAL_IDLE) {
      pollingState.snapshotIntervalMs = SNAPSHOT_INTERVAL_IDLE;
      restartSnapshotInterval();
    }
  }
}

function restartSnapshotInterval() {
  if (pollingState.snapshotInterval) clearInterval(pollingState.snapshotInterval);
  pollingState.snapshotInterval = setInterval(pollSnapshots, pollingState.snapshotIntervalMs);
}

// =============================================================================
// WebSocket Broadcasting
// =============================================================================

let wss; // Will be set after server creation

function broadcastSnapshotUpdate(cascadeId, panel = 'chat') {
  if (!wss) return;
  const message = JSON.stringify({ type: 'snapshot_update', cascadeId, panel });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function broadcastCascadeList() {
  if (!wss) return;
  const cascadeList = Array.from(cascades.values()).map(c => ({
    id: c.id,
    title: c.metadata?.chatTitle || c.metadata?.windowTitle || 'Unknown',
    window: c.metadata?.windowTitle || 'Unknown',
    active: c.metadata?.isActive || false
  }));
  
  const message = JSON.stringify({ type: 'cascade_list', cascades: cascadeList });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

// =============================================================================
// Express App Setup
// =============================================================================

const app = express();
app.use(express.json({ limit: '1mb' })); // Limit request body size

// Disable caching for development - ensures latest code is always served
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(join(__dirname, 'public')));

// Mount API routes
app.use('/', createApiRouter(cascades, mainWindowCDP));

// =============================================================================
// Server Startup
// =============================================================================

const httpServer = createServer(app);

wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress || 'unknown';
  console.log(`[WebSocket] Client connected from ${clientIP}`);
  
  // Send cascade list on connect
  const cascadeList = Array.from(cascades.values()).map(c => ({
    id: c.id,
    title: c.metadata?.chatTitle || c.metadata?.windowTitle || 'Unknown',
    window: c.metadata?.windowTitle || 'Unknown',
    active: c.metadata?.isActive || false
  }));
  
  ws.send(JSON.stringify({ type: 'cascade_list', cascades: cascadeList }));
  
  ws.on('close', () => console.log(`[WebSocket] Client disconnected from ${clientIP}`));
  ws.on('error', (err) => console.error(`[WebSocket] Error from ${clientIP}:`, err.message));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('Antigravity Mobile Bridge');
  console.log('─────────────────────');
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://${localIP}:${PORT}`);
  console.log('');
  console.log('Open the Network URL on your phone to monitor Antigravity.');
  console.log('');
  
  // Start discovery and polling
  discoverTargets();
  pollingState.discoveryInterval = setInterval(discoverTargets, pollingState.discoveryIntervalMs);
  pollingState.snapshotInterval = setInterval(pollSnapshots, pollingState.snapshotIntervalMs);
});
