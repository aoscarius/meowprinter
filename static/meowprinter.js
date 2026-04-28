// ════════════════════════════════════════════
//  CAT PROTOCOL
// ════════════════════════════════════════════
const CRC8T = new Uint8Array([
  0x00,0x07,0x0e,0x09,0x1c,0x1b,0x12,0x15,0x38,0x3f,0x36,0x31,
  0x24,0x23,0x2a,0x2d,0x70,0x77,0x7e,0x79,0x6c,0x6b,0x62,0x65,
  0x48,0x4f,0x46,0x41,0x54,0x53,0x5a,0x5d,0xe0,0xe7,0xee,0xe9,
  0xfc,0xfb,0xf2,0xf5,0xd8,0xdf,0xd6,0xd1,0xc4,0xc3,0xca,0xcd,
  0x90,0x97,0x9e,0x99,0x8c,0x8b,0x82,0x85,0xa8,0xaf,0xa6,0xa1,
  0xb4,0xb3,0xba,0xbd,0xc7,0xc0,0xc9,0xce,0xdb,0xdc,0xd5,0xd2,
  0xff,0xf8,0xf1,0xf6,0xe3,0xe4,0xed,0xea,0xb7,0xb0,0xb9,0xbe,
  0xab,0xac,0xa5,0xa2,0x8f,0x88,0x81,0x86,0x93,0x94,0x9d,0x9a,
  0x27,0x20,0x29,0x2e,0x3b,0x3c,0x35,0x32,0x1f,0x18,0x11,0x16,
  0x03,0x04,0x0d,0x0a,0x57,0x50,0x59,0x5e,0x4b,0x4c,0x45,0x42,
  0x6f,0x68,0x61,0x66,0x73,0x74,0x7d,0x7a,0x89,0x8e,0x87,0x80,
  0x95,0x92,0x9b,0x9c,0xb1,0xb6,0xbf,0xb8,0xad,0xaa,0xa3,0xa4,
  0xf9,0xfe,0xf7,0xf0,0xe5,0xe2,0xeb,0xec,0xc1,0xc6,0xcf,0xc8,
  0xdd,0xda,0xd3,0xd4,0x69,0x6e,0x67,0x60,0x75,0x72,0x7b,0x7c,
  0x51,0x56,0x5f,0x58,0x4d,0x4a,0x43,0x44,0x19,0x1e,0x17,0x10,
  0x05,0x02,0x0b,0x0c,0x21,0x26,0x2f,0x28,0x3d,0x3a,0x33,0x34,
  0x4e,0x49,0x40,0x47,0x52,0x55,0x5c,0x5b,0x76,0x71,0x78,0x7f,
  0x6a,0x6d,0x64,0x63,0x3e,0x39,0x30,0x37,0x22,0x25,0x2c,0x2b,
  0x06,0x01,0x08,0x0f,0x1a,0x1d,0x14,0x13,0xae,0xa9,0xa0,0xa7,
  0xb2,0xb5,0xbc,0xbb,0x96,0x91,0x98,0x9f,0x8a,0x8d,0x84,0x83,
  0xde,0xd9,0xd0,0xd7,0xc2,0xc5,0xcc,0xcb,0xe6,0xe1,0xe8,0xef,
  0xfa,0xfd,0xf4,0xf3
]);
 
function crc8(data) {
  let crc = 0;
  for (const byte of data) crc = CRC8T[(crc ^ byte) & 0xff];
  return crc & 0xff;
}

function bytesLE(val, len = 1) {
  const r = new Uint8Array(len);
  for (let i = 0; i < len; i++) { r[i] = val & 0xff; val >>= 8; }
  return r;
}

function delay(ms) { 
  return new Promise(r => setTimeout(r, ms)); 
}

class CatPrinter{
  constructor(model,writeFn,dry=false){
    this.model=model;this.writeFn=writeFn;this.dry=dry;
    this.mtu=200;this.buf=new Uint8Array(this.mtu);this.bs=0;
    this.state={pause:0,busy:0};this.bytesSent=0;
  }
  notify(m){this.state={pause:m[6]&16,busy:m[6]&0x80}}
  make(cmd,pl,t=0){return new Uint8Array([0x51,0x78,cmd,t,pl.length&0xff,pl.length>>8,...pl,crc8(pl),0xff])}
  pend(d){for(let i=0;i<d.length;i++)this.buf[this.bs++]=d[i]}
  async flush(){
    while(this.state.pause)await delay(100);
    if(!this.bs)return;
    const chunk=this.buf.slice(0,this.bs);
    this.bytesSent+=chunk.length;
    if(!this.dry)await this.writeFn(chunk);
    this.bs=0;await delay(this.dry?2:20);
  }
  async send(d){if(this.bs+d.length>this.mtu)await this.flush();this.pend(d)}
  draw(line){return this.send(this.make(0xa2,line))}
  async prepare(spd,nrg){
    await this.flush();
    await this.send(this.make(0xa3,bytesLE(0)));
    await this.send(new Uint8Array([0x51,0x78,0xbc,0x00,0x01,0x02,0x01,0x2d,0xff]));
    await this.send(this.make(0xa4,bytesLE(50)));
    await this.send(this.make(0xbd,bytesLE(spd)));
    await this.send(this.make(0xaf,bytesLE(nrg,2)));
    await this.send(this.make(0xbe,bytesLE(1)));
    await this.send(this.make(0xa9,bytesLE(0)));
    await this.send(this.make(0xa6,new Uint8Array([0xaa,0x55,0x17,0x38,0x44,0x5f,0x5f,0x5f,0x44,0x38,0x2c])));
    await this.flush();
  }
  async finish(feed){
    await this.flush();
    await this.send(this.make(0xa6,new Uint8Array([0xaa,0x55,0x17,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x17])));
    await this.send(this.make(0xbd,bytesLE(8)));
    await this.send(this.make(0xa1,bytesLE(feed,2)));
    await this.send(this.make(0xa3,bytesLE(0)));
    await this.flush();
  }
}

// ════════════════════════════════════════════
//  BLUETOOTH
// ════════════════════════════════════════════
const SVC='0000ae30-0000-1000-8000-00805f9b34fb';
const TX='0000ae01-0000-1000-8000-00805f9b34fb';
const RX='0000ae02-0000-1000-8000-00805f9b34fb';
const SVC2='49535343-fe7d-4ae5-8fa9-9fafd205e455';
const TX2='49535343-8841-43f4-a8d4-ecbe34729bb3';
let btDev=null,btChr=null,prn=null;

async function toggleBT(){if(btDev?.gatt?.connected)disconnectBT();else connectBT()}
async function connectBT(){
  if(!navigator.bluetooth){toast('Web Bluetooth not supported in this browser','err');return}
  setDot('spin');document.getElementById('bt-lbl').textContent='Connecting…';
  try{
    btDev=await navigator.bluetooth.requestDevice({
      filters:[{namePrefix:'GB'},{namePrefix:'MX'},{namePrefix:'YHY'},{namePrefix:'Cat'}],
      optionalServices:[SVC,SVC2]
    });
    btDev.addEventListener('gattserverdisconnected',onDisc);
    const srv=await btDev.gatt.connect();
    let svc,tx;
    try{svc=await srv.getPrimaryService(SVC);tx=await svc.getCharacteristic(TX)}
    catch{svc=await srv.getPrimaryService(SVC2);tx=await svc.getCharacteristic(TX2)}
    try{const rx=await svc.getCharacteristic(RX);await rx.startNotifications();rx.addEventListener('characteristicvaluechanged',e=>{if(prn)prn.notify(new Uint8Array(e.target.value.buffer))})}catch{}
    btChr=tx;
    prn=new CatPrinter(btDev.name||'GB03',writeToChar,false);
    setDot('ok');
    document.getElementById('bt-lbl').textContent=btDev.name||'Connected';
    document.getElementById('bt-pill').classList.add('ok');
    document.getElementById('p-dryrun').value='0';
    toast('Connected to '+(btDev.name||'printer'),'ok');
  }catch(e){setDot('');document.getElementById('bt-lbl').textContent='Disconnected';if(e.name!=='NotFoundError')toast('BT Error: '+e.message,'err')}
}
async function writeToChar(data){if(!btChr)return;for(let i=0;i<data.length;i+=20){await btChr.writeValueWithoutResponse(data.slice(i,i+20));await delay(5)}}
function disconnectBT(){btDev?.gatt?.disconnect()}
function onDisc(){btChr=null;prn=null;setDot('');document.getElementById('bt-pill').classList.remove('ok');document.getElementById('bt-lbl').textContent='Disconnected';toast('Disconnected','err')}
function setDot(cls){const d=document.getElementById('bt-dot');d.className='bt-dot'+(cls?' '+cls:'')}

// ════════════════════════════════════════════
//  DENSITY PRESETS
// ════════════════════════════════════════════
const DENSITY={
  draft:  {energy:3000, speed:8},
  normal: {energy:8000, speed:5},
  bold:   {energy:18000,speed:3},
  max:    {energy:40000,speed:1},
};
function setDensity(key,btn){
  const d=DENSITY[key];
  document.getElementById('p-energy').value=d.energy;
  document.getElementById('p-speed').value=d.speed;
  document.getElementById('ev-e').textContent=d.energy;
  document.getElementById('ev-s').textContent=d.speed;
  document.querySelectorAll('.density-opt').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}

// ════════════════════════════════════════════
//  BLOCK SYSTEM
// ════════════════════════════════════════════
let blocks=[],idSeq=0;
const PW=()=>parseInt(document.getElementById('p-width').value)||384;

const BDEF={
  text:     {text:'Hello, Meow!',size:28,align:'center',font:'monospace',bold:'normal'},
  inverted: {text:'INVERTED',size:28,align:'center',font:'monospace',bold:'bold'},
  image:    {src:null,fileName:'',dither:'atkinson',threshold:128,contrast:0},
  qr:       {content:'https://aoscarius.github.io/',label:'aoscarius.github.io',margin:24},
  barcode:  {content:'012345678905',height:60,showText:true},
  table:    {cols:2,rows:[['Item','Value'],['A','100'],['B','200']],fontSize:14,bold_header:true},
  checklist:{items:['Task one','Task two','Task three'],checked:[false,false,false]},
  drawing:  {dataUrl:null,height:100},
  logo:     {src:null,fileName:'',width:50},
  countdown:{target:new Date(Date.now()+7*864e5).toISOString().slice(0,10),label:'Days left',size:40,align:'center'},
  ruler:    {unit:'cm',width:60,ticks:10},
  datetime: {format:'full',size:16,align:'center'},
  separator:{style:'solid',thickness:2,padding:10},
  spacer:   {height:30},
};
const BNAME={text:'Text',inverted:'Inverted Text',image:'Image',qr:'QR Code',barcode:'Barcode',table:'Table',checklist:'Checklist',drawing:'Drawing',logo:'Logo / Header',countdown:'Countdown',ruler:'Ruler',datetime:'Date & Time',separator:'Separator',spacer:'Spacer'};
const BICON={text:'✏️',inverted:'◼',image:'🖼',qr:'◼',barcode:'▦',table:'📋',checklist:'☑',drawing:'✍️',logo:'🏷',countdown:'⏳',ruler:'📏',datetime:'🕐',separator:'—',spacer:'↕'};

function addBlock(type){
  const id='b'+(++idSeq);
  blocks.push({id,type,...JSON.parse(JSON.stringify(BDEF[type]))});
  renderBlockList(id);
  schedulePreview();
}
function removeBlock(id){blocks=blocks.filter(b=>b.id!==id);renderBlockList();refreshPreview()}
function duplicateBlock(id){
  const b=blocks.find(b=>b.id===id);if(!b)return;
  const nb={...JSON.parse(JSON.stringify(b)),id:'b'+(++idSeq)};
  const i=blocks.findIndex(b=>b.id===id);
  blocks.splice(i+1,0,nb);renderBlockList();refreshPreview();
}
function moveBlock(id,dir){
  const i=blocks.findIndex(b=>b.id===id);if(i<0)return;
  const ni=i+dir;if(ni<0||ni>=blocks.length)return;
  [blocks[i],blocks[ni]]=[blocks[ni],blocks[i]];
  renderBlockList();refreshPreview();
}
function clearAll(){if(!blocks.length)return;if(!confirm('Clear all blocks?'))return;blocks=[];renderBlockList();refreshPreview()}
function updateBlk(id,key,val){const b=blocks.find(b=>b.id===id);if(b)b[key]=val}

function bSummary(b){
  if(b.type==='text'||b.type==='inverted')return b.text.substring(0,25)+(b.text.length>25?'…':'');
  if(b.type==='qr')return b.content.substring(0,25);
  if(b.type==='barcode')return b.content;
  if(b.type==='datetime')return 'auto timestamp';
  if(b.type==='separator')return b.style;
  if(b.type==='spacer')return b.height+'px';
  if(b.type==='image'||b.type==='logo')return b.fileName||'no image';
  if(b.type==='table')return b.rows.length+' rows';
  if(b.type==='drawing')return b.dataUrl?'has drawing':'empty';
  if(b.type==='checklist')return b.items.length+' items';
  if(b.type==='countdown')return b.target;
  if(b.type==='ruler')return b.width+'% width';
  return '';
}

let _prevOpen={};

function renderBlockList(newId=null){
  const list=document.getElementById('block-list');
  document.getElementById('empty-state').style.display=blocks.length?'none':'flex';
  document.getElementById('blk-count').textContent=blocks.length+' block'+(blocks.length===1?'':'s');

  // Save open state
  list.querySelectorAll('.block-card').forEach(c=>{
    const body=c.querySelector('.block-body');
    if(body)_prevOpen[c.dataset.id]=body.classList.contains('open');
  });

  list.querySelectorAll('.block-card').forEach(c=>c.remove());

  blocks.forEach((blk)=>{
    const card=document.createElement('div');
    card.className='block-card'+(blk.id===newId?' new-block':'');
    card.dataset.type=blk.type;
    card.dataset.id=blk.id;

    card.innerHTML=`
      <div class="block-head">
        <span class="drag-handle" data-drag="${blk.id}" title="Drag to reorder">⠿</span>
        <span class="blk-icon">${BICON[blk.type]}</span>
        <span class="blk-label">${BNAME[blk.type]}</span>
        <span class="blk-summary" id="bs_${blk.id}">${bSummary(blk)}</span>
        <div class="blk-acts">
          <button class="bact" onclick="event.stopPropagation();moveBlock('${blk.id}',-1)" title="Move up">↑</button>
          <button class="bact" onclick="event.stopPropagation();moveBlock('${blk.id}',1)" title="Move down">↓</button>
          <button class="bact" onclick="event.stopPropagation();duplicateBlock('${blk.id}')" title="Duplicate">⧉</button>
          <button class="bact del" onclick="event.stopPropagation();removeBlock('${blk.id}')" title="Remove">✕</button>
        </div>
      </div>
      <div class="block-body${_prevOpen[blk.id]?' open':''}">${bBodyHTML(blk)}</div>`;

    list.appendChild(card);

    // Toggle body on head click (NOT on handle or actions)
    card.querySelector('.block-head').addEventListener('click',e=>{
      if(e.target.closest('.blk-acts')||e.target.closest('.drag-handle'))return;
      const body=card.querySelector('.block-body');
      const opening=!body.classList.contains('open');
      body.classList.toggle('open');
      if(opening){
        if(blk.type==='drawing')initDrawCanvas(card,blk);
        if(blk.type==='table')renderTableEditor(card,blk);
        if(blk.type==='checklist')renderChecklistEditor(card,blk);
      }
    });

    // If was open, re-init special editors
    if(_prevOpen[blk.id]){
      if(blk.type==='drawing')setTimeout(()=>initDrawCanvas(card,blk),50);
      if(blk.type==='table')renderTableEditor(card,blk);
      if(blk.type==='checklist')renderChecklistEditor(card,blk);
    }

    // Drag-and-drop: only from handle
    const handle=card.querySelector('.drag-handle');
    handle.addEventListener('mousedown',e=>{e.stopPropagation();startDrag(e,blk.id,card)});
    handle.addEventListener('touchstart',e=>{e.stopPropagation();startDrag(e,blk.id,card)},{passive:true});

    // Drop target
    card.addEventListener('dragover',e=>{e.preventDefault();card.classList.add('drag-over')});
    card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
    card.addEventListener('drop',e=>{
      e.preventDefault();card.classList.remove('drag-over');
      const fid=e.dataTransfer?.getData('text/plain');
      if(!fid)return;
      const fi=blocks.findIndex(b=>b.id===fid);
      const ti=blocks.findIndex(b=>b.id===blk.id);
      if(fi<0||ti<0||fi===ti)return;
      const [m]=blocks.splice(fi,1);blocks.splice(ti,0,m);
      renderBlockList();refreshPreview();
    });
    card.setAttribute('draggable','false'); // only via handle
  });
}

// Native drag from handle
let dragId=null;
function startDrag(e,id,card){
  dragId=id;
  card.setAttribute('draggable','true');
  card.addEventListener('dragstart',ev=>{
    ev.dataTransfer.setData('text/plain',id);
    card.classList.add('is-dragging');
  },{once:true});
  card.addEventListener('dragend',()=>{
    card.classList.remove('is-dragging');
    card.setAttribute('draggable','false');
  },{once:true});
}

// ════════════════════════════════════════════
//  BLOCK BODY HTML
// ════════════════════════════════════════════
function bBodyHTML(b){
  const id=b.id;
  switch(b.type){
    case 'text': return `
      <div class="fr"><label>Text</label><textarea oninput="updateBlk('${id}','text',this.value);updSummary('${id}',this.value.substring(0,25));schedulePreview()">${b.text}</textarea></div>
      <div class="fg">
        <div class="fr"><label>Size — <span id="sv_${id}">${b.size}</span>px</label><div class="rr"><input type="range" min="8" max="72" value="${b.size}" oninput="updateBlk('${id}','size',+this.value);document.getElementById('sv_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Align</label><select onchange="updateBlk('${id}','align',this.value);schedulePreview()"><option value="left"${b.align==='left'?' selected':''}>◀ Left</option><option value="center"${b.align==='center'?' selected':''}>◆ Center</option><option value="right"${b.align==='right'?' selected':''}>▶ Right</option></select></div>
        <div class="fr"><label>Font</label><select onchange="updateBlk('${id}','font',this.value);schedulePreview()"><option value="monospace"${b.font==='monospace'?' selected':''}>Monospace</option><option value="serif"${b.font==='serif'?' selected':''}>Serif</option><option value="sans-serif"${b.font==='sans-serif'?' selected':''}>Sans-serif</option></select></div>
        <div class="fr"><label>Weight</label><select onchange="updateBlk('${id}','bold',this.value);schedulePreview()"><option value="normal"${b.bold==='normal'?' selected':''}>Normal</option><option value="bold"${b.bold==='bold'?' selected':''}>Bold</option></select></div>
      </div>`;

    case 'inverted': return `
      <div class="fr"><label>Text (white on black)</label><textarea oninput="updateBlk('${id}','text',this.value);updSummary('${id}',this.value.substring(0,25));schedulePreview()">${b.text}</textarea></div>
      <div class="fg">
        <div class="fr"><label>Size — <span id="sv_${id}">${b.size}</span>px</label><div class="rr"><input type="range" min="8" max="72" value="${b.size}" oninput="updateBlk('${id}','size',+this.value);document.getElementById('sv_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Align</label><select onchange="updateBlk('${id}','align',this.value);schedulePreview()"><option value="left"${b.align==='left'?' selected':''}>◀ Left</option><option value="center"${b.align==='center'?' selected':''}>◆ Center</option><option value="right"${b.align==='right'?' selected':''}>▶ Right</option></select></div>
        <div class="fr"><label>Font</label><select onchange="updateBlk('${id}','font',this.value);schedulePreview()"><option value="monospace">Monospace</option><option value="serif">Serif</option><option value="sans-serif">Sans-serif</option></select></div>
        <div class="fr"><label>Weight</label><select onchange="updateBlk('${id}','bold',this.value);schedulePreview()"><option value="normal">Normal</option><option value="bold"${b.bold==='bold'?' selected':''}>Bold</option></select></div>
      </div>`;

    case 'image': return `
      <div class="mini-dz" id="dz_${id}" onclick="document.getElementById('fi_${id}').click()" ondragover="event.preventDefault();this.classList.add('hov')" ondragleave="this.classList.remove('hov')" ondrop="handleImgDrop(event,'${id}')">${b.src?`<img src="${b.src}"><br><small>${b.fileName}</small>`:'📁 Drag or click to load image'}</div>
      <input type="file" accept="image/*" id="fi_${id}" style="display:none" onchange="loadBlockImg(event,'${id}')">
      <div class="fg" style="margin-top:8px">
        <div class="fr"><label>Dithering</label><select onchange="updateBlk('${id}','dither',this.value);schedulePreview()"><option value="atkinson"${b.dither==='atkinson'?' selected':''}>Atkinson</option><option value="floyd"${b.dither==='floyd'?' selected':''}>Floyd-Steinberg</option><option value="threshold"${b.dither==='threshold'?' selected':''}>Threshold</option><option value="none"${b.dither==='none'?' selected':''}>None</option></select></div>
        <div class="fr"><label>Threshold — <span id="tv_${id}">${b.threshold}</span></label><div class="rr"><input type="range" min="0" max="255" value="${b.threshold}" oninput="updateBlk('${id}','threshold',+this.value);document.getElementById('tv_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Contrast — <span id="cv_${id}">${b.contrast>0?'+':''}${b.contrast}</span></label><div class="rr"><input type="range" min="-100" max="100" value="${b.contrast}" oninput="updateBlk('${id}','contrast',+this.value);document.getElementById('cv_${id}').textContent=(this.value>0?'+':'')+this.value;schedulePreview()"></div></div>
      </div>`;

    case 'qr': return `
      <div class="fr"><label>Content / URL</label><input type="text" value="${b.content}" oninput="updateBlk('${id}','content',this.value);updSummary('${id}',this.value.substring(0,25));schedulePreview()"></div>
      <div class="fr"><label>Caption (optional)</label><input type="text" value="${b.label}" placeholder="e.g. scan here" oninput="updateBlk('${id}','label',this.value);schedulePreview()"></div>
      <div class="fr"><label>Margin — <span id="mv_${id}">${b.margin}</span>px</label><div class="rr"><input type="range" min="0" max="60" value="${b.margin}" oninput="updateBlk('${id}','margin',+this.value);document.getElementById('mv_${id}').textContent=this.value;schedulePreview()"></div></div>`;

    case 'barcode': return `
      <div class="fr"><label>Code (Code128)</label><input type="text" value="${b.content}" oninput="updateBlk('${id}','content',this.value);updSummary('${id}',this.value);schedulePreview()"></div>
      <div class="fg">
        <div class="fr"><label>Height — <span id="bh_${id}">${b.height}</span>px</label><div class="rr"><input type="range" min="20" max="120" value="${b.height}" oninput="updateBlk('${id}','height',+this.value);document.getElementById('bh_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Show Text</label><select onchange="updateBlk('${id}','showText',this.value==='1');schedulePreview()"><option value="1"${b.showText?' selected':''}>Yes</option><option value="0"${!b.showText?' selected':''}>No</option></select></div>
      </div>`;

    case 'table': return `
      <div class="fg">
        <div class="fr"><label>Columns</label><select onchange="updateBlk('${id}','cols',+this.value);adjustTableCols('${id}');schedulePreview()">${[2,3,4].map(n=>`<option value="${n}"${b.cols===n?' selected':''}>${n}</option>`).join('')}</select></div>
        <div class="fr"><label>Bold Header</label><select onchange="updateBlk('${id}','bold_header',this.value==='1');schedulePreview()"><option value="1"${b.bold_header?' selected':''}>Yes</option><option value="0"${!b.bold_header?' selected':''}>No</option></select></div>
        <div class="fr"><label>Font Size — <span id="tf_${id}">${b.fontSize}</span>px</label><div class="rr"><input type="range" min="9" max="24" value="${b.fontSize}" oninput="updateBlk('${id}','fontSize',+this.value);document.getElementById('tf_${id}').textContent=this.value;schedulePreview()"></div></div>
      </div>
      <div class="table-grid" id="tg_${id}"></div>`;

    case 'checklist': return `
      <div class="check-editor" id="ce_${id}"></div>
      <button class="add-row-btn" style="margin-top:6px" onclick="addCheckItem('${id}')">+ Add item</button>`;

    case 'drawing': return `
      <div class="fr"><label>Height — <span id="dh_${id}">${b.height}</span>px</label><div class="rr"><input type="range" min="60" max="400" value="${b.height}" oninput="updateBlk('${id}','height',+this.value);resizeDrawCvs('${id}',+this.value);document.getElementById('dh_${id}').textContent=this.value"></div></div>
      <canvas class="draw-cvs" id="dc_${id}" width="384" height="${b.height}"></canvas>
      <div class="draw-tools">
        <button class="dtool on" id="dp_${id}" onclick="setDrawTool('${id}','pen',this)">✏ Pen</button>
        <button class="dtool" id="de_${id}" onclick="setDrawTool('${id}','eraser',this)">⬜ Eraser</button>
        <button class="dtool" onclick="setDrawWidth('${id}',1)">thin</button>
        <button class="dtool" onclick="setDrawWidth('${id}',3)">medium</button>
        <button class="dtool" onclick="setDrawWidth('${id}',6)">thick</button>
        <button class="dtool" onclick="clearDrawCvs('${id}')">✕ Clear</button>
      </div>`;

    case 'logo': return `
      <div class="mini-dz" id="ldz_${id}" onclick="document.getElementById('lfi_${id}').click()" ondragover="event.preventDefault();this.classList.add('hov')" ondragleave="this.classList.remove('hov')" ondrop="handleImgDrop(event,'${id}','logo')">${b.src?`<img src="${b.src}"><br><small>${b.fileName}</small>`:'🏷 Logo/header image'}</div>
      <input type="file" accept="image/*" id="lfi_${id}" style="display:none" onchange="loadBlockImg(event,'${id}','logo')">
      <div class="fr"><label>Width — <span id="lw_${id}">${b.width}</span>%</label><div class="rr"><input type="range" min="10" max="100" value="${b.width}" oninput="updateBlk('${id}','width',+this.value);document.getElementById('lw_${id}').textContent=this.value;schedulePreview()"></div></div>`;

    case 'countdown': return `
      <div class="fr"><label>Target Date</label><input type="text" value="${b.target}" placeholder="YYYY-MM-DD" oninput="updateBlk('${id}','target',this.value);updSummary('${id}',this.value);schedulePreview()"></div>
      <div class="fr"><label>Label</label><input type="text" value="${b.label}" oninput="updateBlk('${id}','label',this.value);schedulePreview()"></div>
      <div class="fg">
        <div class="fr"><label>Number Size — <span id="cs_${id}">${b.size}</span></label><div class="rr"><input type="range" min="20" max="80" value="${b.size}" oninput="updateBlk('${id}','size',+this.value);document.getElementById('cs_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Align</label><select onchange="updateBlk('${id}','align',this.value);schedulePreview()"><option value="left">Left</option><option value="center"${b.align==='center'?' selected':''}>Center</option><option value="right">Right</option></select></div>
      </div>`;

    case 'ruler': return `
      <div class="fg">
        <div class="fr"><label>Unit</label><select onchange="updateBlk('${id}','unit',this.value);schedulePreview()"><option value="cm"${b.unit==='cm'?' selected':''}>cm</option><option value="mm"${b.unit==='mm'?' selected':''}>mm</option><option value="in"${b.unit==='in'?' selected':''}>inch</option></select></div>
        <div class="fr"><label>Width — <span id="rw_${id}">${b.width}</span>%</label><div class="rr"><input type="range" min="20" max="100" value="${b.width}" oninput="updateBlk('${id}','width',+this.value);document.getElementById('rw_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Ticks — <span id="rt_${id}">${b.ticks}</span></label><div class="rr"><input type="range" min="2" max="20" value="${b.ticks}" oninput="updateBlk('${id}','ticks',+this.value);document.getElementById('rt_${id}').textContent=this.value;schedulePreview()"></div></div>
      </div>`;

    case 'datetime': return `
      <div class="fg">
        <div class="fr"><label>Format</label><select onchange="updateBlk('${id}','format',this.value);schedulePreview()"><option value="full"${b.format==='full'?' selected':''}>Date + Time</option><option value="date"${b.format==='date'?' selected':''}>Date only</option><option value="time"${b.format==='time'?' selected':''}>Time only</option></select></div>
        <div class="fr"><label>Size — <span id="dts_${id}">${b.size}</span></label><div class="rr"><input type="range" min="10" max="40" value="${b.size}" oninput="updateBlk('${id}','size',+this.value);document.getElementById('dts_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Align</label><select onchange="updateBlk('${id}','align',this.value);schedulePreview()"><option value="left">Left</option><option value="center"${b.align==='center'?' selected':''}>Center</option><option value="right">Right</option></select></div>
      </div>`;

    case 'separator': return `
      <div class="fg">
        <div class="fr"><label>Style</label><select onchange="updateBlk('${id}','style',this.value);schedulePreview()"><option value="solid"${b.style==='solid'?' selected':''}>— Solid</option><option value="dashed"${b.style==='dashed'?' selected':''}>- - Dashed</option><option value="dotted"${b.style==='dotted'?' selected':''}>· · Dotted</option><option value="double"${b.style==='double'?' selected':''}>═ Double</option><option value="wave"${b.style==='wave'?' selected':''}>~ Wave</option></select></div>
        <div class="fr"><label>Thickness — <span id="st_${id}">${b.thickness}</span>px</label><div class="rr"><input type="range" min="1" max="8" value="${b.thickness}" oninput="updateBlk('${id}','thickness',+this.value);document.getElementById('st_${id}').textContent=this.value;schedulePreview()"></div></div>
        <div class="fr"><label>Padding — <span id="sp_${id}">${b.padding}</span>px</label><div class="rr"><input type="range" min="0" max="50" value="${b.padding}" oninput="updateBlk('${id}','padding',+this.value);document.getElementById('sp_${id}').textContent=this.value;schedulePreview()"></div></div>
      </div>`;

    case 'spacer': return `
      <div class="fr"><label>Height — <span id="spv_${id}">${b.height}</span>px</label><div class="rr"><input type="range" min="4" max="200" value="${b.height}" oninput="updateBlk('${id}','height',+this.value);document.getElementById('spv_${id}').textContent=this.value;schedulePreview()"></div></div>`;
  }
  return '';
}

function updSummary(id,txt){const el=document.getElementById('bs_'+id);if(el)el.textContent=txt}

// ─── TABLE EDITOR ─────────────────────────
function renderTableEditor(card,blk){
  const tg=card.querySelector('#tg_'+blk.id);if(!tg)return;
  tg.innerHTML='';
  blk.rows.forEach((row,ri)=>{
    const rd=document.createElement('div');
    rd.className='table-row-e';
    rd.style.gridTemplateColumns=`repeat(${blk.cols},1fr) 22px`;
    row.slice(0,blk.cols).forEach((cell,ci)=>{
      const inp=document.createElement('input');
      inp.className='tce';inp.value=cell;
      if(ri===0&&blk.bold_header)inp.style.fontWeight='700';
      inp.oninput=()=>{blk.rows[ri][ci]=inp.value;schedulePreview()};
      rd.appendChild(inp);
    });
    const del=document.createElement('button');
    del.className='bact del';del.textContent='✕';del.onclick=()=>{blk.rows.splice(ri,1);renderTableEditor(card,blk);schedulePreview()};
    rd.appendChild(del);tg.appendChild(rd);
  });
  const ab=document.createElement('button');ab.className='add-row-btn';ab.textContent='+ Add row';
  ab.onclick=()=>{blk.rows.push(new Array(blk.cols).fill(''));renderTableEditor(card,blk);schedulePreview()};
  tg.appendChild(ab);
}
function adjustTableCols(id){
  const b=blocks.find(b=>b.id===id);if(!b)return;
  b.rows=b.rows.map(r=>{while(r.length<b.cols)r.push('');return r.slice(0,b.cols)});
  const card=document.querySelector(`[data-id="${id}"]`);if(card)renderTableEditor(card,b);
}

// ─── CHECKLIST EDITOR ────────────────────
function renderChecklistEditor(card,blk){
  const ce=card.querySelector('#ce_'+blk.id);if(!ce)return;ce.innerHTML='';
  blk.items.forEach((item,i)=>{
    const row=document.createElement('div');row.className='check-row';
    const box=document.createElement('div');box.className='chk-pre';
    if(blk.checked[i])box.style.background='var(--ink)';
    box.style.cursor='pointer';
    box.onclick=()=>{blk.checked[i]=!blk.checked[i];box.style.background=blk.checked[i]?'var(--ink)':'transparent';schedulePreview()};
    const inp=document.createElement('input');inp.type='text';inp.value=item;
    inp.oninput=()=>{blk.items[i]=inp.value;schedulePreview()};
    const del=document.createElement('button');del.className='bact del';del.textContent='✕';
    del.onclick=()=>{blk.items.splice(i,1);blk.checked.splice(i,1);renderChecklistEditor(card,blk);schedulePreview()};
    row.append(box,inp,del);ce.appendChild(row);
  });
}
function addCheckItem(id){
  const b=blocks.find(b=>b.id===id);if(!b)return;
  b.items.push('New item');b.checked.push(false);
  const card=document.querySelector(`[data-id="${id}"]`);if(card)renderChecklistEditor(card,b);
  schedulePreview();
}

// ─── DRAWING ────────────────────────────
const DS={};
function initDrawCanvas(card,blk){
  const cvs=card.querySelector('#dc_'+blk.id);if(!cvs)return;
  cvs.width=PW();cvs.height=blk.height;
  const ctx=cvs.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,cvs.width,cvs.height);
  if(blk.dataUrl){const img=new Image();img.onload=()=>ctx.drawImage(img,0,0,cvs.width,cvs.height);img.src=blk.dataUrl}
  if(DS[blk.id])return; // already bound
  DS[blk.id]={tool:'pen',w:2,drawing:false,lx:0,ly:0};
  const s=DS[blk.id];
  function pos(e){const r=cvs.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:(t.clientX-r.left)*cvs.width/r.width,y:(t.clientY-r.top)*cvs.height/r.height}}
  function down(e){e.preventDefault();s.drawing=true;const p=pos(e);s.lx=p.x;s.ly=p.y}
  function move(e){
    e.preventDefault();if(!s.drawing)return;
    const p=pos(e);
    ctx.beginPath();ctx.strokeStyle=s.tool==='eraser'?'#fff':'#000';
    ctx.lineWidth=s.tool==='eraser'?20:s.w;ctx.lineCap='round';
    ctx.moveTo(s.lx,s.ly);ctx.lineTo(p.x,p.y);ctx.stroke();
    s.lx=p.x;s.ly=p.y;blk.dataUrl=cvs.toDataURL();schedulePreview();
  }
  function up(){s.drawing=false}
  cvs.addEventListener('mousedown',down);cvs.addEventListener('mousemove',move);
  cvs.addEventListener('mouseup',up);cvs.addEventListener('mouseleave',up);
  cvs.addEventListener('touchstart',down,{passive:false});
  cvs.addEventListener('touchmove',move,{passive:false});
  cvs.addEventListener('touchend',up);
}
function setDrawTool(id,tool,btn){
  if(DS[id])DS[id].tool=tool;
  const card=document.querySelector(`[data-id="${id}"]`);
  if(card)card.querySelectorAll('.dtool').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
function setDrawWidth(id,w){if(DS[id])DS[id].w=w}
function clearDrawCvs(id){
  const cvs=document.getElementById('dc_'+id);if(!cvs)return;
  const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,cvs.width,cvs.height);
  const b=blocks.find(b=>b.id===id);if(b)b.dataUrl=null;schedulePreview();
}
function resizeDrawCvs(id,h){
  const cvs=document.getElementById('dc_'+id);if(!cvs)return;
  const tmp=document.createElement('canvas');tmp.width=cvs.width;tmp.height=cvs.height;
  tmp.getContext('2d').drawImage(cvs,0,0);cvs.height=h;
  const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,cvs.width,h);ctx.drawImage(tmp,0,0);
}

// ─── IMAGE LOADING ───────────────────────
function loadBlockImg(e,id,kind='image'){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    const b=blocks.find(b=>b.id===id);if(!b)return;
    b.src=ev.target.result;b.fileName=file.name;
    const dz=document.getElementById((kind==='logo'?'ldz_':'dz_')+id);
    if(dz)dz.innerHTML=`<img src="${ev.target.result}"><br><small>${file.name}</small>`;
    updSummary(id,file.name);schedulePreview();
  };reader.readAsDataURL(file);
}
function handleImgDrop(e,id,kind='image'){
  e.preventDefault();
  const dz=document.getElementById((kind==='logo'?'ldz_':'dz_')+id);
  if(dz)dz.classList.remove('hov');
  const file=e.dataTransfer.files[0];
  if(file?.type.startsWith('image/')){
    const inp=document.getElementById((kind==='logo'?'lfi_':'fi_')+id);
    const dt=new DataTransfer();dt.items.add(file);
    inp.files=dt.files;loadBlockImg({target:inp},id,kind);
  }
}

// ════════════════════════════════════════════
//  RENDER ENGINE
// ════════════════════════════════════════════
function ditherImg(imgData,mode,thresh){
  const w=imgData.width,h=imgData.height;
  const px=new Float32Array(w*h);
  for(let i=0;i<w*h;i++)px[i]=0.299*imgData.data[i*4]+0.587*imgData.data[i*4+1]+0.114*imgData.data[i*4+2];
  if(mode==='threshold'||mode==='none'){
    for(let i=0;i<w*h;i++){const v=px[i]<thresh?0:255;imgData.data[i*4]=imgData.data[i*4+1]=imgData.data[i*4+2]=v;imgData.data[i*4+3]=255}
    return imgData;
  }
  if(mode==='floyd'){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x,o=px[i],n=o<thresh?0:255;px[i]=n;const e=o-n;
      if(x+1<w)px[i+1]+=e*7/16;
      if(y+1<h&&x>0)px[(y+1)*w+x-1]+=e*3/16;
      if(y+1<h)px[(y+1)*w+x]+=e*5/16;
      if(y+1<h&&x+1<w)px[(y+1)*w+x+1]+=e/16;
    }
  } else { // atkinson
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x,o=px[i],n=o<thresh?0:255;px[i]=n;const e=(o-n)/8;
      for(const[dy,dx] of [[0,1],[0,2],[1,-1],[1,0],[1,1],[2,0]]){
        const nx=x+dx,ny=y+dy;if(nx>=0&&nx<w&&ny>=0&&ny<h)px[ny*w+nx]+=e;
      }
    }
  }
  for(let i=0;i<w*h;i++){const v=Math.max(0,Math.min(255,px[i]));imgData.data[i*4]=imgData.data[i*4+1]=imgData.data[i*4+2]=v;imgData.data[i*4+3]=255}
  return imgData;
}

// Code128
function code128(text){
  const C=[
    [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],[1,3,1,2,2,2],
    [1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],[2,2,1,3,1,2],[2,3,1,2,1,2],
    [1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],[1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],
    [2,2,3,2,1,1],[2,2,1,1,3,2],[2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],
    [3,1,1,2,2,2],[3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
    [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],[1,3,1,3,2,1],
    [1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],[2,3,1,1,1,3],[2,3,1,3,1,1],
    [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
    [1,1,3,2,1,3],[1,1,3,2,3,1],[2,1,3,2,3,1],[1,3,1,2,3,1],[3,1,1,1,2,3],[3,1,1,3,2,1],
    [3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],[3,1,4,1,1,1],[2,2,1,4,1,1],
    [4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],[1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],
    [1,4,1,2,2,1],[1,1,2,2,1,4],[1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],
    [1,4,2,2,1,1],[2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
    [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],[1,2,4,2,1,1],
    [4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],[2,1,4,1,2,1],[4,1,2,1,2,1],
    [1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],[1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],
    [4,1,1,3,1,1],[1,1,3,1,4,1],[1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],[2,1,1,4,1,2],
    [2,1,1,2,1,4],[2,1,1,2,3,2],[2,3,3,1,1,1,2]
  ];
  const START=104,STOP=106;const vals=[START];let chk=START;
  for(let i=0;i<text.length;i++){const v=text.charCodeAt(i)-32;vals.push(v);chk+=(i+1)*v}
  vals.push(chk%103);vals.push(STOP);
  const bars=[];
  for(const v of vals){const p=C[v];if(!p)continue;for(let i=0;i<p.length;i++)bars.push({w:p[i],black:i%2===0})}
  bars.push({w:2,black:false});return bars;
}
function renderBarcode(text,height,showText,W){
  const bars=code128(text);const mw=2;
  const tw=bars.reduce((s,b)=>s+b.w,0)*mw;
  const th=showText?16:0;
  const cvs=document.createElement('canvas');cvs.width=W;cvs.height=height+th+8;
  const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
  let x=Math.floor((W-tw)/2);
  for(const b of bars){if(b.black){ctx.fillStyle='#000';ctx.fillRect(x,4,b.w*mw,height)}x+=b.w*mw}
  if(showText){ctx.fillStyle='#000';ctx.font='12px monospace';ctx.textAlign='center';ctx.fillText(text,W/2,height+18)}
  return cvs;
}

// Word-wrap text renderer
function renderText(text,size,align,font,bold,W,invert=false){
  const tmp=document.createElement('canvas');const tc=tmp.getContext('2d');
  const f=`${bold} ${size}px ${font}`;tc.font=f;
  const lines=[];
  for(const para of text.split('\n')){
    const words=para===''?['']: para.split(' ');let cur='';
    for(const w of words){const t=cur?cur+' '+w:w;if(tc.measureText(t).width>W&&cur){lines.push(cur);cur=w}else cur=t}
    lines.push(cur);
  }
  const lh=size*1.38;
  const cvs=document.createElement('canvas');cvs.width=W;cvs.height=Math.max(lines.length*lh+6,size+6);
  const ctx=cvs.getContext('2d');
  ctx.fillStyle=invert?'#000':'#fff';ctx.fillRect(0,0,W,cvs.height);
  ctx.fillStyle=invert?'#fff':'#000';ctx.font=f;ctx.textAlign=align;
  const x=align==='left'?2:align==='right'?W-2:W/2;
  let y=size;for(const l of lines){ctx.fillText(l,x,y);y+=lh}
  return cvs;
}

async function renderBlock(b){
  const W=PW();
  switch(b.type){
    case 'text': return renderText(b.text,b.size,b.align,b.font,b.bold,W,false);
    case 'inverted': return renderText(b.text,b.size,b.align,b.font,b.bold,W,true);
    case 'image':{
      if(!b.src)return null;
      return new Promise(res=>{
        const img=new Image();img.onload=()=>{
          const cvs=document.createElement('canvas');
          cvs.width=W;cvs.height=Math.round(W*img.height/img.width);
          const ctx=cvs.getContext('2d');
          if(b.contrast!==0)ctx.filter=`contrast(${100+b.contrast}%)`;
          ctx.drawImage(img,0,0,W,cvs.height);ctx.filter='none';
          let id=ctx.getImageData(0,0,W,cvs.height);
          id=ditherImg(id,b.dither,b.threshold);ctx.putImageData(id,0,0);res(cvs);
        };img.src=b.src;
      });
    }
    case 'logo':{
      if(!b.src)return null;
      return new Promise(res=>{
        const img=new Image();img.onload=()=>{
          const dw=Math.round(W*b.width/100);
          const dh=Math.round(dw*img.height/img.width);
          const cvs=document.createElement('canvas');cvs.width=W;cvs.height=dh+8;
          const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
          const x=Math.floor((W-dw)/2);
          ctx.drawImage(img,x,4,dw,dh);
          let id=ctx.getImageData(0,0,W,cvs.height);
          id=ditherImg(id,'atkinson',128);ctx.putImageData(id,0,0);res(cvs);
        };img.src=b.src;
      });
    }
    case 'qr':{
      return new Promise(res=>{
        const sc=document.getElementById('qr-scratch');sc.innerHTML='';
        try{
          new QRCode(sc,{text:b.content||' ',width:256,height:256,colorDark:'#000',colorLight:'#fff',correctLevel:QRCode.CorrectLevel.M});
          setTimeout(()=>{
            const el=sc.querySelector('img')||sc.querySelector('canvas');
            if(!el){res(null);return}
            const src=el.tagName==='CANVAS'?el.toDataURL():el.src;
            const img=new Image();img.onload=()=>{
              const m=b.margin||10;const qS=Math.min(W-m*2,290);const lH=b.label?22:0;
              const cvs=document.createElement('canvas');cvs.width=W;cvs.height=m+qS+m/2+lH;
              const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
              ctx.imageSmoothingEnabled=false;ctx.drawImage(img,Math.floor((W-qS)/2),m,qS,qS);
              if(b.label){ctx.fillStyle='#000';ctx.font='bold 14px monospace';ctx.textAlign='center';ctx.fillText(b.label,W/2,m+qS+18)}
              sc.innerHTML='';res(cvs);
            };img.src=src;
          },130);
        }catch{sc.innerHTML='';res(null)}
      });
    }
    case 'barcode': return renderBarcode(b.content,b.height,b.showText,W);
    case 'table':{
      const fs=b.fontSize||14;const lh=fs*1.6;const cW=Math.floor(W/b.cols);
      const cvs=document.createElement('canvas');cvs.width=W;cvs.height=b.rows.length*lh+4;
      const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
      b.rows.forEach((row,ri)=>{
        const hdr=ri===0&&b.bold_header;
        if(hdr){ctx.fillStyle='#111';ctx.fillRect(0,ri*lh,W,lh)}
        else if(ri%2===1){ctx.fillStyle='#efefef';ctx.fillRect(0,ri*lh,W,lh)}
        row.slice(0,b.cols).forEach((cell,ci)=>{
          ctx.font=`${hdr?'bold ':''} ${fs}px monospace`;
          ctx.fillStyle=hdr?'#fff':'#111';ctx.textAlign='left';
          ctx.fillText(String(cell).substring(0,Math.floor(cW/fs*1.6)),ci*cW+4,ri*lh+fs+2);
          if(ci>0){ctx.fillStyle='#ccc';ctx.fillRect(ci*cW,ri*lh,1,lh)}
        });
      });
      return cvs;
    }
    case 'checklist':{
      const fs=15;const lh=fs*1.7;const cvs=document.createElement('canvas');
      cvs.width=W;cvs.height=b.items.length*lh+8;
      const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
      b.items.forEach((item,i)=>{
        const y=i*lh+4;
        ctx.strokeStyle='#000';ctx.lineWidth=1.5;
        ctx.strokeRect(4,y+2,fs-4,fs-4);
        if(b.checked[i]){
          ctx.beginPath();ctx.lineWidth=2;
          ctx.moveTo(5,y+fs/2);ctx.lineTo(fs/2-2,y+fs-6);ctx.lineTo(fs+2,y);ctx.stroke();
        }
        ctx.fillStyle='#000';ctx.font=`${fs}px monospace`;ctx.textAlign='left';
        if(b.checked[i]){
          ctx.fillStyle='#888';
          ctx.fillText(item,fs+8,y+fs-2);
          ctx.fillStyle='#888';ctx.fillRect(fs+8,y+fs/2-1,ctx.measureText(item).width,1.5);
        } else ctx.fillText(item,fs+8,y+fs-2);
      });
      return cvs;
    }
    case 'drawing':{
      if(!b.dataUrl)return null;
      return new Promise(res=>{
        const img=new Image();img.onload=()=>{
          const cvs=document.createElement('canvas');cvs.width=W;cvs.height=img.height*(W/img.width);
          const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
          ctx.drawImage(img,0,0,W,cvs.height);
          let id=ctx.getImageData(0,0,W,cvs.height);
          id=ditherImg(id,'threshold',200);ctx.putImageData(id,0,0);res(cvs);
        };img.src=b.dataUrl;
      });
    }
    case 'countdown':{
      const now=new Date();const target=new Date(b.target);
      const diff=Math.ceil((target-now)/864e5);
      const numStr=String(Math.max(0,diff));
      const cvs=document.createElement('canvas');cvs.width=W;cvs.height=b.size*1.5+30;
      const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
      ctx.fillStyle='#000';ctx.textAlign=b.align;const x=b.align==='left'?4:b.align==='right'?W-4:W/2;
      ctx.font=`bold ${b.size}px monospace`;ctx.fillText(numStr,x,b.size+2);
      ctx.font=`14px monospace`;ctx.fillText(b.label,x,b.size+22);
      return cvs;
    }
    case 'ruler':{
      const cvs=document.createElement('canvas');const rw=Math.floor(W*b.width/100);
      const ox=Math.floor((W-rw)/2);cvs.width=W;cvs.height=40;
      const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,40);
      ctx.strokeStyle='#000';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(ox,8);ctx.lineTo(ox+rw,8);ctx.stroke();
      for(let i=0;i<=b.ticks;i++){
        const x=ox+Math.round(i*rw/b.ticks);
        const bigTick=i%5===0||b.ticks<=5;
        const th=bigTick?16:10;
        ctx.beginPath();ctx.moveTo(x,8);ctx.lineTo(x,8+th);ctx.stroke();
        if(bigTick){ctx.font='9px monospace';ctx.textAlign='center';ctx.fillStyle='#000';ctx.fillText(`${i}${b.unit}`,x,36)}
      }
      return cvs;
    }
    case 'datetime':{
      const now=new Date();let str;
      if(b.format==='full')str=now.toLocaleString('en-US');
      else if(b.format==='date')str=now.toLocaleDateString('en-US');
      else str=now.toLocaleTimeString('en-US');
      return renderText(str,b.size,b.align,'monospace','normal',W);
    }
    case 'separator':{
      const cvs=document.createElement('canvas');cvs.width=W;cvs.height=b.padding*2+b.thickness+2;
      const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,cvs.height);
      ctx.strokeStyle='#000';ctx.lineWidth=b.thickness;const y=cvs.height/2;
      if(b.style==='solid'){ctx.beginPath();ctx.moveTo(4,y);ctx.lineTo(W-4,y);ctx.stroke()}
      else if(b.style==='dashed'){ctx.setLineDash([10,6]);ctx.beginPath();ctx.moveTo(4,y);ctx.lineTo(W-4,y);ctx.stroke();ctx.setLineDash([])}
      else if(b.style==='dotted'){ctx.setLineDash([2,6]);ctx.beginPath();ctx.moveTo(4,y);ctx.lineTo(W-4,y);ctx.stroke();ctx.setLineDash([])}
      else if(b.style==='double'){const d=b.thickness+3;ctx.lineWidth=Math.max(1,b.thickness/2);ctx.beginPath();ctx.moveTo(4,y-d/2);ctx.lineTo(W-4,y-d/2);ctx.stroke();ctx.beginPath();ctx.moveTo(4,y+d/2);ctx.lineTo(W-4,y+d/2);ctx.stroke()}
      else if(b.style==='wave'){ctx.beginPath();ctx.moveTo(0,y);for(let x=0;x<W;x+=8)ctx.quadraticCurveTo(x+4,y+(x%16<8?-4*b.thickness:4*b.thickness),x+8,y);ctx.stroke()}
      return cvs;
    }
    case 'spacer':{
      const cvs=document.createElement('canvas');cvs.width=W;cvs.height=b.height;
      const ctx=cvs.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,b.height);return cvs;
    }
  }
  return null;
}

async function composeAll(){
  const W=PW();const canvases=[];
  for(const b of blocks){const c=await renderBlock(b);if(c)canvases.push(c)}
  if(!canvases.length){
    const empty=document.createElement('canvas');empty.width=W;empty.height=80;
    const ctx=empty.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,80);
    ctx.fillStyle='#ccc';ctx.font='12px monospace';ctx.textAlign='center';ctx.fillText('Empty — add blocks',W/2,44);
    return empty;
  }
  const H=canvases.reduce((s,c)=>s+c.height,0);
  const final=document.createElement('canvas');final.width=W;final.height=H;
  const ctx=final.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  let y=0;for(const c of canvases){ctx.drawImage(c,0,y);y+=c.height}
  return final;
}

let _prevTimer=null;
function schedulePreview(){clearTimeout(_prevTimer);_prevTimer=setTimeout(refreshPreview,350)}
async function refreshPreview(){
  const cvs=await composeAll();
  const prev=document.getElementById('preview-canvas');
  prev.width=cvs.width;prev.height=cvs.height;
  prev.getContext('2d').drawImage(cvs,0,0);
}

// ════════════════════════════════════════════
//  PRINT / SIMULATION
// ════════════════════════════════════════════

// Convert canvas to 1-bit bitmap lines (array of Uint8Array)
function canvasToBitmap(cvs){
  const ctx=cvs.getContext('2d');const W=cvs.width,H=cvs.height;
  const img=ctx.getImageData(0,0,W,H);const lines=[];
  const bpr=Math.ceil(W/8);
  for(let y=0;y<H;y++){
    const row=new Uint8Array(bpr);
    for(let x=0;x<W;x++){const v=0.299*img.data[(y*W+x)*4]+0.587*img.data[(y*W+x)*4+1]+0.114*img.data[(y*W+x)*4+2];if(v<128)row[Math.floor(x/8)]|=(0x80>>(x%8))}
    lines.push(row);
  }
  return lines;
}

// ── Simulation state ────────────────────────
let _simRaf=null;

function simSetProgress(frac){
  const pct=Math.round(frac*100);
  document.getElementById('sim-prog-fill').style.width=pct+'%';
  document.getElementById('sim-prog-pct').textContent=pct+'%';
}

/*
  How the paper feed works (correct thermal printer direction):

  - The canvas has row 0 at top (first printed line) and row N at bottom.
  - The roller is at the BOTTOM of the printer shell.
  - Paper emerges UPWARD through the viewing window.
  - We anchor .sim-paper-strip to bottom:0 of the window.
  - translateY(+100%) = fully below (hidden inside machine, at roller level).
  - translateY(0%)    = paper fully risen: its bottom edge is at window bottom,
                        first printed line (top of canvas) is at window top.
  - So we animate translateY from +100% → 0% over the print duration.
  - The canvas content is drawn normally (line 0 = top), so as the paper rises
    the TOP of the image (first block) appears first at the top of the window,
    and subsequent content scrolls upward into view — exactly like a real printer.
  - Feed-out: translateY continues negative (paper exits upward past the top).
  - The torn/perforated mask is applied to the BOTTOM edge of the strip
    (where it would be cut/torn off the roll).
*/
function simStartFeed(composed, totalLines, durationMs){
  const SIM_W = 200;
  const SIM_H = Math.round(totalLines * (SIM_W / PW()));

  // Draw full output onto sim-canvas
  const simC = document.getElementById('sim-canvas');
  simC.width  = SIM_W;
  simC.height = SIM_H;
  const sctx = simC.getContext('2d');
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, SIM_W, SIM_H);
  sctx.drawImage(composed, 0, 0, SIM_W, SIM_H);

  const strip = document.getElementById('sim-paper-strip');
  strip.classList.remove('feed-out');
  // Reset: paper fully hidden below (inside the machine)
  strip.style.transform = 'translateX(-50%) translateY(100%)';

  const startTime = performance.now();

  function tick(now){
    const elapsed = now - startTime;
    const frac    = Math.min(elapsed / durationMs, 1);
    // Linear: 100% → 0%  (paper rises from roller up through window)
    const ty = 100 - frac * 100;
    strip.style.transform = `translateX(-50%) translateY(${ty}%)`;
    if(frac < 1){
      _simRaf = requestAnimationFrame(tick);
    }
  }
  _simRaf = requestAnimationFrame(tick);
}

function simStopFeed(){
  if(_simRaf){ cancelAnimationFrame(_simRaf); _simRaf = null; }
  document.getElementById('sim-roller').classList.remove('spinning');
  document.getElementById('sim-led').className = 'sim-led done';
}

function simFeedOut(){
  // Read current translateY from inline style so animation starts from there
  const strip = document.getElementById('sim-paper-strip');
  const m = strip.style.transform.match(/translateY\(([^)]+)\)/);
  const curY = m ? m[1] : '0%';
  // Use CSS custom property so the @keyframes can pick it up
  strip.style.setProperty('--strip-y', curY);
  strip.classList.add('feed-out');
}

async function printAll(){
  if(!blocks.length){toast('Add at least one block first','err');return}
  const dry=document.getElementById('p-dryrun').value==='1';
  if(!prn&&!dry){toast('⚠ Connect a printer first (or enable Dry Run)','err');return}

  const composed=await composeAll();
  const lines=canvasToBitmap(composed);
  const H=lines.length;
  const spd=parseInt(document.getElementById('p-speed').value);
  const nrg=parseInt(document.getElementById('p-energy').value);
  const feed=parseInt(document.getElementById('p-feed').value);

  let p=prn;
  if(!p||dry){p=new CatPrinter('GB03',async()=>{},true)}
  p.dry=dry; p.bytesSent=0;

  setProg(0,'Preparing…'); showProg(true);

  if(dry){
    // Reset sim UI
    const strip=document.getElementById('sim-paper-strip');
    strip.classList.remove('feed-out');
    strip.style.transform='translateX(-50%) translateY(100%)';
    strip.style.removeProperty('--strip-y');
    document.getElementById('sim-stats').textContent='';
    document.getElementById('sim-prog-fill').style.width='0%';
    document.getElementById('sim-prog-pct').textContent='0%';
    const closeBtn=document.getElementById('sim-close-btn');
    closeBtn.disabled=true; closeBtn.textContent='Printing…';
    document.getElementById('sim-led').className='sim-led active';
    document.getElementById('sim-overlay').classList.add('on');

    // Speed → lines per second (speed 1=slow/dense, 8=fast/light)
    // At speed 5 we target ~3s per 100 lines; scale accordingly
    const linesPerSec = 20 + spd * 14;  // speed 1→34 l/s, speed 8→132 l/s
    const feedDurationMs = (H / linesPerSec) * 1000;
    const cappedDuration = Math.min(Math.max(feedDurationMs, 800), 8000);

    // Start visual feed animation (async, runs in background via rAF)
    simStartFeed(composed, H, cappedDuration);
    // Start roller spinning
    document.getElementById('sim-roller').classList.add('spinning');
  }

  try{
    await p.prepare(spd,nrg);

    for(let y=0;y<H;y++){
      await p.draw(lines[y]);
      if(y%8===0){
        const frac=y/H;
        setProg(frac,`Line ${y}/${H}`);
        if(dry) simSetProgress(frac);
      }
    }

    await p.finish(feed);
    setProg(1,'Done! ✓');
    setTimeout(()=>showProg(false),3000);

    if(dry){
      simSetProgress(1);
      simStopFeed();
      // Brief pause, then feed-out animation
      setTimeout(()=>{
        simFeedOut();
        document.getElementById('sim-stats').textContent=
          `${H} lines · ${p.bytesSent.toLocaleString()} bytes · E:${nrg} S:${spd}`;
        const closeBtn=document.getElementById('sim-close-btn');
        closeBtn.disabled=false; closeBtn.textContent='Close';
      },400);
    } else {
      toast('Print complete ✓','ok');
    }

  }catch(e){
    simStopFeed();
    showProg(false);
    if(dry){
      document.getElementById('sim-overlay').classList.remove('on');
    }
    toast('Error: '+e.message,'err');
  }
}

function closeSim(){
  if(_simRaf){cancelAnimationFrame(_simRaf);_simRaf=null;}
  document.getElementById('sim-overlay').classList.remove('on');
  document.getElementById('sim-roller').classList.remove('spinning');
  document.getElementById('sim-led').className='sim-led';
  toast('Simulation complete ✓','ok');
}

function showProg(v){document.getElementById('prog-bar').classList.toggle('on',v)}
function setProg(f,t){document.getElementById('prog-fill').style.width=(f*100)+'%';document.getElementById('prog-txt').textContent=t}

// ════════════════════════════════════════════
//  UI HELPERS
// ════════════════════════════════════════════
function openDrawer(){document.getElementById('drawer-bg').classList.add('on')}
function closeDrawer(){document.getElementById('drawer-bg').classList.remove('on')}

function downloadPreview(){
  const cvs=document.getElementById('preview-canvas');
  const a=document.createElement('a');a.href=cvs.toDataURL('image/png');
  a.download='meow-print.png';a.click();
}

function toggleTheme(){
  const html=document.documentElement;
  const dark=html.getAttribute('data-theme')==='dark';
  html.setAttribute('data-theme',dark?'light':'dark');
  document.getElementById('theme-btn').textContent=dark?'🌙':'☀';
}

function showMobileTab(tab,btn){
  document.querySelectorAll('.mobile-tabs button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  if(tab==='blocks'){
    document.getElementById('composer').classList.add('mob-visible');
    document.getElementById('preview-col').classList.remove('mob-visible');
  } else {
    document.getElementById('composer').classList.remove('mob-visible');
    document.getElementById('preview-col').classList.add('mob-visible');
    refreshPreview();
  }
}

let _toast;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className='on'+(type?' '+type:'');
  clearTimeout(_toast);_toast=setTimeout(()=>el.className='',3400);
}

// ─── INIT ─────────────────────────────────
renderBlockList();
refreshPreview();
// Set initial theme icon
document.getElementById('theme-btn').textContent='☀';