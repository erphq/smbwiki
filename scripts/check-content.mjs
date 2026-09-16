#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  specializeSkill,
  skillPracticeProfileErrors,
  specializedSkillIds,
} from "./lib/skill-practice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const REQUIRED_BUSINESS_COUNT = 125;
const REQUIRED_MATURITY = ["run badly", "run well", "run excellently"];
// Must stay in step with DEPARTMENTS in scripts/build-site.mjs.
const DEPARTMENTS = [
  "sales", "operations", "supply", "finance",
  "people", "quality", "compliance", "maintenance",
];
const DECORATIVE_CONTRAST = /\bnot (?:just|only)\b|\brather than\b/i;
const DASHES = /[–—]/;

function loadDefinitions(folder) {
  return readdirSync(join(ROOT, "definitions", folder))
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const value = yaml.load(
        readFileSync(join(ROOT, "definitions", folder, file),
        "utf8"),
      );
      return {
        file,
        value: folder === "skills" ? specializeSkill(value) : value,
      };
    });
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) failures.push(`${label} is missing`);
}

function requireList(value, label) {
  if (!Array.isArray(value) || value.length === 0) failures.push(`${label} is missing or empty`);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) failures.push(`${label} is missing`);
}

function proseGate(value, label) {
  if (DASHES.test(value)) failures.push(`${label} contains an em or en dash`);
  if (DECORATIVE_CONTRAST.test(value)) failures.push(`${label} contains rhetorical contrast`);
}

const businesses = loadDefinitions("businesses").filter(({ value }) => !value.abstract);
if (businesses.length !== REQUIRED_BUSINESS_COUNT)
  failures.push(`concrete business count is ${businesses.length}; expected ${REQUIRED_BUSINESS_COUNT}`);

const summaries = new Map();
for (const { file, value: business } of businesses) {
  const label = `businesses/${file}`;
  requireText(business.summary, `${label} summary`);
  if (typeof business.summary !== "string") continue;

  const summary = business.summary.trim();
  const paragraphs = summary.split(/\n+/).filter(Boolean);
  const wordCount = summary.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length ?? 0;
  if (paragraphs.length !== 2)
    failures.push(`${label} summary has ${paragraphs.length} paragraphs; expected 2`);
  if (wordCount < 55)
    failures.push(`${label} summary has ${wordCount} words; expected at least 55`);
  proseGate(summary, `${label} summary`);

  const normalized = summary.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  if (summaries.has(normalized))
    failures.push(`${label} duplicates the summary in ${summaries.get(normalized)}`);
  else
    summaries.set(normalized, label);
}

const skills = loadDefinitions("skills");
const skillText = new Map();
const skillBodies = new Map();
const skillIds = new Set(skills.map(({ value }) => value.id));
for (const failure of skillPracticeProfileErrors())
  failures.push(`skill-practice-profiles.yaml ${failure}`);
for (const id of specializedSkillIds)
  if (!skillIds.has(id))
    failures.push(`skill-practice-profiles.yaml references missing skill "${id}"`);
for (const { file, value: skill } of skills) {
  const label = `skills/${file}`;
  if (skill.kind !== "skill") failures.push(`${label} kind is not "skill"`);
  if (!DEPARTMENTS.includes(skill.department))
    failures.push(
      `${label} department is ${JSON.stringify(skill.department ?? null)}; ` +
      `expected one of ${DEPARTMENTS.join(", ")}`,
    );
  requireText(skill.summary, `${label} summary`);
  requireArray(skill.inputs, `${label} inputs`);
  requireArray(skill.outputs, `${label} outputs`);
  requireList(skill.steps, `${label} steps`);
  requireText(skill.tension, `${label} tension`);
  requireList(skill.failure_modes, `${label} failure_modes`);
  requireList(skill.maturity, `${label} maturity`);
  requireList(skill.competencies, `${label} competencies`);
  requireText(skill.automation?.now, `${label} automation.now`);
  requireText(skill.automation?.human, `${label} automation.human`);
  requireList(skill.questions, `${label} questions`);

  if (Array.isArray(skill.steps)) {
    if (skill.steps.length < 3 || skill.steps.length > 6)
      failures.push(`${label} has ${skill.steps.length} steps; expected 3 to 6`);
    for (const [index, step] of skill.steps.entries()) {
      requireText(step?.name, `${label} step ${index + 1} name`);
      requireText(step?.note, `${label} step ${index + 1} note`);
    }
  }

  if (Array.isArray(skill.failure_modes)) {
    for (const [index, mode] of skill.failure_modes.entries()) {
      requireText(mode?.name, `${label} failure mode ${index + 1} name`);
      requireText(mode?.cost, `${label} failure mode ${index + 1} cost`);
      requireText(mode?.signal, `${label} failure mode ${index + 1} signal`);
    }
  }

  const maturity = Array.isArray(skill.maturity)
    ? skill.maturity.map((entry) => entry?.level)
    : [];
  if (JSON.stringify(maturity) !== JSON.stringify(REQUIRED_MATURITY))
    failures.push(`${label} maturity levels must be ${REQUIRED_MATURITY.join(", ")}`);

  if (Array.isArray(skill.competencies)) {
    for (const [index, competency] of skill.competencies.entries()) {
      requireText(competency?.name, `${label} competency ${index + 1} name`);
      requireText(competency?.note, `${label} competency ${index + 1} note`);
    }
  }

  proseGate(JSON.stringify(skill), label);

  const proseFields = [
    ["summary", skill.summary],
    ...(skill.steps ?? []).map((entry, index) => [`step ${index + 1} note`, entry?.note]),
    ["tension", skill.tension],
    ...(skill.failure_modes ?? []).flatMap((entry, index) => [
      [`failure mode ${index + 1} cost`, entry?.cost],
      [`failure mode ${index + 1} signal`, entry?.signal],
    ]),
    ...(skill.maturity ?? []).map((entry, index) => [`maturity ${index + 1}`, entry?.looks_like]),
    ...(skill.competencies ?? []).map((entry, index) => [`competency ${index + 1}`, entry?.note]),
    ["automation.now", skill.automation?.now],
    ["automation.human", skill.automation?.human],
    ...(skill.questions ?? []).map((entry, index) => [`question ${index + 1}`, entry]),
  ];
  for (const [field, value] of proseFields) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
    if (skillText.has(normalized))
      failures.push(`${label} ${field} duplicates ${skillText.get(normalized)}`);
    else
      skillText.set(normalized, `${label} ${field}`);
  }

  const normalizedBody = JSON.stringify({
    steps: skill.steps,
    tension: skill.tension,
    failure_modes: skill.failure_modes,
    maturity: skill.maturity,
    competencies: skill.competencies,
    automation: skill.automation,
    questions: skill.questions,
  })
    .toLocaleLowerCase("en-US")
    .replaceAll(skill.name.toLocaleLowerCase("en-US"), "<skill>")
    .replaceAll(skill.id.toLocaleLowerCase("en-US"), "<skill>")
    .replace(/\s+/g, " ")
    .trim();
  if (skillBodies.has(normalizedBody))
    failures.push(`${label} is a normalized template duplicate of ${skillBodies.get(normalizedBody)}`);
  else
    skillBodies.set(normalizedBody, label);

  if (
    JSON.stringify(skill).includes(
      "covered, loaded, energized, occupied, or handed over",
    )
  )
    failures.push(`${label} contains the obsolete generic acceptance question`);
}

// Skill pages are articles too: what the process is, why it matters, how it
// runs in prose ahead of the step list, and the controls that keep it honest.
const SKILL_PROSE_FLOORS = { what: 60, why: 50, how: 60 };
const skillWhat = new Map();
const wordsIn = (value) => String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
function walkProse(value, label) {
  if (typeof value === "string") proseGate(value, label);
  else if (Array.isArray(value)) value.forEach((item, index) => walkProse(item, `${label}[${index}]`));
  else if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) walkProse(inner, `${label}.${key}`);
}
function checkNamedNotes(list, label, min, max, noteFloor = 12) {
  requireList(list, label);
  if (!Array.isArray(list)) return;
  if (list.length < min || list.length > max)
    failures.push(`${label} has ${list.length} items; expected ${min} to ${max}`);
  for (const [index, item] of list.entries()) {
    requireText(item?.name, `${label} ${index + 1} name`);
    requireText(item?.note, `${label} ${index + 1} note`);
    if (wordsIn(item?.note) < noteFloor)
      failures.push(`${label} ${index + 1} note has ${wordsIn(item?.note)} words; expected at least ${noteFloor}`);
  }
}
function checkBenchmarkRows(rows, label) {
  for (const [index, row] of rows.entries()) {
    const rowLabel = `${label} ${index + 1}`;
    requireText(row?.scope, `${rowLabel} scope`);
    requireText(row?.value, `${rowLabel} value`);
    requireText(row?.source_name, `${rowLabel} source_name`);
    if (typeof row?.source !== "string" || !/^https?:\/\/\S+$/.test(row.source))
      failures.push(`${rowLabel} source is not an absolute URL`);
  }
}
for (const { file, value: skill } of skills) {
  const label = `skills/${file}`;
  const article = skill.article;
  if (!article || typeof article !== "object") {
    failures.push(`${label} article is missing`);
    continue;
  }
  walkProse(article, `${label} article`);
  for (const [field, floor] of Object.entries(SKILL_PROSE_FLOORS)) {
    requireText(article[field], `${label} article.${field}`);
    if (wordsIn(article[field]) < floor)
      failures.push(`${label} article.${field} has ${wordsIn(article[field])} words; expected at least ${floor}`);
  }
  checkNamedNotes(article.controls, `${label} article.controls`, 3, 5);
  const normalized = String(article.what ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalized) {
    if (skillWhat.has(normalized)) failures.push(`${label} article.what duplicates ${skillWhat.get(normalized)}`);
    skillWhat.set(normalized, label);
  }
}

// Business pages carry three prose sections that match how people search:
// how the business works, how to start one, and the economics. Benchmarks
// are optional but every row needs a real source.
const BUSINESS_PROSE_FLOORS = { operating_model: 60, starting: 80, economics: 80 };
const businessProse = new Map();
for (const { file, value: business } of businesses) {
  const label = `businesses/${file}`;
  const article = business.article;
  if (!article || typeof article !== "object") {
    failures.push(`${label} article is missing`);
    continue;
  }
  walkProse(article, `${label} article`);
  for (const [field, floor] of Object.entries(BUSINESS_PROSE_FLOORS)) {
    requireText(article[field], `${label} article.${field}`);
    if (wordsIn(article[field]) < floor)
      failures.push(`${label} article.${field} has ${wordsIn(article[field])} words; expected at least ${floor}`);
    const normalized = String(article[field] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (normalized) {
      if (businessProse.has(normalized)) failures.push(`${label} article.${field} duplicates ${businessProse.get(normalized)}`);
      businessProse.set(normalized, `${label} article.${field}`);
    }
  }
  if (article.benchmarks !== undefined) {
    requireArray(article.benchmarks, `${label} article.benchmarks`);
    if (Array.isArray(article.benchmarks)) checkBenchmarkRows(article.benchmarks, `${label} article.benchmarks`);
  }
}

// Metric pages are articles: the number, how to compute it, published ranges
// with a source each, what moves it, and how it is misread. Every metric must
// carry the whole contract so the corpus cannot regress to unit-and-direction
// stubs. Word floors are on prose fields; list bounds keep the pages honest
// rather than padded.
const metrics = loadDefinitions("metrics");
const METRIC_DIRECTIONS = ["higher", "lower", "contextual"];
const METRIC_PROSE_FLOORS = { what: 60, how_to_calculate: 50, example: 40 };
const METRIC_LIST_BOUNDS = { drivers: [3, 6], improve: [3, 6], pitfalls: [2, 4] };
const wordCount = (value) => String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
const metricWhat = new Map();
function proseWalk(value, label) {
  if (typeof value === "string") proseGate(value, label);
  else if (Array.isArray(value)) value.forEach((item, index) => proseWalk(item, `${label}[${index}]`));
  else if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) proseWalk(inner, `${label}.${key}`);
}
for (const { file, value: metric } of metrics) {
  const label = `metrics/${file}`;
  if (metric.kind !== "metric") failures.push(`${label} kind is not "metric"`);
  requireText(metric.summary, `${label} summary`);
  requireText(metric.unit, `${label} unit`);
  if (!METRIC_DIRECTIONS.includes(metric.direction))
    failures.push(`${label} direction is ${JSON.stringify(metric.direction ?? null)}; expected one of ${METRIC_DIRECTIONS.join(", ")}`);
  const article = metric.article;
  if (!article || typeof article !== "object") {
    failures.push(`${label} article is missing`);
    continue;
  }
  proseWalk(article, `${label} article`);
  for (const [field, floor] of Object.entries(METRIC_PROSE_FLOORS)) {
    requireText(article[field], `${label} article.${field}`);
    if (wordCount(article[field]) < floor)
      failures.push(`${label} article.${field} has ${wordCount(article[field])} words; expected at least ${floor}`);
  }
  requireText(article.formula, `${label} article.formula`);
  for (const [field, [min, max]] of Object.entries(METRIC_LIST_BOUNDS)) {
    requireList(article[field], `${label} article.${field}`);
    if (!Array.isArray(article[field])) continue;
    if (article[field].length < min || article[field].length > max)
      failures.push(`${label} article.${field} has ${article[field].length} items; expected ${min} to ${max}`);
    for (const [index, item] of article[field].entries()) {
      requireText(item?.name, `${label} article.${field} ${index + 1} name`);
      requireText(item?.note, `${label} article.${field} ${index + 1} note`);
      if (wordCount(item?.note) < 12)
        failures.push(`${label} article.${field} ${index + 1} note has ${wordCount(item?.note)} words; expected at least 12`);
    }
  }
  requireArray(article.benchmarks, `${label} article.benchmarks`);
  if (Array.isArray(article.benchmarks)) {
    if (!article.benchmarks.length) requireText(article.benchmark_note, `${label} article.benchmark_note (required when benchmarks is empty)`);
    for (const [index, row] of article.benchmarks.entries()) {
      const rowLabel = `${label} article.benchmarks ${index + 1}`;
      requireText(row?.scope, `${rowLabel} scope`);
      requireText(row?.value, `${rowLabel} value`);
      requireText(row?.source_name, `${rowLabel} source_name`);
      if (typeof row?.source !== "string" || !/^https?:\/\/\S+$/.test(row.source))
        failures.push(`${rowLabel} source is not an absolute URL`);
    }
  }
  const normalizedWhat = String(article.what ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalizedWhat) {
    if (metricWhat.has(normalizedWhat)) failures.push(`${label} article.what duplicates ${metricWhat.get(normalizedWhat)}`);
    metricWhat.set(normalizedWhat, label);
  }
}

console.log(
  `content businesses=${businesses.length} skills=${skills.length} metrics=${metrics.length} ` +
  `specialized=${specializedSkillIds.size} failures=${failures.length}`,
);
for (const failure of failures) console.log(`ERROR: ${failure}`);
process.exit(failures.length ? 1 : 0);
