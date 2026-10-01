export const STUDY_FAVORITES_KEY = 'tvchart:study-favorites:v1';
type FavoriteStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): FavoriteStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export function loadStudyFavorites(storage = browserStorage()): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STUDY_FAVORITES_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  } catch { return []; }
}

export function saveStudyFavorites(ids: readonly string[], storage = browserStorage()): boolean {
  if (!storage) return false;
  try { storage.setItem(STUDY_FAVORITES_KEY, JSON.stringify([...new Set(ids)])); return true; } catch { return false; }
}
