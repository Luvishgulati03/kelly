/*
 * Henry dashboard — memory constellation card (compact mount).
 *
 * All drawing, layout, and interaction live in the ONE shared module
 * (/constellation.js, src/dashboard/constellation.js). This file only mounts
 * it into the dashboard card, feeds it the real /api/memory/graph export, and
 * keeps a small readout in sync — the observatory mounts the same module in
 * its full immersive form, so the two graphs cannot drift apart.
 *
 * Data: GET /api/memory/graph -> { nodes:[{id,label,tier,importance,useCount,…}], edges:[{src,dst,type,weight}] }
 */
(function () {
  'use strict';

  var MAX_NODES = 300;         // top-N by importance; the sky stays readable
  var POLL_MS = 30000;

  var host = document.getElementById('holo-mount');
  var readout = document.getElementById('holo-readout');
  var stats = document.getElementById('holo-stats');
  if (!host || !window.HenryConstellation) return;

  var view = window.HenryConstellation.mount({
    el: host,
    compact: true,
    height: 420,
    stats: stats,
    ariaLabel: 'Memory constellation: Henry memories as stars, typed associations as filaments. ' +
      'Drag to orbit, scroll to zoom, click a star to read it.',
    onSelect: function (node) { renderReadout(node); },
    onHover: function (node) { if (!view.selected()) renderReadout(node); }
  });

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderReadout(node) {
    if (!readout) return;
    if (!node) {
      readout.innerHTML = '<span class="dim">hover or click a star · drag to orbit · wheel to zoom</span>';
      return;
    }
    readout.innerHTML =
      '<b>' + esc(node.ctitle) + '</b>' +
      '<span>tier <i>' + esc(node.tier || 'memory') + '</i></span>' +
      '<span>importance <i>' + (node.cimp || 0).toFixed(2) + '</i></span>' +
      '<span>used <i>' + esc(node.cuse || 0) + '</i></span>' +
      '<span>links <i>' + esc(node.degree || 0) + '</i></span>';
  }

  var signature = null;
  function load() {
    fetch('/api/memory/graph', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var raw = (data && data.nodes) || [];
        var sig = raw.length + ':' + (((data && data.edges) || []).length);
        if (sig === signature) return;
        signature = sig;
        var nodes = raw.slice().sort(function (a, b) {
          return (Number(b.importance) || 0) - (Number(a.importance) || 0);
        }).slice(0, MAX_NODES);
        var kept = {};
        nodes.forEach(function (n) { kept[n.id] = true; });
        var edges = ((data && data.edges) || []).filter(function (e) { return e && kept[e.src] && kept[e.dst]; });
        view.setData({ nodes: nodes, edges: edges });
        // Honest empty state — never invent stars to look impressive.
        view.setEmpty(nodes.length ? '' :
          'No memories indexed yet. Run `henry memory index` to populate the constellation.');
      })
      .catch(function () {
        view.setData({ nodes: [], edges: [] });
        view.setEmpty('Memory graph unavailable — the dashboard will retry.');
      });
  }

  renderReadout(null);
  load();
  setInterval(function () { if (!document.hidden) load(); }, POLL_MS);
}());
