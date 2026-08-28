// src/env.js
import { readFileSync } from 'node:fs';

// Reads KEY=VALUE lines from the project .env (gitignored) plus process.env.
export function loadEnv(path = new URL('../.env', import.meta.url).pathname) {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  } catch { /* .env optional when real env vars are set */ }
  if (!env.CS_EVENTS_URL || (!env.CS_EVENTS_AUTH && !env.CS_EVENTS_TOKEN)) {
    throw new Error('CS_EVENTS_URL and CS_EVENTS_AUTH (basic) or CS_EVENTS_TOKEN (bearer) must be set');
  }
  return env;
}
