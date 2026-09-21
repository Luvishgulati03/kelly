/**
 * THE KELLY SWITCHBOARD — the owner's one page.
 *
 * One visual system (distribution-board enamel, copper accent, phosphor ink) across every
 * pane, and every number on it is measured, never decorated:
 *
 *  - the heartbeat draws one spike per real activity event from /api/events, its BPM is the
 *    count of events in the last minute, and a stream that goes quiet turns the trace amber,
 *    then flat and red. A dead process looks dead.
 *  - Voice lists what Kelly actually heard, from the transcript store, with what became of
 *    each transcript (confirmed, answered, dropped, expired, failed).
 *  - Usage shows the CLIs' own token counts and Kelly's own timings; a subscription has no
 *    rupees to report, so none are invented.
 *
 * The memory constellation keeps its own page (/memory); chat keeps its own (/chat).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#141516"><title>Kelly · switchboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=Atkinson+Hyperlegible:wght@400;700&family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+Devanagari:wght@400;600&display=swap">
<style>
:root{
  --ground:#141516;--ground-2:#0f1011;--panel:#1b1e20;--panel-2:#22262a;--panel-3:#2a2f33;--line:#2f3539;--line-2:#3c4348;
  --ink:#f3efe6;--ink-2:#c0bab0;--ink-3:#847e75;--ink-4:#5a564f;
  --copper:#d08a4b;--copper-2:#f0b072;--copper-dim:rgba(208,138,75,.16);
  --good:#3cc9b0;--warn:#f0b429;--crit:#f0616d;--good-dim:rgba(60,201,176,.14);--warn-dim:rgba(240,180,41,.14);--crit-dim:rgba(240,97,109,.16);
  --s-in:#C97A3C;--s-cached:#5E8BE8;--s-out:#22A38C;
  --display:"Big Shoulders Display","Arial Narrow",Impact,sans-serif;--body:"Atkinson Hyperlegible","Helvetica Neue",Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--hindi:"Noto Sans Devanagari","Atkinson Hyperlegible",sans-serif;--r:6px;--r-lg:10px}
*{box-sizing:border-box}html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 var(--body);padding-block:0 40px;padding-inline:16px;background-image:radial-gradient(900px 400px at 85% -10%,rgba(208,138,75,.08),transparent 70%)}
a{color:var(--copper-2)}h1,h2,h3,p{margin:0}h1,h2,h3,.num{font-family:var(--display);letter-spacing:.005em;text-wrap:balance}
.num,.mono{font-variant-numeric:tabular-nums}.mono{font-family:var(--mono)}.hi{font-family:var(--hindi)}
.eyebrow{font:500 11px/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.wrap{max-width:1380px;margin:0 auto}
.shell{display:grid;grid-template-columns:200px minmax(0,1fr);margin-top:18px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--ground-2);box-shadow:0 30px 60px -40px rgba(0,0,0,.9)}
.rail{background:var(--panel);border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:18px}
.brand{display:flex;align-items:center;gap:10px}.brand .k{width:30px;height:30px;border-radius:7px;background:linear-gradient(160deg,var(--copper-2),var(--copper) 70%);display:grid;place-items:center;font:800 18px var(--display);color:#1a1108}
.brand strong{font:800 20px var(--display);text-transform:uppercase;letter-spacing:.03em}.brand small{display:block;font:11px var(--mono);color:var(--ink-3)}
.tabs{display:flex;flex-direction:column;gap:2px}
.tab{display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;background:transparent;color:var(--ink-2);font:700 14px var(--body);text-align:left;padding:9px 10px;border-radius:var(--r);cursor:pointer;text-decoration:none}
.tab:hover{background:var(--panel-2);color:var(--ink)}.tab[aria-selected="true"]{background:var(--copper-dim);color:var(--copper-2);box-shadow:inset 3px 0 0 var(--copper)}
.tab .cnt{font:500 11px var(--mono);color:var(--ink-3);background:var(--panel-3);padding:2px 7px;border-radius:999px}.tab[aria-selected="true"] .cnt{color:var(--copper-2)}
.tab .cnt.warn{color:var(--warn)}.tab .cnt.crit{color:var(--crit)}
.rail .foot{margin-top:auto;font:12px/1.6 var(--mono);color:var(--ink-3)}.rail .foot b{color:var(--ink-2);font-weight:500}
.main{padding:20px 22px 26px;min-width:0}.pane{display:none}.pane.on{display:block}
.topline{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.topline h2{font-size:30px;text-transform:uppercase;font-weight:800}.topline .sub{color:var(--ink-3);font-size:13px}
.pills{display:flex;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;font:500 11.5px var(--mono);padding:4px 9px;border-radius:999px;border:1px solid var(--line-2);color:var(--ink-2);background:var(--panel)}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--ink-3)}
.pill.good{color:var(--good);border-color:rgba(60,201,176,.35);background:var(--good-dim)}.pill.good i{background:var(--good)}
.pill.warn{color:var(--warn);border-color:rgba(240,180,41,.35);background:var(--warn-dim)}.pill.warn i{background:var(--warn)}
.pill.crit{color:var(--crit);border-color:rgba(240,97,109,.4);background:var(--crit-dim)}.pill.crit i{background:var(--crit)}
.pill.copper{color:var(--copper-2);border-color:rgba(208,138,75,.4);background:var(--copper-dim)}.pill.copper i{background:var(--copper)}
.button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);background:var(--panel-2);color:var(--ink);font:700 13px var(--body);padding:7px 12px;border-radius:var(--r);cursor:pointer;text-decoration:none}
.button:hover{border-color:var(--copper)}.button.primary{background:var(--copper);border-color:var(--copper);color:#1a1108}
.button:focus-visible,.tab:focus-visible,.chip:focus-visible,.input:focus-visible,select:focus-visible,.lrow:focus-visible,.item:focus-visible{outline:2px solid var(--copper-2);outline-offset:2px}
.beat{display:grid;grid-template-columns:150px minmax(0,1fr) 220px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);overflow:hidden;margin-bottom:16px}
.beat > div{padding:14px 16px}.beat .bpm{border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between}
.beat .bpm .num{font-size:52px;line-height:.9;font-weight:800;color:var(--good)}.beat .bpm .num small{font:500 12px var(--mono);color:var(--ink-3);margin-left:4px}
.beat .bpm .note{font-size:12px;color:var(--ink-3)}.beat.working .bpm .num{color:var(--copper-2)}.beat.stale .bpm .num{color:var(--warn)}.beat.dead .bpm .num{color:var(--crit)}
.beat .trace{padding:0;position:relative;background:var(--ground-2)}.beat canvas{display:block;width:100%;height:110px}
.beat .trace .grid{position:absolute;inset:0;background-image:linear-gradient(to right,rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.035) 1px,transparent 1px);background-size:22px 22px;pointer-events:none}
.beat .trace .sig{position:absolute;top:8px;left:10px;font:11px var(--mono);color:var(--ink-3)}.beat .trace .sig b{font-weight:500;color:var(--good)}.beat.stale .sig b{color:var(--warn)}.beat.dead .sig b{color:var(--crit)}
.beat .feed{border-left:1px solid var(--line);font:12px/1.35 var(--mono);color:var(--ink-2);display:flex;flex-direction:column;gap:6px;overflow:hidden}
.beat .feed .row{display:flex;justify-content:space-between;gap:8px;white-space:nowrap}.beat .feed .row span:first-child{overflow:hidden;text-overflow:ellipsis}.beat .feed .row span:last-child{color:var(--ink-3)}.beat .feed .row.new{color:var(--copper-2)}
.vitals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
.vital{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.vital .eyebrow{display:flex;justify-content:space-between;align-items:center}.vital .num{font-size:34px;line-height:1;font-weight:800}.vital .num small{font:400 13px var(--body);color:var(--ink-3);margin-left:6px}
.vital .bar{height:6px;border-radius:999px;background:var(--panel-3);overflow:hidden}.vital .bar i{display:block;height:100%;background:var(--copper);border-radius:999px;width:0}.vital .bar.good i{background:var(--good)}.vital .sub{font-size:12.5px;color:var(--ink-3)}
.cols{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:12px;align-items:start}
.card{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);padding:14px 16px}
.card h3{font-size:19px;text-transform:uppercase;letter-spacing:.03em;display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px}
.card h3 a{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;text-decoration:none}
.empty{color:var(--ink-3);font-size:13.5px;padding:8px 0}
.list{display:grid}.item{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}.item:first-child{border-top:0}
.item .who{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font:700 11px var(--mono);background:var(--panel-3);color:var(--ink-2)}.item .who.tg{background:rgba(94,139,232,.18);color:#9db7f5}.item .who.ctr{background:var(--copper-dim);color:var(--copper-2)}
.item .t{font-size:14px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.item .m{font:12px var(--mono);color:var(--ink-3);display:flex;gap:8px;flex-wrap:wrap}
.lang{font:500 10.5px var(--mono);padding:1px 6px;border-radius:4px;border:1px solid var(--line-2);color:var(--ink-2)}
.state{font:500 10.5px var(--mono);padding:2px 7px;border-radius:4px;white-space:nowrap}.state.ok{background:var(--good-dim);color:var(--good)}.state.wait{background:var(--warn-dim);color:var(--warn)}.state.drop{background:var(--panel-3);color:var(--ink-3)}.state.err{background:var(--crit-dim);color:var(--crit)}
.attn{display:grid;gap:8px}.attn div{padding:10px 12px;border-radius:var(--r);background:var(--panel-2);border-left:3px solid var(--warn);font-size:13.5px;color:var(--ink-2);line-height:1.5}.attn div.crit{border-left-color:var(--crit)}.attn div.good{border-left-color:var(--good)}.attn b{color:var(--ink)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.chip{border:1px solid var(--line-2);background:var(--panel);color:var(--ink-2);font:500 12.5px var(--body);padding:6px 12px;border-radius:999px;cursor:pointer}.chip[aria-pressed="true"]{background:var(--copper-dim);color:var(--copper-2);border-color:rgba(208,138,75,.5)}.chip.err[aria-pressed="true"]{background:var(--crit-dim);color:var(--crit);border-color:rgba(240,97,109,.5)}
.input,select.input{flex:1;min-width:160px;border:1px solid var(--line-2);background:var(--ground-2);color:var(--ink);border-radius:var(--r);padding:7px 10px;font:14px var(--body)}
.voice{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:12px;align-items:start}
.tlist .item{cursor:pointer;padding:10px 8px;border-radius:var(--r)}.tlist .item.sel{background:var(--copper-dim)}
.detail .head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;padding-bottom:12px;border-bottom:1px solid var(--line);margin-bottom:12px}.detail .head h3{margin:0;font-size:22px;text-transform:none;letter-spacing:0;display:block}
.detail .meta{display:flex;gap:14px;flex-wrap:wrap;font:12px var(--mono);color:var(--ink-3)}
.audio{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r);background:var(--ground-2);margin-bottom:12px}.audio audio{flex:1;min-width:0}
.turns{display:grid;gap:10px}.turn{display:grid;grid-template-columns:70px minmax(0,1fr);gap:12px;align-items:start}.turn .who{font:500 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);padding-top:4px}.turn .who.k{color:var(--copper-2)}
.turn p{padding:10px 12px;border-radius:var(--r);background:var(--panel-2);font-size:15px;line-height:1.55;white-space:pre-wrap;word-break:break-word}.turn.k p{background:transparent;border:1px solid var(--line)}.turn .ts{font:11px var(--mono);color:var(--ink-4);margin-top:3px}
.ents{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.ent{font:500 11.5px var(--mono);padding:2px 8px;border-radius:4px;background:var(--panel-3);color:var(--ink-2)}.ent b{color:var(--copper-2);font-weight:500;margin-right:4px}.ent.miss{color:var(--warn);background:var(--warn-dim)}
.gate{margin-top:12px;padding:10px 12px;border-radius:var(--r);border-left:3px solid var(--good);background:var(--good-dim);font-size:13.5px;color:var(--ink-2)}.gate b{color:var(--good)}.gate.warn{border-left-color:var(--warn);background:var(--warn-dim)}.gate.warn b{color:var(--warn)}
.settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}.settings label{display:grid;gap:4px;font-size:12.5px;color:var(--ink-3)}.settings .toggle{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:14px}
.log{border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;background:var(--panel)}
.lrow{display:grid;grid-template-columns:8px 78px 128px minmax(0,1fr) 92px;gap:0 12px;align-items:baseline;padding:9px 12px 9px 0;border-top:1px solid var(--line);font-size:13.5px;cursor:pointer}.lrow:first-child{border-top:0}.lrow:hover,.lrow.open{background:var(--panel-2)}
.lrow .st{align-self:stretch;background:var(--ink-4)}.lrow.ok .st{background:var(--good)}.lrow.warn .st{background:var(--warn)}.lrow.err .st{background:var(--crit)}
.lrow .ti{font:12px var(--mono);color:var(--ink-3)}.lrow .kd{font:500 11px var(--mono);color:var(--ink-2);border:1px solid var(--line-2);padding:2px 7px;border-radius:4px;width:fit-content;white-space:nowrap}.lrow .ms{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lrow .du{font:12px var(--mono);color:var(--ink-3);text-align:right}
.lmeta{grid-column:2/-1;margin-top:6px;font:12px/1.6 var(--mono);color:var(--ink-2);background:var(--ground-2);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;white-space:pre-wrap;word-break:break-word}
.usage{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:12px;align-items:start}.stack{display:grid;gap:12px}
.chart{display:block;width:100%;height:auto}.legend{display:flex;gap:14px;flex-wrap:wrap;font:12px var(--mono);color:var(--ink-2);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.kv{display:grid;grid-template-columns:1fr auto;gap:6px 12px;font-size:14px;margin:0}.kv dt{color:var(--ink-3)}.kv dd{margin:0;text-align:right}
.meter{margin:10px 0 4px;height:10px;border-radius:999px;background:var(--panel-3);position:relative;overflow:hidden}.meter i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--good),var(--copper));border-radius:999px;width:0}
details.tbl{margin-top:10px}details.tbl summary{cursor:pointer;color:var(--copper-2);font-size:13px}table{border-collapse:collapse;width:100%;font:12.5px var(--mono);margin-top:8px}th,td{text-align:right;padding:5px 8px;border-top:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--ink-3);font-weight:500}
.tip{position:fixed;pointer-events:none;background:var(--panel-3);border:1px solid var(--line-2);color:var(--ink);font:12px var(--mono);padding:6px 8px;border-radius:var(--r);display:none;z-index:5}
.row{padding:8px 0;border-top:1px solid var(--line);font-size:14px}.row:first-child{border-top:0}.row .dim{font:12px var(--mono);color:var(--ink-3)}
.stats{display:flex;gap:18px;flex-wrap:wrap}.stat b{display:block;font:800 26px var(--display);color:var(--ink)}.stat span{font:500 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
@media (prefers-reduced-motion:reduce){.beat canvas{opacity:.9}}
@media (max-width:1000px){.vitals{grid-template-columns:repeat(2,minmax(0,1fr))}.cols,.voice,.usage{grid-template-columns:1fr}.beat{grid-template-columns:120px minmax(0,1fr)}.beat .feed{display:none}.settings{grid-template-columns:1fr}}
@media (max-width:700px){.shell{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid var(--line);padding:12px}.tabs{flex-direction:row;flex-wrap:wrap}.rail .foot{display:none}.vitals{grid-template-columns:1fr}.lrow{grid-template-columns:6px 60px minmax(0,1fr);gap:0 8px}.lrow .kd,.lrow .du{display:none}.beat{grid-template-columns:1fr}.beat .bpm{border-right:0;border-bottom:1px solid var(--line);flex-direction:row;align-items:center;gap:12px}.topline h2{font-size:24px}}
</style></head><body>
<div class="wrap"><div class="shell">
  <nav class="rail" aria-label="Sections">
    <div class="brand"><div class="k">K</div><div><strong id="brand-name">Kelly</strong><small id="brand-sub">switchboard</small></div></div>
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="true" data-pane="overview">Overview</button>
      <button class="tab" role="tab" aria-selected="false" data-pane="voice">Voice <span class="cnt" id="cnt-voice">–</span></button>
      <button class="tab" role="tab" aria-selected="false" data-pane="logs">Logs <span class="cnt" id="cnt-logs">–</span></button>
      <button class="tab" role="tab" aria-selected="false" data-pane="usage">Usage &amp; quota</button>
      <button class="tab" role="tab" aria-selected="false" data-pane="catalogue">Catalogue</button>
      <a class="tab" href="/chat">Chat ↗</a>
      <a class="tab" href="/voice">Speak ↗</a>
      <a class="tab" href="/memory">Memory ↗</a>
    </div>
    <div class="foot" id="foot">brain <b id="foot-provider">–</b><br>stt <b id="foot-stt">–</b><br>tts <b id="foot-tts">–</b><br>bound <b id="foot-bound">–</b></div>
  </nav>
  <div class="main">

  <div class="pane on" id="pane-overview">
    <div class="topline"><div><h2>Overview</h2><div class="sub" id="ov-sub">connecting…</div></div><div class="pills" id="ov-pills"></div></div>
    <div class="beat" id="beat" aria-label="Heartbeat: one spike per real event">
      <div class="bpm"><div class="eyebrow">Heartbeat</div><div><div class="num" id="bpm">0<small>/min</small></div><div class="note" id="bpm-note">waiting for the event stream</div></div></div>
      <div class="trace"><div class="grid"></div><div class="sig">signal <b id="sig">connecting</b> · a spike is a real event, a flat line is a dead process</div><canvas id="ecg" width="1200" height="110" aria-hidden="true"></canvas></div>
      <div class="feed" id="feed"><div class="row"><span>no events yet</span><span></span></div></div>
    </div>
    <div class="vitals">
      <div class="vital"><div class="eyebrow">Codex window <span class="pill" id="quota-pill"><i></i>–</span></div><div class="num" id="quota-num">–</div><div class="bar"><i id="quota-bar"></i></div><div class="sub" id="quota-sub">reading the cooldown ledger</div></div>
      <div class="vital"><div class="eyebrow">Today</div><div class="num" id="today-runs">–<small>runs</small></div><div class="sub" id="today-sub">–</div><div class="bar good"><i id="today-bar"></i></div></div>
      <div class="vital"><div class="eyebrow">Voice today</div><div class="num" id="voice-num">–<small>interactions</small></div><div class="sub" id="voice-sub">–</div><div class="bar"><i id="voice-bar"></i></div></div>
      <div class="vital"><div class="eyebrow">Attention</div><div class="num" id="attn-num">–<small>items</small></div><div class="sub" id="attn-sub">–</div></div>
    </div>
    <div class="cols">
      <div class="card"><h3>Recent voice <a href="#voice">all transcripts →</a></h3><div class="list" id="ov-voice"><div class="empty">loading…</div></div></div>
      <div class="card"><h3>Needs you <a href="#logs">open logs →</a></h3><div class="attn" id="ov-attn"><div class="empty">loading…</div></div></div>
    </div>
  </div>

  <div class="pane" id="pane-voice">
    <div class="topline"><div><h2>Voice transcripts</h2><div class="sub">Every voice interaction Kelly kept, from the counter and from Telegram. Retention is your setting; nothing here leaves the machine.</div></div><span class="pill" id="voice-ret"><i></i>–</span></div>
    <div class="card" style="margin-bottom:12px"><h3>Retention</h3>
      <div class="settings">
        <label>Keep transcripts for <select class="input" id="set-ret"><option value="7">7 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option></select></label>
        <label class="toggle" style="align-self:end"><input type="checkbox" id="set-rec"> Record audio and keep it for <select class="input" id="set-aret" style="flex:0 0 auto;min-width:0"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
        <div><button class="button primary" id="set-save" type="button">Save retention</button> <span class="mono" id="set-note" style="font-size:12px;color:var(--ink-3)"></span></div>
      </div>
    </div>
    <div class="filters" id="vfilters">
      <button class="chip" aria-pressed="true" data-f="">All</button><button class="chip" aria-pressed="false" data-f="surface=counter">Counter</button><button class="chip" aria-pressed="false" data-f="surface=telegram">Telegram</button><button class="chip" aria-pressed="false" data-f="language=hi">Hindi</button><button class="chip" aria-pressed="false" data-f="sparse=true">Needed clarification</button><button class="chip" aria-pressed="false" data-f="state=transcribed">Unconfirmed</button><button class="chip err" aria-pressed="false" data-f="state=failed">Failed</button>
      <input class="input" id="vsearch" type="search" placeholder="search words, brands, quantities">
    </div>
    <div class="voice">
      <div class="card tlist"><div class="list" id="tlist"><div class="empty">loading…</div></div></div>
      <div class="card detail" id="tdetail"><div class="empty">Select a transcript to read it in full.</div></div>
    </div>
  </div>

  <div class="pane" id="pane-logs">
    <div class="topline"><div><h2>Logs</h2><div class="sub">Every event Kelly records, newest first. Click a row for its metadata.</div></div><span class="pill" id="log-pill"><i></i>–</span></div>
    <div class="filters" id="lfilters">
      <button class="chip" aria-pressed="true" data-f="all">All</button><button class="chip" aria-pressed="false" data-f="run">Runs</button><button class="chip" aria-pressed="false" data-f="voice">Voice</button><button class="chip" aria-pressed="false" data-f="catalogue">Catalogue</button><button class="chip" aria-pressed="false" data-f="quote">Quotations</button><button class="chip" aria-pressed="false" data-f="approval">Approvals</button><button class="chip" aria-pressed="false" data-f="telegram">Telegram</button><button class="chip err" aria-pressed="false" data-f="errors">Errors only</button>
      <input class="input" id="lsearch" type="search" placeholder="search message, kind, metadata">
    </div>
    <div class="log" id="log"><div class="empty" style="padding:12px">loading…</div></div>
  </div>

  <div class="pane" id="pane-usage">
    <div class="topline"><div><h2>Usage &amp; quota</h2><div class="sub">Kelly runs on a Codex subscription, so this is tokens and windows, not rupees. Voice runs locally and costs nothing but time.</div></div><span class="pill" id="usage-pill"><i></i>–</span></div>
    <div class="usage">
      <div class="card"><h3>Codex tokens, last 7 days</h3>
        <svg class="chart" id="tok-chart" viewBox="0 0 640 260" role="img" aria-label="Stacked daily tokens: input, cached input, output"></svg>
        <div class="legend"><span><i style="background:var(--s-in)"></i>input</span><span><i style="background:var(--s-cached)"></i>cached input</span><span><i style="background:var(--s-out)"></i>output</span><span style="margin-left:auto;color:var(--ink-3)" id="tok-note">hover a bar for the split</span></div>
        <details class="tbl"><summary>Show as a table</summary><table><thead><tr><th>day</th><th>runs</th><th>failed</th><th>input</th><th>cached</th><th>output</th><th>provider time</th><th>voice</th></tr></thead><tbody id="tok-table"></tbody></table></details>
      </div>
      <div class="stack">
        <div class="card"><h3>Quota</h3><div id="quota-card"><div class="empty">loading…</div></div></div>
        <div class="card"><h3>Latency</h3><svg class="chart" id="lat-chart" viewBox="0 0 320 70" role="img" aria-label="Turn latency, recent runs"></svg><dl class="kv" id="lat-kv"></dl></div>
        <div class="card"><h3>Local machine</h3><dl class="kv" id="machine-kv"></dl></div>
      </div>
    </div>
  </div>

  <div class="pane" id="pane-catalogue">
    <div class="topline"><div><h2>Catalogue</h2><div class="sub">Search published products and see which supplier files are published or still waiting for your review.</div></div><span class="pill" id="cat-pill"><i></i>–</span></div>
    <div class="filters"><input class="input" id="cat-q" type="search" placeholder="search published products (e.g. 20W batten, Havells fan)"><button class="button primary" type="button" id="cat-go">Search</button></div>
    <div class="cols"><div class="card"><h3>Results</h3><div id="cat-results"><div class="empty">Published products will appear here.</div></div></div><div class="card"><h3>Supplier files</h3><div class="stats" id="cat-stats"></div><div id="cat-docs" class="list" style="margin-top:8px"></div><p style="margin-top:10px;font-size:12.5px;color:var(--ink-3)">Import with <span class="mono">kelly catalogue import &lt;file&gt;</span>, review, then publish. Quotations: <span class="mono">kelly quote create --from request.json</span>.</p></div></div>
  </div>

  </div>
</div></div>
<div class="tip" id="tip"></div>
<script>
(function(){'use strict';
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var get=function(p){return fetch(p,{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})};
var post=function(p,b){return fetch(p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json()})};
var ids=function(id){return document.getElementById(id)};
function fmtBytes(n){if(n==null||!isFinite(n))return'–';return n>=1073741824?(n/1073741824).toFixed(2)+' GB':n>=1048576?Math.round(n/1048576)+' MB':Math.round(n/1024)+' KB'}
function fmtDur(ms){if(ms==null||!isFinite(ms))return'–';if(ms<1000)return Math.round(ms)+'ms';var s=ms/1000;if(s<60)return s.toFixed(1)+'s';var m=Math.floor(s/60);return m+'m '+String(Math.round(s%60)).padStart(2,'0')+'s'}
function fmtSec(s){if(s==null||!isFinite(s))return'–';return s<60?Math.round(s)+'s':Math.floor(s/60)+'m '+String(Math.round(s%60)).padStart(2,'0')+'s'}
function fmtK(n){n=n||0;return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n)}
function fmtTime(iso){var d=new Date(iso);return isNaN(d)?'–':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}
function fmtWhen(iso){var d=new Date(iso);if(isNaN(d))return'–';var now=new Date();var same=d.toDateString()===now.toDateString();return(same?'':d.toLocaleDateString([],{weekday:'short'})+' ')+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}
function fmtAgo(iso){if(!iso)return'never';var s=(Date.now()-new Date(iso).getTime())/1000;if(s<60)return Math.round(s)+'s ago';if(s<3600)return Math.round(s/60)+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'}
function fmtUntil(iso){var d=new Date(iso);return isNaN(d)?'–':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}

/* ---- panes: the hash is the route, so /#logs and /#voice are shareable and reloadable ---- */
var tabs=document.querySelectorAll('.tab[data-pane]');
function go(name,push){var known=['overview','voice','logs','usage','catalogue'];if(known.indexOf(name)<0)name='overview';tabs.forEach(function(t){t.setAttribute('aria-selected',String(t.dataset.pane===name))});document.querySelectorAll('.pane').forEach(function(p){p.classList.toggle('on',p.id==='pane-'+name)});if(push!==false&&location.hash!=='#'+name)history.replaceState(null,'','#'+name);if(name==='voice')loadTranscripts();if(name==='logs')loadLogs();if(name==='usage')loadUsage();if(name==='catalogue')loadCatalogue()}
tabs.forEach(function(t){t.addEventListener('click',function(){go(t.dataset.pane)})});
addEventListener('hashchange',function(){go(location.hash.slice(1)||'overview',false)});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(a){e.preventDefault();go(a.getAttribute('href').slice(1))}});

/* ---- status + footer ---- */
var status={};
function refreshStatus(){return get('/api/status').then(function(s){status=s;var k=String(s.name||'').toLowerCase()==='kelly';ids('brand-name').textContent=s.name||'Kelly';ids('brand-sub').textContent=k?'switchboard':'control room';document.title=(s.name||'Kelly')+' · switchboard';ids('foot-provider').textContent=s.provider||'–';ids('foot-bound').textContent=(s.dashboard||'').replace(/^https?:\\/\\//,'')}).catch(function(){})}
function refreshVoiceStatus(){return get('/api/voice/status').then(function(v){ids('foot-stt').textContent=v.sttEnabled?'configured':'off';ids('foot-tts').textContent=v.ttsEnabled?'configured':'off'}).catch(function(){})}

/* ---- heartbeat: one spike per REAL event ---- */
var c=ids('ecg'),ctx=c.getContext('2d'),W=c.width,H=c.height,x=0,buf=new Float32Array(W).fill(H*0.62),phase=0,spike=0;
var reduce=matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var beats=[],lastTick=0,streamState='connecting',working=0,feed=[];
function beat(label,detail){beats.push(Date.now());spike=1;feed.unshift([label,detail]);feed=feed.slice(0,5);ids('feed').innerHTML=feed.map(function(r,i){return'<div class="row'+(i===0?' new':'')+'"><span>'+esc(r[0])+'</span><span>'+esc(r[1]||'')+'</span></div>'}).join('')}
function sample(){phase+=0.06;var v=Math.sin(phase)*1.6;if(streamState==='dead')v=0;if(spike>0){var s=spike;spike-=0.09;if(s>0.85)v=-8;else if(s>0.7)v=-42*(1-(0.85-s)/0.15)-8;else if(s>0.55)v=18;else if(s>0.4)v=-4;else v=Math.sin((1-s)*6)*3}return H*0.62+v}
function traceColor(){return streamState==='dead'?'#f0616d':streamState==='stale'?'#f0b429':working>0?'#f0b072':'#3cc9b0'}
function draw(){if(!reduce){buf[x]=sample();x=(x+1)%W;ctx.clearRect(0,0,W,H);ctx.lineWidth=2;ctx.strokeStyle=traceColor();ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=6;ctx.beginPath();for(var i=0;i<W;i++){var j=(x+i)%W;if(i===0)ctx.moveTo(i,buf[j]);else ctx.lineTo(i,buf[j])}ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#0f1011';ctx.fillRect(x,0,18,H)}
  var cutoff=Date.now()-60000;beats=beats.filter(function(t){return t>cutoff});var per=beats.length;ids('bpm').innerHTML=per+'<small>/min</small>';
  var age=lastTick?(Date.now()-lastTick)/1000:null;var beatEl=ids('beat');
  if(streamState==='connecting'){ids('sig').textContent='connecting'}else if(age!==null&&age>20){streamState='dead';ids('sig').textContent='no signal · '+Math.round(age)+'s'}else if(age!==null&&age>8){streamState='stale';ids('sig').textContent='stale · '+Math.round(age)+'s'}else if(age!==null){streamState='live';ids('sig').textContent='fresh · '+age.toFixed(1)+'s'}
  beatEl.className='beat'+(streamState==='dead'?' dead':streamState==='stale'?' stale':working>0?' working':'');
  ids('bpm-note').textContent=streamState==='dead'?'process not reporting':working>0?'working · '+working+' in flight':per>0?'ticking · '+per+' events last minute':'resting · idle';
  requestAnimationFrame(draw)}
if(reduce){ctx.strokeStyle='#3cc9b0';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,H*0.62);ctx.lineTo(W,H*0.62);ctx.stroke()}
draw();

/* ---- the event stream drives the heartbeat, the log, and the vitals ---- */
var seen={},logEvents=[],es;
function eventLabel(e){var k=e.kind||'';var d=e.metadata||{};var detail=d.durationMs?fmtDur(d.durationMs):d.sttMs?fmtDur(d.sttMs):'';return[k.replace(/\\./g,' '),detail]}
function startEvents(){try{es=new EventSource('/api/events');es.addEventListener('hello',function(){streamState='live';lastTick=Date.now()});
  es.addEventListener('activity',function(m){var e=JSON.parse(m.data);if(seen[e.id])return;seen[e.id]=1;var l=eventLabel(e);beat(l[0],l[1]);logEvents.unshift(e);if(logEvents.length>2000)logEvents.pop();if(ids('pane-logs').classList.contains('on'))renderLogs();if(/^(voice\\.|approval\\.|run\\.failed)/.test(e.kind))scheduleOverview()});
  es.addEventListener('resources',function(m){lastTick=Date.now();var d=JSON.parse(m.data);working=(d.agentState||{}).running||0;renderMachine(d);renderAttention(d)});
  es.onerror=function(){if(streamState!=='connecting')streamState='stale'}}catch(e){}}
var ovTimer=null;function scheduleOverview(){if(ovTimer)clearTimeout(ovTimer);ovTimer=setTimeout(refreshOverview,600)}

/* ---- overview ---- */
var latestUsage=null,latestVoice=null,latestApprovals=[],latestRemote=null;
function remotePill(r){if(!r||r.mode==='off')return'<span class="pill"><i></i>remote: off</span>';if(r.active)return'<span class="pill good"><i></i>remote: '+esc((r.url||'').replace(/^https?:\\/\\//,'')||r.mode)+'</span>';return'<span class="pill crit"><i></i>remote: down · '+esc(r.lastError||'not connected')+'</span>'}
function renderQuota(u){var lim=(u&&u.limits)||{};var codex=lim.codex,claude=lim.claude;var pill=ids('quota-pill');if(codex){pill.className='pill crit';pill.innerHTML='<i></i>cooldown';ids('quota-num').innerHTML='parked';ids('quota-bar').style.width='100%';ids('quota-sub').textContent=(codex.kind==='limit'?'out of quota':codex.kind)+' · back at '+fmtUntil(codex.until)}else{pill.className='pill good';pill.innerHTML='<i></i>ok';ids('quota-num').innerHTML='open';ids('quota-bar').style.width='0%';ids('quota-sub').textContent=claude?'claude parked until '+fmtUntil(claude.until)+' · codex open':'no cooldown recorded; Codex prints its reset time when it refuses'}}
function refreshOverview(){return Promise.all([get('/api/usage').catch(function(){return null}),get('/api/voice/transcripts?limit=6').catch(function(){return null}),get('/api/approvals').catch(function(){return[]}),get('/api/remote').catch(function(){return null})]).then(function(r){latestUsage=r[0];latestVoice=r[1];latestApprovals=r[2]||[];latestRemote=r[3];
  var u=latestUsage;if(u){renderQuota(u);var t=u.today;ids('today-runs').innerHTML=t.runs+'<small>runs</small>';var tok=t.inputTokens+t.cachedTokens+t.outputTokens;ids('today-sub').textContent=(u.tokenCoverage<1&&t.runs?'≥':'')+fmtK(tok)+' tokens · '+fmtDur(t.providerMs)+' provider time'+(u.latency.p50Ms?' · p50 '+fmtDur(u.latency.p50Ms):'')+(t.failedRuns?' · '+t.failedRuns+' failed':'');var max=Math.max.apply(null,u.days.map(function(d){return d.runs}).concat([1]));ids('today-bar').style.width=Math.round(t.runs/max*100)+'%'}
  var v=latestVoice;if(v){var st=v.stats;ids('voice-num').innerHTML=st.today+'<small>interactions</small>';ids('voice-sub').innerHTML=st.bySurface.counter+' counter · '+st.bySurface.telegram+' telegram'+(st.unconfirmed?' · <span style="color:var(--warn)">'+st.unconfirmed+' waiting for your yes</span>':'')+(st.failed?' · '+st.failed+' failed':'');ids('voice-bar').style.width=Math.min(100,st.today*10)+'%';ids('cnt-voice').textContent=st.total;ids('cnt-voice').className='cnt'+(st.unconfirmed?' warn':'');ids('ov-voice').innerHTML=v.transcripts.length?v.transcripts.map(function(t){return transcriptRow(t,false)}).join(''):'<div class="empty">No voice interactions kept yet. Voice notes from the counter and Telegram will appear here.</div>';ids('voice-ret').innerHTML='<i></i>text '+v.settings.retentionDays+'d · audio '+(v.settings.recordAudio?'kept '+v.settings.audioRetentionDays+'d':'not recorded')}
  var pending=latestApprovals.filter(function(a){return a.status==='pending'});var pills=[];pills.push(u&&u.limits&&u.limits.codex?'<span class="pill crit"><i></i>Codex parked</span>':'<span class="pill good"><i></i>Codex quota OK</span>');if(pending.length)pills.push('<span class="pill copper"><i></i>'+pending.length+' approval'+(pending.length===1?'':'s')+' waiting</span>');pills.push('<span class="pill"><i></i>'+(ids('foot-stt').textContent==='configured'?'voice on':'voice off')+'</span>');pills.push(remotePill(latestRemote));ids('ov-pills').innerHTML=pills.join('');
  ids('ov-sub').textContent=new Date().toLocaleDateString([],{weekday:'long',day:'numeric',month:'short'})+' · '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})+(status.provider?' · brain '+status.provider:'');renderAttention(null)})}
var lastResources=null;
function renderAttention(res){if(res)lastResources=res;var pending=latestApprovals.filter(function(a){return a.status==='pending'});var unconfirmed=latestVoice?latestVoice.stats.unconfirmed:0;var failedToday=latestUsage?latestUsage.today.failedRuns:0;var n=pending.length+unconfirmed+failedToday;ids('attn-num').innerHTML=n+'<small>items</small>';ids('attn-num').style.color=n?'var(--warn)':'';ids('attn-sub').textContent=[pending.length+' approval'+(pending.length===1?'':'s'),unconfirmed+' unconfirmed transcript'+(unconfirmed===1?'':'s'),failedToday+' failed run'+(failedToday===1?'':'s')].join(' · ');
  var rows=[];pending.forEach(function(a){rows.push('<div><b>Approve</b> '+esc(a.title)+(a.recipient?' → '+esc(a.recipient):'')+'. Use <span class="mono">kelly approve approve '+esc(a.id)+'</span>, then send.</div>')});if(latestVoice)latestVoice.transcripts.filter(function(t){return t.state==='transcribed'}).slice(0,3).forEach(function(t){rows.push('<div><b>Confirm</b> the '+fmtWhen(t.at)+' '+t.surface+' transcript'+(t.surface==='telegram'?': reply "yes" in Telegram or type anything else to drop it.':': review it on the voice page and send it.')+'</div>')});
  logEvents.filter(function(e){return/failed/.test(e.kind)}).slice(0,2).forEach(function(e){rows.push('<div class="crit"><b>Failed</b> '+esc(e.message)+' <span class="mono" style="color:var(--ink-3)">'+fmtAgo(e.timestamp)+'</span></div>')});
  if(lastResources&&lastResources.memoryPressure&&lastResources.memoryPressure.level!=='normal')rows.push('<div class="'+(lastResources.memoryPressure.level==='critical'?'crit':'')+'"><b>Memory pressure</b> '+esc(lastResources.memoryPressure.level)+' · '+esc(lastResources.memoryPressure.freePercent)+'% free.</div>');
  ids('ov-attn').innerHTML=rows.length?rows.join(''):'<div class="good"><b>Nothing waiting.</b> No approvals, no unconfirmed transcripts, no failed runs today.</div>'}

/* ---- voice ---- */
function stateChip(s){var m={transcribed:['wait','needs yes'],confirmed:['ok','confirmed'],answered:['ok','answered'],dropped:['drop','dropped'],expired:['drop','expired'],failed:['err','failed']}[s]||['drop',s];return'<span class="state '+m[0]+'">'+m[1]+'</span>'}
function langChip(t){if(!t.text)return'<span class="lang">–</span>';return t.mixed?'<span class="lang">Hinglish</span>':'<span class="lang">EN</span>'}
function transcriptRow(t,sel){var who=t.surface==='telegram'?'<div class="who tg">TG</div>':'<div class="who ctr">CTR</div>';var text=t.text||(t.error?'('+t.error+')':'(no words)');var ents=[].concat(t.entities.brands,t.entities.quantities.slice(0,2)).join(' · ');return'<div class="item'+(sel?' sel':'')+'" data-id="'+esc(t.id)+'" tabindex="0">'+who+'<div><div class="t">'+esc(text)+'</div><div class="m">'+langChip(t)+'<span>'+fmtWhen(t.at)+'</span>'+(t.durationSeconds?'<span>'+fmtSec(t.durationSeconds)+'</span>':'')+(t.sttMs?'<span>stt '+fmtDur(t.sttMs)+'</span>':'')+(ents?'<span>'+esc(ents)+'</span>':'')+'</div></div>'+stateChip(t.state)+'</div>'}
var vfilter='',vq='',selected=null;
function loadTranscripts(){var qs='limit=200'+(vfilter?'&'+vfilter:'')+(vq?'&q='+encodeURIComponent(vq):'');return get('/api/voice/transcripts?'+qs).then(function(v){latestVoice=v;var list=v.transcripts;ids('tlist').innerHTML=list.length?list.map(function(t){return transcriptRow(t,t.id===selected)}).join(''):'<div class="empty">'+(vfilter||vq?'Nothing matches these filters.':'No voice interactions kept yet.')+'</div>';ids('set-ret').value=String(v.settings.retentionDays);ids('set-rec').checked=v.settings.recordAudio;ids('set-aret').value=String(v.settings.audioRetentionDays);ids('voice-ret').innerHTML='<i></i>text '+v.settings.retentionDays+'d · audio '+(v.settings.recordAudio?'kept '+v.settings.audioRetentionDays+'d':'not recorded');if(!selected&&list.length)showTranscript(list[0].id);else if(selected)showTranscript(selected)}).catch(function(e){ids('tlist').innerHTML='<div class="empty">Could not load transcripts: '+esc(e.message)+'</div>'})}
function showTranscript(id){selected=id;document.querySelectorAll('#tlist .item').forEach(function(el){el.classList.toggle('sel',el.dataset.id===id)});get('/api/voice/transcripts/'+encodeURIComponent(id)).then(function(t){var e=t.entities;var ents=e.brands.map(function(b){return'<span class="ent"><b>brand</b>'+esc(b)+'</span>'}).concat(e.quantities.map(function(q){return'<span class="ent"><b>qty</b>'+esc(q)+'</span>'})).concat(e.units.filter(function(u){return!e.quantities.some(function(q){return q.toLowerCase().indexOf(u.toLowerCase())>=0})}).map(function(u){return'<span class="ent"><b>unit</b>'+esc(u)+'</span>'}));if(e.sparse&&t.text)ents.push('<span class="ent miss"><b>brand / qty</b>not heard → Kelly should ask</span>');
  var gate=t.state==='transcribed'?'<div class="gate warn"><b>Waiting.</b> These words have not reached Kelly. '+(t.surface==='telegram'?'Reply "yes" in Telegram to run them, or anything else to drop them.':'Review and send from the voice page.')+'</div>':t.state==='dropped'||t.state==='expired'?'<div class="gate"><b>Not run.</b> This transcript was '+t.state+'; nothing was sent or executed from it.</div>':t.state==='failed'?'<div class="gate warn"><b>Failed.</b> '+esc(t.error||'No words were kept.')+'</div>':'<div class="gate"><b>Gate held.</b> The words reached Kelly only after a typed confirmation. Any outbound action still waits in the approval queue.</div>';
  var origDetails=t.original?'<details class="orig"><summary>original script</summary><p class="mono" style="white-space:pre-wrap">'+esc(t.original)+'</p></details>':'';
  ids('tdetail').innerHTML='<div class="head"><div><h3>'+esc(t.text||'(no words)')+'</h3><div class="meta"><span>'+esc(t.surface)+' · '+esc(new Date(t.at).toLocaleString([],{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}))+'</span>'+(t.durationSeconds?'<span>audio '+fmtSec(t.durationSeconds)+(t.bytes?' · '+fmtBytes(t.bytes):'')+'</span>':'')+(t.sttMs?'<span>stt '+fmtDur(t.sttMs)+(t.durationSeconds?' · rtf '+(t.sttMs/1000/t.durationSeconds).toFixed(2):'')+'</span>':'')+(t.language?'<span>lang '+esc(t.language)+'</span>':'')+'</div></div>'+stateChip(t.state)+'</div>'+(t.audio?'<div class="audio"><audio controls preload="none" src="/api/voice/audio/'+esc(t.id)+'"></audio><span class="mono" style="font-size:12px;color:var(--ink-3)">recording kept</span></div>':'')+'<div class="turns">'+(t.text?'<div class="turn"><div class="who">'+(t.surface==='telegram'?'Owner':'Speaker')+'</div><div><p>'+esc(t.text)+'</p>'+origDetails+'<div class="ts">'+fmtTime(t.at)+' · transcript, read back before anything ran</div><div class="ents">'+ents.join('')+'</div></div></div>':'')+(t.reply?'<div class="turn k"><div class="who k">Kelly</div><div><p>'+esc(t.reply)+'</p><div class="ts">'+fmtTime(t.replyAt||t.at)+'</div></div></div>':'')+'</div>'+gate+(t.conversationId?'<p style="margin-top:10px;font-size:12.5px"><a href="/chat">Open the conversation ↗</a></p>':'')}).catch(function(e){ids('tdetail').innerHTML='<div class="empty">Could not load this transcript: '+esc(e.message)+'</div>'})}
ids('tlist').addEventListener('click',function(e){var it=e.target.closest('.item');if(it)showTranscript(it.dataset.id)});
ids('tlist').addEventListener('keydown',function(e){var it=e.target.closest('.item');if(it&&(e.key==='Enter'||e.key===' ')){e.preventDefault();showTranscript(it.dataset.id)}});
ids('vfilters').addEventListener('click',function(e){var chip=e.target.closest('.chip');if(!chip)return;ids('vfilters').querySelectorAll('.chip').forEach(function(o){o.setAttribute('aria-pressed','false')});chip.setAttribute('aria-pressed','true');vfilter=chip.dataset.f||'';selected=null;loadTranscripts()});
var vst=null;ids('vsearch').addEventListener('input',function(){if(vst)clearTimeout(vst);vst=setTimeout(function(){vq=ids('vsearch').value.trim();selected=null;loadTranscripts()},250)});
ids('set-save').addEventListener('click',function(){var rec=ids('set-rec').checked;if(!rec&&latestVoice&&latestVoice.stats.audioKept>0&&!confirm('Switching recording off deletes the '+latestVoice.stats.audioKept+' kept recording(s). Continue?'))return;ids('set-note').textContent='saving…';post('/api/voice/settings',{retentionDays:Number(ids('set-ret').value),recordAudio:rec,audioRetentionDays:Number(ids('set-aret').value)}).then(function(r){ids('set-note').textContent=r.error?r.error:'saved · '+(r.discarded?r.discarded+' recording(s) deleted · ':'')+(r.pruned&&r.pruned.textDeleted?r.pruned.textDeleted+' old transcript(s) pruned':'nothing to prune');loadTranscripts()}).catch(function(e){ids('set-note').textContent=e.message})});

/* ---- logs ---- */
var lfilter='all',lq='';
function sev(e){var k=e.kind||'';if(/failed|rollback/.test(k)||(e.metadata&&e.metadata.error))return'err';if(/pending|created|submission_uncertain|fill_retry|preflight|failover/.test(k))return'warn';if(/completed|answered|confirmed|transcribed|saved|executed|merged|verified|posted|drafted|indexed/.test(k))return'ok';return''}
function matchesFilter(e){var k=e.kind||'',d=e.metadata||{},m=e.message||'';var text=(k+' '+m+' '+JSON.stringify(d)).toLowerCase();if(lq&&text.indexOf(lq)<0)return false;switch(lfilter){case'all':return true;case'run':return/^run\\.|^task\\.|^agent\\./.test(k);case'voice':return/^voice\\./.test(k)||d.voice===true;case'catalogue':return/knowledge\\.|catalogue/i.test(k+' '+m);case'quote':return/quot/i.test(m)||/quote/i.test(k);case'approval':return/^approval\\./.test(k);case'telegram':return d.telegram===true||/telegram/i.test(k+' '+m);case'errors':return sev(e)==='err';default:return true}}
function metaHtml(e){var d=Object.assign({},e.metadata||{});var parts=[];Object.keys(d).forEach(function(k){var v=d[k];parts.push('<span style="color:var(--ink-3)">'+esc(k)+'</span> '+esc(typeof v==='object'?JSON.stringify(v):String(v)))});if(e.runId)parts.push('<span style="color:var(--ink-3)">runId</span> '+esc(e.runId));if(e.provider)parts.push('<span style="color:var(--ink-3)">provider</span> '+esc(e.provider));if(e.role)parts.push('<span style="color:var(--ink-3)">role</span> '+esc(e.role));return parts.join('   ')||'no metadata'}
function renderLogs(){var rows=logEvents.filter(matchesFilter).slice(0,500);ids('log-pill').innerHTML='<i></i>following · '+rows.length+' of '+logEvents.length+' events';var errs=logEvents.filter(function(e){return sev(e)==='err'}).length;ids('cnt-logs').textContent=errs?errs+(errs===1?' error':' errors'):String(logEvents.length);ids('cnt-logs').className='cnt'+(errs?' crit':'');ids('log').innerHTML=rows.length?rows.map(function(e){var d=e.metadata||{};var dur=d.durationMs?fmtDur(d.durationMs):d.sttMs?fmtDur(d.sttMs):'';return'<div class="lrow '+sev(e)+'" data-id="'+esc(e.id)+'" tabindex="0"><i class="st"></i><span class="ti">'+fmtTime(e.timestamp)+'</span><span class="kd">'+esc(e.kind)+'</span><span class="ms" title="'+esc(e.message)+'">'+esc(e.message)+'</span><span class="du">'+esc(dur)+'</span></div>'}).join(''):'<div class="empty" style="padding:12px">'+(logEvents.length?'Nothing matches these filters.':'No events recorded yet.')+'</div>'}
function loadLogs(){return get('/api/logs?limit=1000').then(function(r){(r.events||[]).forEach(function(e){seen[e.id]=1});logEvents=r.events||[];renderLogs()}).catch(function(e){ids('log').innerHTML='<div class="empty" style="padding:12px">Could not load the log: '+esc(e.message)+'</div>'})}
ids('log').addEventListener('click',function(e){var row=e.target.closest('.lrow');if(!row)return;var open=row.classList.toggle('open');var meta=row.querySelector('.lmeta');if(open&&!meta){var ev=logEvents.filter(function(x){return x.id===row.dataset.id})[0];if(ev){var m=document.createElement('div');m.className='lmeta';m.innerHTML=metaHtml(ev);row.appendChild(m)}}else if(meta)meta.remove()});
ids('lfilters').addEventListener('click',function(e){var chip=e.target.closest('.chip');if(!chip)return;ids('lfilters').querySelectorAll('.chip').forEach(function(o){o.setAttribute('aria-pressed','false')});chip.setAttribute('aria-pressed','true');lfilter=chip.dataset.f;renderLogs()});
var lst=null;ids('lsearch').addEventListener('input',function(){if(lst)clearTimeout(lst);lst=setTimeout(function(){lq=ids('lsearch').value.trim().toLowerCase();renderLogs()},200)});

/* ---- usage ---- */
var tip=ids('tip');
function svgEl(n,a){var el=document.createElementNS('http://www.w3.org/2000/svg',n);Object.keys(a||{}).forEach(function(k){el.setAttribute(k,a[k])});return el}
function renderTokens(u){var svg=ids('tok-chart');svg.innerHTML='';var days=u.days;var max=Math.max.apply(null,days.map(function(d){return d.inputTokens+d.cachedTokens+d.outputTokens}).concat([1]));var allZero=days.every(function(d){return d.inputTokens+d.cachedTokens+d.outputTokens===0});
  if(allZero){var empty=svgEl('text',{x:333,y:130,'text-anchor':'middle','font-family':'IBM Plex Mono,monospace','font-size':'13',fill:'#847e75'});empty.textContent='no runs yet this week';svg.appendChild(empty)}else{
  var mag=Math.pow(10,Math.floor(Math.log10(max)));var top=[1,2,2.5,4,5,8,10].map(function(m){return m*mag}).filter(function(v){return v>max})[0]||max*1.1;var scale=180/top;var g=svgEl('g',{'font-family':'IBM Plex Mono,monospace','font-size':'11',fill:'#847e75'});[0,0.333,0.667,1].forEach(function(f){var y=220-f*180;g.appendChild(svgEl('line',{x1:46,x2:620,y1:y,y2:y,stroke:f===0?'#3c4348':'#2f3539'}));var t=svgEl('text',{x:40,y:y+4,'text-anchor':'end'});t.textContent=fmtK(Math.round(top*f));g.appendChild(t)});svg.appendChild(g);
  var cols=['#C97A3C','#5E8BE8','#22A38C'];days.forEach(function(d,i){var x=60+i*80,y=220,total=d.inputTokens+d.cachedTokens+d.outputTokens;[d.inputTokens,d.cachedTokens,d.outputTokens].forEach(function(v,k){var h=Math.max(0,v*scale-2);y-=v*scale;if(v>0)svg.appendChild(svgEl('rect',{x:x,y:y+1,width:52,height:h,fill:cols[k],rx:k===2?3:0}))});var hit=svgEl('rect',{x:x-8,y:30,width:68,height:200,fill:'transparent'});hit.addEventListener('mousemove',function(e){tip.style.display='block';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';tip.innerHTML=esc(d.date)+' · '+fmtK(total)+' tokens<br>input '+d.inputTokens.toLocaleString()+' · cached '+d.cachedTokens.toLocaleString()+' · output '+d.outputTokens.toLocaleString()+'<br>'+d.runs+' runs · '+fmtDur(d.providerMs)});hit.addEventListener('mouseleave',function(){tip.style.display='none'});svg.appendChild(hit);
    var lab=svgEl('text',{x:x+26,y:244,'text-anchor':'middle','font-family':'IBM Plex Mono,monospace','font-size':'11',fill:i===days.length-1?'#f3efe6':'#847e75'});lab.textContent=i===days.length-1?'Today':new Date(d.date+'T12:00:00').toLocaleDateString([],{weekday:'short'});svg.appendChild(lab);if(i===days.length-1&&total>0){var t=svgEl('text',{x:x+26,y:y-6,'text-anchor':'middle','font-family':'IBM Plex Mono,monospace','font-size':'11',fill:'#f3efe6'});t.textContent=fmtK(total);svg.appendChild(t)}});}
  ids('tok-table').innerHTML=days.map(function(d){return'<tr><td>'+esc(d.date)+'</td><td>'+d.runs+'</td><td>'+d.failedRuns+'</td><td>'+d.inputTokens.toLocaleString()+'</td><td>'+d.cachedTokens.toLocaleString()+'</td><td>'+d.outputTokens.toLocaleString()+'</td><td>'+fmtDur(d.providerMs)+'</td><td>'+fmtSec(d.voiceSeconds)+'</td></tr>'}).join('');
  ids('tok-note').textContent=u.tokenCoverage<1?'tokens reported for '+Math.round(u.tokenCoverage*100)+'% of runs':'hover a bar for the split'}
function renderLatency(u){var svg=ids('lat-chart');svg.innerHTML='';var runs=logEvents.filter(function(e){return e.kind==='run.completed'&&e.metadata&&e.metadata.durationMs}).slice(0,24).reverse().map(function(e){return e.metadata.durationMs});if(runs.length>1){var max=Math.max.apply(null,runs);var pts=runs.map(function(v,i){return[(i/(runs.length-1))*320,52-(v/max)*40]});svg.appendChild(svgEl('polyline',{fill:'none',stroke:'#2f3539','stroke-width':1,points:'0,52 320,52'}));svg.appendChild(svgEl('polygon',{fill:'rgba(208,138,75,.14)',points:'0,52 '+pts.map(function(p){return p[0]+','+p[1]}).join(' ')+' 320,52'}));svg.appendChild(svgEl('polyline',{fill:'none',stroke:'#d08a4b','stroke-width':2,points:pts.map(function(p){return p[0]+','+p[1]}).join(' ')}));var last=pts[pts.length-1];svg.appendChild(svgEl('circle',{cx:last[0],cy:last[1],r:4,fill:'#d08a4b',stroke:'#1b1e20','stroke-width':2}))}else{var t=svgEl('text',{x:0,y:40,'font-family':'IBM Plex Mono,monospace','font-size':'11',fill:'#847e75'});t.textContent=runs.length?'one run so far':'no runs recorded yet';svg.appendChild(t)}
  var l=u.latency;ids('lat-kv').innerHTML='<dt>p50 first text</dt><dd class="mono">'+fmtDur(l.p50FirstTextMs)+'</dd><dt>p50 turn</dt><dd class="mono">'+fmtDur(l.p50Ms)+'</dd><dt>p95 turn</dt><dd class="mono">'+fmtDur(l.p95Ms)+'</dd><dt>samples (7d)</dt><dd class="mono">'+l.samples+'</dd><dt>whisper rtf</dt><dd class="mono">'+(u.voice.realTimeFactor!=null?u.voice.realTimeFactor.toFixed(2)+'×':'–')+'</dd>'}
function renderQuotaCard(u){var lim=u.limits||{};var parts=[];['codex','claude'].forEach(function(p){var e=lim[p];if(!e)return;parts.push('<div class="eyebrow" style="margin-top:6px">'+p+' · '+esc(e.kind)+'</div><div class="meter"><i style="width:100%"></i></div><dl class="kv"><dt>back at</dt><dd class="mono">'+esc(new Date(e.until).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}))+'</dd><dt>reason</dt><dd style="font-size:12.5px">'+esc(e.reason)+'</dd><dt>since</dt><dd class="mono">'+fmtAgo(e.since)+'</dd></dl>')});ids('quota-card').innerHTML=(parts.length?parts.join(''):'<div class="eyebrow">Codex</div><div class="meter"><i style="width:0"></i></div><dl class="kv"><dt>state</dt><dd class="mono">open · no cooldown</dd></dl>')+'<p style="font-size:12.5px;color:var(--ink-3);margin-top:10px">Codex prints its reset time when it refuses a turn; Kelly records it here and parks the turn until then. A subscription reports no percentage in advance, so none is shown.</p>';ids('usage-pill').className='pill '+(lim.codex?'crit':'good');ids('usage-pill').innerHTML='<i></i>'+(lim.codex?'codex parked':'no cooldown active')}
function renderMachine(d){if(!d)return;var kv='<dt>RAM (Kelly + children)</dt><dd class="mono">'+fmtBytes(d.totalRssBytes)+' / 5 GB</dd><dt>memory pressure</dt><dd><span class="pill '+(d.memoryPressure&&d.memoryPressure.level==='normal'?'good':d.memoryPressure&&d.memoryPressure.level==='critical'?'crit':'warn')+'" style="padding:1px 7px"><i></i>'+esc(d.memoryPressure?d.memoryPressure.level+' · '+d.memoryPressure.freePercent+'% free':'–')+'</span></dd><dt>uptime</dt><dd class="mono">'+fmtSec((d.heartbeat||{}).uptimeSec)+'</dd><dt>in flight</dt><dd class="mono">'+((d.agentState||{}).running||0)+' run'+(((d.agentState||{}).running||0)===1?'':'s')+'</dd>'+(latestUsage?'<dt>voice today</dt><dd class="mono">'+fmtSec(latestUsage.today.voiceSeconds)+'</dd>':'');ids('machine-kv').innerHTML=kv}
function loadUsage(){return get('/api/usage').then(function(u){latestUsage=u;renderTokens(u);renderLatency(u);renderQuotaCard(u);renderQuota(u);if(lastResources)renderMachine(lastResources);if(!logEvents.length)loadLogs().then(function(){renderLatency(u)})}).catch(function(e){ids('quota-card').innerHTML='<div class="empty">Could not load usage: '+esc(e.message)+'</div>'})}

/* ---- catalogue ---- */
function productRow(p){return'<div class="row"><b>'+esc(p.name)+'</b> <span class="lang">'+esc(p.brand)+'</span><div class="dim">'+esc(p.sku||'')+' · '+esc(p.specification||p.category||'')+' · ₹'+esc((Number(p.pricePaise||0)/100).toFixed(2))+'</div></div>'}
function loadCatalogue(){return get('/api/catalogue/documents').then(function(d){var list=Array.isArray(d)?d:[];var pub=list.filter(function(x){return x.status==='published'}).length;ids('cat-stats').innerHTML='<span class="stat"><b>'+pub+'</b><span>published files</span></span><span class="stat"><b>'+(list.length-pub)+'</b><span>awaiting review</span></span>';ids('cat-pill').innerHTML='<i></i>'+list.length+' supplier file'+(list.length===1?'':'s');ids('cat-docs').innerHTML=list.length?list.slice(0,12).map(function(x){return'<div class="row"><b>'+esc(x.fileName||x.name||x.id)+'</b><div class="dim">'+esc(x.status)+(x.brand?' · '+esc(x.brand):'')+(x.productCount!=null?' · '+esc(x.productCount)+' products':'')+'</div></div>'}).join(''):'<div class="empty">No supplier files imported yet.</div>'}).catch(function(e){ids('cat-docs').innerHTML='<div class="empty">'+esc(e.message.indexOf('503')>=0?'Catalogue is not available in this profile.':'Could not load the catalogue: '+e.message)+'</div>'})}
function searchCatalogue(){var q=ids('cat-q').value.trim();if(!q)return;ids('cat-results').innerHTML='<div class="empty">searching the published catalogue…</div>';get('/api/catalogue/search?q='+encodeURIComponent(q)).then(function(r){var list=Array.isArray(r)?r:(r.results||[]);ids('cat-results').innerHTML=list.length?list.map(productRow).join(''):'<div class="empty">No published product matches. Unpublished imports are not searchable until you publish them.</div>'}).catch(function(e){ids('cat-results').innerHTML='<div class="empty">'+esc(e.message)+'</div>'})}
ids('cat-go').addEventListener('click',searchCatalogue);ids('cat-q').addEventListener('keydown',function(e){if(e.key==='Enter')searchCatalogue()});

/* ---- boot ---- */
refreshStatus().then(refreshVoiceStatus).then(refreshOverview);
loadLogs();startEvents();go(location.hash.slice(1)||'overview',false);
setInterval(function(){if(!document.hidden)refreshOverview()},30000);
})();
</script></body></html>`;
