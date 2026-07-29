#!/usr/bin/env node
// Loads definitions/, validates, resolves inheritance, emits
// build/resolved/<id>.json (concrete businesses) and build/graph.json.
// Exit 1 on any error; warnings print but don't fail the build.

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  specializeSkill,
  skillPracticeProfileErrors,
  specializedSkillIds,
} from "./lib/skill-practice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFS = join(ROOT, "definitions");
const OUT = join(ROOT, "build");

const KINDS = {
  businesses: "business",
  skills: "skill",
  roles: "role",
  documents: "document",
  metrics: "metric",
  "software-categories": "software-category",
  licenses: "license",
  markets: "market",
};

// BOMwiki item catalog (refresh: curl bomwiki.com/sitemap.xml | extract /item/ ids)
const bomwikiCatalog = new Set(
  readFileSync(join(DEFS, "bomwiki-catalog.txt"), "utf8").trim().split("\n"),
);

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ---- load ----------------------------------------------------------------
const byId = new Map(); // id -> { kind, file, data }
for (const [dir, kind] of Object.entries(KINDS)) {
  let files = [];
  try {
    files = readdirSync(join(DEFS, dir)).filter((f) => f.endsWith(".yaml"));
  } catch {
    continue; // kind directory may not exist yet
  }
  for (const f of files) {
    const file = join(dir, f);
    let data;
    try {
      data = yaml.load(readFileSync(join(DEFS, dir, f), "utf8"));
      if (kind === "skill") data = specializeSkill(data);
    } catch (e) {
      err(`${file}: YAML parse error: ${e.message}`);
      continue;
    }
    if (!data?.id) { err(`${file}: missing id`); continue; }
    if (data.id !== f.replace(/\.yaml$/, ""))
      err(`${file}: id "${data.id}" does not match filename`);
    if (byId.has(data.id))
      err(`${file}: duplicate id "${data.id}" (also in ${byId.get(data.id).file})`);
    if (kind !== "business" && data.kind !== kind)
      err(`${file}: kind "${data.kind}" should be "${kind}"`);
    if (!data.name) err(`${file}: missing name`);
    byId.set(data.id, { kind, file, data });
  }
}

for (const failure of skillPracticeProfileErrors())
  err(`skill-practice-profiles.yaml: ${failure}`);
for (const id of specializedSkillIds)
  if (!byId.has(id))
    err(`skill-practice-profiles.yaml: profile "${id}" has no skill definition`);

const kindOf = (id) => byId.get(id)?.kind;
const aliases = new Map();
for (const { file, data } of byId.values()) {
  if (data.aliases === undefined) continue;
  if (!Array.isArray(data.aliases)) {
    err(`${file}: aliases must be a list`);
    continue;
  }
  for (const alias of data.aliases) {
    if (typeof alias !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias)) {
      err(`${file}: alias "${alias}" is not a valid id`);
      continue;
    }
    if (byId.has(alias)) err(`${file}: alias "${alias}" conflicts with a definition id`);
    if (aliases.has(alias))
      err(`${file}: alias "${alias}" is also declared by ${aliases.get(alias)}`);
    aliases.set(alias, file);
  }
}

// ---- inheritance ---------------------------------------------------------
const LIST_KEY = { revenue_model: "id", skills: "ref" };

function mergeLists(parent = [], child = [], key) {
  const removed = new Set(child.filter((e) => e.remove).flatMap((e) => e.remove));
  const additions = child.filter((e) => !e.remove);
  const merged = new Map(parent.map((e) => [e[key], e]));
  for (const e of additions) merged.set(e[key], e); // child replaces same-key parent entry
  for (const r of removed)
    if (!merged.delete(r)) warn(`remove of "${r}" matched nothing`);
  return [...merged.values()];
}

function mergeCountryLists(parent = {}, child = {}, key) {
  const out = {};
  for (const cc of new Set([...Object.keys(parent ?? {}), ...Object.keys(child ?? {})]))
    out[cc] = mergeLists(parent?.[cc], child?.[cc], key);
  return out;
}

function mergeGeo(parent = {}, child = {}) {
  const out = {};
  for (const cc of new Set([...Object.keys(parent ?? {}), ...Object.keys(child ?? {})])) {
    const p = parent?.[cc] ?? {};
    const c = child?.[cc] ?? {};
    out[cc] = { ...structuredClone(p), ...structuredClone(c) };
    out[cc].skills = mergeLists(p.skills, c.skills, "ref");
  }
  return out;
}

function resolveBusiness(id, seen = []) {
  const entry = byId.get(id);
  if (!entry) { err(`extends target "${id}" does not exist`); return null; }
  const d = entry.data;
  if (seen.length > 2) { err(`${entry.file}: extends chain deeper than 2`); return null; }
  if (!d.extends) return structuredClone(d);
  const parent = resolveBusiness(d.extends, [...seen, id]);
  if (!parent) return null;
  const out = { ...structuredClone(parent), ...structuredClone(d) };
  delete out.abstract; // never inherited
  for (const [k, key] of Object.entries(LIST_KEY))
    out[k] = mergeLists(parent[k], d[k], key);
  out.codes = { ...(parent.codes ?? {}), ...(d.codes ?? {}) };
  out.licenses = mergeCountryLists(parent.licenses, d.licenses, "ref");
  out.geo = mergeGeo(parent.geo, d.geo);
  if (d.org) out.org = structuredClone(d.org); // org replaces wholesale
  if (d.supply_chain)
    out.supply_chain = { ...parent.supply_chain, ...d.supply_chain };
  out.summary = d.summary; // summary never inherits
  return out;
}

// ---- validate + resolve --------------------------------------------------
const businesses = [...byId.values()].filter((e) => e.kind === "business");
const resolved = new Map();
const countryKey = (cc) => /^[a-z]{2}$/.test(cc);
const CATALOG_GROUPS = new Set([
  "construction-property",
  "food-lodging",
  "health-care",
  "personal-recreation",
  "retail-vehicles",
  "professional-financial",
  "logistics-production",
]);
const IMMEDIATE_SETTLEMENT_MARKETS = new Set(["retail-consumer"]);
const LICENSE_REQUIREMENTS = new Set(["required", "conditional", "commonly-applicable"]);

const checkRef = (file, ref, kinds, ctx, { dangleOk = false } = {}) => {
  const k = kindOf(ref);
  if (k && kinds.includes(k)) return true;
  const msg = `${file}: ${ctx}: "${ref}" ${k ? `is a ${k}, expected ${kinds.join("/")}` : "does not exist"}`;
  if (dangleOk && !k) warn(msg + " (allowed to dangle)");
  else err(msg);
  return false;
};

function checkRefGeo(file, ref, kind, ctx, geo = null) {
  if (!checkRef(file, ref, [kind], ctx)) return;
  const nodeGeo = byId.get(ref)?.data.geo;
  if (!geo && Array.isArray(nodeGeo))
    err(`${file}: ${ctx} "${ref}" is geo-specific and must be bound in a country layer`);
  if (geo && Array.isArray(nodeGeo) && !nodeGeo.includes(geo))
    err(`${file}: ${ctx} "${ref}" is not tagged for ${geo}`);
}

function walkOrg(file, nodes, roles) {
  for (const n of nodes ?? []) {
    checkRefGeo(file, n.role, "role", "org");
    roles.add(n.role);
    walkOrg(file, n.reports, roles);
  }
}

function checkSkillBinding(file, p, ctx, geo = null) {
  checkRefGeo(file, p.ref, "skill", ctx, geo);
  for (const x of p.roles ?? [])
    checkRefGeo(file, x, "role", `${ctx} ${p.ref} roles`, geo);
  for (const x of p.documents ?? [])
    checkRefGeo(file, x, "document", `${ctx} ${p.ref} documents`, geo);
  for (const x of p.metrics ?? [])
    checkRefGeo(file, x, "metric", `${ctx} ${p.ref} metrics`, geo);
  for (const x of p.software ?? [])
    checkRefGeo(file, x, "software-category", `${ctx} ${p.ref} software`, geo);
}

function checkSkillOwners(file, p, ctx, orgRoles) {
  for (const role of p.roles ?? [])
    if (!orgRoles.has(role))
      err(`${file}: ${ctx} ${p.ref} owner "${role}" is missing from org`);
}

for (const { file, data } of businesses) {
  const r = resolveBusiness(data.id);
  if (!r) continue;
  if ("naics" in r) err(`${file}: bare naics is obsolete; use codes.naics`);
  if (!data.abstract) {
    if (!r.summary) err(`${file}: concrete business missing summary`);
    if (!r.codes?.naics) err(`${file}: concrete business missing codes.naics`);
    else if (!/^\d{6}$/.test(String(r.codes.naics)))
      err(`${file}: codes.naics "${r.codes.naics}" is not a 6-digit code`);
    if (!CATALOG_GROUPS.has(r.catalog_group))
      err(`${file}: concrete business has unsupported catalog_group "${r.catalog_group ?? ""}"`);
  }
  for (const [scheme, code] of Object.entries(r.codes ?? {})) {
    if (!["naics", "nic", "ssic"].includes(scheme))
      err(`${file}: unsupported classification scheme "${scheme}"`);
    if (typeof code !== "string" || !code.trim())
      err(`${file}: codes.${scheme} must be a non-empty string`);
  }
  for (const p of r.skills ?? []) checkSkillBinding(file, p, "skills");
  for (const [cc, layer] of Object.entries(r.geo ?? {})) {
    if (!countryKey(cc)) err(`${file}: geo country "${cc}" must be a lowercase ISO alpha-2 code`);
    if (!layer || typeof layer !== "object" || Array.isArray(layer))
      err(`${file}: geo.${cc} must be an object`);
    for (const p of layer?.skills ?? []) checkSkillBinding(file, p, `geo.${cc}.skills`, cc);
  }
  const orgRoles = new Set();
  walkOrg(file, r.org, orgRoles);
  for (const p of r.skills ?? []) checkSkillOwners(file, p, "skills", orgRoles);
  for (const [cc, layer] of Object.entries(r.geo ?? {}))
    for (const p of layer?.skills ?? [])
      checkSkillOwners(file, p, `geo.${cc}.skills`, orgRoles);
  if (r.licenses && (typeof r.licenses !== "object" || Array.isArray(r.licenses)))
    err(`${file}: licenses must be a per-country map`);
  for (const [cc, entries] of Object.entries(r.licenses ?? {})) {
    if (!countryKey(cc)) err(`${file}: licenses country "${cc}" must be a lowercase ISO alpha-2 code`);
    if (!Array.isArray(entries)) {
      err(`${file}: licenses.${cc} must be a list`);
      continue;
    }
    for (const l of entries)
      {
        checkRefGeo(file, l.ref, "license", `licenses.${cc}`, cc);
        if (!LICENSE_REQUIREMENTS.has(l.requirement))
          err(
            `${file}: licenses.${cc} ${l.ref} requirement must be ` +
            "required, conditional, or commonly-applicable",
          );
        if (typeof l.condition !== "string" || !l.condition.trim())
          err(`${file}: licenses.${cc} ${l.ref} must explain its scope in condition`);
        if (typeof l.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(l.as_of))
          err(`${file}: licenses.${cc} ${l.ref} as_of must be YYYY-MM-DD`);
      }
  }
  for (const x of r.supply_chain?.buys_from ?? [])
    checkRef(file, x, ["business", "market"], "supply_chain.buys_from", { dangleOk: true });
  for (const x of r.supply_chain?.sells_to ?? [])
    checkRef(file, x, ["business", "market"], "supply_chain.sells_to", { dangleOk: true });
  const skillRefs = new Set([
    ...(r.skills ?? []),
    ...Object.values(r.geo ?? {}).flatMap((layer) => layer.skills ?? []),
  ].map((binding) => binding.ref));
  const sellsTo = r.supply_chain?.sells_to ?? [];
  if (
    skillRefs.has("accounts-receivable") &&
    sellsTo.length > 0 &&
    sellsTo.every((id) => IMMEDIATE_SETTLEMENT_MARKETS.has(id))
  )
    err(
      `${file}: accounts-receivable requires a relationship buyer; ` +
      `retail-consumer settles at sale or checkout`,
    );
  if ([...(r.supply_chain?.buys_from ?? []), ...sellsTo].includes("consumer"))
    err(`${file}: legacy market "consumer" must be replaced with a specific buyer type`);
  // products are BOMwiki IDs, checked against the exported catalog
  for (const x of r.products ?? [])
    if (!bomwikiCatalog.has(x)) err(`${file}: product "${x}" not in BOMwiki catalog`);
  resolved.set(data.id, r);
}

for (const { kind, file, data } of byId.values()) {
  if (kind === "skill") {
    for (const x of [...(data.inputs ?? []), ...(data.outputs ?? [])]) {
      if (!checkRef(file, x, ["document"], "process document")) continue;
      const documentGeo = byId.get(x)?.data.geo;
      if (!Array.isArray(data.geo) && Array.isArray(documentGeo))
        err(`${file}: universal process cannot use geo-specific document "${x}"`);
      if (Array.isArray(data.geo) && Array.isArray(documentGeo))
        for (const cc of data.geo)
          if (!documentGeo.includes(cc))
            err(`${file}: document "${x}" is not tagged for process country ${cc}`);
    }
    const provided = new Set(data.inputs ?? []);
    for (const [i, s] of (data.steps ?? []).entries()) {
      const ctx = `steps[${i}]`;
      if (!s?.name) err(`${file}: ${ctx} missing name`);
      if (s.role) checkRef(file, s.role, ["role"], `${ctx} role`);
      for (const x of s.consumes ?? []) {
        checkRef(file, x, ["document"], `${ctx} consumes`);
        if (!provided.has(x)) warn(`${file}: ${ctx} consumes "${x}" before any input or earlier step provides it`);
      }
      for (const x of s.produces ?? []) {
        checkRef(file, x, ["document"], `${ctx} produces`);
        provided.add(x);
      }
    }
  }
  if (kind !== "business" && data.geo !== undefined) {
    if (!Array.isArray(data.geo) || !data.geo.length || data.geo.some((cc) => !countryKey(cc)))
      err(`${file}: shared-node geo must be a list of lowercase ISO alpha-2 codes`);
  }
}

// orphan shared nodes (referenced by nothing) — warn
const referenced = new Set();
for (const r of resolved.values()) {
  const processBindings = [
    ...(r.skills ?? []),
    ...Object.values(r.geo ?? {}).flatMap((layer) => layer.skills ?? []),
  ];
  for (const p of processBindings) {
    referenced.add(p.ref);
    [p.roles, p.documents, p.metrics, p.software].flat().filter(Boolean).forEach((x) => referenced.add(x));
  }
  const addOrg = (ns) => ns?.forEach((n) => { referenced.add(n.role); addOrg(n.reports); });
  addOrg(r.org);
  Object.values(r.licenses ?? {}).flat().forEach((l) => referenced.add(l.ref));
  [...(r.supply_chain?.buys_from ?? []), ...(r.supply_chain?.sells_to ?? [])].forEach((x) => referenced.add(x));
}
for (const { kind, data } of byId.values())
  if (kind === "skill") [...(data.inputs ?? []), ...(data.outputs ?? [])].forEach((x) => referenced.add(x));
for (const { kind, data } of byId.values())
  if (kind !== "business" && !referenced.has(data.id))
    warn(`orphan ${kind}: "${data.id}" referenced by nothing`);

// ---- emit ----------------------------------------------------------------
if (errors.length === 0) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "resolved"), { recursive: true });
  const nodes = [];
  const edges = [];
  for (const { kind, data } of byId.values())
    nodes.push({ id: data.id, label: kind, name: data.name, abstract: !!data.abstract, data });
  for (const [id, r] of resolved) {
    const src = byId.get(id).data;
    if (src.extends) edges.push({ from: id, type: "EXTENDS", to: src.extends });
    for (const p of r.skills ?? []) {
      edges.push({ from: id, type: "HAS_SKILL", to: p.ref, props: { roles: p.roles ?? [], documents: p.documents ?? [], metrics: p.metrics ?? [], software: p.software ?? [] } });
    }
    for (const [cc, layer] of Object.entries(r.geo ?? {}))
      for (const p of layer.skills ?? [])
        edges.push({ from: id, type: "HAS_SKILL", to: p.ref, props: { geo: cc, roles: p.roles ?? [], documents: p.documents ?? [], metrics: p.metrics ?? [], software: p.software ?? [] } });
    for (const [cc, entries] of Object.entries(r.licenses ?? {}))
      entries.forEach((l) => edges.push({
        from: id,
        type: "REQUIRES",
        to: l.ref,
        props: {
          geo: cc,
          requirement: l.requirement,
          condition: l.condition,
          as_of: l.as_of,
        },
      }));
    (r.supply_chain?.buys_from ?? []).forEach((x) => edges.push({ from: id, type: "BUYS_FROM", to: x }));
    (r.supply_chain?.sells_to ?? []).forEach((x) => edges.push({ from: id, type: "SELLS_TO", to: x }));
    (r.products ?? []).forEach((x) => edges.push({ from: id, type: "HANDLES", to: x }));
    writeFileSync(join(OUT, "resolved", `${id}.json`), JSON.stringify({ ...r, abstract: !!src.abstract }, null, 2));
  }
  for (const { kind, data } of byId.values()) {
    if (kind !== "skill") continue;
    (data.outputs ?? []).forEach((x) => edges.push({ from: data.id, type: "PRODUCES", to: x }));
    (data.inputs ?? []).forEach((x) => edges.push({ from: data.id, type: "CONSUMES", to: x }));
  }
  // Bindings were only carried inside HAS_SKILL props, so every role, metric,
  // and software category was an isolated node in the exported graph. Emit
  // them as edges of their own, deduplicated across the businesses that share
  // a binding. Nothing here is inferred: a pair exists only where some
  // business actually binds it.
  const BINDING_EDGES = [
    ["roles", "PERFORMED_BY"],
    ["metrics", "MEASURED_BY"],
    ["software", "RUNS_ON"],
    ["documents", "RECORDS"],
  ];
  const seenBinding = new Set();
  // The org chart is the other relationship the export dropped. A role a
  // business staffs but binds to no skill was previously an orphan node.
  for (const [id, r] of resolved) {
    const walkOrg = (ns) => (ns ?? []).forEach((n) => {
      const key = `${id} EMPLOYS ${n.role}`;
      if (!seenBinding.has(key)) {
        seenBinding.add(key);
        edges.push({ from: id, type: "EMPLOYS", to: n.role });
      }
      walkOrg(n.reports);
    });
    walkOrg(r.org);
  }
  for (const [, r] of resolved)
    for (const p of [
      ...(r.skills ?? []),
      ...Object.values(r.geo ?? {}).flatMap((layer) => layer.skills ?? []),
    ])
      for (const [field, type] of BINDING_EDGES)
        for (const ref of p[field] ?? []) {
          const key = `${p.ref} ${type} ${ref}`;
          if (seenBinding.has(key)) continue;
          seenBinding.add(key);
          edges.push({ from: p.ref, type, to: ref });
        }
  writeFileSync(join(OUT, "graph.json"), JSON.stringify({ nodes, edges }, null, 2));
}

// ---- report --------------------------------------------------------------
const counts = {};
for (const { kind } of byId.values()) counts[kind] = (counts[kind] ?? 0) + 1;
console.log("loaded:", Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
console.log(`resolved concrete businesses: ${[...resolved.values()].filter((r) => !byId.get(r.id).data.abstract).length}`);
warnings.forEach((w) => console.log("WARN:", w));
errors.forEach((e) => console.log("ERROR:", e));
console.log(`${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
