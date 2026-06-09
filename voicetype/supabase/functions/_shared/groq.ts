// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// Server-side Groq key selection.
//
// Normal Pro users use GROQ_API_KEY. Developer/admin users can be routed to
// their own server-side key with GROQ_DEVELOPER_KEYS_JSON:
//   {"user_uuid":"gsk_xxx","dev@example.com":"gsk_yyy"}

import type { AuthedUser } from './auth.ts';
import type { Entitlements } from './entitlements.ts';

const DEFAULT_GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const DEVELOPER_KEYS_RAW = Deno.env.get('GROQ_DEVELOPER_KEYS_JSON') ?? '{}';

if (!DEFAULT_GROQ_API_KEY) console.warn('[groq] GROQ_API_KEY is not set');

let parsedDeveloperKeys: Record<string, string> | null = null;

function developerKeyMap(): Record<string, string> {
  if (parsedDeveloperKeys) return parsedDeveloperKeys;

  try {
    const parsed = JSON.parse(DEVELOPER_KEYS_RAW);
    parsedDeveloperKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(
        Object.entries(parsed)
          .filter((entry): entry is [string, string] =>
            typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].trim().length > 0
          )
          .map(([key, value]) => [key.toLowerCase(), value.trim()])
      )
      : {};
  } catch (err) {
    console.warn('[groq] GROQ_DEVELOPER_KEYS_JSON is invalid JSON; using default key only', err);
    parsedDeveloperKeys = {};
  }

  return parsedDeveloperKeys;
}

export function resolveGroqApiKey(
  user: AuthedUser,
  entitlements: Entitlements,
  scope: 'transcribe' | 'cleanup',
): string {
  const isInternal = entitlements.status === 'developer' || entitlements.status === 'admin';
  if (!isInternal) return DEFAULT_GROQ_API_KEY;

  const keys = developerKeyMap();
  const userIdKey = keys[user.id.toLowerCase()];
  const emailKey = user.email ? keys[user.email.toLowerCase()] : undefined;
  const developerKey = userIdKey ?? emailKey;

  if (developerKey) {
    console.info(`[${scope}] using developer Groq key`, user.id);
    return developerKey;
  }

  console.warn(`[${scope}] developer key missing for ${user.id}; falling back to default Groq key`);
  return DEFAULT_GROQ_API_KEY;
}
