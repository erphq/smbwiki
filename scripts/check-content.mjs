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

console.log(
  `content businesses=${businesses.length} skills=${skills.length} ` +
  `specialized=${specializedSkillIds.size} failures=${failures.length}`,
);
for (const failure of failures) console.log(`ERROR: ${failure}`);
process.exit(failures.length ? 1 : 0);
