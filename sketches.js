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
  const auth = app.auth();
  const mediaOwnerEmail = 'ahmed.elmenshawie@gmail.com';
  const supabaseUrl = 'https://dhipmsdnskhxwlnpfwnq.supabase.co';
  const supabasePublishableKey = 'sb_publishable_jr67l19NLBNBqBtz5UpvWQ_dC_Q6Pbo';
  const boardsRef = db.collection('sketchBoards');
  const boardTree = $('#board-tree');
  const canvas = $('#board-canvas');
  const ctx = canvas.getContext('2d');
  const loadedImages = new Map();
  let boards = [];
  let selectedBoard = null;
  let elements = [];
  let boardListener = null;
  let contentListener = null;
  let loadingLegacy = false;
  let drawing = false;
  let erase = false;
  let activeTool = 'PEN';
  let activeColor = 0xFF1B1F1C;
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
  let imageLayout = { scale: 1, x: 0, y: 0, bounds: { minX: 0, minY: 0 } };
  let lastSaveError = '';

  function isMediaOwner(user) {
    return Boolean(user?.emailVerified && user.email?.toLowerCase() === mediaOwnerEmail);
  }

  async function requireMediaOwner() {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in with the owner Google account to load private media.');
    if (!isMediaOwner(user)) throw new Error(`Use the verified Google account ${mediaOwnerEmail} to load private media.`);
    return user;
  }

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
        media.addEventListener(video ? 'loadedmetadata' : 'load', () => { media.dataset.objectUrl = objectUrl; loadedImages.set(key, media); showLinks(); renderCanvas(); }, { once: true });
        media.addEventListener('error', () => { URL.revokeObjectURL(objectUrl); loadedImages.set(key, null); showLinks(); }, { once: true });
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
        url = supabaseUrl + '/storage/v1/object/public/sketch-media/' + encodedPath;
      }
      const mime = mediaMime(el);
      if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
        loadedImages.set(source, { kind: 'document', src: url });
        showLinks(); renderCanvas();
        return;
      }
      const video = mime.startsWith('video/') || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(url);
      const media = video ? document.createElement('video') : new Image();
      if (video) { media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
      media.addEventListener(video ? 'loadedmetadata' : 'load', () => { loadedImages.set(source, media); showLinks(); renderCanvas(); }, { once: true });
      media.addEventListener('error', () => { loadedImages.set(source, null); showLinks(); renderCanvas(); }, { once: true });
      media.src = url;
    } catch (error) {
      console.warn('Could not load external sketch media', source, error);
      loadedImages.set(source, null); showLinks(); renderCanvas();
      if (source.startsWith('supabase-media://')) {
        $('#media-auth-actions').hidden = false;
        $('#media-auth-state').textContent = 'Media could not load: ' + error.message;
        $('#media-sign-in').hidden = true;
      }
    }
  }

  function drawElement(el, imagesOnly = false) {
    const kind = el._kind;
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
      ctx.fillStyle = ink; ctx.font = `${Math.max(10, Number(el.fontSize) || 16)}px sans-serif`;
      const words = String(el.text || '').split(/\s+/); let line = ''; let row = 0;
      for (const word of words) { const next = line ? `${line} ${word}` : word; if (ctx.measureText(next).width > Math.max(20, w - 12) && line) { ctx.fillText(line, x + 6, y + 18 + row * ((Number(el.fontSize) || 16) + 4)); row++; line = word; } else line = next; }
      if (line) ctx.fillText(line, x + 6, y + 18 + row * ((Number(el.fontSize) || 16) + 4), Math.max(20, w - 12));
      if (Number(el.borderWidth) > 0 || kind === 'treenode') { ctx.strokeStyle = color(el.borderColorArgb || el.colorArgb); ctx.strokeRect(x, y, w, h); }
      return;
    }
    if (kind === 'table') {
      ctx.strokeRect(x, y, w, h); const rows = Math.max(1, Number(el.rows) || 1), cols = Math.max(1, Number(el.cols) || 1);
      for (let i = 1; i < rows; i++) { ctx.beginPath(); ctx.moveTo(x, y + h * i / rows); ctx.lineTo(x + w, y + h * i / rows); ctx.stroke(); }
      for (let i = 1; i < cols; i++) { ctx.beginPath(); ctx.moveTo(x + w * i / cols, y); ctx.lineTo(x + w * i / cols, y + h); ctx.stroke(); }
      ctx.fillStyle = ink; ctx.font = '12px sans-serif';
      for (const [cell, text] of Object.entries(el.cellText || {})) {
        const [row, col] = cell.split(/[,:-]/).map(Number);
        if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
        ctx.fillText(String(text), x + col * w / cols + 5, y + row * h / rows + 16, Math.max(10, w / cols - 10));
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

  function renderCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!rect.width || !rect.height) return;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!selectedBoard) { $('#empty-sketch').hidden = false; return; }
    $('.sketch-drawing-area').dataset.pattern = String(selectedBoard.backgroundPattern || 'BLANK').toUpperCase();
    $('#empty-sketch').hidden = elements.length > 0 || drawing;
    if (!elements.length && !drawing) return;
    const b = boundsFor(elements);
    const worldW = Math.max(1, b.maxX - b.minX), worldH = Math.max(1, b.maxY - b.minY);
    const scale = Math.min((rect.width - 30) / worldW, (rect.height - 30) / worldH, 1.4);
    const x = (rect.width - worldW * scale) / 2, y = (rect.height - worldH * scale) / 2;
    imageLayout = { scale, x, y, bounds: b };
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
    for (const element of elements) if (element._kind === 'image') drawElement(element);
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

  function showLinks() {
    let links = $('#sketch-links');
    if (!links) {
      links = document.createElement('div'); links.id = 'sketch-links'; links.className = 'sketch-links';
      $('.editor-panel').insertBefore(links, $('.sketch-canvas-tools'));
    }
    const items = elements.filter((e) => (e._kind === 'textbox' && e.linkUrl) || e._kind === 'image');
    if (!items.length) { links.replaceChildren(); return; }
    links.innerHTML = items.map((e) => {
      const imageSource = String(e.uriString || e.imageUrl || '');
      const mediaKey = imageSource.startsWith('firestore-media://') ? imageSource.slice('firestore-media://'.length) : imageSource;
      const loaded = e._kind === 'image' ? loadedImages.get(mediaKey) : null;
      const hrefValue = e.linkUrl || (loaded?.kind === 'document' ? loaded.src : (e._kind === 'image' && /^https?:\/\//i.test(imageSource) ? imageSource : ''));
      const href = /^https?:\/\//i.test(hrefValue) ? ` href="${escapeHtml(hrefValue)}" target="_blank" rel="noopener noreferrer"` : '';
      const title = e._kind === 'image' ? (e.mediaName || `Image ${e.id}`) : (e.text || 'Open linked media');
      const mimeType = mediaMime(e);
      const preview = loaded && loaded !== 'loading' && (loaded instanceof HTMLVideoElement || mimeType === 'image/gif' || mimeType === 'image/webp')
        ? loaded instanceof HTMLVideoElement
          ? `<video class="sketch-media-preview" controls preload="metadata" playsinline src="${escapeHtml(loaded.src)}"></video>`
          : `<img class="sketch-media-preview" src="${escapeHtml(loaded.src)}" alt="">` : '';
      return `<a class="sketch-link"${href}><span>${e._kind === 'image' ? '▧' : '▶'}</span>${escapeHtml(title)}${preview}</a>`;
    }).join('');
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
    const visited = new Set();
    const rows = [];
    function append(parentId, depth) {
      for (const board of children.get(parentId) || []) {
        if (visited.has(board.id)) continue;
        visited.add(board.id);
        const count = Number(board.elementCount || 0);
        const section = Boolean(board.isSection);
        rows.push(`<div class="board-entry ${section ? 'section-entry' : ''} ${selectedBoard?.id === board.id ? 'active' : ''}" style="padding-left:${8 + Math.min(depth, 7) * 17}px" ${section ? '' : `data-board-id="${escapeHtml(board.id)}"`} title="${escapeHtml(board.name)}"><span aria-hidden="true">${section ? '▸' : (depth ? '↳' : '▱')}</span><span class="board-name">${escapeHtml(board.name || 'Untitled board')}</span><span class="board-count">${count || ''}</span></div>`);
        append(board.id, depth + 1);
      }
    }
    append('', 0);
    for (const board of boards) if (!visited.has(board.id)) append(board.id, 0);
    boardTree.innerHTML = rows.join('');
  }

  function setElements(next) {
    elements = next.map(parseElement).filter(Boolean).sort((a, b) => a.id - b.id);
    if (selectedBoard) selectedBoard.elementCount = elements.length;
    $('#selected-board-meta').textContent = `${elements.length} elements · ${selectedBoard?.sourceSection || selectedBoard?.sourceNotebook || 'Firebase'}`;
    showLinks(); renderCanvas(); buildTree();
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
    if (boardListener) boardListener();
    if (contentListener) contentListener();
    selectedBoard = board;
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

  $('#media-sign-in').addEventListener('click', async () => {
    if (location.protocol === 'file:') {
      notice('Private media sign-in requires this site to be served from HTTPS or localhost.');
      return;
    }
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ login_hint: mediaOwnerEmail });
      const result = await auth.signInWithPopup(provider);
      if (!isMediaOwner(result.user)) {
        await auth.signOut();
        throw new Error(`Sign in with the verified Google account ${mediaOwnerEmail}.`);
      }
    } catch (error) {
      $('#media-auth-actions').hidden = false;
      $('#media-auth-state').textContent = error.message || 'Google sign-in failed.';
    }
  });

  auth.onAuthStateChanged((user) => {
    const allowed = isMediaOwner(user);
    $('#media-auth-actions').hidden = allowed;
    $('#media-sign-in').hidden = allowed;
    if (location.protocol === 'file:') {
      $('#media-auth-state').textContent = 'Open this page over HTTPS or localhost to sign in and load private images.';
    } else if (!allowed) {
      $('#media-auth-state').textContent = `Sign in with ${mediaOwnerEmail} to load private images and videos.`;
    }
    if (user && !allowed) {
      auth.signOut().catch((error) => console.warn('Could not clear an unauthorized media session', error));
      return;
    }
    if (allowed && selectedBoard) {
      for (const [source, value] of loadedImages) {
        if (source.startsWith('supabase-media://') && value === null) loadedImages.delete(source);
      }
      renderCanvas();
    }
  });

  boardTree.addEventListener('click', (event) => {
    const entry = event.target.closest('[data-board-id]');
    if (entry) { const board = boards.find((item) => item.id === entry.dataset.boardId); if (board) selectBoard(board); }
  });

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

  canvas.addEventListener('pointerdown', (event) => {
      if (!selectedBoard) return;
    const p = point(event); canvas.setPointerCapture(event.pointerId);
    if (activeTool === 'TEXT') {
      const text = prompt('Text to add:');
      if (text?.trim()) saveElement({ type: 'com.impactyn.taskmanager.data.entities.SketchElement.TextBox', kind: 'textbox', x:p.x, y:p.y, w:260, h:32, text:text.trim(), fontSize:20, colorArgb:activeColor, borderWidth:0 });
      return;
    }
    if(activeTool==='IMAGE'){const url=prompt('Paste an image, GIF, video, or document URL:');if(url?.trim()){const u=url.trim();const mime=u.toLowerCase().match(/\.(gif|png|jpe?g|webp|svg|mp4|webm|pdf)(?:\?|$)/)?.[1]||'';const map={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',mp4:'video/mp4',webm:'video/webm',pdf:'application/pdf'};saveElement({_kind:'image',type:'com.impactyn.taskmanager.data.entities.SketchElement.Image',x:p.x,y:p.y,w:480,h:280,uriString:u,mimeType:map[mime]||'',mediaName:u.split('/').pop()||'Linked media'});}return;}
    if(activeTool==='TREE'){const selected=elements.find(el=>selection.has(el.id)&&el._kind==='treenode');const id=elements.reduce((m,el)=>Math.max(m,el.id+1),1);const node={_kind:'treenode',type:'com.impactyn.taskmanager.data.entities.SketchElement.TreeNode',id,parentId:selected?.id??null,x:p.x,y:p.y,w:180,h:68,text:selected?'Decision':'Root decision',colorArgb:activeColor,orientation:'VERTICAL',collapsed:false};saveElement(node);return;}
    if(activeTool==='CONNECTOR'){const hit=[...elements].reverse().find(el=>{const b=elementBounds(el);return p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h;});if(!hit)return showToast('Tap a shape or text box to start a connector');if(connectorStartId===null){connectorStartId=hit.id;return showToast('Now tap the connected shape');}if(connectorStartId!==hit.id){saveElement({_kind:'connector',type:'com.impactyn.taskmanager.data.entities.SketchElement.Connector',fromId:connectorStartId,toId:hit.id,colorArgb:activeColor,strokeWidth:2,curveStyle:'STRAIGHT'});}connectorStartId=null;return;}
    if (activeTool === 'SELECT') {
      const hit = [...elements].reverse().find((el) => { const b=elementBounds(el); return p.x>=b.x-6&&p.x<=b.x+b.w+6&&p.y>=b.y-6&&p.y<=b.y+b.h+6; });
      if (event.shiftKey) {
        if (hit) { if (selection.has(hit.id)) selection.delete(hit.id); else selection.add(hit.id); }
      } else selection = hit ? new Set([hit.id]) : new Set();
      moveSnapshot=elements.map(el=>({...el,points:el.points?.map(pt=>({...pt}))})); moveStart = hit && selection.has(hit.id) ? p : null; drawing = Boolean(moveStart); renderCanvas(); return;
    }
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
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return; const p=point(event);
    if (currentStroke) currentStroke.points.push(p);
    else if (lassoStart) { lassoRect={x:Math.min(lassoStart.x,p.x),y:Math.min(lassoStart.y,p.y),w:Math.abs(p.x-lassoStart.x),h:Math.abs(p.y-lassoStart.y)}; }
    else if (shapePreview&&shapeStart) { shapePreview.w=p.x-shapeStart.x; shapePreview.h=p.y-shapeStart.y; }
    else if (moveStart&&selection.size) { const dx=p.x-moveStart.x,dy=p.y-moveStart.y; elements=elements.map(el=>selection.has(el.id)?moveElement(el,dx,dy):el); moveStart=p; }
    renderCanvas();
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
    if (moveStart) { const before=moveSnapshot||[];moveStart=null;moveSnapshot=null; saveElements(elements,before); return; }
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
  async function persistElement(item) {
    const contentRef=boardsRef.doc(selectedBoard.id).collection('content').doc('elements');
    await db.runTransaction(async transaction=>{
      const snap=await transaction.get(contentRef);
      const nextId=Math.max(elements.reduce((m,e)=>Math.max(m,e.id+1),1),Number(snap.get('nextElementId'))||1);
      const record={...item,id:nextId};delete record._kind;
      transaction.set(boardsRef.doc(selectedBoard.id).collection('elements').doc(String(nextId)),{elementJson:JSON.stringify(record),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      transaction.set(contentRef,{nextElementId:nextId+1,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      item.id=nextId;
    });
  }
  function recordUndo(snapshot=elements) { undoStack.push(snapshot.map(el=>({...el,points:el.points?.map(pt=>({...pt}))}))); if(undoStack.length>40)undoStack.shift(); redoStack.length=0; }
  async function saveElement(item) { try { recordUndo();await persistElement(item);lastSaveError='';$('#save-state').textContent='Saved to shared Firebase';renderCanvas(); } catch(error) { lastSaveError=error.message;notice(`Could not save element: ${error.message}`); } }
  function moveElement(el,dx,dy) {
    if(el.points)return {...el,points:el.points.map(p=>({...p,x:p.x+dx,y:p.y+dy}))};
    if(el.start&&el.end)return {...el,start:{x:el.start.x+dx,y:el.start.y+dy},end:{x:el.end.x+dx,y:el.end.y+dy}};
    if(el._kind==='connector'&&Number.isFinite(el.x1))return {...el,x1:el.x1+dx,y1:el.y1+dy,x2:el.x2+dx,y2:el.y2+dy};
    return {...el,x:(Number(el.x)||0)+dx,y:(Number(el.y)||0)+dy};
  }
  async function saveElements(updated,before=elements) {
    try {recordUndo(before);const col=boardsRef.doc(selectedBoard.id).collection('elements');const old=await col.get();for(let i=0;i<old.docs.length;i+=400){const batch=db.batch();old.docs.slice(i,i+400).forEach(doc=>batch.delete(doc.ref));await batch.commit();}for(let i=0;i<updated.length;i+=400){const batch=db.batch();updated.slice(i,i+400).forEach(el=>{const item={...el};delete item._kind;batch.set(col.doc(String(item.id)),{elementJson:JSON.stringify(item),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});});await batch.commit();}$('#save-state').textContent='Saved to shared Firebase';}
    catch(error){notice(`Could not save moved elements: ${error.message}`);}
  }
  document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>{activeTool=button.dataset.tool;erase=activeTool==='ERASER';document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b===button));canvas.style.cursor=activeTool==='SELECT'?'move':activeTool==='LASSO'?'crosshair':'crosshair';}));
  $('#board-color').addEventListener('input',e=>{const v=e.target.value;activeColor=(0xFF000000|parseInt(v.slice(1),16)>>>0);});
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
  window.addEventListener('keydown',async event=>{if((event.key==='Delete'||event.key==='Backspace')&&selection.size&&!event.target.matches('input,textarea,select')){event.preventDefault();if(!selectedBoard)return;recordUndo();elements=elements.filter(el=>!selection.has(el.id));selection=new Set();await replaceBoardElements(elements);renderCanvas();}});
  $('#save-sketch').addEventListener('click', () => showToast(lastSaveError ? `Save failed: ${lastSaveError}` : 'Sketches save as you draw'));
  new ResizeObserver(renderCanvas).observe(canvas);
  new MutationObserver(renderCanvas).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('taskflow:sketches-open', () => { renderCanvas(); if (selectedBoard) selectBoard(selectedBoard); });
  window.addEventListener('resize', renderCanvas);
})();
