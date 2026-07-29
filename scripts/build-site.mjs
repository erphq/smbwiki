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
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  <script id="opgraph-data" type="application/json">${JSON.stringify(data)}</script>
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
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${indexable ? "" : '<meta name="robots" content="noindex">'}
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${path}">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="${CSS_HREF}">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
<header><div class="wrap"><a class="wordmark" href="/">smbwiki</a><nav><a href="/#business-types">business types</a><a href="https://github.com/erphq/smbwiki">source</a></nav></div></header>
<main class="wrap">
${bare ? "" : `${kicker ? `<p class="kicker">${kicker}</p>` : ""}\n<h1>${esc(h1 ?? title)}</h1>`}
${body}
${src}
</main>
<footer><div class="wrap">smbwiki · <a href="https://github.com/erphq/smbwiki">source on GitHub</a> · MIT</div></footer>
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
  const items = [];
  if (added.length) items.push(`adds ${links(added)}`);
  if (removed.length) items.push(`drops ${links(removed)}`);
  if (rebound.length) items.push(`rebinds ${links(rebound)}`);
  if (revAdd.length) items.push(`adds revenue: ${revAdd.map((id) => esc(sentenceLabel(id))).join(", ")}`);
  if (revDrop.length) items.push(`drops revenue: ${revDrop.map((id) => esc(sentenceLabel(id))).join(", ")}`);
  if (licAdd.length) items.push(`adds ${links(licAdd)}`);
  if (licDrop.length) items.push(`drops ${links(licDrop)}`);
  if (JSON.stringify(p.org) !== JSON.stringify(r.org)) items.push("restructures the org");
  if (!items.length) return "";
  return section(
    `vs ${esc(p.name)}`,
    `<p>Inherits from ${link(r.extends)} and ${items.join("; ")}.</p>`,
  );
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
  const structure = r.abstract ? "" : section(
    "Structure",
    `<p>The definition contains ${(r.skills ?? []).length} core skills${geoProcessCount ? ` and ${geoProcessCount} country-specific ${geoProcessCount === 1 ? "skill" : "skills"}` : ""}. The org chart contains ${orgCount(r.org)} roles across ${orgDepth(r.org)} levels.</p>`,
  );
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
  const statline = r.abstract ? "" : `<p class="statline">${stats.join(" · ")}</p>`;
  const summary = (r.summary ?? "").trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("\n");
  const revenue = `<ul class="revenue-list">${(r.revenue_model ?? []).map((m) =>
    `<li><strong>${esc(sentenceLabel(m.id))}</strong>${m.note ? `: ${esc(m.note)}` : ""}</li>`,
  ).join("")}</ul>`;
  const body = [
    statline,
    r.abstract
      ? `<p class="note">Abstract base. ${children.length ? `Extended by ${links(children.map((c) => c.id))}.` : ""}</p>`
      : "",
    summary ? `<div class="summary">${summary}</div>` : "",
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
        ? `<p class="note">Names without links are external counterparties that are not yet modeled as smbwiki entities.</p>`
        : ""),
    ) : "",
    r.products?.length ? section("Equipment and products handled", `<p>${r.products.map((x) => `<a href="https://bomwiki.com/item/${x}/">${esc(x.replace(/-/g, " "))}</a>`).join(", ")} <span class="muted">(on bomwiki)</span></p>`) : "",
    deltaSection(r),
  ].join("\n");
  page({
    path: `/business/${r.id}/`,
    title: r.seo?.title ?? `${r.name}: How the Business Works | smbwiki`,
    desc: (r.summary ?? `${r.name}: structure, skills, roles, documents, and metrics.`).slice(0, 155),
    h1: r.name,
    kicker: r.abstract ? "abstract base" : `business type${r.codes?.naics ? ` · US NAICS ${r.codes.naics}` : ""}`,
    body,
    yamlPath: `/definitions/businesses/${r.id}.yaml`,
    jsonPath: r.abstract ? null : `/api/def/${r.id}.json`,
    jsonld: r.abstract ? null : {
      "@context": "https://schema.org", "@type": "Article",
      headline: `${r.name}: how the business works`,
      about: { "@type": "Thing", name: r.name },
      isBasedOn: `${SITE}/api/def/${r.id}.json`, license: "https://opensource.org/license/mit",
    },
    indexable: !r.abstract,
  });
}

// ---- SKILL.md: each process distilled into a loadable skill --------------
function skillMd(d) {
  const runners = bizOf(d.id, ["skill-binding"]);
  const L = [];
  L.push(`# ${d.name}`);
  L.push("");
  L.push(`A distilled business skill from smbwiki.${d.department ? ` Department: ${DEPARTMENT_NAME.get(d.department) ?? d.department}.` : ""} ${runners.length ? `Held by ${runners.length} business type${runners.length === 1 ? "" : "s"} in the catalog. ` : ""}Source of truth: ${SITE}/skill/${d.id}/ (structured data: ${SITE}/definitions/skills/${d.id}.yaml).`);
  L.push("");
  L.push("## What this skill is");
  L.push("");
  L.push(String(d.summary ?? "").trim());
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

for (const n of graph.nodes) {
  if (n.label === "business") continue;
  const d = n.data;
  const parts = [(d.summary ? `<p>${esc(d.summary.trim())}</p>` : "")];
  parts.push(section("Relationship map", relationshipGraph(n)));
  if (n.label === "skill") {
    mkdirSync(join(DIST, "skill"), { recursive: true });
    writeFileSync(join(DIST, "skill", `${n.id}.md`), skillMd(d));
    parts.push(`<p class="skill-line">This skill is the steps, guardrails, and checks to run ${esc(n.name.toLowerCase())} anywhere it appears. <a href="/skill/${n.id}.md">Load it as SKILL.md</a>.</p>`);
    if (d.steps?.length) {
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
    parts.push(`<p class="muted">${esc(d.unit ?? "")}${d.direction ? ` · ${d.direction} is better` : ""}</p>`);
    parts.push(section("Measured in", table(["business", "skill", "layer"], (usedBy.get(n.id) ?? []).filter((c) => c.kind === "binding-metric" && !resolved.get(c.biz).abstract).map((c) => [link(c.biz), link(c.process), c.geo ? esc(countryName(c.geo)) : "core"]))));
  } else if (n.label === "document") {
    const prod = graph.edges.filter((e) => e.type === "PRODUCES" && e.to === n.id).map((e) => e.from);
    const cons = graph.edges.filter((e) => e.type === "CONSUMES" && e.to === n.id).map((e) => e.from);
    parts.push(section("Lifecycle", `<p>Produced by ${links(prod) || "none"}. Consumed by ${links(cons) || "none"}.</p>`));
    parts.push(section("Appears in", `<p>${links(bizOf(n.id, ["binding-document"])) || "none"}</p>`));
  } else if (n.label === "role") {
    parts.push(section("Appears in", `<p>${links(bizOf(n.id, ["org", "binding-role"])) || "none"}</p>`));
    const owns = [...new Set((usedBy.get(n.id) ?? []).filter((c) => c.kind === "binding-role").map((c) => c.process))];
    if (owns.length) parts.push(section("Owns", `<p>${links(owns)}</p>`));
  } else if (n.label === "software-category") {
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
    parts.push(section("Sold to by", `<p>${links(bizOf(n.id, ["sells-to"])) || "none"}</p>`));
  }
  if (n.label === "skill") {
    mkdirSync(join(DIST, "process", n.id), { recursive: true });
    writeFileSync(join(DIST, "process", n.id, "index.html"),
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=/skill/${n.id}/"><link rel="canonical" href="${SITE}/skill/${n.id}/"><a href="/skill/${n.id}/">Moved to /skill/${n.id}/</a>`);
  }
  page({
    path: `/${SEG[n.label]}/${n.id}/`,
    title: `${n.name} (${KICKER[n.label]}) | smbwiki`,
    desc: (d.summary ?? n.name).slice(0, 155),
    h1: n.name,
    kicker: n.label === "skill" && d.department
      ? `${KICKER[n.label]} · ${esc(DEPARTMENT_NAME.get(d.department) ?? d.department)}`
      : KICKER[n.label],
    body: parts.join("\n"),
    yamlPath: `/definitions/${DEF_DIR[n.label]}/${n.id}.yaml`,
    indexable: n.label === "skill",
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
const PLURAL = { skill: "Skills", role: "Roles", document: "Documents", metric: "Metrics", "software-category": "Software categories", license: "Licenses" };
const USE_KINDS = {
  skill: ["skill-binding"], role: ["org", "binding-role"], document: ["binding-document"],
  metric: ["binding-metric"], "software-category": ["binding-software"], license: ["license"],
};
const kindList = (label, seg) => {
  const items = graph.nodes.filter((n) => n.label === label).sort((a, b) => a.name.localeCompare(b.name));
  const rows = items.map((n) => {
    const uses = bizOf(n.id, USE_KINDS[label]).length;
    return `<li><a href="/${seg}/${n.id}/">${esc(n.name)}</a>${uses > 1 ? ` <span class="usecount">${uses}</span>` : ""}</li>`;
  }).join("");
  return `<h2>${esc(PLURAL[label].toLowerCase())} <span class="muted">(${items.length})</span></h2><ul class="index-cols">${rows}</ul>`;
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
const COUNT_WORD = [
  "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];
const countWord = (n) => COUNT_WORD[n] ?? String(n);
const COUNTRY_ARTICLE = { us: "the " };
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
// A magazine sidebar, not a section: it sits beside the lead so the page
// still reads hero then catalog without an interruption.
const PASTE = `Read ${SITE}/skill/${AI_EXAMPLE}.md and follow it. Then: set up ${aiExampleName.toLowerCase()} for my business.`;
const skillsAndAi = `<aside class="skillbox" id="skills-and-ai" aria-labelledby="skillbox-title">
      <div class="skillbox-text">
        <h2 id="skillbox-title">What a skill is</h2>
        <p>A prompt asks for a result. A skill records the process used to produce and check it: the steps and who runs each, the records in and out, how the work fails, and what stays human. ${skillReach.size} of them here, plain Markdown, no key and no account.</p>
        <p class="note">Business skills live here. Skills for building and shipping things live at <a href="https://sphinxstack.com/skills/">sphinxstack</a>.</p>
      </div>
      <div class="skillbox-try">
        <p class="skillbox-sub">Paste into any agent</p>
        <p class="paste"><code>${esc(PASTE)}</code></p>
        <p>That one is ${link(AI_EXAMPLE)}. <a href="/skill/${AI_EXAMPLE}.md">Read the file</a>, <a href="/business/${LEAD_ID}/#skills">see a full set by department</a>, or take <a href="/llms.txt">llms.txt</a>.</p>
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
  title: "smbwiki: how businesses work",
  desc: `Operating models for ${concrete.length} familiar business types, covering revenue, skills, roles, documents, metrics, software, licenses, and supply chains.`,
  bare: true,
  body: [
    `<div class="home-lead">
      <h1>How businesses work</h1>
      <p class="deck">Operating models for ${concrete.length} familiar business types.</p>
      <div class="home-brief">
        <div class="home-copy">
          <p>${leadSentences}</p>
          <p class="thesis">All ${concrete.length} business types are documented that way. Every skill is also published as a file any AI agent can load, which is how this corpus connects to AI. There are <a href="#skills-and-ai">${skillReach.size} of them</a>.</p>
        </div>
        <ul class="contents">
          <li><a href="#business-types">Browse the catalog</a></li>
          <li><a href="/business/${LEAD_ID}/">Read an example business</a></li>
          <li><a href="/definitions/businesses/${LEAD_ID}.yaml">Read a definition file</a></li>
          <li><a href="https://github.com/erphq/smbwiki">Open the source</a></li>
        </ul>
      </div>
    </div>`,
    skillsAndAi,
    `<h2 id="business-types">business types</h2>
     <div class="catalog-filter" hidden>
       <label for="catalog-q">Filter</label>
       <input id="catalog-q" type="search" autocomplete="off" spellcheck="false"
              placeholder="name, skill, record, measure, or NAICS code">
       <p class="filter-hint">Try <button type="button" data-q="production control">production control</button>, <button type="button" data-q="scrap rate">scrap rate</button>, or <button type="button" data-q="332710">332710</button>.</p>
     </div>
     <p class="filter-status" role="status" aria-live="polite" hidden></p>
     <div class="business-sectors">${businessCatalog}</div>
     <p class="filter-empty" hidden>No business type matches that.</p>
     <script src="${CATALOG_HREF}" defer></script>`,
    sharedWork,
    kindList("skill", "skill"),
    kindList("role", "role"),
    kindList("document", "document"),
    kindList("metric", "metric"),
    kindList("software-category", "software"),
    kindList("license", "license"),
  ].join("\n"),
  indexable: true,
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
cpSync(join(ROOT, "assets", "opgraph.js"), join(DIST, "static", "opgraph.js"));
cpSync(join(ROOT, "assets", "catalog.js"), join(DIST, "static", "catalog.js"));
cpSync(join(ROOT, "assets", "vendor"), join(DIST, "static", "vendor"), { recursive: true });
const sitemapPaths = [
  "/",
  ...[...concrete]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `/business/${r.id}/`),
  ...graph.nodes
    .filter((n) => n.label === "skill")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `/skill/${n.id}/`),
];
// Every page is regenerated from the same corpus, so the release commit date
// is the honest lastmod. Taken from git rather than the clock, so a rebuild of
// an unchanged tree produces an identical sitemap.
const releaseDate = (() => {
  try {
    return execSync("git log -1 --format=%cI", { cwd: ROOT, encoding: "utf8" }).trim().slice(0, 10);
  } catch {
    return null;
  }
})();
const lastmod = releaseDate ? `<lastmod>${releaseDate}</lastmod>` : "";
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
  `# smbwiki

Open, machine-readable definitions of how small and medium businesses
operate. Each business type decomposes into skills, roles, documents,
metrics, licenses, and software categories.

- Business pages: ${SITE}/business/<id>/
- Resolved definitions (JSON): ${SITE}/api/def/<id>.json
- Source definitions (YAML): ${SITE}/definitions/businesses/<id>.yaml
- Distilled skills (markdown): ${SITE}/skill/<skill-id>.md
- All definitions: https://github.com/erphq/smbwiki (MIT)

Business types: ${concrete.map((r) => r.id).join(", ")}
`,
);
console.log(`rendered ${readdirSync(DIST, { recursive: true }).filter((f) => String(f).endsWith("index.html")).length} pages -> dist/`);
