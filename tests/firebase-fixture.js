// Only loaded by the isolated preview server, never by the deployed index.html.
(() => {
  const records=new Map([
    ['sketchBoards/typing-test',{name:'Typing & paste sandbox',orderIndex:1,backgroundPattern:'BLANK'}],
    ['sketchBoards/typing-test/elements/1',{elementJson:JSON.stringify({id:1,kind:'textbox',x:40,y:40,w:600,h:150,fontSize:20,fontFamily:'Arial',text:'Editing playground\nSelect text, then try Copy and Paste.\nfunction hello() { return "world"; }'})}],
    ['sketchBoards/typing-test/elements/2',{elementJson:JSON.stringify({id:2,kind:'table',x:40,y:240,w:500,h:100,rows:2,cols:2,cellText:{'0,0':'First','0,1':'Second','1,0':'Third','1,1':'Fourth'}})}],
    ['sketchBoards/typing-test/content/elements',{nextElementId:3}]
  ]);
  // A wide mixed-media page reproduces click-to-type re-centering around images.
  // Synthetic local artwork only; no imported notebook content or remote requests.
  const diagram = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="820" height="300"><rect width="820" height="300" fill="#f0f5ff"/><text x="30" y="40" font-size="24" fill="#20356a">Stationary diagram — clicks must not move it</text><path d="M120 230V90M120 170L320 110H650" fill="none" stroke="#6558e8" stroke-width="6"/><g fill="#559ef5" stroke="#20356a" stroke-width="3"><circle cx="120" cy="230" r="20"/><circle cx="120" cy="170" r="20"/><circle cx="120" cy="90" r="20"/><circle cx="320" cy="110" r="20"/><circle cx="650" cy="110" r="20"/></g></svg>');
  const diagramBytes = new TextEncoder().encode(decodeURIComponent(diagram.split(',')[1]));
  records.set('sketchMedia/local-diagram', {byteLength:diagramBytes.length,mimeType:'image/svg+xml'});
  records.set('sketchMedia/local-diagram/chunks/0', {chunkIndex:0,chunkData:{toUint8Array:()=>diagramBytes}});
  records.set('sketchBoards/wide-test', {name:'Wide image click test',orderIndex:2,backgroundPattern:'BLANK'});
  for (const item of [
    {id:1,kind:'textbox',x:600,y:40,w:820,h:70,fontSize:20,fontFamily:'Arial',text:'• Each circle is one commit.\n• Click in different blank places without moving the content.'},
    {id:2,kind:'image',x:600,y:150,w:820,h:300,uriString:diagram,mimeType:'image/svg+xml',mediaName:'Synthetic diagram'},
    {id:3,kind:'textbox',x:600,y:480,w:820,h:120,fontSize:20,fontFamily:'Arial',text:'• Merge without squash\n• Squash merge\n• Rebase + fast-forward'},
    {id:4,kind:'image',x:600,y:640,w:820,h:300,uriString:diagram,mimeType:'image/svg+xml',mediaName:'Second synthetic diagram'}
  ]) records.set('sketchBoards/wide-test/elements/'+item.id,{elementJson:JSON.stringify(item.kind==='image'?{...item,uriString:'firestore-media://local-diagram'}:item)});
  records.set('sketchBoards/wide-test/content/elements',{nextElementId:5});
  for (const record of records.values()) if(record.elementJson) record.elementJson=JSON.stringify({colorArgb:0xFF1B1F1C,...JSON.parse(record.elementJson)});
  const listeners=new Set();
  const snap=path=>({id:path.split('/').at(-1),exists:records.has(path),data:()=>records.get(path)||{},get:key=>records.get(path)?.[key]});
  const emit=()=>queueMicrotask(()=>listeners.forEach(fn=>fn()));
  class Ref {
    constructor(path,isDoc=false){this.path=path;this.isDoc=isDoc;this.id=path.split('/').at(-1);}
    collection(name){return new Ref(this.path+'/'+name);}
    doc(id){return new Ref(this.path+'/'+id,true);}
    orderBy(){return this;} where(){return this;} limit(){return this;}
    snapshot(){if(this.isDoc)return snap(this.path);const docs=[...records.keys()].filter(p=>p.startsWith(this.path+'/')&&p.split('/').length===this.path.split('/').length+1).map(p=>({...snap(p),ref:new Ref(p,true)}));return {docs,empty:!docs.length,size:docs.length,forEach:fn=>docs.forEach(fn)};}
    get(){return Promise.resolve(this.snapshot());}
    onSnapshot(fn){const run=()=>fn(this.snapshot());listeners.add(run);queueMicrotask(run);return()=>listeners.delete(run);}
    set(value,options){records.set(this.path,options?.merge?{...records.get(this.path),...value}:value);emit();return Promise.resolve();}
    update(value){return this.set(value,{merge:true});}
    delete(){records.delete(this.path);emit();return Promise.resolve();}
  }
  const batch=()=>({set(ref,value,options){ref.set(value,options);return this;},update(ref,value){ref.update(value);return this;},delete(ref){ref.delete();return this;},commit:async()=>{}});
  const db={collection:name=>new Ref(name),batch,runTransaction:async fn=>fn({...batch(),get:ref=>ref.get()})};
  const app={firestore:()=>db};
  window.taskflowFirebaseConfig={projectId:'isolated-preview'};
  window.firebase={apps:[app],app:()=>app,firestore:{FieldValue:{serverTimestamp:()=>Date.now()}}};
})();
