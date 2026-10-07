/* Flowing document view over the existing notebook records. Opening it never writes data. */
(() => {
  const kind = item => item._kind || item.kind || '';
  const rank = item => Number.isFinite(item.documentOrder) ? item.documentOrder : (Number(item.y) || 0) * 1024 + (Number(item.x) || 0) / 1000000 + (Number(item.id) || 0) / 1000000000;
  const ordered = items => [...items].sort((a,b) => rank(a)-rank(b) || a.id-b.id);
  const adjacentOrder = (before, after) => before && after ? (rank(before)+rank(after))/2 : before ? rank(before)+1024 : after ? rank(after)-1024 : 0;
  function create({ host, save, media, readText, writeText, status, openCanvas }) {
    let boardId = null, items = [], nextId = -1000000, timer, saving = null, selectedImage = null, deferredSync=null;
    const dirty = new Map(), nodes = new Map();
    const sheet = document.createElement('article'); sheet.className = 'document-sheet'; sheet.hidden=true; sheet.setAttribute('aria-label','Notebook document');
    const blocks = document.createElement('div'); blocks.className = 'document-blocks';
    const end = button('Write at end', () => insertAt(items.length)); end.className = 'document-insert document-end';
    const retry = button('Retry saving', () => flush()); retry.hidden = true; retry.className = 'document-retry';
    sheet.append(blocks,end,retry); host.append(sheet);
    function button(label, action) {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
      node.addEventListener('click',action); return node;
    }
    function itemFor(node) { return items.find(item => String(item.id) === node.closest('[data-document-id]')?.dataset.documentId); }
    function changed(item) {
      dirty.set(item.id, (dirty.get(item.id)||0)+1);
      status('Saving…'); clearTimeout(timer); timer = setTimeout(flush,700);
    }
    async function flush() {
      clearTimeout(timer);
      if (saving) { await saving; if (retry.hidden && dirty.size) return flush(); return !dirty.size; }
      if (!dirty.size || !boardId) return true;
      const changes = items.filter(item => dirty.has(item.id)).map(item => JSON.parse(JSON.stringify(item)));
      const versions = new Map(dirty);
      retry.hidden = true;
      saving = (async () => {
        try {
          const saved = await save(boardId,changes);
          for (const { previousId, item } of saved) {
            const current = items.find(entry => entry.id === previousId);
            if (!current) continue;
            if (dirty.get(previousId) === versions.get(previousId)) dirty.delete(previousId);
            else { const version=dirty.get(previousId); dirty.delete(previousId); dirty.set(item.id,version); }
            current.id = item.id;
            const node=nodes.get(previousId);
            if(node){nodes.delete(previousId);nodes.set(item.id,node);node.dataset.documentId=String(item.id);}
          }
          status(dirty.size ? 'Saving…' : 'Saved');
        } catch(error) { retry.hidden=false; status(`Save failed: ${error.message}`); }
      })();
      await saving; saving=null;
      if(deferredSync){const deferred=deferredSync;deferredSync=null;sync(...deferred);}
      if (retry.hidden && dirty.size) return flush();
      return !dirty.size;
    }
    function sync(id, incoming) {
      sheet.hidden=!id;
      if (boardId !== id) {
        boardId=id; items=[]; nodes.clear(); dirty.clear(); blocks.replaceChildren(); selectedImage=null;
      }
      // Preserve local drafts and selection while Firestore echoes a save.
      if (saving) {deferredSync=[id,incoming];return;}
      const local = new Map(items.map(item=>[item.id,item]));
      items = ordered(incoming.map(item => dirty.has(item.id) ? local.get(item.id) : {...item}));
      for(const item of local.values()) if((item.id<0 || dirty.has(item.id)) && !items.some(entry=>entry.id===item.id)) items.push(item);
      items=ordered(items); render();
    }
    function focusText(node, atEnd=false) {
      node.focus({preventScroll:true}); const range=document.createRange();range.selectNodeContents(node);range.collapse(!atEnd);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      node.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    function insertAt(index) {
      const before=items[index-1],after=items[index];
      const item={id:nextId--,_kind:'textbox',kind:'textbox',type:'com.impactyn.taskmanager.data.entities.SketchElement.TextBox',text:'',fontRuns:[],fontFamily:'Arial',fontSize:20,colorArgb:0xFF1B1F1C,borderWidth:0,x:Number(after?.x??before?.x)||0,y:Number(after?.y??before?.y)||0,w:820,h:32,documentOrder:adjacentOrder(before,after)};
      items.splice(index,0,item);render();focusText(nodes.get(item.id).querySelector('.document-text'));
      return item;
    }
    function adjacentText(item, after) {
      const index=items.findIndex(entry=>entry.id===item.id),neighbor=items[index+(after?1:-1)];
      if(kind(neighbor||{})==='textbox') return focusText(nodes.get(neighbor.id).querySelector('.document-text'),!after);
      return insertAt(index+(after?1:0));
    }
    function build(item) {
      const block=document.createElement('section');block.className='document-block';block.dataset.documentId=String(item.id);
      if(kind(item)==='textbox') {
        const text=document.createElement('div'); text.className='document-text';text.contentEditable='true';text.setAttribute('role','textbox');text.setAttribute('aria-multiline','true');text.setAttribute('aria-label','Document paragraph');text.dataset.placeholder='Write here…';text.dir='auto';
        writeText(text,item.text||'',item.fontRuns||[]);text.style.fontFamily=item.fontFamily||'Arial';text.style.fontSize=`${Math.max(12,Math.min(48,Number(item.fontSize)||20))}px`;
        text.addEventListener('input',()=>{const current=itemFor(text);Object.assign(current,readText(text));current.h=Math.max(32,text.scrollHeight);changed(current);});
        text.addEventListener('paste',event=>paste(event,text));
        block.append(text);
      } else if(kind(item)==='image') {
        block.classList.add('document-image-block');
        const before=button('Write before image',()=>adjacentText(itemFor(block),false));before.className='document-insert';
        const figure=document.createElement('figure');figure.className='document-figure';figure.tabIndex=0;figure.setAttribute('aria-label',item.mediaName||'Image');
        const asset=document.createElement('div');asset.className='document-asset';
        const controls=document.createElement('div');controls.className='document-image-controls';controls.setAttribute('role','toolbar');controls.setAttribute('aria-label','Image alignment');
        for(const [value,label] of [['left','Align left'],['center','Align center'],['right','Align right']]){
          const control=button(label,()=>{const current=itemFor(block);current.documentAlign=value;align(block,current);changed(current);});control.dataset.align=value;controls.append(control);
        }
        figure.append(asset,controls);figure.addEventListener('click',()=>selectImage(block));figure.addEventListener('focus',()=>selectImage(block));
        const after=button('Write after image',()=>adjacentText(itemFor(block),true));after.className='document-insert';
        block.append(before,figure,after);align(block,item);
      } else if(kind(item)==='table') {
        const table=document.createElement('table');table.className='document-table';
        for(let row=0;row<Math.min(500,item.rows||1);row++){
          const tr=table.insertRow();
          for(let col=0;col<Math.min(100,item.cols||1);col++){
            const cell=tr.insertCell();cell.contentEditable='true';cell.className='document-cell';cell.dataset.cell=`${row},${col}`;cell.setAttribute('aria-label',`Row ${row+1}, column ${col+1}`);cell.textContent=item.cellText?.[cell.dataset.cell]||'';
            cell.style.backgroundColor=item.cellBackgroundColors?.[cell.dataset.cell]||'';
            cell.addEventListener('input',()=>{const current=itemFor(cell);current.cellText={...current.cellText,[cell.dataset.cell]:cell.innerText};changed(current);});
            cell.addEventListener('paste',event=>paste(event,cell));
          }
        }
        block.append(table);
      } else {
        block.classList.add('document-drawing');
        const label=document.createElement('span');label.textContent=`${kind(item)||'Drawing'} · preserved in canvas view`;
        block.append(label,button('Open canvas',openCanvas));
      }
      return block;
    }
    function selectImage(block) {selectedImage?.classList.remove('selected');selectedImage=block;block.classList.add('selected');}
    function align(block,item) {
      const asset=block.querySelector('.document-asset');asset.style.width=`${Math.max(80,Number(item.w)||640)}px`;
      asset.style.marginInlineStart=item.documentAlign==='right'||item.documentAlign==='center'?'auto':'0';
      asset.style.marginInlineEnd=item.documentAlign==='center'?'auto':'0';
      block.querySelectorAll('[data-align]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.align===(item.documentAlign||'left'))));
    }
    function refreshMedia() {
      for(const item of items.filter(item=>kind(item)==='image')) {
        const asset=nodes.get(item.id)?.querySelector('.document-asset');if(!asset)continue;
        const loaded=media(item);
        if(loaded?.src && asset.dataset.source!==loaded.src){
          asset.dataset.source=loaded.src;
          const node=document.createElement(loaded.tag==='video'?'video':loaded.tag==='link'?'a':'img');
          if(node.tagName==='A'){node.href=loaded.src;node.textContent=item.mediaName||'Open attachment';node.target='_blank';node.rel='noopener noreferrer';}
          else {node.src=loaded.src;node.alt=item.mediaName||'Notebook image';if(node.tagName==='VIDEO')node.controls=true;}
          asset.replaceChildren(node);
        } else if(!loaded?.src&&!asset.dataset.source) asset.textContent=loaded?.failed?'Image unavailable':'Loading image…';
      }
    }
    function render() {
      const ids=new Set(items.map(item=>item.id));
      for(const [id,node] of nodes)if(!ids.has(id)){node.remove();nodes.delete(id);}
      let cursor=blocks.firstChild;
      for(const item of items){
        let node=nodes.get(item.id);
        if(!node){node=build(item);nodes.set(item.id,node);}
        else if(!dirty.has(item.id)&&!node.contains(document.activeElement)){
          const text=node.querySelector('.document-text');
          if(text&&JSON.stringify(readText(text))!==JSON.stringify({text:item.text||'',fontRuns:item.fontRuns||[]}))writeText(text,item.text||'',item.fontRuns||[]);
          if(kind(item)==='image')align(node,item);
          node.querySelectorAll('.document-cell').forEach(cell=>{cell.textContent=item.cellText?.[cell.dataset.cell]||'';});
        }
        if(node!==cursor)blocks.insertBefore(node,cursor);cursor=node.nextSibling;
      }
      refreshMedia();
    }
    function paste(event,text) {
      event.preventDefault();event.stopPropagation();
      // Plain text retains indentation and native undo. Media insertion is offered separately.
      if(/<(?:img|table)\b/i.test(event.clipboardData?.getData('text/html')||'') || [...(event.clipboardData?.files||[])].some(file=>file.type.startsWith('image/'))){status('Paste images and tables in Canvas, then return to Document. Nothing was pasted.');return;}
      const value=event.clipboardData?.getData('text/plain')||'';
      if(value)window.TaskflowTextUX.insertPlainText(text,value);
      else status('For images, use Canvas → Paste; they also appear in this document.');
    }
    function pasteText(value) {
      const selection=window.TaskflowTextUX.captureSelection();
      if(selection&&host.contains(selection.node))return window.TaskflowTextUX.insertPlainText(selection.node,value,selection);
      const item=insertAt(items.length);return window.TaskflowTextUX.insertPlainText(nodes.get(item.id).querySelector('.document-text'),value);
    }
    host.addEventListener('pointerdown',event=>{if(!event.target.closest('.document-image-block')){selectedImage?.classList.remove('selected');selectedImage=null;}});
    window.addEventListener('beforeunload',event=>{if(dirty.size||saving){event.preventDefault();event.returnValue='';}});
    return {sync,flush,refreshMedia,pasteText,hasPending:()=>Boolean(dirty.size||saving),focusEnd:()=>boardId&&insertAt(items.length)};
  }
  window.TaskflowDocument={create,ordered,adjacentOrder};
})();
