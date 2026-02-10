/**
 * API Routes - REST endpoints for mobile client
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { injectMessage } from '../services/message.js';
import { clickElement } from '../services/click.js';
import {
  validatePathWithinRoot,
  sanitizeClickInfo,
  validateMessage,
  sanitizeFilePath
} from '../utils/security.js';
import {
  getLanguageFromExtension,
  isCodeFile,
  MAX_FILE_SEARCH_DEPTH,
  MAX_WORKSPACE_DEPTH
} from '../utils/constants.js';

/**
 * Create API router
 * @param {Map} cascades - Cascade connections map
 * @param {object} mainWindowCDP - Main window CDP connection
 * @returns {Router} - Express router
 */
export function createApiRouter(cascades, mainWindowCDP) {
  const router = Router();

  // GET /snapshot/:id - Get HTML snapshot for a cascade
  router.get('/snapshot/:id', (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.snapshot) return res.status(404).json({ error: 'No snapshot available' });
    res.json(cascade.snapshot);
  });

  // GET /styles/:id - Get CSS for a cascade
  router.get('/styles/:id', (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.css) return res.status(404).json({ error: 'No styles available' });
    res.type('text/css').send(cascade.css);
  });

  // GET /editor/:id - Get editor snapshot
  router.get('/editor/:id', (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.editor?.hasContent) return res.status(404).json({ error: 'No editor content available' });
    res.json(cascade.editor);
  });

  // POST /send/:id - Send message to chat
  router.post('/send/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

    const { message } = req.body;

    // Validate message input
    const validation = validateMessage(message);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    if (!cascade.cdp) return res.status(503).json({ error: 'CDP connection not available' });

    // Log message length only, not content (security)
    console.log(`[Send] Message to ${req.params.id}: ${message.length} chars`);
    const result = await injectMessage(cascade.cdp, message);

    if (result.success) {
      res.json({ success: true, method: result.method });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  });

  // POST /click/:id - Click UI element
  router.post('/click/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.cdp?.rootContextId) return res.status(503).json({ error: 'CDP not available' });

    // Validate and sanitize click info
    const { valid, sanitized, error } = sanitizeClickInfo(req.body);
    if (!valid) {
      return res.status(400).json({ error: error || 'Invalid click info' });
    }

    console.log(`[Click] ${sanitized.text?.substring(0, 30) || sanitized.ariaLabel || sanitized.tag || 'element'}`);

    try {
      const result = await clickElement(cascade.cdp, sanitized);
      res.json(result);
    } catch (err) {
      console.error('[Click] Error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /debug-model/:id - Debug model selector structure
  router.get('/debug-model/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.cdp?.rootContextId) return res.status(503).json({ error: 'CDP not available' });

    const script = `(function() {
      let targetDoc = document;
      const activeFrame = document.getElementById('active-frame');
      if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
      
      const results = {
        dropdownOpen: false,
        dropdownItems: [],
        dropdownContainer: null,
        autopilotToggle: null
      };
      
      // Check if dropdown is open
      const openDropdown = targetDoc.querySelector('.kiro-dropdown-menu, .antigravity-dropdown-menu, [class*="dropdown-menu"], [class*="dropdown-content"], [role="listbox"], [role="menu"]');
      if (openDropdown && openDropdown.offsetParent !== null) {
        results.dropdownOpen = true;
        results.dropdownContainer = {
          tag: openDropdown.tagName,
          className: (openDropdown.className || '').substring(0, 100),
          role: openDropdown.getAttribute('role'),
          innerHTML: openDropdown.innerHTML.substring(0, 1000)
        };
        
        // Find all items in the dropdown
        const items = openDropdown.querySelectorAll('.kiro-dropdown-item, .antigravity-dropdown-item, [role="option"], [role="menuitem"], [class*="dropdown-item"], [class*="menu-item"], > div, > button');
        items.forEach(item => {
          results.dropdownItems.push({
            tag: item.tagName,
            className: (item.className || '').substring(0, 80),
            text: (item.textContent || '').substring(0, 100),
            role: item.getAttribute('role'),
            dataValue: item.getAttribute('data-value'),
            onclick: !!item.onclick,
            cursor: window.getComputedStyle(item).cursor
          });
        });
      }
      
      // Find Autopilot toggle
      const autopilotElements = targetDoc.querySelectorAll('[class*="toggle"], input[type="checkbox"]');
      for (const el of autopilotElements) {
        const parent = el.closest('.kiro-toggle-switch, .antigravity-toggle-switch, [class*="toggle"]');
        if (parent) {
          const label = parent.querySelector('label');
          const labelText = label ? label.textContent.toLowerCase() : '';
          if (labelText.includes('autopilot') || labelText.includes('auto')) {
            results.autopilotToggle = {
              toggleElement: {
                tag: el.tagName,
                type: el.type,
                className: (el.className || '').substring(0, 80),
                checked: el.checked,
                id: el.id
              },
              parentElement: {
                tag: parent.tagName,
                className: (parent.className || '').substring(0, 80),
                onclick: !!parent.onclick
              },
              labelText: labelText
            };
            break;
          }
        }
      }
      
      return results;
    })()`;

    try {
      const result = await cascade.cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: cascade.cdp.rootContextId,
        returnByValue: true
      });

      const data = result.result?.value;
      console.log('[Debug] UI structure:', JSON.stringify(data, null, 2));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /debug-toggle/:id - Debug toggle/switch structure in detail
  router.get('/debug-toggle/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.cdp?.rootContextId) return res.status(503).json({ error: 'CDP not available' });

    const script = `(function() {
      let targetDoc = document;
      const activeFrame = document.getElementById('active-frame');
      if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
      
      const results = {
        toggles: [],
        switchRoles: []
      };
      
      // Find all toggle-like elements
      const toggleSelectors = [
        '.kiro-toggle-switch',
        '.antigravity-toggle-switch',
        '[role="switch"]',
        'input[type="checkbox"]',
        '[class*="toggle"]',
        '[class*="Toggle"]',
        '[class*="switch"]',
        '[class*="Switch"]'
      ];
      
      for (const sel of toggleSelectors) {
        try {
          const elements = targetDoc.querySelectorAll(sel);
          elements.forEach(el => {
            if (el.offsetParent === null) return;
            
            const label = el.querySelector('label') || el.closest('[class*="toggle"]')?.querySelector('label');
            const input = el.querySelector('input[type="checkbox"]') || (el.type === 'checkbox' ? el : null);
            const parent = el.parentElement;
            
            const toggleInfo = {
              selector: sel,
              tag: el.tagName,
              className: (el.className || '').substring(0, 150),
              role: el.getAttribute('role'),
              ariaChecked: el.getAttribute('aria-checked'),
              dataState: el.getAttribute('data-state'),
              labelText: label ? label.textContent.trim() : '',
              inputChecked: input ? input.checked : null,
              inputAriaChecked: input ? input.getAttribute('aria-checked') : null,
              cursor: window.getComputedStyle(el).cursor,
              parentTag: parent?.tagName,
              parentClass: (parent?.className || '').substring(0, 80)
            };
            
            // Check if this is the Autopilot toggle
            if (toggleInfo.labelText.toLowerCase().includes('autopilot')) {
              toggleInfo.isAutopilot = true;
            }
            
            results.toggles.push(toggleInfo);
          });
        } catch(e) {}
      }
      
      // Deduplicate by removing entries with same labelText
      const seen = new Set();
      results.toggles = results.toggles.filter(t => {
        if (!t.labelText) return true;
        if (seen.has(t.labelText)) return false;
        seen.add(t.labelText);
        return true;
      });
      
      return results;
    })()`;

    try {
      const result = await cascade.cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: cascade.cdp.rootContextId,
        returnByValue: true
      });

      const data = result.result?.value;
      console.log('[Debug Toggle] Structure:', JSON.stringify(data, null, 2));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /debug-welcome/:id - Debug welcome/onboarding screen structure
  router.get('/debug-welcome/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.cdp?.rootContextId) return res.status(503).json({ error: 'CDP not available' });

    const script = `(function() {
      let targetDoc = document;
      const activeFrame = document.getElementById('active-frame');
      if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
      
      const results = {
        vibeElements: [],
        specElements: [],
        clickableCards: [],
        allTextMatches: []
      };
      
      // Find elements containing "Vibe" or "Spec" text
      const allElements = targetDoc.querySelectorAll('*');
      for (const el of allElements) {
        if (el.offsetParent === null) continue;
        const text = (el.textContent || '').trim();
        const directText = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 
          ? el.childNodes[0].textContent.trim() : '';
        
        if (text.toLowerCase().includes('vibe') && text.length < 500) {
          const computedStyle = window.getComputedStyle(el);
          results.vibeElements.push({
            tag: el.tagName,
            className: (el.className || '').substring(0, 150),
            text: text.substring(0, 200),
            directText: directText.substring(0, 100),
            cursor: computedStyle.cursor,
            role: el.getAttribute('role'),
            tabindex: el.getAttribute('tabindex'),
            childCount: el.children.length,
            parentTag: el.parentElement?.tagName,
            parentClass: (el.parentElement?.className || '').substring(0, 100)
          });
        }
        
        if (text.toLowerCase().includes('spec') && text.length < 500 && !text.toLowerCase().includes('inspect')) {
          const computedStyle = window.getComputedStyle(el);
          results.specElements.push({
            tag: el.tagName,
            className: (el.className || '').substring(0, 150),
            text: text.substring(0, 200),
            directText: directText.substring(0, 100),
            cursor: computedStyle.cursor,
            role: el.getAttribute('role'),
            tabindex: el.getAttribute('tabindex'),
            childCount: el.children.length,
            parentTag: el.parentElement?.tagName,
            parentClass: (el.parentElement?.className || '').substring(0, 100)
          });
        }
      }
      
      // Find clickable card-like elements
      const cardSelectors = [
        '[class*="card"]', '[class*="Card"]',
        '[class*="choice"]', '[class*="Choice"]',
        '[class*="option"]', '[class*="Option"]',
        '[role="button"]', '[tabindex="0"]'
      ];
      
      for (const sel of cardSelectors) {
        try {
          const cards = targetDoc.querySelectorAll(sel);
          for (const card of cards) {
            if (card.offsetParent === null) continue;
            const text = (card.textContent || '').trim();
            if (text.length < 10 || text.length > 500) continue;
            
            const computedStyle = window.getComputedStyle(card);
            results.clickableCards.push({
              selector: sel,
              tag: card.tagName,
              className: (card.className || '').substring(0, 150),
              text: text.substring(0, 200),
              cursor: computedStyle.cursor,
              role: card.getAttribute('role'),
              tabindex: card.getAttribute('tabindex'),
              childCount: card.children.length
            });
          }
        } catch(e) {}
      }
      
      return results;
    })()`;

    try {
      const result = await cascade.cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: cascade.cdp.rootContextId,
        returnByValue: true
      });

      const data = result.result?.value;
      console.log('[Debug Welcome] Structure:', JSON.stringify(data, null, 2));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /debug-snackbar/:id - Debug snackbar/command trust dialog structure
  router.get('/debug-snackbar/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.cdp?.rootContextId) return res.status(503).json({ error: 'CDP not available' });

    const script = `(function() {
      let targetDoc = document;
      const activeFrame = document.getElementById('active-frame');
      if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
      
      const results = {
        snackbars: [],
        clickableElements: [],
        buttons: []
      };
      
      // Find all snackbars
      const snackbarSelectors = ['.kiro-snackbar', '.antigravity-snackbar', '[class*="snackbar"]', '[class*="notification"]', '[class*="toast"]'];
      for (const sel of snackbarSelectors) {
        try {
          const snackbars = targetDoc.querySelectorAll(sel);
          snackbars.forEach(snackbar => {
            if (snackbar.offsetParent === null) return;
            
            const snackbarInfo = {
              selector: sel,
              className: (snackbar.className || '').substring(0, 150),
              text: (snackbar.textContent || '').substring(0, 500),
              children: []
            };
            
            // Find all clickable children
            const clickables = snackbar.querySelectorAll('button, [role="button"], [tabindex="0"], div');
            clickables.forEach(el => {
              if (el.offsetParent === null) return;
              if (el.children.length > 10) return;
              
              const elText = (el.textContent || '').trim();
              if (elText.length < 3 || elText.length > 200) return;
              
              const computedStyle = window.getComputedStyle(el);
              snackbarInfo.children.push({
                tag: el.tagName,
                text: elText.substring(0, 100),
                className: (el.className || '').substring(0, 80),
                cursor: computedStyle.cursor,
                bgColor: computedStyle.backgroundColor,
                role: el.getAttribute('role'),
                tabindex: el.getAttribute('tabindex'),
                hasOnclick: !!el.onclick
              });
            });
            
            results.snackbars.push(snackbarInfo);
          });
        } catch(e) {}
      }
      
      // Find all buttons in the page
      const allButtons = targetDoc.querySelectorAll('button, [role="button"]');
      allButtons.forEach(btn => {
        if (btn.offsetParent === null) return;
        const btnText = (btn.textContent || '').trim();
        const ariaLabel = btn.getAttribute('aria-label') || '';
        
        // Check for action icons
        const hasPlayIcon = btn.querySelector('.codicon-play, .codicon-run');
        const hasEditIcon = btn.querySelector('.codicon-edit');
        const hasCheckIcon = btn.querySelector('.codicon-check');
        
        if (hasPlayIcon || hasEditIcon || hasCheckIcon || ariaLabel || btnText) {
          const computedStyle = window.getComputedStyle(btn);
          results.buttons.push({
            text: btnText.substring(0, 50),
            ariaLabel: ariaLabel,
            className: (btn.className || '').substring(0, 80),
            bgColor: computedStyle.backgroundColor,
            hasPlayIcon: !!hasPlayIcon,
            hasEditIcon: !!hasEditIcon,
            hasCheckIcon: !!hasCheckIcon
          });
        }
      });
      
      return results;
    })()`;

    try {
      const result = await cascade.cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: cascade.cdp.rootContextId,
        returnByValue: true
      });

      const data = result.result?.value;
      console.log('[Debug Snackbar] Structure:', JSON.stringify(data, null, 2));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /debug-compare/:id - Compare working vs non-working button structures
  router.get('/debug-compare/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });
    if (!cascade.cdp?.rootContextId) return res.status(503).json({ error: 'CDP not available' });

    const searchText = req.query.text || 'keep optional';

    const script = `(function() {
      let targetDoc = document;
      const activeFrame = document.getElementById('active-frame');
      if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
      
      const searchText = '${searchText}'.toLowerCase();
      const results = {
        searchText: searchText,
        matchingElements: [],
        snackbarInfo: null,
        dialogInfo: null,
        allContexts: []
      };
      
      // Find ALL elements containing the search text
      const allElements = targetDoc.querySelectorAll('*');
      for (const el of allElements) {
        const elText = (el.textContent || '').trim().toLowerCase();
        if (!elText.includes(searchText)) continue;
        if (el.children.length > 15) continue; // Skip containers
        
        const rect = el.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(el);
        
        // Get React fiber info if available
        let reactFiber = null;
        for (const key of Object.keys(el)) {
          if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
            reactFiber = key;
            break;
          }
        }
        
        // Check for event listeners
        const hasReactOnClick = !!el.onclick || Object.keys(el).some(k => k.includes('onClick') || k.includes('onMouseDown'));
        
        results.matchingElements.push({
          tag: el.tagName,
          className: (el.className || '').substring(0, 150),
          text: elText.substring(0, 100),
          textLength: elText.length,
          cursor: computedStyle.cursor,
          pointerEvents: computedStyle.pointerEvents,
          position: computedStyle.position,
          zIndex: computedStyle.zIndex,
          role: el.getAttribute('role'),
          tabindex: el.getAttribute('tabindex'),
          ariaLabel: el.getAttribute('aria-label'),
          dataState: el.getAttribute('data-state'),
          childCount: el.children.length,
          rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
          isVisible: el.offsetParent !== null,
          hasReactFiber: !!reactFiber,
          reactFiberKey: reactFiber,
          hasReactOnClick: hasReactOnClick,
          parentTag: el.parentElement?.tagName,
          parentClass: (el.parentElement?.className || '').substring(0, 100),
          grandparentTag: el.parentElement?.parentElement?.tagName,
          grandparentClass: (el.parentElement?.parentElement?.className || '').substring(0, 100),
          inSnackbar: !!el.closest('.kiro-snackbar, .antigravity-snackbar, [class*="snackbar"]'),
          inDialog: !!el.closest('[role="dialog"], [class*="dialog"]')
        });
      }
      
      // Sort by text length (shorter = more specific)
      results.matchingElements.sort((a, b) => a.textLength - b.textLength);
      
      // Get snackbar structure
      const snackbar = targetDoc.querySelector('.kiro-snackbar, .antigravity-snackbar');
      if (snackbar) {
        results.snackbarInfo = {
          className: snackbar.className,
          childCount: snackbar.children.length,
          innerHTML: snackbar.innerHTML.substring(0, 2000)
        };
      }
      
      return results;
    })()`;

    try {
      const result = await cascade.cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: cascade.cdp.rootContextId,
        returnByValue: true
      });

      const data = result.result?.value;
      console.log('[Debug Compare] Results for "' + searchText + '":', JSON.stringify(data, null, 2));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /readFile/:id - Read file from filesystem
  router.post('/readFile/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

    const { filePath } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'filePath is required and must be a string' });
    }

    // Sanitize the file path
    const sanitizedPath = sanitizeFilePath(filePath);
    if (!sanitizedPath) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    console.log(`[ReadFile] Request for: ${sanitizedPath}`);

    try {
      // Get workspace root
      const workspaceRoot = await getWorkspaceRoot(mainWindowCDP) || process.cwd();
      console.log(`[ReadFile] Workspace root: ${workspaceRoot}`);

      // SECURITY: Validate path is within workspace root
      const pathValidation = validatePathWithinRoot(sanitizedPath, workspaceRoot);

      let content = null;
      let foundPath = null;

      // Try 1: Direct path validation
      if (pathValidation.valid) {
        try {
          content = await fs.readFile(pathValidation.resolvedPath, 'utf-8');
          foundPath = pathValidation.resolvedPath;
          console.log(`[ReadFile] Found at validated path: ${foundPath}`);
        } catch (e) {
          // File doesn't exist at validated path, try other methods
        }
      }

      // Try 2: Common path variations
      if (!content) {
        const pathVariations = [
          sanitizedPath,
          sanitizedPath.replace(/^\.\//, ''),  // Remove leading ./
          sanitizedPath.replace(/^\//, ''),     // Remove leading /
          `src/${sanitizedPath}`,               // Try in src/
          `src/${sanitizedPath.replace(/^src\//, '')}`,
        ];

        for (const variation of pathVariations) {
          const varValidation = validatePathWithinRoot(variation, workspaceRoot);
          if (varValidation.valid) {
            try {
              content = await fs.readFile(varValidation.resolvedPath, 'utf-8');
              foundPath = varValidation.resolvedPath;
              console.log(`[ReadFile] Found at variation: ${foundPath}`);
              break;
            } catch (e) {
              // Continue to next variation
            }
          }
        }
      }

      // Try 3: Search by filename within workspace
      if (!content) {
        const fileName = path.basename(sanitizedPath);
        console.log(`[ReadFile] Searching for filename: ${fileName}`);
        foundPath = await findFileRecursive(workspaceRoot, fileName, MAX_FILE_SEARCH_DEPTH);

        if (foundPath) {
          // Validate the found path is still within workspace
          const foundValidation = validatePathWithinRoot(foundPath, workspaceRoot);
          if (foundValidation.valid) {
            content = await fs.readFile(foundPath, 'utf-8');
            console.log(`[ReadFile] Found via search: ${foundPath}`);
          } else {
            console.warn(`[ReadFile] Found file outside workspace: ${foundPath}`);
            foundPath = null;
          }
        }
      }

      // Try 4: Search with partial path matching
      if (!content && sanitizedPath.includes('/')) {
        const pathParts = sanitizedPath.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const parentDir = pathParts[pathParts.length - 2];

        if (parentDir && fileName) {
          console.log(`[ReadFile] Searching for ${parentDir}/${fileName}`);
          foundPath = await findFileWithParent(workspaceRoot, parentDir, fileName, MAX_FILE_SEARCH_DEPTH);

          if (foundPath) {
            const foundValidation = validatePathWithinRoot(foundPath, workspaceRoot);
            if (foundValidation.valid) {
              content = await fs.readFile(foundPath, 'utf-8');
              console.log(`[ReadFile] Found via parent search: ${foundPath}`);
            }
          }
        }
      }

      if (!content) {
        console.log(`[ReadFile] File not found: ${sanitizedPath}`);
        return res.status(404).json({ error: 'File not found within workspace' });
      }

      const language = getLanguageFromExtension(sanitizedPath);

      res.json({
        content,
        fileName: path.basename(foundPath || sanitizedPath),
        fullPath: foundPath,
        language,
        lineCount: content.split('\n').length,
        hasContent: true
      });
    } catch (err) {
      console.error('[ReadFile] Error:', err.message);
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // GET /files/:id - List workspace files
  router.get('/files/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

    try {
      const workspaceRoot = await getWorkspaceRoot(mainWindowCDP) || process.cwd();
      const files = await collectWorkspaceFiles(workspaceRoot);

      console.log(`[Files] Found ${files.length} files in ${workspaceRoot}`);
      res.json({ files, workspaceRoot });
    } catch (err) {
      console.error('[Files] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id - List task files from .antigravity/specs (or .kiro/specs)
  router.get('/tasks/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

    try {
      const workspaceRoot = await getWorkspaceRoot(mainWindowCDP) || process.cwd();
      const tasks = [];

      // Check both .antigravity/specs and .kiro/specs
      const specPaths = [
        path.join(workspaceRoot, '.antigravity', 'specs'),
        path.join(workspaceRoot, '.kiro', 'specs')
      ];

      for (const specsPath of specPaths) {
        try {
          await fs.access(specsPath);
          const specDirs = await fs.readdir(specsPath, { withFileTypes: true });
          const configDir = path.basename(path.dirname(specsPath)); // .antigravity or .kiro

          for (const dir of specDirs) {
            if (!dir.isDirectory()) continue;
            // Avoid duplicates if both exist
            if (tasks.some(t => t.name === dir.name)) continue;

            const tasksFilePath = path.join(specsPath, dir.name, 'tasks.md');
            try {
              const content = await fs.readFile(tasksFilePath, 'utf-8');
              tasks.push({ name: dir.name, path: `${configDir}/specs/${dir.name}/tasks.md`, content });
            } catch (e) {
              // Task file doesn't exist, skip
            }
          }
        } catch (e) {
          // Specs dir doesn't exist, skip
        }
      }

      tasks.sort((a, b) => a.name.localeCompare(b.name));
      console.log(`[Tasks] Found ${tasks.length} task files`);
      res.json({ tasks, workspaceRoot });
    } catch (err) {
      console.error('[Tasks] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /open-spec/:id - Open spec in Kiro
  router.post('/open-spec/:id', async (req, res) => {
    const cascade = cascades.get(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

    const { specName } = req.body;
    if (!specName || typeof specName !== 'string') {
      return res.status(400).json({ error: 'specName is required and must be a string' });
    }

    // Sanitize spec name (alphanumeric, hyphens, underscores only)
    const sanitizedSpecName = specName.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
    if (!sanitizedSpecName) {
      return res.status(400).json({ error: 'Invalid spec name' });
    }

    const cdp = cascade.cdp;
    if (!cdp?.rootContextId) return res.status(503).json({ error: 'CDP not connected' });

    console.log(`[OpenSpec] Opening ${sanitizedSpecName}`);

    // Try to click on spec in sidebar
    const script = `(function() {
      let targetDoc = document;
      const activeFrame = document.getElementById('active-frame');
      if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
      
      const specName = '${sanitizedSpecName}';
      const allElements = targetDoc.querySelectorAll('*');
      
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        if (text === specName || text.includes(specName)) {
          if (el.offsetParent !== null && el.textContent.length < 100) {
            el.click();
            return { success: true, method: 'click-spec-name' };
          }
        }
      }
      return { success: false, error: 'Spec not found in UI' };
    })()`;

    try {
      const result = await cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: cdp.rootContextId,
        returnByValue: true
      });
      res.json(result.result?.value || { success: false });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

/**
 * Get workspace root from VS Code window title
 * Uses environment-based paths instead of hardcoded values
 * @param {object} mainWindowCDP - Main window CDP connection
 * @returns {Promise<string|null>}
 */
async function getWorkspaceRoot(mainWindowCDP) {
  if (!mainWindowCDP.connection?.rootContextId) return null;

  try {
    const result = await mainWindowCDP.connection.call('Runtime.evaluate', {
      expression: 'document.title',
      contextId: mainWindowCDP.connection.rootContextId,
      returnByValue: true
    });

    const title = result.result?.value || '';
    const parts = title.split(' - ');
    if (parts.length >= 2) {
      const folderName = parts[parts.length - 2].trim();
      const homeDir = os.homedir();

      // Build possible roots from environment, not hardcoded paths
      const possibleRoots = [
        process.cwd(),
        path.join(homeDir, folderName),
        path.join(homeDir, 'projects', folderName),
        path.join(homeDir, 'dev', folderName),
        path.join(homeDir, 'workspace', folderName),
        path.join(homeDir, 'code', folderName)
      ];

      // Add Windows-specific paths if on Windows
      if (process.platform === 'win32') {
        const drives = ['C:', 'D:', 'E:'];
        for (const drive of drives) {
          possibleRoots.push(
            path.join(drive, 'dev', folderName),
            path.join(drive, 'projects', folderName),
            path.join(drive, 'workspace', folderName)
          );
        }
      }

      for (const root of possibleRoots) {
        try {
          const stat = await fs.stat(root);
          if (stat.isDirectory()) {
            const hasKiro = await fs.access(path.join(root, '.kiro')).then(() => true).catch(() => false);
            const hasAntigravity = await fs.access(path.join(root, '.antigravity')).then(() => true).catch(() => false);
            const hasPackage = await fs.access(path.join(root, 'package.json')).then(() => true).catch(() => false);
            const hasGit = await fs.access(path.join(root, '.git')).then(() => true).catch(() => false);
            if (hasKiro || hasAntigravity || hasPackage || hasGit) return root;
          }
        } catch (e) {
          // Path doesn't exist, continue
        }
      }
    }
  } catch (e) {
    console.error('[getWorkspaceRoot] Error:', e.message);
  }
  return null;
}

/**
 * Find file recursively within a directory
 * @param {string} dir - Directory to search
 * @param {string} fileName - File name to find
 * @param {number} maxDepth - Maximum search depth
 * @param {number} currentDepth - Current depth (internal)
 * @returns {Promise<string|null>}
 */
async function findFileRecursive(dir, fileName, maxDepth = MAX_FILE_SEARCH_DEPTH, currentDepth = 0) {
  if (currentDepth > maxDepth) return null;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    // Check files first
    for (const entry of entries) {
      if (entry.isFile() && entry.name === fileName) {
        return path.join(dir, entry.name);
      }
    }

    // Then recurse into directories
    for (const entry of entries) {
      if (entry.isDirectory() &&
        (!entry.name.startsWith('.') || entry.name === '.kiro' || entry.name === '.antigravity') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist' &&
        entry.name !== 'build' &&
        entry.name !== '.git') {
        const found = await findFileRecursive(
          path.join(dir, entry.name),
          fileName,
          maxDepth,
          currentDepth + 1
        );
        if (found) return found;
      }
    }
  } catch (e) {
    // Directory not accessible, skip
  }
  return null;
}

/**
 * Find file with matching parent directory name
 * Useful when path is like "services/snapshot.js" and we need to find the right one
 * @param {string} dir - Directory to search
 * @param {string} parentDirName - Expected parent directory name
 * @param {string} fileName - File name to find
 * @param {number} maxDepth - Maximum search depth
 * @param {number} currentDepth - Current depth (internal)
 * @returns {Promise<string|null>}
 */
async function findFileWithParent(dir, parentDirName, fileName, maxDepth = MAX_FILE_SEARCH_DEPTH, currentDepth = 0) {
  if (currentDepth > maxDepth) return null;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    // Check if current directory matches parent name and contains the file
    const currentDirName = path.basename(dir);
    if (currentDirName === parentDirName) {
      for (const entry of entries) {
        if (entry.isFile() && entry.name === fileName) {
          return path.join(dir, entry.name);
        }
      }
    }

    // Recurse into directories
    for (const entry of entries) {
      if (entry.isDirectory() &&
        (!entry.name.startsWith('.') || entry.name === '.kiro' || entry.name === '.antigravity') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist' &&
        entry.name !== 'build' &&
        entry.name !== '.git') {
        const found = await findFileWithParent(
          path.join(dir, entry.name),
          parentDirName,
          fileName,
          maxDepth,
          currentDepth + 1
        );
        if (found) return found;
      }
    }
  } catch (e) {
    // Directory not accessible, skip
  }
  return null;
}

/**
 * Collect workspace files for file tree
 * @param {string} workspaceRoot - Workspace root directory
 * @returns {Promise<Array<{name: string, path: string, language: string}>>}
 */
async function collectWorkspaceFiles(workspaceRoot) {
  const files = [];

  async function collect(dir, relativePath = '', depth = 0) {
    if (depth > MAX_WORKSPACE_DEPTH) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files (except .kiro, .antigravity and .github), node_modules, and build directories
        if ((entry.name.startsWith('.') && entry.name !== '.kiro' && entry.name !== '.antigravity' && entry.name !== '.github') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '__pycache__') {
          continue;
        }

        const entryPath = path.join(dir, entry.name);
        const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isFile()) {
          if (isCodeFile(entry.name)) {
            files.push({
              name: entry.name,
              path: entryRelative,
              language: getLanguageFromExtension(entry.name)
            });
          }
        } else if (entry.isDirectory()) {
          await collect(entryPath, entryRelative, depth + 1);
        }
      }
    } catch (e) {
      // Directory not accessible, skip
    }
  }

  await collect(workspaceRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
