/**
 * Patreon OAuth sign-in flow — popup + polling fallback for Electron / external browser.
 *
 * Returns a Promise that resolves with the session key on success.
 */

import { N8N_ENDPOINTS, PATREON_URL, devUrl } from './n8n.js';

export async function startPatreonSignIn({ devMode = false } = {}) {
  const N8N_ORIGIN = new URL(devUrl(N8N_ENDPOINTS.authLogin, devMode)).origin;
  const POLL_URL   = N8N_ORIGIN + devUrl('/webhook/oauth/patreon/poll', devMode);
  const POLL_MS    = 2500;
  const TIMEOUT_MS = 5 * 60 * 1000;

  console.log('[NPC Builder] starting Patreon sign-in, poll URL:', POLL_URL);

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const authUrl = devUrl(N8N_ENDPOINTS.authLogin, devMode)
    + '?origin=' + encodeURIComponent(window.location.origin)
    + '&nonce='  + encodeURIComponent(nonce);

  const w = 520, h = 720;
  const Y = (window.top?.outerHeight || window.outerHeight);
  const X = (window.top?.outerWidth  || window.outerWidth);
  const y = (Y / 2) + (window.top?.screenY || window.screenY) - (h / 2);
  const x = (X / 2) + (window.top?.screenX || window.screenX) - (w / 2);

  const win = window.open(
    authUrl,
    'patreon-login',
    `toolbar=0,location=1,status=0,menubar=0,scrollbars=1,resizable=1,width=${w},height=${h},left=${x},top=${y}`
  );

  return new Promise((resolve, reject) => {
    let resolved = false;

    const succeed = (key) => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollTimer);
      window.removeEventListener('message', msgHandler);
      try { win?.close?.(); } catch {}
      resolve(String(key));
    };

    const fail = (errMsg) => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollTimer);
      window.removeEventListener('message', msgHandler);
      reject(new Error(errMsg || 'Patreon membership required to use this module.'));
    };

    // Method A: postMessage
    const msgHandler = (ev) => {
      const okOrigins = new Set([N8N_ORIGIN, window.location.origin, 'null', '*']);
      if (!okOrigins.has(ev.origin) && ev.origin !== '') return;
      let data = ev.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || data.type !== 'patreon-auth') return;
      if (data.ok && data.key && String(data.key).length >= 32) succeed(data.key);
      else fail(data?.error);
    };
    window.addEventListener('message', msgHandler);

    // Method B: polling
    let consecutiveErrors = 0;
    const MAX_ERRORS = 10;
    const deadline = Date.now() + TIMEOUT_MS;

    const pollTimer = setInterval(async () => {
      if (resolved) { clearInterval(pollTimer); return; }
      if (Date.now() > deadline) {
        clearInterval(pollTimer);
        if (!resolved) fail('Sign-in timed out. Please try again.');
        return;
      }
      try {
        const resp = await fetch(POLL_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ nonce }),
        });
        if (resp.status === 500) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_ERRORS) {
            clearInterval(pollTimer);
            fail('Sign-in server error — please contact support.');
          }
          return;
        }
        consecutiveErrors = 0;
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.ok && data.key && String(data.key).length >= 32) {
          succeed(data.key);
        } else if (data.error && data.error !== 'not_found') {
          fail(data.error);
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          clearInterval(pollTimer);
          fail('Sign-in server error — CORS or network issue.');
        }
      }
    }, POLL_MS);
  });
}

export { PATREON_URL };
