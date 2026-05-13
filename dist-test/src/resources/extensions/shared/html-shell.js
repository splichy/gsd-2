function renderHtmlShell(options) {
  const version = options.version ? `v${esc(options.version)}` : "";
  const documentTitle = options.documentTitle ?? `${options.kind} - ${options.title}`;
  const subtitle = options.subtitle ? `<span class="header-path">${esc(options.subtitle)}</span>` : "";
  const toc = options.toc?.length ? `<nav class="toc" aria-label="Report sections">
  <ul>
${options.toc.map((item) => `    <li><a href="${esc(item.href)}">${esc(item.label)}</a></li>`).join("\n")}
  </ul>
</nav>` : "";
  const actions = options.headerActionsHtml ? `${options.headerActionsHtml}` : "";
  const footerNote = options.footerNote ? `<span class="sep">/</span>
    <span>${esc(options.footerNote)}</span>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(documentTitle)}</title>
<style>${HTML_SHELL_CSS}</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="branding">
      <span class="logo">GSD</span>
      ${version ? `<span class="version">${version}</span>` : ""}
    </div>
    <div class="header-meta">
      <h1>${esc(options.title)}</h1>
      ${subtitle}
    </div>
    <div class="header-right">
      ${actions}
      <span class="kind-chip">${esc(options.kind)}</span>
      <div class="generated">${formatDateLong(options.generatedAt)}</div>
    </div>
  </div>
</header>
${toc}
<main>
${options.mainHtml}
</main>
<footer>
  <div class="footer-inner">
    <span>GSD${version ? ` ${version}` : ""}</span>
    <span class="sep">/</span>
    <span>${esc(options.kind)}</span>
    ${footerNote}
    <span class="sep">/</span>
    <span>${formatDateLong(options.generatedAt)}</span>
  </div>
</footer>
<script>${HTML_SHELL_JS}</script>
</body>
</html>`;
}
function renderHtmlShellTemplate(options) {
  return renderHtmlShell({
    ...options,
    generatedAt: options.generatedAtPlaceholder ?? "{{GENERATED_AT}}",
    mainHtml: options.mainPlaceholder
  });
}
function formatDateLong(iso) {
  if (/^\{\{[A-Z_]+\}\}$/.test(iso)) return iso;
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  } catch {
    return iso;
  }
}
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const HTML_SHELL_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-0:#0f1115;--bg-1:#16181d;--bg-2:#1e2028;--bg-3:#272a33;
  --border-1:#2b2e38;--border-2:#3b3f4c;
  --text-0:#ededef;--text-1:#a1a1aa;--text-2:#71717a;
  --accent:#5e6ad2;--accent-subtle:rgba(94,106,210,.12);
  --ok:#22c55e;--ok-subtle:rgba(34,197,94,.12);--warn:#ef4444;--caution:#eab308;
  /* Chart palette - 6 hues for bar charts */
  --c0:#5e6ad2;--c1:#e5796d;--c2:#14b8a6;--c3:#a78bfa;--c4:#f59e0b;--c5:#10b981;
  /* Token breakdown - 4 distinct hues */
  --tk-input:#5e6ad2;--tk-output:#e5796d;--tk-cache-r:#2dd4bf;--tk-cache-w:#64748b;
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,monospace;
}
html{scroll-behavior:smooth;font-size:13px}
body{background:var(--bg-0);color:var(--text-0);font-family:var(--font);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:12px;background:var(--bg-3);padding:1px 5px;border-radius:3px}
.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--text-2)}
.accent{color:var(--accent)}
.sep{color:var(--border-2);margin:0 4px}
.empty{color:var(--text-2);padding:8px 0;font-size:13px}
.indent{padding-left:12px}
.num{font-variant-numeric:tabular-nums;text-align:right}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;vertical-align:middle}
.dot-sm{width:6px;height:6px}
.dot-complete{background:var(--ok);opacity:.6}
.dot-active{background:var(--accent)}
.dot-pending{background:transparent;border:1.5px solid var(--border-2)}
.dot-parked{background:var(--warn);opacity:.5}
header{background:var(--bg-1);border-bottom:1px solid var(--border-1);padding:12px 32px;position:sticky;top:0;z-index:200}
.header-inner{display:flex;align-items:center;gap:16px;max-width:1280px;margin:0 auto}
.branding{display:flex;align-items:baseline;gap:6px;flex-shrink:0}
.logo{font-size:18px;font-weight:800;letter-spacing:-.5px;color:var(--text-0)}
.version{font-size:10px;color:var(--text-2);font-family:var(--mono)}
.header-meta{flex:1;min-width:0}
.header-meta h1{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-path{font-size:11px;color:var(--text-2);font-family:var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-right{text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.generated{font-size:11px;color:var(--text-2)}
.kind-chip{font-size:10px;font-weight:600;color:var(--accent);background:var(--accent-subtle);border:1px solid rgba(94,106,210,.25);border-radius:3px;padding:2px 7px;text-transform:uppercase;letter-spacing:.4px}
.back-link{font-size:12px;color:var(--text-1)}
.back-link:hover{color:var(--accent)}
.toc{background:var(--bg-1);border-bottom:1px solid var(--border-1);overflow-x:auto}
.toc ul{display:flex;list-style:none;max-width:1280px;margin:0 auto;padding:0 32px}
.toc a{display:inline-block;padding:8px 12px;color:var(--text-2);font-size:12px;font-weight:500;border-bottom:2px solid transparent;transition:color .12s,border-color .12s;white-space:nowrap;text-decoration:none}
.toc a:hover{color:var(--text-0);border-bottom-color:var(--border-2)}
.toc a.active{color:var(--text-0);border-bottom-color:var(--accent)}
main{max-width:1280px;margin:0 auto;padding:32px;display:flex;flex-direction:column;gap:48px}
section{scroll-margin-top:82px}
section>h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-1);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border-1);display:flex;align-items:center;gap:8px}
h3{font-size:13px;font-weight:600;color:var(--text-1);margin:20px 0 8px}
.count{font-size:11px;font-weight:500;color:var(--text-2);background:var(--bg-3);border-radius:3px;padding:1px 6px}
.count-warn{color:var(--caution)}
.kv-grid{display:flex;flex-wrap:wrap;gap:1px;background:var(--border-1);border:1px solid var(--border-1);border-radius:4px;overflow:hidden;margin-bottom:16px}
.kv{background:var(--bg-1);padding:10px 16px;display:flex;flex-direction:column;gap:2px;min-width:110px;flex:1}
.kv-val{font-size:18px;font-weight:600;color:var(--text-0);font-variant-numeric:tabular-nums}
.kv-lbl{font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px}
.progress-wrap{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.progress-track{flex:1;height:4px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.progress-fill{height:100%;background:var(--accent);border-radius:2px}
.progress-label{font-size:12px;font-weight:600;color:var(--text-1);min-width:40px;text-align:right}
.active-info{font-size:12px;color:var(--text-1);margin-bottom:4px}
.activity-line{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-1);padding:6px 0}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{color:var(--text-2);font-weight:500;padding:6px 12px;text-align:left;border-bottom:1px solid var(--border-1);font-size:11px;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.tbl td{padding:6px 12px;border-bottom:1px solid var(--border-1);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl tbody tr:hover td{background:var(--accent-subtle)}
.tbl-kv td:first-child{color:var(--text-2);width:180px}
.table-scroll{overflow-x:auto;border:1px solid var(--border-1);border-radius:4px}
.table-scroll .tbl{border:none}
.h-ok td:first-child{color:var(--text-1)}
.h-caution td{color:var(--caution)}
.h-warn td{color:var(--warn)}
.label{font-size:10px;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.4px}
.risk{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0}
.risk-low{color:var(--text-2)}
.risk-medium{color:var(--caution)}
.risk-high{color:var(--warn)}
.risk-unknown{color:var(--text-2)}
.tag-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.tag{font-size:11px;font-family:var(--mono);color:var(--text-2);background:var(--bg-3);border-radius:3px;padding:1px 6px}
.verif{font-size:12px;color:var(--text-1);padding:4px 0;margin-bottom:6px}
.verif-blocker{color:var(--warn)}
.detail-block{font-size:12px;color:var(--text-2);margin-bottom:6px}
.detail-label{font-weight:600;color:var(--text-1);display:block;margin-bottom:2px}
.detail-block ul{padding-left:16px;margin-top:2px}
.detail-block li{margin-bottom:1px}
.ms-block{border:1px solid var(--border-1);border-radius:4px;overflow:hidden;margin-bottom:8px}
.ms-summary{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;list-style:none;background:var(--bg-1);user-select:none;font-size:13px}
.ms-summary:hover{background:var(--bg-2)}
.ms-summary::-webkit-details-marker{display:none}
.ms-id{font-weight:600}
.ms-title{flex:1;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms-body{padding:6px 12px 8px 24px;display:flex;flex-direction:column;gap:4px}
.sl-block{border:1px solid var(--border-1);border-radius:3px;overflow:hidden}
.sl-summary{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;list-style:none;background:var(--bg-2);font-size:12px;user-select:none}
.sl-summary:hover{background:var(--bg-3)}
.sl-summary::-webkit-details-marker{display:none}
.sl-crit{border-left:2px solid var(--accent)}
.sl-deps::before{content:'\\2190 ';color:var(--border-2)}
.sl-detail{padding:8px 12px;background:var(--bg-0);border-top:1px solid var(--border-1)}
.task-list{list-style:none;padding:4px 0 0;display:flex;flex-direction:column;gap:2px}
.task-row{display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 6px;border-radius:2px}
.dep-block{margin-bottom:28px}
.dep-legend{display:flex;gap:14px;font-size:12px;color:var(--text-2);margin-bottom:8px;align-items:center}
.dep-legend span{display:flex;align-items:center;gap:4px}
.dep-wrap{overflow-x:auto;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:16px}
.dep-svg{display:block}
.edge{fill:none;stroke:var(--border-2);stroke-width:1.5}
.edge-crit{stroke:var(--accent);stroke-width:2}
.node rect{fill:var(--bg-2);stroke:var(--border-2);stroke-width:1}
.n-done rect{fill:var(--ok-subtle);stroke:rgba(34,197,94,.4)}
.n-active rect{fill:var(--accent-subtle);stroke:var(--accent)}
.n-crit rect{stroke:var(--accent)!important;stroke-width:1.5!important}
.n-id{font-family:var(--mono);font-size:10px;fill:var(--text-1);font-weight:600;text-anchor:middle}
.n-title{font-size:9px;fill:var(--text-2);text-anchor:middle}
.n-active .n-id{fill:var(--accent)}
.token-block{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px;margin-bottom:16px}
.token-bar{display:flex;height:16px;border-radius:2px;overflow:hidden;gap:1px;margin-bottom:8px}
.tseg{height:100%;min-width:2px}
.seg-1{background:var(--tk-input)}
.seg-2{background:var(--tk-output)}
.seg-3{background:var(--tk-cache-r)}
.seg-4{background:var(--tk-cache-w)}
.token-legend{display:flex;flex-wrap:wrap;gap:12px}
.leg-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2)}
.leg-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.chart-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:16px}
.chart-block{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px}
.bar-row{display:grid;grid-template-columns:120px 1fr 68px;align-items:center;gap:6px;margin-bottom:2px}
.bar-lbl{font-size:12px;color:var(--text-2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{height:14px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;background:var(--c0)}
.bar-c0{background:var(--c0)}.bar-c1{background:var(--c1)}.bar-c2{background:var(--c2)}
.bar-c3{background:var(--c3)}.bar-c4{background:var(--c4)}.bar-c5{background:var(--c5)}
.bar-val{font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-1)}
.bar-sub{font-size:10px;color:var(--text-2);padding-left:128px;margin-bottom:6px}
.cl-entry{border-bottom:1px solid var(--border-1);padding:12px 0}
.cl-entry:last-child{border-bottom:none}
.cl-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.cl-title{flex:1;font-weight:500}
.cl-date{margin-left:auto;white-space:nowrap}
.cl-liner{font-size:13px;color:var(--text-1);margin-bottom:6px}
.files-detail summary{font-size:12px;cursor:pointer}
.file-list{list-style:none;padding-left:10px;margin-top:4px;display:flex;flex-direction:column;gap:2px}
.file-list li{font-size:12px;color:var(--text-1)}
footer{border-top:1px solid var(--border-1);padding:20px 32px;margin-top:40px}
.footer-inner{display:flex;align-items:center;gap:6px;justify-content:center;font-size:11px;color:var(--text-2);flex-wrap:wrap}
.exec-summary{font-size:13px;color:var(--text-1);margin-bottom:12px;line-height:1.7}
.eta-line{font-size:12px;color:var(--accent);margin-top:4px}
.cost-svg{display:block;margin:8px 0;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px}
.cost-line{fill:none;stroke:var(--accent);stroke-width:2}
.cost-area{fill:var(--accent-subtle);stroke:none}
.cost-axis{fill:var(--text-2);font-family:var(--mono);font-size:10px}
.cost-grid{stroke:var(--border-1);stroke-width:1;stroke-dasharray:4,4}
.burndown-wrap{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px;margin-bottom:16px}
.burndown-bar{display:flex;height:20px;border-radius:3px;overflow:hidden;gap:1px;margin-bottom:8px}
.burndown-spent{background:var(--accent);height:100%}
.burndown-projected{background:var(--caution);height:100%;opacity:.6}
.burndown-overshoot{background:var(--warn);height:100%;opacity:.7}
.burndown-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--text-2)}
.burndown-legend span{display:flex;align-items:center;gap:4px}
.burndown-dot{display:inline-block;width:8px;height:8px;border-radius:2px}
.blocker-card{border-left:3px solid var(--warn);background:var(--bg-1);border-radius:0 4px 4px 0;padding:10px 14px;margin-bottom:8px}
.blocker-id{font-family:var(--mono);font-size:12px;color:var(--warn);margin-bottom:2px}
.blocker-text{font-size:12px;color:var(--text-1)}
.blocker-risk{font-size:11px;color:var(--caution);margin-top:2px}
.gantt-wrap{overflow-x:auto;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:16px;margin-top:16px}
.gantt-svg{display:block}
.gantt-bar-done{fill:var(--ok);opacity:.7}
.gantt-bar-active{fill:var(--accent)}
.gantt-bar-pending{fill:var(--border-2)}
.gantt-label{fill:var(--text-2);font-family:var(--mono);font-size:10px}
.gantt-axis{fill:var(--text-2);font-family:var(--mono);font-size:9px}
.tl-filter{display:block;width:100%;padding:6px 10px;margin-bottom:8px;background:var(--bg-2);border:1px solid var(--border-1);border-radius:4px;color:var(--text-0);font-size:12px;font-family:var(--font);outline:none}
.tl-filter:focus{border-color:var(--accent)}
.tl-filter::placeholder{color:var(--text-2)}
.sec-toggle{background:none;border:1px solid var(--border-2);color:var(--text-2);width:20px;height:20px;border-radius:3px;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.sec-toggle:hover{border-color:var(--text-1);color:var(--text-1)}
.theme-toggle{background:var(--bg-3);border:1px solid var(--border-2);color:var(--text-1);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:var(--font)}
.theme-toggle:hover{border-color:var(--accent);color:var(--accent)}
.callout-info,.callout-warn,.callout-ok{border-left:3px solid var(--accent);background:var(--bg-1);border-radius:0 4px 4px 0;padding:10px 14px}
.callout-warn{border-left-color:var(--caution)}
.callout-ok{border-left-color:var(--ok)}
.card-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px}
.light-theme{--bg-0:#fff;--bg-1:#fafafa;--bg-2:#f5f5f5;--bg-3:#ebebeb;--border-1:#e5e5e5;--border-2:#d4d4d4;--text-0:#1a1a1a;--text-1:#525252;--text-2:#a3a3a3;--accent:#4f46e5;--accent-subtle:rgba(79,70,229,.08);--ok:#16a34a;--ok-subtle:rgba(22,163,74,.08);--warn:#dc2626;--caution:#ca8a04;--c0:#4f46e5;--c1:#dc2626;--c2:#0d9488;--c3:#7c3aed;--c4:#d97706;--c5:#059669;--tk-input:#4f46e5;--tk-output:#dc2626;--tk-cache-r:#0d9488;--tk-cache-w:#64748b}
@media(max-width:768px){
  header{padding:10px 16px}
  .header-inner{flex-wrap:wrap;gap:8px}
  .header-meta h1{font-size:13px}
  main{padding:16px}
  .kv-grid{gap:1px}
  .kv{min-width:80px;padding:8px 10px}
  .kv-val{font-size:14px}
  .chart-row{grid-template-columns:1fr}
  .toc ul{padding:0 16px}
  .toc a{padding:6px 8px;font-size:11px}
  .bar-row{grid-template-columns:80px 1fr 56px}
  .ms-body{padding-left:12px}
}
@media(max-width:480px){
  .kv{min-width:60px;padding:6px 8px}
  .kv-val{font-size:12px}
  .kv-lbl{font-size:9px}
  .bar-row{grid-template-columns:60px 1fr 48px}
  .bar-lbl{font-size:10px}
  .toc ul{flex-wrap:wrap}
  .header-right{display:none}
  .gantt-wrap{overflow-x:auto}
}
@media print{
  header,nav.toc{position:static}
  body{background:#fff;color:#1a1a1a}
  :root{--bg-0:#fff;--bg-1:#fafafa;--bg-2:#f5f5f5;--bg-3:#ebebeb;--border-1:#e5e5e5;--border-2:#d4d4d4;--text-0:#1a1a1a;--text-1:#525252;--text-2:#a3a3a3;--accent:#4f46e5;--ok:#16a34a;--ok-subtle:rgba(22,163,74,.08);--c0:#4f46e5;--c1:#dc2626;--c2:#0d9488;--c3:#7c3aed;--c4:#d97706;--c5:#059669;--tk-input:#4f46e5;--tk-output:#dc2626;--tk-cache-r:#0d9488;--tk-cache-w:#64748b}
  section{page-break-inside:avoid}
  .table-scroll{overflow:visible}
}
`;
const HTML_SHELL_JS = `
(function(){
  const sections=document.querySelectorAll('section[id]');
  const links=document.querySelectorAll('.toc a');
  if(!sections.length||!links.length)return;
  const obs=new IntersectionObserver(entries=>{
    for(const e of entries){
      if(!e.isIntersecting)continue;
      for(const l of links)l.classList.remove('active');
      const a=document.querySelector('.toc a[href="#'+e.target.id+'"]');
      if(a)a.classList.add('active');
    }
  },{rootMargin:'-10% 0px -80% 0px',threshold:0});
  for(const s of sections)obs.observe(s);
})();
(function(){
  var tl=document.getElementById('timeline');
  if(!tl)return;
  var table=tl.querySelector('.tbl');
  if(!table)return;
  var input=document.createElement('input');
  input.className='tl-filter';
  input.placeholder='Filter timeline\\u2026';
  input.type='text';
  table.parentNode.insertBefore(input,table);
  var rows=table.querySelectorAll('tbody tr');
  input.addEventListener('input',function(){
    var q=this.value.toLowerCase();
    for(var i=0;i<rows.length;i++){
      rows[i].style.display=rows[i].textContent.toLowerCase().indexOf(q)>-1?'':'none';
    }
  });
})();
function safeLocalStorageSet(key,value){
  try{localStorage.setItem(key,value)}catch(e){}
}
function safeLocalStorageGet(key){
  try{return localStorage.getItem(key)}catch(e){return null}
}
(function(){
  var saved={};
  try{saved=JSON.parse(safeLocalStorageGet('gsd-collapsed')||'{}')}catch(e){}
  document.querySelectorAll('section[id]').forEach(function(sec){
    var h2=sec.querySelector('h2');
    if(!h2)return;
    var btn=document.createElement('button');
    btn.className='sec-toggle';
    btn.textContent=saved[sec.id]?'+':'-';
    btn.setAttribute('aria-label','Toggle section');
    h2.prepend(btn);
    if(saved[sec.id])toggleSection(sec,true);
    btn.addEventListener('click',function(e){
      e.preventDefault();
      var collapsed=btn.textContent==='-';
      toggleSection(sec,collapsed);
      btn.textContent=collapsed?'+':'-';
      saved[sec.id]=collapsed;
      safeLocalStorageSet('gsd-collapsed',JSON.stringify(saved));
    });
  });
  function toggleSection(sec,hide){
    var children=sec.children;
    for(var i=0;i<children.length;i++){
      if(children[i].tagName!=='H2')children[i].style.display=hide?'none':'';
    }
  }
})();
(function(){
  var hr=document.querySelector('.header-right');
  if(!hr)return;
  var stored=safeLocalStorageGet('gsd-theme');
  var btn=document.createElement('button');
  btn.className='theme-toggle';
  btn.textContent=stored==='light'?'Dark':'Light';
  if(stored==='light')document.documentElement.classList.add('light-theme');
  btn.addEventListener('click',function(){
    document.documentElement.classList.toggle('light-theme');
    var isLight=document.documentElement.classList.contains('light-theme');
    btn.textContent=isLight?'Dark':'Light';
    safeLocalStorageSet('gsd-theme',isLight?'light':'dark');
  });
  hr.prepend(btn);
})();
`;
export {
  HTML_SHELL_CSS,
  HTML_SHELL_JS,
  esc,
  formatDateLong,
  renderHtmlShell,
  renderHtmlShellTemplate
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NoYXJlZC9odG1sLXNoZWxsLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJleHBvcnQgaW50ZXJmYWNlIEh0bWxTaGVsbExpbmsge1xuICBocmVmOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSHRtbFNoZWxsT3B0aW9ucyB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGRvY3VtZW50VGl0bGU/OiBzdHJpbmc7XG4gIHN1YnRpdGxlPzogc3RyaW5nO1xuICBraW5kOiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmc7XG4gIGdlbmVyYXRlZEF0OiBzdHJpbmc7XG4gIG1haW5IdG1sOiBzdHJpbmc7XG4gIHRvYz86IHJlYWRvbmx5IEh0bWxTaGVsbExpbmtbXTtcbiAgaGVhZGVyQWN0aW9uc0h0bWw/OiBzdHJpbmc7XG4gIGZvb3Rlck5vdGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSHRtbFNoZWxsVGVtcGxhdGVPcHRpb25zIGV4dGVuZHMgT21pdDxIdG1sU2hlbGxPcHRpb25zLCBcIm1haW5IdG1sXCIgfCBcImdlbmVyYXRlZEF0XCI+IHtcbiAgbWFpblBsYWNlaG9sZGVyOiBzdHJpbmc7XG4gIGdlbmVyYXRlZEF0UGxhY2Vob2xkZXI/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIdG1sU2hlbGwob3B0aW9uczogSHRtbFNoZWxsT3B0aW9ucyk6IHN0cmluZyB7XG4gIGNvbnN0IHZlcnNpb24gPSBvcHRpb25zLnZlcnNpb24gPyBgdiR7ZXNjKG9wdGlvbnMudmVyc2lvbil9YCA6IFwiXCI7XG4gIGNvbnN0IGRvY3VtZW50VGl0bGUgPSBvcHRpb25zLmRvY3VtZW50VGl0bGUgPz8gYCR7b3B0aW9ucy5raW5kfSAtICR7b3B0aW9ucy50aXRsZX1gO1xuICBjb25zdCBzdWJ0aXRsZSA9IG9wdGlvbnMuc3VidGl0bGUgPyBgPHNwYW4gY2xhc3M9XCJoZWFkZXItcGF0aFwiPiR7ZXNjKG9wdGlvbnMuc3VidGl0bGUpfTwvc3Bhbj5gIDogXCJcIjtcbiAgY29uc3QgdG9jID0gb3B0aW9ucy50b2M/Lmxlbmd0aFxuICAgID8gYDxuYXYgY2xhc3M9XCJ0b2NcIiBhcmlhLWxhYmVsPVwiUmVwb3J0IHNlY3Rpb25zXCI+XG4gIDx1bD5cbiR7b3B0aW9ucy50b2MubWFwKChpdGVtKSA9PiBgICAgIDxsaT48YSBocmVmPVwiJHtlc2MoaXRlbS5ocmVmKX1cIj4ke2VzYyhpdGVtLmxhYmVsKX08L2E+PC9saT5gKS5qb2luKFwiXFxuXCIpfVxuICA8L3VsPlxuPC9uYXY+YFxuICAgIDogXCJcIjtcbiAgY29uc3QgYWN0aW9ucyA9IG9wdGlvbnMuaGVhZGVyQWN0aW9uc0h0bWwgPyBgJHtvcHRpb25zLmhlYWRlckFjdGlvbnNIdG1sfWAgOiBcIlwiO1xuICBjb25zdCBmb290ZXJOb3RlID0gb3B0aW9ucy5mb290ZXJOb3RlID8gYDxzcGFuIGNsYXNzPVwic2VwXCI+Lzwvc3Bhbj5cXG4gICAgPHNwYW4+JHtlc2Mob3B0aW9ucy5mb290ZXJOb3RlKX08L3NwYW4+YCA6IFwiXCI7XG5cbiAgcmV0dXJuIGA8IURPQ1RZUEUgaHRtbD5cbjxodG1sIGxhbmc9XCJlblwiPlxuPGhlYWQ+XG48bWV0YSBjaGFyc2V0PVwiVVRGLThcIj5cbjxtZXRhIG5hbWU9XCJ2aWV3cG9ydFwiIGNvbnRlbnQ9XCJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MS4wXCI+XG48dGl0bGU+JHtlc2MoZG9jdW1lbnRUaXRsZSl9PC90aXRsZT5cbjxzdHlsZT4ke0hUTUxfU0hFTExfQ1NTfTwvc3R5bGU+XG48L2hlYWQ+XG48Ym9keT5cbjxoZWFkZXI+XG4gIDxkaXYgY2xhc3M9XCJoZWFkZXItaW5uZXJcIj5cbiAgICA8ZGl2IGNsYXNzPVwiYnJhbmRpbmdcIj5cbiAgICAgIDxzcGFuIGNsYXNzPVwibG9nb1wiPkdTRDwvc3Bhbj5cbiAgICAgICR7dmVyc2lvbiA/IGA8c3BhbiBjbGFzcz1cInZlcnNpb25cIj4ke3ZlcnNpb259PC9zcGFuPmAgOiBcIlwifVxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJoZWFkZXItbWV0YVwiPlxuICAgICAgPGgxPiR7ZXNjKG9wdGlvbnMudGl0bGUpfTwvaDE+XG4gICAgICAke3N1YnRpdGxlfVxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJoZWFkZXItcmlnaHRcIj5cbiAgICAgICR7YWN0aW9uc31cbiAgICAgIDxzcGFuIGNsYXNzPVwia2luZC1jaGlwXCI+JHtlc2Mob3B0aW9ucy5raW5kKX08L3NwYW4+XG4gICAgICA8ZGl2IGNsYXNzPVwiZ2VuZXJhdGVkXCI+JHtmb3JtYXREYXRlTG9uZyhvcHRpb25zLmdlbmVyYXRlZEF0KX08L2Rpdj5cbiAgICA8L2Rpdj5cbiAgPC9kaXY+XG48L2hlYWRlcj5cbiR7dG9jfVxuPG1haW4+XG4ke29wdGlvbnMubWFpbkh0bWx9XG48L21haW4+XG48Zm9vdGVyPlxuICA8ZGl2IGNsYXNzPVwiZm9vdGVyLWlubmVyXCI+XG4gICAgPHNwYW4+R1NEJHt2ZXJzaW9uID8gYCAke3ZlcnNpb259YCA6IFwiXCJ9PC9zcGFuPlxuICAgIDxzcGFuIGNsYXNzPVwic2VwXCI+Lzwvc3Bhbj5cbiAgICA8c3Bhbj4ke2VzYyhvcHRpb25zLmtpbmQpfTwvc3Bhbj5cbiAgICAke2Zvb3Rlck5vdGV9XG4gICAgPHNwYW4gY2xhc3M9XCJzZXBcIj4vPC9zcGFuPlxuICAgIDxzcGFuPiR7Zm9ybWF0RGF0ZUxvbmcob3B0aW9ucy5nZW5lcmF0ZWRBdCl9PC9zcGFuPlxuICA8L2Rpdj5cbjwvZm9vdGVyPlxuPHNjcmlwdD4ke0hUTUxfU0hFTExfSlN9PC9zY3JpcHQ+XG48L2JvZHk+XG48L2h0bWw+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckh0bWxTaGVsbFRlbXBsYXRlKG9wdGlvbnM6IEh0bWxTaGVsbFRlbXBsYXRlT3B0aW9ucyk6IHN0cmluZyB7XG4gIHJldHVybiByZW5kZXJIdG1sU2hlbGwoe1xuICAgIC4uLm9wdGlvbnMsXG4gICAgZ2VuZXJhdGVkQXQ6IG9wdGlvbnMuZ2VuZXJhdGVkQXRQbGFjZWhvbGRlciA/PyBcInt7R0VORVJBVEVEX0FUfX1cIixcbiAgICBtYWluSHRtbDogb3B0aW9ucy5tYWluUGxhY2Vob2xkZXIsXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RGF0ZUxvbmcoaXNvOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoL15cXHtcXHtbQS1aX10rXFx9XFx9JC8udGVzdChpc28pKSByZXR1cm4gaXNvO1xuICB0cnkge1xuICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShpc28pO1xuICAgIHJldHVybiBkLnRvTG9jYWxlU3RyaW5nKCdlbi1VUycsIHsgd2Vla2RheTogJ3Nob3J0JywgbW9udGg6ICdzaG9ydCcsIGRheTogJ251bWVyaWMnLCB5ZWFyOiAnbnVtZXJpYycsIGhvdXI6ICcyLWRpZ2l0JywgbWludXRlOiAnMi1kaWdpdCcsIHRpbWVab25lTmFtZTogJ3Nob3J0JyB9KTtcbiAgfSBjYXRjaCB7IHJldHVybiBpc287IH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVzYyhzOiBzdHJpbmcgfCB1bmRlZmluZWQgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKHMgPT0gbnVsbCkgcmV0dXJuICcnO1xuICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKS5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JykucmVwbGFjZSgvJy9nLCAnJiMzOTsnKTtcbn1cblxuZXhwb3J0IGNvbnN0IEhUTUxfU0hFTExfQ1NTID0gYFxuKiwqOjpiZWZvcmUsKjo6YWZ0ZXJ7Ym94LXNpemluZzpib3JkZXItYm94O21hcmdpbjowO3BhZGRpbmc6MH1cbjpyb290e1xuICAtLWJnLTA6IzBmMTExNTstLWJnLTE6IzE2MTgxZDstLWJnLTI6IzFlMjAyODstLWJnLTM6IzI3MmEzMztcbiAgLS1ib3JkZXItMTojMmIyZTM4Oy0tYm9yZGVyLTI6IzNiM2Y0YztcbiAgLS10ZXh0LTA6I2VkZWRlZjstLXRleHQtMTojYTFhMWFhOy0tdGV4dC0yOiM3MTcxN2E7XG4gIC0tYWNjZW50OiM1ZTZhZDI7LS1hY2NlbnQtc3VidGxlOnJnYmEoOTQsMTA2LDIxMCwuMTIpO1xuICAtLW9rOiMyMmM1NWU7LS1vay1zdWJ0bGU6cmdiYSgzNCwxOTcsOTQsLjEyKTstLXdhcm46I2VmNDQ0NDstLWNhdXRpb246I2VhYjMwODtcbiAgLyogQ2hhcnQgcGFsZXR0ZSAtIDYgaHVlcyBmb3IgYmFyIGNoYXJ0cyAqL1xuICAtLWMwOiM1ZTZhZDI7LS1jMTojZTU3OTZkOy0tYzI6IzE0YjhhNjstLWMzOiNhNzhiZmE7LS1jNDojZjU5ZTBiOy0tYzU6IzEwYjk4MTtcbiAgLyogVG9rZW4gYnJlYWtkb3duIC0gNCBkaXN0aW5jdCBodWVzICovXG4gIC0tdGstaW5wdXQ6IzVlNmFkMjstLXRrLW91dHB1dDojZTU3OTZkOy0tdGstY2FjaGUtcjojMmRkNGJmOy0tdGstY2FjaGUtdzojNjQ3NDhiO1xuICAtLWZvbnQ6J0ludGVyJywtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLHNhbnMtc2VyaWY7XG4gIC0tbW9ubzonSmV0QnJhaW5zIE1vbm8nLCdGaXJhIENvZGUnLHVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixtb25vc3BhY2U7XG59XG5odG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGg7Zm9udC1zaXplOjEzcHh9XG5ib2R5e2JhY2tncm91bmQ6dmFyKC0tYmctMCk7Y29sb3I6dmFyKC0tdGV4dC0wKTtmb250LWZhbWlseTp2YXIoLS1mb250KTtsaW5lLWhlaWdodDoxLjY7LXdlYmtpdC1mb250LXNtb290aGluZzphbnRpYWxpYXNlZH1cbmF7Y29sb3I6dmFyKC0tYWNjZW50KTt0ZXh0LWRlY29yYXRpb246bm9uZX1cbmE6aG92ZXJ7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX1cbmNvZGV7Zm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Zm9udC1zaXplOjEycHg7YmFja2dyb3VuZDp2YXIoLS1iZy0zKTtwYWRkaW5nOjFweCA1cHg7Ym9yZGVyLXJhZGl1czozcHh9XG4ubW9ub3tmb250LWZhbWlseTp2YXIoLS1tb25vKTtmb250LXNpemU6MTJweH1cbi5tdXRlZHtjb2xvcjp2YXIoLS10ZXh0LTIpfVxuLmFjY2VudHtjb2xvcjp2YXIoLS1hY2NlbnQpfVxuLnNlcHtjb2xvcjp2YXIoLS1ib3JkZXItMik7bWFyZ2luOjAgNHB4fVxuLmVtcHR5e2NvbG9yOnZhcigtLXRleHQtMik7cGFkZGluZzo4cHggMDtmb250LXNpemU6MTNweH1cbi5pbmRlbnR7cGFkZGluZy1sZWZ0OjEycHh9XG4ubnVte2ZvbnQtdmFyaWFudC1udW1lcmljOnRhYnVsYXItbnVtczt0ZXh0LWFsaWduOnJpZ2h0fVxuLmRvdHtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo4cHg7aGVpZ2h0OjhweDtib3JkZXItcmFkaXVzOjUwJTtmbGV4LXNocmluazowO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX1cbi5kb3Qtc217d2lkdGg6NnB4O2hlaWdodDo2cHh9XG4uZG90LWNvbXBsZXRle2JhY2tncm91bmQ6dmFyKC0tb2spO29wYWNpdHk6LjZ9XG4uZG90LWFjdGl2ZXtiYWNrZ3JvdW5kOnZhcigtLWFjY2VudCl9XG4uZG90LXBlbmRpbmd7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MS41cHggc29saWQgdmFyKC0tYm9yZGVyLTIpfVxuLmRvdC1wYXJrZWR7YmFja2dyb3VuZDp2YXIoLS13YXJuKTtvcGFjaXR5Oi41fVxuaGVhZGVye2JhY2tncm91bmQ6dmFyKC0tYmctMSk7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO3BhZGRpbmc6MTJweCAzMnB4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MDt6LWluZGV4OjIwMH1cbi5oZWFkZXItaW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXgtd2lkdGg6MTI4MHB4O21hcmdpbjowIGF1dG99XG4uYnJhbmRpbmd7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmJhc2VsaW5lO2dhcDo2cHg7ZmxleC1zaHJpbms6MH1cbi5sb2dve2ZvbnQtc2l6ZToxOHB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotLjVweDtjb2xvcjp2YXIoLS10ZXh0LTApfVxuLnZlcnNpb257Zm9udC1zaXplOjEwcHg7Y29sb3I6dmFyKC0tdGV4dC0yKTtmb250LWZhbWlseTp2YXIoLS1tb25vKX1cbi5oZWFkZXItbWV0YXtmbGV4OjE7bWluLXdpZHRoOjB9XG4uaGVhZGVyLW1ldGEgaDF7Zm9udC1zaXplOjE1cHg7Zm9udC13ZWlnaHQ6NjAwO3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc31cbi5oZWFkZXItcGF0aHtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpO2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pO2Rpc3BsYXk6YmxvY2s7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7d2hpdGUtc3BhY2U6bm93cmFwfVxuLmhlYWRlci1yaWdodHt0ZXh0LWFsaWduOnJpZ2h0O2ZsZXgtc2hyaW5rOjA7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpmbGV4LWVuZDtnYXA6NHB4fVxuLmdlbmVyYXRlZHtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpfVxuLmtpbmQtY2hpcHtmb250LXNpemU6MTBweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tYWNjZW50KTtiYWNrZ3JvdW5kOnZhcigtLWFjY2VudC1zdWJ0bGUpO2JvcmRlcjoxcHggc29saWQgcmdiYSg5NCwxMDYsMjEwLC4yNSk7Ym9yZGVyLXJhZGl1czozcHg7cGFkZGluZzoycHggN3B4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouNHB4fVxuLmJhY2stbGlua3tmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LTEpfVxuLmJhY2stbGluazpob3Zlcntjb2xvcjp2YXIoLS1hY2NlbnQpfVxuLnRvY3tiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtvdmVyZmxvdy14OmF1dG99XG4udG9jIHVse2Rpc3BsYXk6ZmxleDtsaXN0LXN0eWxlOm5vbmU7bWF4LXdpZHRoOjEyODBweDttYXJnaW46MCBhdXRvO3BhZGRpbmc6MCAzMnB4fVxuLnRvYyBhe2Rpc3BsYXk6aW5saW5lLWJsb2NrO3BhZGRpbmc6OHB4IDEycHg7Y29sb3I6dmFyKC0tdGV4dC0yKTtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo1MDA7Ym9yZGVyLWJvdHRvbToycHggc29saWQgdHJhbnNwYXJlbnQ7dHJhbnNpdGlvbjpjb2xvciAuMTJzLGJvcmRlci1jb2xvciAuMTJzO3doaXRlLXNwYWNlOm5vd3JhcDt0ZXh0LWRlY29yYXRpb246bm9uZX1cbi50b2MgYTpob3Zlcntjb2xvcjp2YXIoLS10ZXh0LTApO2JvcmRlci1ib3R0b20tY29sb3I6dmFyKC0tYm9yZGVyLTIpfVxuLnRvYyBhLmFjdGl2ZXtjb2xvcjp2YXIoLS10ZXh0LTApO2JvcmRlci1ib3R0b20tY29sb3I6dmFyKC0tYWNjZW50KX1cbm1haW57bWF4LXdpZHRoOjEyODBweDttYXJnaW46MCBhdXRvO3BhZGRpbmc6MzJweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo0OHB4fVxuc2VjdGlvbntzY3JvbGwtbWFyZ2luLXRvcDo4MnB4fVxuc2VjdGlvbj5oMntmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi41cHg7Y29sb3I6dmFyKC0tdGV4dC0xKTttYXJnaW4tYm90dG9tOjE2cHg7cGFkZGluZy1ib3R0b206OHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHh9XG5oM3tmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tdGV4dC0xKTttYXJnaW46MjBweCAwIDhweH1cbi5jb3VudHtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo1MDA7Y29sb3I6dmFyKC0tdGV4dC0yKTtiYWNrZ3JvdW5kOnZhcigtLWJnLTMpO2JvcmRlci1yYWRpdXM6M3B4O3BhZGRpbmc6MXB4IDZweH1cbi5jb3VudC13YXJue2NvbG9yOnZhcigtLWNhdXRpb24pfVxuLmt2LWdyaWR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxcHg7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItMSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItMSk7Ym9yZGVyLXJhZGl1czo0cHg7b3ZlcmZsb3c6aGlkZGVuO21hcmdpbi1ib3R0b206MTZweH1cbi5rdntiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO3BhZGRpbmc6MTBweCAxNnB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjJweDttaW4td2lkdGg6MTEwcHg7ZmxleDoxfVxuLmt2LXZhbHtmb250LXNpemU6MThweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tdGV4dC0wKTtmb250LXZhcmlhbnQtbnVtZXJpYzp0YWJ1bGFyLW51bXN9XG4ua3YtbGJse2ZvbnQtc2l6ZToxMHB4O2NvbG9yOnZhcigtLXRleHQtMik7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi40cHh9XG4ucHJvZ3Jlc3Mtd3JhcHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4O21hcmdpbi1ib3R0b206MTJweH1cbi5wcm9ncmVzcy10cmFja3tmbGV4OjE7aGVpZ2h0OjRweDtiYWNrZ3JvdW5kOnZhcigtLWJnLTMpO2JvcmRlci1yYWRpdXM6MnB4O292ZXJmbG93OmhpZGRlbn1cbi5wcm9ncmVzcy1maWxse2hlaWdodDoxMDAlO2JhY2tncm91bmQ6dmFyKC0tYWNjZW50KTtib3JkZXItcmFkaXVzOjJweH1cbi5wcm9ncmVzcy1sYWJlbHtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tdGV4dC0xKTttaW4td2lkdGg6NDBweDt0ZXh0LWFsaWduOnJpZ2h0fVxuLmFjdGl2ZS1pbmZve2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLXRleHQtMSk7bWFyZ2luLWJvdHRvbTo0cHh9XG4uYWN0aXZpdHktbGluZXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tdGV4dC0xKTtwYWRkaW5nOjZweCAwfVxuLnRibHt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtmb250LXNpemU6MTJweH1cbi50YmwgdGh7Y29sb3I6dmFyKC0tdGV4dC0yKTtmb250LXdlaWdodDo1MDA7cGFkZGluZzo2cHggMTJweDt0ZXh0LWFsaWduOmxlZnQ7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2ZvbnQtc2l6ZToxMXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouM3B4O3doaXRlLXNwYWNlOm5vd3JhcH1cbi50YmwgdGR7cGFkZGluZzo2cHggMTJweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItMSk7dmVydGljYWwtYWxpZ246dG9wfVxuLnRibCB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206bm9uZX1cbi50YmwgdGJvZHkgdHI6aG92ZXIgdGR7YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQtc3VidGxlKX1cbi50Ymwta3YgdGQ6Zmlyc3QtY2hpbGR7Y29sb3I6dmFyKC0tdGV4dC0yKTt3aWR0aDoxODBweH1cbi50YWJsZS1zY3JvbGx7b3ZlcmZsb3cteDphdXRvO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4fVxuLnRhYmxlLXNjcm9sbCAudGJse2JvcmRlcjpub25lfVxuLmgtb2sgdGQ6Zmlyc3QtY2hpbGR7Y29sb3I6dmFyKC0tdGV4dC0xKX1cbi5oLWNhdXRpb24gdGR7Y29sb3I6dmFyKC0tY2F1dGlvbil9XG4uaC13YXJuIHRke2NvbG9yOnZhcigtLXdhcm4pfVxuLmxhYmVse2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjUwMDtjb2xvcjp2YXIoLS1hY2NlbnQpO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouNHB4fVxuLnJpc2t7Zm9udC1zaXplOjEwcHg7Zm9udC13ZWlnaHQ6NjAwO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouM3B4O2ZsZXgtc2hyaW5rOjB9XG4ucmlzay1sb3d7Y29sb3I6dmFyKC0tdGV4dC0yKX1cbi5yaXNrLW1lZGl1bXtjb2xvcjp2YXIoLS1jYXV0aW9uKX1cbi5yaXNrLWhpZ2h7Y29sb3I6dmFyKC0td2Fybil9XG4ucmlzay11bmtub3due2NvbG9yOnZhcigtLXRleHQtMil9XG4udGFnLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjRweDttYXJnaW4tYm90dG9tOjhweH1cbi50YWd7Zm9udC1zaXplOjExcHg7Zm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Y29sb3I6dmFyKC0tdGV4dC0yKTtiYWNrZ3JvdW5kOnZhcigtLWJnLTMpO2JvcmRlci1yYWRpdXM6M3B4O3BhZGRpbmc6MXB4IDZweH1cbi52ZXJpZntmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LTEpO3BhZGRpbmc6NHB4IDA7bWFyZ2luLWJvdHRvbTo2cHh9XG4udmVyaWYtYmxvY2tlcntjb2xvcjp2YXIoLS13YXJuKX1cbi5kZXRhaWwtYmxvY2t7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tdGV4dC0yKTttYXJnaW4tYm90dG9tOjZweH1cbi5kZXRhaWwtbGFiZWx7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLXRleHQtMSk7ZGlzcGxheTpibG9jazttYXJnaW4tYm90dG9tOjJweH1cbi5kZXRhaWwtYmxvY2sgdWx7cGFkZGluZy1sZWZ0OjE2cHg7bWFyZ2luLXRvcDoycHh9XG4uZGV0YWlsLWJsb2NrIGxpe21hcmdpbi1ib3R0b206MXB4fVxuLm1zLWJsb2Nre2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tYm90dG9tOjhweH1cbi5tcy1zdW1tYXJ5e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjEwcHggMTRweDtjdXJzb3I6cG9pbnRlcjtsaXN0LXN0eWxlOm5vbmU7YmFja2dyb3VuZDp2YXIoLS1iZy0xKTt1c2VyLXNlbGVjdDpub25lO2ZvbnQtc2l6ZToxM3B4fVxuLm1zLXN1bW1hcnk6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1iZy0yKX1cbi5tcy1zdW1tYXJ5Ojotd2Via2l0LWRldGFpbHMtbWFya2Vye2Rpc3BsYXk6bm9uZX1cbi5tcy1pZHtmb250LXdlaWdodDo2MDB9XG4ubXMtdGl0bGV7ZmxleDoxO2ZvbnQtd2VpZ2h0OjUwMDttaW4td2lkdGg6MDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpczt3aGl0ZS1zcGFjZTpub3dyYXB9XG4ubXMtYm9keXtwYWRkaW5nOjZweCAxMnB4IDhweCAyNHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjRweH1cbi5zbC1ibG9ja3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtib3JkZXItcmFkaXVzOjNweDtvdmVyZmxvdzpoaWRkZW59XG4uc2wtc3VtbWFyeXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7cGFkZGluZzo2cHggMTBweDtjdXJzb3I6cG9pbnRlcjtsaXN0LXN0eWxlOm5vbmU7YmFja2dyb3VuZDp2YXIoLS1iZy0yKTtmb250LXNpemU6MTJweDt1c2VyLXNlbGVjdDpub25lfVxuLnNsLXN1bW1hcnk6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1iZy0zKX1cbi5zbC1zdW1tYXJ5Ojotd2Via2l0LWRldGFpbHMtbWFya2Vye2Rpc3BsYXk6bm9uZX1cbi5zbC1jcml0e2JvcmRlci1sZWZ0OjJweCBzb2xpZCB2YXIoLS1hY2NlbnQpfVxuLnNsLWRlcHM6OmJlZm9yZXtjb250ZW50OidcXFxcMjE5MCAnO2NvbG9yOnZhcigtLWJvcmRlci0yKX1cbi5zbC1kZXRhaWx7cGFkZGluZzo4cHggMTJweDtiYWNrZ3JvdW5kOnZhcigtLWJnLTApO2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKX1cbi50YXNrLWxpc3R7bGlzdC1zdHlsZTpub25lO3BhZGRpbmc6NHB4IDAgMDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDoycHh9XG4udGFzay1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NnB4O2ZvbnQtc2l6ZToxMnB4O3BhZGRpbmc6M3B4IDZweDtib3JkZXItcmFkaXVzOjJweH1cbi5kZXAtYmxvY2t7bWFyZ2luLWJvdHRvbToyOHB4fVxuLmRlcC1sZWdlbmR7ZGlzcGxheTpmbGV4O2dhcDoxNHB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLXRleHQtMik7bWFyZ2luLWJvdHRvbTo4cHg7YWxpZ24taXRlbXM6Y2VudGVyfVxuLmRlcC1sZWdlbmQgc3BhbntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo0cHh9XG4uZGVwLXdyYXB7b3ZlcmZsb3cteDphdXRvO2JhY2tncm91bmQ6dmFyKC0tYmctMSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItMSk7Ym9yZGVyLXJhZGl1czo0cHg7cGFkZGluZzoxNnB4fVxuLmRlcC1zdmd7ZGlzcGxheTpibG9ja31cbi5lZGdle2ZpbGw6bm9uZTtzdHJva2U6dmFyKC0tYm9yZGVyLTIpO3N0cm9rZS13aWR0aDoxLjV9XG4uZWRnZS1jcml0e3N0cm9rZTp2YXIoLS1hY2NlbnQpO3N0cm9rZS13aWR0aDoyfVxuLm5vZGUgcmVjdHtmaWxsOnZhcigtLWJnLTIpO3N0cm9rZTp2YXIoLS1ib3JkZXItMik7c3Ryb2tlLXdpZHRoOjF9XG4ubi1kb25lIHJlY3R7ZmlsbDp2YXIoLS1vay1zdWJ0bGUpO3N0cm9rZTpyZ2JhKDM0LDE5Nyw5NCwuNCl9XG4ubi1hY3RpdmUgcmVjdHtmaWxsOnZhcigtLWFjY2VudC1zdWJ0bGUpO3N0cm9rZTp2YXIoLS1hY2NlbnQpfVxuLm4tY3JpdCByZWN0e3N0cm9rZTp2YXIoLS1hY2NlbnQpIWltcG9ydGFudDtzdHJva2Utd2lkdGg6MS41IWltcG9ydGFudH1cbi5uLWlke2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pO2ZvbnQtc2l6ZToxMHB4O2ZpbGw6dmFyKC0tdGV4dC0xKTtmb250LXdlaWdodDo2MDA7dGV4dC1hbmNob3I6bWlkZGxlfVxuLm4tdGl0bGV7Zm9udC1zaXplOjlweDtmaWxsOnZhcigtLXRleHQtMik7dGV4dC1hbmNob3I6bWlkZGxlfVxuLm4tYWN0aXZlIC5uLWlke2ZpbGw6dmFyKC0tYWNjZW50KX1cbi50b2tlbi1ibG9ja3tiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4O3BhZGRpbmc6MTRweDttYXJnaW4tYm90dG9tOjE2cHh9XG4udG9rZW4tYmFye2Rpc3BsYXk6ZmxleDtoZWlnaHQ6MTZweDtib3JkZXItcmFkaXVzOjJweDtvdmVyZmxvdzpoaWRkZW47Z2FwOjFweDttYXJnaW4tYm90dG9tOjhweH1cbi50c2Vne2hlaWdodDoxMDAlO21pbi13aWR0aDoycHh9XG4uc2VnLTF7YmFja2dyb3VuZDp2YXIoLS10ay1pbnB1dCl9XG4uc2VnLTJ7YmFja2dyb3VuZDp2YXIoLS10ay1vdXRwdXQpfVxuLnNlZy0ze2JhY2tncm91bmQ6dmFyKC0tdGstY2FjaGUtcil9XG4uc2VnLTR7YmFja2dyb3VuZDp2YXIoLS10ay1jYWNoZS13KX1cbi50b2tlbi1sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxMnB4fVxuLmxlZy1pdGVte2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjVweDtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LTIpfVxuLmxlZy1kb3R7d2lkdGg6OHB4O2hlaWdodDo4cHg7Ym9yZGVyLXJhZGl1czoycHg7ZmxleC1zaHJpbms6MH1cbi5jaGFydC1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDI4MHB4LDFmcikpO2dhcDoxNnB4O21hcmdpbi1ib3R0b206MTZweH1cbi5jaGFydC1ibG9ja3tiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4O3BhZGRpbmc6MTRweH1cbi5iYXItcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MTIwcHggMWZyIDY4cHg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7bWFyZ2luLWJvdHRvbToycHh9XG4uYmFyLWxibHtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LTIpO3RleHQtYWxpZ246cmlnaHQ7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7d2hpdGUtc3BhY2U6bm93cmFwfVxuLmJhci10cmFja3toZWlnaHQ6MTRweDtiYWNrZ3JvdW5kOnZhcigtLWJnLTMpO2JvcmRlci1yYWRpdXM6MnB4O292ZXJmbG93OmhpZGRlbn1cbi5iYXItZmlsbHtoZWlnaHQ6MTAwJTtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOnZhcigtLWMwKX1cbi5iYXItYzB7YmFja2dyb3VuZDp2YXIoLS1jMCl9LmJhci1jMXtiYWNrZ3JvdW5kOnZhcigtLWMxKX0uYmFyLWMye2JhY2tncm91bmQ6dmFyKC0tYzIpfVxuLmJhci1jM3tiYWNrZ3JvdW5kOnZhcigtLWMzKX0uYmFyLWM0e2JhY2tncm91bmQ6dmFyKC0tYzQpfS5iYXItYzV7YmFja2dyb3VuZDp2YXIoLS1jNSl9XG4uYmFyLXZhbHtmb250LXNpemU6MTFweDtmb250LXZhcmlhbnQtbnVtZXJpYzp0YWJ1bGFyLW51bXM7Y29sb3I6dmFyKC0tdGV4dC0xKX1cbi5iYXItc3Vie2ZvbnQtc2l6ZToxMHB4O2NvbG9yOnZhcigtLXRleHQtMik7cGFkZGluZy1sZWZ0OjEyOHB4O21hcmdpbi1ib3R0b206NnB4fVxuLmNsLWVudHJ5e2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtwYWRkaW5nOjEycHggMH1cbi5jbC1lbnRyeTpsYXN0LWNoaWxke2JvcmRlci1ib3R0b206bm9uZX1cbi5jbC1oZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O21hcmdpbi1ib3R0b206NHB4fVxuLmNsLXRpdGxle2ZsZXg6MTtmb250LXdlaWdodDo1MDB9XG4uY2wtZGF0ZXttYXJnaW4tbGVmdDphdXRvO3doaXRlLXNwYWNlOm5vd3JhcH1cbi5jbC1saW5lcntmb250LXNpemU6MTNweDtjb2xvcjp2YXIoLS10ZXh0LTEpO21hcmdpbi1ib3R0b206NnB4fVxuLmZpbGVzLWRldGFpbCBzdW1tYXJ5e2ZvbnQtc2l6ZToxMnB4O2N1cnNvcjpwb2ludGVyfVxuLmZpbGUtbGlzdHtsaXN0LXN0eWxlOm5vbmU7cGFkZGluZy1sZWZ0OjEwcHg7bWFyZ2luLXRvcDo0cHg7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6MnB4fVxuLmZpbGUtbGlzdCBsaXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LTEpfVxuZm9vdGVye2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtwYWRkaW5nOjIwcHggMzJweDttYXJnaW4tdG9wOjQwcHh9XG4uZm9vdGVyLWlubmVye2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjZweDtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtMik7ZmxleC13cmFwOndyYXB9XG4uZXhlYy1zdW1tYXJ5e2ZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLXRleHQtMSk7bWFyZ2luLWJvdHRvbToxMnB4O2xpbmUtaGVpZ2h0OjEuN31cbi5ldGEtbGluZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1hY2NlbnQpO21hcmdpbi10b3A6NHB4fVxuLmNvc3Qtc3Zne2Rpc3BsYXk6YmxvY2s7bWFyZ2luOjhweCAwO2JhY2tncm91bmQ6dmFyKC0tYmctMSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItMSk7Ym9yZGVyLXJhZGl1czo0cHh9XG4uY29zdC1saW5le2ZpbGw6bm9uZTtzdHJva2U6dmFyKC0tYWNjZW50KTtzdHJva2Utd2lkdGg6Mn1cbi5jb3N0LWFyZWF7ZmlsbDp2YXIoLS1hY2NlbnQtc3VidGxlKTtzdHJva2U6bm9uZX1cbi5jb3N0LWF4aXN7ZmlsbDp2YXIoLS10ZXh0LTIpO2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pO2ZvbnQtc2l6ZToxMHB4fVxuLmNvc3QtZ3JpZHtzdHJva2U6dmFyKC0tYm9yZGVyLTEpO3N0cm9rZS13aWR0aDoxO3N0cm9rZS1kYXNoYXJyYXk6NCw0fVxuLmJ1cm5kb3duLXdyYXB7YmFja2dyb3VuZDp2YXIoLS1iZy0xKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjE0cHg7bWFyZ2luLWJvdHRvbToxNnB4fVxuLmJ1cm5kb3duLWJhcntkaXNwbGF5OmZsZXg7aGVpZ2h0OjIwcHg7Ym9yZGVyLXJhZGl1czozcHg7b3ZlcmZsb3c6aGlkZGVuO2dhcDoxcHg7bWFyZ2luLWJvdHRvbTo4cHh9XG4uYnVybmRvd24tc3BlbnR7YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpO2hlaWdodDoxMDAlfVxuLmJ1cm5kb3duLXByb2plY3RlZHtiYWNrZ3JvdW5kOnZhcigtLWNhdXRpb24pO2hlaWdodDoxMDAlO29wYWNpdHk6LjZ9XG4uYnVybmRvd24tb3ZlcnNob290e2JhY2tncm91bmQ6dmFyKC0td2Fybik7aGVpZ2h0OjEwMCU7b3BhY2l0eTouN31cbi5idXJuZG93bi1sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxMnB4O2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtMil9XG4uYnVybmRvd24tbGVnZW5kIHNwYW57ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NHB4fVxuLmJ1cm5kb3duLWRvdHtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo4cHg7aGVpZ2h0OjhweDtib3JkZXItcmFkaXVzOjJweH1cbi5ibG9ja2VyLWNhcmR7Ym9yZGVyLWxlZnQ6M3B4IHNvbGlkIHZhcigtLXdhcm4pO2JhY2tncm91bmQ6dmFyKC0tYmctMSk7Ym9yZGVyLXJhZGl1czowIDRweCA0cHggMDtwYWRkaW5nOjEwcHggMTRweDttYXJnaW4tYm90dG9tOjhweH1cbi5ibG9ja2VyLWlke2ZvbnQtZmFtaWx5OnZhcigtLW1vbm8pO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLXdhcm4pO21hcmdpbi1ib3R0b206MnB4fVxuLmJsb2NrZXItdGV4dHtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LTEpfVxuLmJsb2NrZXItcmlza3tmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS1jYXV0aW9uKTttYXJnaW4tdG9wOjJweH1cbi5nYW50dC13cmFwe292ZXJmbG93LXg6YXV0bztiYWNrZ3JvdW5kOnZhcigtLWJnLTEpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTEpO2JvcmRlci1yYWRpdXM6NHB4O3BhZGRpbmc6MTZweDttYXJnaW4tdG9wOjE2cHh9XG4uZ2FudHQtc3Zne2Rpc3BsYXk6YmxvY2t9XG4uZ2FudHQtYmFyLWRvbmV7ZmlsbDp2YXIoLS1vayk7b3BhY2l0eTouN31cbi5nYW50dC1iYXItYWN0aXZle2ZpbGw6dmFyKC0tYWNjZW50KX1cbi5nYW50dC1iYXItcGVuZGluZ3tmaWxsOnZhcigtLWJvcmRlci0yKX1cbi5nYW50dC1sYWJlbHtmaWxsOnZhcigtLXRleHQtMik7Zm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Zm9udC1zaXplOjEwcHh9XG4uZ2FudHQtYXhpc3tmaWxsOnZhcigtLXRleHQtMik7Zm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Zm9udC1zaXplOjlweH1cbi50bC1maWx0ZXJ7ZGlzcGxheTpibG9jazt3aWR0aDoxMDAlO3BhZGRpbmc6NnB4IDEwcHg7bWFyZ2luLWJvdHRvbTo4cHg7YmFja2dyb3VuZDp2YXIoLS1iZy0yKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtib3JkZXItcmFkaXVzOjRweDtjb2xvcjp2YXIoLS10ZXh0LTApO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQpO291dGxpbmU6bm9uZX1cbi50bC1maWx0ZXI6Zm9jdXN7Ym9yZGVyLWNvbG9yOnZhcigtLWFjY2VudCl9XG4udGwtZmlsdGVyOjpwbGFjZWhvbGRlcntjb2xvcjp2YXIoLS10ZXh0LTIpfVxuLnNlYy10b2dnbGV7YmFja2dyb3VuZDpub25lO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLTIpO2NvbG9yOnZhcigtLXRleHQtMik7d2lkdGg6MjBweDtoZWlnaHQ6MjBweDtib3JkZXItcmFkaXVzOjNweDtjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTRweDtsaW5lLWhlaWdodDoxO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7ZmxleC1zaHJpbms6MH1cbi5zZWMtdG9nZ2xlOmhvdmVye2JvcmRlci1jb2xvcjp2YXIoLS10ZXh0LTEpO2NvbG9yOnZhcigtLXRleHQtMSl9XG4udGhlbWUtdG9nZ2xle2JhY2tncm91bmQ6dmFyKC0tYmctMyk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItMik7Y29sb3I6dmFyKC0tdGV4dC0xKTtwYWRkaW5nOjRweCAxMHB4O2JvcmRlci1yYWRpdXM6NHB4O2N1cnNvcjpwb2ludGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQpfVxuLnRoZW1lLXRvZ2dsZTpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tYWNjZW50KTtjb2xvcjp2YXIoLS1hY2NlbnQpfVxuLmNhbGxvdXQtaW5mbywuY2FsbG91dC13YXJuLC5jYWxsb3V0LW9re2JvcmRlci1sZWZ0OjNweCBzb2xpZCB2YXIoLS1hY2NlbnQpO2JhY2tncm91bmQ6dmFyKC0tYmctMSk7Ym9yZGVyLXJhZGl1czowIDRweCA0cHggMDtwYWRkaW5nOjEwcHggMTRweH1cbi5jYWxsb3V0LXdhcm57Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0tY2F1dGlvbil9XG4uY2FsbG91dC1va3tib3JkZXItbGVmdC1jb2xvcjp2YXIoLS1vayl9XG4uY2FyZC1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDI0MHB4LDFmcikpO2dhcDoxMnB4fVxuLmNhcmR7YmFja2dyb3VuZDp2YXIoLS1iZy0xKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci0xKTtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjE0cHh9XG4ubGlnaHQtdGhlbWV7LS1iZy0wOiNmZmY7LS1iZy0xOiNmYWZhZmE7LS1iZy0yOiNmNWY1ZjU7LS1iZy0zOiNlYmViZWI7LS1ib3JkZXItMTojZTVlNWU1Oy0tYm9yZGVyLTI6I2Q0ZDRkNDstLXRleHQtMDojMWExYTFhOy0tdGV4dC0xOiM1MjUyNTI7LS10ZXh0LTI6I2EzYTNhMzstLWFjY2VudDojNGY0NmU1Oy0tYWNjZW50LXN1YnRsZTpyZ2JhKDc5LDcwLDIyOSwuMDgpOy0tb2s6IzE2YTM0YTstLW9rLXN1YnRsZTpyZ2JhKDIyLDE2Myw3NCwuMDgpOy0td2FybjojZGMyNjI2Oy0tY2F1dGlvbjojY2E4YTA0Oy0tYzA6IzRmNDZlNTstLWMxOiNkYzI2MjY7LS1jMjojMGQ5NDg4Oy0tYzM6IzdjM2FlZDstLWM0OiNkOTc3MDY7LS1jNTojMDU5NjY5Oy0tdGstaW5wdXQ6IzRmNDZlNTstLXRrLW91dHB1dDojZGMyNjI2Oy0tdGstY2FjaGUtcjojMGQ5NDg4Oy0tdGstY2FjaGUtdzojNjQ3NDhifVxuQG1lZGlhKG1heC13aWR0aDo3NjhweCl7XG4gIGhlYWRlcntwYWRkaW5nOjEwcHggMTZweH1cbiAgLmhlYWRlci1pbm5lcntmbGV4LXdyYXA6d3JhcDtnYXA6OHB4fVxuICAuaGVhZGVyLW1ldGEgaDF7Zm9udC1zaXplOjEzcHh9XG4gIG1haW57cGFkZGluZzoxNnB4fVxuICAua3YtZ3JpZHtnYXA6MXB4fVxuICAua3Z7bWluLXdpZHRoOjgwcHg7cGFkZGluZzo4cHggMTBweH1cbiAgLmt2LXZhbHtmb250LXNpemU6MTRweH1cbiAgLmNoYXJ0LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfVxuICAudG9jIHVse3BhZGRpbmc6MCAxNnB4fVxuICAudG9jIGF7cGFkZGluZzo2cHggOHB4O2ZvbnQtc2l6ZToxMXB4fVxuICAuYmFyLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6ODBweCAxZnIgNTZweH1cbiAgLm1zLWJvZHl7cGFkZGluZy1sZWZ0OjEycHh9XG59XG5AbWVkaWEobWF4LXdpZHRoOjQ4MHB4KXtcbiAgLmt2e21pbi13aWR0aDo2MHB4O3BhZGRpbmc6NnB4IDhweH1cbiAgLmt2LXZhbHtmb250LXNpemU6MTJweH1cbiAgLmt2LWxibHtmb250LXNpemU6OXB4fVxuICAuYmFyLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6NjBweCAxZnIgNDhweH1cbiAgLmJhci1sYmx7Zm9udC1zaXplOjEwcHh9XG4gIC50b2MgdWx7ZmxleC13cmFwOndyYXB9XG4gIC5oZWFkZXItcmlnaHR7ZGlzcGxheTpub25lfVxuICAuZ2FudHQtd3JhcHtvdmVyZmxvdy14OmF1dG99XG59XG5AbWVkaWEgcHJpbnR7XG4gIGhlYWRlcixuYXYudG9je3Bvc2l0aW9uOnN0YXRpY31cbiAgYm9keXtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzFhMWExYX1cbiAgOnJvb3R7LS1iZy0wOiNmZmY7LS1iZy0xOiNmYWZhZmE7LS1iZy0yOiNmNWY1ZjU7LS1iZy0zOiNlYmViZWI7LS1ib3JkZXItMTojZTVlNWU1Oy0tYm9yZGVyLTI6I2Q0ZDRkNDstLXRleHQtMDojMWExYTFhOy0tdGV4dC0xOiM1MjUyNTI7LS10ZXh0LTI6I2EzYTNhMzstLWFjY2VudDojNGY0NmU1Oy0tb2s6IzE2YTM0YTstLW9rLXN1YnRsZTpyZ2JhKDIyLDE2Myw3NCwuMDgpOy0tYzA6IzRmNDZlNTstLWMxOiNkYzI2MjY7LS1jMjojMGQ5NDg4Oy0tYzM6IzdjM2FlZDstLWM0OiNkOTc3MDY7LS1jNTojMDU5NjY5Oy0tdGstaW5wdXQ6IzRmNDZlNTstLXRrLW91dHB1dDojZGMyNjI2Oy0tdGstY2FjaGUtcjojMGQ5NDg4Oy0tdGstY2FjaGUtdzojNjQ3NDhifVxuICBzZWN0aW9ue3BhZ2UtYnJlYWstaW5zaWRlOmF2b2lkfVxuICAudGFibGUtc2Nyb2xse292ZXJmbG93OnZpc2libGV9XG59XG5gO1xuXG5leHBvcnQgY29uc3QgSFRNTF9TSEVMTF9KUyA9IGBcbihmdW5jdGlvbigpe1xuICBjb25zdCBzZWN0aW9ucz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdzZWN0aW9uW2lkXScpO1xuICBjb25zdCBsaW5rcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9jIGEnKTtcbiAgaWYoIXNlY3Rpb25zLmxlbmd0aHx8IWxpbmtzLmxlbmd0aClyZXR1cm47XG4gIGNvbnN0IG9icz1uZXcgSW50ZXJzZWN0aW9uT2JzZXJ2ZXIoZW50cmllcz0+e1xuICAgIGZvcihjb25zdCBlIG9mIGVudHJpZXMpe1xuICAgICAgaWYoIWUuaXNJbnRlcnNlY3RpbmcpY29udGludWU7XG4gICAgICBmb3IoY29uc3QgbCBvZiBsaW5rcylsLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpO1xuICAgICAgY29uc3QgYT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9jIGFbaHJlZj1cIiMnK2UudGFyZ2V0LmlkKydcIl0nKTtcbiAgICAgIGlmKGEpYS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTtcbiAgICB9XG4gIH0se3Jvb3RNYXJnaW46Jy0xMCUgMHB4IC04MCUgMHB4Jyx0aHJlc2hvbGQ6MH0pO1xuICBmb3IoY29uc3QgcyBvZiBzZWN0aW9ucylvYnMub2JzZXJ2ZShzKTtcbn0pKCk7XG4oZnVuY3Rpb24oKXtcbiAgdmFyIHRsPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0aW1lbGluZScpO1xuICBpZighdGwpcmV0dXJuO1xuICB2YXIgdGFibGU9dGwucXVlcnlTZWxlY3RvcignLnRibCcpO1xuICBpZighdGFibGUpcmV0dXJuO1xuICB2YXIgaW5wdXQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgaW5wdXQuY2xhc3NOYW1lPSd0bC1maWx0ZXInO1xuICBpbnB1dC5wbGFjZWhvbGRlcj0nRmlsdGVyIHRpbWVsaW5lXFxcXHUyMDI2JztcbiAgaW5wdXQudHlwZT0ndGV4dCc7XG4gIHRhYmxlLnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKGlucHV0LHRhYmxlKTtcbiAgdmFyIHJvd3M9dGFibGUucXVlcnlTZWxlY3RvckFsbCgndGJvZHkgdHInKTtcbiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7XG4gICAgdmFyIHE9dGhpcy52YWx1ZS50b0xvd2VyQ2FzZSgpO1xuICAgIGZvcih2YXIgaT0wO2k8cm93cy5sZW5ndGg7aSsrKXtcbiAgICAgIHJvd3NbaV0uc3R5bGUuZGlzcGxheT1yb3dzW2ldLnRleHRDb250ZW50LnRvTG93ZXJDYXNlKCkuaW5kZXhPZihxKT4tMT8nJzonbm9uZSc7XG4gICAgfVxuICB9KTtcbn0pKCk7XG5mdW5jdGlvbiBzYWZlTG9jYWxTdG9yYWdlU2V0KGtleSx2YWx1ZSl7XG4gIHRyeXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksdmFsdWUpfWNhdGNoKGUpe31cbn1cbmZ1bmN0aW9uIHNhZmVMb2NhbFN0b3JhZ2VHZXQoa2V5KXtcbiAgdHJ5e3JldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpfWNhdGNoKGUpe3JldHVybiBudWxsfVxufVxuKGZ1bmN0aW9uKCl7XG4gIHZhciBzYXZlZD17fTtcbiAgdHJ5e3NhdmVkPUpTT04ucGFyc2Uoc2FmZUxvY2FsU3RvcmFnZUdldCgnZ3NkLWNvbGxhcHNlZCcpfHwne30nKX1jYXRjaChlKXt9XG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ3NlY3Rpb25baWRdJykuZm9yRWFjaChmdW5jdGlvbihzZWMpe1xuICAgIHZhciBoMj1zZWMucXVlcnlTZWxlY3RvcignaDInKTtcbiAgICBpZighaDIpcmV0dXJuO1xuICAgIHZhciBidG49ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgYnRuLmNsYXNzTmFtZT0nc2VjLXRvZ2dsZSc7XG4gICAgYnRuLnRleHRDb250ZW50PXNhdmVkW3NlYy5pZF0/JysnOictJztcbiAgICBidG4uc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywnVG9nZ2xlIHNlY3Rpb24nKTtcbiAgICBoMi5wcmVwZW5kKGJ0bik7XG4gICAgaWYoc2F2ZWRbc2VjLmlkXSl0b2dnbGVTZWN0aW9uKHNlYyx0cnVlKTtcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpe1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgdmFyIGNvbGxhcHNlZD1idG4udGV4dENvbnRlbnQ9PT0nLSc7XG4gICAgICB0b2dnbGVTZWN0aW9uKHNlYyxjb2xsYXBzZWQpO1xuICAgICAgYnRuLnRleHRDb250ZW50PWNvbGxhcHNlZD8nKyc6Jy0nO1xuICAgICAgc2F2ZWRbc2VjLmlkXT1jb2xsYXBzZWQ7XG4gICAgICBzYWZlTG9jYWxTdG9yYWdlU2V0KCdnc2QtY29sbGFwc2VkJyxKU09OLnN0cmluZ2lmeShzYXZlZCkpO1xuICAgIH0pO1xuICB9KTtcbiAgZnVuY3Rpb24gdG9nZ2xlU2VjdGlvbihzZWMsaGlkZSl7XG4gICAgdmFyIGNoaWxkcmVuPXNlYy5jaGlsZHJlbjtcbiAgICBmb3IodmFyIGk9MDtpPGNoaWxkcmVuLmxlbmd0aDtpKyspe1xuICAgICAgaWYoY2hpbGRyZW5baV0udGFnTmFtZSE9PSdIMicpY2hpbGRyZW5baV0uc3R5bGUuZGlzcGxheT1oaWRlPydub25lJzonJztcbiAgICB9XG4gIH1cbn0pKCk7XG4oZnVuY3Rpb24oKXtcbiAgdmFyIGhyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5oZWFkZXItcmlnaHQnKTtcbiAgaWYoIWhyKXJldHVybjtcbiAgdmFyIHN0b3JlZD1zYWZlTG9jYWxTdG9yYWdlR2V0KCdnc2QtdGhlbWUnKTtcbiAgdmFyIGJ0bj1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgYnRuLmNsYXNzTmFtZT0ndGhlbWUtdG9nZ2xlJztcbiAgYnRuLnRleHRDb250ZW50PXN0b3JlZD09PSdsaWdodCc/J0RhcmsnOidMaWdodCc7XG4gIGlmKHN0b3JlZD09PSdsaWdodCcpZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsYXNzTGlzdC5hZGQoJ2xpZ2h0LXRoZW1lJyk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXtcbiAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LnRvZ2dsZSgnbGlnaHQtdGhlbWUnKTtcbiAgICB2YXIgaXNMaWdodD1kb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LmNvbnRhaW5zKCdsaWdodC10aGVtZScpO1xuICAgIGJ0bi50ZXh0Q29udGVudD1pc0xpZ2h0PydEYXJrJzonTGlnaHQnO1xuICAgIHNhZmVMb2NhbFN0b3JhZ2VTZXQoJ2dzZC10aGVtZScsaXNMaWdodD8nbGlnaHQnOidkYXJrJyk7XG4gIH0pO1xuICBoci5wcmVwZW5kKGJ0bik7XG59KSgpO1xuYDtcbiJdLAogICJtYXBwaW5ncyI6ICJBQXVCTyxTQUFTLGdCQUFnQixTQUFtQztBQUNqRSxRQUFNLFVBQVUsUUFBUSxVQUFVLElBQUksSUFBSSxRQUFRLE9BQU8sQ0FBQyxLQUFLO0FBQy9ELFFBQU0sZ0JBQWdCLFFBQVEsaUJBQWlCLEdBQUcsUUFBUSxJQUFJLE1BQU0sUUFBUSxLQUFLO0FBQ2pGLFFBQU0sV0FBVyxRQUFRLFdBQVcsNkJBQTZCLElBQUksUUFBUSxRQUFRLENBQUMsWUFBWTtBQUNsRyxRQUFNLE1BQU0sUUFBUSxLQUFLLFNBQ3JCO0FBQUE7QUFBQSxFQUVKLFFBQVEsSUFBSSxJQUFJLENBQUMsU0FBUyxvQkFBb0IsSUFBSSxLQUFLLElBQUksQ0FBQyxLQUFLLElBQUksS0FBSyxLQUFLLENBQUMsV0FBVyxFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUE7QUFBQSxVQUduRztBQUNKLFFBQU0sVUFBVSxRQUFRLG9CQUFvQixHQUFHLFFBQVEsaUJBQWlCLEtBQUs7QUFDN0UsUUFBTSxhQUFhLFFBQVEsYUFBYTtBQUFBLFlBQXlDLElBQUksUUFBUSxVQUFVLENBQUMsWUFBWTtBQUVwSCxTQUFPO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxTQUtBLElBQUksYUFBYSxDQUFDO0FBQUEsU0FDbEIsY0FBYztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFFBT2YsVUFBVSx5QkFBeUIsT0FBTyxZQUFZLEVBQUU7QUFBQTtBQUFBO0FBQUEsWUFHcEQsSUFBSSxRQUFRLEtBQUssQ0FBQztBQUFBLFFBQ3RCLFFBQVE7QUFBQTtBQUFBO0FBQUEsUUFHUixPQUFPO0FBQUEsZ0NBQ2lCLElBQUksUUFBUSxJQUFJLENBQUM7QUFBQSwrQkFDbEIsZUFBZSxRQUFRLFdBQVcsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSWhFLEdBQUc7QUFBQTtBQUFBLEVBRUgsUUFBUSxRQUFRO0FBQUE7QUFBQTtBQUFBO0FBQUEsZUFJSCxVQUFVLElBQUksT0FBTyxLQUFLLEVBQUU7QUFBQTtBQUFBLFlBRS9CLElBQUksUUFBUSxJQUFJLENBQUM7QUFBQSxNQUN2QixVQUFVO0FBQUE7QUFBQSxZQUVKLGVBQWUsUUFBUSxXQUFXLENBQUM7QUFBQTtBQUFBO0FBQUEsVUFHckMsYUFBYTtBQUFBO0FBQUE7QUFHdkI7QUFFTyxTQUFTLHdCQUF3QixTQUEyQztBQUNqRixTQUFPLGdCQUFnQjtBQUFBLElBQ3JCLEdBQUc7QUFBQSxJQUNILGFBQWEsUUFBUSwwQkFBMEI7QUFBQSxJQUMvQyxVQUFVLFFBQVE7QUFBQSxFQUNwQixDQUFDO0FBQ0g7QUFFTyxTQUFTLGVBQWUsS0FBcUI7QUFDbEQsTUFBSSxvQkFBb0IsS0FBSyxHQUFHLEVBQUcsUUFBTztBQUMxQyxNQUFJO0FBQ0YsVUFBTSxJQUFJLElBQUksS0FBSyxHQUFHO0FBQ3RCLFdBQU8sRUFBRSxlQUFlLFNBQVMsRUFBRSxTQUFTLFNBQVMsT0FBTyxTQUFTLEtBQUssV0FBVyxNQUFNLFdBQVcsTUFBTSxXQUFXLFFBQVEsV0FBVyxjQUFjLFFBQVEsQ0FBQztBQUFBLEVBQ25LLFFBQVE7QUFBRSxXQUFPO0FBQUEsRUFBSztBQUN4QjtBQUVPLFNBQVMsSUFBSSxHQUFzQztBQUN4RCxNQUFJLEtBQUssS0FBTSxRQUFPO0FBQ3RCLFNBQU8sT0FBTyxDQUFDLEVBQUUsUUFBUSxNQUFNLE9BQU8sRUFBRSxRQUFRLE1BQU0sTUFBTSxFQUFFLFFBQVEsTUFBTSxNQUFNLEVBQUUsUUFBUSxNQUFNLFFBQVEsRUFBRSxRQUFRLE1BQU0sT0FBTztBQUNuSTtBQUVPLE1BQU0saUJBQWlCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFpT3ZCLE1BQU0sZ0JBQWdCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTsiLAogICJuYW1lcyI6IFtdCn0K
