/* ==========================================================================
   Research database — search, faceting and sorting.

   Everything here runs against window.RESEARCH_DATA, which is baked into
   /assets/research-data.js at build time from data/library.json. No network
   requests are made from this page.
   ========================================================================== */

(function () {
  'use strict';

  var DATA = window.RESEARCH_DATA || [];

  var state = {
    q: '',
    sort: 'best',
    types: new Set(),
    tags: new Set(),
    institutions: new Set(),
    years: new Set(),
  };

  /* --- Search index ------------------------------------------------------- */

  // Weighted so a title hit outranks a passing mention in an abstract.
  // threshold 0.35 tolerates typos without drifting into noise at this corpus
  // size; ignoreLocation lets a match land anywhere in a long abstract.
  var fuse = new Fuse(DATA, {
    keys: [
      { name: 'title', weight: 0.45 },
      { name: 'creators', weight: 0.2 },
      { name: 'tags', weight: 0.15 },
      { name: 'publication', weight: 0.1 },
      { name: 'abstract', weight: 0.1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2,
    includeScore: true,
  });

  /* --- Helpers ------------------------------------------------------------ */

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ESCAPES[c];
    });
  }

  /**
   * Sort key for a record. Prefers the real Publication Date, falls back to
   * the free-text Date field, then to the year alone so undated items still
   * land in roughly the right place instead of at the very bottom.
   */
  function dateVal(d) {
    var t = Date.parse(d.publicationDate || d.date);
    if (!isNaN(t)) return t;
    var y = parseInt(d.year, 10);
    return y ? Date.UTC(y, 0, 1) : 0;
  }

  function bestLink(d) {
    return d.url || (d.doi ? 'https://doi.org/' + d.doi : '');
  }

  /* --- Facets ------------------------------------------------------------- */

  // Counts are computed once over the whole dataset, so a facet's number is
  // "how many entries carry this value", not "how many survive the current
  // filters". That keeps the sidebar stable as you click through it.
  function countBy(getter) {
    var m = new Map();
    DATA.forEach(function (d) {
      getter(d).forEach(function (v) {
        m.set(v, (m.get(v) || 0) + 1);
      });
    });
    return Array.from(m.entries()).sort(function (a, b) {
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  }

  var FACETS = {
    types: countBy(function (d) {
      return d.type ? [d.type] : [];
    }),
    tags: countBy(function (d) {
      return d.tags || [];
    }),
    // `institutions` is a real array in the JSON, so multi-institution entries
    // face correctly even when an institution name contains a comma.
    institutions: countBy(function (d) {
      return d.institutions || [];
    }),
    years: countBy(function (d) {
      return d.year ? [d.year] : [];
    }).sort(function (a, b) {
      return b[0].localeCompare(a[0]);
    }),
  };

  function facetItem(group, value, count) {
    return (
      '<label class="facet-item">' +
      '<input type="checkbox" data-group="' + esc(group) + '" value="' + esc(value) + '">' +
      '<span>' + esc(value) + '</span>' +
      '<span class="cnt">' + count + '</span>' +
      '</label>'
    );
  }

  function facetGroup(label, group, list, limit) {
    var shown = limit ? list.slice(0, limit) : list;
    var extra = limit ? list.slice(limit) : [];

    var html = '<div class="facet"><h4>' + esc(label) + '</h4><div class="facet-list">';
    html += shown
      .map(function (e) {
        return facetItem(group, e[0], e[1]);
      })
      .join('');

    if (extra.length) {
      html +=
        '<div class="facet-extra" data-extra="' + esc(group) + '">' +
        extra
          .map(function (e) {
            return facetItem(group, e[0], e[1]);
          })
          .join('') +
        '</div>';
    }
    html += '</div>';

    if (extra.length) {
      html +=
        '<button type="button" class="link-btn" data-show-more="' + esc(group) + '" ' +
        'aria-expanded="false">+ ' + extra.length + ' more</button>';
    }
    return html + '</div>';
  }

  function renderFacets() {
    var el = document.getElementById('facets');
    el.innerHTML =
      facetGroup('Item type', 'types', FACETS.types) +
      facetGroup('Tags', 'tags', FACETS.tags, 10) +
      facetGroup('Institution', 'institutions', FACETS.institutions, 8) +
      facetGroup('Year', 'years', FACETS.years) +
      '<button type="button" class="link-btn" id="clearAll">Clear all filters</button>';

    el.addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb.matches('input[type=checkbox]')) return;
      var set = state[cb.dataset.group];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      render();
    });

    el.addEventListener('click', function (ev) {
      var more = ev.target.closest('[data-show-more]');
      if (more) {
        var extra = el.querySelector('[data-extra="' + more.dataset.showMore + '"]');
        var open = extra.classList.toggle('open');
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open
          ? 'Show less'
          : '+ ' + extra.querySelectorAll('.facet-item').length + ' more';
        return;
      }
      if (ev.target.id === 'clearAll') clearAll();
    });
  }

  function clearAll() {
    ['types', 'tags', 'institutions', 'years'].forEach(function (k) {
      state[k].clear();
    });
    document.querySelectorAll('#facets input[type=checkbox]').forEach(function (cb) {
      cb.checked = false;
    });
    render();
  }

  /* --- Filtering ---------------------------------------------------------- */

  function filtered() {
    var q = state.q.trim();
    var items;
    var rank = null;

    if (q) {
      var hits = fuse.search(q);
      // Remember Fuse's ordering so "Best match" can restore it after the
      // facet pass; lower score is a better match.
      rank = new Map();
      hits.forEach(function (h, i) {
        rank.set(h.item.id, i);
      });
      items = hits.map(function (h) {
        return h.item;
      });
    } else {
      items = DATA.slice();
    }

    // Facets are OR within a group, AND across groups.
    items = items.filter(function (d) {
      if (state.types.size && !state.types.has(d.type)) return false;
      if (state.years.size && !state.years.has(d.year)) return false;
      if (
        state.tags.size &&
        !(d.tags || []).some(function (t) {
          return state.tags.has(t);
        })
      ) {
        return false;
      }
      if (
        state.institutions.size &&
        !(d.institutions || []).some(function (i) {
          return state.institutions.has(i);
        })
      ) {
        return false;
      }
      return true;
    });

    var sort = state.sort;
    // "Best match" is only meaningful while there is a query; with an empty
    // box it means the same thing as newest first.
    if (sort === 'best' && !rank) sort = 'newest';

    if (sort === 'best') {
      items.sort(function (a, b) {
        return rank.get(a.id) - rank.get(b.id);
      });
    } else if (sort === 'title') {
      items.sort(function (a, b) {
        return a.title.localeCompare(b.title);
      });
    } else {
      items.sort(function (a, b) {
        var av = dateVal(a);
        var bv = dateVal(b);
        // A handful of entries carry no date at all. Park them at the bottom
        // either way — under "Oldest first" they would otherwise take the top
        // of the list and look like a bug.
        if (!av !== !bv) return av ? -1 : 1;
        var diff = av - bv;
        return sort === 'oldest' ? diff : -diff;
      });
    }

    return items;
  }

  /* --- Rendering ---------------------------------------------------------- */

  function renderChips() {
    var chips = [];
    ['types', 'tags', 'institutions', 'years'].forEach(function (k) {
      state[k].forEach(function (v) {
        chips.push([k, v]);
      });
    });

    var el = document.getElementById('chips');
    el.innerHTML = chips
      .map(function (c) {
        return (
          '<span class="chip">' + esc(c[1]) +
          '<button type="button" data-k="' + esc(c[0]) + '" data-v="' + esc(c[1]) + '" ' +
          'aria-label="Remove filter ' + esc(c[1]) + '">&times;</button></span>'
        );
      })
      .join('');
  }

  function card(d) {
    var link = bestLink(d);
    var meta = [d.creators, d.publication, d.date].filter(Boolean);
    var title = esc(d.title);

    return (
      '<article class="card">' +
      '<div class="card-top">' +
      '<div class="card-title">' +
      (link
        ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + title + '</a>'
        : title) +
      '</div>' +
      (d.type ? '<span class="type-badge">' + esc(d.type) + '</span>' : '') +
      '</div>' +
      (meta.length
        ? '<div class="card-meta">' +
          meta.map(esc).join(' <span class="sep">&middot;</span> ') +
          '</div>'
        : '') +
      (d.abstract
        ? '<div class="abstract">' + esc(d.abstract) + '</div>' +
          '<button type="button" class="abstract-toggle" aria-expanded="false">Read abstract</button>'
        : '') +
      '<div class="card-bottom">' +
      '<div class="tag-list">' +
      (d.tags || [])
        .map(function (t) {
          return '<span class="tag">' + esc(t) + '</span>';
        })
        .join('') +
      (d.institution ? '<span class="tag">' + esc(d.institution) + '</span>' : '') +
      '</div>' +
      (link
        ? '<a class="card-link" href="' + esc(link) + '" target="_blank" rel="noopener">View ' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M7 17L17 7M8 7h9v9"/></svg></a>'
        : '') +
      '</div>' +
      '</article>'
    );
  }

  function renderResults() {
    var items = filtered();
    document.getElementById('count').textContent =
      items.length === DATA.length
        ? DATA.length + ' entries'
        : items.length + ' of ' + DATA.length + ' entries';

    var el = document.getElementById('results');
    el.innerHTML = items.length
      ? items.map(card).join('')
      : '<div class="empty">No results match your filters.</div>';
  }

  function render() {
    renderChips();
    renderResults();
  }

  /* --- Wiring ------------------------------------------------------------- */

  function init() {
    renderFacets();

    var search = document.getElementById('search');
    var timer;
    search.addEventListener('input', function (e) {
      // Fuzzy search over ~200 abstracts is cheap but not free; a short debounce
      // keeps typing smooth on slower machines.
      clearTimeout(timer);
      var value = e.target.value;
      timer = setTimeout(function () {
        state.q = value;
        render();
      }, 120);
    });

    document.getElementById('sort').addEventListener('change', function (e) {
      state.sort = e.target.value;
      render();
    });

    // Delegated so it survives every re-render of the results list.
    document.getElementById('results').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.abstract-toggle');
      if (!btn) return;
      var abs = btn.previousElementSibling;
      var expanded = abs.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', String(expanded));
      btn.textContent = expanded ? 'Show less' : 'Read abstract';
    });

    document.getElementById('chips').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-k]');
      if (!btn) return;
      state[btn.dataset.k].delete(btn.dataset.v);
      var cb = document.querySelector(
        '#facets input[data-group="' + btn.dataset.k + '"][value="' +
          btn.dataset.v.replace(/["\\]/g, '\\$&') + '"]'
      );
      if (cb) cb.checked = false;
      render();
    });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
