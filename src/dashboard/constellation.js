/*
 * Henry — shared memory constellation renderer.
 *
 * ONE implementation, two mount points: the dashboard card (compact, via
 * holo.js) and the memory observatory (full immersive view with inspector).
 * Both call HenryConstellation.mount(); neither owns any drawing code, so the
 * two graphs cannot drift apart again.
 *
 * Served by server.ts at /constellation.js as a plain asset (same pattern as
 * holo.js) so backticks / ${...} here can never break a template literal.
 *
 * Rendering brief (constellation-spec.md): a night sky you can read. Small
 * crisp stars (1.2-2.6px ordinary, 4-5px hubs), hairline filaments (0.55px,
 * alpha 0.05-0.10 idle), no shadowBlur on edges, sparse small pulses, depth
 * fog, a faint static star-field, labels only for hubs and the selection.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- palette
  var TYPES = [
    { key: 'communication', label: 'Communication', color: '#35efc3', rgb: [53, 239, 195] },
    { key: 'projects', label: 'Projects', color: '#26e6ff', rgb: [38, 230, 255] },
    { key: 'knowledge', label: 'Knowledge', color: '#4e7dff', rgb: [78, 125, 255] },
    { key: 'people', label: 'People', color: '#8d5cff', rgb: [141, 92, 255] },
    { key: 'routines', label: 'Routines', color: '#ff4fd8', rgb: [255, 79, 216] },
    { key: 'decisions', label: 'Decisions', color: '#ffc857', rgb: [255, 200, 87] }
  ];
  var TYPE_BY_KEY = {};
  for (var ti = 0; ti < TYPES.length; ti++) TYPE_BY_KEY[TYPES[ti].key] = TYPES[ti];

  // Rendering constants — the spec's numbers live here and nowhere else.
  var R_MIN = 1.2, R_MAX = 2.6, R_HUB_MIN = 3.8, R_HUB_MAX = 5.0;
  var EDGE_W_IDLE = 0.55, EDGE_W_ACTIVE = 0.8, EDGE_W_FOCUS = 1.15;
  var EDGE_A_MIN = 0.05, EDGE_A_MAX = 0.1, EDGE_A_ACTIVE = 0.28, EDGE_A_FOCUS = 0.55;
  var BLUR_STAR = 6, BLUR_HUB = 10;
  var PULSE_MAX = 16, PULSE_R_MIN = 1.0, PULSE_R_MAX = 1.6;
  var STARFIELD_DENSITY = 1 / 5200;   // static backdrop points per css pixel^2
  var ZOOM_MIN = 0.5, ZOOM_MAX = 3.1;
  var PITCH_LIMIT = 1.05;
  var CAM_NEAR = 1.25, CAM_FAR = 3.5;  // submerge 1 .. 0
  var FOCAL = 620;
  var ORBIT_RATE = (Math.PI * 2) / 150000; // one very slow revolution / 150s
  var LABEL_MAX = 26;

  var reduceMotion = false;
  try {
    reduceMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { reduceMotion = false; }

  // ----------------------------------------------------------------- utils
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
  }
  function rnd(id, salt) { return hash32(id + '#' + salt); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a < 0 ? 0 : a > 1 ? 1 : a).toFixed(3) + ')'; }
  function shorten(value, max) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  /*
   * Node type from real engram data — GraphExport carries tier/topic/source/
   * emotion, not a UI category, so the six constellation families are derived.
   * A host may override by setting node.ctype before setData().
   */
  function classify(node) {
    if (node.ctype && TYPE_BY_KEY[node.ctype]) return node.ctype;
    var store = String(node.store || '').toLowerCase();
    if (store === 'knowledge' || store === 'retrieval') return store === 'knowledge' ? 'knowledge' : 'routines';
    var hay = (String(node.source || '') + ' ' + String(node.topic || '') + ' ' + String(node.group || '') + ' ' +
      String(node.label || node.title || '')).toLowerCase();
    var tier = String(node.tier || '').toLowerCase();
    if (/decision|decided|chose|trade-?off|verdict/.test(hay)) return 'decisions';
    if (/telegram|chat|email|gmail|message|standup|call|thread|reply/.test(hay)) return 'communication';
    if (/person|people|contact|@|recruiter|founder|friend|family/.test(hay)) return 'people';
    if (/routine|schedule|habit|daily|weekly|cron|workflow|reminder/.test(hay) || tier === 'procedural') return 'routines';
    if (/project|repo|build|ship|feature|sprint|task|job|application/.test(hay)) return 'projects';
    if (tier === 'semantic') return 'knowledge';
    if (tier === 'episodic') return 'communication';
    return 'projects';
  }

  // Six type anchors spread over a sphere so each family reads as its own
  // constellation instead of one undifferentiated cloud.
  var ANCHORS = (function () {
    var out = [], n = TYPES.length, ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      // Half-step avoids pinning the first and last families to the poles,
      // where projection collapses a whole cluster into a vertical stack.
      var y = 1 - ((i + 0.5) / n) * 2;
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var th = i * ga;
      out.push([Math.cos(th) * r, y * 0.72, Math.sin(th) * r]);
    }
    return out;
  }());

  function basisFor(a) {
    // Any vector not parallel to `a` gives a stable orthonormal pair.
    var up = Math.abs(a[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    var b1 = [a[1] * up[2] - a[2] * up[1], a[2] * up[0] - a[0] * up[2], a[0] * up[1] - a[1] * up[0]];
    var l1 = Math.hypot(b1[0], b1[1], b1[2]) || 1;
    b1 = [b1[0] / l1, b1[1] / l1, b1[2] / l1];
    var b2 = [a[1] * b1[2] - a[2] * b1[1], a[2] * b1[0] - a[0] * b1[2], a[0] * b1[1] - a[1] * b1[0]];
    return [b1, b2];
  }
  var BASES = ANCHORS.map(basisFor);

  // ------------------------------------------------------------------- CSS
  var CSS = [
    '.hmc{--hmc-line:rgba(155,190,255,.18);--hmc-text:#eef7ff;--hmc-muted:#8aa4bf;--hmc-cyan:#26e6ff;',
    'position:relative;display:grid;gap:12px;color:var(--hmc-text);',
    "font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}",
    '.hmc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}',
    '.hmc-hero{position:relative;border:1px solid var(--hmc-line);border-radius:18px;overflow:hidden;',
    'background:radial-gradient(120% 90% at 18% 6%,rgba(38,230,255,.10),transparent 58%),',
    'radial-gradient(110% 90% at 84% 12%,rgba(141,92,255,.12),transparent 60%),',
    'radial-gradient(120% 120% at 50% 108%,rgba(78,125,255,.10),transparent 62%),',
    'linear-gradient(180deg,#07111f,#030912)}',
    '.hmc-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;outline:none}',
    '.hmc-canvas:active{cursor:grabbing}',
    '.hmc-canvas:focus-visible{outline:2px solid var(--hmc-cyan);outline-offset:-3px}',
    '.hmc-overlay{position:absolute;inset:0;pointer-events:none}',
    '.hmc-chips{position:absolute;top:12px;left:12px;display:flex;gap:6px;flex-wrap:wrap}',
    '.hmc-chip{display:flex;align-items:baseline;gap:6px;padding:5px 9px;border:1px solid var(--hmc-line);',
    'border-radius:999px;background:rgba(9,20,38,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
    '.hmc-chip i{font-style:normal;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--hmc-muted);',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.hmc-chip b{font-size:11px;font-weight:600;color:var(--hmc-text)}',
    '.hmc-compass{position:absolute;top:12px;right:12px;width:70px;height:70px;border-radius:50%;',
    'border:1px solid var(--hmc-line);background:rgba(9,20,38,.55);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
    '.hmc-hint{position:absolute;left:14px;bottom:12px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;',
    'color:var(--hmc-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:52%}',
    '.hmc-sub{position:absolute;right:12px;bottom:12px;pointer-events:auto;display:grid;gap:5px;padding:9px 11px;',
    'border:1px solid var(--hmc-line);border-radius:13px;background:rgba(9,20,38,.72);',
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);width:172px}',
    '.hmc-sub label{display:flex;justify-content:space-between;font-size:9px;letter-spacing:.16em;text-transform:uppercase;',
    'color:var(--hmc-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.hmc-sub input[type=range]{width:100%;accent-color:var(--hmc-cyan);height:16px;margin:0}',
    '.hmc-sub input:focus-visible{outline:2px solid var(--hmc-cyan);outline-offset:2px}',
    '.hmc-empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;',
    'padding:24px;color:var(--hmc-muted);font-size:12px;line-height:1.6}',
    '.hmc-empty.on{display:flex}',
    '.hmc-legend{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center}',
    '.hmc-legend span{display:inline-flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.12em;',
    'text-transform:uppercase;color:var(--hmc-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.hmc-legend i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}',
    '.hmc-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.hmc-btn{min-height:42px;display:inline-flex;align-items:center;gap:7px;padding:0 13px;border-radius:11px;',
    'border:1px solid var(--hmc-line);background:linear-gradient(180deg,rgba(12,28,52,.62),rgba(9,20,38,.72));',
    'color:var(--hmc-muted);font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;',
    'text-transform:uppercase;cursor:pointer;transition:color .15s,border-color .15s,background .15s}',
    '.hmc-btn:hover{color:var(--hmc-text);border-color:rgba(38,230,255,.45)}',
    '.hmc-btn:focus-visible{outline:2px solid var(--hmc-cyan);outline-offset:2px}',
    '.hmc-btn[aria-pressed=true]{color:#07111f;background:linear-gradient(180deg,#4ceaff,#26c6ff);border-color:transparent;font-weight:700}',
    '.hmc-btn.icon{padding:0;width:42px;justify-content:center;font-size:13px}',
    '.hmc-select{min-height:42px;padding:0 11px;border-radius:11px;border:1px solid var(--hmc-line);',
    'background:rgba(9,20,38,.72);color:var(--hmc-text);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.hmc-select:focus-visible{outline:2px solid var(--hmc-cyan);outline-offset:2px}',
    '.hmc-pad{display:inline-grid;grid-template-columns:repeat(3,32px);grid-auto-rows:26px;gap:2px}',
    '.hmc-pad .hmc-btn{min-height:26px;width:32px;padding:0;justify-content:center;border-radius:7px;font-size:11px}',
    '.hmc-insp{display:grid;gap:14px;align-content:start}',
    '.hmc-insp-head{display:flex;gap:10px;align-items:flex-start}',
    '.hmc-orb{width:11px;height:11px;border-radius:50%;margin-top:5px;flex:none;background:var(--orb,#26e6ff);',
    'box-shadow:0 0 12px var(--orb,#26e6ff)}',
    '.hmc-insp h4{margin:0;font-size:14px;font-weight:600;letter-spacing:-.01em;line-height:1.35}',
    '.hmc-insp-meta{margin-top:3px;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em;',
    'text-transform:uppercase;color:var(--hmc-muted)}',
    '.hmc-insp p{margin:0;font-size:12.5px;line-height:1.65;color:#c8d9ef}',
    '.hmc-tags{display:flex;flex-wrap:wrap;gap:6px}',
    '.hmc-tag{padding:3px 9px;border-radius:999px;border:1px solid var(--hmc-line);background:rgba(12,28,52,.62);',
    'font:9.5px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--hmc-muted)}',
    '.hmc-sect{display:grid;gap:8px}',
    '.hmc-sect-label{display:flex;justify-content:space-between;align-items:baseline;gap:10px;',
    'font:9.5px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--hmc-muted)}',
    '.hmc-sect-label strong{color:var(--hmc-cyan);font-weight:600}',
    '.hmc-bar{display:grid;grid-template-columns:64px 1fr 38px;gap:9px;align-items:center;font-size:11px;color:var(--hmc-muted)}',
    '.hmc-bar div{height:4px;border-radius:99px;background:rgba(155,190,255,.12);overflow:hidden}',
    '.hmc-bar div span{display:block;height:100%;border-radius:99px;width:var(--w,0%);background:var(--c,#26e6ff)}',
    '.hmc-bar b{font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--hmc-text);text-align:right;font-weight:500}',
    '.hmc-rel{display:flex;align-items:center;gap:9px;padding:7px 0;border-top:1px solid rgba(155,190,255,.1)}',
    '.hmc-rel:first-child{border-top:0}',
    '.hmc-rel i{width:6px;height:6px;border-radius:50%;flex:none;background:var(--orb,#26e6ff);box-shadow:0 0 7px var(--orb,#26e6ff)}',
    '.hmc-rel span{flex:1;min-width:0;font-size:11.5px;color:#c8d9ef;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hmc-rel b{font:9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em;text-transform:uppercase;',
    'color:var(--hmc-muted);border:1px solid var(--hmc-line);border-radius:999px;padding:2px 7px;font-weight:500;white-space:nowrap}',
    '.hmc-note{font-size:11px;line-height:1.6;color:var(--hmc-muted)}',
    '@media (prefers-reduced-motion:reduce){.hmc-btn{transition:none}}'
  ].join('');

  function injectStyles(doc) {
    if (doc.getElementById('hmc-styles')) return;
    var style = doc.createElement('style');
    style.id = 'hmc-styles';
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------------ shell
  function buildShell(host, opts) {
    var doc = host.ownerDocument;
    injectStyles(doc);
    host.classList.add('hmc');
    var compact = Boolean(opts.compact);
    var height = opts.height || (compact ? 420 : 560);
    if (typeof height === 'number') height = height + 'px';
    host.innerHTML =
      '<div class="hmc-hero" data-hmc="hero" style="height:' + height + '">' +
        '<canvas class="hmc-canvas" data-hmc="canvas" tabindex="0"></canvas>' +
        '<div class="hmc-overlay">' +
          '<div class="hmc-chips" data-hmc="chips">' +
            '<span class="hmc-chip"><i>mode</i><b data-hmc="mode">orbit</b></span>' +
            '<span class="hmc-chip"><i>focus</i><b data-hmc="focus">none</b></span>' +
            '<span class="hmc-chip"><i>depth</i><b data-hmc="depth">0%</b></span>' +
          '</div>' +
          '<canvas class="hmc-compass" data-hmc="compass" width="140" height="140" aria-hidden="true"></canvas>' +
          '<div class="hmc-hint" data-hmc="hint">drag to orbit · wheel to zoom · click a star</div>' +
          '<div class="hmc-sub">' +
            '<label for="' + opts.idPrefix + '-sub"><span>submerge</span><span data-hmc="subval">0%</span></label>' +
            '<input id="' + opts.idPrefix + '-sub" data-hmc="submerge" type="range" min="0" max="100" value="0" ' +
              'aria-label="Submerge into the lattice">' +
          '</div>' +
          '<div class="hmc-empty" data-hmc="empty" role="status"></div>' +
        '</div>' +
      '</div>' +
      '<div class="hmc-legend" data-hmc="legend"></div>' +
      '<div class="hmc-controls" data-hmc="controls"></div>';

    var q = function (name) { return host.querySelector('[data-hmc="' + name + '"]'); };
    var legend = q('legend');
    var html = '';
    for (var i = 0; i < TYPES.length; i++) {
      html += '<span style="color:' + TYPES[i].color + '"><i></i>' + esc(TYPES[i].label) + '</span>';
    }
    legend.innerHTML = html;

    var controls = q('controls');
    controls.innerHTML =
      '<button class="hmc-btn" type="button" data-hmc="pulse" aria-pressed="' + (reduceMotion ? 'false' : 'true') + '">recall pulse</button>' +
      '<button class="hmc-btn" type="button" data-hmc="orbit" aria-pressed="false">auto-orbit</button>' +
      '<button class="hmc-btn" type="button" data-hmc="inside" aria-pressed="false">inside view</button>' +
      '<button class="hmc-btn" type="button" data-hmc="reset">reset view</button>' +
      (compact ? '' :
        '<select class="hmc-select" data-hmc="relation" aria-label="Relationship view">' +
          '<option value="focus">Focused neighbourhood</option>' +
          '<option value="all">All relationships</option>' +
          '<option value="similar">Similarity</option>' +
          '<option value="temporal_next">Temporal</option>' +
          '<option value="caused">Caused / lesson</option>' +
        '</select>') +
      '<span class="hmc-pad">' +
        '<span></span><button class="hmc-btn" type="button" data-hmc="up" aria-label="Orbit up">↑</button><span></span>' +
        '<button class="hmc-btn" type="button" data-hmc="left" aria-label="Orbit left">←</button>' +
        '<button class="hmc-btn" type="button" data-hmc="down" aria-label="Orbit down">↓</button>' +
        '<button class="hmc-btn" type="button" data-hmc="right" aria-label="Orbit right">→</button>' +
      '</span>' +
      '<button class="hmc-btn icon" type="button" data-hmc="zoomin" aria-label="Zoom in">+</button>' +
      '<button class="hmc-btn icon" type="button" data-hmc="zoomout" aria-label="Zoom out">−</button>';
    return q;
  }

  // ------------------------------------------------------------------ mount
  var mountSeq = 0;

  function mount(options) {
    var opts = options || {};
    var host = opts.el;
    if (!host || !host.ownerDocument) return null;
    opts.idPrefix = 'hmc' + (++mountSeq);
    var q = buildShell(host, opts);
    var hero = q('hero');
    var canvas = q('canvas');
    if (!canvas.getContext) return null;
    var ctx = canvas.getContext('2d');
    var compass = q('compass');
    var cctx = compass.getContext('2d');
    var emptyEl = q('empty');
    canvas.setAttribute('aria-label', opts.ariaLabel ||
      'Memory constellation: an interactive star map of Henry memory nodes and their associations. ' +
      'Drag to orbit, scroll to zoom, click a star to inspect it.');

    var S = {
      nodes: [], edges: [], byId: {},
      w: 0, h: 0, dpr: 1,
      yaw: 0.55, pitch: 0.28, zoom: 1, submerge: 0,
      autoOrbit: false, pulsesOn: !reduceMotion,
      relation: 'focus', edgeTypes: null, filter: null,
      selectedId: null, hoveredId: null, highlight: null,
      hubThreshold: 6, empty: true, emptyMessage: '',
      raf: null, last: 0, dragging: false, moved: 0, px: 0, py: 0,
      lastClickAt: 0, lastClickId: null,
      stars: [], starCount: 0, grad: null, vignette: null,
      order: [], pulses: []
    };

    // -------------------------------------------------------------- data
    function setData(payload) {
      var rawNodes = (payload && payload.nodes) || [];
      var rawEdges = (payload && payload.edges) || [];
      var nodes = [], byId = {}, i;
      for (i = 0; i < rawNodes.length; i++) {
        var src = rawNodes[i];
        if (!src || src.id == null) continue;
        var n = src;                                  // hosts may share objects
        n.id = String(n.id);
        n.ctype = classify(n);
        n.ctitle = shorten(n.title || n.label || '(memory)', 64);
        n.cimp = clamp(num(n.importance, 0.4) > 1 ? num(n.importance, 4) / 10 : num(n.importance, 0.4), 0, 1);
        n.cuse = Math.max(0, num(n.useCount != null ? n.useCount : n.usage, 0));
        n.degree = 0;
        n.activation = num(n.activation, 0);
        nodes.push(n);
        byId[n.id] = n;
      }
      var edges = [];
      for (i = 0; i < rawEdges.length; i++) {
        var e = rawEdges[i];
        if (!e) continue;
        var a = byId[String(e.src != null ? e.src : e.from)];
        var b = byId[String(e.dst != null ? e.dst : e.to)];
        if (!a || !b || a === b) continue;
        edges.push({
          a: a, b: b,
          type: String(e.type || e.kind || 'related'),
          w: clamp(num(e.weight, 0.35), 0.02, 1)
        });
        a.degree++; b.degree++;
      }
      // Hub cut-off: top ~8% by degree, never below 4 edges.
      var degrees = [];
      for (i = 0; i < nodes.length; i++) degrees.push(nodes[i].degree);
      degrees.sort(function (x, y) { return y - x; });
      var cut = degrees.length ? degrees[Math.min(degrees.length - 1, Math.floor(degrees.length * 0.08))] : 4;
      S.hubThreshold = Math.max(4, cut);
      for (i = 0; i < nodes.length; i++) nodes[i].hub = nodes[i].degree >= S.hubThreshold;

      layout(nodes);
      S.nodes = nodes; S.edges = edges; S.byId = byId;
      S.empty = nodes.length === 0;
      S.order.length = 0;
      for (i = 0; i < nodes.length; i++) S.order.push(i);
      seedPulses();
      if (S.selectedId && !byId[S.selectedId]) S.selectedId = null;
      updateChips();
      requestDraw();
      return api;
    }

    /* Deterministic 3D layout. Type anchors keep related memories recognisable,
     * while a per-node global direction prevents dense families collapsing into
     * one unreadable knot as the graph grows. Same id -> same stable star. */
    function layout(list) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        var idx = TYPE_BY_KEY[n.ctype] ? TYPES.indexOf(TYPE_BY_KEY[n.ctype]) : 1;
        var a = ANCHORS[idx], bs = BASES[idx];
        var u = rnd(n.id, 'u'), v = rnd(n.id, 'v'), w = rnd(n.id, 'w');
        var spread = 0.5 + (1 - n.cimp) * 0.42;
        var th = u * Math.PI * 2, rr = Math.sqrt(v) * spread;
        var gy = 1 - 2 * rnd(n.id, 'gy');
        var gr = Math.sqrt(Math.max(0, 1 - gy * gy));
        var gth = rnd(n.id, 'gth') * Math.PI * 2;
        var gx = Math.cos(gth) * gr, gz = Math.sin(gth) * gr;
        var cluster = 0.62, globalSpread = 0.78;
        var dx = a[0] * cluster + bs[0][0] * Math.cos(th) * rr + bs[1][0] * Math.sin(th) * rr + gx * globalSpread;
        var dy = a[1] * cluster + bs[0][1] * Math.cos(th) * rr + bs[1][1] * Math.sin(th) * rr + gy * globalSpread;
        var dz = a[2] * cluster + bs[0][2] * Math.cos(th) * rr + bs[1][2] * Math.sin(th) * rr + gz * globalSpread;
        var len = Math.hypot(dx, dy, dz) || 1;
        var shell = 0.64 + (1 - n.cimp) * 0.34 + w * 0.26;
        n.wx = (dx / len) * shell;
        n.wy = (dy / len) * shell * 0.86;
        n.wz = (dz / len) * shell;
        n.tw = 0.6 + rnd(n.id, 't') * 0.4;   // per-star twinkle phase weight
      }
    }

    function seedPulses() {
      S.pulses.length = 0;
      if (!S.edges.length) return;
      var count = Math.min(PULSE_MAX, Math.max(3, Math.round(S.edges.length / 18)));
      for (var i = 0; i < count; i++) {
        S.pulses.push({ e: (i * 7919) % S.edges.length, t: i / count, v: 0.00016 + rnd(String(i), 'p') * 0.00022 });
      }
    }

    // -------------------------------------------------------- projection
    function camDist() { return CAM_FAR - S.submerge * (CAM_FAR - CAM_NEAR); }

    function project(n) {
      var cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
      var rx = n.wx * cy + n.wz * sy;
      var rz = -n.wx * sy + n.wz * cy;
      var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
      var ry = n.wy * cp - rz * sp;
      var rz2 = n.wy * sp + rz * cp;
      var cam = camDist();
      var zc = cam - rz2;
      if (zc < 0.22) zc = 0.22;
      var s = FOCAL * S.zoom / zc;
      // Wide canvases should use their width. A spherical projection otherwise
      // occupies only a central square and makes dense labels fight for pixels.
      var aspectStretch = clamp((S.w / Math.max(1, S.h)) * 0.72, 1, 1.9);
      n.sx = S.w / 2 + rx * s * aspectStretch;
      n.sy = S.h / 2 - ry * s;
      n.zc = zc;
      n.pscale = zc > 0 ? (cam / zc) : 1;
      n.depth = clamp((cam + 1.1 - zc) / 2.2, 0, 1);   // 0 = far, 1 = near
    }

    function radiusFor(n) {
      var base;
      if (n.hub) base = R_HUB_MIN + (R_HUB_MAX - R_HUB_MIN) * n.cimp;
      else base = R_MIN + (R_MAX - R_MIN) * (0.45 * n.cimp + 0.55 * Math.min(1, Math.log(n.cuse + 1) / Math.LN2 / 6));
      return base * clamp(n.pscale * (0.82 + 0.28 * n.depth), 0.5, 2.0);
    }

    function visible(n) {
      if (S.filter && !S.filter(n)) return false;
      return true;
    }

    // ----------------------------------------------------------- sizing
    function resize() {
      var rect = hero.getBoundingClientRect();
      var w = Math.max(240, Math.round(rect.width));
      var h = Math.max(200, Math.round(rect.height));
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      if (w === S.w && h === S.h && dpr === S.dpr) return;
      S.w = w; S.h = h; S.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildBackdrop();
      requestDraw();
    }

    // Static caches rebuilt only on resize — nothing here allocates per frame.
    function buildBackdrop() {
      var g = ctx.createLinearGradient(0, 0, 0, S.h);
      g.addColorStop(0, '#07111f');
      g.addColorStop(1, '#030912');
      S.grad = g;
      var v = ctx.createRadialGradient(S.w / 2, S.h / 2, Math.min(S.w, S.h) * 0.28,
        S.w / 2, S.h / 2, Math.max(S.w, S.h) * 0.78);
      v.addColorStop(0, 'rgba(3,9,18,0)');
      v.addColorStop(1, 'rgba(3,9,18,0.92)');
      S.vignette = v;
      var want = Math.round(S.w * S.h * STARFIELD_DENSITY);
      S.starCount = Math.min(260, want);
      S.stars.length = 0;
      for (var i = 0; i < S.starCount; i++) {
        S.stars.push({
          x: rnd('star' + i, 'x') * S.w,
          y: rnd('star' + i, 'y') * S.h,
          r: 0.4 + rnd('star' + i, 'r') * 0.7,
          a: 0.03 + rnd('star' + i, 'a') * 0.07
        });
      }
    }

    // ---------------------------------------------------------- drawing
    function edgeShown(ed, sel) {
      if (S.edgeTypes && !S.edgeTypes.has(ed.type)) return false;
      if (!visible(ed.a) || !visible(ed.b)) return false;
      var mode = S.relation;
      if (mode === 'focus') {
        if (!sel) return true;
        return ed.a === sel || ed.b === sel;
      }
      if (mode === 'all') return true;
      if (mode === 'caused') return ed.type === 'caused' || ed.type === 'lesson_from';
      return ed.type === mode;
    }

    function draw(now) {
      if (!S.w) resize();
      var i, n;
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      ctx.fillStyle = S.grad;
      ctx.fillRect(0, 0, S.w, S.h);

      // 1. faint static star-field, well behind the graph
      ctx.fillStyle = '#dbe9ff';
      for (i = 0; i < S.stars.length; i++) {
        var st = S.stars[i];
        ctx.globalAlpha = st.a;
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 6.283185); ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (S.empty) { drawCompass(); return; }

      var sel = S.selectedId ? S.byId[S.selectedId] : null;
      var hov = S.hoveredId ? S.byId[S.hoveredId] : null;
      var nodes = S.nodes;
      for (i = 0; i < nodes.length; i++) project(nodes[i]);

      // 2. edges — hairline filaments, never with shadowBlur
      ctx.shadowBlur = 0;
      for (i = 0; i < S.edges.length; i++) {
        var ed = S.edges[i];
        if (!edgeShown(ed, sel)) continue;
        var a = ed.a, b = ed.b;
        var focused = sel && (a === sel || b === sel);
        var hovered = hov && (a === hov || b === hov);
        var act = Math.max(a.activation || 0, b.activation || 0);
        var lit = S.highlight ? (S.highlight[a.id] && S.highlight[b.id]) : false;
        var depth = (a.depth + b.depth) * 0.5;
        var alpha, width, col;
        if (focused || hovered) {
          alpha = EDGE_A_FOCUS; width = EDGE_W_FOCUS;
          col = TYPE_BY_KEY[(focused ? sel : hov).ctype].rgb;
        } else if (lit || act > 0.2) {
          alpha = EDGE_A_ACTIVE; width = EDGE_W_ACTIVE;
          col = TYPE_BY_KEY[a.ctype].rgb;
        } else {
          alpha = (EDGE_A_MIN + ed.w * (EDGE_A_MAX - EDGE_A_MIN)) * (0.55 + 0.45 * depth);
          if (sel) alpha *= 0.6;
          width = EDGE_W_IDLE;
          col = [150, 185, 235];
        }
        if (alpha < 0.012) continue;
        ctx.strokeStyle = rgba(col, alpha);
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        // A very gentle sag keeps parallel filaments from stacking into a bar.
        ctx.quadraticCurveTo((a.sx + b.sx) / 2, (a.sy + b.sy) / 2 + (a.zc - b.zc) * 5, b.sx, b.sy);
        ctx.stroke();
      }

      // 3. travelling pulses — signal, not traffic
      if (S.pulsesOn && !reduceMotion) {
        for (i = 0; i < S.pulses.length; i++) {
          var p = S.pulses[i];
          var pe = S.edges[p.e];
          if (!pe || !edgeShown(pe, sel)) continue;
          var t = p.t;
          var px = pe.a.sx + (pe.b.sx - pe.a.sx) * t;
          var py = pe.a.sy + (pe.b.sy - pe.a.sy) * t;
          var pf = sel && (pe.a === sel || pe.b === sel);
          ctx.fillStyle = rgba(TYPE_BY_KEY[pe.a.ctype].rgb, pf ? 0.85 : 0.4);
          ctx.shadowBlur = pf ? 6 : 0;
          ctx.shadowColor = pf ? TYPE_BY_KEY[pe.a.ctype].color : 'transparent';
          ctx.beginPath();
          ctx.arc(px, py, PULSE_R_MIN + (PULSE_R_MAX - PULSE_R_MIN) * pe.w, 0, 6.283185);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      }

      // 4. stars — painter's order, far to near
      S.order.sort(byDepth);
      for (i = 0; i < S.order.length; i++) {
        n = nodes[S.order[i]];
        if (!n || !visible(n)) continue;
        drawStar(n, n === sel, n === hov, now);
      }

      // 5. labels — hubs and the selection only, with screen-space collision
      // avoidance. Label boxes also participate in hit-testing, so readable text
      // remains clickable even when the star itself is tiny.
      ctx.font = '10px ui-monospace,SFMono-Regular,Menlo,monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      var labelled = 0, boxes = [];
      for (i = 0; i < nodes.length; i++) nodes[i].labelBox = null;
      for (i = S.order.length - 1; i >= 0; i--) {
        n = nodes[S.order[i]];
        if (!n || !visible(n)) continue;
        var must = n === sel || n === hov;
        if (!must && (!n.hub || labelled >= 12 || n.depth < 0.35)) continue;
        var label = shorten(n.ctitle, LABEL_MAX);
        var width = ctx.measureText(label).width;
        var radius = radiusFor(n), gap = radius + 7;
        var candidates = [[n.sx + gap, n.sy], [n.sx - gap - width, n.sy], [n.sx + gap, n.sy - 14], [n.sx - gap - width, n.sy + 14]];
        var box = null;
        for (var ci = 0; ci < candidates.length; ci++) {
          var candidate = { x: candidates[ci][0] - 3, y: candidates[ci][1] - 8, w: width + 6, h: 16 };
          if (candidate.x < 4 || candidate.y < 4 || candidate.x + candidate.w > S.w - 4 || candidate.y + candidate.h > S.h - 4) continue;
          var overlaps = false;
          for (var bi = 0; bi < boxes.length; bi++) {
            var other = boxes[bi];
            if (candidate.x < other.x + other.w + 5 && candidate.x + candidate.w + 5 > other.x && candidate.y < other.y + other.h + 4 && candidate.y + candidate.h + 4 > other.y) { overlaps = true; break; }
          }
          if (!overlaps || must) { box = candidate; break; }
        }
        if (!box) continue;
        boxes.push(box); n.labelBox = box;
        if (!must) labelled++;
        ctx.fillStyle = 'rgba(3,9,18,' + (must ? '0.82' : '0.52') + ')';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = rgba(must ? [238, 247, 255] : [180, 205, 235], must ? 0.96 : 0.30 + n.depth * 0.28);
        ctx.fillText(label, box.x + 3, box.y + box.h / 2);
      }

      // 6. fog / vignette — deepens as the camera submerges
      ctx.globalAlpha = 0.42 + S.submerge * 0.34;
      ctx.fillStyle = S.vignette;
      ctx.fillRect(0, 0, S.w, S.h);
      ctx.globalAlpha = 1;

      drawCompass();
    }

    function byDepth(x, y) { return S.nodes[x].zc - S.nodes[y].zc; }

    function drawStar(n, isSel, isHov, now) {
      var type = TYPE_BY_KEY[n.ctype] || TYPES[1];
      var r = radiusFor(n);
      var lit = isSel || isHov;
      var hi = S.highlight ? S.highlight[n.id] : 0;
      var act = Math.max(n.activation || 0, hi ? (hi === 2 ? 1 : 0.55) : 0);
      var fade = S.highlight && !hi && !lit ? 0.22 : 1;
      // Depth grading: far stars smaller, dimmer, cooler; near stars brighter.
      var alpha = (0.34 + n.depth * 0.58) * fade;
      var tw = reduceMotion ? 1 : 0.92 + 0.08 * Math.sin(now * 0.0011 + n.tw * 9);

      if (lit || isSel) {
        // Soft halo ring for the selection — gradient, low alpha, no hard glow.
        var hr = r * 5.2;
        var g = ctx.createRadialGradient(n.sx, n.sy, r, n.sx, n.sy, hr);
        g.addColorStop(0, rgba(type.rgb, 0.22));
        g.addColorStop(1, rgba(type.rgb, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, hr, 0, 6.283185); ctx.fill();
        ctx.strokeStyle = rgba(type.rgb, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 5, 0, 6.283185); ctx.stroke();
      }

      // Most stars are a plain filled arc with no shadow at all.
      var wantsGlow = n.hub || lit || act > 0.25;
      if (wantsGlow) {
        ctx.shadowColor = type.color;
        ctx.shadowBlur = n.hub || lit ? BLUR_HUB : BLUR_STAR;
      }
      ctx.fillStyle = rgba(type.rgb, clamp(alpha * tw + act * 0.3, 0.05, 1));
      ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, 6.283185); ctx.fill();
      if (wantsGlow) ctx.shadowBlur = 0;

      // Tight bright core, small falloff.
      if (r > 1.5 || lit) {
        ctx.fillStyle = rgba([245, 251, 255], clamp((0.2 + n.depth * 0.5) * fade, 0, 0.9));
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 0.38, 0, 6.283185); ctx.fill();
      }
    }

    function drawCompass() {
      var c = 70, cx = c, cy = c;
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, 140, 140);
      cctx.strokeStyle = 'rgba(155,190,255,0.22)';
      cctx.lineWidth = 2;
      cctx.beginPath(); cctx.moveTo(cx - 46, cy); cctx.lineTo(cx + 46, cy); cctx.stroke();
      cctx.beginPath(); cctx.moveTo(cx, cy - 46); cctx.lineTo(cx, cy + 46); cctx.stroke();
      cctx.strokeStyle = 'rgba(38,230,255,0.35)';
      cctx.beginPath(); cctx.arc(cx, cy, 40, 0, 6.283185); cctx.stroke();
      // Heading needle follows the orbit yaw; the tilt shifts the centre dot.
      var hx = cx + Math.sin(S.yaw) * 34, hy = cy - Math.cos(S.yaw) * 34 * Math.cos(S.pitch);
      cctx.strokeStyle = 'rgba(38,230,255,0.85)';
      cctx.lineWidth = 3;
      cctx.beginPath(); cctx.moveTo(cx, cy); cctx.lineTo(hx, hy); cctx.stroke();
      cctx.shadowColor = '#26e6ff'; cctx.shadowBlur = 10;
      cctx.fillStyle = '#8ef4ff';
      cctx.beginPath(); cctx.arc(cx, cy - S.pitch * 16, 5, 0, 6.283185); cctx.fill();
      cctx.shadowBlur = 0;
    }

    // ------------------------------------------------------------- loop
    function needsAnimation() {
      if (reduceMotion) return false;
      return S.autoOrbit || S.pulsesOn;
    }
    function frame(ts) {
      S.raf = null;
      if (host.ownerDocument.hidden) return;
      var now = ts || performance.now();
      var dt = S.last ? Math.min(80, now - S.last) : 16;
      S.last = now;
      if (S.autoOrbit && !S.dragging && !reduceMotion) S.yaw += ORBIT_RATE * dt * 1000;
      if (S.pulsesOn && !reduceMotion) {
        for (var i = 0; i < S.pulses.length; i++) {
          var p = S.pulses[i];
          p.t += p.v * dt;
          if (p.t > 1) { p.t = 0; p.e = (p.e + 13) % Math.max(1, S.edges.length); }
        }
      }
      draw(now);
      if (needsAnimation()) S.raf = requestAnimationFrame(frame);
    }
    function requestDraw() {
      if (S.raf != null) return;
      if (needsAnimation()) { S.raf = requestAnimationFrame(frame); return; }
      S.raf = requestAnimationFrame(function (ts) { S.raf = null; S.last = 0; draw(ts || performance.now()); });
    }

    // ------------------------------------------------------------- HUD
    function updateChips() {
      var sel = S.selectedId ? S.byId[S.selectedId] : null;
      q('mode').textContent = S.autoOrbit ? 'auto-orbit' : (S.submerge > 0.5 ? 'inside' : 'orbit');
      q('focus').textContent = sel ? shorten(sel.ctitle, 18) : 'none';
      q('depth').textContent = Math.round(S.submerge * 100) + '%';
      q('subval').textContent = Math.round(S.submerge * 100) + '%';
      if (opts.stats) {
        opts.stats.textContent = S.nodes.length + ' node' + (S.nodes.length === 1 ? '' : 's') +
          ' · ' + S.edges.length + ' relationship' + (S.edges.length === 1 ? '' : 's') + ' · live';
      }
    }

    function setEmpty(message) {
      S.emptyMessage = message || '';
      emptyEl.textContent = S.emptyMessage;
      emptyEl.classList.toggle('on', Boolean(S.emptyMessage));
      requestDraw();
    }

    // ------------------------------------------------------- interaction
    function localPoint(evt) {
      var rect = canvas.getBoundingClientRect();
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    }
    function hitTest(pt) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < S.nodes.length; i++) {
        var n = S.nodes[i];
        if (n.sx == null || !visible(n)) continue;
        var lb = n.labelBox;
        if (lb && pt.x >= lb.x && pt.x <= lb.x + lb.w && pt.y >= lb.y && pt.y <= lb.y + lb.h) return n;
        var dx = n.sx - pt.x, dy = n.sy - pt.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var reach = Math.max(9, radiusFor(n) * 2.2);
        if (d <= reach && d < bestD) { best = n; bestD = d; }
      }
      return best;
    }
    function select(id, quiet) {
      S.selectedId = id || null;
      updateChips();
      requestDraw();
      if (!quiet && opts.onSelect) opts.onSelect(S.selectedId ? S.byId[S.selectedId] : null, api);
      return api;
    }

    canvas.addEventListener('pointerdown', function (evt) {
      S.dragging = true; S.moved = 0; S.px = evt.clientX; S.py = evt.clientY;
      try { canvas.setPointerCapture(evt.pointerId); } catch (e) { /* capture unsupported */ }
    });
    canvas.addEventListener('pointermove', function (evt) {
      if (S.dragging) {
        var dx = evt.clientX - S.px, dy = evt.clientY - S.py;
        S.px = evt.clientX; S.py = evt.clientY;
        S.moved += Math.abs(dx) + Math.abs(dy);
        S.yaw += dx * 0.0055;
        S.pitch = clamp(S.pitch + dy * 0.0045, -PITCH_LIMIT, PITCH_LIMIT);
        requestDraw();
        return;
      }
      var hit = hitTest(localPoint(evt));
      var id = hit ? hit.id : null;
      if (id !== S.hoveredId) {
        S.hoveredId = id;
        canvas.style.cursor = id ? 'pointer' : 'grab';
        if (opts.onHover) opts.onHover(hit, api);
        requestDraw();
      }
    });
    function endDrag(evt) {
      if (!S.dragging) return;
      var moved = S.moved;
      S.dragging = false;
      if (evt) { try { canvas.releasePointerCapture(evt.pointerId); } catch (e) { /* already released */ } }
      if (moved < 6 && evt) {
        var hit = hitTest(localPoint(evt));
        var now = Date.now();
        if (hit && S.lastClickId === hit.id && now - S.lastClickAt < 380) {
          // double-click dives toward the star
          setSubmerge(Math.min(1, S.submerge + 0.34));
          S.zoom = clamp(S.zoom * 1.25, ZOOM_MIN, ZOOM_MAX);
        }
        S.lastClickId = hit ? hit.id : null;
        S.lastClickAt = now;
        select(hit ? (S.selectedId === hit.id ? null : hit.id) : null);
      }
      requestDraw();
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', function () { S.dragging = false; });
    canvas.addEventListener('pointerleave', function () {
      if (S.hoveredId) { S.hoveredId = null; requestDraw(); }
    });
    canvas.addEventListener('wheel', function (evt) {
      evt.preventDefault();
      S.zoom = clamp(S.zoom * (1 - evt.deltaY * 0.0014), ZOOM_MIN, ZOOM_MAX);
      requestDraw();
    }, { passive: false });
    canvas.addEventListener('keydown', function (evt) {
      var step = 0.12;
      if (evt.key === 'ArrowLeft') S.yaw -= step;
      else if (evt.key === 'ArrowRight') S.yaw += step;
      else if (evt.key === 'ArrowUp') S.pitch = clamp(S.pitch - step, -PITCH_LIMIT, PITCH_LIMIT);
      else if (evt.key === 'ArrowDown') S.pitch = clamp(S.pitch + step, -PITCH_LIMIT, PITCH_LIMIT);
      else if (evt.key === '+' || evt.key === '=') S.zoom = clamp(S.zoom * 1.15, ZOOM_MIN, ZOOM_MAX);
      else if (evt.key === '-') S.zoom = clamp(S.zoom / 1.15, ZOOM_MIN, ZOOM_MAX);
      else if (evt.key === 'Escape') { select(null); return; }
      else return;
      evt.preventDefault();
      requestDraw();
    });

    function setSubmerge(value) {
      S.submerge = clamp(value, 0, 1);
      var slider = q('submerge');
      if (slider) slider.value = String(Math.round(S.submerge * 100));
      var insideBtn = q('inside');
      if (insideBtn) insideBtn.setAttribute('aria-pressed', String(S.submerge > 0.5));
      updateChips();
      requestDraw();
    }

    q('submerge').addEventListener('input', function (evt) { setSubmerge(Number(evt.target.value) / 100); });
    q('reset').addEventListener('click', function () { resetView(); });
    q('orbit').addEventListener('click', function (evt) {
      S.autoOrbit = !S.autoOrbit && !reduceMotion;
      evt.currentTarget.setAttribute('aria-pressed', String(S.autoOrbit));
      updateChips();
      S.last = 0;
      requestDraw();
    });
    q('pulse').addEventListener('click', function (evt) {
      S.pulsesOn = !S.pulsesOn && !reduceMotion;
      evt.currentTarget.setAttribute('aria-pressed', String(S.pulsesOn));
      S.last = 0;
      requestDraw();
    });
    q('inside').addEventListener('click', function () { setSubmerge(S.submerge > 0.5 ? 0 : 0.78); });
    q('zoomin').addEventListener('click', function () { S.zoom = clamp(S.zoom * 1.18, ZOOM_MIN, ZOOM_MAX); requestDraw(); });
    q('zoomout').addEventListener('click', function () { S.zoom = clamp(S.zoom / 1.18, ZOOM_MIN, ZOOM_MAX); requestDraw(); });
    q('left').addEventListener('click', function () { S.yaw -= 0.22; requestDraw(); });
    q('right').addEventListener('click', function () { S.yaw += 0.22; requestDraw(); });
    q('up').addEventListener('click', function () { S.pitch = clamp(S.pitch - 0.16, -PITCH_LIMIT, PITCH_LIMIT); requestDraw(); });
    q('down').addEventListener('click', function () { S.pitch = clamp(S.pitch + 0.16, -PITCH_LIMIT, PITCH_LIMIT); requestDraw(); });
    var relationSelect = q('relation');
    if (relationSelect) {
      relationSelect.addEventListener('change', function (evt) {
        S.relation = evt.target.value;
        if (opts.onRelation) opts.onRelation(S.relation);
        requestDraw();
      });
    }

    function resetView() {
      S.yaw = 0.55; S.pitch = 0.28; S.zoom = 1;
      S.autoOrbit = false;
      q('orbit').setAttribute('aria-pressed', 'false');
      setSubmerge(0);
      select(null);
      if (opts.onReset) opts.onReset();
      return api;
    }

    var ro = null;
    if (global.ResizeObserver) {
      ro = new global.ResizeObserver(function () { resize(); });
      ro.observe(hero);
    } else {
      global.addEventListener('resize', resize);
    }
    host.ownerDocument.addEventListener('visibilitychange', function () {
      if (!host.ownerDocument.hidden) { S.last = 0; requestDraw(); }
    });

    // --------------------------------------------------------------- api
    var api = {
      state: S,
      types: TYPES,
      setData: setData,
      setEmpty: setEmpty,
      select: function (id) { return select(id); },
      selected: function () { return S.selectedId ? S.byId[S.selectedId] : null; },
      neighbours: function (id) { return neighbours(id); },
      setHighlight: function (seeds, activated) {
        if (!seeds && !activated) { S.highlight = null; requestDraw(); return api; }
        var map = {};
        (activated || []).forEach(function (x) { map[x] = 1; });
        (seeds || []).forEach(function (x) { map[x] = 2; });
        S.highlight = map;
        requestDraw();
        return api;
      },
      setFilter: function (fn) { S.filter = fn || null; requestDraw(); return api; },
      setEdgeTypes: function (set) { S.edgeTypes = set || null; requestDraw(); return api; },
      setRelation: function (mode) {
        S.relation = mode;
        if (relationSelect) relationSelect.value = mode;
        requestDraw();
        return api;
      },
      redraw: function () { requestDraw(); return api; },
      resize: resize,
      resetView: resetView,
      renderInspector: function (el, node) { return renderInspector(el, node, api); },
      reduceMotion: reduceMotion,
      destroy: function () {
        if (ro) ro.disconnect();
        if (S.raf != null) cancelAnimationFrame(S.raf);
        S.raf = null;
      }
    };

    function neighbours(id) {
      var out = [];
      for (var i = 0; i < S.edges.length; i++) {
        var ed = S.edges[i];
        if (ed.a.id === id) out.push({ node: ed.b, edge: ed });
        else if (ed.b.id === id) out.push({ node: ed.a, edge: ed });
      }
      out.sort(function (x, y) { return y.edge.w - x.edge.w; });
      return out;
    }

    resize();
    updateChips();
    requestDraw();
    return api;
  }

  /*
   * Shared inspector renderer — used by BOTH mounts so the panel cannot drift
   * either. Recall-blend bars are a client-side preview derived from the real
   * node fields (importance / use count / activation); they are labelled as
   * such rather than presented as server-side scores.
   */
  function renderInspector(el, node, instance) {
    if (!el) return;
    if (!node) {
      el.className = 'hmc-insp';
      el.innerHTML = '<div class="hmc-note">Click any star to inspect its tier, importance, description, ' +
        'and the relationships that activate with it.</div>';
      return;
    }
    var type = TYPE_BY_KEY[node.ctype] || TYPES[1];
    var rel = instance ? instance.neighbours(node.id).slice(0, 6) : [];
    var lexical = clamp(0.24 + Math.min(0.6, (node.cuse || 0) / 40), 0, 1);
    var vector = clamp(0.38 + (node.cimp || 0) * 0.55, 0, 1);
    var graph = clamp(0.2 + Math.min(0.7, (node.degree || 0) / 12), 0, 1);
    var tags = [];
    if (node.tier) tags.push(node.tier);
    if (node.topic) tags.push(node.topic);
    if (node.emotion) tags.push(node.emotion);
    if (node.store) tags.push(node.store);
    tags.push(type.label.toLowerCase());
    if (node.archived) tags.push('archived');

    function bar(name, value, color) {
      return '<div class="hmc-bar"><span>' + esc(name) + '</span>' +
        '<div><span style="--w:' + Math.round(value * 100) + '%;--c:' + color + '"></span></div>' +
        '<b>' + value.toFixed(2) + '</b></div>';
    }
    el.className = 'hmc-insp';
    el.innerHTML =
      '<div class="hmc-insp-head">' +
        '<span class="hmc-orb" style="--orb:' + type.color + '"></span>' +
        '<div><h4>' + esc(node.ctitle) + '</h4>' +
        '<div class="hmc-insp-meta">' + esc(node.tier || 'memory') + ' · importance ' +
          (node.cimp || 0).toFixed(2) + ' · salience ' + num(node.salience, node.cimp || 0).toFixed(2) + '</div></div>' +
      '</div>' +
      '<p>' + esc(shorten(node.body || node.label || node.ctitle, 460)) + '</p>' +
      '<div class="hmc-tags">' + tags.map(function (t) { return '<span class="hmc-tag">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<div class="hmc-sect">' +
        '<div class="hmc-sect-label"><span>recall blend</span><strong>client-side preview</strong></div>' +
        bar('lexical', lexical, '#26e6ff') + bar('vector', vector, '#4e7dff') + bar('graph', graph, '#8d5cff') +
      '</div>' +
      '<div class="hmc-sect">' +
        '<div class="hmc-sect-label"><span>activated relationships</span><strong>' + rel.length + '</strong></div>' +
        (rel.length ? rel.map(function (item) {
          var c = (TYPE_BY_KEY[item.node.ctype] || TYPES[1]).color;
          return '<div class="hmc-rel"><i style="--orb:' + c + '"></i><span>' + esc(item.node.ctitle) + '</span>' +
            '<b>' + esc(item.edge.type) + ' ' + item.edge.w.toFixed(2) + '</b></div>';
        }).join('') : '<div class="hmc-note">No typed associations recorded for this memory yet.</div>') +
      '</div>' +
      '<div class="hmc-note">Stars are memories, filaments are typed associations. Drag to orbit, ' +
        'submerge to move the camera inside the lattice, double-click a star to dive toward it.</div>';
  }

  global.HenryConstellation = {
    mount: mount,
    types: TYPES,
    classify: classify,
    reduceMotion: reduceMotion,
    renderInspector: function (el, node, instance) { return renderInspector(el, node, instance); }
  };
}(typeof window !== 'undefined' ? window : this));
