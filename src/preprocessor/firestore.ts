import { getToken, getUserId } from '../auth.js';

type Callback = () => void;

export function watchFirestore(onTrigger: Callback): void {
  let lastTimestamp: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function resetDebounce(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onTrigger, 60_000);
  }

  async function poll(): Promise<void> {
    try {
      const uid = getUserId();
      const url =
        `https://firestore.googleapis.com/v1/projects/copilot-production-22904` +
        `/databases/(default)/documents/changes/${uid}/w`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${await getToken()}` },
      });
      if (!res.ok) return;
      const doc = await res.json() as {
        fields?: { timestamp?: { timestampValue?: string } };
      };
      const ts = doc.fields?.timestamp?.timestampValue ?? null;
      if (ts && ts !== lastTimestamp) {
        lastTimestamp = ts;
        resetDebounce();
      }
    } catch (err) {
      console.error('[firestore] poll error:', err);
    }
  }

  setInterval(() => { void poll(); }, 30_000);
  void poll(); // initial poll
}
