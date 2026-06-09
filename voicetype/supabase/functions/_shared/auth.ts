// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// Verifies the Supabase access token on the incoming request and
// returns the authenticated user. Every Echo billing/proxy function
// uses this — never trust a `user_id` claim from the request body.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export interface AuthedUser {
  id: string;
  email: string | null;
}

export interface AuthedContext {
  user: AuthedUser;
  client: SupabaseClient;
  // Service-role client. ONLY use after `requireUser()` has confirmed
  // the caller, and ONLY scope writes to `user.id` to avoid letting one
  // signed-in user mutate another user's data.
  admin: SupabaseClient;
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (!supabaseUrl) console.warn('[auth] SUPABASE_URL is not set');
if (!supabaseAnonKey) console.warn('[auth] SUPABASE_ANON_KEY is not set');
if (!supabaseServiceKey) console.warn('[auth] SUPABASE_SERVICE_ROLE_KEY is not set');

export async function requireUser(req: Request): Promise<AuthedContext> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (!token) {
    throw new HttpError(401, 'missing_token', 'Missing Authorization bearer token.');
  }

  const anon = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, 'invalid_token', error?.message ?? 'Invalid token.');
  }

  const admin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    user: { id: data.user.id, email: data.user.email ?? null },
    client: anon,
    admin,
  };
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function adminClient(): SupabaseClient {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
