#!/usr/bin/env node
// Renders dist/ from build/graph.json + build/resolved/*.json.
// Run build-graph.mjs first (npm run build does both).

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { specializedSkillIds } from "./lib/skill-practice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const DIST = join(ROOT, "dist");
const SITE = "https://smbwiki.com";
const releaseDate = (() => {
  try {
    return execSync("git log -1 --format=%cI", { cwd: ROOT, encoding: "utf8" }).trim().slice(0, 10);
  } catch {
    return null;
  }
})();
const CATALOG_GROUPS = [
  ["construction-property", "Construction and property"],
  ["food-lodging", "Food, drink, and lodging"],
  ["health-care", "Health and care"],
  ["personal-recreation", "Personal care and recreation"],
  ["retail-vehicles", "Retail and vehicles"],
  ["professional-financial", "Professional and financial services"],
  ["logistics-production", "Logistics and production"],
];

const cssHash = createHash("sha256").update(readFileSync(join(ROOT, "assets", "style.css"))).digest("hex").slice(0, 8);
const CSS_HREF = `/style.css?v=${cssHash}`;
const opgraphHash = createHash("sha256").update(readFileSync(join(ROOT, "assets", "opgraph.js"))).digest("hex").slice(0, 8);
const OPGRAPH_HREF = `/static/opgraph.js?v=${opgraphHash}`;
const catalogHash = createHash("sha256").update(readFileSync(join(ROOT, "assets", "catalog.js"))).digest("hex").slice(0, 8);
const CATALOG_HREF = `/static/catalog.js?v=${catalogHash}`;

const graph = JSON.parse(readFileSync(join(BUILD, "graph.json"), "utf8"));
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const resolved = new Map(
  readdirSync(join(BUILD, "resolved")).map((f) => {
    const r = JSON.parse(readFileSync(join(BUILD, "resolved", f), "utf8"));
    return [r.id, r];
  }),
);
const concrete = [...resolved.values()].filter((r) => !r.abstract);

const SEG = {
  business: "business", skill: "skill", role: "role", document: "document",
  metric: "metric", "software-category": "software", license: "license", market: "market",
};
const DEF_DIR = {
  skill: "skills", role: "roles", document: "documents", metric: "metrics",
  "software-category": "software-categories", license: "licenses", market: "markets",
};
const COUNTRY = { us: "United States", in: "India", sg: "Singapore" };
const SCHEME_COUNTRY = { naics: "us", nic: "in", ssic: "sg" };
// The department a skill belongs to, in reading order on a business page:
// win the work, do it, supply it, get paid, staff it, check it, stay legal,
// keep the kit running. Every skill definition carries exactly one.
const DEPARTMENTS = [
  ["sales", "Sales"],
  ["operations", "Operations"],
  ["supply", "Supply"],
  ["finance", "Finance"],
  ["people", "People"],
  ["quality", "Quality"],
  ["compliance", "Compliance"],
  ["maintenance", "Maintenance"],
];
const DEPARTMENT_NAME = new Map(DEPARTMENTS);
const REQUIREMENT_NAME = {
  required: "Required",
  conditional: "Conditional",
  "commonly-applicable": "Commonly applicable",
};
const countryName = (cc) => COUNTRY[cc] ?? cc.toUpperCase();
const allSkillBindings = (r) => [
  ...(r.skills ?? []).map((binding) => ({ binding, geo: null })),
  ...Object.entries(r.geo ?? {}).flatMap(([geo, layer]) =>
    (layer.skills ?? []).map((binding) => ({ binding, geo })),
  ),
];
const allLicenseBindings = (r) =>
  Object.entries(r.licenses ?? {}).flatMap(([geo, entries]) =>
    (entries ?? []).map((entry) => ({ entry, geo })),
  );
const href = (id) => {
  const n = nodes.get(id);
  return n ? `/${SEG[n.label]}/${id}/` : null;
};
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");
const escAttr = (s) => esc(s)
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
const cleanText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const descriptionSentences = (value) => {
  const text = cleanText(value);
  if (!text) return [];
  return (text.match(/.*?[.!?](?=\s|$)|.+$/g) ?? [text])
    .map((sentence) => cleanText(sentence))
    .filter(Boolean)
    .map((sentence) => /[.!?]$/.test(sentence)
      ? sentence
      : `${sentence.replace(/[,:;\s]+$/, "")}.`);
};
const completeSentence = (value) => descriptionSentences(value)[0] ?? "";
const metaDescription = (...parts) => {
  for (const part of parts) {
    const sentences = descriptionSentences(part);
    const complete = sentences.find((sentence) => sentence.length >= 50 && sentence.length <= 155);
    if (complete) return complete;
    const semantic = sentences.find((sentence) => sentence.length >= 50);
    if (!semantic) continue;
    const clipped = semantic.slice(0, 154);
    const boundary = clipped.lastIndexOf(" ");
    return `${clipped.slice(0, boundary > 0 ? boundary : 154).replace(/[,:;\s]+$/, "")}…`;
  }
  return completeSentence(parts.find((part) => cleanText(part)));
};
const contextualTitle = (name, context) => {
  const full = `${name}: ${context} | SMBwiki`;
  if (full.length <= 65) return full;
  const suffix = " | SMBwiki";
  const nameOnly = `${name}${suffix}`;
  if (nameOnly.length <= 65) return nameOnly;
  const available = 65 - suffix.length;
  const clipped = String(name).slice(0, available);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > 0 ? boundary : available).trim()}${suffix}`;
};
// Skill pages are named for the process people search for: "Accounts
// payable process". Names that already say "process" are left alone.
const processName = (name) => (/\bprocess\b/i.test(name) ? name : `${name} process`);
const skillTitle = (name) => {
  const suffix = " | SMBwiki";
  for (const candidate of [`${processName(name)}: Steps and Controls`, processName(name)])
    if (`${candidate}${suffix}`.length <= 65) return `${candidate}${suffix}`;
  return contextualTitle(name, "Process and Controls");
};
const aOrAn = (name) => (/^(?:[aeiou]|hvac)/i.test(name) ? "an" : "a");
const businessTitle = (name) => {
  const suffix = " | SMBwiki";
  for (const context of ["How It Works and How to Start One", "How It Works, How to Start One", "How the Business Works"])
    if (`${name}: ${context}${suffix}`.length <= 65) return `${name}: ${context}${suffix}`;
  return contextualTitle(name, "How the Business Works");
};
const normalizeTitleBrand = (title) => cleanText(title).replace(/\|\s*smbwiki$/i, "| SMBwiki");
const jsonScriptData = (value) => JSON.stringify(value)
  .replace(/&/g, "\\u0026")
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e");
const sentenceLabel = (s) => {
  const text = String(s ?? "").replace(/-/g, " ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
};
const link = (id) => {
  const n = nodes.get(id);
  return n
    ? `<a href="${href(id)}">${esc(n.name)}</a>`
    : `<span class="external-concept">${esc(sentenceLabel(id))}</span>`;
};
const links = (ids) => (ids ?? []).map(link).join(", ");
const COUNT_WORD = [
  "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];
const countWord = (n) => COUNT_WORD[n] ?? String(n);
// Node names are Title Case for headings; inside a sentence they read lowercase.
// Acronyms keep their case, so "HVAC Contractor" reads "HVAC contractor".
const linkLower = (id) => {
  const n = nodes.get(id);
  if (!n) return esc(id);
  const name = n.name
    .split(" ")
    .map((word) => (word === word.toUpperCase() ? word : word.toLowerCase()))
    .join(" ");
  return `<a href="${href(id)}">${esc(name)}</a>`;
};

// ---- reverse indexes -----------------------------------------------------
// usedBy: shared-node id -> [{biz, binding}] ; docFlow per doc; org role usage
const usedBy = new Map(); // id -> Set/array of contexts
const add = (id, ctx) => {
  if (!usedBy.has(id)) usedBy.set(id, []);
  usedBy.get(id).push(ctx);
};
for (const r of resolved.values()) {
  for (const { binding: p, geo } of allSkillBindings(r)) {
    add(p.ref, { biz: r.id, kind: "skill-binding", binding: p, geo });
    for (const x of p.roles ?? []) add(x, { biz: r.id, kind: "binding-role", process: p.ref, geo });
    for (const x of p.documents ?? []) add(x, { biz: r.id, kind: "binding-document", process: p.ref, geo });
    for (const x of p.metrics ?? []) add(x, { biz: r.id, kind: "binding-metric", process: p.ref, geo });
    for (const x of p.software ?? []) add(x, { biz: r.id, kind: "binding-software", process: p.ref, geo });
  }
  const walk = (ns) => ns?.forEach((n) => { add(n.role, { biz: r.id, kind: "org" }); walk(n.reports); });
  walk(r.org);
  allLicenseBindings(r).forEach(({ entry, geo }) =>
    add(entry.ref, { biz: r.id, kind: "license", entry, geo }),
  );
  (r.supply_chain?.sells_to ?? []).forEach((m) => add(m, { biz: r.id, kind: "sells-to" }));
  (r.supply_chain?.buys_from ?? []).forEach((m) => add(m, { biz: r.id, kind: "buys-from" }));
}
const bizOf = (id, kinds) =>
  [...new Set((usedBy.get(id) ?? []).filter((c) => !kinds || kinds.includes(c.kind)).map((c) => c.biz))]
    .filter((b) => !resolved.get(b)?.abstract);
const documentSkills = (id) => [...new Set(
  graph.edges
    .filter((edge) =>
      edge.to === id && (edge.type === "PRODUCES" || edge.type === "CONSUMES"))
    .map((edge) => edge.from),
)];
const documentBusinesses = (id) => [...new Set([
  ...bizOf(id, ["binding-document"]),
  ...documentSkills(id).flatMap((skill) => bizOf(skill, ["skill-binding"])),
])];

const KIND_NAME = {
  business: "business type",
  skill: "skill",
  role: "role",
  document: "document",
  metric: "metric",
  "software-category": "software category",
  license: "license",
  market: "market",
};
const visualKind = (label) => label === "software-category" ? "software" : label;
const relationshipLabel = {
  EXTENDS: "extends",
  HAS_SKILL: "has skill",
  REQUIRES: "requires",
  SELLS_TO: "sells to",
  BUYS_FROM: "buys from",
  PRODUCES: "produces",
  CONSUMES: "consumes",
  HANDLES: "handles",
  EMPLOYS: "employs",
  PERFORMED_BY: "performed by",
  MEASURED_BY: "measured by",
  RUNS_ON: "runs on",
  RECORDS: "records",
  "owned-by": "owned by",
  "measured-by": "measured by",
  uses: "uses",
};
const preciseDocumentFlows = new Set(
  graph.edges
    .filter((edge) => edge.type === "PRODUCES" || edge.type === "CONSUMES")
    .map((edge) => `${edge.from}\u0000${edge.to}`),
);

// ---- SVG: org chart ------------------------------------------------------
const NODE_H = 30, VGAP = 26, HGAP = 14;
const nodeW = (name) => Math.max(84, name.length * 7.4 + 22);

function orgChart(org) {
  if (!org?.length) return "";
  const measure = (n) => {
    const w = nodeW(nodes.get(n.role)?.name ?? n.role);
    const kids = (n.reports ?? []).map(measure);
    const kw = kids.reduce((a, k) => a + k.tw, 0) + Math.max(0, kids.length - 1) * HGAP;
    return { n, w, kids, tw: Math.max(w, kw) };
  };
  const roots = org.map(measure);
  const totalW = roots.reduce((a, r) => a + r.tw, 0) + Math.max(0, roots.length - 1) * HGAP * 2;
  let out = [], maxY = 0;
  const place = (m, x0, depth) => {
    const y = depth * (NODE_H + VGAP);
    maxY = Math.max(maxY, y + NODE_H);
    const cx = x0 + m.tw / 2;
    const name = nodes.get(m.n.role)?.name ?? m.n.role;
    out.push(`<a href="${href(m.n.role) ?? "#"}"><rect x="${cx - m.w / 2}" y="${y}" width="${m.w}" height="${NODE_H}" rx="3"/><text x="${cx}" y="${y + NODE_H / 2 + 4}">${esc(name)}</text></a>`);
    let cx0 = x0 + (m.tw - (m.kids.reduce((a, k) => a + k.tw, 0) + Math.max(0, m.kids.length - 1) * HGAP)) / 2;
    for (const k of m.kids) {
      const kcx = cx0 + k.tw / 2;
      out.push(`<path d="M ${cx} ${y + NODE_H} V ${y + NODE_H + VGAP / 2} H ${kcx} V ${y + NODE_H + VGAP}" fill="none"/>`);
      place(k, cx0, depth + 1);
      cx0 += k.tw + HGAP;
    }
  };
  let x = 0;
  for (const r of roots) { place(r, x, 0); x += r.tw + HGAP * 2; }
  return `<div class="diagram-shell"><svg class="diagram org" viewBox="-6 -6 ${totalW + 12} ${maxY + 12}" width="${totalW + 12}" height="${maxY + 12}" role="img" aria-label="Org chart">${out.join("")}</svg></div>`;
}

// ---- SVG: process flow ---------------------------------------------------
// ---- SVG: step flow (one process, its steps left to right) ---------------
function stepFlow(d) {
  const steps = d.steps ?? [];
  if (!steps.length) return "";
  const H = 46, GAP = 78;
  const widths = steps.map((s) => Math.max(120, s.name.length * 7.4 + 26));
  const xs = [];
  let x = 0;
  for (const w of widths) { xs.push(x); x += w + GAP; }
  const total = x - GAP;
  const out = [];
  steps.forEach((s, i) => {
    const w = widths[i], sx = xs[i];
    const roleName = s.role ? (nodes.get(s.role)?.name ?? s.role) : "";
    out.push(`<rect x="${sx}" y="0" width="${w}" height="${H}" rx="3"/>`);
    out.push(`<text x="${sx + w / 2}" y="${roleName ? 19 : H / 2 + 4}" class="step-name">${esc(s.name)}</text>`);
    if (roleName) out.push(`<text x="${sx + w / 2}" y="34" class="step-role">${esc(roleName)}</text>`);
    if (i < steps.length - 1) {
      const x1 = sx + w, x2 = xs[i + 1];
      out.push(`<path d="M ${x1} ${H / 2} H ${x2 - 2}" fill="none" marker-end="url(#sarr)"/>`);
      const made = (s.produces ?? []).map((doc) => nodes.get(doc)?.name ?? doc).join(", ");
      if (made) out.push(`<text class="edge" x="${(x1 + x2) / 2}" y="${H / 2 - 7}">${esc(made)}</text>`);
    }
  });
  const last = steps[steps.length - 1];
  const lastMade = (last.produces ?? []).map((doc) => nodes.get(doc)?.name ?? doc).join(", ");
  const tail = lastMade ? 16 : 0;
  if (lastMade) out.push(`<text class="edge" x="${total}" y="${H + 14}" text-anchor="end">→ ${esc(lastMade)}</text>`);
  return `<div class="diagram-shell"><svg class="diagram steps" viewBox="-6 -16 ${total + 12} ${H + 24 + tail}" width="${total + 12}" height="${H + 24 + tail}" role="img" aria-label="Steps"><defs><marker id="sarr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs>${out.join("")}</svg></div>`;
}

// ---- interactive relationship maps ---------------------------------------
function graphShell(data, caption, relationships) {
  const sizeClass = data.nodes.length <= 5
    ? "op-small"
    : data.nodes.length <= 14
      ? "op-medium"
      : "op-large";
  const fallback = relationships.length
    ? `<details class="graph-relationships"><summary>Direct relationships</summary><ul>${relationships.map((rel) => {
        const from = rel.s === data.focusId ? `<strong>${esc(nodes.get(rel.s)?.name ?? rel.s)}</strong>` : link(rel.s);
        const to = rel.t === data.focusId ? `<strong>${esc(nodes.get(rel.t)?.name ?? rel.t)}</strong>` : link(rel.t);
        return `<li>${from} <span>${esc(rel.label)}</span> ${to}</li>`;
      }).join("")}</ul></details>`
    : "";
  const controls = [
    `<button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button>`,
    `<button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">−</button>`,
    `<button type="button" data-z="fit" title="Fit map" aria-label="Fit relationship map">fit</button>`,
    data.mode === "business"
      ? `<button type="button" data-z="all" title="Expand or collapse skill details" aria-label="Expand or collapse skill details">all</button>`
      : "",
  ].filter(Boolean);
  return `<div class="op-wrap ${sizeClass}">
    <div class="op-tools">
      ${controls.join("\n      ")}
    </div>
    <div id="opcanvas" role="img" aria-label="${esc(data.ariaLabel)}"></div>
  </div>
  <p class="figcaption">${caption}</p>${fallback ? `\n  ${fallback}` : ""}
  <script id="opgraph-data" type="application/json">${jsonScriptData(data)}</script>
  <script src="${OPGRAPH_HREF}" defer></script>`;
}

function opGraph(r) {
  const gNodes = new Map(), gEdges = [];
  const useCount = (id, kinds) => bizOf(id, kinds).length;
  const inTypes = (n) => (n > 1 ? `in ${n} types` : "");
  const put = (id, kind, extra = {}) => {
    if (!gNodes.has(id)) {
      const n = nodes.get(id);
      gNodes.set(id, { id, kind, name: n?.name ?? r.name, url: n ? href(id) : null, ...extra });
    }
  };
  const bindings = allSkillBindings(r).filter(({ binding: p }) => nodes.get(p.ref));
  const orgN = (function c(ns) { return (ns ?? []).reduce((a, n) => a + 1 + c(n.reports), 0); })(r.org);
  put(r.id, "business", { focus: 1, initial: true, sub: `business type · ${bindings.length} skills · ${orgN} roles` });
  for (const { binding: p, geo } of bindings) {
    const pd = nodes.get(p.ref).data;
    const shared = useCount(p.ref, ["skill-binding"]);
    put(p.ref, "skill", {
      initial: true,
      shared: shared > 1 ? 1 : undefined,
      sub: ["skill", pd.steps?.length ? `${pd.steps.length} steps` : "", geo ? countryName(geo) : "", inTypes(shared)].filter(Boolean).join(" · "),
    });
    gEdges.push({ s: r.id, t: p.ref, kind: geo ? "geo" : "has-skill", label: geo ? `has skill in ${countryName(geo)}` : "has skill" });
    for (const x of pd.outputs ?? []) { if (nodes.get(x)) { put(x, "document", { sub: ["document", inTypes(useCount(x, ["binding-document"]))].filter(Boolean).join(" · ") }); gEdges.push({ s: p.ref, t: x, kind: "produces", label: "produces" }); } }
    for (const x of pd.inputs ?? []) { if (nodes.get(x)) { put(x, "document", { sub: ["document", inTypes(useCount(x, ["binding-document"]))].filter(Boolean).join(" · ") }); gEdges.push({ s: p.ref, t: x, kind: "consumes", label: "consumes" }); } }
    for (const x of p.roles ?? []) { if (nodes.get(x)) { put(x, "role", { sub: ["role", inTypes(useCount(x, ["org", "binding-role"]))].filter(Boolean).join(" · ") }); gEdges.push({ s: p.ref, t: x, kind: "owned-by", label: "owned by" }); } }
    for (const x of p.metrics ?? []) { if (nodes.get(x)) { put(x, "metric", { sub: ["metric", inTypes(useCount(x, ["binding-metric"]))].filter(Boolean).join(" · ") }); gEdges.push({ s: p.ref, t: x, kind: "measured-by", label: "measured by" }); } }
    for (const x of p.software ?? []) { if (nodes.get(x)) { put(x, "software", { sub: ["software category", inTypes(useCount(x, ["binding-software"]))].filter(Boolean).join(" · ") }); gEdges.push({ s: p.ref, t: x, kind: "uses", label: "uses" }); } }
  }
  // Related businesses are structural siblings, children of an abstract
  // base, or represented supply-chain partners.
  const related = new Set();
  if (r.abstract) {
    for (const child of [...resolved.values()].filter((candidate) => candidate.extends === r.id))
      related.add(child.id);
  } else if (r.extends) {
    for (const s of concrete.filter((c) => c.extends === r.extends && c.id !== r.id)) related.add(s.id);
  }
  for (const x of [...(r.supply_chain?.buys_from ?? []), ...(r.supply_chain?.sells_to ?? [])])
    if (nodes.get(x)) related.add(x);
  for (const id of [...related].slice(0, 8)) {
    const n = nodes.get(id);
    put(id, visualKind(n.label), { initial: true, related: 1, sub: KIND_NAME[n.label] ?? n.label });
    gEdges.push({ s: r.id, t: id, kind: "related", label: r.abstract ? "extended by" : "related" });
  }
  const data = {
    mode: "business",
    focusId: r.id,
    ariaLabel: `Skill and relationship map for ${r.name}`,
    nodes: [...gNodes.values()],
    edges: gEdges,
  };
  return graphShell(
    data,
    "Skills are shown first. Select a skill to reveal its documents, roles, metrics, and software. Select any other node to open its page. Drag to pan; use the controls to zoom.",
    gEdges,
  );
}

function relationshipGraph(n) {
  const relationships = new Map();
  const addRelationship = (s, t, kind, label) => {
    if (!nodes.get(s) || !nodes.get(t)) return;
    const otherId = s === n.id ? t : s;
    if (resolved.get(otherId)?.abstract) return;
    const key = `${s}\u0000${kind}\u0000${t}`;
    if (!relationships.has(key)) relationships.set(key, { s, t, kind, label });
  };

  for (const edge of graph.edges) {
    if (edge.from !== n.id && edge.to !== n.id) continue;
    const label = edge.type === "REQUIRES"
      ? edge.props?.requirement === "conditional"
        ? "may require"
        : edge.props?.requirement === "commonly-applicable"
          ? "commonly needs"
          : "requires"
      : relationshipLabel[edge.type] ?? sentenceLabel(edge.type);
    addRelationship(
      edge.from,
      edge.to,
      edge.type.toLowerCase().replace(/_/g, "-"),
      label,
    );
  }

  for (const edge of graph.edges.filter((candidate) => candidate.type === "HAS_SKILL")) {
    const skill = edge.to;
    for (const document of edge.props?.documents ?? []) {
      const hasPreciseFlow = preciseDocumentFlows.has(`${skill}\u0000${document}`);
      if (!hasPreciseFlow && (n.id === skill || n.id === document))
        addRelationship(skill, document, "uses-document", "uses document");
    }
    for (const role of edge.props?.roles ?? [])
      if (n.id === skill || n.id === role) addRelationship(skill, role, "owned-by", relationshipLabel["owned-by"]);
    for (const metric of edge.props?.metrics ?? [])
      if (n.id === skill || n.id === metric) addRelationship(skill, metric, "measured-by", relationshipLabel["measured-by"]);
    for (const software of edge.props?.software ?? [])
      if (n.id === skill || n.id === software) addRelationship(skill, software, "uses", relationshipLabel.uses);
  }
  if (n.label === "role") {
    for (const context of usedBy.get(n.id) ?? [])
      if (context.kind === "org") addRelationship(context.biz, n.id, "includes-role", "includes role");
  }

  const all = [...relationships.values()].sort((a, b) => {
    const aOther = a.s === n.id ? a.t : a.s;
    const bOther = b.s === n.id ? b.t : b.s;
    return (nodes.get(aOther)?.name ?? aOther).localeCompare(nodes.get(bOther)?.name ?? bOther)
      || a.label.localeCompare(b.label);
  });
  const byKind = new Map();
  for (const rel of all) {
    const other = nodes.get(rel.s === n.id ? rel.t : rel.s);
    if (!byKind.has(other.label)) byKind.set(other.label, []);
    byKind.get(other.label).push(rel);
  }
  const kindOrder = ["skill", "document", "role", "metric", "software-category", "license", "market", "business"];
  const selected = [];
  while (selected.length < 36 && [...byKind.values()].some((items) => items.length)) {
    for (const kind of kindOrder) {
      const items = byKind.get(kind);
      if (items?.length && selected.length < 36) selected.push(items.shift());
    }
  }

  const shownIds = new Set([n.id]);
  for (const rel of selected) {
    shownIds.add(rel.s);
    shownIds.add(rel.t);
  }
  const gNodes = [...shownIds].map((id) => {
    const node = nodes.get(id);
    return {
      id,
      kind: visualKind(node.label),
      name: node.name,
      ...(id === n.id ? { focus: 1 } : { url: href(id) }),
      initial: true,
      sub: KIND_NAME[node.label] ?? node.label,
    };
  });
  const data = {
    mode: "entity",
    focusId: n.id,
    ariaLabel: `Direct relationship map for ${n.name}`,
    nodes: gNodes,
    edges: selected,
  };
  const relationshipCount = all.length;
  const entityCount = new Set(all.map((rel) => rel.s === n.id ? rel.t : rel.s)).size;
  const scope = selected.length < relationshipCount
    ? `Showing ${selected.length} of ${relationshipCount} recorded relationships across ${entityCount} directly related ${entityCount === 1 ? "entity" : "entities"}. The complete relationship list is available below the map.`
    : `${entityCount} directly related ${entityCount === 1 ? "entity" : "entities"} across ${relationshipCount} recorded ${relationshipCount === 1 ? "relationship" : "relationships"}.`;
  return graphShell(
    data,
    `${scope} Select a linked node to open its page. Drag to pan; use the controls to zoom.`,
    all,
  );
}

// ---- SVG: process neighborhood (upstream | this | downstream) ------------
function contextDiagram(d) {
  const others = graph.nodes.filter((n) => n.label === "skill" && n.id !== d.id);
  const up = [], down = [];
  for (const o of others) {
    const feeds = (o.data.outputs ?? []).filter((x) => (d.inputs ?? []).includes(x));
    const takes = (d.outputs ?? []).filter((x) => (o.data.inputs ?? []).includes(x));
    if (feeds.length) up.push({ id: o.id, docs: feeds });
    if (takes.length) down.push({ id: o.id, docs: takes });
  }
  if (!up.length && !down.length) return "";
  // Each of the three columns is as wide as its own widest label. A single
  // fixed width clipped every skill whose name ran past it.
  const H = 34, ROW = 52;
  const wOf = (id) => nodeW(nodes.get(id)?.name ?? id);
  const docLabel = (docs) => docs.map((x) => nodes.get(x)?.name ?? x).join(", ");
  // The gap between columns has to hold the edge label, or the label runs
  // over the next box. Edge text is italic 10.5px serif.
  const labelW = (docs) => docLabel(docs).length * 5.1 + 20;
  const gapFor = (list) => Math.max(72, ...list.map((e) => labelW(e.docs)));
  const wOfList = (list) => Math.max(...list.map((e) => wOf(e.id)), 0);
  const wUp = wOfList(up);
  const wSelf = wOf(d.id);
  const wDown = wOfList(down);
  const gapUp = gapFor(up);
  const gapDown = gapFor(down);
  const xSelf = up.length ? wUp + gapUp : 0;
  const xDown = xSelf + wSelf + gapDown;
  const rows = Math.max(up.length, down.length, 1);
  const midY = ((rows - 1) * ROW) / 2;
  const out = [];
  const box = (x, y, id, self = false) => {
    const w = wOf(id);
    const inner = `<rect x="${x}" y="${y}" width="${w}" height="${H}" rx="3"${self ? ' class="self"' : ""}/><text x="${x + w / 2}" y="${y + H / 2 + 4}">${esc(nodes.get(id).name)}</text>`;
    return self ? inner : `<a href="${href(id)}">${inner}</a>`;
  };
  // One label per distinct document, not one per edge. Where eleven edges all
  // carry an inspection report, the word is worth saying once.
  const groupLabels = (list, x) => {
    const groups = new Map();
    list.forEach((e, i) => {
      const key = docLabel(e.docs);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i * ROW + H / 2);
    });
    const placed = [...groups.entries()]
      .map(([label, ys]) => ({ label, y: ys.reduce((a, b) => a + b, 0) / ys.length }))
      .sort((a, b) => a.y - b.y);
    // Keep stacked groups legible when their rows sit close together.
    for (let i = 1; i < placed.length; i++)
      if (placed[i].y - placed[i - 1].y < 15) placed[i].y = placed[i - 1].y + 15;
    return placed.map((g) => `<text class="edge from-left" x="${x}" y="${(g.y - 6).toFixed(1)}">${esc(g.label)}</text>`);
  };
  up.forEach((u, i) => {
    const y = i * ROW;
    const x1 = wOf(u.id);
    out.push(box(wUp - x1, y, u.id));
    out.push(`<path d="M ${wUp} ${y + H / 2} C ${wUp + 40} ${y + H / 2}, ${xSelf - 40} ${midY + H / 2}, ${xSelf} ${midY + H / 2}" fill="none" marker-end="url(#carr)"/>`);
  });
  out.push(...groupLabels(up, wUp + 10));
  out.push(box(xSelf, midY, d.id, true));
  down.forEach((v, i) => {
    const y = i * ROW;
    const from = xSelf + wSelf;
    out.push(`<path d="M ${from} ${midY + H / 2} C ${from + 40} ${midY + H / 2}, ${xDown - 40} ${y + H / 2}, ${xDown} ${y + H / 2}" fill="none" marker-end="url(#carr)"/>`);
    out.push(box(xDown, y, v.id));
  });
  if (down.length) out.push(...groupLabels(down, xSelf + wSelf + 10));
  const totalW = down.length ? xDown + wDown : xSelf + wSelf;
  const totalH = (rows - 1) * ROW + H;
  return `<div class="diagram-shell"><svg class="diagram context" viewBox="-6 -8 ${totalW + 12} ${totalH + 16}" width="${totalW + 12}" height="${totalH + 16}" role="img" aria-label="Process in context"><defs><marker id="carr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs>${out.join("")}</svg></div>`;
}

function flowDiagram(r) {
  const procs = (r.skills ?? []).map((p) => p.ref).filter((id) => nodes.get(id));
  const outsOf = (id) => nodes.get(id)?.data.outputs ?? [];
  const insOf = (id) => nodes.get(id)?.data.inputs ?? [];
  const edges = [];
  for (const a of procs)
    for (const b of procs) {
      if (a === b) continue;
      const docs = outsOf(a).filter((d) => insOf(b).includes(d));
      if (docs.length) edges.push({ a, b, docs });
    }
  // longest-path layering with cycle guard
  const layer = Object.fromEntries(procs.map((p) => [p, 0]));
  for (let i = 0; i < procs.length; i++) {
    let moved = false;
    for (const e of edges)
      if (layer[e.b] <= layer[e.a] && layer[e.a] + 1 <= procs.length) {
        layer[e.b] = layer[e.a] + 1; moved = true;
      }
    if (!moved) break;
  }
  const byLayer = new Map();
  for (const p of procs) {
    if (!byLayer.has(layer[p])) byLayer.set(layer[p], []);
    byLayer.get(layer[p]).push(p);
  }
  // Boxes are sized to their label, as the org chart already does. A fixed
  // width clipped every skill whose name ran past it.
  const ROW = 62, H = 34, GAP = 58;
  const boxW = (id) => nodeW(nodes.get(id)?.name ?? id);
  const layerX = new Map();
  let cursor = 0;
  for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
    layerX.set(l, cursor);
    cursor += Math.max(...byLayer.get(l).map(boxW)) + GAP;
  }
  const pos = {};
  for (const [l, ps] of byLayer)
    ps.forEach((p, i) => (pos[p] = { x: layerX.get(l), y: i * ROW, w: boxW(p) }));
  const maxX = Math.max(...Object.values(pos).map((p) => p.x + p.w));
  const maxY = Math.max(...Object.values(pos).map((p) => p.y)) + H + 14;
  const out = [];
  // Edges leaving one skill all start at the same point. Label each distinct
  // document once per source rather than once per edge, so a skill that hands
  // the same record to five others says the record's name once.
  const bundles = new Map();
  for (const e of edges) {
    const A = pos[e.a], B = pos[e.b];
    const x1 = A.x + A.w, y1 = A.y + H / 2, x2 = B.x, y2 = B.y + H / 2;
    const mx = (x1 + x2) / 2;
    out.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" marker-end="url(#arr)"/>`);
    const label = e.docs.map((d) => nodes.get(d)?.name ?? d).join(", ");
    const key = `${e.a}\u0000${label}`;
    if (!bundles.has(key)) bundles.set(key, { label, pts: [] });
    bundles.get(key).pts.push({ x1, y1, x2, y2, mx });
  }
  // Place one label per bundle a third of the way along its middle run.
  const placed = [...bundles.values()].map(({ label, pts }) => {
    const p = pts[Math.floor(pts.length / 2)];
    const t = 0.34, u = 1 - t;
    return {
      label,
      x: u ** 3 * p.x1 + 3 * u * u * t * p.mx + 3 * u * t * t * p.mx + t ** 3 * p.x2,
      y: u ** 3 * p.y1 + 3 * u * u * t * p.y1 + 3 * u * t * t * p.y2 + t ** 3 * p.y2,
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 1; i < placed.length; i++)
    if (Math.abs(placed[i].x - placed[i - 1].x) < 90 && placed[i].y - placed[i - 1].y < 15)
      placed[i].y = placed[i - 1].y + 15;
  for (const g of placed)
    out.push(`<text class="edge" x="${g.x.toFixed(1)}" y="${(g.y - 5).toFixed(1)}">${esc(g.label)}</text>`);
  for (const p of procs) {
    const { x, y, w } = pos[p];
    out.push(`<a href="${href(p)}"><rect x="${x}" y="${y}" width="${w}" height="${H}" rx="3"/><text x="${x + w / 2}" y="${y + H / 2 + 4}">${esc(nodes.get(p).name)}</text></a>`);
  }
  return `<div class="diagram-shell"><svg class="diagram flow" viewBox="-6 -14 ${maxX + 12} ${maxY + 18}" width="${maxX + 12}" height="${maxY + 18}" role="img" aria-label="Process flow"><defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs>${out.join("")}</svg></div>`;
}

// ---- page shell ----------------------------------------------------------
function page({ path, title, desc, h1, kicker, body, jsonld, yamlPath, jsonPath, bare, indexable = false }) {
  const src = yamlPath
    ? `<p class="source">Definition: <a href="${yamlPath}">YAML</a>${jsonPath ? ` · <a href="${jsonPath}">resolved JSON</a>` : ""} · <a href="https://github.com/erphq/smbwiki">repo</a></p>`
    : "";
  const ogType = jsonld?.["@type"] === "Article" ? "article" : "website";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${indexable ? "" : '<meta name="robots" content="noindex">'}
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:site_name" content="SMBwiki">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/static/card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="${CSS_HREF}">
${jsonld ? `<script type="application/ld+json">${jsonScriptData(jsonld)}</script>` : ""}
</head>
<body>
<header><div class="wrap"><a class="wordmark" href="/">SMBwiki</a><nav><a href="/#business-types">business types</a><a href="/about/">about</a><a href="https://github.com/erphq/smbwiki">source</a></nav></div></header>
<main class="wrap">
${bare ? "" : `${kicker ? `<p class="kicker">${kicker}</p>` : ""}\n<h1>${esc(h1 ?? title)}</h1>`}
${body}
${src}
</main>
<footer><div class="wrap"><p>SMBwiki · <a href="/about/">about</a> · <a href="/graph/">how the graph is built</a> · <a href="/research/">research</a> · <a href="/llms.txt">llms.txt</a> · <a href="https://github.com/erphq/smbwiki">source on GitHub</a> · MIT</p><p>Definitions anchored to NAICS and standards-body sources · made by <a href="https://github.com/protosphinx">protosphinx</a></p></div></footer>
</body>
</html>`;
  const dir = join(DIST, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const section = (title, inner) =>
  inner ? `<section id="${slug(title)}"><h2>${title}</h2>${inner}</section>` : "";
const table = (head, rows) =>
  rows.length
    ? `<div class="tblwrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : "";

// ---- inheritance delta ---------------------------------------------------
function deltaSection(r) {
  if (!r.extends) return "";
  const p = resolved.get(r.extends);
  if (!p) return "";
  const pProcs = new Map((p.skills ?? []).map((x) => [x.ref, x]));
  const cProcs = new Map((r.skills ?? []).map((x) => [x.ref, x]));
  const added = [...cProcs.keys()].filter((k) => !pProcs.has(k));
  const removed = [...pProcs.keys()].filter((k) => !cProcs.has(k));
  const rebound = [...cProcs.keys()].filter(
    (k) => pProcs.has(k) && JSON.stringify(pProcs.get(k)) !== JSON.stringify(cProcs.get(k)),
  );
  const rev = (x) => new Set((x.revenue_model ?? []).map((e) => e.id));
  const revAdd = [...rev(r)].filter((x) => !rev(p).has(x));
  const revDrop = [...rev(p)].filter((x) => !rev(r).has(x));
  const lic = (x) => new Set(allLicenseBindings(x).map(({ entry }) => entry.ref));
  const licDrop = [...lic(p)].filter((x) => !lic(r).has(x));
  const licAdd = [...lic(r)].filter((x) => !lic(p).has(x));
  // Reader prose, not diff-speak: name the shared model, name the businesses
  // it is shared with, then say in whole sentences what this trade changes.
  const baseName = p.name.replace(/\s*\(base\)$/i, "").toLowerCase();
  const baseLink = `<a href="${href(r.extends)}">${esc(baseName)}</a>`;
  const siblings = [...resolved.values()]
    .filter((x) => !x.abstract && x.extends === r.extends && x.id !== r.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const revName = (id) => esc(sentenceLabel(id).toLowerCase());
  const andJoin = (parts) =>
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
  const linksAnd = (ids) => andJoin((ids ?? []).map(link));
  const sentences = [];
  const sibExamples = siblings.slice(0, 2).map((x) => x.id);
  sentences.push(
    siblings.length === 0
      ? `A ${linkLower(r.id)} runs on the ${baseLink} model.`
      : siblings.length <= 2
        ? `A ${linkLower(r.id)} runs on the ${baseLink} model it shares with ${linksAnd(sibExamples)}.`
        : `A ${linkLower(r.id)} runs on the ${baseLink} model it shares with ${countWord(siblings.length)} other business types, among them ${linksAnd(sibExamples)}.`,
  );
  if (added.length) sentences.push(`On top of that shared machinery it adds ${linksAnd(added)}.`);
  const orJoin = (parts) =>
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}` : parts.join("");
  if (removed.length) sentences.push(`It does not run ${orJoin(removed.map(link))}.`);
  if (rebound.length) sentences.push(`It runs ${linksAnd(rebound)} with its own roles and records.`);
  if (revAdd.length && revDrop.length)
    sentences.push(`Its revenue comes from ${andJoin(revAdd.map(revName))} in place of the base model's ${andJoin(revDrop.map(revName))}.`);
  else if (revAdd.length) sentences.push(`It adds ${andJoin(revAdd.map(revName))} revenue.`);
  else if (revDrop.length) sentences.push(`It does not earn ${andJoin(revDrop.map(revName))}.`);
  if (licAdd.length) sentences.push(`It adds the ${linksAnd(licAdd)}.`);
  if (licDrop.length) sentences.push(`It does not need the ${orJoin(licDrop.map(link))}.`);
  if (JSON.stringify(p.org) !== JSON.stringify(r.org)) sentences.push("Its org chart is arranged differently.");
  if (sentences.length < 2) return "";
  return section("Shared model", `<p>${sentences.join(" ")}</p>`);
}

// ---- render: business pages ----------------------------------------------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const r of resolved.values()) {
  const bindingRow = (p) => [
    link(p.ref),
    links(p.roles),
    links(p.documents),
    links(p.metrics),
    links(p.software),
  ];
  const bindRows = (r.skills ?? []).map((p) => bindingRow(p));
  // Grouped by department so a reader can see which function of this business
  // each skill belongs to, and which functions an agent could pick up.
  const departmentOf = (ref) => nodes.get(ref)?.data?.department ?? "operations";
  const skillsByDepartment = DEPARTMENTS
    .map(([id, label]) => [label, (r.skills ?? []).filter((p) => departmentOf(p.ref) === id)])
    .filter(([, ps]) => ps.length)
    .map(([label, ps]) =>
      `<h3 class="dept">${esc(label)} <span class="muted">${ps.length}</span></h3>` +
      table(["skill", "owned by", "documents", "metrics", "software"], ps.map(bindingRow)),
    ).join("");
  const countryKeys = new Set([
    ...Object.keys(r.licenses ?? {}),
    ...Object.keys(r.geo ?? {}),
    ...Object.keys(r.codes ?? {}).map((scheme) => SCHEME_COUNTRY[scheme]).filter(Boolean),
  ]);
  const countryLayers = [...countryKeys].sort((a, b) =>
    (Object.keys(COUNTRY).indexOf(a) + 1 || 99) - (Object.keys(COUNTRY).indexOf(b) + 1 || 99),
  ).map((cc) => {
    const codeRows = Object.entries(r.codes ?? {})
      .filter(([scheme]) => SCHEME_COUNTRY[scheme] === cc)
      .map(([scheme, code]) => `<span class="code-chip">${esc(scheme.toUpperCase())} ${esc(code)}</span>`)
      .join("");
    const licenseRows = (r.licenses?.[cc] ?? []).map((l) => [
      link(l.ref),
      esc(REQUIREMENT_NAME[l.requirement] ?? sentenceLabel(l.requirement)),
      esc(nodes.get(l.ref)?.data.jurisdiction ?? countryName(cc)),
      esc(l.condition),
      `<time datetime="${esc(l.as_of)}">${esc(l.as_of)}</time>`,
    ]);
    const geoRows = (r.geo?.[cc]?.skills ?? []).map((p) => bindingRow(p));
    return `<div class="geo-block"><div class="geo-heading"><h3>${esc(countryName(cc))}</h3><div class="code-chips">${codeRows}</div></div>${licenseRows.length ? `<div class="geo-sub"><h4>Licenses and credentials</h4>${table(["license or credential", "status", "jurisdiction", "scope", "source checked"], licenseRows)}<p class="note">Status describes this business model as of the date shown. Confirm current requirements with the authority for the operating jurisdiction.</p></div>` : ""}${geoRows.length ? `<div class="geo-sub"><h4>Country-specific operations</h4>${table(["skill", "owned by", "documents", "metrics", "software"], geoRows)}</div>` : ""}</div>`;
  }).join("");
  const geoProcessCount = Object.values(r.geo ?? {}).reduce((n, layer) => n + (layer.skills ?? []).length, 0);
  const orgDepth = (ns, d = 1) => Math.max(d, ...(ns ?? []).flatMap((n) => (n.reports?.length ? [orgDepth(n.reports, d + 1)] : [d])));
  const orgCount = (ns) => (ns ?? []).reduce((a, n) => a + 1 + orgCount(n.reports), 0);
  const metricRows = [];
  const seenM = new Set();
  for (const { binding: p, geo } of allSkillBindings(r))
    for (const m of p.metrics ?? []) {
      const metricKey = `${m}:${p.ref}:${geo ?? "core"}`;
      if (seenM.has(metricKey)) continue;
      seenM.add(metricKey);
      const d = nodes.get(m)?.data ?? {};
      metricRows.push([
        link(m),
        esc(d.unit ?? ""),
        d.direction === "lower" ? "lower is better" : "higher is better",
        `${link(p.ref)}${geo ? ` <span class="geo-tag">${esc(countryName(geo))}</span>` : ""}`,
      ]);
    }
  const children = [...resolved.values()].filter((c) => c.extends === r.id);
  const descendants = concrete.filter((candidate) => {
    let parent = candidate.extends;
    while (parent) {
      if (parent === r.id) return true;
      parent = resolved.get(parent)?.extends;
    }
    return false;
  });
  const orgN = (function c(ns) { return (ns ?? []).reduce((a, n) => a + 1 + c(n.reports), 0); })(r.org);
  const processN = new Set(allSkillBindings(r).map(({ binding }) => binding.ref)).size;
  const licenseN = allLicenseBindings(r).length;
  const productN = (r.products ?? []).length;
  const stats = [
    `<b>${processN}</b> ${processN === 1 ? "skill" : "skills"}`,
    `<b>${orgN}</b> ${orgN === 1 ? "role" : "roles"}`,
    licenseN ? `<b>${licenseN}</b> ${licenseN === 1 ? "license" : "licenses"}` : "",
    productN ? `<b>${productN}</b> linked ${productN === 1 ? "product" : "products"}` : "",
  ].filter(Boolean);
  if (r.abstract) stats.unshift(`<b>${descendants.length}</b> inheriting business ${descendants.length === 1 ? "type" : "types"}`);
  const statline = `<p class="statline">${stats.join(" · ")}</p>`;
  const abstractName = r.name.replace(/\s*\(base\)$/i, "");
  const descendantExamples = descendants
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((business) => business.name);
  const abstractSummary = r.abstract
    ? `${abstractName} is SMBwiki's shared operating model for ${descendants.length} business ${descendants.length === 1 ? "type" : "types"}${descendantExamples.length ? `, including ${descendantExamples.join(", ")}` : ""}. It defines the common skills, roles, documents, metrics, software, and compliance structure those businesses inherit.`
    : "";
  const businessSummarySource = String(r.summary ?? "").trim() || abstractSummary;
  const businessSummaryText = cleanText(businessSummarySource);
  const summary = businessSummarySource
    .split(/\n+/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("\n");
  const structure = section(
    r.abstract ? "Model scope" : "Structure",
    `<p>This ${r.abstract ? "shared operating model" : "business definition"} contains ${(r.skills ?? []).length} core skills${geoProcessCount ? ` and ${geoProcessCount} country-specific ${geoProcessCount === 1 ? "skill" : "skills"}` : ""}. The org chart contains ${orgCount(r.org)} roles across ${orgDepth(r.org)} levels.${r.abstract && children.length ? ` It is extended directly by ${children.length} ${children.length === 1 ? "model" : "models"}.` : ""}</p>`,
  );
  const revenue = `<ul class="revenue-list">${(r.revenue_model ?? []).map((m) =>
    `<li><strong>${esc(sentenceLabel(m.id))}</strong>${m.note ? `: ${esc(m.note)}` : ""}</li>`,
  ).join("")}</ul>`;
  const a = r.article;
  const lowerName = r.name.toLowerCase();
  const article = a ? [
    section(`How ${aOrAn(r.name)} ${lowerName} works`, `<p>${esc(String(a.operating_model).trim())}</p>`),
    section(`How to start ${aOrAn(r.name)} ${lowerName}`, `<p>${esc(String(a.starting).trim())}</p>`),
    section(`${r.name} economics and profit margin`,
      `<p>${esc(String(a.economics).trim())}</p>` +
      (a.benchmarks?.length
        ? table(["figure", "value", "what it assumes", "source"],
            a.benchmarks.map((b) => [esc(b.scope), esc(b.value), esc(b.note ?? ""), `<a href="${escAttr(b.source)}">${esc(b.source_name)}</a>`])) +
          `<p class="note">Published figures for the scope shown, read from the linked source on the release date. Local costs, mix, and scale move every one of them.</p>`
        : "")),
  ].join("\n") : "";
  const body = [
    statline,
    r.abstract && children.length
      ? `<p class="note">Shared reference model. Extended directly by ${links(children.map((c) => c.id))}.</p>`
      : "",
    summary ? `<div class="summary">${summary}</div>` : "",
    article,
    section("Revenue", revenue),
    structure,
    section("Document flow", flowDiagram(r)),
    section("Skill map", opGraph(r)),
    section("Skills", bindRows.length
      ? `<p class="note">Grouped by department. Each skill links to its page and to a file an agent can load.</p>${skillsByDepartment}`
      : ""),
    section("Org chart", orgChart(r.org)),
    section("Metrics", table(["metric", "unit", "direction", "attached to"], metricRows)),
    countryLayers ? section("Country layers", countryLayers) : "",
    r.supply_chain ? section(
      "Supply chain",
      `<p>Buys from ${links(r.supply_chain.buys_from) || "none"}. Sells to ${links(r.supply_chain.sells_to) || "none"}.</p>` +
      ([...(r.supply_chain.buys_from ?? []), ...(r.supply_chain.sells_to ?? [])].some((id) => !nodes.has(id))
        ? `<p class="note">Names without links are external counterparties that are not yet modeled as SMBwiki entities.</p>`
        : ""),
    ) : "",
    r.products?.length ? section("Equipment and products handled", `<p>${r.products.map((x) => `<a href="https://bomwiki.com/item/${x}/">${esc(x.replace(/-/g, " "))}</a>`).join(", ")} <span class="muted">(on bomwiki)</span></p>`) : "",
    deltaSection(r),
  ].join("\n");
  const authoredTitle = normalizeTitleBrand(r.seo?.title);
  const businessDescription = metaDescription(
    a ? `How ${aOrAn(r.name)} ${lowerName} works, what it takes to start one, and where the money is: revenue streams, margins, licenses, roles, and the skills it runs.` : "",
    r.abstract ? completeSentence(businessSummaryText) : businessSummaryText,
    `${r.name} operating model with skills, roles, documents, metrics, software, licenses, and relationships.`,
  );
  page({
    path: `/business/${r.id}/`,
    title: a
      ? businessTitle(r.name)
      : authoredTitle && authoredTitle.length <= 65
      ? authoredTitle
      : contextualTitle(
          abstractName,
          r.abstract ? "Shared Business Operating Model" : "How the Business Works",
        ),
    desc: businessDescription,
    h1: r.name,
    kicker: r.abstract ? "shared business operating model" : `business type${r.codes?.naics ? ` · US NAICS ${r.codes.naics}` : ""}`,
    body,
    yamlPath: `/definitions/businesses/${r.id}.yaml`,
    jsonPath: r.abstract ? null : `/api/def/${r.id}.json`,
    jsonld: {
      "@context": "https://schema.org", "@type": "Article",
      headline: r.abstract ? `${abstractName}: shared business operating model` : `${r.name}: how the business works`,
      description: businessDescription,
      url: `${SITE}/business/${r.id}/`,
      mainEntityOfPage: `${SITE}/business/${r.id}/`,
      about: { "@type": "Thing", name: r.name },
      ...(r.abstract ? {} : { isBasedOn: `${SITE}/api/def/${r.id}.json` }),
      isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
      dateModified: releaseDate,
      license: "https://opensource.org/license/mit",
    },
    indexable: true,
  });
}

// ---- SKILL.md: each process distilled into a loadable skill --------------
function skillMd(d) {
  const runners = bizOf(d.id, ["skill-binding"]);
  const L = [];
  L.push(`# ${d.name}`);
  L.push("");
  L.push(`A distilled business skill from SMBwiki.${d.department ? ` Department: ${DEPARTMENT_NAME.get(d.department) ?? d.department}.` : ""} ${runners.length ? `Held by ${runners.length} business type${runners.length === 1 ? "" : "s"} in the catalog. ` : ""}Source of truth: ${SITE}/skill/${d.id}/ (structured data: ${SITE}/definitions/skills/${d.id}.yaml).`);
  L.push("");
  L.push("## What this skill is");
  L.push("");
  L.push(String(d.summary ?? "").trim());
  if (d.article?.what) {
    L.push("");
    L.push(String(d.article.what).trim());
  }
  if (d.article?.why) {
    L.push("");
    L.push("## Why it matters");
    L.push("");
    L.push(String(d.article.why).trim());
  }
  if (d.tension) {
    L.push("");
    L.push("## The tension it manages");
    L.push("");
    L.push(String(d.tension).trim());
  }
  if (d.steps?.length) {
    L.push("");
    L.push("## Steps");
    L.push("");
    d.steps.forEach((s, i) => {
      const role = s.role ? ` _(${nodes.get(s.role)?.name ?? s.role})_` : "";
      const docs = [
        (s.consumes ?? []).length ? `consumes: ${s.consumes.join(", ")}` : "",
        (s.produces ?? []).length ? `produces: ${s.produces.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      L.push(`${i + 1}. **${s.name}.**${role} ${s.note ? String(s.note).trim() : ""}${docs ? ` (${docs})` : ""}`);
    });
  }
  if (d.failure_modes?.length) {
    L.push("");
    L.push("## Guardrails: how this fails");
    L.push("");
    for (const f of d.failure_modes)
      L.push(`- **${f.name}.** ${f.cost ?? ""} Early signal: ${f.signal ?? "none recorded"}`);
  }
  if (d.maturity?.length) {
    L.push("");
    L.push("## What good looks like");
    L.push("");
    for (const m of d.maturity) L.push(`- **${m.level}:** ${m.looks_like ?? ""}`);
  }
  if (d.competencies?.length) {
    L.push("");
    L.push("## Competencies involved");
    L.push("");
    for (const c of d.competencies)
      L.push(`- **${c.name}.** ${c.note ?? ""}`);
  }
  if (d.automation) {
    L.push("");
    L.push("## Automation boundary");
    L.push("");
    if (d.automation.now) L.push(`- Already automatable: ${d.automation.now}`);
    if (d.automation.human) L.push(`- Stays human: ${d.automation.human}`);
  }
  if (d.questions?.length) {
    L.push("");
    L.push("## Checks: questions that reveal how it's run");
    L.push("");
    for (const q of d.questions) L.push(`- ${q}`);
  }
  L.push("");
  L.push(`Documents: consumes ${(d.inputs ?? []).join(", ") || "none"}; produces ${(d.outputs ?? []).join(", ") || "none"}.`);
  L.push("");
  L.push(`MIT. From the open definitions at https://github.com/erphq/smbwiki.`);
  return L.join("\n") + "\n";
}

// ---- render: shared-node pages -------------------------------------------
const KICKER = { skill: "skill", role: "role", document: "document", metric: "metric", "software-category": "software category", license: "license", market: "market" };
const PAGE_CONTEXT = {
  skill: "Process and Controls",
  role: "Responsibilities and Workflows",
  document: "Purpose and Workflow",
  metric: "Formula and Benchmarks",
  "software-category": "Functions and Business Uses",
  license: "Scope and Requirements",
  market: "Buyer Context",
};
const PAGE_KICKER = {
  skill: "business skill",
  role: "role in small-business operations",
  document: "document in small-business operations",
  metric: "metric in small-business operations",
  "software-category": "software category for small businesses",
  license: "license or credential in a business operating model",
  market: "customer market in the SMBwiki graph",
};
const unique = (values) => [...new Set(values.filter(Boolean))];
const nodeSummary = (id) => completeSentence(
  nodes.get(id)?.data?.summary ??
    `${nodes.get(id)?.name ?? sentenceLabel(id)} in the SMBwiki operating-model graph.`,
);
const businessSummary = (id) => completeSentence(
  resolved.get(id)?.summary ?? `${resolved.get(id)?.name ?? sentenceLabel(id)} business operating model.`,
);
const entityContext = (n) => {
  const contexts = usedBy.get(n.id) ?? [];
  const businesses = n.label === "document" ? documentBusinesses(n.id) : bizOf(n.id);
  const skills = unique(contexts.map((context) => context.process));
  if (n.label === "skill")
    return `Within SMBwiki, this skill is part of ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"}. The page connects its steps, owners, documents, metrics, software, failure modes, and operating questions.`;
  if (n.label === "role")
    return `Within SMBwiki, this role appears in ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"} and is assigned to ${skills.length} ${skills.length === 1 ? "skill" : "skills"}. The relationships below show where the role sits and what work it owns.`;
  if (n.label === "document") {
    const producers = unique(graph.edges.filter((edge) => edge.type === "PRODUCES" && edge.to === n.id).map((edge) => edge.from));
    const consumers = unique(graph.edges.filter((edge) => edge.type === "CONSUMES" && edge.to === n.id).map((edge) => edge.from));
    return `Within SMBwiki, this document appears in ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"}. It is produced by ${producers.length} ${producers.length === 1 ? "skill" : "skills"} and consumed by ${consumers.length}, which places the record in its operating lifecycle.`;
  }
  if (n.label === "metric")
    return `Within SMBwiki, this metric is used by ${skills.length} ${skills.length === 1 ? "skill" : "skills"} across ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"}. Its unit, preferred direction, and business-level uses are listed below.`;
  if (n.label === "software-category")
    return `Within SMBwiki, this software category supports ${skills.length} ${skills.length === 1 ? "skill" : "skills"} across ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"}. The page shows the operational work the system category is expected to run.`;
  if (n.label === "license") {
    const licenseContexts = contexts.filter((context) => context.kind === "license" && !resolved.get(context.biz)?.abstract);
    const countries = unique(licenseContexts.map((context) => context.geo));
    return `Within SMBwiki, this license or credential applies to ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"} across ${countries.length} modeled ${countries.length === 1 ? "country layer" : "country layers"}. The dated applicability table provides operating context, not legal advice.`;
  }
  if (n.label === "market")
    return `Within SMBwiki, this market is served by ${businesses.length} concrete business ${businesses.length === 1 ? "model" : "models"}. The relationship map connects the customer type to the businesses and operating work that serve it.`;
  return "This page places the entity in the SMBwiki operating-model graph.";
};
const nodeDescriptionFallback = (n) => {
  const count = (n.label === "document" ? documentBusinesses(n.id) : bizOf(n.id)).length;
  if (n.label === "skill")
    return `${n.name}: process steps, controls, records, measures, and use across ${count} SMBwiki business models.`;
  if (n.label === "role")
    return `${n.name}: responsibilities, owned workflows, and use across ${count} modeled SMBwiki business types.`;
  if (n.label === "document")
    return `${n.name}: purpose, producing and consuming workflows, and use across ${count} modeled SMBwiki business types.`;
  if (n.label === "metric")
    return `${n.name}: definition, unit, preferred direction, measured workflows, and use across ${count} SMBwiki business models.`;
  if (n.label === "software-category")
    return `${n.name}: supported workflows and use across ${count} modeled SMBwiki business types.`;
  if (n.label === "license")
    return `${n.name}: jurisdiction, scope, dated applicability, and use across ${count} modeled SMBwiki business types.`;
  if (n.label === "market")
    return `${n.name}: buyer context and the ${count} modeled SMBwiki business types that serve this market.`;
  return `${n.name}: definition, operating context, and relationships in the SMBwiki graph.`;
};
const nodeJsonLd = (n, description) => n.label === "skill" || (n.label === "metric" && n.data.article)
  ? {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: n.label === "skill" ? `${processName(n.name)}: steps, records, and controls` : `${n.name}: formula, benchmarks, and what moves it`,
      description,
      url: `${SITE}${href(n.id)}`,
      mainEntityOfPage: `${SITE}${href(n.id)}`,
      about: { "@type": "Thing", name: n.name },
      isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
      dateModified: releaseDate,
      license: "https://opensource.org/license/mit",
    }
  : {
      "@context": "https://schema.org",
      "@type": "DefinedTerm",
      name: n.name,
      description,
      url: `${SITE}${href(n.id)}`,
      termCode: n.id,
      inDefinedTermSet: {
        "@type": "DefinedTermSet",
        name: "SMBwiki operating-model graph",
        url: `${SITE}/graph/`,
      },
    };

// A metric page is an article first: what the number is, how to compute it,
// published ranges with their sources, what moves it, and how it is misread.
// Headings name the metric so each section answers the query it is asked as.
const metricArticle = (n, a) => {
  const lower = n.name.toLowerCase();
  const bullets = (items) => `<ul class="article-list">${items.map((item) => `<li><strong>${esc(item.name)}.</strong> ${esc(String(item.note).trim())}</li>`).join("")}</ul>`;
  const benchmarks = a.benchmarks?.length
    ? table(["business type or scope", "typical value", "what it assumes", "source"],
        a.benchmarks.map((b) => [esc(b.scope), esc(b.value), esc(b.note ?? ""), `<a href="${escAttr(b.source)}">${esc(b.source_name)}</a>`]))
    : "";
  return [
    `<p>${esc(String(a.what).trim())}</p>`,
    section(`How to calculate ${lower}`,
      `<p class="formula">${esc(a.formula)}</p><p>${esc(String(a.how_to_calculate).trim())}</p><h3>Worked example</h3><p>${esc(String(a.example).trim())}</p>`),
    section(`${n.name} benchmarks by business type`,
      benchmarks +
      (a.benchmark_note ? `<p>${esc(String(a.benchmark_note).trim())}</p>` : "") +
      `<p class="note">Published figures for the scope shown, read from the linked source on the release date. Use them to set a direction, then judge your own number against your own trend and definition.</p>`),
    section(`What moves ${lower}`, bullets(a.drivers)),
    section(`How to improve ${lower}`, bullets(a.improve)),
    section("Measurement mistakes", bullets(a.pitfalls)),
  ].join("\n");
};

for (const n of graph.nodes) {
  if (n.label === "business") continue;
  const d = n.data;
  const context = entityContext(n);
  const description = metaDescription(
    n.label === "metric" && d.article
      ? `How to calculate ${n.name.toLowerCase()}, typical ranges by business type, what moves it, and how ${bizOf(n.id).length} SMBwiki business types track it.`
      : n.label === "skill" && d.article
        ? `How the ${processName(n.name).toLowerCase()} runs: the steps, who owns each, the records it moves, how it fails, and how ${bizOf(n.id, ["skill-binding"]).length} business types use it.`
        : "",
    d.summary,
    nodeDescriptionFallback(n),
  );
  const parts = [
    (d.summary ? `<p>${esc(d.summary.trim())}</p>` : ""),
    `<p class="entity-context">${esc(context)}</p>`,
  ];
  if (n.label === "metric" && d.article) parts.push(metricArticle(n, d.article));
  if (n.label === "skill" && d.article) {
    const lowerProcess = processName(n.name).toLowerCase();
    const notes = (d.steps ?? []).filter((s) => s.note).map((s) => `<li><strong>${esc(s.name)}.</strong> ${esc(String(s.note).trim())}</li>`).join("");
    parts.push(`<p>${esc(String(d.article.what).trim())}</p>`);
    parts.push(section(`Why the ${lowerProcess} matters`, `<p>${esc(String(d.article.why).trim())}</p>`));
    parts.push(section(`How to run the ${lowerProcess}`,
      `<p>${esc(String(d.article.how).trim())}</p>` + (d.steps?.length ? stepFlow(d) : "") + (notes ? `<ol class="step-notes">${notes}</ol>` : "")));
    parts.push(section("Controls and records", `<ul class="article-list">${(d.article.controls ?? []).map((c) => `<li><strong>${esc(c.name)}.</strong> ${esc(String(c.note).trim())}</li>`).join("")}</ul>`));
  }
  parts.push(section("Relationship map", relationshipGraph(n)));
  if (n.label === "skill") {
    mkdirSync(join(DIST, "skill"), { recursive: true });
    writeFileSync(join(DIST, "skill", `${n.id}.md`), skillMd(d));
    parts.push(`<p class="skill-line">This skill is the steps, guardrails, and checks to run ${esc(n.name.toLowerCase())} anywhere it appears. <a href="/skill/${n.id}.md">Load it as SKILL.md</a>.</p>`);
    if (d.steps?.length && !d.article) {
      const notes = d.steps.filter((s) => s.note).map((s) => `<li><strong>${esc(s.name)}.</strong> ${esc(String(s.note).trim())}</li>`).join("");
      parts.push(section("How it runs", stepFlow(d) + (notes ? `<ol class="step-notes">${notes}</ol>` : "")));
    }
    if (d.tension) parts.push(section("The tension", `<p>${esc(String(d.tension).trim())}</p>`));
    const ctx = contextDiagram(d);
    if (ctx) parts.push(section("In context", ctx + `<p class="figcaption">Where the documents come from and where they go, computed across every business in the catalog.</p>`));
    if (d.failure_modes?.length)
      parts.push(section("Failure modes", table(["failure", "what it costs", "early signal"],
        d.failure_modes.map((f) => [`<strong>${esc(f.name)}</strong>`, esc(f.cost ?? ""), esc(f.signal ?? "")]))));
    if (d.maturity?.length)
      parts.push(section("What good looks like", table(["", "you'd observe"],
        d.maturity.map((m) => [`<strong>${esc(m.level)}</strong>`, esc(m.looks_like ?? "")]))));
    if (d.competencies?.length)
      parts.push(section("Competencies involved", `<ul>${d.competencies.map((s) => `<li><strong>${esc(s.name)}.</strong> ${esc(s.note ?? "")}</li>`).join("")}</ul>`));
    if (d.automation)
      parts.push(section("What automates", `<p><strong>Already automatable:</strong> ${esc(d.automation.now ?? "")}</p><p><strong>Stays human:</strong> ${esc(d.automation.human ?? "")}</p>`));
    if (d.questions?.length)
      parts.push(section("Questions that reveal how it's run", `<ul>${d.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`));
    parts.push(section("Documents", `<p>Consumes ${links(d.inputs) || "none"}. Produces ${links(d.outputs) || "none"}.</p>`));
    const rows = (usedBy.get(n.id) ?? []).filter((c) => c.kind === "skill-binding" && !resolved.get(c.biz).abstract)
      .map((c) => [link(c.biz), c.geo ? esc(countryName(c.geo)) : "core", links(c.binding.roles), links(c.binding.metrics), links(c.binding.software)]);
    parts.push(section("Run by", table(["business", "layer", "owned by", "measured by", "software"], rows)));
  } else if (n.label === "metric") {
    const measuredBy = unique((usedBy.get(n.id) ?? [])
      .filter((context) => context.kind === "binding-metric" && !resolved.get(context.biz)?.abstract)
      .map((context) => context.process));
    parts.push(`<p class="muted">${esc(d.unit ?? "")}${d.direction ? ` · ${d.direction} is better` : ""}</p>`);
    if (!d.article) parts.push(section(
      "How to read it",
      `<p>${esc(n.name)} is tracked in ${esc(d.unit ?? "the unit recorded by the operating business")}. ${d.direction === "lower" ? "Lower values generally indicate improvement" : d.direction === "higher" ? "Higher values generally indicate improvement" : "Interpret the direction against the operating target"}. Compare values using the same definition, scope, and reporting period.</p>`,
    ));
    parts.push(section("Measured through", table(
      ["skill", "operating context", "business models"],
      measuredBy.map((skill) => [link(skill), esc(nodeSummary(skill)), `${bizOf(skill, ["skill-binding"]).length}`]),
    )));
    parts.push(section("Measured in", table(["business", "skill", "layer"], (usedBy.get(n.id) ?? []).filter((c) => c.kind === "binding-metric" && !resolved.get(c.biz).abstract).map((c) => [link(c.biz), link(c.process), c.geo ? esc(countryName(c.geo)) : "core"]))));
  } else if (n.label === "document") {
    const prod = graph.edges.filter((e) => e.type === "PRODUCES" && e.to === n.id).map((e) => e.from);
    const cons = graph.edges.filter((e) => e.type === "CONSUMES" && e.to === n.id).map((e) => e.from);
    parts.push(section("Lifecycle", `<p>Produced by ${links(prod) || "none"}. Consumed by ${links(cons) || "none"}.</p>`));
    parts.push(section("Workflow context", table(
      ["stage", "skill", "what the work covers", "business models"],
      [
        ...unique(prod).map((skill) => ["produced by", link(skill), esc(nodeSummary(skill)), `${bizOf(skill, ["skill-binding"]).length}`]),
        ...unique(cons).map((skill) => ["consumed by", link(skill), esc(nodeSummary(skill)), `${bizOf(skill, ["skill-binding"]).length}`]),
      ],
    )));
    parts.push(section("Appears in", `<p>${links(documentBusinesses(n.id)) || "none"}</p>`));
  } else if (n.label === "role") {
    parts.push(section("Appears in", `<p>${links(bizOf(n.id, ["org", "binding-role"])) || "none"}</p>`));
    const owns = [...new Set((usedBy.get(n.id) ?? []).filter((c) => c.kind === "binding-role").map((c) => c.process))];
    if (owns.length) parts.push(section("Responsibilities and workflows", table(
      ["skill", "what the work covers", "department", "business models"],
      owns.map((skill) => [
        link(skill),
        esc(nodeSummary(skill)),
        esc(DEPARTMENT_NAME.get(nodes.get(skill)?.data?.department) ?? sentenceLabel(nodes.get(skill)?.data?.department ?? "operations")),
        `${bizOf(skill, ["skill-binding"]).length}`,
      ]),
    )));
  } else if (n.label === "software-category") {
    const supportedSkills = unique((usedBy.get(n.id) ?? [])
      .filter((context) => context.kind === "binding-software" && !resolved.get(context.biz)?.abstract)
      .map((context) => context.process));
    parts.push(section("Supported workflows", table(
      ["skill", "what the work covers", "business models"],
      supportedSkills.map((skill) => [link(skill), esc(nodeSummary(skill)), `${bizOf(skill, ["skill-binding"]).length}`]),
    )));
    parts.push(section("Runs", table(["business", "skill", "layer"], (usedBy.get(n.id) ?? []).filter((c) => c.kind === "binding-software" && !resolved.get(c.biz).abstract).map((c) => [link(c.biz), link(c.process), c.geo ? esc(countryName(c.geo)) : "core"]))));
    parts.push(`<p class="muted">Typical system area: ${esc(sentenceLabel(d.erpai_category ?? "none"))}</p>`);
  } else if (n.label === "license") {
    parts.push(`<p class="muted">jurisdiction: ${esc(d.jurisdiction ?? "none")}</p>`);
    const licenseRows = (usedBy.get(n.id) ?? [])
      .filter((context) => context.kind === "license" && !resolved.get(context.biz).abstract)
      .map((context) => [
        link(context.biz),
        esc(REQUIREMENT_NAME[context.entry.requirement] ?? sentenceLabel(context.entry.requirement)),
        esc(countryName(context.geo)),
        esc(context.entry.condition),
        `<time datetime="${esc(context.entry.as_of)}">${esc(context.entry.as_of)}</time>`,
      ]);
    parts.push(section(
      "Applies to",
      table(["business", "status", "country", "scope", "source checked"], licenseRows) +
      `<p class="note">These dated states describe the modeled business context, not a nationwide legal conclusion. Confirm current requirements with the authority for the operating jurisdiction.</p>`,
    ));
  } else if (n.label === "market") {
    const sellers = bizOf(n.id, ["sells-to"]);
    parts.push(section("Businesses serving this market", table(
      ["business type", "operating context"],
      sellers.map((business) => [link(business), esc(businessSummary(business))]),
    )));
  }
  if (n.label === "skill") {
    mkdirSync(join(DIST, "process", n.id), { recursive: true });
    writeFileSync(join(DIST, "process", n.id, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=/skill/${n.id}/"><link rel="canonical" href="${SITE}/skill/${n.id}/"><a href="/skill/${n.id}/">Moved to /skill/${n.id}/</a>`);
  }
  page({
    path: `/${SEG[n.label]}/${n.id}/`,
    title: n.label === "skill" && d.article ? skillTitle(n.name) : contextualTitle(n.name, PAGE_CONTEXT[n.label]),
    desc: description,
    h1: n.label === "skill" && d.article ? processName(n.name) : n.name,
    kicker: n.label === "skill" && d.department
      ? `${PAGE_KICKER[n.label]} · ${esc(DEPARTMENT_NAME.get(d.department) ?? d.department)}`
      : PAGE_KICKER[n.label],
    body: parts.join("\n"),
    yamlPath: `/definitions/${DEF_DIR[n.label]}/${n.id}.yaml`,
    jsonld: nodeJsonLd(n, description),
    indexable: true,
  });
  for (const alias of d.aliases ?? []) {
    const target = `/${SEG[n.label]}/${n.id}/`;
    const aliasDir = join(DIST, SEG[n.label], alias);
    mkdirSync(aliasDir, { recursive: true });
    writeFileSync(
      join(aliasDir, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">` +
      `<meta http-equiv="refresh" content="0; url=${target}">` +
      `<link rel="canonical" href="${SITE}${target}">` +
      `<a href="${target}">Moved to ${target}</a>`,
    );
  }
}

// ---- homepage ------------------------------------------------------------
// How many concrete business types run each skill. Drives the shared/specific
// split below the catalog and the example picks in the lead.
const skillReach = new Map();
for (const r of concrete)
  for (const id of new Set(allSkillBindings(r).map(({ binding }) => binding.ref)))
    skillReach.set(id, (skillReach.get(id) ?? 0) + 1);
const nodeName = (id) => nodes.get(id)?.name ?? sentenceLabel(id);
const streamLabel = (r) => sentenceLabel((r.revenue_model ?? [])[0]?.id ?? "").toLowerCase();

const businessesByGroup = new Map(CATALOG_GROUPS.map(([id]) => [id, []]));
for (const r of concrete)
  (businessesByGroup.get(r.catalog_group) ?? businessesByGroup.get("professional-financial")).push(r);
const GROUP_LABEL = new Map(CATALOG_GROUPS);
// What people call these businesses when they are not reading a catalog.
// Search keys only. Never rendered, and never a substitute for the real name.
const SEARCH_ALIASES = {
  "auto-repair-shop": "mechanic garage",
  "child-care-center": "daycare nursery preschool",
  "coffee-shop": "cafe espresso",
  "assisted-living-facility": "nursing home eldercare",
  "law-firm": "lawyer attorney solicitor legal",
  "primary-care-practice": "doctor physician gp family medicine",
  "veterinary-clinic": "vet animal hospital",
  "optometry-practice": "optician eye doctor optometrist",
  "real-estate-brokerage": "realtor estate agent",
  "moving-company": "movers removals",
  "general-freight-trucking-company": "trucker haulage",
  "local-delivery-service": "courier last mile",
  "employment-agency": "recruiter staffing headhunter",
  "funeral-home": "undertaker mortuary",
  "janitorial-service": "cleaner cleaning company",
  "pest-control-company": "exterminator",
  "gym": "fitness center centre health club",
  "day-spa": "spa",
  "hair-salon": "hairdresser stylist",
  "tax-preparation-service": "tax preparer",
  "managed-it-service-provider": "it support msp computer repair",
  "custom-software-consultancy": "software agency developers",
  "used-car-dealership": "car dealer",
  "new-car-dealership": "car dealer",
  "limited-service-restaurant": "fast food takeaway",
  "full-service-restaurant": "restaurant",
  "retail-bakery": "baker",
  "physical-therapy-clinic": "physio physiotherapy",
  "mental-health-practice": "therapist counselor counsellor psychologist",
  "medical-laboratory": "lab testing",
};
// Filter key: everything a reader might type. Name, sector, NAICS, what it
// sells, and every skill, record, and measure it carries, so "dispatch",
// "scrap rate", and "238220" all find rows.
const filterKey = (r) => {
  const bindings = allSkillBindings(r).map(({ binding }) => binding);
  const parts = [
    r.name,
    GROUP_LABEL.get(r.catalog_group) ?? "",
    r.codes?.naics ?? "",
    SEARCH_ALIASES[r.id] ?? "",
    ...(r.revenue_model ?? []).map((m) => m.id),
    ...new Set(bindings.flatMap((b) => [
      b.ref,
      ...(b.documents ?? []),
      ...(b.metrics ?? []),
      ...(b.roles ?? []),
    ]).map(nodeName)),
  ];
  return [...new Set(parts.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" "))]
    .filter(Boolean)
    .join(" ");
};
const businessCatalog = CATALOG_GROUPS.map(([id, label]) => {
  const items = businessesByGroup.get(id).sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) return "";
  const rows = items.map((r) => {
    const skills = new Set(allSkillBindings(r).map(({ binding }) => binding.ref)).size;
    return `<li data-k="${esc(filterKey(r))}"><a href="/business/${r.id}/">${esc(r.name)}</a><span>${skills} skills · ${esc(streamLabel(r))}</span></li>`;
  }).join("");
  return `<section class="business-sector"><h3>${esc(label)}</h3><ul class="business-list">${rows}</ul></section>`;
}).join("");
const PLURAL = { skill: "Skills", role: "Roles", document: "Documents", metric: "Metrics", "software-category": "Software categories", license: "Licenses", market: "Customer markets" };
const USE_KINDS = {
  skill: ["skill-binding"], role: ["org", "binding-role"], document: ["binding-document"],
  metric: ["binding-metric"], "software-category": ["binding-software"], license: ["license"],
  market: ["sells-to"],
};
const kindEntries = (label, seg) => {
  const items = graph.nodes.filter((n) => n.label === label).sort((a, b) => a.name.localeCompare(b.name));
  const rows = items.map((n) => {
    const uses = bizOf(n.id, USE_KINDS[label]).length;
    return `<li><a href="/${seg}/${n.id}/">${esc(n.name)}</a>${uses > 1 ? ` <span class="usecount">${uses}</span>` : ""}</li>`;
  }).join("");
  return { items, rows };
};
// One index page per node kind. The homepage used to carry all seven lists,
// about 670 links, which flattened the link graph so no page inherited
// weight. Now the homepage links the seven pages and each page carries one
// list, with prose that explains what the counts mean.
const KIND_INDEXES = [
  ["skill", "skill"], ["role", "role"], ["document", "document"], ["metric", "metric"],
  ["software-category", "software"], ["license", "license"], ["market", "market"],
];
const SINGULAR = { skill: "skill", role: "role", document: "document", metric: "metric", "software-category": "software category", license: "license", market: "customer market" };
const KIND_INTRO = {
  skill: "A skill is one piece of work a business runs: the steps, the roles that own each step, the records it takes in and produces, and how the result is judged. Every skill page is also published as a plain Markdown file an AI agent can load.",
  role: "A role is a seat in a business that holds skills. The same role name in two business types points at the same node, so each page shows every trade that seat appears in and the skills it owns there.",
  document: "A document is a record a skill takes in or produces: the order, the estimate, the inspection report, the invoice. Each page shows which skills move it and which business types keep it.",
  metric: "A metric is how a business judges a piece of work. Each page defines the measure, shows the skills it judges, and lists the business types that track it.",
  "software-category": "A software category is the kind of system a skill runs on, named by function rather than by vendor. Each page shows the skills that depend on it and the business types that run it.",
  license: "A license is a permit or registration a business type must hold before it can operate. Each page names the jurisdiction and the business types bound to it.",
  market: "A customer market is who a business type sells to. Each page lists the business types that serve that market and the revenue mechanics they use.",
};
const kindIndexPage = (label, seg) => {
  const { items, rows } = kindEntries(label, seg);
  const plural = PLURAL[label];
  const lower = plural.toLowerCase();
  page({
    path: `/${seg}/`,
    title: `All ${items.length} ${lower} across ${concrete.length} business types | SMBwiki`,
    h1: plural,
    kicker: `${items.length} ${lower} in the operating-model graph`,
    desc: `An alphabetical index of the ${items.length} ${lower} in the SMBwiki operating-model graph, each marked with how many of the ${concrete.length} business types use it.`,
    jsonld: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${plural} on SMBwiki`,
      description: `Index of the ${items.length} ${lower} used by ${concrete.length} business types.`,
      url: `${SITE}/${seg}/`,
      isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
      dateModified: releaseDate,
    },
    indexable: true,
    body: `<p>${KIND_INTRO[label]}</p>
<p>A number after a name shows how many of the ${concrete.length} business types use that ${SINGULAR[label]}. A name without a number belongs to one business type. Every entry is a page with its own relationship map.</p>
<ul class="index-cols">${rows}</ul>`,
  });
};
// The lead opens on one real business rather than describing what a page
// contains. Every name, count, and link below is read from the definition.
const LEAD_ID = "machine-shop";
const lead = resolved.get(LEAD_ID);
const leadBindings = [...new Map(allSkillBindings(lead).map(({ binding }) => [binding.ref, binding])).values()]
  .sort((a, b) => (skillReach.get(a.ref) ?? 0) - (skillReach.get(b.ref) ?? 0));
const leadOwned = leadBindings.find((b) => b.roles?.length && b.documents?.length && b.metrics?.length);
const leadRun = leadBindings.find((b) => b !== leadOwned && b.software?.length && b.metrics?.length);
const leadLicenses = allLicenseBindings(lead);
const leadDocuments = new Set(leadBindings.flatMap((b) => b.documents ?? []));
const leadRoles = new Set();
(function walkOrg(ns) { ns?.forEach((n) => { leadRoles.add(n.role); walkOrg(n.reports); }); })(lead.org);
const leadHead = lead.org?.[0]?.role;
const COUNTRY_ARTICLE = { us: "the " };
// How many concrete business types touch each shared node. Used to pick the
// most characteristic role, record, and measure a business has.
const shareCount = (kinds) => (id) => bizOf(id, kinds).length;
const rarest = (ids, kinds, used) =>
  [...(ids ?? [])]
    .filter((id) => !used?.has(id))
    .sort((a, b) => shareCount(kinds)(a) - shareCount(kinds)(b) || a.localeCompare(b))[0];
const softwareLink = (id) => {
  const name = nodes.get(id)?.name ?? "";
  return /software|system|platform/i.test(name) ? linkLower(id) : `${linkLower(id)} software`;
};
// The first role in a binding is the one that owns the skill. Records and
// measures carry no order, so show the ones most particular to this trade,
// and never name the same measure twice.
const leadRecord = leadOwned && rarest(leadOwned.documents, ["binding-document"]);
const leadMeasure = leadOwned && rarest(leadOwned.metrics, ["binding-metric"]);
const leadSecondMeasure = leadRun
  && (rarest(leadRun.metrics, ["binding-metric"], new Set([leadMeasure])) ?? leadRun.metrics[0]);
const leadSentences = [
  `Take a ${linkLower(LEAD_ID)}.`,
  leadOwned
    ? `${link(leadOwned.ref)} belongs to the ${linkLower(leadOwned.roles[0])}, records a ${linkLower(leadRecord)}, and is measured by ${linkLower(leadMeasure)}.`
    : "",
  leadRun
    ? `${link(leadRun.ref)} runs on ${softwareLink(rarest(leadRun.software, ["binding-software"]))} and answers for ${linkLower(leadSecondMeasure)}.`
    : "",
  // "Skill" is this site's term of art. Define it in the sentence where a
  // reader first meets it, from the examples just shown.
  leadOwned ? "Each of those is a skill: a named piece of work with an owner, records, and a measure." : "",
  `${sentenceLabel(countWord(leadBindings.length))} skills in all, ${countWord(leadRoles.size)} roles under ${leadHead ? `an ${linkLower(leadHead)}` : "the owner"}, and ${countWord(leadDocuments.size)} documents between them.`,
  // Licensed trades say so. Trades that need no license do not pretend to.
  leadLicenses.length
    ? `${sentenceLabel(countWord(leadLicenses.length))} ${leadLicenses.length === 1 ? "license" : "licenses"} to hold in ${COUNTRY_ARTICLE[leadLicenses[0].geo] ?? ""}${countryName(leadLicenses[0].geo)}.`
    : "",
].filter(Boolean).join(" ");

// Shared and specific work: the shape of the corpus, counted from bindings.
const SPINE_ROWS = 6;
const sharedRows = [...skillReach]
  .sort((a, b) => b[1] - a[1] || nodeName(a[0]).localeCompare(nodeName(b[0])))
  .slice(0, SPINE_ROWS)
  .map(([id, n]) => `<li>${link(id)} <span>${n} of ${concrete.length}</span></li>`)
  .join("");
const soleUse = new Map(); // skill run by exactly one business type -> that business
for (const r of concrete)
  for (const id of new Set(allSkillBindings(r).map(({ binding }) => binding.ref)))
    if (skillReach.get(id) === 1) soleUse.set(id, r);
// One per sector, so the sample spans the catalog rather than one vertical.
const specificRows = CATALOG_GROUPS.map(([group]) =>
  [...soleUse].filter(([, r]) => r.catalog_group === group)
    .sort((a, b) => nodeName(a[0]).localeCompare(nodeName(b[0])))[0],
).filter(Boolean).slice(0, SPINE_ROWS)
  .map(([id, r]) => `<li>${link(id)} <span>${link(r.id)}</span></li>`)
  .join("");
// Skills are the machine-readable surface. Say so plainly, and show the
// example rather than describing it. Counts come from the generated files.
const AI_EXAMPLE = leadOwned?.ref ?? "production-control";
const aiExampleName = nodeName(AI_EXAMPLE);
const aiExampleReach = skillReach.get(AI_EXAMPLE) ?? 0;
// A magazine pull-out placed after the catalog: readers get the whole
// human path first, and this box gathers everything machine-facing.
const PASTE = `Read ${SITE}/skill/${AI_EXAMPLE}.md and follow it. Then: set up ${aiExampleName.toLowerCase()} for my business.`;
const skillsAndAi = `<aside class="skillbox" id="skills-and-ai" aria-labelledby="skillbox-title">
      <div class="skillbox-text">
        <h2 id="skillbox-title">Use it with an AI agent</h2>
        <p>A skill records how a piece of work is done: the steps and who runs each, the records in and out, how the work fails, and what stays human. A prompt asks for a result; a skill carries the process used to produce and check it. All ${skillReach.size} are published as plain Markdown files, free to read without an account.</p>
        <p class="note">Business skills live here. Skills for software development live at <a href="https://sphinxstack.com/skills/">sphinxstack</a>.</p>
      </div>
      <div class="skillbox-try">
        <p class="skillbox-sub">Paste into any agent</p>
        <p class="paste"><code>${esc(PASTE)}</code></p>
        <p>That one is ${link(AI_EXAMPLE)}. <a href="/skill/${AI_EXAMPLE}.md">Read the file</a>, <a href="/business/${LEAD_ID}/#skills">see a full set by department</a>, or take <a href="/llms.txt">llms.txt</a>. Every page is built from a <a href="/definitions/businesses/${LEAD_ID}.yaml">YAML definition</a> in the <a href="https://github.com/erphq/smbwiki">open-source repo</a>.</p>
      </div>
    </aside>`;

const sharedWork = `<h2 id="shared-work">shared and specific work</h2>
    <p>The ${concrete.length} business types run ${skillReach.size} distinct skills between them. Most of that work belongs to one trade: ${soleUse.size} of those skills appear in a single business type. What they share is the back office.</p>
    <div class="split">
      <section><h3>Run by the most business types</h3><ul class="tally">${sharedRows}</ul></section>
      <section><h3>Run by one business type</h3><ul class="tally">${specificRows}</ul></section>
    </div>`;

page({
  path: "/",
  title: "SMBwiki: how businesses work",
  desc: `Operating models for ${concrete.length} familiar business types, covering revenue, skills, roles, documents, metrics, software, licenses, and supply chains.`,
  jsonld: {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "SMBwiki",
    description: `A free encyclopedia of how ${concrete.length} small-business types work, built from one connected operating-model graph.`,
    url: SITE,
    dateModified: releaseDate,
  },
  bare: true,
  body: [
    `<div class="home-lead">
      <h1>How businesses work</h1>
      <p class="deck">Operating models for ${concrete.length} familiar business types.</p>
      <div class="home-brief">
        <div class="home-copy">
          <p>${leadSentences}</p>
          <p class="thesis">All ${concrete.length} business types are documented that way. Every skill is also published as a plain-text file <a href="#skills-and-ai">any AI agent can load</a>.</p>
        </div>
        <ul class="contents">
          <li><a href="#business-types">Browse the catalog</a></li>
          <li><a href="/business/${LEAD_ID}/">Read an example business</a></li>
          <li><a href="#shared-work">See what businesses share</a></li>
          <li><a href="#skills-and-ai">Use it with an AI agent</a></li>
          <li><a href="#index">Index by kind</a></li>
        </ul>
      </div>
    </div>`,
    `<h2 id="business-types">business types</h2>
     <div class="catalog-filter" hidden>
       <label for="catalog-q">Filter</label>
       <input id="catalog-q" type="search" autocomplete="off" spellcheck="false"
              placeholder="name, skill, record, measure, or NAICS code">
       <p class="filter-hint">Try <button type="button" data-q="plumber">plumber</button>, <button type="button" data-q="pizzeria">pizzeria</button>, or <button type="button" data-q="scrap rate">scrap rate</button>.</p>
     </div>
     <p class="filter-status" role="status" aria-live="polite" hidden></p>
     <div class="business-sectors">${businessCatalog}</div>
     <p class="filter-empty" hidden>No business type matches that.</p>
     <script src="${CATALOG_HREF}" defer></script>`,
    sharedWork,
    skillsAndAi,
    `<h2 id="index">index</h2>
     <p>Every node in the graph has its own page. The seven indexes list them by kind, each name marked with how many of the ${concrete.length} business types use it.</p>
     <ul class="kind-index">${KIND_INDEXES.map(([label, seg]) => `<li><a href="/${seg}/">${esc(PLURAL[label])}</a> <span class="usecount">${graph.nodes.filter((n) => n.label === label).length}</span></li>`).join("")}<li><a href="/kpis/">KPIs by sector</a> <span class="usecount">${CATALOG_GROUPS.length}</span></li></ul>`,
  ].join("\n"),
  indexable: true,
});

for (const [label, seg] of KIND_INDEXES) kindIndexPage(label, seg);

// ---- sector KPI pages ----------------------------------------------------
// One page per catalog group: the metrics its business types track, ranked
// by how many of them use each. Generated from the bindings, so the counts
// and the skill links cannot drift from the definitions.
const kpiPath = (group) => `/kpis/${group}/`;
const firstSentence = (text) => descriptionSentences(text ?? "")[0] ?? "";
const sectorKpis = (group) => {
  const members = businessesByGroup.get(group).sort((a, b) => a.name.localeCompare(b.name));
  const uses = new Map();
  for (const r of members)
    for (const { binding } of allSkillBindings(r))
      for (const m of binding.metrics ?? []) {
        if (!nodes.get(m)) continue;
        if (!uses.has(m)) uses.set(m, { businesses: new Set(), skills: new Set() });
        uses.get(m).businesses.add(r.id);
        uses.get(m).skills.add(binding.ref);
      }
  const rows = [...uses].sort((a, b) =>
    b[1].businesses.size - a[1].businesses.size || nodeName(a[0]).localeCompare(nodeName(b[0])));
  return { members, rows };
};
const sectorSummaries = [];
for (const [group, label] of CATALOG_GROUPS) {
  const { members, rows } = sectorKpis(group);
  const lower = label.toLowerCase();
  const threshold = Math.max(2, Math.ceil(members.length / 3));
  const shared = rows.filter(([, u]) => u.businesses.size >= threshold);
  const specific = rows.filter(([, u]) => u.businesses.size < threshold);
  const tableFor = (list) => list.length
    ? table(["metric", "what it measures", "unit", "business types", "measured by"], list.map(([m, u]) => {
        const d = nodes.get(m).data;
        const skills = [...u.skills];
        return [
          link(m),
          esc(firstSentence(d.article?.what ?? d.summary)),
          esc(d.unit ?? ""),
          `${u.businesses.size} of ${members.length}`,
          links(skills.slice(0, 3)) + (skills.length > 3 ? ` and ${skills.length - 3} more` : ""),
        ];
      }))
    : "";
  sectorSummaries.push({ group, label, members: members.length, metrics: rows.length });
  page({
    path: kpiPath(group),
    title: `${label} KPIs and metrics | SMBwiki`,
    h1: `${label} KPIs`,
    kicker: `${rows.length} metrics across ${members.length} business types`,
    desc: `The ${rows.length} metrics that the ${members.length} business types in ${lower} track, ranked by how many of them use each, with the skills each one measures.`,
    jsonld: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${label} KPIs`,
      description: `Metrics tracked by the ${members.length} ${lower} business types on SMBwiki.`,
      url: `${SITE}${kpiPath(group)}`,
      isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
      dateModified: releaseDate,
    },
    indexable: true,
    body: `<p>${esc(label)} covers ${members.length} business types on SMBwiki: ${links(members.map((r) => r.id))}. Between them they track ${rows.length} distinct metrics. A KPI here is a metric bound to a skill inside a business definition, so every row below names the work it judges, and every count says how many of the ${members.length} types track it.</p>
<p>The metrics most of the sector shares are the ones with published benchmarks and the ones a lender or a buyer asks for first. The metrics specific to one or two business types are the operating numbers that identify the trade. Each metric page gives the formula, the published ranges with their sources, what moves the number, and the measurement mistakes to avoid.</p>
${section(`Metrics most ${lower} businesses track`, tableFor(shared))}
${section(`Metrics specific to a few ${lower} business types`, tableFor(specific))}
<p class="note">Every metric on SMBwiki is listed in the <a href="/metric/">metric index</a>. Other sectors: ${CATALOG_GROUPS.filter(([g]) => g !== group).map(([g, l]) => `<a href="${kpiPath(g)}">${esc(l)}</a>`).join(", ")}.</p>`,
  });
}
page({
  path: "/kpis/",
  title: "KPIs by sector: what each trade measures | SMBwiki",
  h1: "KPIs by sector",
  kicker: `${CATALOG_GROUPS.length} sectors, ${concrete.length} business types`,
  desc: `Key performance indicators for ${CATALOG_GROUPS.length} small-business sectors, each page listing the metrics its business types track and the skills they measure.`,
  jsonld: {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "KPIs by sector",
    description: `Metrics tracked by ${concrete.length} small-business types, grouped into ${CATALOG_GROUPS.length} sectors.`,
    url: `${SITE}/kpis/`,
    isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
    dateModified: releaseDate,
  },
  indexable: true,
  body: `<p>A key performance indicator is a metric a business type tracks because a skill in its operating model is judged by it. SMBwiki binds ${graph.nodes.filter((n) => n.label === "metric").length} metrics to skills across ${concrete.length} business types, so the KPIs of a sector can be read straight from the definitions instead of from a generic list. Each sector page ranks its metrics by how many of its business types track them and links the skills each metric measures.</p>
<ul class="kind-index">${sectorSummaries.map((x) => `<li><a href="${kpiPath(x.group)}">${esc(x.label)} KPIs</a> <span class="usecount">${x.metrics} metrics, ${x.members} types</span></li>`).join("")}</ul>
<p>For one metric across every sector, use the <a href="/metric/">metric index</a>. Each metric page carries the formula, published benchmarks with their sources, what moves the number, and how it is misread.</p>`,
});

// ---- static passthroughs -------------------------------------------------
cpSync(join(ROOT, "definitions"), join(DIST, "definitions"), { recursive: true });
for (const n of graph.nodes) {
  if (n.label !== "skill" || !specializedSkillIds.has(n.id)) continue;
  writeFileSync(
    join(DIST, "definitions", "skills", `${n.id}.yaml`),
    yaml.dump(n.data, { lineWidth: 78, noRefs: true }),
  );
}
mkdirSync(join(DIST, "api", "def"), { recursive: true });
for (const r of concrete)
  cpSync(join(BUILD, "resolved", `${r.id}.json`), join(DIST, "api", "def", `${r.id}.json`));
cpSync(join(ROOT, "assets", "style.css"), join(DIST, "style.css"));
cpSync(join(ROOT, "assets", "favicon.svg"), join(DIST, "favicon.svg"));
// IndexNow key (Bing and partners). Served at /<key>.txt so submissions verify.
const indexNowKey = readFileSync(join(ROOT, "assets", "indexnow-key.txt"), "utf8").trim();
cpSync(join(ROOT, "assets", "indexnow-key.txt"), join(DIST, indexNowKey + ".txt"));
cpSync(join(ROOT, "assets", "card.png"), join(DIST, "static", "card.png"));
cpSync(join(ROOT, "assets", "opgraph.js"), join(DIST, "static", "opgraph.js"));
cpSync(join(ROOT, "assets", "catalog.js"), join(DIST, "static", "catalog.js"));
cpSync(join(ROOT, "assets", "vendor"), join(DIST, "static", "vendor"), { recursive: true });
const sitemapPaths = [
  "/",
  "/about/",
  "/graph/",
  "/research/",
  ...KIND_INDEXES.map(([, seg]) => `/${seg}/`),
  "/kpis/",
  ...CATALOG_GROUPS.map(([group]) => `/kpis/${group}/`),
  ...graph.nodes
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map((n) => href(n.id)),
];
const lastmod = releaseDate ? `<lastmod>${releaseDate}</lastmod>` : "";

// ---- project pages: about, graph, research -------------------------------
// Hand-written prose, but every count in it is computed from the corpus so
// these pages cannot drift from the data they describe.
const fmt = (n) => n.toLocaleString("en-US");
const releaseYear = releaseDate ? releaseDate.slice(0, 4) : "2026";
const REPO = "https://github.com/erphq/smbwiki";
const businessNodeCount = graph.nodes.filter((n) => n.label === "business").length;
const baseCount = businessNodeCount - concrete.length;
const edgeTypeCount = new Set(graph.edges.map((e) => e.type)).size;
const bindingCount = concrete.reduce((a, r) => a + allSkillBindings(r).length, 0);
const kindCount = (label) => graph.nodes.filter((n) => n.label === label).length;
const inheritsModel = (business, baseId) => {
  let parent = business.extends;
  while (parent) {
    if (parent === baseId) return true;
    parent = resolved.get(parent)?.extends;
  }
  return false;
};
const baseModelRows = [...resolved.values()]
  .filter((business) => business.abstract)
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((base) => {
    const descendants = concrete.filter((business) => inheritsModel(business, base.id));
    return [
      link(base.id),
      `${descendants.length} ${descendants.length === 1 ? "business type" : "business types"}`,
      descendants.slice(0, 3).map((business) => link(business.id)).join(", "),
    ];
  });
const reachValues = [...skillReach.values()];
const reachBucket = (lo, hi) => reachValues.filter((v) => v >= lo && v <= hi).length;
const deptSplit = new Map();
for (const n of graph.nodes)
  if (n.label === "skill")
    deptSplit.set(n.data.department, (deptSplit.get(n.data.department) ?? 0) + 1);
const deptLine = DEPARTMENTS
  .map(([id, name]) => ({ name, n: deptSplit.get(id) ?? 0 }))
  .sort((a, b) => b.n - a.n)
  .map(({ name, n }) => `${name.toLowerCase()} ${n}`)
  .join(", ");
const spineLine = [...skillReach]
  .sort((a, b) => b[1] - a[1] || nodeName(a[0]).localeCompare(nodeName(b[0])))
  .slice(0, SPINE_ROWS)
  .map(([id, n]) => `${linkLower(id)} in ${n}`)
  .join(", ");

const ARROW = (id) =>
  `<defs><marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0 0L8 4L0 8z" fill="#72777d"/></marker></defs>`;

const apReach = skillReach.get("accounts-payable") ?? 0;
const figShared = `<figure class="fig">
<svg viewBox="0 0 640 216" role="img" aria-label="Three business types each linked to the single shared accounts payable node">
  ${ARROW("arr-shared")}
  <g font-size="13" fill="var(--ink)">
    <rect x="24" y="18" width="160" height="36" rx="0" fill="#fff" stroke="var(--hair)"/>
    <text x="104" y="41" text-anchor="middle">Machine shop</text>
    <rect x="24" y="81" width="160" height="36" rx="0" fill="#fff" stroke="var(--hair)"/>
    <text x="104" y="104" text-anchor="middle">Pizzeria</text>
    <rect x="24" y="144" width="160" height="36" rx="0" fill="#fff" stroke="var(--hair)"/>
    <text x="104" y="167" text-anchor="middle">Law firm</text>
    <text x="104" y="205" text-anchor="middle" font-size="12" fill="var(--muted)">…and ${apReach - 3} more</text>
    <line x1="188" y1="36" x2="428" y2="96" stroke="var(--muted)" marker-end="url(#arr-shared)"/>
    <line x1="188" y1="99" x2="428" y2="103" stroke="var(--muted)" marker-end="url(#arr-shared)"/>
    <line x1="188" y1="162" x2="428" y2="110" stroke="var(--muted)" marker-end="url(#arr-shared)"/>
    <text x="306" y="92" text-anchor="middle" font-size="11" fill="var(--muted)">has skill</text>
    <rect x="436" y="81" width="180" height="44" rx="0" fill="#f8f9fa" stroke="var(--ink)"/>
    <text x="526" y="108" text-anchor="middle">Accounts payable</text>
  </g>
</svg>
<figcaption>${link("accounts-payable")} is one node with many parents: a single page run by ${apReach} of the ${concrete.length} business types. An improvement to it reaches all of them at once.</figcaption>
</figure>`;

const psBaseSkills = (resolved.get("professional-services-base")?.skills ?? []).map((b) => nodeName(b.ref));
const figExtends = `<figure class="fig">
<svg viewBox="0 0 640 300" role="img" aria-label="A law firm extends the professional services base and adds its own specialist skill">
  ${ARROW("arr-ext")}
  <g font-size="12.5" fill="var(--ink)">
    <rect x="20" y="16" width="264" height="222" rx="0" fill="#f8f9fa" stroke="var(--hair)"/>
    <text x="36" y="42" font-weight="600" font-size="13">professional-services-base</text>
    ${psBaseSkills.map((name, i) => `<text x="36" y="${70 + i * 24}" fill="var(--soft)">${esc(name)}</text>`).join("\n    ")}
    <line x1="352" y1="127" x2="292" y2="127" stroke="var(--muted)" marker-end="url(#arr-ext)"/>
    <text x="322" y="116" text-anchor="middle" font-size="11" fill="var(--muted)">extends</text>
    <rect x="360" y="16" width="260" height="268" rx="0" fill="#fff" stroke="var(--ink)"/>
    <text x="376" y="42" font-weight="600" font-size="13">Law firm</text>
    ${psBaseSkills.map((name, i) => `<text x="376" y="${70 + i * 24}" fill="var(--muted)">${esc(name)}</text>`).join("\n    ")}
    <line x1="376" y1="${70 + psBaseSkills.length * 24 - 10}" x2="604" y2="${70 + psBaseSkills.length * 24 - 10}" stroke="var(--hair-lt)"/>
    <text x="376" y="${70 + psBaseSkills.length * 24 + 12}" font-weight="600">Legal matter and deadline control</text>
  </g>
</svg>
<figcaption>${sentenceLabel(countWord(baseCount))} abstract bases hold the shared machinery. A ${linkLower("law-firm")} inherits ${countWord(psBaseSkills.length)} skills from its base, then adds its own specialist skill, ${linkLower("legal-matter-and-deadline-control")}.</figcaption>
</figure>`;

const pipelineFig = `<ol class="pipeline">
  <li><b>definitions/*.yaml</b><span>${businessNodeCount} business definitions (${concrete.length} concrete, ${baseCount} abstract bases) plus a file for every shared skill, role, document, metric, software category, license, and market: ${fmt(graph.nodes.length)} nodes in all.</span></li>
  <li><b>build-graph: validate and resolve</b><span>Every reference must name a defined node or the build exits with an error. Inheritance is resolved so each concrete business carries its full operating model. The one allowance is supply-chain references to businesses not documented yet, which render as plain unlinked names.</span></li>
  <li><b>graph.json and one resolved JSON per business</b><span>${fmt(graph.edges.length)} edges across ${edgeTypeCount} relationship types. The resolved files are published unchanged at /api/def/&lt;id&gt;.json, and the graph at /api/graph.json.</span></li>
  <li><b>build-site: render everything from the graph</b><span>Business articles, a page with a relationship map for every node, ${skillReach.size} loadable skill Markdown files, the JSON APIs, and the sitemap.</span></li>
  <li><b>three release checks</b><span>The catalog check compares the live set against the ${concrete.length}-type roadmap. The content check enforces the required operating detail on every definition. The site check re-walks the output: every internal link on every page must resolve, every published JSON must match its build twin, and the sitemap must contain exactly the intended pages. A release ships only when the build reports zero errors and all three checks pass.</span></li>
</ol>`;

const EDGE_MEANING = [
  ["HAS_SKILL", "business type → skill", "the business runs this skill; the binding carries its roles, documents, metrics, and software"],
  ["PERFORMED_BY", "skill → role", "who runs the work"],
  ["RECORDS", "skill → document", "the records the work reads and writes"],
  ["MEASURED_BY", "skill → metric", "the measure that judges the work"],
  ["RUNS_ON", "skill → software category", "the class of software the work runs on"],
  ["PRODUCES", "skill → document", "a record the skill creates"],
  ["CONSUMES", "skill → document", "a record the skill needs first"],
  ["EMPLOYS", "business type → role", "the role appears in the org chart"],
  ["REQUIRES", "business type → license", "a credential the business must hold"],
  ["EXTENDS", "business type → base", "inheritance of shared machinery"],
  ["BUYS_FROM", "business type → supplier", "supply chain, upstream"],
  ["SELLS_TO", "business type → customer", "supply chain, downstream"],
  ["HANDLES", "business type → product", "equipment and products the business works with"],
];
const edgeCountByType = new Map();
for (const e of graph.edges) edgeCountByType.set(e.type, (edgeCountByType.get(e.type) ?? 0) + 1);
const edgeTable = table(
  ["relationship", "joins", "meaning", "edges"],
  EDGE_MEANING.map(([type, joins, meaning]) => [
    `<code>${type}</code>`, esc(joins), esc(meaning), fmt(edgeCountByType.get(type) ?? 0),
  ]),
);

const reachBuckets = [
  ["run by one business type", reachBucket(1, 1)],
  ["2–9 business types", reachBucket(2, 9)],
  ["10–59 business types", reachBucket(10, 59)],
  ["60 or more", reachBucket(60, Infinity)],
];
const reachMax = Math.max(...reachBuckets.map(([, v]) => v));
const figReach = `<figure class="fig">
<svg viewBox="0 0 640 156" role="img" aria-label="How many business types each of the ${skillReach.size} skills runs in">
  <g font-size="12.5">
    ${reachBuckets.map(([bLabel, v], i) => {
      const y = 14 + i * 34;
      const w = Math.max(3, Math.round((v / reachMax) * 320));
      return `<text x="196" y="${y + 13}" text-anchor="end" fill="var(--soft)">${esc(bLabel)}</text>
    <rect x="208" y="${y}" width="${w}" height="17" rx="0" fill="var(--blue)"/>
    <text x="${208 + w + 8}" y="${y + 13}" fill="var(--ink)">${v} skills</text>`;
    }).join("\n    ")}
  </g>
</svg>
<figcaption>How many of the ${concrete.length} business types each of the ${skillReach.size} skills runs in.</figcaption>
</figure>`;

page({
  path: "/about/",
  title: "About · SMBwiki",
  desc: "What SMBwiki is, where the definitions come from, how they are checked, and who makes it.",
  jsonld: {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "About SMBwiki",
    description: "What SMBwiki is, where its business definitions come from, how they are checked, and who maintains the project.",
    url: `${SITE}/about/`,
    isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
    dateModified: releaseDate,
  },
  h1: "About SMBwiki",
  kicker: "From SMBwiki, the free encyclopedia of how businesses work",
  indexable: true,
  body: `
<p>SMBwiki is a free encyclopedia of how small businesses work. It documents ${concrete.length} familiar business types (machine shops, pizzerias, law firms, roofing contractors) as operating models: the skills each business runs, the roles that hold them, the documents the work moves, the metrics that judge it, the software it runs on, and the licenses it must carry.</p>
<p>Pages are written for a curious reader. The same corpus is also published in machine-readable form: Markdown skill files, resolved JSON, raw YAML, and the full graph, so an AI agent can load any part of it. <a href="/llms.txt">llms.txt</a> is the index for machines.</p>
<h2>The goal</h2>
<p>The goal is to extract meaningful, objective data from a sea of subjectivity. Models trained on humanity's accumulated writing can surface that structure, but only when properly guardrailed. What we're trying to find out is how much guardrail consistency takes. <a href="/graph/">How the graph is built</a> describes the guardrails in place today.</p>
<h2>Where the content comes from</h2>
<p>Every page is generated from YAML definitions in a <a href="${REPO}">public repository</a>. Classifications, regulated credentials, and licensing details are anchored to primary sources: NAICS industry classifications from the U.S. Census Bureau and the publications of regulators, standards bodies, and state licensing boards. The <a href="${REPO}/blob/main/SOURCES.md">source register</a> lists them.</p>
<p>The operating details, such as which role owns a skill or what records the work produces, are editorial judgment about how these businesses typically run. They describe a typical operation, and an owner should check every detail against their own business. Licensing varies by state and locality, and conditional license entries say so on the page.</p>
<h2>How it is checked</h2>
<p>Every reference on every page must resolve to a defined node before anything renders, the graph must stay one connected component with no isolated node, and three release checks verify the catalog count, the completeness of each definition, and every internal link on every generated page. <a href="/graph/">How the graph is built</a> explains the machinery.</p>
<p>The checks verify structure; they cannot tell whether a description is right. Corrections happen as changes to the definitions in the repository, and because pages share nodes, one fix to a document or a metric reaches every business type that uses it.</p>
<h2>Who makes it</h2>
<p>SMBwiki is an ERP·AI project maintained by <a href="https://github.com/protosphinx">protosphinx</a>. The generator, the checks, and every definition are open source under the MIT license.</p>
<p class="note">Sister sites: <a href="https://bomwiki.com/">BOMwiki</a>, the bill-of-materials encyclopedia (equipment on business pages here links to its bill of materials there), and <a href="https://sphinxstack.com/skills/">sphinxstack</a>, skills for software development.</p>`,
});

page({
  path: "/graph/",
  title: "How the graph is built · SMBwiki",
  desc: `How ${fmt(graph.nodes.length)} nodes and ${fmt(graph.edges.length)} edges become every page on SMBwiki: shared nodes, inheritance from abstract bases, the build pipeline, and its checks.`,
  jsonld: {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "How the SMBwiki operating-model graph is built",
    description: `How ${fmt(graph.nodes.length)} nodes and ${fmt(graph.edges.length)} edges become the business, skill, role, document, metric, software, license, and market pages on SMBwiki.`,
    url: `${SITE}/graph/`,
    isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
    dateModified: releaseDate,
  },
  h1: "How the graph is built",
  kicker: "From SMBwiki, the free encyclopedia of how businesses work",
  indexable: true,
  body: `
<p>Every page on SMBwiki is a view of one graph. Its ${fmt(graph.nodes.length)} nodes are the business types, skills, roles, documents, metrics, software categories, licenses, and markets, joined by ${fmt(graph.edges.length)} edges across ${edgeTypeCount} relationship types. The prose is written into the definitions; everything around it, from the skill tables to the relationship map on each page, is derived from the graph. This page explains how the graph is made and what the build guarantees.</p>
<h2>Shared nodes</h2>
<p>When two business types run the same work or keep the same record, the definition names the same node, and each page links to the same place. That is what the counts on the <a href="/skill/">skill index</a> and its six sibling indexes mean: how many business types share the node.</p>
${figShared}
<h2>Inheritance</h2>
<p>Businesses that run alike share an abstract base: a ${linkLower("pizzeria")} extends a restaurant base, and a ${linkLower("law-firm")} a professional-services base. The build resolves the inheritance before anything renders, so every concrete business page and API carries its full operating model, with the trade-specific work layered over the shared machinery.</p>
${figExtends}
<h2>Shared operating models</h2>
<p>Each shared model has its own reference page. It explains the common skills, roles, records, measures, software, and compliance structure inherited by the concrete businesses that use it.</p>
${table(["shared model", "used by", "examples"], baseModelRows)}
<h2>The pipeline</h2>
${pipelineFig}
<h2>The relationship types</h2>
<p>Each edge carries one of ${edgeTypeCount} meanings. Skill-to-role, document, metric, and software edges come from the bindings inside each business definition; the rest describe the businesses themselves. Product edges cross to a sister encyclopedia: equipment on a business page links to its bill of materials on <a href="https://bomwiki.com/">BOMwiki</a>.</p>
${edgeTable}
<h2>What the build guarantees</h2>
<p>The build guarantees that every reference resolves and that the graph stays connected. It cannot check the content itself: whether a real masonry contractor runs the work the way ${linkLower("masonry-contractor")} describes is editorial judgment, anchored to the <a href="${REPO}/blob/main/SOURCES.md">source register</a> and open to correction in the <a href="${REPO}">repository</a>. Because nodes are shared, a correction lands on every page that uses them.</p>`,
});

page({
  path: "/research/",
  title: "Research · SMBwiki",
  desc: "The SMBwiki corpus as a dataset: statistics, the shape of shared and specialist work, downloads, and how to cite it.",
  jsonld: {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "SMBwiki research and dataset",
    description: "Statistics, downloads, provenance, and citation guidance for the SMBwiki operating-model dataset.",
    url: `${SITE}/research/`,
    isPartOf: { "@type": "WebSite", name: "SMBwiki", url: SITE },
    dateModified: releaseDate,
  },
  h1: "Research",
  kicker: "From SMBwiki, the free encyclopedia of how businesses work",
  indexable: true,
  body: `
<p>The corpus behind SMBwiki is one structured dataset: every business type, skill, role, document, metric, software category, license, and market as nodes in a single graph, with the bindings between them. This page carries the dataset's statistics, the patterns visible in it, how to load it, and how to cite it. There are no published reports on the corpus yet; when there are, they will be listed here.</p>
<h2>The dataset</h2>
${table(["", "current release"], [
  ["business types", `${concrete.length} concrete, plus ${baseCount} abstract bases`],
  ["skills", `${kindCount("skill")}`],
  ["roles", `${kindCount("role")}`],
  ["documents", `${kindCount("document")}`],
  ["metrics", `${kindCount("metric")}`],
  ["software categories", `${kindCount("software-category")}`],
  ["licenses", `${kindCount("license")}`],
  ["markets", `${kindCount("market")}`],
  ["graph", `${fmt(graph.nodes.length)} nodes, ${fmt(graph.edges.length)} edges, ${edgeTypeCount} relationship types`],
  ["skill bindings", `${fmt(bindingCount)} across the ${concrete.length} concrete businesses (${(bindingCount / concrete.length).toFixed(2)} average)`],
])}
<p class="note">Counts describe the current release; the corpus changes as the catalog grows. Release dates are recorded in the <a href="/sitemap.xml">sitemap</a> and the <a href="${REPO}">repository history</a>.</p>
<h2>The shape of the work</h2>
<p>Of the ${skillReach.size} skills, ${soleUse.size} run in exactly one business type: trade work like ${linkLower("aggregate-base-placement")} or ${linkLower("medication-dispensing")}. ${sentenceLabel(countWord(reachBucket(60, Infinity)))} run in sixty or more, and they are the back office: ${spineLine} of the ${concrete.length} types.</p>
${figReach}
<p>The same split shows in documents and roles. A ${linkLower("payment-record")} appears in ${bizOf("payment-record", ["binding-document"]).length} of the ${concrete.length} business types and a ${linkLower("supplier-invoice")} in ${bizOf("supplier-invoice", ["binding-document"]).length}; an ${linkLower("owner-operator")} leads ${bizOf("owner-operator", ["org", "binding-role"]).length} of them. By department, the ${skillReach.size} skills split ${deptLine}; the assignments are editorial and open to correction.</p>
<h2>Get the data</h2>
<ul>
  <li><a href="/api/graph.json">/api/graph.json</a>: the full graph, nodes and typed edges</li>
  <li><code>/api/def/&lt;id&gt;.json</code>: one resolved definition per business type, inheritance already merged (<a href="/api/def/machine-shop.json">example</a>)</li>
  <li><code>/definitions/</code>: the source YAML, exactly as in the repository (<a href="/definitions/businesses/machine-shop.yaml">example</a>)</li>
  <li><code>/skill/&lt;id&gt;.md</code>: each skill as a loadable Markdown file (<a href="/skill/production-control.md">example</a>)</li>
  <li><a href="/llms.txt">/llms.txt</a>: the machine index of all of the above</li>
  <li><a href="${REPO}">the repository</a>: definitions, generator, and checks, MIT-licensed</li>
</ul>
<h2>Cite</h2>
<p>protosphinx. <i>SMBwiki: how businesses work.</i> ERP·AI, ${releaseYear}. ${SITE}/</p>
<pre><code>@misc{smbwiki,
  title  = {SMBwiki: how businesses work},
  author = {protosphinx},
  year   = {${releaseYear}},
  url    = {${SITE}/},
  note   = {Operating models for ${concrete.length} business types; MIT-licensed corpus}
}</code></pre>`,
});
cpSync(join(BUILD, "graph.json"), join(DIST, "api", "graph.json"));

writeFileSync(
  join(DIST, "sitemap.xml"),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemapPaths.map((path) => `  <url><loc>${SITE}${path}</loc>${lastmod}</url>`),
    "</urlset>",
    "",
  ].join("\n"),
);
writeFileSync(
  join(DIST, "robots.txt"),
  `User-agent: *
Allow: /
Sitemap: ${SITE}/sitemap.xml
`,
);
writeFileSync(
  join(DIST, "llms.txt"),
  `# SMBwiki

Open, machine-readable definitions of how small and medium businesses
operate. Each business type decomposes into skills, roles, documents,
metrics, licenses, and software categories.

- Business pages: ${SITE}/business/<id>/
- Resolved definitions (JSON): ${SITE}/api/def/<id>.json
- Full graph (JSON): ${SITE}/api/graph.json
- Source definitions (YAML): ${SITE}/definitions/businesses/<id>.yaml
- Distilled skills (markdown): ${SITE}/skill/<skill-id>.md
- About and method: ${SITE}/about/ and ${SITE}/graph/
- All definitions: https://github.com/erphq/smbwiki (MIT)

Business types: ${concrete.map((r) => r.id).join(", ")}
`,
);
console.log(`rendered ${readdirSync(DIST, { recursive: true }).filter((f) => String(f).endsWith("index.html")).length} pages -> dist/`);
