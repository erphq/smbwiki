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
if (uniqueHomeBusinesses.size !== businessSources.length)
  failures.push(
    `homepage links to ${uniqueHomeBusinesses.size} unique businesses; ` +
    `expected ${businessSources.length}`,
  );
const skillSources = readdirSync(join(ROOT, "definitions", "skills"))
  .filter((file) => file.endsWith(".yaml"))
  .map((file) => yaml.load(readFileSync(join(ROOT, "definitions", "skills", file), "utf8")));
for (const business of businessSources) {
  const buildPath = join(ROOT, "build", "resolved", `${business.id}.json`);
  const publicPath = join(DIST, "api", "def", `${business.id}.json`);
  if (!existsSync(buildPath) || !existsSync(publicPath)) {
    failures.push(`${business.id} is missing a generated definition artifact`);
    continue;
  }
  const built = JSON.stringify(JSON.parse(readFileSync(buildPath, "utf8")));
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
const sitemapPath = join(DIST, "sitemap.xml");
const sitemap = existsSync(sitemapPath) ? readFileSync(sitemapPath, "utf8") : "";
if (!sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  failures.push("sitemap.xml is missing its UTF-8 XML declaration");
if (!sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'))
  failures.push("sitemap.xml is missing the sitemap protocol namespace");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const expectedSitemapUrls = [
  `${SITE}/`,
  ...businessSources.map((business) => `${SITE}/business/${business.id}/`),
  ...skillSources.map((skill) => `${SITE}/skill/${skill.id}/`),
].sort();
const actualSitemapUrls = [...sitemapUrls].sort();
if (JSON.stringify(actualSitemapUrls) !== JSON.stringify(expectedSitemapUrls))
  failures.push(
    `sitemap contains ${actualSitemapUrls.length} URLs; expected the exact ` +
    `${expectedSitemapUrls.length}-URL homepage, business, and skill set`,
  );
if (new Set(sitemapUrls).size !== sitemapUrls.length)
  failures.push("sitemap.xml contains duplicate URLs");
for (const url of sitemapUrls) {
  if (!url.startsWith(`${SITE}/`)) {
    failures.push(`sitemap URL is not canonical for smbwiki.com: ${url}`);
    continue;
  }
  if (!existsSync(targetFor(new URL(url).pathname)))
    failures.push(`sitemap URL has no generated page: ${url}`);
}
const indexablePaths = new Set(sitemapUrls.map((url) => new URL(url).pathname));
for (const file of htmlFiles) {
  const rel = relative(DIST, file);
  const html = readFileSync(file, "utf8");
  const pagePath = rel === "index.html"
    ? "/"
    : `/${dirname(rel).split("\\").join("/")}/`;
  const hasNoindex = /<meta name="robots" content="noindex">/.test(html);
  if (indexablePaths.has(pagePath) && hasNoindex)
    failures.push(`${rel} is in the sitemap but carries noindex`);
  if (!indexablePaths.has(pagePath) && !hasNoindex)
    failures.push(`${rel} is outside the sitemap but is missing noindex`);
}

const robots = existsSync(join(DIST, "robots.txt"))
  ? readFileSync(join(DIST, "robots.txt"), "utf8")
  : "";
if (!robots.includes(`Sitemap: ${SITE}/sitemap.xml`))
  failures.push("robots.txt does not advertise the canonical sitemap URL");

console.log(
  `site files=${files.length} html=${htmlFiles.length} hrefs=${hrefCount} ` +
  `businesses=${uniqueHomeBusinesses.size} api=${businessSources.length} ` +
  `skill_markdown=${skillMarkdown.length} graph_pages=${graphPages} sitemap=${sitemapUrls.length} ` +
  `failures=${failures.length}`,
);
for (const failure of failures) console.log(`ERROR: ${failure}`);
process.exit(failures.length ? 1 : 0);
