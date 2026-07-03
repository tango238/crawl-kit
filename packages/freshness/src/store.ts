// packages/freshness/src/store.ts
//
// Read/write the acquisition-freshness store at data/acquisition.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DATA_FILES, dataPath } from "@crawl-kit/contract";
import { type AcquisitionStore, DEFAULT_TTL_SECONDS, emptyStore } from "./model.js";

export function acquisitionPath(start?: string): string {
  return dataPath(DATA_FILES.acquisition, start);
}

/** Read the store, or an empty one (with the given TTL default) if absent/corrupt. */
export async function readStore(path: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<AcquisitionStore> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AcquisitionStore>;
    return {
      ttlSeconds: parsed.ttlSeconds ?? ttlSeconds,
      structure: parsed.structure ?? {},
      behavior: parsed.behavior ?? {},
    };
  } catch {
    return emptyStore(ttlSeconds);
  }
}

export async function writeStore(path: string, store: AcquisitionStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
