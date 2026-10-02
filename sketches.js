(() => {
  const $ = (s) => document.querySelector(s);
  const status = (message, connected = false) => {
    $('#sync-label').textContent = message;
    $('#sync-dot').classList.toggle('online', connected);
  };
  const notice = (message) => {
    const box = $('#firebase-warning');
    box.textContent = message;
    box.hidden = !message;
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);

  if (!window.firebase || !window.taskflowFirebaseConfig) {
    status('Firebase configuration missing');
    notice('Firebase could not start. Check firebase-config.js and make sure the Firebase scripts loaded over HTTPS.');
    $('#board-tree').innerHTML = '<div class="board-placeholder">Could not connect to Firebase.</div>';
    return;
  }

  const app = firebase.apps.length
    ? firebase.app()
    : firebase.initializeApp(window.taskflowFirebaseConfig);
  const db = app.firestore();
  const supabaseUrl = 'https://dhipmsdnskhxwlnpfwnq.supabase.co';
  const boardsRef = db.collection('sketchBoards');
  const boardTree = $('#board-tree');
  const canvas = $('#board-canvas');
  const ctx = canvas.getContext('2d');
  const loadedImages = new Map();
  const pendingImagePreviews = new Set();
  let boards = [];
  let selectedBoard = null;
  let elements = [];
  let boardListener = null;
  let contentListener = null;
  let loadingLegacy = false;
  let drawing = false;
  let erase = false;
  let activeTool = 'SELECT';
  let activeColor = 0xFF1B1F1C;
  let zoomFactor = 1;
  let clipboardElements = [];
  let clipboardPlain = '';
  let shapeStart = null;
  let shapePreview = null;
  let selection = new Set();
  let moveStart = null;
  let moveSnapshot = null;
  let lassoStart = null;
  let lassoRect = null;
  let connectorStartId = null;
  const undoStack = [];
  const redoStack = [];
  let currentStroke = null;
  let pageBodyEditor = null;
  let pageBodySaveTimer = null;
  let textElementEditor = null;
  let textElementSaveTimer = null;
  let nextProvisionalTextId = -1;
  let tableEditor = null;
  let tableSaveTimer = null;
  let lastCanvasPoint = null;
  let draggedBoardId = null;
  let collapsedBoardIds = new Set();
  let imageLayout = { scale: 1, x: 0, y: 0, bounds: { minX: 0, minY: 0 } };
  let lastSaveError = '';

  try { collapsedBoardIds = new Set(JSON.parse(localStorage.getItem('taskflow-sketch-collapsed-pages') || '[]')); } catch { collapsedBoardIds = new Set(); }

  function labelForType(el) {
    const raw = String(el.type || el.kind || '').split('.').pop().toLowerCase();
    const map = { stroke: 'stroke', shape: 'shape', textbox: 'textbox', textBox: 'textbox',
      image: 'image', table: 'table', connector: 'connector', treenode: 'treenode',
      curve: 'curve', curveshape: 'curveshape' };
    return map[raw] || raw;
  }

  function mediaMime(el) {
    const explicit = String(el.mimeType || '').toLowerCase();
    if (explicit && explicit !== 'application/octet-stream') return explicit;
    const name = String(el.mediaName || el.uriString || '').split(/[?#]/)[0].toLowerCase();
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.svg')) return 'image/svg+xml';
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
    if (name.endsWith('.mp4')) return 'video/mp4';
    if (name.endsWith('.webm')) return 'video/webm';
    return explicit || 'application/octet-stream';
  }

  function parseElement(raw) {
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return null; }
    }
    if (!raw || typeof raw !== 'object') return null;
    const kind = labelForType(raw);
    if (!kind) return null;
    return { ...raw, _kind: kind, id: Number(raw.id) || 0 };
  }

  function color(value, fallback = '#292a33', adaptInkForDarkMode = true) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const hex = (number >>> 0).toString(16).padStart(8, '0');
    const alpha = parseInt(hex.slice(0, 2), 16) / 255;
    let red = parseInt(hex.slice(2, 4), 16), green = parseInt(hex.slice(4, 6), 16), blue = parseInt(hex.slice(6, 8), 16);
    if (adaptInkForDarkMode && document.documentElement.dataset.theme === 'dark' && red < 48 && green < 48 && blue < 48) red = green = blue = 245;
    return `rgba(${red},${green},${blue},${alpha})`;
  }

  function elementBounds(el) {
    const points = el.points || [];
    if (points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const point of points) {
        const x = Number(point.x) || 0, y = Number(point.y) || 0;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }
    if (el._kind === 'curveshape' && el.start && el.end) {
      return { x: Math.min(el.start.x, el.end.x), y: Math.min(el.start.y, el.end.y), w: Math.max(1, Math.abs(el.end.x - el.start.x)), h: Math.max(1, Math.abs(el.end.y - el.start.y)) };
    }
    return { x: Number(el.x) || 0, y: Number(el.y) || 0, w: Math.max(1, Number(el.w) || 1), h: Math.max(1, Number(el.h) || 1) };
  }

  function boundsFor(list) {
    if (!list.length) return { minX: 0, minY: 0, maxX: 900, maxY: 560 };
    const boxes = list.map(elementBounds);
    const pad = 36;
    let minX = 0, minY = 0, maxX = 700, maxY = 430;
    for (const box of boxes) {
      minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
    }
    return {
      minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad
    };
  }

  function requestImage(el) {
    const source = String(el.uriString || el.imageUrl || '');
    if (!source) return;
    if (/^https?:\/\//i.test(source)) {
      if (loadedImages.has(source)) return;
      loadedImages.set(source, 'loading');
      loadExternalMedia(source, el);
      return;
    }
    if (source.startsWith('supabase-media://')) {
      if (loadedImages.has(source)) return;
      loadedImages.set(source, 'loading');
      loadExternalMedia(source, el);
      return;
    }
    const key = source.startsWith('firestore-media://') ? source.slice('firestore-media://'.length) : '';
    if (!key || loadedImages.has(key)) return;
    loadedImages.set(key, 'loading');
    (async () => {
      try {
        const metadata = await db.collection('sketchMedia').doc(key).get();
        const byteLength = Number(metadata.get('byteLength'));
        if (!metadata.exists || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 32 * 1024 * 1024) throw new Error('Image is missing or too large.');
        const snap = await db.collection('sketchMedia').doc(key).collection('chunks').orderBy('chunkIndex').get();
        const bytes = new Uint8Array(byteLength);
        let cursor = 0;
        snap.forEach((document) => {
          const blob = document.get('chunkData');
          if (!blob?.toUint8Array) return;
          const chunk = blob.toUint8Array();
          if (cursor + chunk.length > bytes.length) return;
          bytes.set(chunk, cursor);
          cursor += chunk.length;
        });
        if (cursor !== byteLength) throw new Error('Image data is incomplete.');
        const type = metadata.get('mimeType') || mediaMime(el);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
        const video = String(type).startsWith('video/');
        const media = video ? document.createElement('video') : new Image();
        if (video) { media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
        media.addEventListener(video ? 'loadedmetadata' : 'load', () => { media.dataset.objectUrl = objectUrl; loadedImages.set(key, media); renderCanvas(); }, { once: true });
        media.addEventListener('error', () => { URL.revokeObjectURL(objectUrl); loadedImages.set(key, null); renderCanvas(); }, { once: true });
        media.src = objectUrl;
      } catch (error) {
        console.warn('Could not load sketch image', key, error);
        loadedImages.set(key, null);
        renderCanvas();
      }
    })();
  }

  async function loadExternalMedia(source, el) {
    try {
      let url = source;
      if (source.startsWith('supabase-media://')) {
        const objectPath = source.slice('supabase-media://'.length).split('/').map((part) => {
          try { return decodeURIComponent(part.replace(/\+/g, '%2B')); } catch { return part; }
        }).join('/');
        const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
        url = `${supabaseUrl}/storage/v1/object/public/sketch-media/${encodedPath}`;
      }
      const mime = mediaMime(el);
      if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
        loadedImages.set(source, { kind: 'document', src: url });
        renderCanvas();
        return;
      }
      const video = mime.startsWith('video/') || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(url);
      const media = video ? document.createElement('video') : new Image();
      if (video) { media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
      media.addEventListener(video ? 'loadedmetadata' : 'load', () => { loadedImages.set(source, media); renderCanvas(); }, { once: true });
      media.addEventListener('error', () => { loadedImages.set(source, null); renderCanvas(); }, { once: true });
      media.src = url;
    } catch (error) {
      console.warn('Could not load external sketch media', source, error);
      loadedImages.set(source, null); renderCanvas();
      if (source.startsWith('supabase-media://')) {
        $('#media-auth-actions').hidden = false;
        $('#media-auth-state').textContent = `Media could not load: ${error.message}`;
        $('#media-sign-in').hidden = true;
      }
    }
  }

  function drawElement(el, imagesOnly = false) {
    const kind = el._kind;
    if (el.isPageBody && pageBodyEditor?.boardId === selectedBoard?.id && pageBodyEditor.node.isConnected) return;
    if (textElementEditor?.boardId === selectedBoard?.id && textElementEditor.item.id === el.id && textElementEditor.node.isConnected) return;
    const ink = color(el.colorArgb);
    const width = Math.max(1, Number(el.strokeWidth) || 2);
    ctx.strokeStyle = ink;
    ctx.fillStyle = color(el.backgroundColorArgb, 'transparent', false);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'image') {
      const src = String(el.uriString || el.imageUrl || '');
      const key = src.startsWith('firestore-media://') ? src.slice('firestore-media://'.length) : src;
      const image = loadedImages.get(key);
      if (image?.kind === 'document') {
        ctx.fillStyle = '#f0efff'; ctx.fillRect(el.x, el.y, el.w, el.h);
        ctx.fillStyle = '#6558e8'; ctx.font = '14px sans-serif';
        ctx.fillText(el.mediaName || 'Open attached file', el.x + 8, el.y + 24, Math.max(40, el.w - 16));
      } else if (image && image !== 'loading' && (!(image instanceof HTMLVideoElement) || image.readyState >= 2)) {
        ctx.drawImage(image, el.x, el.y, el.w, el.h);
      } else {
        if (image === undefined) requestImage(el);
        ctx.fillStyle = '#f0efff'; ctx.fillRect(el.x, el.y, el.w, el.h);
        ctx.fillStyle = '#6558e8'; ctx.font = '12px sans-serif';
        ctx.fillText(image === null ? 'Image unavailable' : (el.mediaName || 'Loading image…'), el.x + 8, el.y + 20, Math.max(40, el.w - 16));
      }
      return;
    }
    if (imagesOnly) return;
    if (kind === 'stroke' || kind === 'curve') {
      const points = el.points || [];
      if (points.length < 1) return;
      ctx.globalCompositeOperation = el.isEraser ? 'destination-out' : 'source-over';
      if (el.isHighlighter) ctx.lineWidth=Math.max(width,14);
      ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      if (el.closed) ctx.closePath();
      ctx.stroke(); ctx.globalCompositeOperation = 'source-over';
      return;
    }
    const { x, y, w, h } = elementBounds(el);
    if (kind === 'shape') {
      const shape = String(el.shapeType || 'RECT').toUpperCase();
      ctx.beginPath();
      if (shape === 'ELLIPSE') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else if (shape === 'DIAMOND') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath(); }
      else if (shape === 'LINE') { ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); }
      else ctx.rect(x, y, w, h);
      ctx.stroke(); return;
    }
    if (kind === 'connector') {
      const a=elements.find(item=>item.id===Number(el.fromId)),b=elements.find(item=>item.id===Number(el.toId));
      if(a&&b){const p=elementBounds(a),q=elementBounds(b);ctx.beginPath();ctx.moveTo(p.x+p.w/2,p.y+p.h/2);ctx.lineTo(q.x+q.w/2,q.y+q.h/2);ctx.stroke();} return;
    }
    if (kind === 'textbox' || kind === 'treenode') {
      if (el.backgroundColorArgb != null || kind === 'treenode') { ctx.fillStyle = color(el.backgroundColorArgb, '#f4f2ff', false); ctx.fillRect(x, y, w, h); }
      const fontSize = Math.max(10, Number(el.fontSize) || 16);
      const fontFamily = ['Arial', 'Lora', 'Caveat'].includes(el.fontFamily) ? el.fontFamily : 'Arial';
      ctx.fillStyle = ink; ctx.font = `${fontSize}px "${fontFamily}"`;
      if (el.fontRuns?.length || codeSpans(el.text).length) { drawRichText(el.text || '', el.fontRuns, x + 6, y + 18, Math.max(20, w - 12), fontSize, fontFamily, fontSize + 4); return; }
      const lines = [];
      for (const sourceLine of String(el.text || '').split('\n')) {
        let line = '';
        for (const word of sourceLine.split(/\s+/)) {
          const next = line ? `${line} ${word}` : word;
          if (ctx.measureText(next).width > Math.max(20, w - 12) && line) { lines.push(line); line = word; }
          else line = next;
        }
        lines.push(line);
      }
      const lineHeight = fontSize + 4;
      lines.forEach((line, row) => { if (line) ctx.fillText(line, x + 6, y + 18 + row * lineHeight, Math.max(20, w - 12)); });
      if (Number(el.borderWidth) > 0 || kind === 'treenode') { ctx.strokeStyle = color(el.borderColorArgb || el.colorArgb); ctx.strokeRect(x, y, w, h); }
      return;
    }
    if (kind === 'table') {
      const rows = Math.max(1, Number(el.rows) || 1), cols = Math.max(1, Number(el.cols) || 1);
      const heights = tableRowHeights(el), offsets = heights.map((_, row) => heights.slice(0, row).reduce((sum, value) => sum + value, 0));
      for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
        const background=tableCellBackground(el,row,col);
        if(background){ctx.fillStyle=background;ctx.fillRect(x+col*w/cols,y+offsets[row],w/cols,heights[row]);}
      }
      ctx.strokeRect(x,y,w,h);
      for (let i = 1; i < rows; i++) { ctx.beginPath(); ctx.moveTo(x, y + offsets[i]); ctx.lineTo(x + w, y + offsets[i]); ctx.stroke(); }
      for (let i = 1; i < cols; i++) { ctx.beginPath(); ctx.moveTo(x + w * i / cols, y); ctx.lineTo(x + w * i / cols, y + h); ctx.stroke(); }
      ctx.fillStyle = ink; ctx.font = '12px sans-serif';
      for (const [cell, text] of Object.entries(el.cellText || {})) {
        const [row, col] = cell.split(/[,:-]/).map(Number);
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= rows || col < 0 || col >= cols) continue;
        drawRichText(text, el.cellFontRuns?.[`${row},${col}`], x + col * w / cols + 5, y + offsets[row] + 16, Math.max(1, w / cols - 10), 12, 'Arial', 16);
      }
      return;
    }
    if (kind === 'connector') {
      const positions = new Map(elements.map((item) => [item.id, elementBounds(item)]));
      const from = positions.get(Number(el.fromId)), to = positions.get(Number(el.toId));
      if (from && to) { ctx.beginPath(); ctx.moveTo(from.x + from.w / 2, from.y + from.h / 2); ctx.lineTo(to.x + to.w / 2, to.y + to.h / 2); ctx.stroke(); }
      return;
    }
    if (kind === 'curveshape' && el.start && el.end) {
      ctx.beginPath(); ctx.moveTo(el.start.x, el.start.y);
      const bend = String(el.curveStyle || '').includes('ARC') ? 0.35 : 0.1;
      ctx.quadraticCurveTo((el.start.x + el.end.x) / 2, Math.min(el.start.y, el.end.y) - Math.abs(el.end.x - el.start.x) * bend, el.end.x, el.end.y); ctx.stroke();
    }
  }

  let canvasFrame = 0;
  function requestCanvasRender() {
    if (!canvasFrame) canvasFrame = requestAnimationFrame(() => { canvasFrame = 0; renderCanvas(); });
  }
  function renderCanvas() {
    if (canvasFrame) { cancelAnimationFrame(canvasFrame); canvasFrame = 0; }
    const area = $('.sketch-drawing-area');
    if (!selectedBoard) { $('#empty-sketch').hidden = false; return; }
    $('.sketch-drawing-area').dataset.pattern = String(selectedBoard.backgroundPattern || 'BLANK').toUpperCase();
    $('#empty-sketch').hidden = elements.length > 0 || drawing;
    const b = boundsFor(elements);
    const worldW = Math.max(1, b.maxX - b.minX), worldH = Math.max(1, b.maxY - b.minY);
    const scale = zoomFactor;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rectWidth = Math.max(area.clientWidth, Math.min(10000, Math.ceil(worldW * scale + 60)));
    const rectHeight = Math.max(area.clientHeight, Math.min(10000, Math.ceil(worldH * scale + 60)));
    if (canvas.style.width !== `${rectWidth}px`) canvas.style.width = `${rectWidth}px`;
    if (canvas.style.height !== `${rectHeight}px`) canvas.style.height = `${rectHeight}px`;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const x = Math.max(30, (rect.width - worldW * scale) / 2), y = 30;
    imageLayout = { scale, x, y, bounds: b };
    const zoomLabel = $('#zoom-label'); if (zoomLabel) zoomLabel.textContent = `${Math.round(zoomFactor * 100)}%`;
    positionPageBodyEditor();
    positionPendingImagePreviews();
    positionTextElementEditor();
    positionTableEditor();
    if (!elements.length && !drawing) return;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (x - b.minX * scale), dpr * (y - b.minY * scale));
    const treeNodes = new Map(elements.filter((element) => element._kind === 'treenode').map((element) => [element.id, element]));
    ctx.strokeStyle = '#8a8578'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (const node of treeNodes.values()) {
      const parent = treeNodes.get(Number(node.parentId));
      if (!parent) continue;
      ctx.beginPath();
      const horizontal = String(parent.orientation || node.orientation || '').toUpperCase() === 'HORIZONTAL';
      if (horizontal) {
        const sx = parent.x + parent.w, sy = parent.y + parent.h / 2, ex = node.x, ey = node.y + node.h / 2, mid = (sx + ex) / 2;
        ctx.moveTo(sx, sy); ctx.bezierCurveTo(mid, sy, mid, ey, ex, ey);
      } else {
        const sx = parent.x + parent.w / 2, sy = parent.y + parent.h, ex = node.x + node.w / 2, ey = node.y, mid = (sy + ey) / 2;
        ctx.moveTo(sx, sy); ctx.bezierCurveTo(sx, mid, ex, mid, ex, ey);
      }
      ctx.stroke();
    }
    const referenceImages = new Set(elements.filter((element) => element._kind === 'table' && element.referenceImageId != null).map((element) => Number(element.referenceImageId)));
    for (const element of elements) if (element._kind === 'image') { ctx.save(); if (referenceImages.has(element.id)) ctx.globalAlpha = 0.42; drawElement(element); ctx.restore(); }
    for (const element of elements) if (element._kind !== 'image' && element._kind !== 'connector') drawElement(element);
    for (const element of elements) if (element._kind === 'connector') drawElement(element);
    if (currentStroke?.points.length) drawElement(currentStroke);
    if (shapePreview) drawElement(shapePreview);
    if (lassoRect) {
      ctx.save(); ctx.fillStyle = 'rgba(101,88,232,.12)'; ctx.strokeStyle = '#6558e8'; ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([5 / scale, 4 / scale]); ctx.fillRect(lassoRect.x, lassoRect.y, lassoRect.w, lassoRect.h); ctx.strokeRect(lassoRect.x, lassoRect.y, lassoRect.w, lassoRect.h); ctx.restore();
    }
    for (const id of selection) {
      const element = elements.find((item) => item.id === id);
      if (!element) continue;
      const box = elementBounds(element); ctx.save(); ctx.strokeStyle = '#6558e8'; ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([5 / scale, 4 / scale]); ctx.strokeRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8); ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function buildTree() {
    const pageCount = boards.filter((board) => !board.isSection).length;
    $('#board-count').textContent = `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
    if (!boards.length) { boardTree.innerHTML = '<div class="board-placeholder">No sketch boards found in Firestore.</div>'; return; }
    const byId = new Map(boards.map((b) => [b.id, b]));
    const children = new Map();
    for (const board of boards) {
      const parent = byId.has(board.parentBoardId) ? board.parentBoardId : '';
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(board);
    }
    for (const group of children.values()) group.sort((a, b) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0) || String(a.name).localeCompare(String(b.name)));
    const query = ($('#board-filter')?.value || '').trim().toLocaleLowerCase();
    const matches = new Set();
    if (query) {
      for (const board of boards) {
        if (!String(board.name || '').toLocaleLowerCase().includes(query)) continue;
        let current = board;
        while (current && !matches.has(current.id)) { matches.add(current.id); current = byId.get(current.parentBoardId); }
      }
    }
    const visited = new Set();
    const rows = [];
    function append(parentId, depth, ancestorsExpanded = true) {
      for (const board of children.get(parentId) || []) {
        if (visited.has(board.id)) continue;
        visited.add(board.id);
        const count = Number(board.elementCount || 0);
        const section = Boolean(board.isSection);
        const hasChildren = Boolean(children.get(board.id)?.length);
        const collapsed = !query && collapsedBoardIds.has(board.id);
        if ((!query || matches.has(board.id)) && ancestorsExpanded) rows.push(`<div class="board-entry ${section ? 'section-entry' : ''} ${selectedBoard?.id === board.id ? 'active' : ''}" style="padding-left:${8 + Math.min(depth, 7) * 17}px" data-board-id="${escapeHtml(board.id)}" ${section ? 'data-section="true"' : ''} draggable="true" title="${escapeHtml(board.name)}">${hasChildren ? `<button class="tree-toggle" type="button" data-toggle-id="${escapeHtml(board.id)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(board.name)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>` : `<span class="tree-toggle" aria-hidden="true">${section ? '▸' : (depth ? '↳' : '▱')}</span>`}<span class="board-name">${escapeHtml(board.name || 'Untitled board')}</span><span class="board-count">${count || ''}</span></div>`);
        append(board.id, depth + 1, ancestorsExpanded && (!collapsed || Boolean(query)));
      }
    }
    append('', 0);
    for (const board of boards) if (!visited.has(board.id)) append(board.id, 0);
    boardTree.innerHTML = rows.join('');
  }

  function isPageBody(element) { return element?._kind === 'textbox' && Boolean(element.isPageBody); }

  function pageBodyDraft(state = pageBodyEditor) {
    if (!state) return null;
    const rich = state.node?.isConnected ? readRichEditor(state.node) : { text: state.text, fontRuns: state.item.fontRuns || [] };
    const text = rich.text;
    state.text = text;
    const item = { ...state.item, _kind: 'textbox', isPageBody: true, text, fontRuns: rich.fontRuns };
    if (state.node?.isConnected) item.h = Math.max(40, state.node.getBoundingClientRect().height / zoomFactor);
    state.item = item;
    return item;
  }

  function setElements(next) {
    const incoming = next.map(parseElement).filter(Boolean);
    if (pageBodyEditor?.boardId === selectedBoard?.id) {
      const draft = pageBodyDraft();
      const index = incoming.findIndex(isPageBody);
      if (index >= 0) {
        draft.id = incoming[index].id;
      }
      for (const layoutElement of pageBodyEditor.layoutElements || []) {
        if (isPageBody(layoutElement)) {
          const bodyDraft = { ...layoutElement, ...draft, id: layoutElement.id || draft.id };
          const bodyIndex = incoming.findIndex(isPageBody);
          if (bodyIndex >= 0) incoming[bodyIndex] = bodyDraft;
          else if (bodyDraft.text || bodyDraft.id) incoming.push(bodyDraft);
          pageBodyEditor.item = bodyDraft;
          continue;
        }
        const layoutIndex = incoming.findIndex((element) => element.id === layoutElement.id);
        if (layoutIndex >= 0) incoming[layoutIndex] = layoutElement;
      }
      if (!(pageBodyEditor.layoutElements || []).some(isPageBody) && (draft.text || draft.id)) incoming.push(draft);
    }
    if (textElementEditor?.boardId === selectedBoard?.id && textElementEditor.node.isConnected) {
      for (const draft of textElementEditor.layoutElements) {
        const pendingId = textElementEditor.isNew && draft.id === textElementEditor.item.id ? textElementEditor.pendingId : null;
        const mergedDraft = pendingId ? { ...draft, id: pendingId } : draft;
        const index = incoming.findIndex((el) => el.id === mergedDraft.id);
        if (index >= 0) incoming[index] = { ...incoming[index], ...mergedDraft };
        else if (textElementEditor.isNew && draft.id === textElementEditor.item.id) incoming.push(mergedDraft);
      }
      const draft = textElementEditor.layoutElements.find((el) => el.id === textElementEditor.item.id);
      if (draft) textElementEditor.item = draft;
    }
    if (tableEditor?.boardId === selectedBoard?.id && tableEditor.dirty) {
      for (const draft of [tableEditor.item, ...tableEditor.shifted.values()]) { const index = incoming.findIndex(el => el.id === draft.id); if (index >= 0) incoming[index] = draft; }
    }
    if (tableEditor?.boardId === selectedBoard?.id && !tableEditor.dirty) { const current = incoming.find((element) => element.id === tableEditor.item.id); if (current) tableEditor.item = current; }
    elements = incoming.sort((a, b) => a.id - b.id);
    if (selectedBoard) selectedBoard.elementCount = elements.length;
    $('#selected-board-meta').textContent = `${elements.length} elements · ${selectedBoard?.sourceSection || selectedBoard?.sourceNotebook || 'Firebase'}`;
    renderCanvas(); buildTree();
  }

  async function loadLegacyContent(boardId) {
    if (loadingLegacy) return;
    loadingLegacy = true;
    try {
      const doc = await boardsRef.doc(boardId).collection('content').doc('elements').get();
      const json = doc.get('elementsJson');
      if (json) {
        let parsed;
        try { parsed = JSON.parse(json); } catch { parsed = []; }
        setElements(Array.isArray(parsed) ? parsed : (parsed.elements || []));
      }
    } catch (error) { console.warn('Legacy sketch content read failed', error); }
    finally { loadingLegacy = false; }
  }

  function selectBoard(board) {
    closePageBodyEditor();
    closeTextElementEditor();
    closeTableEditor();
    if (boardListener) boardListener();
    if (contentListener) contentListener();
    selectedBoard = board;
    zoomFactor = 1;
    elements = [];
    for (const image of loadedImages.values()) if (image instanceof Image && image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    loadedImages.clear();
    $('#selected-board-name').disabled = false;
    $('#selected-board-name').value = board.name || 'Untitled board';
    $('#board-background').value=String(board.backgroundPattern||'BLANK').toUpperCase();
    selection=new Set();undoStack.length=0;redoStack.length=0;connectorStartId=null;
    $('#save-state').textContent = 'Watching Firebase…';
    buildTree(); renderCanvas();
    const collection = boardsRef.doc(board.id).collection('elements');
    boardListener = collection.onSnapshot((snapshot) => {
      const next = [];
      snapshot.forEach((doc) => {
        const raw = doc.get('elementJson');
        if (raw) next.push(parseElement(raw));
        else if (doc.get('kind')) next.push({ ...doc.data(), id: Number(doc.id), _kind: labelForType(doc.data()) });
      });
      if (next.length) setElements(next);
      else loadLegacyContent(board.id);
      $('#save-state').textContent = 'Live updates on';
    }, (error) => {
      console.error('Sketch elements listener failed', error);
      $('#save-state').textContent = 'Sketch read blocked';
      notice(`Could not read sketch contents: ${error.message}. Check the Firebase web app and Firestore rules.`);
    });
    contentListener = boardsRef.doc(board.id).collection('content').doc('elements').onSnapshot((doc) => {
      const json = doc.get('elementsJson');
      if (json && elements.length === 0) {
        try { const old = JSON.parse(json); setElements(Array.isArray(old) ? old : (old.elements || [])); } catch { /* Invalid legacy data is left untouched. */ }
      }
    });
  }

  function drawTreeMessage(message) { boardTree.innerHTML = `<div class="board-placeholder">${escapeHtml(message)}</div>`; }

  boardsRef.orderBy('orderIndex', 'asc').onSnapshot((snapshot) => {
    boards = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    status('Connected to shared Firebase', true);
    notice(location.protocol === 'file:'
      ? 'Sketches can load from Firebase, but private Supabase images need Firebase sign-in. Open this page over HTTPS or localhost instead of file://.'
      : 'Sketch boards read directly from the Android app’s sketchBoards collection. Firebase rules decide who may see or change them.');
    buildTree();
    if (selectedBoard) {
      const updated = boards.find((b) => b.id === selectedBoard.id);
      if (updated) { selectedBoard = updated; $('#selected-board-name').value = updated.name || ''; }
    }
  }, (error) => {
    console.error('Sketch boards listener failed', error);
    status('Firebase access denied');
    drawTreeMessage(error.code === 'permission-denied' ? 'Firestore rules denied access. Sign-in or rules configuration is needed.' : `Firestore error: ${error.message}`);
    notice(`The Firebase connection could not read sketchBoards: ${error.message}. The page did not change any stored data.`);
  });

  boardTree.addEventListener('click', (event) => {
    const entry = event.target.closest('.board-entry');
    const toggle = event.target.closest('[data-toggle-id]') || (entry?.classList.contains('section-entry') ? entry.querySelector('[data-toggle-id]') : null);
    if (toggle) {
      event.stopPropagation();
      const id = toggle.dataset.toggleId;
      collapsedBoardIds.has(id) ? collapsedBoardIds.delete(id) : collapsedBoardIds.add(id);
      try { localStorage.setItem('taskflow-sketch-collapsed-pages', JSON.stringify([...collapsedBoardIds])); } catch { /* Collapse still works when storage is unavailable. */ }
      buildTree(); return;
    }
    const pageEntry = event.target.closest('[data-board-id]:not([data-section="true"])');
    if (pageEntry) { const board = boards.find((item) => item.id === pageEntry.dataset.boardId); if (board) selectBoard(board); }
  });

  function descendantIds(rootId) {
    const found = new Set([rootId]);
    let changed = true;
    while (changed) { changed = false; for (const board of boards) if (board.parentBoardId && found.has(board.parentBoardId) && !found.has(board.id)) { found.add(board.id); changed = true; } }
    return found;
  }
  async function reparentBoard(movingId, parentId = null) {
    const moving = boards.find((item) => item.id === movingId);
    const parent = parentId ? boards.find((item) => item.id === parentId) : null;
    if (!moving || (parentId && !parent) || parentId === movingId || (parentId && descendantIds(movingId).has(parentId))) return;
    const subtree = descendantIds(movingId);
    const nextLevel = parent ? (Number(parent.hierarchyLevel) || 0) + 1 : 0;
    const delta = nextLevel - (Number(moving.hierarchyLevel) || 0);
    try {
      const batch = db.batch(), now = firebase.firestore.FieldValue.serverTimestamp();
      batch.update(boardsRef.doc(moving.id), { parentBoardId: parent?.id || null, hierarchyLevel: nextLevel, orderIndex: Date.now(), updatedAt: now });
      for (const board of boards) if (subtree.has(board.id) && board.id !== moving.id) batch.update(boardsRef.doc(board.id), { hierarchyLevel: Math.max(0, (Number(board.hierarchyLevel) || 0) + delta), updatedAt: now });
      await batch.commit();
      if (parent) collapsedBoardIds.delete(parent.id);
      buildTree(); showToast(parent ? `Moved “${moving.name}” under “${parent.name}”` : `Moved “${moving.name}” to notebook root`);
    } catch (error) { notice(`Could not move page: ${error.message}`); }
  }
  boardTree.addEventListener('dragstart', (event) => {
    const entry = event.target.closest('[data-board-id]'); if (!entry) return;
    draggedBoardId = entry.dataset.boardId; entry.classList.add('dragging');
    event.dataTransfer?.setData('text/plain', draggedBoardId); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  boardTree.addEventListener('dragend', (event) => { event.target.closest('.board-entry')?.classList.remove('dragging'); boardTree.querySelectorAll('.drop-target').forEach((entry) => entry.classList.remove('drop-target')); draggedBoardId = null; });
  boardTree.addEventListener('dragover', (event) => { const entry = event.target.closest('[data-board-id]'); if (!entry || !draggedBoardId || entry.dataset.boardId === draggedBoardId || descendantIds(draggedBoardId).has(entry.dataset.boardId)) return; event.preventDefault(); boardTree.querySelectorAll('.drop-target').forEach((item) => item.classList.remove('drop-target')); entry.classList.add('drop-target'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; });
  boardTree.addEventListener('drop', async (event) => {
    const entry = event.target.closest('[data-board-id]'); if (!entry || !draggedBoardId) return;
    event.preventDefault(); await reparentBoard(draggedBoardId, entry.dataset.boardId);
  });
  boardTree.addEventListener('dragover', (event) => { if (draggedBoardId && event.target === boardTree) event.preventDefault(); });
  boardTree.addEventListener('drop', async (event) => {
    if (event.target !== boardTree || !draggedBoardId) return;
    event.preventDefault(); await reparentBoard(draggedBoardId, null);
  });

  // HTML drag-and-drop is inconsistent on touch devices. Long-press starts a
  // pointer drag on tablets; dropping a page on another page reparents it.
  let touchDrag = null, touchDragTimer = null, suppressTreeClick = false;
  function clearTouchDrag() {
    clearTimeout(touchDragTimer); touchDragTimer = null;
    boardTree.querySelectorAll('.dragging,.drop-target').forEach((entry) => entry.classList.remove('dragging', 'drop-target'));
    touchDrag = null; draggedBoardId = null;
  }
  boardTree.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' || event.target.closest('.tree-toggle,[data-toggle-id]')) return;
    const entry = event.target.closest('[data-board-id]'); if (!entry) return;
    touchDrag = { id: entry.dataset.boardId, startX: event.clientX, startY: event.clientY, active: false, targetId: null };
    touchDragTimer = setTimeout(() => {
      if (!touchDrag) return;
      touchDrag.active = true; draggedBoardId = touchDrag.id; entry.classList.add('dragging');
      if (navigator.vibrate) navigator.vibrate(20);
    }, 350);
  });
  boardTree.addEventListener('pointermove', (event) => {
    if (!touchDrag) return;
    const distance = Math.hypot(event.clientX - touchDrag.startX, event.clientY - touchDrag.startY);
    if (!touchDrag.active && distance > 12) { clearTimeout(touchDragTimer); touchDragTimer = null; touchDrag = null; return; }
    if (!touchDrag.active) return;
    event.preventDefault();
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.board-entry[data-board-id]');
    const valid = over && over.dataset.boardId !== touchDrag.id && !descendantIds(touchDrag.id).has(over.dataset.boardId);
    boardTree.querySelectorAll('.drop-target').forEach((entry) => entry.classList.remove('drop-target'));
    touchDrag.targetId = valid ? over.dataset.boardId : null;
    if (valid) over.classList.add('drop-target');
  }, { passive: false });
  boardTree.addEventListener('pointerup', async () => {
    if (!touchDrag) return;
    const drag = touchDrag;
    if (drag.active) {
      suppressTreeClick = true;
      if (drag.targetId) await reparentBoard(drag.id, drag.targetId);
    }
    clearTouchDrag();
  });
  boardTree.addEventListener('pointercancel', clearTouchDrag);
  boardTree.addEventListener('click', (event) => {
    if (!suppressTreeClick) return;
    suppressTreeClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);

  $('#new-board').addEventListener('click', async () => {
    const name = prompt('Name this sketch board or page:');
    if (!name?.trim()) return;
    try {
      const parentBoardId = selectedBoard?.id || null;
      const hierarchyLevel = parentBoardId ? (Number(selectedBoard.hierarchyLevel) || 0) + 1 : 0;
      const orderIndex = boards.reduce((max, board) => Math.max(max, Number(board.orderIndex) || 0), -1) + 1;
      const doc = await boardsRef.add({ name: name.trim(), orderIndex, backgroundPattern: 'BLANK', parentBoardId, hierarchyLevel, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      showToast('Sketch board created');
      selectBoard({ id: doc.id, name: name.trim(), orderIndex, parentBoardId, hierarchyLevel });
    } catch (error) { notice(`Could not create board: ${error.message}`); }
  });

  $('#rename-board').addEventListener('click', async () => {
    if (!selectedBoard) return showToast('Choose a board first');
    const name = prompt('Rename this sketch:', selectedBoard.name || '');
    if (!name?.trim() || name.trim() === selectedBoard.name) return;
    try { await boardsRef.doc(selectedBoard.id).update({ name: name.trim(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }); selectedBoard.name = name.trim(); $('#selected-board-name').value = name.trim(); showToast('Sketch renamed'); }
    catch (error) { notice(`Could not rename board: ${error.message}`); }
  });

  $('#delete-board').addEventListener('click', async () => {
    if (!selectedBoard) return showToast('Choose a board first');
    if (boards.some((b) => b.parentBoardId === selectedBoard.id)) return showToast('Move or delete its child pages first');
    if (!confirm(`Delete “${selectedBoard.name}” and its sketch elements? This cannot be undone.`)) return;
    try {
      const docs = await boardsRef.doc(selectedBoard.id).collection('elements').get();
      const list = docs.docs;
      for (let i = 0; i < list.length; i += 400) {
        const batch = db.batch(); list.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref)); await batch.commit();
      }
      await boardsRef.doc(selectedBoard.id).collection('content').doc('elements').delete();
      await boardsRef.doc(selectedBoard.id).delete();
      if (boardListener) boardListener(); if (contentListener) contentListener();
      selectedBoard = null; elements = []; $('#selected-board-name').value = 'Select a sketch'; $('#selected-board-name').disabled = true; $('#selected-board-meta').textContent = 'Pages and hierarchy stay linked'; renderCanvas();
      showToast('Sketch board deleted');
    } catch (error) { notice(`Could not delete board: ${error.message}`); }
  });

  function point(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const layout = imageLayout;
    return { x: (x - layout.x) / layout.scale + layout.bounds.minX, y: (y - layout.y) / layout.scale + layout.bounds.minY, t: Date.now(), pressure: Number(e.pressure) || 0.5 };
  }

  function pageCenter() {
    const area = $('.sketch-drawing-area');
    const canvasRect = canvas.getBoundingClientRect();
    const areaRect = area.getBoundingClientRect();
    const x = areaRect.left + area.clientWidth / 2 - canvasRect.left;
    const y = areaRect.top + area.clientHeight / 2 - canvasRect.top;
    return {
      x: (x - imageLayout.x) / imageLayout.scale + imageLayout.bounds.minX,
      y: (y - imageLayout.y) / imageLayout.scale + imageLayout.bounds.minY
    };
  }

  function positionPageBodyEditor() {
    const state = pageBodyEditor;
    if (!state?.node.isConnected || state.boardId !== selectedBoard?.id) return;
    const box = state.item;
    state.node.style.left = `${canvas.offsetLeft + imageLayout.x + (box.x - imageLayout.bounds.minX) * imageLayout.scale}px`;
    state.node.style.top = `${canvas.offsetTop + imageLayout.y + (box.y - imageLayout.bounds.minY) * imageLayout.scale}px`;
    state.node.style.width = `${Math.max(1, box.w * imageLayout.scale)}px`;
    state.node.style.minHeight = `${Math.max(40, box.h * imageLayout.scale)}px`;
    state.node.style.fontFamily = box.fontFamily || 'Arial';
    state.node.style.fontSize = `${Math.max(8, (Number(box.fontSize) || 20) * imageLayout.scale)}px`;
    state.node.style.lineHeight = `${((Number(box.fontSize) || 20) + 4) * imageLayout.scale}px`;
    state.node.style.color = color(box.colorArgb);
  }

  function positionTextElementEditor() {
    const state = textElementEditor;
    if (!state?.node.isConnected || state.boardId !== selectedBoard?.id) return;
    const box = state.item;
    state.node.style.left = `${canvas.offsetLeft + imageLayout.x + (box.x - imageLayout.bounds.minX) * imageLayout.scale}px`;
    state.node.style.top = `${canvas.offsetTop + imageLayout.y + (box.y - imageLayout.bounds.minY) * imageLayout.scale}px`;
    state.node.style.width = `${Math.max(100, box.w * imageLayout.scale)}px`;
    state.node.style.minHeight = `${Math.max(40, box.h * imageLayout.scale)}px`;
    state.node.style.fontFamily = box.fontFamily || 'Arial';
    state.node.style.fontSize = `${Math.max(8, (Number(box.fontSize) || 20) * imageLayout.scale)}px`;
    state.node.style.lineHeight = `${((Number(box.fontSize) || 20) + 4) * imageLayout.scale}px`;
    state.node.style.color = color(box.colorArgb);
  }

  function tableRowHeights(item) {
    const rows = Math.max(1, Number(item.rows) || 1);
    return Array.from({ length: rows }, (_, row) => Math.max(20, Number(item.rowHeights?.[row]) || Number(item.h) / rows || 25));
  }

  // Formatting is derived from plain text; source and manual font runs stay intact.
  const codeCache = new Map();
  function codeSpans(value) {
    const text = String(value || '');
    if (codeCache.has(text)) return codeCache.get(text);
    const spans = []; let offset = 0, fence = '', depth = 0;
    const strong = line => /^(?:(?:export\s+)?(?:const|let|var|val|fun|function|class|interface|enum|data\s+class|def|async\s+def|import|package|namespace|using)\s+[\w{*]|(?:public|private|protected|static|override|suspend)\s+\w|(?:if|for|while|switch|catch)\s*\(|(?:if|for|while|elif|except)\s+.+:\s*$|(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\s|<\/?[\w-]+(?:\s[^>]*|\s*)>|["'][^"']+["']\s*:\s*\S|[\w.$]+\s*(?:=|:=|=>)\s*\S|[\w.$]+\([^\n]*\)\s*[;{]?\s*$|(?:return|throw|yield)\s+.+[;}]\s*$)/.test(line);
    for (const line of text.split('\n')) {
      const trimmed = line.trim(), marker = trimmed.match(/^(`{3,}|~{3,})/);
      let isCode = false;
      if (marker) { isCode = true; fence = fence ? (marker[1][0] === fence[0] && marker[1].length >= fence.length ? '' : fence) : marker[1]; if (!fence) depth = 0; }
      else isCode = Boolean(fence) || strong(trimmed) || (depth > 0) || /^(?:[{}\[\]]+[;,]?|\/\/.*|\/\*.*|\*\/)$/.test(trimmed);
      if (isCode) {
        spans.push({ start: offset, end: offset + line.length, kind: marker ? 'comment' : 'base' });
        if (!marker) {
          const tokens = /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\];,.<>:=+*/!?&|%-]/g;
          for (const match of line.matchAll(tokens)) {
            const word = match[0];
            const kind = /^(?:\/\/|#|\/\*)/.test(word) ? 'comment' : /^["'`]/.test(word) ? 'string' : /^\d/.test(word) ? 'number' : /^(?:const|let|var|val|fun|function|class|interface|enum|data|def|async|await|import|from|package|export|default|return|throw|throws|yield|if|else|elif|for|while|switch|case|break|continue|try|catch|except|finally|new|public|private|protected|static|final|override|suspend|when|in|is|as|void|int|float|double|boolean|String|true|false|null|undefined|None|True|False|SELECT|FROM|WHERE|JOIN|ON|AS|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|GROUP|ORDER|BY|AND|OR|NOT|LIMIT)$/.test(word) ? 'keyword' : /^[A-Za-z_$]/.test(word) && /^\s*\(/.test(line.slice(match.index + word.length)) ? 'function' : /^[^\w$]/.test(word) ? 'punctuation' : 'base';
            spans.push({ start: offset + match.index, end: offset + match.index + word.length, kind });
          }
          // Braces inside comments and strings must not turn following prose into code.
          const structural = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|#.*|\/\*.*?\*\//g, '');
          depth = Math.max(0, depth + (structural.match(/[({\[]/g)||[]).length - (structural.match(/[)}\]]/g)||[]).length);
        }
      } else {
        for (const match of line.matchAll(/`[^`\n]+`/g)) spans.push({ start:offset+match.index,end:offset+match.index+match[0].length,kind:'string' });
      }
      offset += line.length + 1;
    }
    if (codeCache.size >= 100) codeCache.delete(codeCache.keys().next().value);
    codeCache.set(text, spans); return spans;
  }
  const codePalette = () => document.documentElement.dataset.theme === 'dark'
    ? {base:'#e2e8f0',keyword:'#c4b5fd',string:'#86efac',number:'#fdba74',comment:'#94a3b8',function:'#7dd3fc',punctuation:'#cbd5e1'}
    : {base:'#243247',keyword:'#713bb5',string:'#237a3b',number:'#a54b00',comment:'#64748b',function:'#006b9e',punctuation:'#475569'};
  const codeStyle = document.createElement('style');
  codeStyle.textContent = `[data-auto-code]{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace!important;color:var(--syntax-base)}:root{--syntax-base:#243247;--syntax-keyword:#713bb5;--syntax-string:#237a3b;--syntax-number:#a54b00;--syntax-comment:#64748b;--syntax-function:#006b9e;--syntax-punctuation:#475569}[data-theme="dark"]{--syntax-base:#e2e8f0;--syntax-keyword:#c4b5fd;--syntax-string:#86efac;--syntax-number:#fdba74;--syntax-comment:#94a3b8;--syntax-function:#7dd3fc;--syntax-punctuation:#cbd5e1}[data-auto-code="keyword"]{color:var(--syntax-keyword)}[data-auto-code="string"]{color:var(--syntax-string)}[data-auto-code="number"]{color:var(--syntax-number)}[data-auto-code="comment"]{color:var(--syntax-comment)}[data-auto-code="function"]{color:var(--syntax-function)}[data-auto-code="punctuation"]{color:var(--syntax-punctuation)}`;
  document.head.append(codeStyle);

  function decorateCode(node) {
    if (!node.isConnected) return;
    if (!node.querySelector('[data-auto-code]') && !codeSpans(readRichEditor(node).text).length) return;
    const selection = window.getSelection(), active = selection?.rangeCount && node.contains(selection.anchorNode) && node.contains(selection.focusNode);
    let anchorMarker, focusMarker;
    if (active) {
      const anchorRange = document.createRange(), focusRange = document.createRange();
      anchorRange.setStart(selection.anchorNode, selection.anchorOffset); anchorRange.collapse(true);
      focusRange.setStart(selection.focusNode, selection.focusOffset); focusRange.collapse(true);
      anchorMarker = document.createComment('caret-anchor'); focusMarker = document.createComment('caret-focus');
      focusRange.insertNode(focusMarker); anchorRange.insertNode(anchorMarker);
    }
    node.querySelectorAll('[data-auto-code]').forEach(span => span.replaceWith(...span.childNodes));
    const nodes = [];
    const rich = readRichEditor(node, (textNode, start, end) => nodes.push({node:textNode,start,end}));
    const spans = codeSpans(rich.text);
    for (const item of nodes) {
      const hits = spans.filter(span=>span.start<item.end&&span.end>item.start);
      if (!hits.length) continue;
      const boundaries = [...new Set([item.start,item.end,...hits.flatMap(span=>[Math.max(item.start,span.start),Math.min(item.end,span.end)])])].sort((a,b)=>a-b);
      const fragment = document.createDocumentFragment();
      for(let i=0;i<boundaries.length-1;i++) {
        const start=boundaries[i],end=boundaries[i+1],token=hits.findLast(span=>span.start<=start&&span.end>=end);
        const text=item.node.textContent.slice(start-item.start,end-item.start);
        if(token){const span=document.createElement('span');span.dataset.autoCode=token.kind;span.textContent=text;fragment.append(span);}else fragment.append(document.createTextNode(text));
      }
      item.node.replaceWith(fragment);
    }
    if(active){
      const anchorRange = document.createRange(), focusRange = document.createRange();
      anchorRange.setStartBefore(anchorMarker); anchorRange.collapse(true);
      focusRange.setStartBefore(focusMarker); focusRange.collapse(true);
      anchorMarker.remove(); focusMarker.remove();
      selection.setBaseAndExtent(anchorRange.startContainer, anchorRange.startOffset, focusRange.startContainer, focusRange.startOffset);
      rememberTextSelection();
    }
  }
  function enableCodeFormatting(node, onLayout) {
    let timer, composing=false;
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!composing&&node.isConnected){decorateCode(node);onLayout?.();}},180);};
    node.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);});
    node.addEventListener('compositionend',()=>{composing=false;schedule();});
    node.addEventListener('input',schedule);
    decorateCode(node);
  }

  const textFonts = new Set(['Arial', 'Lora', 'Caveat']);
  let savedTextSelection = null;

  function richEditorContent(node, text, runs = []) {
    node.replaceChildren();
    let offset = 0;
    for (const run of [...runs].sort((a, b) => a.start - b.start)) {
      const start = Math.max(offset, Math.min(text.length, run.start)), end = Math.min(text.length, run.end);
      if (end <= start || !textFonts.has(run.fontFamily)) continue;
      node.append(document.createTextNode(text.slice(offset, start)));
      const span = document.createElement('span'); span.style.fontFamily = run.fontFamily;
      span.textContent = text.slice(start, end); node.append(span); offset = end;
    }
    node.append(document.createTextNode(text.slice(offset)));
  }

  function readRichEditor(node, visitText) {
    let text = ''; const fontRuns = [];
    const meaningful = child => child.nodeType === Node.ELEMENT_NODE || (child.nodeType === Node.TEXT_NODE && child.length > 0);
    const sibling = (current, direction) => { let next = current[direction]; while (next && !meaningful(next)) next = next[direction]; return next; };
    function walk(current, font = '') {
      if (current.nodeType === Node.TEXT_NODE) {
        const start = text.length; text += current.textContent;
        visitText?.(current, start, text.length);
        if (font && text.length > start) fontRuns.push({ start, end: text.length, fontFamily: font });
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;
      if (current.tagName === 'BR') {
        const parent = current.parentElement;
        if ([...parent.childNodes].filter(meaningful).length === 1) return;
        if (!sibling(current, 'nextSibling') && sibling(current, 'previousSibling')?.nodeName === 'BR') return;
        text += '\n'; return;
      }
      const candidate = (current.style.fontFamily || current.getAttribute('face') || '').replace(/["']/g, '').trim();
      const family = textFonts.has(candidate) ? candidate : font;
      const block = current !== node && /^(DIV|P|LI)$/.test(current.tagName);
      const previous = sibling(current, 'previousSibling'), next = sibling(current, 'nextSibling');
      if (block && previous && previous.nodeName !== 'BR') text += '\n';
      for (const child of current.childNodes) walk(child, family);
      if (block && next && !/^(DIV|P|LI)$/.test(next.nodeName)) text += '\n';
    }
    walk(node); return { text: text.replace(/\r/g, ''), fontRuns };
  }

  function rememberTextSelection() {
    const selected = window.getSelection();
    if (!selected?.rangeCount) return;
    const range = selected.getRangeAt(0), element = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const node = element?.closest('.page-body-editor,.table-editor-cell');
    if (node && node.contains(range.startContainer) && node.contains(range.endContainer)) savedTextSelection = { node, range: range.cloneRange() };
  }
  document.addEventListener('selectionchange', rememberTextSelection);
  $('.sketch-ribbon-shell').addEventListener('pointerdown', rememberTextSelection, true);
  function usingFormatToolbar(target) { return Boolean(target?.closest?.('.sketch-ribbon-shell')); }

  function drawRichText(text, runs, x, y, width, fontSize, family, lineHeight) {
    let cursor = 0, line = 0, offset = 0;
    const syntax = codeSpans(text), palette = codePalette(), originalInk = ctx.fillStyle;
    for (const char of String(text)) {
      const run = runs?.find(run => offset >= run.start && offset < run.end);
      const token = syntax.findLast(span => offset >= span.start && offset < span.end);
      ctx.font = token ? `${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace` : `${fontSize}px "${textFonts.has(run?.fontFamily) ? run.fontFamily : family}"`;
      ctx.fillStyle = token ? palette[token.kind] : originalInk;
      if (char === '\n') { cursor = 0; line++; offset++; continue; }
      const size = ctx.measureText(char).width;
      if (cursor && cursor + size > width) { cursor = 0; line++; }
      ctx.fillText(char, x + cursor, y + line * lineHeight); cursor += size; offset += char.length;
    }
    ctx.fillStyle = originalInk;
  }

  function applySelectedFont(fontFamily) {
    const saved = savedTextSelection;
    if (!saved?.node.isConnected || !textFonts.has(fontFamily)) return false;
    const node = saved.node;
    node.focus({ preventScroll: true });
    const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(saved.range);
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('fontName', false, fontFamily);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    rememberTextSelection(); return true;
  }

  function resizeTableRows(state) {
    const before = elementBounds(state.item), heights = [...state.minRowHeights];
    const scale = Math.max(.01, imageLayout.scale);
    for (const cell of state.node.querySelectorAll('.table-editor-cell')) {
      const row = Number(cell.dataset.cell.split(',')[0]);
      cell.style.height = '0px';
      heights[row] = Math.max(heights[row], (cell.scrollHeight + 2) / scale);
      cell.style.height = '100%'; cell.scrollTop = 0;
    }
    const height = heights.reduce((sum, value) => sum + value, 0), delta = height - before.h;
    state.item = { ...state.item, rowHeights: heights, rowMinHeights: state.minRowHeights, h: height };
    elements = elements.map(entry => {
      if (entry.id === state.item.id) return state.item;
      const box = elementBounds(entry);
      if (Math.abs(delta) > .01 && box.y >= before.y + before.h - 2 && box.x < before.x + before.w && box.x + box.w > before.x) {
        const moved = moveElement(entry, 0, delta); state.shifted.set(entry.id, moved); return moved;
      }
      return entry;
    });
    positionTableEditor();
  }

  function positionTableEditor() {
    const state = tableEditor;
    if (!state?.node?.isConnected || state.boardId !== selectedBoard?.id) return;
    const { x, y, w, h } = elementBounds(state.item);
    const rows = Math.max(1, Number(state.item.rows) || 1), cols = Math.max(1, Number(state.item.cols) || 1);
    const left = canvas.offsetLeft + imageLayout.x + (x - imageLayout.bounds.minX) * imageLayout.scale;
    const top = canvas.offsetTop + imageLayout.y + (y - imageLayout.bounds.minY) * imageLayout.scale;
    state.node.style.left = `${left}px`; state.node.style.top = `${top}px`;
    state.node.style.width = `${Math.max(30, w * imageLayout.scale)}px`; state.node.style.height = `${Math.max(25, h * imageLayout.scale)}px`;
    state.node.style.gridTemplateColumns = `repeat(${cols},minmax(0,1fr))`;
    state.node.style.gridTemplateRows = tableRowHeights(state.item).map(height => `${height * imageLayout.scale}px`).join(' ');
    for (const cell of state.node.querySelectorAll('.table-editor-cell')) {
      cell.style.font = `${12 * imageLayout.scale}px sans-serif`;
      cell.style.lineHeight = `${16 * imageLayout.scale}px`;
      cell.style.padding = `${3 * imageLayout.scale}px ${5 * imageLayout.scale}px`;
    }
  }

  function startTableEditor(item) {
    closePageBodyEditor(); closeTextElementEditor(); closeTableEditor();
    const area = $('.sketch-drawing-area');
    const rows = Math.max(1, Number(item.rows) || 1), cols = Math.max(1, Number(item.cols) || 1);
    const node = document.createElement('div'); node.className = 'table-editor'; node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Edit ${rows} by ${cols} table`);
    const state = { boardId: selectedBoard.id, item, node, shifted: new Map(), minRowHeights: Array.from({ length: rows }, (_, row) => Math.max(24, Number(item.rowMinHeights?.[row]) || (item.rowHeights ? 24 : Number(item.h) / rows) || 24)) }; tableEditor = state;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const cell = document.createElement('div'); cell.className = 'table-editor-cell'; cell.dataset.cell = `${row},${col}`;
      cell.contentEditable = 'true'; cell.setAttribute('role', 'textbox'); cell.setAttribute('aria-multiline', 'true');
      cell.setAttribute('aria-label', `Row ${row + 1}, column ${col + 1}`);
      cell.style.whiteSpace = 'pre-wrap'; cell.style.overflowWrap = 'anywhere'; cell.style.cursor = 'text';
      richEditorContent(cell, String(item.cellText?.[`${row},${col}`] ?? item.cellText?.[`${row}-${col}`] ?? ''), item.cellFontRuns?.[`${row},${col}`]);
      const background = tableCellBackground(item,row,col);
      if(background) cell.style.backgroundColor = background;
      cell.spellcheck = false;
      cell.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || ''); });
      cell.addEventListener('input', () => {
        const rich = readRichEditor(cell);
        const cellText = { ...(state.item.cellText || {}), [cell.dataset.cell]: rich.text };
        delete cellText[cell.dataset.cell.replace(',', '-')];
        state.item = { ...state.item, cellText, cellFontRuns: { ...(state.item.cellFontRuns || {}), [cell.dataset.cell]: rich.fontRuns } };
        state.dirty = true; elements = elements.map((entry) => entry.id === state.item.id ? state.item : entry);
        resizeTableRows(state); clearTimeout(tableSaveTimer); tableSaveTimer = setTimeout(() => saveTableEditor(state), 500); renderCanvas();
      });
      cell.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closeTableEditor(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); closeTableEditor(); } });
      node.append(cell);
    }
    node.addEventListener('focusout', (event) => { if (!node.contains(event.relatedTarget) && !usingFormatToolbar(event.relatedTarget)) { clearTimeout(tableSaveTimer); tableSaveTimer = setTimeout(() => closeTableEditor(state), 120); } });
    area.append(node); area.classList.add('editing-table'); positionTableEditor();
    node.querySelectorAll('.table-editor-cell').forEach(cell => enableCodeFormatting(cell, () => { resizeTableRows(state); renderCanvas(); }));
    node.querySelector('.table-editor-cell')?.focus();
  }

  async function saveTableEditor(state) {
    if (state.boardId !== selectedBoard?.id) return;
    const snapshot = [state.item, ...state.shifted.values()].map(cloneElement);
    state.savePromise = (state.savePromise || Promise.resolve()).catch(() => {}).then(async () => {
      const collection = boardsRef.doc(state.boardId).collection('elements');
      for (let offset = 0; offset < snapshot.length; offset += 400) {
        const batch = db.batch();
        snapshot.slice(offset, offset + 400).forEach(item => {
          const record = { ...item }; delete record._kind;
          batch.set(collection.doc(String(record.id)), { elementJson: JSON.stringify(record), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        await batch.commit();
      }
      $('#save-state').textContent = 'Saved to shared Firebase';
    }).catch(error => notice(`Could not save table cell: ${error.message}`));
    return state.savePromise;
  }

  function closeTableEditor(state = tableEditor) {
    if (!state) return;
    clearTimeout(tableSaveTimer); tableSaveTimer = null;
    if (state.dirty) { state.dirty = false; void saveTableEditor(state); }
    if (state === tableEditor) tableEditor = null;
    state.node?.remove(); $('.sketch-drawing-area').classList.remove('editing-table'); renderCanvas();
  }

  function queueTextElementSave(state) {
    clearTimeout(textElementSaveTimer);
    textElementSaveTimer = setTimeout(() => { void persistTextElement(state); }, 600);
  }

  function persistTextElement(state) {
    state.savePromise = (state.savePromise || Promise.resolve()).catch(() => {}).then(async () => {
      const snapshot = state.layoutElements.map(cloneElement);
      const current = snapshot.find((item) => item.id === state.item.id);
      if (!current) return;
      if (state.isNew && !String(current.text || '').trim()) return;
      const changed = snapshot.filter((item) => item.id !== current.id).filter((item) => {
        const previous = state.savedElements.find((el) => el.id === item.id);
        if (!previous) return false;
        const currentRecord = { ...item }; delete currentRecord._kind;
        const previousRecord = { ...previous }; delete previousRecord._kind;
        return JSON.stringify(currentRecord) !== JSON.stringify(previousRecord);
      });
      const collection = boardsRef.doc(state.boardId).collection('elements');
      if (state.isNew) {
        const contentRef = boardsRef.doc(state.boardId).collection('content').doc('elements');
        const provisionalId = current.id;
        let nextId;
        await db.runTransaction(async (transaction) => {
          const snap = await transaction.get(contentRef);
          nextId = Math.max(
            snapshot.reduce((max, element) => Math.max(max, Number(element.id) + 1), 1),
            Number(snap.get('nextElementId')) || 1
          );
          state.pendingId = nextId;
          const record = { ...current, id: nextId }; delete record._kind;
          transaction.set(collection.doc(String(nextId)), { elementJson: JSON.stringify(record), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          changed.forEach((element) => {
            const shifted = { ...element }; delete shifted._kind;
            transaction.set(collection.doc(String(element.id)), { elementJson: JSON.stringify(shifted), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          });
          transaction.set(contentRef, { nextElementId: nextId + 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        const replaceId = (element) => element.id === provisionalId ? { ...element, id: nextId } : element;
        state.baseElements = state.baseElements.map(replaceId);
        state.layoutElements = state.layoutElements.map(replaceId);
        state.item = replaceId(state.item);
        state.isNew = false;
        elements = elements.map(replaceId);
      } else {
        const savedCurrent = state.savedElements.find((el) => el.id === current.id);
        const currentRecord = { ...current }; delete currentRecord._kind;
        const previousRecord = { ...(savedCurrent || {}) }; delete previousRecord._kind;
        if (!changed.length && JSON.stringify(currentRecord) === JSON.stringify(previousRecord)) return;
        const batch = db.batch();
        [current, ...changed].forEach((item) => {
          const record = { ...item }; delete record._kind;
          batch.set(collection.doc(String(item.id)), { elementJson: JSON.stringify(record), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        await batch.commit();
      }
      state.savedElements = state.layoutElements.map(cloneElement);
      const latest = state.layoutElements.find((el) => el.id === state.item.id);
      if (latest) {
        state.item = latest;
        const index = elements.findIndex((el) => el.id === latest.id);
        if (index >= 0) elements[index] = latest;
      }
      $('#save-state').textContent = 'Saved to shared Firebase';
    }).catch((error) => {
      lastSaveError = error.message;
      $('#save-state').textContent = 'Save failed';
      notice(`Could not save text: ${error.message}`);
    });
    return state.savePromise;
  }

  function closeTextElementEditor(state = textElementEditor) {
    if (!state) return;
    clearTimeout(textElementSaveTimer);
    state.item = { ...state.item, ...readRichEditor(state.node) };
    if (state.isNew && !state.item.text.trim()) {
      if (textElementEditor === state) textElementEditor = null;
      state.node.remove();
      elements = state.baseElements.filter((element) => element.id !== state.item.id);
      if (selectedBoard?.id === state.boardId) {
        selectedBoard.elementCount = elements.length;
        $('#selected-board-meta').textContent = `${elements.length} elements · ${selectedBoard.sourceSection || selectedBoard.sourceNotebook || 'Firebase'}`;
      }
      $('#save-state').textContent = 'Edit canceled';
      renderCanvas();
      return;
    }
    updateTextElementFlow(state);
    if (textElementEditor === state) textElementEditor = null;
    state.node.remove();
    const index = elements.findIndex((el) => el.id === state.item.id);
    if (index >= 0) elements[index] = state.item;
    void persistTextElement(state);
    renderCanvas();
  }

  function startTextElementEditor(item, options = {}) {
    if (!selectedBoard || !item || item._kind !== 'textbox' || item.isPageBody) return;
    closePageBodyEditor();
    closeTextElementEditor();
    closeTableEditor();
    selection = new Set();
    const editor = document.createElement('div');
    editor.className = 'page-body-editor text-element-editor';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', 'Edit sketch text');
    editor.setAttribute('aria-multiline', 'true');
    editor.spellcheck = true;
    richEditorContent(editor, String(item.text || ''), item.fontRuns);
    const initialElements = elements.map(cloneElement);
    const state = { boardId: selectedBoard.id, item: { ...item }, node: editor, isNew: Boolean(options.isNew), baseHeight: Math.max(1, Number(item.h) || 1), baseElements: initialElements, savedElements: initialElements.map(cloneElement), layoutElements: initialElements.map(cloneElement), savePromise: Promise.resolve() };
    textElementEditor = state;
    $('.sketch-drawing-area').append(editor);
    positionTextElementEditor();
    editor.addEventListener('input', () => {
      updateTextElementFlow(state);
      $('#save-state').textContent = 'Saving…';
      queueTextElementSave(state);
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault(); closeTextElementEditor(state);
      }
    });
    editor.addEventListener('blur', event => {
      if (textElementEditor === state && !usingFormatToolbar(event.relatedTarget)) closeTextElementEditor(state);
    });
    editor.addEventListener('paste', (event) => handleSketchEditorPaste(event, editor));
    enableCodeFormatting(editor, () => { updateTextElementFlow(state); queueTextElementSave(state); });
    editor.focus({ preventScroll: true });
    if (Number.isFinite(options.clientX) && Number.isFinite(options.clientY)) caretAtPoint(editor, options.clientX, options.clientY);
    else caretAtEnd(editor);
    renderCanvas();
  }

  function startBlankTextEditor(worldPoint, options = {}) {
    if (!selectedBoard || !worldPoint) return;
    closePageBodyEditor();
    closeTextElementEditor();
    const area = $('.sketch-drawing-area');
    const item = {
      type: 'com.impactyn.taskmanager.data.entities.SketchElement.TextBox', kind: 'textbox', _kind: 'textbox',
      id: nextProvisionalTextId--, x: Number(worldPoint.x) || 0, y: Number(worldPoint.y) || 0,
      w: Math.max(320, Math.min(1600, (area.clientWidth - 72) / zoomFactor)), h: 40, text: '',
      fontSize: Number($('#board-font-size').value) || 20,
      fontFamily: $('#board-font-family').value || 'Arial', colorArgb: activeColor, borderWidth: 0
    };
    elements = [...elements, item];
    startTextElementEditor(item, { ...options, isNew: true });
  }

  function updateTextElementFlow(state) {
    const rich = readRichEditor(state.node);
    const text = rich.text;
    const original = state.baseElements.find((el) => el.id === state.item.id);
    if (!original) return;
    const baseBox = elementBounds(original);
    state.node.style.minHeight = `${Math.max(40, state.baseHeight * imageLayout.scale)}px`;
    const measuredHeight = state.node.scrollHeight / Math.max(0.01, imageLayout.scale);
    const height = Math.max(state.baseHeight, measuredHeight);
    const delta = height - state.baseHeight;
    const layout = state.baseElements.map((element) => {
      if (element.id === original.id) return { ...element, text, fontRuns: rich.fontRuns, h: height };
      if (!delta || element.isPageBody) return element;
      const box = elementBounds(element);
      const followsVertically = box.y >= baseBox.y + baseBox.h - 2;
      const sharesTextColumn = box.x < baseBox.x + baseBox.w - 12 && box.x + box.w > baseBox.x + 12;
      return followsVertically && sharesTextColumn ? moveElement(element, 0, delta) : element;
    });
    state.layoutElements = layout;
    state.item = layout.find((element) => element.id === original.id) || state.item;
    elements = elements.map((element) => layout.find((updated) => updated.id === element.id) || element);
    if (selectedBoard?.id === state.boardId) {
      selectedBoard.elementCount = elements.length;
      $('#selected-board-meta').textContent = `${elements.length} elements · ${selectedBoard.sourceSection || selectedBoard.sourceNotebook || 'Firebase'}`;
    }
    state.node.style.minHeight = `${Math.max(40, height * imageLayout.scale)}px`;
    if (selectedBoard?.id === state.boardId) {
      renderCanvas();
    }
  }

  function caretAtEnd(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  }

  function caretAtPoint(node, clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return caretAtEnd(node);
    let range = null;
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    if (position && node.contains(position.offsetNode)) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    } else {
      const found = document.caretRangeFromPoint?.(clientX, clientY);
      if (found && node.contains(found.startContainer)) range = found;
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (range) selection.addRange(range); else caretAtEnd(node);
  }

  function updateLocalPageBody(state, render = true) {
    const item = pageBodyDraft(state);
    const baseElements = state.baseElements || elements.map(cloneElement);
    const original = baseElements.find(isPageBody);
    const baseItem = original || state.item;
    const baseBox = elementBounds(baseItem);
    const delta = item.h - (Number(state.baseHeight) || 40);
    const knownIds = new Set(baseElements.map((element) => element.id));
    const addedElements = elements.filter((element) => !knownIds.has(element.id) && !isPageBody(element));
    const layout = baseElements.map((element) => {
      if (isPageBody(element)) return { ...item, id: element.id };
      if (!delta) return element;
      const box = elementBounds(element);
      const followsVertically = box.y >= baseBox.y + baseBox.h - 2;
      const sharesTextColumn = box.x < baseBox.x + baseBox.w - 12 && box.x + box.w > baseBox.x + 12;
      return followsVertically && sharesTextColumn ? moveElement(element, 0, delta) : element;
    });
    layout.push(...addedElements);
    if (!original && (item.text || item.id)) layout.push(item);
    state.layoutElements = layout;
    state.item = item;
    elements = layout;
    elements.sort((a, b) => a.id - b.id);
    if (selectedBoard?.id === state.boardId) {
      selectedBoard.elementCount = elements.length;
      $('#selected-board-meta').textContent = `${elements.length} elements · ${selectedBoard.sourceSection || selectedBoard.sourceNotebook || 'Firebase'}`;
      if (render) renderCanvas();
    }
    return item;
  }

  function queuePageBodySave(state, immediate = false) {
    clearTimeout(pageBodySaveTimer);
    if (immediate) { void persistPageBody(state); return; }
    pageBodySaveTimer = setTimeout(() => persistPageBody(state), 900);
  }

  function persistPageBody(state) {
    state.savePromise = (state.savePromise || Promise.resolve()).catch(() => {}).then(async () => {
      const draft = pageBodyDraft(state);
      if (!draft.text.trim() && !draft.id) return;
      const changedElements = (state.layoutElements || []).filter((element) => {
        if (isPageBody(element)) return false;
        const previous = (state.savedElements || []).find((saved) => saved.id === element.id);
        if (!previous) return false;
        const currentRecord = { ...element }; delete currentRecord._kind;
        const previousRecord = { ...previous }; delete previousRecord._kind;
        return JSON.stringify(currentRecord) !== JSON.stringify(previousRecord);
      });
      if (draft.id && draft.text === state.lastSavedText && JSON.stringify(draft.fontRuns || []) === state.lastSavedFontRuns && !changedElements.length) return;
      const item = { ...draft }; delete item._kind;
      const collection = boardsRef.doc(state.boardId).collection('elements');
      if (Number(item.id) > 0) {
        const batch = db.batch();
        batch.set(collection.doc(String(item.id)), { elementJson: JSON.stringify(item), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        changedElements.forEach((element) => {
          const record = { ...element }; delete record._kind;
          batch.set(collection.doc(String(element.id)), { elementJson: JSON.stringify(record), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        await batch.commit();
      } else {
        const contentRef = boardsRef.doc(state.boardId).collection('content').doc('elements');
        await db.runTransaction(async (transaction) => {
          const snap = await transaction.get(contentRef);
          const nextId = Math.max(
            selectedBoard?.id === state.boardId ? elements.reduce((max, el) => Math.max(max, Number(el.id) + 1), 1) : 1,
            Number(snap.get('nextElementId')) || 1
          );
          item.id = nextId;
          transaction.set(collection.doc(String(nextId)), { elementJson: JSON.stringify(item), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          changedElements.forEach((element) => {
            const record = { ...element }; delete record._kind;
            transaction.set(collection.doc(String(element.id)), { elementJson: JSON.stringify(record), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          });
          transaction.set(contentRef, { nextElementId: nextId + 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        state.item.id = item.id;
        const bodyDraft = state.layoutElements?.find(isPageBody);
        if (bodyDraft) bodyDraft.id = item.id;
      }
      state.item = { ...item, _kind: 'textbox' };
      state.lastSavedText = item.text; state.lastSavedFontRuns = JSON.stringify(item.fontRuns || []);
      changedElements.forEach((element) => {
        const savedIndex = state.savedElements.findIndex((saved) => saved.id === element.id);
        if (savedIndex >= 0) state.savedElements[savedIndex] = cloneElement(element);
      });
      if (selectedBoard?.id === state.boardId) updateLocalPageBody(state);
      $('#save-state').textContent = 'Saved to shared Firebase';
    }).catch((error) => {
      lastSaveError = error.message;
      $('#save-state').textContent = 'Save failed';
      notice(`Could not save page text: ${error.message}`);
    });
    return state.savePromise;
  }

  function closePageBodyEditor(state = pageBodyEditor) {
    if (!state) return;
    clearTimeout(pageBodySaveTimer);
    pageBodyDraft(state);
    if (pageBodyEditor === state) pageBodyEditor = null;
    state.node.remove();
    updateLocalPageBody(state);
    void persistPageBody(state);
    if (!$('.page-body-editor')) canvas.focus({ preventScroll: true });
  }

  function startPageBodyEditor(worldPoint, initialText = '', options = {}) {
    if (!selectedBoard) return;
    closeTableEditor();
    closeTextElementEditor();
    let state = pageBodyEditor;
    if (!state || state.boardId !== selectedBoard.id || !state.node.isConnected) {
      const existing = elements.find(isPageBody);
      const area = $('.sketch-drawing-area');
      const text = String(existing?.text || '');
      const item = existing ? { ...existing } : {
        type: 'com.impactyn.taskmanager.data.entities.SketchElement.TextBox', kind: 'textbox', _kind: 'textbox',
        id: 0, isPageBody: true, x: Number(worldPoint?.x) || 0, y: Number(worldPoint?.y) || 0,
        w: Math.max(320, Math.min(1600, (area.clientWidth - 72) / zoomFactor)), h: 40,
        fontSize: Number($('#board-font-size').value) || 20,
        fontFamily: $('#board-font-family').value || 'Arial', colorArgb: activeColor, borderWidth: 0
      };
      const initialElements = elements.map(cloneElement);
      state = { boardId: selectedBoard.id, item, text, lastSavedText: existing?.text || '', baseHeight: Math.max(40, Number(item.h) || 40), baseElements: initialElements, savedElements: initialElements.map(cloneElement), layoutElements: initialElements.map(cloneElement), savePromise: Promise.resolve() };
      const editor = document.createElement('div');
      editor.className = 'page-body-editor';
      editor.contentEditable = 'true';
      editor.setAttribute('role', 'textbox');
      editor.setAttribute('aria-label', 'Notebook page text');
      editor.setAttribute('aria-multiline', 'true');
      editor.dataset.placeholder = elements.some((element) => !isPageBody(element)) ? '' : 'Click anywhere and keep typing…';
      editor.spellcheck = true;
      richEditorContent(editor, text, item.fontRuns);
      state.node = editor;
      pageBodyEditor = state;
      area.append(editor);
      positionPageBodyEditor();
      editor.addEventListener('input', () => {
        state.text = editor.innerText.replace(/\r\n?/g, '\n');
        const oldHeight = Number(state.item.h) || 40;
        editor.style.minHeight = `${Math.max(40, state.baseHeight * imageLayout.scale)}px`;
        const item = updateLocalPageBody(state, false);
        if (Math.abs(item.h - oldHeight) > 1) renderCanvas();
        $('#save-state').textContent = 'Saving…';
        queuePageBodySave(state);
      });
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closePageBodyEditor(state); }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); closePageBodyEditor(state); }
      });
      editor.addEventListener('blur', event => {
        if (pageBodyEditor === state && !usingFormatToolbar(event.relatedTarget)) closePageBodyEditor(state);
      });
      editor.addEventListener('paste', (event) => handleSketchEditorPaste(event, editor));
      enableCodeFormatting(editor, () => { updateLocalPageBody(state); queuePageBodySave(state); });
    }

    if (initialText) {
      state.node.focus({ preventScroll: true });
      if (options.insertText) {
        if (Number.isFinite(options.clientX) && Number.isFinite(options.clientY)) caretAtPoint(state.node, options.clientX, options.clientY);
        else caretAtEnd(state.node);
        document.execCommand('insertText', false, initialText);
      } else if (options.append && state.node.textContent) {
        state.node.append(document.createTextNode(`${state.node.textContent.endsWith('\n') ? '' : '\n'}${initialText}`));
      } else if (!state.node.textContent) state.node.textContent = initialText;
      state.text = state.node.innerText.replace(/\r\n?/g, '\n');
      caretAtEnd(state.node);
      updateLocalPageBody(state);
      queuePageBodySave(state);
    } else {
      state.node.focus({ preventScroll: true });
      if (Number.isFinite(options.clientX) && Number.isFinite(options.clientY)) caretAtPoint(state.node, options.clientX, options.clientY);
    }
    positionPageBodyEditor();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!selectedBoard) return;
    const p = point(event);
    lastCanvasPoint = p;
      if (activeTool === 'TEXT') {
      event.preventDefault();
      const textHit = [...elements].reverse().find((el) => el._kind === 'textbox' && (() => { const b = elementBounds(el); return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; })());
      if (textHit && !textHit.isPageBody) {
        startTextElementEditor(textHit, { clientX: event.clientX, clientY: event.clientY });
        return;
      }
      if (textHit?.isPageBody) startPageBodyEditor(p, '', { clientX: event.clientX, clientY: event.clientY });
      else startBlankTextEditor(p, { clientX: event.clientX, clientY: event.clientY });
      return;
    }
    canvas.focus({ preventScroll: true });
    if(activeTool==='IMAGE'){const url=prompt('Paste an image, GIF, video, or document URL:');if(url?.trim()){const u=url.trim();const mime=u.toLowerCase().match(/\.(gif|png|jpe?g|webp|svg|mp4|webm|pdf)(?:\?|$)/)?.[1]||'';const map={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',mp4:'video/mp4',webm:'video/webm',pdf:'application/pdf'};saveElement({_kind:'image',type:'com.impactyn.taskmanager.data.entities.SketchElement.Image',x:p.x,y:p.y,w:480,h:280,uriString:u,mimeType:map[mime]||'',mediaName:u.split('/').pop()||'Linked media'});}return;}
    if(activeTool==='TREE'){const selected=elements.find(el=>selection.has(el.id)&&el._kind==='treenode');const id=elements.reduce((m,el)=>Math.max(m,el.id+1),1);const node={_kind:'treenode',type:'com.impactyn.taskmanager.data.entities.SketchElement.TreeNode',id,parentId:selected?.id??null,x:p.x,y:p.y,w:180,h:68,text:selected?'Decision':'Root decision',colorArgb:activeColor,orientation:'VERTICAL',collapsed:false};saveElement(node);return;}
    if(activeTool==='CONNECTOR'){const hit=[...elements].reverse().find(el=>{const b=elementBounds(el);return p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h;});if(!hit)return showToast('Tap a shape or text box to start a connector');if(connectorStartId===null){connectorStartId=hit.id;return showToast('Now tap the connected shape');}if(connectorStartId!==hit.id){saveElement({_kind:'connector',type:'com.impactyn.taskmanager.data.entities.SketchElement.Connector',fromId:connectorStartId,toId:hit.id,colorArgb:activeColor,strokeWidth:2,curveStyle:'STRAIGHT'});}connectorStartId=null;return;}
    if (activeTool === 'SELECT') {
      let hit = [...elements].reverse().find((el) => { const b=elementBounds(el); return p.x>=b.x-6&&p.x<=b.x+b.w+6&&p.y>=b.y-6&&p.y<=b.y+b.h+6; });
      if (hit?.isPageBody && event.pointerType === 'pen' && !event.shiftKey) hit = null;
      if (hit?._kind === 'textbox' && event.pointerType !== 'pen' && !event.shiftKey) {
        event.preventDefault();
        if (hit.isPageBody) startPageBodyEditor(p, '', { clientX: event.clientX, clientY: event.clientY });
        else startTextElementEditor(hit, { clientX: event.clientX, clientY: event.clientY });
        return;
      }
      if ((!hit || hit.isPageBody) && event.pointerType !== 'pen' && !event.shiftKey) {
        event.preventDefault();
        if (!hit) selection = new Set();
        if (hit?.isPageBody) startPageBodyEditor(p, '', { clientX: event.clientX, clientY: event.clientY });
        else startBlankTextEditor(p, { clientX: event.clientX, clientY: event.clientY });
        return;
      }
      if (!hit && event.pointerType === 'pen') {
        // Keep stylus writing available in the default click-to-type mode.
      } else {
        canvas.setPointerCapture(event.pointerId);
        if (event.shiftKey) {
          if (hit) { if (selection.has(hit.id)) selection.delete(hit.id); else selection.add(hit.id); }
        } else selection = hit ? new Set([hit.id]) : new Set();
        moveSnapshot=elements.map(el=>({...el,points:el.points?.map(pt=>({...pt}))})); moveStart = hit && selection.has(hit.id) ? p : null; drawing = Boolean(moveStart); renderCanvas(); return;
      }
    }
    canvas.setPointerCapture(event.pointerId);
    if (activeTool === 'LASSO') {
      lassoStart = p; lassoRect = { x:p.x, y:p.y, w:0, h:0 }; drawing = true; renderCanvas(); return;
    }
    if (['RECT','ELLIPSE','DIAMOND','LINE','TABLE'].includes(activeTool)) {
      drawing=true; shapeStart=p;
      shapePreview = activeTool==='TABLE'
        ? {_kind:'table',id:-1,x:p.x,y:p.y,w:0,h:0,rows:3,cols:3,colorArgb:activeColor,strokeWidth:2,cellText:{}}
        : {_kind:'shape',id:-1,shapeType:activeTool,x:p.x,y:p.y,w:0,h:0,colorArgb:activeColor,strokeWidth:2};
      renderCanvas(); return;
    }
    drawing = true;
    currentStroke = { type: activeTool==='CURVE'?'com.impactyn.taskmanager.data.entities.SketchElement.Curve':'com.impactyn.taskmanager.data.entities.SketchElement.Stroke', id: 0, colorArgb: erase ? 0 : (activeTool==='HIGHLIGHTER' ? ((activeColor & 0x00FFFFFF) | 0x66000000) : activeColor), strokeWidth: erase ? 18 : 4, isEraser: erase, isHighlighter: activeTool==='HIGHLIGHTER', points: [p], _kind: activeTool==='CURVE'?'curve':'stroke' };
    renderCanvas();
  });
  canvas.addEventListener('dblclick', (event) => {
    if (!selectedBoard) return;
    const p = point(event);
    const tableHit = [...elements].reverse().find((el) => el._kind === 'table' && (() => { const b = elementBounds(el); return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; })());
    if (tableHit) { event.preventDefault(); startTableEditor(tableHit); return; }
    const hit = [...elements].reverse().find((el) => el._kind === 'textbox' && (() => { const b = elementBounds(el); return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; })());
    if (hit) { event.preventDefault(); startTextElementEditor(hit); }
  });
  canvas.addEventListener('pointermove', (event) => {
    const p=point(event); lastCanvasPoint=p; if (!drawing) return;
    if (currentStroke) currentStroke.points.push(p);
    else if (lassoStart) { lassoRect={x:Math.min(lassoStart.x,p.x),y:Math.min(lassoStart.y,p.y),w:Math.abs(p.x-lassoStart.x),h:Math.abs(p.y-lassoStart.y)}; }
    else if (shapePreview&&shapeStart) { shapePreview.w=p.x-shapeStart.x; shapePreview.h=p.y-shapeStart.y; }
    else if (moveStart&&selection.size) { const dx=p.x-moveStart.x,dy=p.y-moveStart.y; elements=elements.map(el=>selection.has(el.id)?moveElement(el,dx,dy):el); moveStart=p; }
    requestCanvasRender();
  });
  async function endStroke() {
    if (!drawing) return;
    drawing = false;
    if (lassoStart) {
      const box=lassoRect; lassoStart=null; lassoRect=null;
      if (box && (box.w > 3 || box.h > 3)) {
        const matches=elements.filter(el=>{const b=elementBounds(el);return b.x<=box.x+box.w&&b.x+b.w>=box.x&&b.y<=box.y+box.h&&b.y+b.h>=box.y;});
        selection=new Set(matches.map(el=>el.id));
      }
      renderCanvas(); return;
    }
    if (shapePreview) {
      const shape=shapePreview; shapePreview=null; shapeStart=null;
      if (shape._kind==='shape' ? Math.abs(shape.w)>4&&Math.abs(shape.h)>4 : Math.abs(shape.w)>30&&Math.abs(shape.h)>30) {
        if(shape._kind==='shape'&&shape.shapeType!=='LINE'){shape.x=Math.min(shape.x,shape.x+shape.w);shape.y=Math.min(shape.y,shape.y+shape.h);shape.w=Math.max(24,Math.abs(shape.w));shape.h=Math.max(24,Math.abs(shape.h));}
        saveElement(shape);
      } else renderCanvas();
      return;
    }
    if (moveStart) { const before=moveSnapshot||[];moveStart=null;moveSnapshot=null; void saveElements(elements,before).catch(()=>{}); return; }
    if (!currentStroke) return;
    let stroke = currentStroke; currentStroke = null;
    if (stroke.points.length < 2) { renderCanvas(); return; }
    try {
      $('#save-state').textContent = 'Saving to Firebase…';
      if(activeTool==='RECOGNIZE'){
        const xs=stroke.points.map(p=>p.x),ys=stroke.points.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),w=maxX-minX,h=maxY-minY;
        const first=stroke.points[0],last=stroke.points[stroke.points.length-1],closed=Math.hypot(last.x-first.x,last.y-first.y)<Math.max(18,Math.max(w,h)*0.16);
        const length=stroke.points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-stroke.points[i].x,p.y-stroke.points[i].y),0),direct=Math.hypot(last.x-first.x,last.y-first.y);
        if(closed&&w>8&&h>8){
          const ratio=Math.max(w,h)/Math.max(1,Math.min(w,h));
          const ellipse=ratio<1.3;
          stroke={_kind:'shape',type:'com.impactyn.taskmanager.data.entities.SketchElement.Shape',shapeType:ellipse?'ELLIPSE':'RECT',x:minX,y:minY,w:Math.max(24,w),h:Math.max(24,h),colorArgb:activeColor,strokeWidth:4};
        }else if(direct>1&&length/direct<1.16){stroke={_kind:'shape',type:'com.impactyn.taskmanager.data.entities.SketchElement.Shape',shapeType:'LINE',x:first.x,y:first.y,w:last.x-first.x,h:last.y-first.y,colorArgb:activeColor,strokeWidth:4};}
        else {notice('Could not recognize that stroke. Try a more closed, simple shape.');renderCanvas();return;}
      }
      recordUndo(); await persistElement(stroke);
      lastSaveError = ''; $('#save-state').textContent = 'Saved to shared Firebase';
    } catch (error) {
      lastSaveError = error.message; $('#save-state').textContent = 'Save failed';
      notice(`The stroke is visible on this page but did not save: ${error.message}`);
    }
    renderCanvas();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  async function persistElement(item, boardId = selectedBoard.id) {
    const contentRef=boardsRef.doc(boardId).collection('content').doc('elements');
    await db.runTransaction(async transaction=>{
      const snap=await transaction.get(contentRef);
      const nextId=Math.max(elements.reduce((m,e)=>Math.max(m,e.id+1),1),Number(snap.get('nextElementId'))||1);
      const record={...item,id:nextId};delete record._kind;
      transaction.set(boardsRef.doc(boardId).collection('elements').doc(String(nextId)),{elementJson:JSON.stringify(record),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      transaction.set(contentRef,{nextElementId:nextId+1,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      item.id=nextId;
    });
  }
  function cloneElement(el) { return JSON.parse(JSON.stringify(el)); }
  function recordUndo(snapshot=elements) { undoStack.push(snapshot.map(cloneElement)); if(undoStack.length>40)undoStack.shift(); redoStack.length=0; }
  async function saveElement(item) { try { recordUndo();await persistElement(item);lastSaveError='';$('#save-state').textContent='Saved to shared Firebase';if(!elements.some((element)=>element.id===item.id))elements=[...elements,item].sort((a,b)=>a.id-b.id);renderCanvas();return true; } catch(error) { lastSaveError=error.message;notice(`Could not save element: ${error.message}`);return false; } }
  function selectedElements() { return elements.filter((el) => selection.has(el.id)); }
  async function formatSelectedText(updates) {
    const picked = selectedElements().filter((el) => el._kind === 'textbox' || el._kind === 'treenode');
    if (!picked.length) return;
    const before = elements.map(cloneElement);
    recordUndo(before);
    elements = elements.map((el) => selection.has(el.id) && (el._kind === 'textbox' || el._kind === 'treenode') ? { ...el, ...updates } : el);
    try {
      const col = boardsRef.doc(selectedBoard.id).collection('elements');
      for (let i = 0; i < picked.length; i += 450) {
        const batch = db.batch();
        picked.slice(i, i + 450).forEach((el) => {
          const updated = elements.find((item) => item.id === el.id);
          const record = { ...updated }; delete record._kind;
          batch.set(col.doc(String(updated.id)), { elementJson: JSON.stringify(record), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        await batch.commit();
      }
      renderCanvas();
      showToast('Text formatting saved');
    } catch (error) { elements = before; renderCanvas(); notice(`Could not format text: ${error.message}`); }
  }
  async function copySelection() {
    const picked = selectedElements();
    if (!picked.length) return showToast('Select something on the page first');
    clipboardElements = picked.map(cloneElement);
    clipboardPlain = picked.filter((el) => el._kind === 'textbox' || el._kind === 'treenode').map((el) => el.text || '').filter(Boolean).join('\n') || `${picked.length} sketch element${picked.length === 1 ? '' : 's'}`;
    try { await navigator.clipboard?.writeText(clipboardPlain); } catch { /* In-memory sketch copy still works. */ }
    showToast(`Copied ${picked.length} item${picked.length === 1 ? '' : 's'} — paste with Ctrl/Cmd+V`);
  }
  async function pasteElements(items = clipboardElements) {
    if (!selectedBoard) return showToast('Choose a page before pasting');
    if (!items.length) return showToast('Copy a sketch item first, or paste text from your clipboard');
    recordUndo();
    selection = new Set();
    try {
      for (const source of items) {
        const copy = moveElement(cloneElement(source), 28, 28);
        delete copy.id;
        await persistElement(copy);
        elements.push(copy);
        selection.add(copy.id);
      }
      renderCanvas();
      showToast(`Pasted ${items.length} item${items.length === 1 ? '' : 's'}`);
    } catch (error) { renderCanvas(); notice(`Paste stopped: ${error.message}`); }
  }
  function pasteText(text) {
    if (!selectedBoard || !text.trim()) return;
    startPageBodyEditor(pageCenter(), text.trim(), { append: true });
  }
  async function pasteButtonAction() {
    if (!selectedBoard) return showToast('Choose a page before pasting');
    if (navigator.clipboard?.read) {
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const clipboardItem of clipboardItems) {
          if (clipboardItem.types.includes('text/html')) {
            const html = await (await clipboardItem.getType('text/html')).text();
            if (/<table\b/i.test(html)) {
              if (savedTextSelection?.node.isConnected) { savedTextSelection.node.focus({preventScroll:true}); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(savedTextSelection.range); }
              return pasteTableContent(html, savedTextSelection?.node);
            }
          }
          const mime = clipboardItem.types.find((type) => type.startsWith('image/'));
          if (mime) return pasteImage(await clipboardItem.getType(mime));
          if (clipboardItem.types.includes('text/html')) {
            const html = await (await clipboardItem.getType('text/html')).text();
            const image = imageBlobFromHtml(html);
            if (image) return pasteImage(image);
          }
        }
      } catch (error) { console.info('Clipboard image read needs keyboard paste fallback:', error); }
    }
    try {
      const text = await navigator.clipboard?.readText();
      const image = imageBlobFromHtml(text || '');
      if (image) return pasteImage(image);
      if (text && clipboardElements.length && text === clipboardPlain) return pasteElements();
      if (text?.trim()) return pasteText(text);
    } catch (error) { console.info('Clipboard text read unavailable:', error); }
    if (clipboardElements.length) return pasteElements();
    showToast('Tap Paste, or press Ctrl/Cmd+V to insert the copied image');
  }

  function imageBlobFromHtml(html) {
    if (!html || !/<img\b/i.test(html)) return null;
    const match = html.match(/<img\b[^>]*\bsrc\s*=\s*(["'])(data:image\/[^"']+)\1/i);
    if (!match) return null;
    const dataUrl = match[2];
    const data = dataUrl.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i);
    if (!data) return null;
    try {
      const bytes = data[2] ? Uint8Array.from(atob(data[3]), (character) => character.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data[3]));
      return new Blob([bytes], { type: data[1] });
    } catch { return null; }
  }

  function safeTableColor(value) {
    const probe = document.createElement('span').style;
    probe.color = String(value || '');
    const color = probe.color;
    return color && !/^(?:inherit|initial|unset|revert|currentcolor|transparent)$/i.test(color) && !/var\(|url\(/i.test(color) ? color : '';
  }
  function tableCellBackground(item, row, col) {
    return safeTableColor(item.cellBackgroundColors?.[`${row},${col}`] || item.rowBackgroundColors?.[row] || item.backgroundColor || '');
  }
  function pastedBackgroundReader(doc) {
    const rules = [];
    for (const style of doc.querySelectorAll('style')) {
      try {
        const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent);
        const collect = list => { for (const rule of list) { if (rule.selectorText && rule.style) rules.push(rule); else if (rule.cssRules) collect(rule.cssRules); } };
        collect(sheet.cssRules);
      } catch { /* Inline colors remain available if the copied stylesheet is invalid. */ }
    }
    return element => {
      let winner = safeTableColor(element.getAttribute('bgcolor')), score = -1;
      for (const rule of rules) for (const selector of rule.selectorText.split(',')) {
        try {
          if (!element.matches(selector)) continue;
          const value = safeTableColor(rule.style.backgroundColor); if (!value) continue;
          const weight = (rule.style.getPropertyPriority('background-color') === 'important' ? 1000000 : 0) + (selector.match(/#[\w-]+/g)||[]).length*10000 + (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)||[]).length*100 + (selector.match(/(?:^|[\s>+~])\w+/g)||[]).length;
          if (weight >= score) {score=weight;winner=value;}
        } catch { /* Ignore selectors unsupported by the browser. */ }
      }
      const inline = safeTableColor(element.style.backgroundColor);
      if (inline && (element.style.getPropertyPriority('background-color') === 'important' || score < 1000000)) winner=inline;
      return winner;
    };
  }

  function clipboardTableBlocks(html) {
    if (!/<table\b/i.test(html || '')) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const backgroundOf = pastedBackgroundReader(doc);
    doc.querySelectorAll('script,style,iframe,object,embed,template').forEach(node => node.remove());
    if (!doc.querySelector('table')) return null;
    const plain = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
      const text = [...node.childNodes].map(plain).join('');
      return text + (/^(P|DIV|LI|H[1-6]|TR)$/.test(node.tagName) ? '\n' : '');
    };
    const blocks = []; let text = '';
    const flush = () => { if (text.trim()) blocks.push({kind:'text',text:text.replace(/^\n+|\n+$/g,'')}); text = ''; };
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) { text += node.textContent; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'TABLE') {
        flush(); const grid = [], occupied = [], cellBackgroundColors = {};
        const rows = [...node.rows].filter(row => row.closest('table') === node);
        rows.forEach((row, r) => {
          grid[r] ||= []; occupied[r] ||= []; let c = 0;
          for (const cell of row.cells) {
            while (occupied[r][c]) c++;
            const rs = Math.min(rows.length-r, cell.rowSpan || rows.length-r), cs = Math.max(1, cell.colSpan || 1);
            if (c + cs > 100 || rows.length > 500) throw Error('This table is too large to paste at once. Copy a smaller group of rows.');
            grid[r][c] = plain(cell).replace(/\n+$/,'');
            const background = backgroundOf(cell) || backgroundOf(row) || backgroundOf(row.parentElement) || backgroundOf(node);
            if (background) for(let dr=0;dr<rs;dr++) for(let dc=0;dc<cs;dc++) cellBackgroundColors[`${r+dr},${c+dc}`] = background;
            for (let dr=0;dr<rs;dr++) for(let dc=0;dc<cs;dc++) { occupied[r+dr] ||= []; occupied[r+dr][c+dc] = true; grid[r+dr] ||= []; grid[r+dr][c+dc] ??= ''; }
            c += cs;
          }
        });
        if (grid.length) blocks.push({kind:'table',grid,cellBackgroundColors});
        return;
      }
      if (node.tagName === 'BR') {text += '\n';return;}
      const block = /^(P|DIV|LI|H[1-6])$/.test(node.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      [...node.childNodes].forEach(visit);
      if (block && !text.endsWith('\n')) text += '\n';
    }
    [...doc.body.childNodes].forEach(visit); flush(); return blocks;
  }

  async function pasteTableContent(html, editor = null) {
    let blocks;
    try { blocks = clipboardTableBlocks(html); } catch(error) { notice(error.message); return; }
    if (!blocks?.length || !selectedBoard) return;
    const boardId = selectedBoard.id;
    const state = pageBodyEditor?.node === editor ? pageBodyEditor : textElementEditor?.node === editor ? textElementEditor : null;
    const selectionRange = window.getSelection();
    let beforeText = '', afterText = '';
    if (state) {
      const range = selectionRange?.rangeCount && editor.contains(selectionRange.anchorNode) ? selectionRange.getRangeAt(0).cloneRange() : document.createRange();
      if (!editor.contains(range.startContainer)) {range.selectNodeContents(editor);range.collapse(false);}
      const before = range.cloneRange(), after = range.cloneRange();
      before.selectNodeContents(editor);before.setEnd(range.startContainer,range.startOffset);
      after.selectNodeContents(editor);after.setStart(range.endContainer,range.endOffset);
      const read = fragment => {const node=document.createElement('div');node.append(fragment);return readRichEditor(node);};
      beforeText = read(before.cloneContents());afterText = read(after.cloneContents());
      if (beforeText.text) blocks.unshift({kind:'text',...beforeText});
      if (afterText.text) blocks.push({kind:'text',...afterText});
      if (state === pageBodyEditor) closePageBodyEditor(state); else closeTextElementEditor(state);
      await state.savePromise;
      if (lastSaveError) {notice('Save the current text successfully before pasting a table.');return;}
    }
    if (selectedBoard?.id !== boardId) return;
    const original = state ? elements.find(item => item.id === state.item.id) || state.item : null;
    const origin = original ? elementBounds(original) : lastCanvasPoint || pageCenter();
    const width = Math.max(320, original?.w || 720), fontSize = Number(original?.fontSize) || 20;
    let y = origin.y;
    const added = blocks.map(block => {
      let item;
      if (block.kind === 'table') {
        const rows=block.grid.length, cols=Math.max(1,...block.grid.map(row=>row.length));
        const w=Math.max(width,cols*90), cellText={};
        const rowHeights=block.grid.map((row,r)=>Math.max(28,...Array.from({length:cols},(_,c)=>{
          const text=String(row[c]||'');cellText[`${r},${c}`]=text;
          return 10+16*text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length*7/Math.max(20,w/cols-12))),0);
        })));
        item={type:'com.impactyn.taskmanager.data.entities.SketchElement.Table',_kind:'table',x:origin.x,y,w,h:rowHeights.reduce((a,b)=>a+b,0),rows,cols,cellText,cellBackgroundColors:block.cellBackgroundColors,rowHeights,rowMinHeights:Array(rows).fill(28),colorArgb:original?.colorArgb ?? activeColor,strokeWidth:1};
      } else {
        const lines=block.text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length*fontSize*.6/(width-12))),0);
        item={type:'com.impactyn.taskmanager.data.entities.SketchElement.TextBox',_kind:'textbox',x:origin.x,y,w:width,h:Math.max(32,lines*(fontSize+4)+12),text:block.text,fontRuns:block.fontRuns||[],fontSize,fontFamily:original?.fontFamily||'Arial',colorArgb:original?.colorArgb ?? activeColor,borderWidth:0};
      }
      y += item.h+12; return item;
    });
    const snapshot=elements.map(cloneElement), delta=y-origin.y-(original?.h||0);
    const shifted=elements.filter(item=>item.id!==original?.id).map(item=>{
      const box=elementBounds(item);
      return box.y>=origin.y+(original?.h||0)-2 && box.x<origin.x+width && box.x+box.w>origin.x ? moveElement(item,0,delta) : item;
    });
    try {
      const content=boardsRef.doc(boardId).collection('content').doc('elements'), collection=boardsRef.doc(boardId).collection('elements');
      await db.runTransaction(async transaction=>{
        const snap=await transaction.get(content);
        let nextId=Math.max(Number(snap.get('nextElementId'))||1,...snapshot.map(item=>Number(item.id)+1));
        for(const [index,item] of added.entries()){item.id=index===0 && original?.id ? original.id : nextId++;const record={...item};delete record._kind;transaction.set(collection.doc(String(item.id)),{elementJson:JSON.stringify(record),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});}
        for(const item of shifted){const old=snapshot.find(entry=>entry.id===item.id);if(JSON.stringify(old)===JSON.stringify(item))continue;const record={...item};delete record._kind;transaction.set(collection.doc(String(item.id)),{elementJson:JSON.stringify(record),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});}
        transaction.set(content,{nextElementId:nextId,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      });
      if(selectedBoard?.id===boardId){recordUndo(snapshot);elements=[...shifted,...added];renderCanvas();}
      lastSaveError='';$('#save-state').textContent='Saved to shared Firebase';showToast('Pasted text and editable tables');
    } catch(error){lastSaveError=error.message;notice(`Could not paste table: ${error.message}. Your original content is unchanged.`);}
  }

  function handleSketchEditorPaste(event, editor) {
    const clipboard = event.clipboardData;
    const html = clipboard?.getData('text/html') || '';
    if (/<table\b/i.test(html)) { event.preventDefault(); event.stopPropagation(); void pasteTableContent(html, editor); return; }
    const imageItem = [...(clipboard?.items || [])].find((item) => item.type.toLowerCase().startsWith('image/'));
    const imageFile = imageItem?.getAsFile() || clipboard?.files?.[0];
    if (imageFile?.type?.startsWith('image/')) {
      event.preventDefault();
      event.stopPropagation();
      void pasteImageAtTextCursor(imageFile, editor);
      return;
    }
    const htmlImage = imageBlobFromHtml(clipboard?.getData('text/html') || '');
    if (htmlImage) {
      event.preventDefault();
      event.stopPropagation();
      void pasteImageAtTextCursor(htmlImage, editor);
      return;
    }
    const plain = clipboard?.getData('text/plain');
    if (plain != null) {
      event.preventDefault();
      document.execCommand('insertText', false, plain);
    }
  }

  function rangeWorldPoint(range) {
    const canvasRect = canvas.getBoundingClientRect();
    const rect = range?.getBoundingClientRect?.();
    const x = rect?.left ?? canvasRect.left;
    const y = rect?.top ?? canvasRect.top;
    return {
      x: (x - canvasRect.left - imageLayout.x) / imageLayout.scale + imageLayout.bounds.minX,
      y: (y - canvasRect.top - imageLayout.y) / imageLayout.scale + imageLayout.bounds.minY
    };
  }

  async function pasteImageAtTextCursor(blob, editor) {
    const state = pageBodyEditor?.node === editor ? pageBodyEditor : (textElementEditor?.node === editor ? textElementEditor : null);
    if (!state || !editor.isConnected) return pasteImage(blob);
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return pasteImage(blob);
    const range = selection.getRangeAt(0).cloneRange();
    let width = 320, height = 220;
    try {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch { /* Keep a readable inline-sized placeholder for uncommon image formats. */ }
    if (!editor.isConnected || (pageBodyEditor !== state && textElementEditor !== state)) return pasteImage(blob);

    const worldPoint = rangeWorldPoint(range);
    const lineHeight = Math.max(12, Number(state.item.fontSize) || 20) + 4;
    const reservedLines = Math.max(1, Math.ceil(height / lineHeight));
    editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, '\n'.repeat(reservedLines));
    worldPoint.y += lineHeight;
    const item = await pasteImage(blob, worldPoint, { w: width, h: height });
    if (item && editor.isConnected && (pageBodyEditor === state || textElementEditor === state)) {
      editor.focus({ preventScroll: true });
      if (pageBodyEditor === state) queuePageBodySave(state, true);
      else void persistTextElement(state);
    }
    return item;
  }

  function positionPendingImagePreviews() {
    for (const preview of pendingImagePreviews) {
      const { node, item, boardId } = preview;
      node.hidden = selectedBoard?.id !== boardId;
      node.style.left = `${canvas.offsetLeft + imageLayout.x + (item.x - imageLayout.bounds.minX) * imageLayout.scale}px`;
      node.style.top = `${canvas.offsetTop + imageLayout.y + (item.y - imageLayout.bounds.minY) * imageLayout.scale}px`;
      node.style.width = `${item.w * imageLayout.scale}px`;
      node.querySelector('img').style.height = `${item.h * imageLayout.scale}px`;
    }
  }

  async function pasteImage(blob, placement = null, dimensions = null) {
    if (!selectedBoard) return showToast('Choose a page before pasting an image');
    if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) return showToast('Copy an image, then paste it onto the page');
    if (blob.size < 1 || blob.size > 32 * 1024 * 1024) return notice('This image is too large to save. Images must be 32 MB or smaller.');
    const boardId = selectedBoard.id;
    const mediaRef = db.collection('sketchMedia').doc();
    const key = mediaRef.id;
    const mediaName = blob.name || `pasted-image.${blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`;
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.src = objectUrl;
    try { await image.decode(); } catch { URL.revokeObjectURL(objectUrl); notice('The clipboard image could not be decoded.'); return; }
    image.dataset.objectUrl = objectUrl;
    const w = dimensions?.w || image.naturalWidth;
    const h = dimensions?.h || w * image.naturalHeight / image.naturalWidth;
    const p = placement || lastCanvasPoint || pageCenter();
    const item = { type: 'com.impactyn.taskmanager.data.entities.SketchElement.Image', _kind: 'image', uriString: `firestore-media://${key}`, mediaName, mimeType: blob.type, x: p.x, y: p.y, w, h };
    const node = document.createElement('div'); node.className = 'pasted-image-preview';
    const caption = document.createElement('button'); caption.type = 'button'; caption.textContent = 'Saving image…'; caption.disabled = true;
    node.append(image, caption); $('.sketch-drawing-area').append(node);
    const preview = { node, item, boardId }; pendingImagePreviews.add(preview); positionPendingImagePreviews();
    recordUndo();
    let mediaSaved = false, saving = false, uploadErrorMessage = '';
    const upload = async () => {
      if (saving) return;
      saving = true; caption.disabled = true; caption.textContent = 'Saving image…';
      try {
        if (!mediaSaved) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const chunkSize = 400 * 1024;
          for (let start = 0, chunkIndex = 0; start < bytes.length; start += chunkSize, chunkIndex++) {
            const chunk = bytes.slice(start, Math.min(bytes.length, start + chunkSize));
            await mediaRef.collection('chunks').doc(String(chunkIndex).padStart(5, '0')).set({ chunkIndex, chunkData: firebase.firestore.Blob.fromUint8Array(chunk) });
          }
          await mediaRef.set({ byteLength: bytes.length, mimeType: blob.type, mediaName, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
          mediaSaved = true;
        }
        await persistElement(item, boardId);
        if (selectedBoard?.id === boardId) {
          loadedImages.set(key, image);
          if (!elements.some((element) => element.id === item.id)) elements.push(item);
          // Make the image part of the current text layout, so the next keystroke keeps it.
          for (const state of [pageBodyEditor, textElementEditor]) {
            if (state?.boardId !== boardId) continue;
            state.baseElements = elements.map(cloneElement);
            state.baseHeight = state.item.h;
            state.layoutElements = elements.map(cloneElement);
          }
          $('#save-state').textContent = 'Image saved to shared Firebase';
          if (uploadErrorMessage && $('#firebase-warning').textContent === uploadErrorMessage) notice('');
        } else URL.revokeObjectURL(objectUrl);
        pendingImagePreviews.delete(preview); node.remove(); renderCanvas();
        return item;
      } catch (error) {
        caption.textContent = 'Image not saved · Retry'; caption.disabled = false;
        if (selectedBoard?.id === boardId) {
          $('#save-state').textContent = 'Image not saved';
          uploadErrorMessage = error.code === 'resource-exhausted'
            ? 'Firebase quota is exhausted. This image is visible here but is not saved. Keep this tab open and retry when the quota is available.'
            : `Image is visible but could not save: ${error.message}. Keep this tab open and retry.`;
          notice(uploadErrorMessage);
        }
      } finally { saving = false; }
    };
    caption.addEventListener('click', () => { void upload(); });
    // The preview is already visible; saving must not hold the paste interaction open.
    void upload();
    return item;
  }

  async function imageToEditableTable() {
    const image = selectedElements().find((item) => item._kind === 'image');
    if (!image) return showToast('Select a table image first');
    const rows = Math.min(30, Math.max(1, Number(prompt('How many table rows?', '4')) || 0));
    if (!rows) return;
    const cols = Math.min(20, Math.max(1, Number(prompt('How many table columns?', '3')) || 0));
    if (!cols) return;
    const table = { type: 'com.impactyn.taskmanager.data.entities.SketchElement.Table', _kind: 'table', x: image.x, y: image.y, w: image.w, h: image.h, rows, cols, cellText: {}, referenceImageId: image.id, colorArgb: activeColor, strokeWidth: 1 };
    selection = new Set(); await saveElement(table); selection = new Set([table.id]); startTableEditor(table);
    showToast('Editable grid added. Double-click cells to enter the text from the image.');
  }
  async function deleteSelection() {
    if (!selectedBoard || !selection.size) return;
    recordUndo();
    elements = elements.filter((el) => !selection.has(el.id));
    selection = new Set();
    await replaceBoardElements(elements);
    renderCanvas();
  }
  function moveElement(el,dx,dy) {
    if(el.points)return {...el,points:el.points.map(p=>({...p,x:p.x+dx,y:p.y+dy}))};
    if(el.start&&el.end)return {...el,start:{x:el.start.x+dx,y:el.start.y+dy},end:{x:el.end.x+dx,y:el.end.y+dy}};
    if(el._kind==='connector'&&Number.isFinite(el.x1))return {...el,x1:el.x1+dx,y1:el.y1+dy,x2:el.x2+dx,y2:el.y2+dy};
    return {...el,x:(Number(el.x)||0)+dx,y:(Number(el.y)||0)+dy};
  }
  async function saveElements(updated,before=elements) {
    if (!selectedBoard) return;
    const boardId=selectedBoard.id, collection=boardsRef.doc(boardId).collection('elements');
    const record = element => {const item={...element};delete item._kind;return JSON.stringify(item);};
    const previous=new Map(before.map(item=>[String(item.id),record(item)]));
    const next=new Map(updated.map(item=>[String(item.id),record(item)]));
    const changes=[...next].filter(([id,value])=>previous.get(id)!==value);
    const removed=[...previous.keys()].filter(id=>!next.has(id));
    if(!changes.length&&!removed.length)return;
    recordUndo(before);$('#save-state').textContent='Saving…';
    try {
      const operations=[...changes.map(([id,value])=>({id,value})),...removed.map(id=>({id}))];
      for(let i=0;i<operations.length;i+=400){const batch=db.batch();for(const op of operations.slice(i,i+400)){const ref=collection.doc(op.id);if(op.value===undefined)batch.delete(ref);else batch.set(ref,{elementJson:op.value,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});}await batch.commit();}
      lastSaveError='';$('#save-state').textContent='Saved to shared Firebase';
    } catch(error){lastSaveError=error.message;$('#save-state').textContent='Save failed';notice(`Could not save changed elements: ${error.message}`);throw error;}
  }
  document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>{activeTool=button.dataset.tool;erase=activeTool==='ERASER';document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b===button));canvas.style.cursor=activeTool==='SELECT'?'move':activeTool==='LASSO'?'crosshair':'crosshair';if(activeTool==='TEXT'&&selectedBoard)startPageBodyEditor(pageCenter());}));
  const ribbonGroups = { draw: ['draw', 'shapes'], insert: ['insert'], format: ['format'], page: ['page'], edit: ['edit'], view: ['view'] };
  document.querySelectorAll('[data-ribbon-tab]').forEach((button) => button.addEventListener('click', () => {
    const tab = button.dataset.ribbonTab;
    $('.sketch-ribbon').dataset.ribbon = tab;
    document.querySelectorAll('[data-ribbon-tab]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-ribbon-group]').forEach((group) => { group.hidden = !ribbonGroups[tab].includes(group.dataset.ribbonGroup); });
  }));
  let pageSearchTimer;
  $('#board-filter').addEventListener('input', () => { clearTimeout(pageSearchTimer); pageSearchTimer=setTimeout(buildTree,120); });
  $('#toggle-board-panel').addEventListener('click', () => {
    const layout = $('.sketch-layout'); layout.classList.toggle('boards-hidden');
    const open = !layout.classList.contains('boards-hidden');
    $('#toggle-board-panel').setAttribute('aria-label', open ? 'Hide notebook pages' : 'Show notebook pages');
    $('#toggle-board-panel').title = open ? 'Hide notebook pages' : 'Show notebook pages'; renderCanvas();
  });
  let allPagesCollapsed = false;
  $('#toggle-board-tree').addEventListener('click', () => {
    allPagesCollapsed = !allPagesCollapsed;
    collapsedBoardIds = new Set(allPagesCollapsed ? boards.filter((board) => boards.some((item) => item.parentBoardId === board.id)).map((board) => board.id) : []);
    try { localStorage.setItem('taskflow-sketch-collapsed-pages', JSON.stringify([...collapsedBoardIds])); } catch { /* The current view still updates without persisted preference. */ }
    $('#toggle-board-tree').textContent = allPagesCollapsed ? '⊞' : '⊖';
    $('#toggle-board-tree').title = allPagesCollapsed ? 'Expand all pages' : 'Collapse all pages';
    $('#toggle-board-tree').setAttribute('aria-label', allPagesCollapsed ? 'Expand all pages' : 'Collapse all pages'); buildTree();
  });
  $('#board-copy').addEventListener('click', copySelection);
  $('#board-paste').addEventListener('click', pasteButtonAction);
  $('#board-delete-selection').addEventListener('click', deleteSelection);
  $('#board-image-table').addEventListener('click', imageToEditableTable);
  $('#board-font-size').addEventListener('change', (event) => { event.target.value = String(Math.max(10, Math.min(96, Number(event.target.value) || 20))); formatSelectedText({ fontSize: Number(event.target.value) }); });
  $('#board-font-family').addEventListener('change', (event) => { if (!applySelectedFont(event.target.value)) formatSelectedText({ fontFamily: event.target.value }); });
  function updateZoom(nextZoom, fit = false) {
    const area = $('.sketch-drawing-area');
    const oldCenter = pageCenter();
    if (fit) {
      const bounds = boundsFor(elements);
      const width = Math.max(1, bounds.maxX - bounds.minX), height = Math.max(1, bounds.maxY - bounds.minY);
      zoomFactor = Math.max(0.1, Math.min(1.4, (area.clientWidth - 60) / width, (area.clientHeight - 60) / height));
    } else zoomFactor = Math.max(0.1, Math.min(4, Number(nextZoom) || 1));
    renderCanvas();
    if (fit) { area.scrollTo({ left: 0, top: 0 }); return; }
    const x = imageLayout.x + (oldCenter.x - imageLayout.bounds.minX) * imageLayout.scale;
    const y = imageLayout.y + (oldCenter.y - imageLayout.bounds.minY) * imageLayout.scale;
    area.scrollTo({ left: Math.max(0, x - area.clientWidth / 2), top: Math.max(0, y - area.clientHeight / 2) });
  }
  $('#zoom-in').addEventListener('click', () => updateZoom(zoomFactor + 0.1));
  $('#zoom-out').addEventListener('click', () => updateZoom(zoomFactor - 0.1));
  $('#zoom-label').addEventListener('click', () => updateZoom(1));
  $('#zoom-fit').addEventListener('click', () => updateZoom(zoomFactor, true));
  $('#sketch-exit').addEventListener('click', () => document.querySelector('[data-page="Tasks"]').click());
  $('#sketch-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('#sketch-view').requestFullscreen) await $('#sketch-view').requestFullscreen();
      else showToast('Use the browser full-screen control on this device');
    } catch { showToast('Browser full screen is unavailable here'); }
  });
  let panelWasHiddenBeforeFullscreen = false;
  document.addEventListener('fullscreenchange', () => {
    const fullscreen = document.fullscreenElement === $('#sketch-view');
    $('#sketch-fullscreen').textContent = fullscreen ? '⛶ Exit full screen' : '⛶ Full screen';
    const layout = $('.sketch-layout');
    if (fullscreen) { panelWasHiddenBeforeFullscreen = layout.classList.contains('boards-hidden'); layout.classList.add('boards-hidden'); }
    else layout.classList.toggle('boards-hidden', panelWasHiddenBeforeFullscreen);
    renderCanvas();
  });
  $('#board-color').addEventListener('input',e=>{const v=e.target.value;activeColor=(0xFF000000|parseInt(v.slice(1),16)>>>0);});
  $('#board-color').addEventListener('change', () => formatSelectedText({ colorArgb: activeColor }));
  $('#board-background').addEventListener('change',async e=>{if(!selectedBoard)return;selectedBoard.backgroundPattern=e.target.value;$('.sketch-drawing-area').dataset.pattern=e.target.value;await boardsRef.doc(selectedBoard.id).update({backgroundPattern:e.target.value,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});});
  $('#board-search').addEventListener('click',()=>{const q=prompt('Find text on this page:');if(!q)return;const found=elements.find(el=>String(el.text||'').toLowerCase().includes(q.toLowerCase()));if(found){selection=new Set([found.id]);renderCanvas();showToast('Text found and selected');}else showToast('No matching text on this page');});
  $('#board-export').addEventListener('click',()=>{renderCanvas();const a=document.createElement('a');a.download=`${selectedBoard?.name||'sketch'}.png`;a.href=canvas.toDataURL('image/png');a.click();});
  $('#board-export-json').addEventListener('click',()=>{if(!selectedBoard)return;const payload={format:'taskmanager-sketch-board-v1',board:{id:selectedBoard.id,name:selectedBoard.name,backgroundPattern:selectedBoard.backgroundPattern},elements:elements.map(({_kind,...el})=>el)};const a=document.createElement('a');a.download=`${selectedBoard.name||'sketch'}.json`;a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
  $('#board-import-json').addEventListener('click',()=>$('#board-json-file').click());
  $('#board-json-file').addEventListener('change',async event=>{const file=event.target.files?.[0];event.target.value='';if(!file||!selectedBoard)return;try{const data=JSON.parse(await file.text());const incoming=Array.isArray(data)?data:data.elements;if(!Array.isArray(incoming))throw new Error('JSON must contain an elements array.');if(!confirm(`Replace this page's ${elements.length} elements with ${incoming.length} imported elements?`))return;const normalized=incoming.map((el,i)=>({...el,id:Number(el.id)||i+1,_kind:labelForType(el)}));await saveElements(normalized,elements);elements=normalized;renderCanvas();}catch(error){notice(`JSON import failed: ${error.message}`);}});
  async function replaceBoardElements(updated){const col=boardsRef.doc(selectedBoard.id).collection('elements');const old=await col.get();for(let i=0;i<old.docs.length;i+=400){const batch=db.batch();old.docs.slice(i,i+400).forEach(doc=>batch.delete(doc.ref));await batch.commit();}for(let i=0;i<updated.length;i+=400){const batch=db.batch();updated.slice(i,i+400).forEach(el=>{const item={...el};delete item._kind;batch.set(col.doc(String(item.id)),{elementJson:JSON.stringify(item),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});});await batch.commit();}}
  $('#board-undo').addEventListener('click',async()=>{if(!selectedBoard||!undoStack.length)return;redoStack.push(elements.map(el=>({...el})));elements=undoStack.pop();await replaceBoardElements(elements);renderCanvas();});
  $('#board-redo').addEventListener('click',async()=>{if(!selectedBoard||!redoStack.length)return;undoStack.push(elements.map(el=>({...el})));elements=redoStack.pop();await replaceBoardElements(elements);renderCanvas();});
  $('#board-clear').addEventListener('click',async()=>{if(!selectedBoard||!elements.length)return;if(!confirm(`Clear all ${elements.length} elements from “${selectedBoard.name}”?`))return;recordUndo();elements=[];await replaceBoardElements(elements);renderCanvas();});
  window.addEventListener('keydown', async (event) => {
    if (!document.body.classList.contains('sketch-active')) return;
    const editable = event.target.matches?.('input,textarea,select,[contenteditable]');
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'c' && selection.size && !editable) { event.preventDefault(); copySelection(); return; }
    if (mod && event.key.toLowerCase() === 'x' && selection.size && !editable) { event.preventDefault(); await copySelection(); await deleteSelection(); return; }
    if (mod && event.key.toLowerCase() === 'z' && !editable) {
      event.preventDefault();
      if (event.shiftKey) $('#board-redo').click(); else $('#board-undo').click();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y' && !editable) { event.preventDefault(); $('#board-redo').click(); return; }
    if (event.key === 'Escape' && document.fullscreenElement) { await document.exitFullscreen(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.size && !editable) { event.preventDefault(); await deleteSelection(); return; }
    if (!editable && selectedBoard && (event.target === canvas || event.target === document.body) && event.key.length === 1 && !mod && !event.altKey) {
      event.preventDefault(); startPageBodyEditor(pageCenter(), event.key, { insertText: true });
    }
  });
  window.addEventListener('paste', (event) => {
    if (!document.body.classList.contains('sketch-active') || !selectedBoard) return;
    if (event.defaultPrevented) return;
    const tableHtml = event.clipboardData?.getData('text/html') || '';
    if (/<table\b/i.test(tableHtml) && !event.target.closest?.('input,textarea,select,[contenteditable]')) { event.preventDefault(); void pasteTableContent(tableHtml); return; }
    const clipboardItems = [...(event.clipboardData?.items || [])];
    const imageItem = clipboardItems.find((item) => item.type.toLowerCase().startsWith('image/'));
    const imageFile = imageItem?.getAsFile() || event.clipboardData?.files?.[0];
    const targetEditor = event.target.closest?.('.page-body-editor');
    if (imageFile?.type?.startsWith('image/')) { event.preventDefault(); void (targetEditor ? pasteImageAtTextCursor(imageFile, targetEditor) : pasteImage(imageFile, lastCanvasPoint || pageCenter())); return; }
    const html = event.clipboardData?.getData('text/html') || '';
    const htmlImage = imageBlobFromHtml(html);
    if (htmlImage) { event.preventDefault(); void (targetEditor ? pasteImageAtTextCursor(htmlImage, targetEditor) : pasteImage(htmlImage, lastCanvasPoint || pageCenter())); return; }
    if (event.target.matches?.('input,textarea,select,[contenteditable]')) return;
    const text = event.clipboardData?.getData('text/plain') || '';
    if (text && clipboardElements.length && text === clipboardPlain) { event.preventDefault(); pasteElements(); }
    else if (text.trim()) { event.preventDefault(); pasteText(text); }
    else if (event.clipboardData?.items?.length) showToast('Paste text here; use Media link for an image or video URL');
  });
  // Keep frequent actions reachable without opening another ribbon tab.
  const quickBar = document.createElement('div'); quickBar.className='sketch-quickbar';quickBar.setAttribute('role','toolbar');quickBar.setAttribute('aria-label','Writing and navigation');
  const quickActions=[['Type','[data-tool="TEXT"]','Click the page to type'],['Pen','[data-tool="PEN"]','Draw with a pen'],['Undo','#board-undo','Undo (Ctrl/Cmd+Z)'],['Redo','#board-redo','Redo (Ctrl/Cmd+Shift+Z)']];
  for(const [label,target,title] of quickActions){const button=document.createElement('button');button.type='button';button.className='tool';button.textContent=label;button.title=title;button.addEventListener('pointerdown',event=>event.preventDefault());button.addEventListener('click',()=>$(target).click());quickBar.append(button);}
  const toolsToggle=document.createElement('button');toolsToggle.type='button';toolsToggle.className='tool';toolsToggle.textContent='Hide tools';toolsToggle.setAttribute('aria-expanded','true');
  const ribbon=$('.sketch-ribbon-shell');ribbon.id='sketch-ribbon-controls';toolsToggle.setAttribute('aria-controls',ribbon.id);
  toolsToggle.addEventListener('click',()=>{ribbon.hidden=!ribbon.hidden;toolsToggle.textContent=ribbon.hidden?'Show tools':'Hide tools';toolsToggle.setAttribute('aria-expanded',String(!ribbon.hidden));requestCanvasRender();});quickBar.append(toolsToggle);
  const saveStatus=$('#save-state');saveStatus.setAttribute('role','status');saveStatus.setAttribute('aria-live','polite');quickBar.append(saveStatus);
  $('.editor-heading').after(quickBar);
  const uxStyle=document.createElement('style');uxStyle.textContent=`
    .sketch-toolbar p{display:none}.sketch-toolbar{min-height:40px}.sketch-toolbar h1{font-size:16px}
    .sketch-quickbar{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--line);background:var(--surface);flex-shrink:0;overflow-x:auto}
    .sketch-quickbar .tool{min-height:34px;padding:0 12px;white-space:nowrap}.sketch-quickbar #save-state{margin-left:auto;max-width:210px;overflow:hidden;text-overflow:ellipsis}
    .board-panel .panel-heading{position:sticky;top:-13px;background:var(--surface);z-index:1;padding:10px 0;margin-top:-10px}.board-entry{min-height:38px}.board-entry.active{box-shadow:inset 3px 0 var(--accent)}
    .board-search{height:39px;font-size:12px}.sketch-ribbon-tabs{height:34px}.sketch-ribbon-tabs button{font-size:11px}.sketch-ribbon .tool{min-height:34px}
    .sketch-quickbar button:focus-visible,.sketch-ribbon button:focus-visible,.board-entry:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .sketch-ribbon-shell[hidden]{display:none!important}.editor-heading small{max-width:170px;overflow:hidden;text-overflow:ellipsis}.sketch-drawing-area{scrollbar-width:thin;scrollbar-color:var(--line) transparent}
    @media(max-width:780px){.sketch-quickbar{padding:5px 8px;gap:4px}.sketch-quickbar .tool{padding:0 9px;min-height:36px}.sketch-quickbar #save-state{font-size:9px!important;max-width:115px}.editor-heading .board-actions{display:none}.sketch-toolbar h1{font-size:14px}}
    #sketch-view:fullscreen .sketch-quickbar{padding:3px 7px}#sketch-view:fullscreen .sketch-quickbar .tool{min-height:30px}
  `;document.head.append(uxStyle);
  document.addEventListener('keydown',event=>{
    if(!document.body.classList.contains('sketch-active'))return;
    if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='f'){
      event.preventDefault();$('.sketch-layout').classList.remove('boards-hidden');$('#toggle-board-panel').setAttribute('aria-label','Hide notebook pages');$('#board-filter').focus();$('#board-filter').select();requestCanvasRender();
    }
  });
  $('#save-sketch').addEventListener('click', () => showToast(lastSaveError ? `Save failed: ${lastSaveError}` : 'Sketches save as you draw'));
  new ResizeObserver(requestCanvasRender).observe($('.sketch-drawing-area'));
  new MutationObserver(renderCanvas).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('taskflow:sketches-open', () => { renderCanvas(); if (selectedBoard) selectBoard(selectedBoard); });
  window.addEventListener('resize', requestCanvasRender);
})();
