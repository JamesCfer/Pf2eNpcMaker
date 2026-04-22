/**
 * Feedback panel — sends a short message + context to the n8n feedback endpoint.
 */

import { N8N_ENDPOINTS, devUrl } from './n8n.js';

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
