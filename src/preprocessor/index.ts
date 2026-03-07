import 'dotenv/config';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { watchFirestore } from './firestore.js';
import { runSync } from './sync.js';
import { getToken } from '../auth.js';

export async function startPreprocessor(): Promise<void> {
  // Validate auth early so we fail fast if refresh token is missing
  await getToken();

  const windowDays = parseInt(process.env['PREPROCESS_WINDOW_DAYS'] ?? '30', 10);

  // Tier 1: Firestore-triggered, last N days (60s debounce inside watchFirestore)
  watchFirestore(() => {
    void runSync({ scope: 'recent', trigger: 'firestore', windowDays });
  });

  // Tier 2: Daily full scan at 2am
  cron.schedule('0 2 * * *', () => {
    void runSync({ scope: 'full', trigger: 'daily' });
  });

  // Startup syncs
  await runSync({ scope: 'recent', trigger: 'startup', windowDays });
  await runSync({ scope: 'full', trigger: 'startup' });
}

// Run directly when invoked as a standalone script
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startPreprocessor().catch(err => {
    console.error('[preprocessor] Fatal:', err);
    process.exit(1);
  });
}
