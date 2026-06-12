/**
 * Content Bridge — Firefox ISOLATED world bridge
 *
 * Firefox MV3 doesn't support world:"MAIN" content scripts via temporary install,
 * so this bridge injects the MAIN world script dynamically via a <script> tag.
 * Communication is done via window.postMessage() between the two worlds.
 *
 * Runs at document_start.
 */

import { isBlacklisted } from '../utils/blacklist.js';
import { matchSiteRule } from '../utils/site-pattern.js';

const SPEED_MIN = 0.07;
const SPEED_MAX = 16;

let bridgeInitialized = false;

/**
 * Inject a script into the page via <script> tag
 */
function injectScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const url = chrome.runtime.getURL(scriptPath);
    console.log('[VSC] Bridge: injectScript URL:', url);
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
      console.log('[VSC] Bridge: script onload fired');
      script.remove();
      resolve();
    };
    script.onerror = (err) => {
      console.error('[VSC] Bridge: script onerror:', err);
      script.remove();
      reject(new Error(`Failed to load script: ${scriptPath}`));
    };
    (document.head || document.documentElement).appendChild(script);
  });
}

async function init() {
  try {
    console.log('[VSC] Bridge init starting');
    if (location.href === 'about:blank') {
      console.log('[VSC] Bridge: about:blank, skipping');
      return;
    }

    if (bridgeInitialized) {
      console.log('[VSC] Bridge: already initialized, skipping');
      return;
    }
    bridgeInitialized = true;

    console.log('[VSC] Bridge: reading storage');
    const settings = await chrome.storage.sync.get(null);

    const disabled = settings.enabled === false;
    const blacklisted = !settings.siteRules && isBlacklisted(settings.blacklist, location.href);
    const siteRuleMatch = matchSiteRule(settings.siteRules, location.href);
    const siteDisabled = siteRuleMatch && siteRuleMatch.enabled === false;
    const shouldAbort = disabled || blacklisted || siteDisabled;

    if (shouldAbort) {
      console.log('[VSC] Bridge: site disabled/blacklisted, aborting');
      return;
    }

    console.log('[VSC] Bridge: creating settings element');
    // Embed settings in a script element for the MAIN world to read
    const settingsElement = document.createElement('script');
    settingsElement.id = 'vsc-settings-data';
    settingsElement.type = 'application/json';
    const settingsData = { ...settings };
    delete settingsData.blacklist;
    delete settingsData.enabled;
    settingsElement.textContent = JSON.stringify({
      settings: settingsData,
      hostname: location.hostname.replace(/^www\./, ''),
    });
    (document.head || document.documentElement).appendChild(settingsElement);
    console.log('[VSC] Bridge: settings element created, head exists:', !!document.head);

    // Inject the MAIN world script
    console.log('[VSC] Bridge: about to inject inject.js via chrome.runtime.getURL');
    const injectUrl = chrome.runtime.getURL('inject.js');
    console.log('[VSC] Bridge: inject URL:', injectUrl);
    try {
      await injectScript('inject.js');
      console.log('[VSC] Bridge: inject.js loaded successfully');
    } catch (e) {
      console.error('[VSC] Bridge: injectScript error:', e.message);
    }

    // --- postMessage bridge ---

    // Page -> Bridge: storage writes
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.source !== 'vsc-page') {
        return;
      }
      const { action, data } = event.data;

      if (action === 'storage-update') {
        // Only lastSpeed can be written from MAIN world (trust boundary)
        if (data && 'lastSpeed' in data) {
          const speed = data.lastSpeed;
          if (typeof speed === 'number' && Number.isFinite(speed)) {
            const clamped = Math.min(Math.max(speed, SPEED_MIN), SPEED_MAX);
            chrome.storage.sync.set({ lastSpeed: clamped });
          }
        }
      } else if (action === 'runtime-message') {
        chrome.runtime.sendMessage(data);
      }
    });

    // Bridge -> Page: storage changes relay
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'sync') {
        return;
      }

      if (changes.enabled?.newValue === false) {
        window.postMessage({
          source: 'vsc-bridge',
          action: 'lifecycle',
          data: { type: 'VSC_TEARDOWN' },
        }, '*');
        return;
      }
      if (changes.enabled?.oldValue === false && changes.enabled?.newValue !== false) {
        window.postMessage({
          source: 'vsc-bridge',
          action: 'lifecycle',
          data: { type: 'VSC_REINIT' },
        }, '*');
      }

      const relayChanges = { ...changes };
      delete relayChanges.enabled;
      delete relayChanges.blacklist;
      if (Object.keys(relayChanges).length > 0) {
        window.postMessage({
          source: 'vsc-bridge',
          action: 'storage-changed',
          data: relayChanges,
        }, '*');
      }
    });

    // Bridge -> Page: runtime messages relay
    chrome.runtime.onMessage.addListener((request) => {
      window.postMessage({
        source: 'vsc-bridge',
        action: 'runtime-message',
        data: request,
      }, '*');
    });
  } catch (error) {
    console.error('[VSC] Firefox bridge init failed:', error);
  }
}

init();
