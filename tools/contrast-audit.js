(function(){
const parse=(c)=>{const m=c.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};};
const lum=(c)=>{const f=(v)=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b);};
const blend=(top,bot)=>({r:top.r*top.a+bot.r*(1-top.a),g:top.g*top.a+bot.g*(1-top.a),b:top.b*top.a+bot.b*(1-top.a),a:1});
function bgOf(el){const layers=[];let e=el;while(e){const cs=getComputedStyle(e);if(cs.backgroundImage&&cs.backgroundImage!=='none'&&!/url\(/.test(cs.backgroundImage))return {grad:true};const c=parse(cs.backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break;}e=e.parentElement;}
 let base={r:255,g:255,b:255,a:1};if(layers.length&&layers[layers.length-1].a<1){const b=parse(getComputedStyle(document.body).backgroundColor);if(b)base=b;}
 let out=base;for(let i=layers.length-1;i>=0;i--)out=blend(layers[i],out);return out;}
const bad=[];const seen=new Set();
const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
let n;while((n=walker.nextNode())){const t=n.textContent.trim();if(!t)continue;const el=n.parentElement;if(!el||!el.offsetParent&&getComputedStyle(el).position!=='fixed')continue;
 const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;const cs=getComputedStyle(el);if(cs.visibility==='hidden'||+cs.opacity===0)continue;
 const fg=parse(cs.color);if(!fg)continue;const bg=bgOf(el);if(bg.grad)continue;const f=fg.a<1?blend(fg,bg):fg;
 const L1=lum(f),L2=lum(bg);const ratio=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
 const size=parseFloat(cs.fontSize);const bold=+cs.fontWeight>=700;const need=(size>=18.66||(size>=14&&bold))?3:4.5;
 if(ratio<need-0.01){const key=el.className+'|'+t.slice(0,25);if(seen.has(key))continue;seen.add(key);bad.push(ratio.toFixed(2)+' need '+need+' · '+(el.className||el.tagName).toString().slice(0,40)+' · "'+t.slice(0,40)+'"');}}
window.__out=bad.slice(0,60);
})();
