// Netlify Function: every /api/* request lands here. Data lives in Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { handle } from '../../lib/core.mjs';

// Adapts a Netlify Blobs store to the small interface lib/core.mjs expects.
function wrap(name) {
  const s = getStore({ name, consistency: 'strong' });
  return {
    getJSON: (k) => s.get(k, { type: 'json' }),
    setJSON: (k, v, opts) => s.setJSON(k, v, opts && opts.onlyIfNew ? { onlyIfNew: true } : undefined),
    getBuf: (k) => s.get(k, { type: 'arrayBuffer' }),
    setBuf: (k, buf) => s.set(k, buf),
    del: (k) => s.delete(k),
  };
}

export default async (req) =>
  handle(req, { users: wrap('chatbit-users'), sessions: wrap('chatbit-sessions'), spaces: wrap('chatbit-spaces'), files: wrap('chatbit-files') });

export const config = { path: '/api/*' };
