import 'dotenv/config';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { watchFirestore } from './firestore.js';
import { runSync } from './sync.js';
import { getToken } from '../auth.js';

export async function startPreprocessor(): Promise<void> {
  // Validate auth early so we fail fast if refresh token is missing
  await getToken();

  watchFirestore(() => {
    void runSync({ scope: 'recent', trigger: 'firestore', windowDays: 30 });
  });

  // Tier 2: Daily full scan at 2am
  cron.schedule('0 2 * * *', () => {
    void runSync({ scope: 'full', trigger: 'daily', windowDays: 365 * 10 });
  });

  // Startup syncs
  await runSync({ scope: 'recent', trigger: 'startup', windowDays: 7 });
}
