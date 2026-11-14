// Favorites + print list persistence (IndexedDB kv store).
// Favorites/print marks are keyed by record id (relative path) and survive
// app restarts; the views filter the currently scanned folder against them.

const FAV_KEY = 'favorites';
const PRINT_KEY = 'printList';
const PRINT_DIR_KEY = 'printDir';

import { tx } from './cache';
import type { PrintDirRef } from './desktop';

async function kvGet<T>(key: string): Promise<T | null> {
  return (await tx<T>('kv', 'readonly', (s) => s.get(key))) ?? null;
}

async function kvPut<T>(key: string, value: T): Promise<void> {
  await tx('kv', 'readwrite', (s) => s.put(value, key));
}

export async function loadIdSet(key: string): Promise<Set<string>> {
  const arr = await kvGet<string[]>(key);
  return new Set(Array.isArray(arr) ? arr : []);
}

export async function saveIdSet(key: string, set: Set<string>): Promise<void> {
  await kvPut(key, [...set]);
}

export const FAV_STORE = {
  load: () => loadIdSet(FAV_KEY),
  save: (s: Set<string>) => saveIdSet(FAV_KEY, s),
};

export const PRINT_STORE = {
  load: () => loadIdSet(PRINT_KEY),
  save: (s: Set<string>) => saveIdSet(PRINT_KEY, s),
};

export const PRINT_DIR_STORE = {
  load: () => kvGet<PrintDirRef>(PRINT_DIR_KEY),
  save: (v: PrintDirRef) => kvPut(PRINT_DIR_KEY, v),
};
