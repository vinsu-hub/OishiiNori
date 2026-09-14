import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { formatTimestamp12h } from '@/lib/utils';

const format12h = (d: Date) => formatTimestamp12h(d.toISOString());

const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h -- past this, stock has likely moved enough that a restored draft is more likely wrong than helpful.
const DEBOUNCE_MS = 600;

interface StoredDraft<T> {
  savedAt: number;
  data: T;
}

function isEmptyDraft<T extends Record<string, unknown>>(value: T): boolean {
  return Object.values(value).every((v) => v === '' || v === undefined || v === null);
}

/**
 * Persists an in-progress count-entry draft to localStorage (debounced) so a
 * closed tab or dead device doesn't lose unsaved manual counting -- never
 * touches the network. On mount, offers to restore a recent draft via a
 * dismissible toast; the caller decides how to merge it back into state.
 */
export function useDraftPersistence<T extends Record<string, unknown>>(
  storageKey: string,
  value: T,
  onRestore: (data: T) => void
) {
  const restoredRef = useRef(false);

  // Offer to restore once, on mount (or when the storage key changes, e.g.
  // switching Stock Count station tabs).
  useEffect(() => {
    restoredRef.current = false;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as StoredDraft<T>;
      if (Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(storageKey);
        return;
      }
      if (isEmptyDraft(parsed.data)) return;
      const savedAt = new Date(parsed.savedAt);
      toast('Unsaved count found', {
        description: `Restored entries you were entering at ${format12h(savedAt)}. Numbers may be stale if stock has changed since -- double-check before saving.`,
        action: {
          label: 'Discard',
          onClick: () => {
            try {
              localStorage.removeItem(storageKey);
            } catch {
              // best-effort
            }
          },
        },
      });
      restoredRef.current = true;
      onRestore(parsed.data);
    } catch {
      // Corrupt/unparseable draft -- ignore rather than throw.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Debounced save on every change.
  useEffect(() => {
    if (isEmptyDraft(value)) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // best-effort
      }
      return;
    }
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), data: value } as StoredDraft<T>));
      } catch {
        // best-effort -- e.g. storage full/disabled, not worth surfacing
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, JSON.stringify(value)]);

  function clearDraft() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // best-effort
    }
  }

  return { clearDraft };
}
