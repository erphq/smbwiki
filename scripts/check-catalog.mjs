#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = 125;
const failures = [];
const key = (name) => name.toLocaleLowerCase("en-US");

const roadmap = readFileSync(join(ROOT, "CATALOG.md"), "utf8");
const rows = [...roadmap.matchAll(/^\| ([^|]+?) \| (\d{6}) \| (live|planned) \|$/gm)]
  .map(([, name, naics, state]) => ({ name, naics, state }));

if (rows.length !== TARGET)
  failures.push(`catalog roadmap has ${rows.length} business rows; expected ${TARGET}`);

const names = new Set();
for (const row of rows) {
  if (names.has(key(row.name))) failures.push(`duplicate roadmap business name "${row.name}"`);
  names.add(key(row.name));
}

const businesses = readdirSync(join(ROOT, "definitions", "businesses"))
  .filter((file) => file.endsWith(".yaml"))
  .map((file) => yaml.load(readFileSync(join(ROOT, "definitions", "businesses", file), "utf8")))
  .filter((business) => !business.abstract);

const liveRows = rows.filter((row) => row.state === "live");
if (liveRows.length !== businesses.length)
  failures.push(`roadmap marks ${liveRows.length} live; definitions contain ${businesses.length}`);

for (const business of businesses) {
  const row = liveRows.find((candidate) => key(candidate.name) === key(business.name));
  if (!row) {
    failures.push(`live business "${business.name}" is absent from the roadmap`);
    continue;
  }
  if (row.naics !== String(business.codes?.naics ?? ""))
    failures.push(`${business.name}: roadmap NAICS ${row.naics} differs from definition ${business.codes?.naics ?? "missing"}`);
}

for (const row of liveRows)
  if (!businesses.some((business) => key(business.name) === key(row.name)))
    failures.push(`roadmap marks "${row.name}" live without a business definition`);

console.log(`catalog target=${rows.length} live=${liveRows.length} definitions=${businesses.length} failures=${failures.length}`);
for (const failure of failures) console.log(`ERROR: ${failure}`);
process.exit(failures.length ? 1 : 0);
