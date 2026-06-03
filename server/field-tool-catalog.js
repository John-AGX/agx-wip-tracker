// System field-tool catalog.
//
// These are Project 86's built-in "system" field tools — a curated,
// higher-tier set an org admin can add to their field-tools list from a
// picker. Each entry is a self-contained HTML document (same shape as a
// user-authored field tool) that runs in the sandboxed iframe and reports
// inputs/outputs via the standard postMessage contract so Save Printout
// works. Added tools carry their `key` in field_tools.system_key, render
// with a gold star, and can't be deleted by regular users.
//
// To add another system tool later: append an entry here with a unique
// `key`, then redeploy. Orgs add it from Tools → "Add system tool".
// (Re-adding an existing key upgrades its html_body in place.)

'use strict';

// ── Stairs Calculator ───────────────────────────────────────────────
// Dark-themed (matches the field-tool modal) with GetCost-style, color-
// coded, labeled side-view + stringer cutting-template diagrams. 3 primary
// inputs + tread thickness + board width → full stair layout. The throat
// (uncut) math matches a standard cut-stringer: W - (riser*tread)/hypot.
var STAIRS_HTML = [
'<!doctype html>',
'<html lang="en"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
'<title>Stairs Calculator</title>',
'<style>',
'  :root{--bg:#0f0f0f;--card:#161616;--line:#2a2a2a;--ink:#e8e8e8;--dim:#8a8a8a;--accent:#4f8cff;',
'    --A:#ec4899;--B:#22c55e;--C:#f59e0b;--D:#a855f7;--F:#22d3ee;--J:#94a3b8;--G:#3b82f6;--H:#ec4899;--I:#34d399;}',
'  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
'  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);padding:12px 12px 36px;}',
'  h1{font-size:17px;margin:0 0 2px;}',
'  .sub{font-size:11.5px;color:var(--dim);margin:0 0 12px;}',
'  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px;}',
'  .inputs{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
'  @media(max-width:360px){.inputs{grid-template-columns:1fr;}}',
'  label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--dim);font-weight:700;margin-bottom:3px;}',
'  .fieldrow{display:flex;}',
'  input[type=number]{width:100%;font-size:16px;font-weight:600;padding:9px 11px;border:1px solid #333;border-radius:8px 0 0 8px;outline:none;color:var(--ink);background:#0a0a0a;min-width:0;}',
'  input[type=number]:focus{border-color:var(--accent);}',
'  .unit{display:flex;align-items:center;padding:0 10px;font-size:12px;color:var(--dim);background:#111;border:1px solid #333;border-left:0;border-radius:0 8px 8px 0;}',
'  .headline{background:linear-gradient(180deg,#1b2536,#141b29);border:1px solid #29405f;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:15px;font-weight:700;color:#dbeafe;}',
'  .headline b{color:#fff;font-size:20px;}',
'  .headline .dot{color:#3b6;margin:0 8px;opacity:.5;}',
'  .diagtitle{font-size:12px;font-weight:800;margin:0 0 8px;text-align:center;letter-spacing:.4px;color:#cbd5e1;}',
'  .legend{display:flex;flex-wrap:wrap;gap:5px 14px;font-size:11px;margin-bottom:8px;}',
'  .lg b{font-weight:800;margin-right:3px;} .lg i{font-style:normal;color:#fff;font-weight:600;}',
'  canvas{width:100%;display:block;border-radius:6px;}',
'  .note{font-size:11.5px;border-radius:8px;padding:7px 10px;margin-top:9px;line-height:1.4;}',
'  .note.ok{background:rgba(34,197,94,0.08);color:#86efac;border:1px solid rgba(34,197,94,0.3);}',
'  .note.warn{background:rgba(245,158,11,0.08);color:#fcd34d;border:1px solid rgba(245,158,11,0.3);}',
'  .btns{display:flex;gap:8px;}',
'  button{flex:1;font-size:14px;font-weight:700;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;cursor:pointer;}',
'  @media print{:root{--bg:#fff;--card:#fff;--ink:#111;}body{padding:0;}.btns,.sub{display:none;}.card{border:0;break-inside:avoid;}.headline{color:#111;}}',
'</style></head><body>',
'  <h1>Stairs Calculator</h1>',
'  <p class="sub">Enter the rise and your targets &mdash; risers, run, first-step cut and the stringer are computed and drawn.</p>',
// Label input — same UX as the org-created tools. The auto-instrumenter
// picks it up via labelFor() so it lands in the printout snapshot and
// the draft autosave under the key "Label this calculation".
'  <div class="card"><div><label for="ftLabel">Label this calculation</label><input id="ftLabel" type="text" placeholder="e.g. Front porch &mdash; Smith residence" style="width:100%;font-size:14px;padding:9px 11px;border:1px solid #333;border-radius:8px;outline:none;color:var(--ink);background:#0a0a0a;" /></div></div>',
'  <div class="card"><div class="inputs">',
'    <div><label>Total rise (floor to floor)</label><div class="fieldrow"><input id="rise" type="number" inputmode="decimal" value="48" step="0.125"><span class="unit">in</span></div></div>',
'    <div><label>Target riser height</label><div class="fieldrow"><input id="triser" type="number" inputmode="decimal" value="7" step="0.125"><span class="unit">in</span></div></div>',
'    <div><label>Tread depth (run)</label><div class="fieldrow"><input id="tread" type="number" inputmode="decimal" value="10" step="0.25"><span class="unit">in</span></div></div>',
'    <div><label>Tread thickness</label><div class="fieldrow"><input id="tthick" type="number" inputmode="decimal" value="1.5" step="0.125"><span class="unit">in</span></div></div>',
'    <div><label>Stringer board width</label><div class="fieldrow"><input id="bwidth" type="number" inputmode="decimal" value="11.25" step="0.25"><span class="unit">in</span></div></div>',
'  </div></div>',
'  <div class="headline" id="headline">&mdash;</div>',
'  <div id="notes"></div>',
'  <div class="card"><div class="diagtitle">STAIRS BLUEPRINT (SIDE VIEW)</div><div class="legend" id="leg_side"></div><canvas id="side" height="250"></canvas></div>',
'  <div class="card"><div class="diagtitle">STRINGER CUTTING TEMPLATE</div><div class="legend" id="leg_str"></div><canvas id="stringer" height="260"></canvas></div>',
'  <div class="btns"><button onclick="window.print()">Print cut sheet</button></div>',
'<script>',
'(function(){',
'  var COL={A:"#ec4899",B:"#22c55e",C:"#f59e0b",D:"#a855f7",F:"#22d3ee",J:"#94a3b8",G:"#3b82f6",H:"#ec4899",I:"#34d399"};',
'  var Q=String.fromCharCode(34);',
'  function gcd(a,b){return b?gcd(b,a%b):a;}',
'  function fmtIn(x){ if(!isFinite(x))return "\\u2014"; var neg=x<0;x=Math.abs(x); var w=Math.floor(x+1e-9); var f=Math.round((x-w)*16); if(f===16){w++;f=0;} var s=""+w; if(f>0){var g=gcd(f,16); s+=" "+(f/g)+"/"+(16/g);} return (neg?"-":"")+s+Q; }',
'  function fmtFtIn(x){ if(!isFinite(x))return "\\u2014"; var neg=x<0;x=Math.abs(x); var ft=Math.floor(x/12+1e-9); var inch=x-ft*12; return (neg?"-":"")+ft+"\\u2019 "+fmtIn(inch); }',
'  function num(id){ var v=parseFloat(document.getElementById(id).value); return isFinite(v)?v:0; }',
'  var M={};',
'  function compute(){',
'    var rise=num("rise"), tRiser=num("triser")||7, tread=num("tread")||10, tthick=num("tthick"), bwidth=num("bwidth")||11.25;',
'    var risers=Math.max(1, Math.round(rise/(tRiser||7)));',
'    var riser=rise/risers, treads=Math.max(0,risers-1), run=treads*tread, first=riser-tthick;',
'    var diag=Math.sqrt(riser*riser+tread*tread)||1, throat=bwidth-(riser*tread)/diag;',
// Stringer length = the lumber length you actually need to cut. That
// equals the back edge of the cut stringer, which is parallel to the
// nosing line and spans FIRST nosing → TOP nosing — i.e. `treads`
// steps of slope `diag`, not the full rise/run hypotenuse (which is
// the line-of-travel, one riser longer). Old `sqrt(rise²+run²)`
// over-stated the board length by one riser worth — visually obvious
// because the H dimension line is drawn ON the back edge but its
// label printed the line-of-travel value, so the number didn't match
// the line. Angle stays as the stair line-of-travel angle (the
// conventional "stair angle").
'    var slen=treads*diag, ang=Math.atan2(rise,run)*180/Math.PI;',
'    M={rise:rise,tRiser:tRiser,tread:tread,tthick:tthick,bwidth:bwidth,risers:risers,riser:riser,treads:treads,run:run,first:first,slen:slen,ang:ang,throat:throat};',
'    document.getElementById("headline").innerHTML="<b>"+risers+" risers</b> @ "+fmtIn(riser)+"<span class=\\"dot\\">\\u2022</span>Run "+fmtFtIn(run)+"<span class=\\"dot\\">\\u2022</span>"+ang.toFixed(1)+"\\u00b0";',
'    document.getElementById("leg_side").innerHTML=',
'      lg("A","Total Raise",fmtFtIn(rise),COL.A)+lg("B","Total Run",fmtFtIn(run),COL.B)+lg("C","Step Height",fmtIn(riser),COL.C)+',
'      lg("D","Tread Depth",fmtIn(tread),COL.D)+lg("F","First Step",fmtIn(first),COL.F)+lg("J","Tread Thk",fmtIn(tthick),COL.J);',
'    document.getElementById("leg_str").innerHTML=',
'      lg("C","Step Height",fmtIn(riser),COL.C)+lg("D","Tread Depth",fmtIn(tread),COL.D)+lg("F","First Step",fmtIn(first),COL.F)+',
'      lg("G","Board Width",fmtIn(bwidth),COL.G)+lg("H","Stringer Len",fmtFtIn(slen),COL.H)+lg("I","Uncut",fmtIn(throat),COL.I);',
'    renderNotes(); drawSide(); drawStringer(); postResult();',
'  }',
'  function lg(k,name,val,col){ return "<span class=\\"lg\\"><b style=\\"color:"+col+"\\">"+k+":</b>"+name+" <i>("+val+")</i></span>"; }',
'  function renderNotes(){',
'    var n=document.getElementById("notes"), h="";',
'    if(M.riser<6.25||M.riser>7.875) h+=note("warn","Riser "+fmtIn(M.riser)+" is outside the comfortable 6\\u00bd\\u20137\\u00be"+Q+" range.");',
'    else h+=note("ok","Riser "+fmtIn(M.riser)+" is in the comfortable range.");',
'    if(M.tread<10) h+=note("warn","Tread depth under 10"+Q+" \\u2014 many codes require a 10"+Q+" minimum run.");',
'    var rule=2*M.riser+M.tread; if(rule<24||rule>25) h+=note("warn","2\\u00d7riser + tread = "+fmtIn(rule)+" (target 24\\u201325"+Q+" for an even stride).");',
'    if(M.throat<3.5) h+=note("warn","Stringer throat "+fmtIn(M.throat)+" is thin \\u2014 use a wider board (\\u2265 3\\u00bd"+Q+", often 5"+Q+" for cut stringers).");',
'    n.innerHTML=h;',
'  }',
'  function note(cls,txt){ return "<div class=\\"note "+cls+"\\">"+txt+"</div>"; }',
'  function ctxFit(c,H){ var dpr=Math.min(window.devicePixelRatio||1,2); var W=c.clientWidth||340; c.width=Math.round(W*dpr); c.height=Math.round(H*dpr); c.style.height=H+"px"; var x=c.getContext("2d"); x.setTransform(dpr,0,0,dpr,0,0); x.fillStyle=getStyle("--card","#161616"); x.fillRect(0,0,W,H); return {x:x,W:W,H:H}; }',
'  function getStyle(v,d){ try{var s=getComputedStyle(document.documentElement).getPropertyValue(v).trim(); return s||d;}catch(e){return d;} }',
'  function tick(x,ax,ay,bx,by){ var dx=bx-ax,dy=by-ay,L=Math.hypot(dx,dy)||1,tx=-dy/L*4,ty=dx/L*4; x.beginPath();x.moveTo(ax-tx,ay-ty);x.lineTo(ax+tx,ay+ty);x.moveTo(bx-tx,by-ty);x.lineTo(bx+tx,by+ty);x.stroke(); }',
'  function dim(x,ax,ay,bx,by,col){ x.strokeStyle=col;x.lineWidth=1.5;x.beginPath();x.moveTo(ax,ay);x.lineTo(bx,by);x.stroke();tick(x,ax,ay,bx,by); }',
'  function tag(x,px,py,letter,col){ x.fillStyle=col;x.font="bold 12px Arial";x.textAlign="center";x.textBaseline="middle";x.fillText(letter,px,py); }',
'  function dashed(x,ax,ay,bx,by){ x.save();x.strokeStyle="#5b6473";x.lineWidth=1;x.setLineDash([6,5]);x.beginPath();x.moveTo(ax,ay);x.lineTo(bx,by);x.stroke();x.restore(); }',
'  function drawSide(){',
'    var c=document.getElementById("side"), o=ctxFit(c,250), x=o.x, W=o.W, H=o.H;',
'    var padL=46,padR=64,padT=26,padB=46;',
'    var sc=Math.min((W-padL-padR)/Math.max(M.run,1),(H-padT-padB)/Math.max(M.rise,1));',
'    var ox=padL, oy=H-padB; function PX(r){return ox+r*sc;} function PY(r){return oy-r*sc;}',
'    dashed(x,PX(0)-14,oy,PX(M.run)+18,oy);',
'    dashed(x,PX(M.run-M.tread),PY(M.rise),PX(M.run)+44,PY(M.rise));',
'    x.strokeStyle="#d4d4d4";x.lineWidth=2;x.lineJoin="round";x.beginPath();x.moveTo(PX(0),PY(0));',
'    var cx=0,cy=0; for(var i=0;i<M.risers;i++){ cy+=M.riser; x.lineTo(PX(cx),PY(cy)); if(i<M.treads){ cx+=M.tread; x.lineTo(PX(cx),PY(cy)); } } x.stroke();',
'    dim(x,PX(M.run)+34,PY(0),PX(M.run)+34,PY(M.rise),COL.A); tag(x,PX(M.run)+48,PY(M.rise/2),"A",COL.A);',
'    dim(x,PX(0),oy+22,PX(M.run),oy+22,COL.B); tag(x,PX(M.run/2),oy+34,"B",COL.B);',
'    if(M.treads>=2){ dim(x,PX(M.tread)+2,PY(M.riser),PX(M.tread)+2,PY(2*M.riser),COL.C); tag(x,PX(M.tread)+12,PY(1.5*M.riser),"C",COL.C); }',
'    dim(x,PX(0),PY(M.riser)-9,PX(M.tread),PY(M.riser)-9,COL.D); tag(x,PX(M.tread/2),PY(M.riser)-18,"D",COL.D);',
'    dim(x,PX(0)-10,PY(0),PX(0)-10,PY(M.first),COL.F); tag(x,PX(0)-19,PY(M.first/2),"F",COL.F);',
'    dim(x,PX(0)+5,PY(M.riser),PX(0)+5,PY(M.riser-M.tthick),COL.J); tag(x,PX(0)+15,PY(M.riser-M.tthick/2),"J",COL.J);',
'  }',
'  function drawStringer(){',
'    var c=document.getElementById("stringer"), o=ctxFit(c,270), x=o.x, W=o.W, H=o.H;',
'    var padL=44,padR=56,padT=28,padB=46;',
'    // Cut-stringer geometry: the sawtooth top edge is the stair profile;',
'    // the straight back edge runs parallel to the nosing line, offset by',
'    // the THROAT (min wood, under the nosing tips). Board width = throat',
'    // + notch depth = bw (measured under an inner corner). n = down-right',
'    // normal to the nosing line = (riser,-tread)/Dg.',
'    var Dg=Math.sqrt(M.tread*M.tread+M.riser*M.riser)||1, nx=M.riser/Dg, ny=-M.tread/Dg;',
'    var minY=ny*M.throat, maxX=M.run+nx*M.bwidth;',
'    var sc=Math.min((W-padL-padR)/Math.max(maxX,1),(H-padT-padB)/Math.max(M.rise-minY,1));',
'    var ox=padL, oy=(H-padB)+minY*sc; function PX(r){return ox+r*sc;} function PY(r){return oy-r*sc;}',
'    var cut=[[0,0]],cx=0,cy=0; for(var i=0;i<M.risers;i++){ cy+=M.riser; cut.push([cx,cy]); if(i<M.treads){ cx+=M.tread; cut.push([cx,cy]); } }',
'    var Bb=[nx*M.throat, ny*M.throat], topNose=[M.run, M.treads*M.riser], Tb=[topNose[0]+nx*M.throat, topNose[1]+ny*M.throat];',
'    dashed(x,PX(Bb[0])-14,PY(Bb[1]),PX(maxX)+10,PY(Bb[1]));',
'    dashed(x,PX(M.run-M.tread),PY(M.rise),PX(maxX)+28,PY(M.rise));',
'    x.beginPath();x.moveTo(PX(cut[0][0]),PY(cut[0][1]));',
'    for(var j=1;j<cut.length;j++) x.lineTo(PX(cut[j][0]),PY(cut[j][1]));',
// Bottom-front cut: the old single-diagonal Bb → (0,0) merged the
// plumb cut and level cut into one slope, which is what no real
// carpenter cuts. Real bottom of a cut stringer = a LEVEL cut along
// the floor (Bb → (0, Bb[1])) meeting a PLUMB cut up the front of
// the first riser ((0, Bb[1]) → (0, 0)). closePath() auto-draws the
// plumb segment back to the start point. Net result: a right-angle
// notch at the front-bottom corner instead of a triangular nick.
'    x.lineTo(PX(Tb[0]),PY(Tb[1]));x.lineTo(PX(Bb[0]),PY(Bb[1]));x.lineTo(PX(0),PY(Bb[1]));x.closePath();',
'    x.fillStyle="rgba(184,134,72,0.30)";x.fill();x.strokeStyle="#c08a45";x.lineWidth=2;x.stroke();',
'    x.fillStyle="#8a8a8a";x.font="10px Arial";x.textAlign="left";x.fillText("Ground",PX(Bb[0])-14,PY(Bb[1])+14);',
'    x.textAlign="right";x.fillText("Top",PX(maxX)+28,PY(M.rise)-5);',
'    dim(x,PX(Bb[0]),PY(Bb[1]),PX(Tb[0]),PY(Tb[1]),COL.H); tag(x,PX((Bb[0]+Tb[0])/2)+4,PY((Bb[1]+Tb[1])/2)-9,"H",COL.H);',
'    var Gf=[M.run+nx*M.bwidth, M.rise+ny*M.bwidth]; dim(x,PX(M.run),PY(M.rise),PX(Gf[0]),PY(Gf[1]),COL.G); tag(x,PX((M.run+Gf[0])/2)+11,PY((M.rise+Gf[1])/2),"G",COL.G);',
'    if(M.treads>=2){ dim(x,PX(M.tread),PY(M.riser),PX(M.tread),PY(2*M.riser),COL.C); tag(x,PX(M.tread)+10,PY(1.5*M.riser),"C",COL.C); }',
'    dim(x,PX(0),PY(M.riser),PX(M.tread),PY(M.riser),COL.D); tag(x,PX(M.tread/2),PY(M.riser)+12,"D",COL.D);',
// F (first installed riser height) drawn on the plumb-cut edge, just
// outside the board's left side. Bumped 3px further left so it has
// more breathing room from the I label below it.
'    dim(x,PX(0)-9,PY(0),PX(0)-9,PY(M.first),COL.F); tag(x,PX(0)-21,PY(M.first/2),"F",COL.F);',
// I (throat / minimum wood under the nosing line) goes from origin
// diagonally down-right to Bb. Old label position landed right under
// the F dim line and the two letters bunched into "FI" on tall stair
// configs. Push the label well down-right of the dim midpoint so it
// reads cleanly inside the level-cut wedge.
'    dim(x,PX(0),PY(0),PX(Bb[0]),PY(Bb[1]),COL.I); tag(x,PX(Bb[0])+12,PY(Bb[1])-4,"I",COL.I);',
'  }',
'  function postResult(){',
'    try{ window.parent.postMessage({type:"p86-field-tool-result",',
'      inputs:{ "Total rise":fmtFtIn(M.rise), "Target riser":fmtIn(M.tRiser), "Tread depth":fmtIn(M.tread), "Tread thickness":fmtIn(M.tthick), "Board width":fmtIn(M.bwidth) },',
'      outputs:{ "Risers":M.risers, "Riser height":fmtIn(M.riser), "Treads":M.treads, "Total run":fmtFtIn(M.run), "First step (cut)":fmtIn(M.first), "Stringer length":fmtFtIn(M.slen), "Angle":M.ang.toFixed(1)+"\\u00b0", "Throat":fmtIn(M.throat) } },"*"); }catch(e){}',
'  }',
'  ["rise","triser","tread","tthick","bwidth"].forEach(function(id){ var el=document.getElementById(id); el.addEventListener("input",compute); el.addEventListener("change",compute); });',
'  window.addEventListener("resize",function(){ drawSide(); drawStringer(); });',
'  compute();',
'})();',
'</script>',
'</body></html>'
].join('\n');

var CATALOG = [
  {
    key: 'stairs-calculator',
    name: 'Stairs Calculator',
    description: 'Rise + targets in, full stair layout out — risers, run, first-step cut, stringer length/angle, throat + color-coded side-view & stringer cut diagrams.',
    category: 'calculator',
    html_body: STAIRS_HTML
  }
];

function getCatalog() { return CATALOG; }
function getEntry(key) {
  for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].key === key) return CATALOG[i];
  return null;
}

module.exports = { CATALOG: CATALOG, getCatalog: getCatalog, getEntry: getEntry };
