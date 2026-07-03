import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

export async function readYamlFile<T>(path: string): Promise<T> {
  return parse(await readFile(path, "utf8")) as T;
}

export async function writeYamlFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(data), "utf8");
}
