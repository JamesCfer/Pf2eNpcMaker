/**
 * Feedback panel — sends a short message + context to the n8n feedback endpoint.
 */

import { N8N_ENDPOINTS, devUrl } from './n8n.js';

/**
 * @param {object}  opts
 * @param {string}  opts.message      The feedback text to send.
 * @param {string}  opts.moduleLabel  Display name of the sending module (e.g. 'Pathfinder 2e').
 * @param {string}  opts.email        User email (may be empty).
 * @param {string}  opts.tier         Patreon tier label (e.g. 'Free', 'Champion').
 * @param {string}  opts.sessionKey   Patreon session key (may be empty).
 * @param {boolean} [opts.devMode=false]
 * @returns {Promise<void>}
 * @throws {Error} If the server returns a non-OK status.
 */
export async function sendFeedback({
  message,
  moduleLabel,
  email,
  tier,
  sessionKey,
  devMode = false,
}) {
  const response = await fetch(devUrl(N8N_ENDPOINTS.feedback, devMode), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      message,
      tab:        moduleLabel,
      email:      email || '',
      tier:       tier || 'unknown',
      sessionKey: sessionKey || '',
    }),
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
}
