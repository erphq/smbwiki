#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { specializedSkillIds } from "./lib/skill-practice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SITE = "https://smbwiki.com";
const failures = [];
const TITLE_MIN = 10;
const TITLE_MAX = 65;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;
const CONTEXT_MIN = 200;

function walk(folder) {
  return readdirSync(folder)
    .flatMap((name) => {
      const path = join(folder, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    })
    .sort();
}

function targetFor(href) {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  if (clean === "/") return join(DIST, "index.html");
  if (clean.endsWith("/")) return join(DIST, clean.slice(1), "index.html");
  return join(DIST, clean.slice(1));
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const radix = entity[1].toLowerCase() === "x" ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : whole;
  });
}

function cleanText(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function visibleText(value) {
  return cleanText(
    value
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[^>]*>[^]*?<\/\1>/gi, " "),
  );
}

function pagePathFor(file) {
  const rel = relative(DIST, file).split("\\").join("/");
  if (rel === "index.html") return "/";
  if (!rel.endsWith("/index.html")) return null;
  return `/${rel.slice(0, -"index.html".length)}`;
}

function addToList(map, key, value) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function allJsonLdObjects(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) allJsonLdObjects(item, result);
    return result;
  }
  result.push(value);
  for (const nested of Object.values(value)) allJsonLdObjects(nested, result);
  return result;
}

function jsonLdTypes(object) {
  const value = object?.["@type"];
  return new Set(Array.isArray(value) ? value : value ? [value] : []);
}

if (!existsSync(DIST)) failures.push("dist/ does not exist; generate the site first");

const files = existsSync(DIST) ? walk(DIST) : [];
const htmlFiles = files.filter((file) => extname(file) === ".html");
let hrefCount = 0;
const graphPath = join(ROOT, "build", "graph.json");
const graph = existsSync(graphPath)
  ? JSON.parse(readFileSync(graphPath, "utf8"))
  : { nodes: [], edges: [] };
const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
const graphSegments = {
  business: "business",
  skill: "skill",
  role: "role",
  document: "document",
  metric: "metric",
  "software-category": "software",
  license: "license",
  market: "market",
};
let graphPages = 0;

// The exported graph once carried bindings only inside HAS_SKILL props, which
// left every role, metric, and software category an orphan. Guard the fix.
{
  const resolvable = new Set(graph.nodes.map((node) => node.id));
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!resolvable.has(edge.to)) continue;
    degree.set(edge.from, degree.get(edge.from) + 1);
    degree.set(edge.to, degree.get(edge.to) + 1);
  }
  const isolated = graph.nodes.filter((node) => degree.get(node.id) === 0);
  if (isolated.length)
    failures.push(
      `${isolated.length} graph node(s) have no relationship: ` +
      isolated.slice(0, 5).map((node) => node.id).join(", "),
    );
  for (const type of ["EMPLOYS", "PERFORMED_BY", "MEASURED_BY", "RUNS_ON", "RECORDS"])
    if (!graph.edges.some((edge) => edge.type === type))
      failures.push(`graph is missing ${type} edges; binding relationships were dropped`);
}

for (const file of htmlFiles) {
  const rel = relative(DIST, file);
  const html = readFileSync(file, "utf8");

  if (/^business\/[^/]+\/index\.html$/.test(rel) && /<th>also in<\/th>/.test(html))
    failures.push(`${rel} exposes the retired cross-business skill column`);
  if (/^business\/[^/]+\/index\.html$/.test(rel)) {
    if (/Inherits from [\s\S]*? and \.<\/p>/.test(html))
      failures.push(`${rel} renders an empty inheritance comparison`);
    if (/\b1 licenses\b/.test(html))
      failures.push(`${rel} uses the wrong singular form for license`);
    if (/\b0 linked products\b/.test(html))
      failures.push(`${rel} renders an empty linked-product statistic`);
    if (/<span class="external-concept">[^<]*-/.test(html))
      failures.push(`${rel} exposes a raw external supply-chain identifier`);
  }
  if (/\buniversal skills\b|>universal<|erp\.ai category:/i.test(html))
    failures.push(`${rel} exposes internal terminology in viewer copy`);

  // Diagram boxes were once a fixed 150px wide, which clipped every label
  // longer than the box. Boxes must be at least as wide as their own text.
  for (const svg of html.matchAll(/<svg class="diagram[^"]*"[\s\S]*?<\/svg>/g))
    for (const box of svg[0].matchAll(
      /<rect x="[-\d.]+" y="[-\d.]+" width="([\d.]+)"[^>]*\/><text[^>]*>([^<]*)<\/text>/g,
    )) {
      const width = Number(box[1]);
      const needed = Math.max(84, box[2].length * 7.4 + 22);
      if (width + 0.5 < needed)
        failures.push(
          `${rel} diagram box for "${box[2]}" is ${width}px wide, needs ${Math.ceil(needed)}px`,
        );
    }

  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    hrefCount += 1;
    const target = targetFor(href);
    if (!existsSync(target))
      failures.push(`${rel} links to missing ${href}`);
  }
}

for (const node of graph.nodes) {
  const segment = graphSegments[node.label];
  if (!segment) {
    failures.push(`graph node ${node.id} has no page segment for ${node.label}`);
    continue;
  }
  const pagePath = join(DIST, segment, node.id, "index.html");
  if (!existsSync(pagePath)) {
    failures.push(`graph node ${node.id} is missing its entity page`);
    continue;
  }
  for (const alias of node.data?.aliases ?? []) {
    const aliasPath = join(DIST, segment, alias, "index.html");
    if (!existsSync(aliasPath)) {
      failures.push(`graph node ${node.id} is missing alias page ${segment}/${alias}/`);
      continue;
    }
    const aliasHtml = readFileSync(aliasPath, "utf8");
    const target = `/${segment}/${node.id}/`;
    if (
      !aliasHtml.includes(`url=${target}`) ||
      !aliasHtml.includes(`rel="canonical" href="${SITE}${target}"`)
    )
      failures.push(`${segment}/${alias}/ does not redirect canonically to ${target}`);
  }
  const html = readFileSync(pagePath, "utf8");
  if (node.label === "skill" && !html.includes('<section id="run-by"><h2>Run by</h2>'))
    failures.push(`${segment}/${node.id}/ is missing its cross-business Run by section`);
  if (node.label === "license") {
    if (html.includes('<section id="required-by">'))
      failures.push(`${segment}/${node.id}/ presents license applicability as unconditional`);
    for (const heading of ["status", "scope", "source checked"])
      if (!html.includes(`<th>${heading}</th>`))
        failures.push(`${segment}/${node.id}/ is missing its ${heading} license context`);
  }
  const dataMatches = [...html.matchAll(/<script id="opgraph-data" type="application\/json">([\s\S]*?)<\/script>/g)];
  if (dataMatches.length !== 1) {
    failures.push(`${segment}/${node.id}/ has ${dataMatches.length} relationship-map payloads; expected 1`);
    continue;
  }
  if (!html.includes('id="opcanvas"') || !html.includes("Direct relationships") && !html.includes("0 direct relationships"))
    failures.push(`${segment}/${node.id}/ is missing the relationship-map surface or fallback`);
  if (html.includes("op-legend"))
    failures.push(`${segment}/${node.id}/ contains the retired colored graph legend`);
  let data;
  try {
    data = JSON.parse(dataMatches[0][1]);
  } catch {
    failures.push(`${segment}/${node.id}/ has invalid relationship-map JSON`);
    continue;
  }
  if (data.focusId !== node.id)
    failures.push(`${segment}/${node.id}/ map focuses ${data.focusId ?? "nothing"}`);
  if (!data.nodes?.some((item) => item.id === node.id && item.focus))
    failures.push(`${segment}/${node.id}/ map is missing its marked focus node`);
  if (!(data.edges?.length > 0))
    failures.push(`${segment}/${node.id}/ map has no recorded relationship`);
  if (data.mode === "entity" && (data.edges?.length ?? 0) > 36)
    failures.push(`${segment}/${node.id}/ entity map exceeds the 36-relationship display bound`);
  if (data.mode === "entity" && !html.includes("directly related"))
    failures.push(`${segment}/${node.id}/ does not explain its relationship count as entities`);
  if (
    data.mode === "entity" &&
    (data.nodes ?? []).some((item) => graph.nodes.find((candidate) => candidate.id === item.id)?.abstract)
  )
    failures.push(`${segment}/${node.id}/ entity map counts an abstract business`);
  const shown = new Set((data.nodes ?? []).map((item) => item.id));
  for (const item of data.nodes ?? [])
    if (!graphNodeIds.has(item.id))
      failures.push(`${segment}/${node.id}/ map contains unknown node ${item.id}`);
  for (const edge of data.edges ?? []) {
    if (!shown.has(edge.s) || !shown.has(edge.t))
      failures.push(`${segment}/${node.id}/ map edge ${edge.s} -> ${edge.t} has a hidden endpoint`);
    if (!edge.label)
      failures.push(`${segment}/${node.id}/ map edge ${edge.s} -> ${edge.t} has no relationship label`);
  }
  graphPages += 1;
}

const home = existsSync(join(DIST, "index.html"))
  ? readFileSync(join(DIST, "index.html"), "utf8")
  : "";
const homeBusinessHrefs = [
  ...home.matchAll(/href="(\/business\/[^"]+\/)"/g),
].map((match) => match[1]);
const uniqueHomeBusinesses = new Set(homeBusinessHrefs);
if (/\b\d+\s+of\s+100\b/i.test(home))
  failures.push("homepage contains internal catalog progress notation");
if (/components of a definition|one business,\s*traced/i.test(home))
  failures.push("homepage contains retired implementation furniture");
if (!home.includes('id="catalog-q"') || !/src="\/static\/catalog\.js\?v=/.test(home))
  failures.push("homepage is missing the catalog filter or its script");
if (!existsSync(join(DIST, "static", "catalog.js")))
  failures.push("dist/static/catalog.js is missing");
const filterKeys = [...home.matchAll(/<li data-k="([^"]*)"/g)].map((match) => match[1]);
if (filterKeys.length !== uniqueHomeBusinesses.size)
  failures.push(
    `homepage has ${filterKeys.length} filter keys for ` +
    `${uniqueHomeBusinesses.size} catalog businesses`,
  );
for (const key of filterKeys)
  if (!key.trim() || /[^a-z0-9 ]/.test(key))
    failures.push(`homepage catalog row has an unusable filter key: "${key}"`);
if (!/<h2 id="shared-work">/.test(home))
  failures.push("homepage is missing the shared and specific work section");
if (!/<aside class="skillbox" id="skills-and-ai"/.test(home))
  failures.push("homepage no longer explains what a skill is");
if (!home.includes('href="https://sphinxstack.com/skills/"'))
  failures.push("homepage no longer points build-and-ship skills at sphinxstack");
if (!/href="\/skill\/[a-z0-9-]+\.md"/.test(home) || !home.includes('href="/llms.txt"'))
  failures.push("homepage does not offer a loadable skill file and llms.txt");
// The shared/specific counts are claims about the corpus. Recompute them from
// the resolved definitions so the homepage cannot drift away from the data.
const resolvedDir = join(ROOT, "build", "resolved");
if (existsSync(resolvedDir)) {
  const reach = new Map();
  let liveCount = 0;
  for (const file of readdirSync(resolvedDir)) {
    const r = JSON.parse(readFileSync(join(resolvedDir, file), "utf8"));
    if (r.abstract) continue;
    liveCount += 1;
    const refs = [
      ...(r.skills ?? []),
      ...Object.values(r.geo ?? {}).flatMap((layer) => layer.skills ?? []),
    ].map((binding) => binding.ref);
    for (const ref of new Set(refs)) reach.set(ref, (reach.get(ref) ?? 0) + 1);
  }
  const sole = [...reach.values()].filter((n) => n === 1).length;
  const claim = new RegExp(
    `The ${liveCount} business types run ${reach.size} distinct skills between them\\.` +
    `[^<]*?\\b${sole} of those skills appear in a single business type\\.`,
  );
  if (!claim.test(home))
    failures.push(
      `homepage shared-work counts disagree with the definitions ` +
      `(expected ${liveCount} types, ${reach.size} skills, ${sole} used once)`,
    );
  const spine = [...reach].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [id, n] of spine)
    if (!home.includes(`<a href="/skill/${id}/">`) || !home.includes(`<span>${n} of ${liveCount}</span>`))
      failures.push(`homepage shared-work list is missing ${id} at ${n} of ${liveCount}`);
}

const businessSources = readdirSync(join(ROOT, "definitions", "businesses"))
  .filter((file) => file.endsWith(".yaml"))
  .map((file) => yaml.load(readFileSync(join(ROOT, "definitions", "businesses", file), "utf8")))
  .filter((business) => !business.abstract);
const resolvedBusinesses = new Map();
if (uniqueHomeBusinesses.size !== businessSources.length)
  failures.push(
    `homepage links to ${uniqueHomeBusinesses.size} unique businesses; ` +
    `expected ${businessSources.length}`,
  );
for (const business of businessSources) {
  const buildPath = join(ROOT, "build", "resolved", `${business.id}.json`);
  const publicPath = join(DIST, "api", "def", `${business.id}.json`);
  if (!existsSync(buildPath) || !existsSync(publicPath)) {
    failures.push(`${business.id} is missing a generated definition artifact`);
    continue;
  }
  const builtDefinition = JSON.parse(readFileSync(buildPath, "utf8"));
  resolvedBusinesses.set(business.id, builtDefinition);
  const built = JSON.stringify(builtDefinition);
  const published = JSON.stringify(JSON.parse(readFileSync(publicPath, "utf8")));
  if (built !== published)
    failures.push(`${business.id} public JSON differs from the resolved build`);
}

for (const source of walk(join(ROOT, "definitions"))) {
  const rel = relative(join(ROOT, "definitions"), source);
  const published = join(DIST, "definitions", rel);
  if (!existsSync(published)) {
    failures.push(`definitions/${rel} is missing from dist`);
    continue;
  }
  const specialized = rel.match(/^skills\/([a-z0-9-]+)\.yaml$/)?.[1];
  if (specialized && specializedSkillIds.has(specialized)) {
    const expected = graphNodes.get(specialized)?.data;
    const actual = yaml.load(readFileSync(published, "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      failures.push(`definitions/${rel} differs from its specialized graph definition`);
    continue;
  }
  if (readFileSync(source, "utf8") !== readFileSync(published, "utf8"))
    failures.push(`definitions/${rel} differs from its dist copy`);
}

const skillMarkdown = files.filter((file) =>
  /^skill\/[^/]+\.md$/.test(relative(DIST, file)),
);

// Every real page comes from either the project shell or one graph node. The
// only HTML that is deliberately not indexable is a compatibility redirect:
// the old /process/ form of a skill URL, or a declared node alias.
const contentTypes = new Map([
  ["/", new Set(["WebSite"])],
  ["/about/", new Set(["WebPage", "AboutPage"])],
  ["/graph/", new Set(["WebPage", "CollectionPage", "Dataset"])],
  ["/research/", new Set(["WebPage", "CollectionPage", "Dataset"])],
  // One index page per graph node kind (moved off the homepage 2026-09-15).
  ...["skill", "role", "document", "metric", "software", "license", "market"]
    .map((segment) => [`/${segment}/`, new Set(["WebPage", "CollectionPage"])]),
  // Sector KPI pages. Group ids must stay in step with CATALOG_GROUPS in
  // scripts/build-site.mjs.
  ["/kpis/", new Set(["WebPage", "CollectionPage"])],
  ...["construction-property", "food-lodging", "health-care", "personal-recreation",
    "retail-vehicles", "professional-financial", "logistics-production"]
    .map((group) => [`/kpis/${group}/`, new Set(["WebPage", "CollectionPage"])]),
]);
const contentNames = new Map();
const entityPaths = new Set();
const redirectTargets = new Map();
for (const node of graph.nodes) {
  const segment = graphSegments[node.label];
  if (!segment) continue;
  const path = `/${segment}/${node.id}/`;
  contentTypes.set(
    path,
    new Set(
      node.label === "business" || node.label === "skill"
        ? ["Article"]
        : node.label === "metric"
          ? ["Article", "DefinedTerm"]
          : ["DefinedTerm"],
    ),
  );
  entityPaths.add(path);
  if (node.label !== "business") contentNames.set(path, node.name);
  if (node.label === "skill")
    redirectTargets.set(`/process/${node.id}/`, path);
  for (const alias of node.data?.aliases ?? []) {
    const aliasPath = `/${segment}/${alias}/`;
    if (redirectTargets.has(aliasPath) && redirectTargets.get(aliasPath) !== path)
      failures.push(`${aliasPath} aliases both ${redirectTargets.get(aliasPath)} and ${path}`);
    redirectTargets.set(aliasPath, path);
  }
}
for (const path of redirectTargets.keys())
  if (contentTypes.has(path))
    failures.push(`${path} is both a content URL and a redirect URL`);

const htmlByPath = new Map();
for (const file of htmlFiles) {
  const path = pagePathFor(file);
  const rel = relative(DIST, file);
  if (!path) {
    failures.push(`${rel} is HTML outside a directory index URL`);
    continue;
  }
  if (htmlByPath.has(path)) {
    failures.push(`${path} is generated by more than one HTML file`);
    continue;
  }
  htmlByPath.set(path, { file, rel, html: readFileSync(file, "utf8") });
}
for (const path of contentTypes.keys())
  if (!htmlByPath.has(path)) failures.push(`content page ${path} is not generated`);
for (const [path, target] of redirectTargets)
  if (!htmlByPath.has(path)) failures.push(`redirect page ${path} -> ${target} is not generated`);
for (const [path, { rel }] of htmlByPath)
  if (!contentTypes.has(path) && !redirectTargets.has(path))
    failures.push(`${rel} is neither a genuine content page nor a declared redirect`);

// A document can be declared directly on a business binding or inherited from
// the input/output contract of the bound skill. Its page must include both;
// otherwise it can claim "Appears in none" while linking a skill used widely.
const documentBusinesses = new Map(
  graph.nodes
    .filter((node) => node.label === "document")
    .map((node) => [node.id, new Set()]),
);
for (const [businessId, business] of resolvedBusinesses) {
  const bindings = [
    ...(business.skills ?? []),
    ...Object.values(business.geo ?? {}).flatMap((layer) => layer.skills ?? []),
  ];
  for (const binding of bindings) {
    const skill = graphNodes.get(binding.ref)?.data ?? {};
    const documents = new Set([
      ...(binding.documents ?? []),
      ...(skill.inputs ?? []),
      ...(skill.outputs ?? []),
    ]);
    for (const documentId of documents)
      documentBusinesses.get(documentId)?.add(businessId);
  }
}
for (const [documentId, businesses] of documentBusinesses) {
  const path = `/document/${documentId}/`;
  const page = htmlByPath.get(path);
  if (!page) continue;
  const section = page.html.match(/<section id="appears-in">([^]*?)<\/section>/i)?.[1] ?? "";
  const actual = new Set(
    [...section.matchAll(/href="\/business\/([a-z0-9-]+)\/"/g)].map((match) => match[1]),
  );
  const expected = [...businesses].sort();
  const shown = [...actual].sort();
  if (JSON.stringify(shown) !== JSON.stringify(expected))
    failures.push(
      `${page.rel} Appears in lists ${shown.length} businesses; ` +
      `expected ${expected.length} from direct and skill document contracts`,
    );
  const countClaim = `this document appears in ${expected.length} concrete business ` +
    `${expected.length === 1 ? "model" : "models"}`;
  if (!visibleText(page.html).toLowerCase().includes(countClaim))
    failures.push(`${page.rel} document context does not state the expected ${expected.length}-business use`);
}

const sitemapPath = join(DIST, "sitemap.xml");
const sitemap = existsSync(sitemapPath) ? readFileSync(sitemapPath, "utf8") : "";
if (!sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  failures.push("sitemap.xml is missing its UTF-8 XML declaration");
if (!sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'))
  failures.push("sitemap.xml is missing the sitemap protocol namespace");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
  decodeHtml(match[1].trim()),
);
const expectedSitemapUrls = [...contentTypes.keys()]
  .map((path) => `${SITE}${path}`)
  .sort();
const actualSitemapUrls = [...sitemapUrls].sort();
if (JSON.stringify(actualSitemapUrls) !== JSON.stringify(expectedSitemapUrls)) {
  const expected = new Set(expectedSitemapUrls);
  const actual = new Set(actualSitemapUrls);
  const missing = expectedSitemapUrls.filter((url) => !actual.has(url));
  const extra = actualSitemapUrls.filter((url) => !expected.has(url));
  failures.push(
    `sitemap contains ${actualSitemapUrls.length} URLs; expected the exact ` +
    `${expectedSitemapUrls.length}-URL genuine-content set` +
    `${missing.length ? `; missing ${missing.length} (${missing.slice(0, 5).join(", ")})` : ""}` +
    `${extra.length ? `; extra ${extra.length} (${extra.slice(0, 5).join(", ")})` : ""}`,
  );
}
if (new Set(sitemapUrls).size !== sitemapUrls.length)
  failures.push("sitemap.xml contains duplicate URLs");
const sitemapPaths = new Set();
for (const url of sitemapUrls) {
  if (!url.startsWith(`${SITE}/`)) {
    failures.push(`sitemap URL is not canonical for smbwiki.com: ${url}`);
    continue;
  }
  try {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash)
      failures.push(`sitemap URL has a query or fragment: ${url}`);
    sitemapPaths.add(parsed.pathname);
    if (!existsSync(targetFor(parsed.pathname)))
      failures.push(`sitemap URL has no generated page: ${url}`);
  } catch {
    failures.push(`sitemap URL is invalid: ${url}`);
  }
}

const titleOwners = new Map();
const descriptionOwners = new Map();
for (const [path, allowedTypes] of contentTypes) {
  const page = htmlByPath.get(path);
  if (!page) continue;
  const { rel, html } = page;
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const robotsDirectives = metaTags
    .filter((tag) => ["robots", "googlebot"].includes((attribute(tag, "name") ?? "").toLowerCase()))
    .flatMap((tag) => (attribute(tag, "content") ?? "").toLowerCase().split(/[\s,]+/))
    .filter(Boolean);
  if (robotsDirectives.includes("noindex") || robotsDirectives.includes("none"))
    failures.push(`${rel} is genuine content but carries noindex`);
  if (!sitemapPaths.has(path))
    failures.push(`${rel} is genuine content but is missing from sitemap.xml`);

  const canonicalTags = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  if (canonicalTags.length !== 1) {
    failures.push(`${rel} has ${canonicalTags.length} canonical links; expected exactly 1`);
  } else if (attribute(canonicalTags[0], "href") !== `${SITE}${path}`) {
    failures.push(
      `${rel} canonical is ${attribute(canonicalTags[0], "href") ?? "missing"}; ` +
      `expected self-canonical ${SITE}${path}`,
    );
  }

  const titleMatches = [...html.matchAll(/<title\b[^>]*>([^]*?)<\/title>/gi)];
  if (titleMatches.length !== 1) {
    failures.push(`${rel} has ${titleMatches.length} title elements; expected exactly 1`);
  } else {
    const title = cleanText(titleMatches[0][1]);
    const length = [...title].length;
    if (length < TITLE_MIN || length > TITLE_MAX)
      failures.push(
        `${rel} title is ${length} characters; expected ${TITLE_MIN}-${TITLE_MAX}: "${title}"`,
      );
    if (!title.includes("SMBwiki"))
      failures.push(`${rel} title does not use the canonical SMBwiki brand casing: "${title}"`);
    const contentName = contentNames.get(path);
    if (
      contentName &&
      `${contentName} | SMBwiki`.length <= TITLE_MAX &&
      !title.toLocaleLowerCase("en").includes(contentName.toLocaleLowerCase("en"))
    )
      failures.push(`${rel} title drops its full entity name "${contentName}": "${title}"`);
    addToList(titleOwners, title.toLocaleLowerCase("en"), rel);
  }

  const descriptionTags = metaTags.filter(
    (tag) => (attribute(tag, "name") ?? "").toLowerCase() === "description",
  );
  let metaDescriptionText = null;
  if (descriptionTags.length !== 1) {
    failures.push(`${rel} has ${descriptionTags.length} meta descriptions; expected exactly 1`);
  } else {
    const description = cleanText(attribute(descriptionTags[0], "content") ?? "");
    metaDescriptionText = description;
    const length = [...description].length;
    if (length < DESCRIPTION_MIN || length > DESCRIPTION_MAX)
      failures.push(
        `${rel} description is ${length} characters; expected ` +
        `${DESCRIPTION_MIN}-${DESCRIPTION_MAX}: "${description}"`,
      );
    if (!/[.!?…]$/.test(description))
      failures.push(`${rel} description is not a complete sentence: "${description}"`);
    addToList(descriptionOwners, description.toLocaleLowerCase("en"), rel);
  }
  const ogDescriptionTags = metaTags.filter(
    (tag) => (attribute(tag, "property") ?? "").toLowerCase() === "og:description",
  );
  if (ogDescriptionTags.length !== 1) {
    failures.push(`${rel} has ${ogDescriptionTags.length} Open Graph descriptions; expected exactly 1`);
  } else if (cleanText(attribute(ogDescriptionTags[0], "content") ?? "") !== metaDescriptionText) {
    failures.push(`${rel} Open Graph description differs from its meta description`);
  }

  const mainMatches = [...html.matchAll(/<main\b[^>]*>([^]*?)<\/main>/gi)];
  if (mainMatches.length !== 1) {
    failures.push(`${rel} has ${mainMatches.length} main elements; expected exactly 1`);
  } else {
    const h1Matches = [...mainMatches[0][1].matchAll(/<h1\b[^>]*>([^]*?)<\/h1>/gi)];
    if (h1Matches.length !== 1) {
      failures.push(`${rel} has ${h1Matches.length} h1 headings in main; expected exactly 1`);
    } else if (!cleanText(h1Matches[0][1])) {
      failures.push(`${rel} has an empty h1 heading`);
    }
    const context = visibleText(mainMatches[0][1]);
    if ([...context].length < CONTEXT_MIN)
      failures.push(
        `${rel} has only ${[...context].length} visible main-text characters; ` +
        `expected at least ${CONTEXT_MIN} characters of page context`,
      );
    const explanatoryParagraphs = [...mainMatches[0][1].matchAll(/<p\b[^>]*>([^]*?)<\/p>/gi)]
      .map((match) => visibleText(match[1]))
      .filter((text) => [...text].length >= 40);
    if (!explanatoryParagraphs.length)
      failures.push(`${rel} has no explanatory paragraph with at least 40 characters`);
  }

  const jsonLdScripts = [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/gi)]
    .filter((match) => (attribute(match[1], "type") ?? "").toLowerCase() === "application/ld+json");
  if (jsonLdScripts.length !== 1) {
    failures.push(`${rel} has ${jsonLdScripts.length} JSON-LD blocks; expected exactly 1`);
  } else {
    let data;
    try {
      data = JSON.parse(jsonLdScripts[0][2]);
    } catch {
      failures.push(`${rel} has invalid JSON-LD`);
    }
    if (data) {
      const objects = allJsonLdObjects(data);
      if (!objects.some((object) => JSON.stringify(object["@context"] ?? "").includes("schema.org")))
        failures.push(`${rel} JSON-LD is missing a schema.org @context`);
      const typed = !Array.isArray(data) &&
        [...jsonLdTypes(data)].some((type) => allowedTypes.has(type))
        ? data
        : null;
      if (!typed) {
        failures.push(
          `${rel} JSON-LD root has no appropriate type; expected one of ${[...allowedTypes].join(", ")}`,
        );
      } else {
        const label = cleanText(String(typed.headline ?? typed.name ?? ""));
        const description = cleanText(String(typed.description ?? ""));
        if (!label) failures.push(`${rel} JSON-LD is missing a name or headline`);
        if ([...description].length < 30)
          failures.push(`${rel} JSON-LD description has fewer than 30 characters`);
        if (entityPaths.has(path) && description !== metaDescriptionText)
          failures.push(`${rel} JSON-LD description differs from its meta description`);
        let structuredUrl = null;
        try {
          structuredUrl = new URL(String(typed.url ?? "")).href;
        } catch {
          // Report the missing or invalid URL uniformly below.
        }
        const expectedUrl = new URL(`${SITE}${path}`).href;
        if (structuredUrl !== expectedUrl)
          failures.push(`${rel} JSON-LD root URL is ${structuredUrl ?? "missing"}; expected ${expectedUrl}`);
        if (jsonLdTypes(typed).has("Article")) {
          let mainEntityUrl = null;
          try {
            mainEntityUrl = new URL(String(typed.mainEntityOfPage ?? "")).href;
          } catch {
            // Report the missing or invalid main-entity URL uniformly below.
          }
          if (mainEntityUrl !== expectedUrl)
            failures.push(`${rel} Article mainEntityOfPage must be ${expectedUrl}`);
        }
      }
    }
  }
}

for (const [title, owners] of titleOwners)
  if (owners.length > 1)
    failures.push(`duplicate title "${title}" on ${owners.join(", ")}`);
for (const [description, owners] of descriptionOwners)
  if (owners.length > 1)
    failures.push(`duplicate meta description "${description}" on ${owners.join(", ")}`);

for (const [path, target] of redirectTargets) {
  const page = htmlByPath.get(path);
  if (!page) continue;
  const { rel, html } = page;
  if (sitemapPaths.has(path))
    failures.push(`${rel} is a redirect but is present in sitemap.xml`);
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const robotsDirectives = metaTags
    .filter((tag) => ["robots", "googlebot"].includes((attribute(tag, "name") ?? "").toLowerCase()))
    .flatMap((tag) => (attribute(tag, "content") ?? "").toLowerCase().split(/[\s,]+/))
    .filter(Boolean);
  if (!robotsDirectives.includes("noindex") && !robotsDirectives.includes("none"))
    failures.push(`${rel} is a redirect but is missing noindex`);
  const canonicalTags = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  if (canonicalTags.length !== 1 || attribute(canonicalTags[0], "href") !== `${SITE}${target}`)
    failures.push(`${rel} must have exactly one canonical link to ${SITE}${target}`);
  const refreshTags = metaTags.filter(
    (tag) => (attribute(tag, "http-equiv") ?? "").toLowerCase() === "refresh",
  );
  const refreshTarget = refreshTags.length === 1
    ? (attribute(refreshTags[0], "content") ?? "").match(/(?:^|;)\s*url\s*=\s*(.+)\s*$/i)?.[1]
    : null;
  let refreshPath = null;
  try {
    if (refreshTarget) refreshPath = new URL(refreshTarget, `${SITE}${path}`).pathname;
  } catch {
    // Report the invalid or absent refresh uniformly below.
  }
  if (refreshTags.length !== 1 || refreshPath !== target)
    failures.push(`${rel} must have exactly one meta refresh to ${target}`);
}

const robots = existsSync(join(DIST, "robots.txt"))
  ? readFileSync(join(DIST, "robots.txt"), "utf8")
  : "";
if (!robots.includes(`Sitemap: ${SITE}/sitemap.xml`))
  failures.push("robots.txt does not advertise the canonical sitemap URL");

console.log(
  `site files=${files.length} html=${htmlFiles.length} hrefs=${hrefCount} ` +
  `businesses=${uniqueHomeBusinesses.size} api=${businessSources.length} ` +
  `skill_markdown=${skillMarkdown.length} graph_pages=${graphPages} ` +
  `content=${contentTypes.size} redirects=${redirectTargets.size} sitemap=${sitemapUrls.length} ` +
  `failures=${failures.length}`,
);
for (const failure of failures) console.log(`ERROR: ${failure}`);
process.exit(failures.length ? 1 : 0);
