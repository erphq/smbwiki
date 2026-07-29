import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE_FILE = join(ROOT, "definitions", "skill-practice-profiles.yaml");

export const skillPracticeProfiles =
  yaml.load(readFileSync(PROFILE_FILE, "utf8")) ?? {};

export const specializedSkillIds = new Set(
  Object.keys(skillPracticeProfiles),
);

export function skillPracticeProfileErrors() {
  const failures = [];
  for (const [id, profile] of Object.entries(skillPracticeProfiles)) {
    for (const field of ["basis", "acceptance", "evidence"])
      if (typeof profile?.[field] !== "string" || !profile[field].trim())
        failures.push(`profile "${id}" is missing ${field}`);
    for (const field of ["name", "cost", "signal"])
      if (
        typeof profile?.risk?.[field] !== "string" ||
        !profile.risk[field].trim()
      )
        failures.push(`profile "${id}" is missing risk.${field}`);
  }
  return failures;
}

const sentence = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

const lowerFirst = (value) => {
  const text = String(value ?? "");
  return text ? text[0].toLocaleLowerCase("en-US") + text.slice(1) : "";
};

const specificSummary = (summary) => {
  const text = String(summary ?? "").replace(/\s+/g, " ").trim();
  const generic = text.search(
    /\s+[A-Z][^.]* leaves a current work basis, a field record, and acceptance evidence/i,
  );
  return sentence(generic === -1 ? text : text.slice(0, generic));
};

export function specializeSkill(skill) {
  const profile = skillPracticeProfiles[skill.id];
  if (!profile) return skill;

  const name = skill.name;
  const lowerName = lowerFirst(name);
  const basis = String(profile.basis ?? "").trim();
  const acceptance = String(profile.acceptance ?? "").trim();
  const evidence = String(profile.evidence ?? "").trim();
  const risk = profile.risk ?? {};

  return {
    ...skill,
    steps: [
      {
        name: "Confirm readiness",
        note: sentence(`Confirm ${basis} before ${lowerName} is released`),
      },
      {
        name: `Run ${lowerName}`,
        note: sentence(
          `In practice, ${lowerName} ${lowerFirst(specificSummary(skill.summary))}`,
        ),
      },
      {
        name: "Verify and close",
        note: sentence(
          `Check the result against ${acceptance}. Resolve exceptions and preserve ${evidence}`,
        ),
      },
    ],
    tension: sentence(
      `Schedule pressure can push ${lowerName} ahead of a complete readiness check across ${basis}. ` +
      `${String(risk.cost ?? "").trim()}`,
    ),
    failure_modes: [
      {
        name: String(risk.name ?? "").trim(),
        cost: sentence(risk.cost),
        signal: sentence(risk.signal),
      },
      {
        name: `${name} closes without traceable evidence`,
        cost: sentence(
          `If the result is challenged or fails later, it cannot be reconstructed from ${evidence}`,
        ),
        signal: sentence(
          `One or more items in ${evidence} lack a location, date, responsible person, result, or open exception`,
        ),
      },
    ],
    maturity: [
      {
        level: "run badly",
        looks_like: sentence(
          `Work starts before readiness is established across ${basis}. The team reconstructs ${evidence} afterward`,
        ),
      },
      {
        level: "run well",
        looks_like: sentence(
          `Readiness is confirmed across ${basis}. Acceptance is checked against ${acceptance}, with results preserved in ${evidence}`,
        ),
      },
      {
        level: "run excellently",
        looks_like: sentence(
          `Patterns in ${evidence} improve the next plan, control point, and acceptance decision for ${lowerName}`,
        ),
      },
    ],
    competencies: [
      {
        name: `${name} control`,
        note: sentence(
          `The operator reconciles readiness across ${basis}, then checks execution against ${acceptance}`,
        ),
      },
      {
        name: "Evidence control",
        note: sentence(
          `The evidence set includes ${evidence}. Each entry must identify its location, decision, result, and open exception while they can still be checked`,
        ),
      },
    ],
    automation: {
      now: sentence(
        `Workflow tools can track readiness across ${basis}; assignments and due dates; checks against ${acceptance}; exceptions; and ${evidence}`,
      ),
      human: sentence(
        `Judgment about changed conditions and responsibility for ${acceptance} remain human`,
      ),
    },
    questions: [
      sentence(`Which readiness item remains unresolved across ${basis}?`),
      sentence(
        `What in ${evidence} proves the result meets ${acceptance}?`,
      ),
    ],
  };
}
