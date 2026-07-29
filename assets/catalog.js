// Homepage catalog filter. Progressive enhancement: the index ships complete
// and scannable, and this only narrows it. Every row carries a data-k key of
// its name, sector, NAICS code, revenue streams, and skill names.
(function () {
  "use strict";
  var shell = document.querySelector(".catalog-filter");
  var input = document.getElementById("catalog-q");
  var status = document.querySelector(".filter-status");
  var empty = document.querySelector(".filter-empty");
  var sectors = [].slice.call(document.querySelectorAll(".business-sector"));
  if (!shell || !input || !status || !empty || !sectors.length) return;

  var rows = sectors.map(function (sector) {
    return {
      sector: sector,
      items: [].slice.call(sector.querySelectorAll("li")).map(function (li) {
        return { li: li, key: li.getAttribute("data-k") || "" };
      }),
    };
  });
  var total = rows.reduce(function (n, group) { return n + group.items.length; }, 0);

  var norm = function (value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  };

  // A term matches on substring. "pizza" does not occur inside "pizzeria",
  // so a search that finds nothing retries on word stems before giving up.
  var STEM = 4;
  var anywhere = function (key, term) { return key.indexOf(term) !== -1; };
  // Stems only match where a word starts, so "dent" finds dental work and not
  // every residential trade.
  var wordStart = function (key, term) {
    return key.lastIndexOf(term, 0) === 0 || key.indexOf(" " + term) !== -1;
  };
  function paint(terms, match) {
    var shown = 0;
    rows.forEach(function (group) {
      var visible = 0;
      group.items.forEach(function (item) {
        var hit = terms.every(function (term) { return match(item.key, term); });
        item.li.hidden = !hit;
        if (hit) visible += 1;
      });
      group.sector.hidden = visible === 0;
      shown += visible;
    });
    return shown;
  }

  function apply(query) {
    var terms = norm(query).split(" ").filter(Boolean);
    // Whole words first, then anywhere in the key, then stems. Precision
    // before recall, so "fast food" does not drag in bed-and-breakfast.
    var shown = paint(terms, wordStart);
    if (!shown) shown = paint(terms, anywhere);
    var stemmed = false;
    if (!shown && terms.length && terms.every(function (t) { return t.length > STEM; })) {
      var stems = terms.map(function (t) { return t.slice(0, STEM); });
      shown = paint(stems, wordStart);
      stemmed = shown > 0;
    }
    empty.hidden = shown !== 0;
    status.hidden = !terms.length || !shown;
    if (status.hidden) {
      status.textContent = "";
      return;
    }
    status.textContent = shown + (shown === 1 ? " business type" : " business types")
      + (stemmed ? " close to that" : " of " + total);
  }

  var pending;
  input.addEventListener("input", function () {
    clearTimeout(pending);
    var value = input.value;
    pending = setTimeout(function () { apply(value); }, 60);
  });
  input.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !input.value) return;
    input.value = "";
    apply("");
  });
  [].slice.call(shell.querySelectorAll("button[data-q]")).forEach(function (button) {
    button.addEventListener("click", function () {
      input.value = button.getAttribute("data-q");
      apply(input.value);
      input.focus();
    });
  });

  shell.hidden = false;
  if (input.value) apply(input.value); // browser-restored value on reload
})();
