// Interactive relationship map on entity pages. Cytoscape + Dagre are
// vendored classic scripts and loaded only when the map nears the viewport.
(() => {
  const canvas = document.getElementById("opcanvas");
  const dataEl = document.getElementById("opgraph-data");
  if (!canvas || !dataEl) return;
  const DATA = JSON.parse(dataEl.textContent);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }
  let vendorPromise;
  function ensureVendors() {
    if (!vendorPromise) {
      vendorPromise = loadScript("/static/vendor/cytoscape.min.js")
        .then(() => loadScript("/static/vendor/dagre.min.js"))
        .then(() => loadScript("/static/vendor/cytoscape-dagre.js"));
    }
    return vendorPromise;
  }

  const INK = "#202122", MUTED = "#72777d",
    HAIR = "#9aa0a6", BLUE = "#0645ad";
  const FILL = {
    business: "#ffffff", skill: "#ffffff", document: "#ffffff", role: "#ffffff",
    metric: "#ffffff", software: "#ffffff", license: "#ffffff", market: "#ffffff",
  };

  // Business maps start with the business and its skills. Other entity maps
  // show the bounded direct neighborhood supplied by the generator.
  const expanded = new Set();

  function visibleElements() {
    const nodes = [], edges = [], present = new Set();
    for (const n of DATA.nodes) {
      const keep = n.initial || n.focus ||
        [...expanded].some((p) => DATA.edges.some((e) => e.s === p && e.t === n.id));
      if (keep) { present.add(n.id); nodes.push({ data: n }); }
    }
    for (const e of DATA.edges)
      if (present.has(e.s) && present.has(e.t))
        edges.push({ data: {
          id: e.s + "->" + e.t + ":" + e.kind,
          source: e.s,
          target: e.t,
          kind: e.kind,
          label: DATA.mode === "entity" ? e.label : "",
        } });
    return { nodes, edges };
  }

  function layout(cy, fitAfter = false) {
    if (fitAfter) cy.one("layoutstop", () => cy.fit(undefined, 24));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    cy.layout({
      name: "dagre",
      rankDir: "LR",
      nodeSep: 18,
      rankSep: DATA.mode === "entity" ? 92 : 70,
      animate: !reduceMotion,
      animationDuration: reduceMotion ? 0 : 250,
      fit: false,
    }).run();
  }

  async function start() {
    await ensureVendors();
    // Node labels were capped at 150px with no text-max-width, so any name
    // past roughly 24 characters was cut off. Size the box to its text and
    // let anything longer wrap onto another line instead.
    const CHAR = 6.2, LINE = 14, MAX_W = 230;
    const nodeBox = (n) => {
      const name = String(n.data("name") ?? "");
      const sub = String(n.data("sub") ?? "");
      const w = Math.max(70, Math.min(MAX_W, Math.max(name.length, sub.length) * CHAR));
      const rows = Math.ceil((name.length * CHAR) / w) + (sub ? Math.ceil((sub.length * CHAR) / w) : 0);
      return { w, h: Math.max(18, Math.max(1, rows) * LINE) };
    };
    const cy = window.cytoscape({
      container: canvas,
      elements: visibleElements(),
      style: [
        { selector: "node", style: {
          shape: "round-rectangle",
          width: (n) => nodeBox(n).w,
          height: (n) => nodeBox(n).h,
          "text-max-width": (n) => nodeBox(n).w + "px",
          "padding-top": "6px", "padding-bottom": "6px",
          "padding-left": "9px", "padding-right": "9px",
          "background-color": (n) => FILL[n.data("kind")] ?? "#fff",
          "border-width": 1, "border-color": HAIR,
          label: (n) => n.data("sub") ? n.data("name") + "\n" + n.data("sub") : n.data("name"),
          "text-wrap": "wrap", "line-height": 1.25, "font-size": 11, color: INK,
          "text-valign": "center", "text-halign": "center",
          "font-family": '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        } },
        { selector: "node[shared = 1]", style: { "background-color": "#f8f9fa", "border-width": 1.5 } },
        { selector: "node[url]", style: { color: BLUE } },
        { selector: "node[related = 1]", style: { color: BLUE, "border-style": "dashed", "border-color": BLUE } },
        { selector: "node[focus = 1]", style: {
          "background-color": INK, color: "#fff", "font-size": 12.5,
          "border-color": INK,
        } },
        { selector: "edge", style: {
          width: 1.1, "line-color": HAIR, "curve-style": "bezier",
          "target-arrow-shape": "triangle", "target-arrow-color": HAIR, "arrow-scale": 0.8,
          label: "data(label)", "font-size": 9, color: MUTED,
          "text-background-color": "#ffffff", "text-background-opacity": 0.92,
          "text-background-padding": 2,
        } },
        { selector: 'edge[kind = "consumes"]', style: { "line-style": "dashed" } },
        { selector: 'edge[kind = "geo"]', style: { "line-style": "dotted" } },
        { selector: 'edge[kind = "related"]', style: { "line-style": "dashed", "line-color": BLUE, "target-arrow-shape": "none", opacity: 0.55 } },
      ],
    });
    cy.fit(undefined, 24);
    const readableZoom = canvas.clientWidth < 600 ? 0.8 : 0.72;
    if (cy.nodes().length > 14 && cy.zoom() < readableZoom) {
      cy.zoom(readableZoom);
      cy.center(cy.getElementById(DATA.focusId));
    }

    cy.on("tap", "node", (ev) => {
      const n = ev.target, id = n.id(), kind = n.data("kind");
      if (DATA.mode === "business" && kind === "skill" && !n.data("focus")) {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        const { nodes, edges } = visibleElements();
        const keep = new Set(nodes.map((x) => x.data.id));
        cy.nodes().forEach((x) => { if (!keep.has(x.id())) x.remove(); });
        const have = new Set(cy.nodes().map((x) => x.id()));
        cy.add(nodes.filter((x) => !have.has(x.data.id)));
        const haveE = new Set(cy.edges().map((x) => x.id()));
        cy.add(edges.filter((x) => !haveE.has(x.data.id)));
        layout(cy);
      } else if (n.data("url")) {
        window.location.href = n.data("url");
      }
    });

    document.querySelectorAll(".op-tools button").forEach((b) => {
      b.addEventListener("click", () => {
        const z = b.dataset.z;
        if (z === "in") cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } });
        else if (z === "out") cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } });
        else if (z === "fit") cy.fit(undefined, 24);
        else if (z === "all" && DATA.mode === "business") {
          const every = DATA.nodes.filter((n) => n.kind === "skill").map((n) => n.id);
          if (expanded.size === every.length) expanded.clear();
          else every.forEach((id) => expanded.add(id));
          const { nodes, edges } = visibleElements();
          cy.elements().remove();
          cy.add(nodes); cy.add(edges);
          layout(cy, true);
        }
      });
    });
    return cy;
  }

  let started = false, startPromise = null;
  const ensure = () => {
    if (!started) {
      started = true;
      startPromise = start().catch((error) => {
        canvas.textContent = "The interactive map could not load. The linked relationship list remains available below.";
        canvas.classList.add("graph-error");
        throw error;
      });
    }
    return startPromise;
  };
  window.__smbwikiEnsureGraph = ensure; // programmatic hook, BOMwiki-style
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !started) {
      io.disconnect();
      ensure();
    }
  }, { rootMargin: "200px" });
  io.observe(canvas);
})();
