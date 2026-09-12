/** Main dashboard shell. The memory renderer stays in holo.js so its canvas code
 * can evolve independently from this page's controls and data panels. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07111f"><title>Henry · control room</title>
<style>
:root{color-scheme:dark;
/* Constellation palette (constellation-spec.md). Deep ink grounds, one accent
   doing the work per area. The old terminal-green survives only as the
   Communication node colour inside the graph legend — never as UI chrome. */
--bg:#07111f;--bg-deep:#030912;--panel:rgba(9,20,38,.72);--panel-2:rgba(12,28,52,.62);
--line:rgba(155,190,255,.18);--line-hot:rgba(38,230,255,.42);
--text:#eef7ff;--muted:#8aa4bf;--dim:#67839f;
--cyan:#26e6ff;--blue:#4e7dff;--violet:#8d5cff;--magenta:#ff4fd8;--teal:#35efc3;--amber:#ffc857;--red:#ff7a92;
--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--r:16px;--shadow:0 22px 48px -28px rgba(2,8,20,.95)}
*{box-sizing:border-box}html{background:var(--bg-deep)}
body{margin:0;color:var(--text);font:14px/1.55 var(--sans);letter-spacing:.004em;
background:radial-gradient(120% 80% at 12% -8%,rgba(38,230,255,.10),transparent 60%),radial-gradient(100% 70% at 88% -4%,rgba(141,92,255,.13),transparent 62%),radial-gradient(120% 90% at 50% 108%,rgba(78,125,255,.08),transparent 60%),linear-gradient(180deg,var(--bg),var(--bg-deep) 70%);background-attachment:fixed}
main{position:relative;z-index:1;max-width:1480px;margin:auto;padding:30px 32px 56px}
h1,h2,h3,p{margin:0}h1{font-size:23px;letter-spacing:-.028em;font-weight:600}
.eyebrow,.label,.tag{font:10px/1.2 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.eyebrow{color:var(--cyan);margin-bottom:6px}
.subtitle{color:var(--muted);font-size:12.5px;margin-top:3px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-bottom:26px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:13px}
.mark{width:13px;height:13px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#8ef4ff,var(--cyan) 55%,rgba(38,230,255,0) 76%);box-shadow:0 0 20px rgba(38,230,255,.75)}
.controls,.links{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.links{margin-top:20px}
.button,.link{display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:0 13px;color:var(--muted);border:1px solid var(--line);border-radius:11px;background:linear-gradient(180deg,var(--panel-2),var(--panel));text-decoration:none;font:11px var(--mono);letter-spacing:.07em;text-transform:uppercase;cursor:pointer;transition:color .16s,border-color .16s,background .16s}
.button:hover,.link:hover{color:var(--text);border-color:var(--line-hot)}
.button:focus-visible,.link:focus-visible,.seg button:focus-visible,.input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.button.primary{color:#04121e;border-color:transparent;background:linear-gradient(180deg,#6cf1ff,#20c9ff);font-weight:700;box-shadow:0 10px 26px -14px rgba(38,230,255,.9)}
.button.primary:hover{background:linear-gradient(180deg,#8df5ff,#3ad4ff);color:#04121e}
.seg{display:flex;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
.seg button{border:0;border-right:1px solid var(--line);border-radius:0;min-height:38px;padding:0 13px;background:transparent;color:var(--muted);font:11px var(--mono);letter-spacing:.07em;text-transform:uppercase;cursor:pointer}
.seg button:last-child{border-right:0}.seg button.active{background:rgba(38,230,255,.16);color:var(--cyan)}
.hero{display:grid;grid-template-columns:1.4fr repeat(5,1fr);gap:1px;margin:26px 0;background:var(--line);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow)}
.hero-item{min-height:92px;padding:17px 18px;background:linear-gradient(165deg,rgba(12,28,52,.86),rgba(7,17,31,.94));display:flex;flex-direction:column;justify-content:space-between;gap:8px}
.hero-item strong{font:17px var(--mono);color:var(--text);letter-spacing:-.01em}
.hero-item:first-child strong{color:var(--cyan)}
.heartbeat{display:flex;align-items:center;gap:9px}
.heartbeat i{display:block;width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 14px var(--cyan);animation:pulse 2.2s ease-in-out infinite}
.heartbeat i.stale{background:var(--dim);box-shadow:none;animation:none}
@keyframes pulse{50%{transform:scale(.62);opacity:.5}}
.metric-note{font-size:11px;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.card{min-width:0;background:linear-gradient(160deg,var(--panel-2),var(--panel));border:1px solid var(--line);border-radius:var(--r);padding:20px;box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.045);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
.card:hover{border-color:rgba(155,190,255,.28)}
.span-8{grid-column:span 8}.span-4{grid-column:span 4}.span-12{grid-column:1/-1}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:16px}
.card h2{font-size:14.5px;letter-spacing:-.012em;font-weight:600}
.card-head .label{color:var(--dim)}
.muted{color:var(--muted)}.dim{color:var(--dim)}
.scroll{max-height:320px;overflow:auto;scrollbar-color:rgba(155,190,255,.3) transparent}
.row{padding:12px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.tag{color:var(--cyan);font-size:9px}
.row-main{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.row-time{font:10px var(--mono);color:var(--dim);white-space:nowrap}
.row-copy{word-break:break-word;color:#cfdff2}
.telegram-tag{color:var(--teal)}
.approval{border-left:2px solid var(--amber);padding-left:12px}.approval button{margin-top:9px}
.stats{display:flex;gap:26px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:3px}
.stat b{font:21px var(--mono);color:var(--cyan);letter-spacing:-.02em}
.stat span{font:10px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.13em}
.status-strip{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--cyan);box-shadow:0 0 13px var(--cyan)}
.form-grid{display:grid;grid-template-columns:1fr auto;gap:11px}.form-grid textarea{grid-column:1/-1}
.input,textarea,select{width:100%;color:var(--text);background:rgba(3,9,18,.66);border:1px solid var(--line);border-radius:11px;padding:11px 12px;font:13px var(--sans)}
textarea{min-height:112px;resize:vertical}
.input::placeholder,textarea::placeholder{color:var(--dim)}
.input:focus,textarea:focus,select:focus{outline:none;border-color:var(--line-hot)}
#role,#task{margin-bottom:9px}
pre{white-space:pre-wrap;word-break:break-word;color:#c3d7ec;margin:13px 0 0;font:12px/1.6 var(--mono)}
.health{display:flex;gap:1px;flex-wrap:wrap;background:var(--line);border:1px solid var(--line);border-radius:13px;overflow:hidden}
.health .stat{background:linear-gradient(165deg,rgba(12,28,52,.8),rgba(7,17,31,.92));padding:13px 15px;min-width:124px}
.health .stat b{font-size:17px}.health .stat.bad b{color:var(--red)}
.badge{display:inline-block;width:max-content;border:1px solid var(--line);border-radius:99px;padding:3px 9px;color:var(--muted);font:10px var(--mono);letter-spacing:.1em;text-transform:uppercase}
.badge.normal{color:var(--teal);border-color:rgba(53,239,195,.4)}
.badge.warn{color:var(--amber);border-color:rgba(255,200,87,.45)}
.badge.critical{color:var(--red);border-color:rgba(255,122,146,.5)}
.meter{width:170px;height:5px;border-radius:99px;background:rgba(3,9,18,.8);border:1px solid var(--line);overflow:hidden}
.meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--blue));transition:width .4s}
.agent-row{display:grid;grid-template-columns:auto 1fr auto;gap:11px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
.agent-row:first-child{border-top:0}
.agent-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--dim)}
.agent-dot.running{background:var(--cyan);box-shadow:0 0 12px var(--cyan);animation:pulse 2s ease-in-out infinite}
.agent-dot.done{background:var(--teal)}.agent-dot.failed{background:var(--red)}
.agent-role{font:10px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--cyan)}
.agent-task{color:#cfdff2;word-break:break-word;margin-top:2px}
.agent-sub{font:10px var(--mono);color:var(--dim);margin-top:3px;letter-spacing:.06em}
.agent-when{font:10px var(--mono);color:var(--dim);white-space:nowrap;text-align:right}
.holo-card{padding:0;overflow:hidden}
.holo-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:20px 20px 16px}
.holo-head h2{font-size:18px}
.holo-stats{font:10px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);text-align:right}
.holo-body{padding:0 20px 4px}
.holo-readout{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;min-height:34px;padding:9px 20px;font:11px var(--mono);color:var(--muted)}
.holo-readout b{color:var(--text);font-size:12px}
.holo-readout i{color:var(--cyan);font-style:normal}
.holo-footer{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;padding:13px 20px;border-top:1px solid var(--line)}
.loading{color:var(--dim);font:11px var(--mono)}
@media(max-width:1050px){.hero{grid-template-columns:repeat(3,1fr)}.hero-item:first-child{grid-column:span 3}.span-8,.span-4{grid-column:1/-1}}
@media(max-width:600px){main{padding:20px 15px 36px}.topbar{align-items:flex-start;flex-direction:column}.hero{grid-template-columns:repeat(2,1fr)}.hero-item:first-child{grid-column:span 2}.form-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
</style></head><body><main>
<header class="topbar"><div class="brand"><span class="mark"></span><div><div class="eyebrow">personal operations system</div><h1>Henry <span class="dim">/ control room</span></h1><p class="subtitle">memory, work, and decisions — visible at a glance</p></div></div><div class="controls"><a class="button primary" href="/chat">chat with Henry ↗</a><div class="seg" title="Primary provider"><button id="prov-codex" onclick="setProvider('codex')">codex</button><button id="prov-claude" onclick="setProvider('claude')">claude</button></div><button class="button" onclick="refresh()">refresh</button></div></header>
<section class="hero" id="hero"><div class="hero-item"><span class="label">system state</span><div class="heartbeat"><i id="heartbeat-indicator"></i><strong id="hero-status">connecting</strong></div><span class="metric-note">live local process</span></div><div class="hero-item"><span class="label">provider</span><strong id="hero-provider">—</strong><span class="metric-note">primary brain</span></div><div class="hero-item"><span class="label">uptime</span><strong id="hero-uptime">—</strong><span class="metric-note">since boot</span></div><div class="hero-item"><span class="label">last event</span><strong id="hero-last-activity">—</strong><span class="metric-note">activity stream</span></div><div class="hero-item"><span class="label">approvals</span><strong id="hero-pending">—</strong><span class="metric-note">awaiting you</span></div><div class="hero-item"><span class="label">memory pressure</span><span class="badge" id="mem-pressure-badge">—</span><span class="metric-note">agent stack</span></div></section>
<div class="links"><a class="link" href="/chat">open chat ↗</a><a class="link" href="/memory">memory observatory ↗</a><a class="link" href="/logs">all logs ↗</a><a class="link" href="/logs?source=telegram">telegram pipeline ↗</a><span class="dim label" id="ram-bar-label">ram —</span><div class="meter"><i id="ram-bar-fill"></i></div></div>
<section class="grid"><div class="card span-12"><div class="card-head"><h2>system snapshot</h2><span class="label">health telemetry</span></div><div class="status-strip" id="status"><span class="status-dot"></span><span class="loading">loading status…</span></div></div>
<div class="card span-12"><div class="card-head"><h2>memory health</h2><span class="label">engram / retrieval</span></div><div class="health" id="memory-health-body"><span class="loading">loading metrics…</span></div></div>
<div class="card span-8"><div class="card-head"><h2>ask Henry</h2><span class="label">one-shot terminal work</span></div><div class="form-grid"><textarea id="prompt" placeholder="What should Henry investigate?"></textarea><button class="button primary" onclick="ask()">run query</button></div><pre id="answer"></pre></div>
<div class="card span-4"><div class="card-head"><h2>dispatch</h2><span class="label">Luna / specialist</span></div><select id="role"><option>architect</option><option>runtime</option><option>memory</option><option>dashboard</option><option>gmail</option><option>pr-review</option><option>job-application</option><option>research</option><option>qa</option></select><input class="input" id="task" placeholder="Task for the specialist"><button class="button primary" onclick="dispatch()">dispatch</button><pre id="dispatchResult"></pre></div>
<div class="card span-12"><div class="card-head"><h2>agent activity</h2><span class="label">running / recently finished</span></div><div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:20px"><div><div class="label" style="margin-bottom:8px">running now</div><div id="agents-running" class="scroll"><span class="loading">loading…</span></div></div><div><div class="label" style="margin-bottom:8px">recently finished</div><div id="agents-recent" class="scroll"><span class="loading">loading…</span></div></div></div></div>
<div class="card span-8"><div class="card-head"><h2>activity stream</h2><a class="link" href="/logs">open full log ↗</a></div><div id="activity" class="scroll"><span class="loading">waiting for activity…</span></div></div>
<div class="card span-4"><div class="card-head"><h2>approval queue</h2><span class="label">human gate</span></div><div id="approvals" class="scroll"><span class="loading">loading…</span></div></div>
<div class="card span-12"><div class="card-head"><h2>job applications</h2><a class="link" href="/logs?source=jobs">application log ↗</a></div><div id="jobstats" class="stats"></div><div id="jobs" class="scroll" style="margin-top:10px"></div></div>
<div class="card span-12 holo-card"><div class="holo-head"><div><div class="eyebrow">associative memory</div><h2>Memory constellation</h2><p class="subtitle">stars are memories · filaments are typed associations</p></div><span class="holo-stats" id="holo-stats">—</span></div><div class="holo-body"><div id="holo-mount"></div></div><div class="holo-readout" id="holo-readout"></div><div class="holo-footer"><span class="dim">personal memory and curated knowledge remain separate stores</span><div class="controls"><a class="link" href="/memory">open observatory ↗</a><a class="link" href="/logs?source=telegram">telegram logs ↗</a></div></div></div>
<div class="card span-4"><div class="card-head"><h2>knowledge base</h2><span class="label">on demand RAG</span></div><div id="knowledge"><span class="loading">loading…</span></div></div><div class="card span-8"><div class="card-head"><h2>prepared documents</h2><span class="label">resume / cover letters</span></div><div id="covers" class="scroll"><span class="loading">loading…</span></div></div></section></main>
<script>
(function(){'use strict';
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var get=function(p){return fetch(p).then(function(r){return r.json()})};var post=function(p,b){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json()})};
var ids=function(id){return document.getElementById(id)};var seen={};var activityLimit=80;var rss=[];var budget=5*1024*1024*1024;
function fmtBytes(n){if(n==null||!isFinite(n))return'—';return n/1073741824>=1?(n/1073741824).toFixed(2)+' GB':Math.round(n/1048576)+' MB'}function fmtDuration(s){if(s==null||!isFinite(s))return'—';s=Math.max(0,Math.round(s));return s>=3600?Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m':s>=60?Math.floor(s/60)+'m '+s%60+'s':s+'s'}function fmtWhen(i){if(!i)return'—';try{var d=new Date(i),n=(Date.now()-d.getTime())/1000;return n<5?'just now':n<60?Math.floor(n)+'s ago':n<3600?Math.floor(n/60)+'m ago':d.toLocaleTimeString()}catch(e){return'—'}}function fmtPct(n){return n==null||!isFinite(n)?'—':Math.round(n*100)+'%'}function fmtMs(n){return n==null||!isFinite(n)?'—':Math.round(n)+'ms'}
function isTelegram(x){return Boolean(x&&x.metadata&&(x.metadata.telegram||x.metadata.standup||x.metadata.bridge))||/telegram/i.test((x&&x.kind||'')+' '+(x&&x.message||''))}function activityRow(x){return'<div class="row"><div class="row-main"><span class="tag '+(isTelegram(x)?'telegram-tag':'')+'">'+(isTelegram(x)?'telegram · ':'')+esc(x.kind)+'</span><span class="row-time">'+esc(fmtWhen(x.timestamp))+'</span></div><div class="row-copy">'+esc(x.message)+'</div></div>'}function renderActivity(a){ids('activity').innerHTML=(a||[]).map(activityRow).join('')||'<span class="dim">No activity yet.</span>'}function loadActivity(){return get('/api/activity?limit='+activityLimit).then(renderActivity).catch(function(){ids('activity').innerHTML='<span class="dim">Activity unavailable.</span>'})}
function refreshStatus(){return get('/api/status').then(function(s){ids('prov-codex').classList.toggle('active',s.provider==='codex');ids('prov-claude').classList.toggle('active',s.provider==='claude');ids('hero-provider').textContent=s.provider;ids('hero-status').textContent='live';ids('hero-pending').textContent=s.approvals??0;ids('status').innerHTML='<span class="status-dot"></span><div class="stats"><span class="stat"><b>'+esc(s.name)+'</b><span>agent</span></span><span class="stat"><b>'+esc(s.approvals)+'</b><span>approvals</span></span><span class="stat"><b>'+esc(s.jobs&&s.jobs.readyForReview||0)+'</b><span>jobs ready</span></span><span class="stat"><b>'+esc(s.memory&&s.memory.memories||0)+'</b><span>memories</span></span><span class="stat"><b>'+esc(s.dashboard)+'</b><span>endpoint</span></span></div>';}).catch(function(){ids('status').innerHTML='<span class="dim">Status unavailable — refresh to retry.</span>';ids('hero-status').textContent='unavailable'})}
function refreshResources(){return get('/api/resources').then(function(d){var n=d.totalRssBytes||0,p=Math.min(100,n/budget*100);ids('ram-bar-fill').style.width=p+'%';ids('ram-bar-label').textContent='ram '+fmtBytes(n)+' / 5.00 GB';var b=ids('mem-pressure-badge'),m=d.memoryPressure;b.className='badge'+(m?' '+m.level:'');b.textContent=m?m.level.toUpperCase()+' · '+m.freePercent+'% free':'—';var a=d.agentState||{};ids('hero-status').textContent=a.state==='working'?'working · '+(a.running||0):'live';ids('hero-uptime').textContent=fmtDuration((d.heartbeat||{}).uptimeSec);ids('hero-last-activity').textContent=fmtWhen((d.heartbeat||{}).lastActivityAt);ids('hero-pending').textContent=(d.heartbeat||{}).pendingApprovals??'—';rss.push(n);if(rss.length>60)rss.shift()}).catch(function(){})}
function refreshApprovals(){return get('/api/approvals').then(function(p){ids('approvals').innerHTML=(p||[]).map(function(x){return'<div class="row approval"><b>'+esc(x.title)+'</b><div class="dim">'+esc(x.status)+' · '+esc(x.recipient||'')+'</div><pre>'+esc(x.body)+'</pre>'+(x.status==='pending'?'<button class="button" data-approval-action="approve-execute" data-id="'+esc(x.id)+'">approve &amp; execute</button>':'')+(x.status==='approved'?'<button class="button" data-approval-action="execute" data-id="'+esc(x.id)+'">execute</button>':'')+(x.status==='failed'&&x.kind==='social.x-post'?'<button class="button" data-approval-action="retry" data-id="'+esc(x.id)+'">stage retry</button>':'')+'</div>'}).join('')||'<span class="dim">Nothing waiting.</span>';ids('approvals').querySelectorAll('[data-approval-action]').forEach(function(b){b.addEventListener('click',function(){var action=b.getAttribute('data-approval-action'),id=b.getAttribute('data-id');if(action==='approve-execute')approveExecute(id);else if(action==='retry')retry(id);else execute(id)})})}).catch(function(){ids('approvals').innerHTML='<span class="dim">Approvals unavailable — retrying.</span>'})}
function refreshJobs(){return get('/api/jobs').then(function(j){var s=j.summary||{};ids('jobstats').innerHTML=['total','discovered','drafted','readyForReview','filled','submitted'].map(function(k){return'<span class="stat"><b>'+esc(s[k]??0)+'</b><span>'+esc(k.replace(/([A-Z])/g,' $1'))+'</span></span>'}).join('');ids('jobs').innerHTML=(j.applications||[]).map(function(x){return'<div class="row"><b>'+esc(x.posting&&x.posting.title)+' · '+esc(x.posting&&x.posting.company)+'</b><div class="dim">'+esc(x.status)+' · '+esc(x.posting&&x.posting.url)+'</div></div>'}).join('')||'<span class="dim">No job applications yet.</span>'}).catch(function(){})}
function refreshKnowledge(){return get('/api/knowledge').then(function(k){if(k.error){ids('knowledge').innerHTML='<span class="dim">'+esc(k.error)+'</span>';return}var s=k.stats;ids('knowledge').innerHTML=s?'<div class="stats"><span class="stat"><b>'+esc(s.count||0)+'</b><span>entries</span></span>'+Object.entries(s.domains||s.tiers||{}).map(function(e){return'<span class="stat"><b>'+esc(e[1])+'</b><span>'+esc(e[0])+'</span></span>'}).join('')+'</div>':k.loading?'<span class="dim">Index warming — metrics will appear automatically.</span>':'<span class="dim">No knowledge base yet.</span>'}).catch(function(){ids('knowledge').innerHTML='<span class="dim">Knowledge metrics unavailable — retrying.</span>'})}
function refreshHealth(){return get('/api/engram/metrics').then(function(m){if(!m||m.available===false){ids('memory-health-body').innerHTML='<span class="dim">Recall metrics unavailable.</span>';return}var f=m.indexFreshness||{};ids('memory-health-body').innerHTML=[['coverage',fmtPct(m.recallCoverage),m.recallCoverage!=null&&m.recallCoverage<.6],['zero-result',fmtPct(m.zeroResultRate),false],['p50',fmtMs(m.p50LatencyMs),false],['p95',fmtMs(m.p95LatencyMs),m.p95LatencyMs>2000],['personal index',fmtWhen(f.personal),false],['knowledge index',fmtWhen(f.knowledge),false]].map(function(x){return'<span class="stat '+(x[2]?'bad':'')+'"><b>'+x[1]+'</b><span>'+x[0]+'</span></span>'}).join('')}).catch(function(){})}
function refreshCovers(){return get('/api/covers').then(function(c){ids('covers').innerHTML=(c||[]).map(function(x){return'<div class="row"><b>'+esc(x.name)+'</b><div class="dim">'+esc(Math.round((x.size||0)/1024))+' KB · '+esc(new Date(x.mtime).toLocaleString())+'</div></div>'}).join('')||'<span class="dim">No cover letters yet.</span>'}).catch(function(){})}

/* Agent activity — display only, no dispatch control lives here. The backend
   (GET /api/agents -> {running:Agent[],recent:Agent[]}, plus 'agent' events on
   the existing /api/events stream) is being built in parallel; until it lands
   this panel says so honestly instead of inventing rows. */
var agentsAvailable=null;
function elapsed(a){var start=a.startedAt?Date.parse(a.startedAt):NaN;var end=a.finishedAt?Date.parse(a.finishedAt):Date.now();return isFinite(start)?fmtDuration((end-start)/1000):'—'}
function agentRow(a,running){var status=String(a.status||(running?'running':'done'));var cls=status==='failed'?'failed':status==='running'?'running':'done';var sub=[a.provider?'provider '+a.provider:'',running?'elapsed '+elapsed(a):status+' · '+elapsed(a),a.summary?String(a.summary):''].filter(Boolean).join(' · ');return'<div class="agent-row"><span class="agent-dot '+cls+'"></span><div><div class="agent-role">'+esc(a.role||'agent')+'</div><div class="agent-task">'+esc(a.task||'(no task recorded)')+'</div><div class="agent-sub">'+esc(sub)+'</div></div><span class="agent-when">'+esc(fmtWhen(running?a.startedAt:(a.finishedAt||a.startedAt)))+'</span></div>'}
function renderAgents(d){var running=(d&&d.running)||[],recent=(d&&d.recent)||[];ids('agents-running').innerHTML=running.length?running.map(function(a){return agentRow(a,true)}).join(''):'<span class="dim">No agents running right now.</span>';ids('agents-recent').innerHTML=recent.length?recent.map(function(a){return agentRow(a,false)}).join(''):'<span class="dim">No finished agents recorded yet.</span>'}
function refreshAgents(){return fetch('/api/agents',{headers:{accept:'application/json'}}).then(function(r){if(r.status===404){agentsAvailable=false;throw new Error('missing')}if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){agentsAvailable=true;renderAgents(d)}).catch(function(){var note=agentsAvailable===false?'Agent feed not wired up yet — this panel fills in once /api/agents ships.':'Agent activity unavailable — retrying.';ids('agents-running').innerHTML='<span class="dim">'+note+'</span>';ids('agents-recent').innerHTML='<span class="dim">—</span>'})}
function refresh(){[refreshStatus,refreshResources,refreshApprovals,refreshJobs,refreshKnowledge,refreshHealth,refreshCovers,loadActivity,refreshAgents].forEach(function(fn){fn()})}window.refresh=refresh;
window.ask=function(){var p=ids('prompt').value;if(!p.trim())return;ids('answer').textContent='Henry is thinking…';post('/api/ask',{prompt:p}).then(function(r){ids('answer').textContent=r.response||r.error||JSON.stringify(r,null,2);refresh()})};window.dispatch=function(){var task=ids('task').value;if(!task.trim())return;ids('dispatchResult').textContent='Luna is dispatching…';post('/api/dispatch',{role:ids('role').value,task:task}).then(function(r){ids('dispatchResult').textContent=r.response||r.error||JSON.stringify(r,null,2);refresh()})};window.approve=function(id){post('/api/approvals/'+encodeURIComponent(id)+'/approve').then(refresh)};window.execute=function(id){post('/api/approvals/'+encodeURIComponent(id)+'/execute').then(function(r){alert(r.result||r.error||'Done');refresh()})};window.approveExecute=function(id){if(!confirm('Approve this exact item and execute it now?'))return;post('/api/approvals/'+encodeURIComponent(id)+'/approve-execute').then(function(r){alert(r.result||r.error||'Done');refresh()})};window.retry=function(id){post('/api/approvals/'+encodeURIComponent(id)+'/retry').then(function(r){alert(r.error||'Retry staged');refresh()})};window.setProvider=function(name){post('/api/settings/provider',{provider:name}).then(function(r){if(r.error)alert(r.error);refresh()})};
var es;var agentTimer=null;function startEvents(){try{es=new EventSource('/api/events');es.addEventListener('hello',function(){ids('hero-status').textContent='live'});es.addEventListener('agent',function(){if(agentTimer)clearTimeout(agentTimer);agentTimer=setTimeout(refreshAgents,250)});es.addEventListener('activity',function(e){try{var x=JSON.parse(e.data);if(!seen[x.id]){seen[x.id]=1;loadActivity()}}catch(z){}});es.addEventListener('resources',function(e){try{var d=JSON.parse(e.data);var n=d.totalRssBytes||0,p=Math.min(100,n/budget*100);ids('ram-bar-fill').style.width=p+'%';ids('ram-bar-label').textContent='ram '+fmtBytes(n)+' / 5.00 GB'}catch(z){}});es.onerror=function(){if(es){es.close();es=null}}}catch(e){}}
function starfield(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;var c=document.createElement('canvas');c.setAttribute('aria-hidden','true');c.style='position:fixed;inset:0;pointer-events:none;opacity:.5;z-index:0';document.body.appendChild(c);var x=c.getContext('2d'),pts=[],dpr=Math.min(2,devicePixelRatio||1);function size(){c.width=innerWidth*dpr;c.height=innerHeight*dpr;c.style.width=innerWidth+'px';c.style.height=innerHeight+'px';x.setTransform(dpr,0,0,dpr,0,0);pts=[];var n=Math.min(150,Math.round(innerWidth*innerHeight/13000));for(var i=0;i<n;i++)pts.push({x:Math.random()*innerWidth,y:Math.random()*innerHeight,r:.4+Math.random()*.9,a:.05+Math.random()*.16,v:.004+Math.random()*.012,p:Math.random()*6.283})}
function draw(t){if(!document.hidden){x.clearRect(0,0,innerWidth,innerHeight);x.fillStyle='#cfe6ff';for(var i=0;i<pts.length;i++){var s2=pts[i];x.globalAlpha=s2.a*(.62+.38*Math.sin(t*s2.v*.06+s2.p));x.beginPath();x.arc(s2.x,s2.y,s2.r,0,6.283);x.fill()}x.globalAlpha=1}requestAnimationFrame(draw)}
addEventListener('resize',size);size();requestAnimationFrame(draw)}starfield();refresh();startEvents();setInterval(function(){if(!document.hidden)refresh()},10000);
})();
</script><script src="/constellation.js" defer></script><script src="/holo.js" defer></script></body></html>`;
