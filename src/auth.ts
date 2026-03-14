import 'dotenv/config';
import { pool } from './shared/db.js';

async function readStoredRefreshToken(): Promise<string | null> {
  const result = await pool.query<{ refresh_token: string }>(
    'SELECT refresh_token FROM auth_tokens WHERE id = 1'
  );
  return result.rows[0]?.refresh_token ?? null;
}

async function writeStoredRefreshToken(token: string): Promise<void> {
  await pool.query(
    `INSERT INTO auth_tokens (id, refresh_token, updated_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
    [token]
  );
}

interface TokenState {
  idToken: string;
  expiresAt: number;
  refreshToken: string;
}

let tokenState: TokenState | null = null;

export function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

async function doRefresh(currentRefreshToken: string): Promise<TokenState> {
  const apiKey = env('FIREBASE_API_KEY');
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as {
    id_token: string;
    refresh_token: string;
    expires_in: string;
  };
  const state = {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + parseInt(data.expires_in, 10) * 1000,
  };
  await writeStoredRefreshToken(state.refreshToken);
  return state;
}

export async function getToken(): Promise<string> {
  const fiveMinutes = 5 * 60 * 1000;
  if (!tokenState) {
    const storedRefreshToken = (await readStoredRefreshToken()) ?? process.env['FIREBASE_REFRESH_TOKEN'];
    if (!storedRefreshToken) {
      throw new Error(
        'No refresh token found. Set FIREBASE_REFRESH_TOKEN env var or seed the auth_tokens table.'
      );
    }
    tokenState = await doRefresh(storedRefreshToken);
  } else if (Date.now() >= tokenState.expiresAt - fiveMinutes) {
    tokenState = await doRefresh(tokenState.refreshToken);
  }
  return tokenState.idToken;
}

export function getUserId(): string {
  if (!tokenState) throw new Error('getToken() must be called before getUserId()');
  const payload = JSON.parse(
    Buffer.from(tokenState.idToken.split('.')[1], 'base64url').toString()
  );
  return payload.sub as string;
}
