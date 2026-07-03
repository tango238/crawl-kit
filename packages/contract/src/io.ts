// packages/contract/src/io.ts
//
// Atomic read/write for the two files the reconciler owns. Two guarantees:
//   1. A write is validated FIRST — a registry that fails referential integrity
//      never reaches disk (validate.ts is the gate, this is the door).
//   2. A write is atomic — temp file + rename — so a crash mid-write can never
//      leave a half-written registry that every tool then trusts.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Registry, Unified } from "./model.js";
import { validateRegistry, validateUnified } from "./validate.js";

/** A fresh, valid, empty registry. The starting spine before any concept exists. */
export function emptyRegistry(): Registry {
  return { version: 1, concepts: {}, adrs: {}, relations: [] };
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read "${path}": ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`"${path}" is not valid JSON: ${(error as Error).message}`);
  }
}

async function writeAtomic(path: string, data: unknown): Promise<void> {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  // Unique temp name so concurrent writers never clobber each other's tmp file.
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await writeFile(tmp, json, "utf8");
    await rename(tmp, path);
  } catch (error) {
    throw new Error(`cannot write "${path}": ${(error as Error).message}`);
  }
}

/** Read + validate the durable registry. Throws on dangling refs or bad shape. */
export async function readRegistry(path: string): Promise<Registry> {
  return validateRegistry((await readJson(path)) as Registry);
}

/** Validate THEN atomically write the durable registry. Invalid → never written. */
export async function writeRegistry(path: string, registry: Registry): Promise<void> {
  validateRegistry(registry);
  await writeAtomic(path, registry);
}

/** Read the registry if it exists, otherwise start from an empty one. */
export async function readRegistryOrEmpty(path: string): Promise<Registry> {
  try {
    await readFile(path, "utf8");
  } catch {
    return emptyRegistry();
  }
  return readRegistry(path);
}

/** Read + validate the derived unified view. */
export async function readUnified(path: string): Promise<Unified> {
  return validateUnified((await readJson(path)) as Unified);
}

/** Validate THEN atomically write the derived unified view. */
export async function writeUnified(path: string, unified: Unified): Promise<void> {
  validateUnified(unified);
  await writeAtomic(path, unified);
}

/** Read + parse a JSON file. Throws with a path-carrying message on failure. */
export async function readJsonFile<T>(path: string): Promise<T> {
  return (await readJson(path)) as T;
}

/** Read + parse a JSON file, or return `fallback` when it can't be read/parsed. */
export async function readJsonFileOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return (await readJson(path)) as T;
  } catch {
    return fallback;
  }
}

/** Atomically write pretty-printed JSON (temp file + rename). */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeAtomic(path, data);
}
