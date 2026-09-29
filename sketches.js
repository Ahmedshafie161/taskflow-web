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
  let currentStroke = null;
  let imageLayout = { scale: 1, x: 0, y: 0, bounds: { minX: 0, minY: 0 } };
  let lastSaveError = '';

  function labelForType(el) {
    const raw = String(el.type || el.kind || '').split('.').pop().toLowerCase();
    const map = { stroke: 'stroke', shape: 'shape', textbox: 'textbox', textBox: 'textbox',
      image: 'image', table: 'table', connector: 'connector', treenode: 'treenode',
      curve: 'curve', curveshape: 'curveshape' };
    return map[raw] || raw;
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
      const video = String(el.mimeType || '').startsWith('video/') || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(source);
      const media = video ? document.createElement('video') : new Image();
      if (video) { media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
      const loaded = () => { loadedImages.set(source, media); showLinks(); renderCanvas(); };
      media.addEventListener(video ? 'loadedmetadata' : 'load', loaded, { once: true });
      media.addEventListener('error', () => { loadedImages.set(source, null); showLinks(); }, { once: true });
      media.src = source;
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
        const type = metadata.get('mimeType') || el.mimeType || 'application/octet-stream';
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
      if (image && image !== 'loading' && (!(image instanceof HTMLVideoElement) || image.readyState >= 2)) {
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
      const hrefValue = e.linkUrl || (e._kind === 'image' && /^https?:\/\//i.test(imageSource) ? imageSource : '');
      const href = /^https?:\/\//i.test(hrefValue) ? ` href="${escapeHtml(hrefValue)}" target="_blank" rel="noopener noreferrer"` : '';
      const title = e._kind === 'image' ? (e.mediaName || `Image ${e.id}`) : (e.text || 'Open linked media');
      const mediaKey = imageSource.startsWith('firestore-media://') ? imageSource.slice('firestore-media://'.length) : imageSource;
      const loaded = e._kind === 'image' ? loadedImages.get(mediaKey) : null;
      const mimeType = String(e.mimeType || '').toLowerCase();
      const preview = loaded && loaded !== 'loading' && (loaded instanceof HTMLVideoElement || mimeType === 'image/gif' || mimeType === 'image/webp')
        ? loaded instanceof HTMLVideoElement
          ? `<video class="sketch-media-preview" controls preload="metadata" playsinline src="${escapeHtml(loaded.src)}"></video>`
          : `<img class="sketch-media-preview" src="${escapeHtml(loaded.src)}" alt="">` : '';
      return `<a class="sketch-link"${href}><span>${e._kind === 'image' ? '▧' : '▶'}</span>${escapeHtml(title)}${preview}</a>`;
    }).join('');
  }

  function buildTree() {
    $('#board-count').textContent = `${boards.length} ${boards.length === 1 ? 'board' : 'boards'}`;
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
        rows.push(`<div class="board-entry ${selectedBoard?.id === board.id ? 'active' : ''}" style="padding-left:${8 + Math.min(depth, 7) * 17}px" data-board-id="${escapeHtml(board.id)}" title="${escapeHtml(board.name)}"><span aria-hidden="true">${depth ? '↳' : '▱'}</span><span class="board-name">${escapeHtml(board.name || 'Untitled board')}</span><span class="board-count">${count || ''}</span></div>`);
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
    notice('Sketch boards read directly from the Android app’s sketchBoards collection. Firebase rules decide who may see or change them.');
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
    drawing = true; canvas.setPointerCapture(event.pointerId);
    currentStroke = { type: 'com.impactyn.taskmanager.data.entities.SketchElement.Stroke', id: 0, colorArgb: erase ? 0 : 0xFF1B1F1C, strokeWidth: erase ? 18 : 4, isEraser: erase, isHighlighter: false, points: [point(event)], _kind: 'stroke' };
    renderCanvas();
  });
  canvas.addEventListener('pointermove', (event) => { if (!drawing || !currentStroke) return; currentStroke.points.push(point(event)); renderCanvas(); });
  async function endStroke() {
    if (!drawing || !currentStroke) return;
    drawing = false;
    const stroke = currentStroke; currentStroke = null;
    if (stroke.points.length < 2) { renderCanvas(); return; }
    try {
      $('#save-state').textContent = 'Saving to Firebase…';
      const contentRef = boardsRef.doc(selectedBoard.id).collection('content').doc('elements');
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(contentRef);
        const nextId = elements.reduce((max, element) => Math.max(max, element.id + 1), Number(snapshot.get('nextElementId')) || 1);
        const item = { ...stroke, id: nextId }; delete item._kind;
        const elementRef = boardsRef.doc(selectedBoard.id).collection('elements').doc(String(nextId));
        transaction.set(elementRef, { elementJson: JSON.stringify(item), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        transaction.set(contentRef, { nextElementId: nextId + 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        stroke.id = nextId;
      });
      lastSaveError = ''; $('#save-state').textContent = 'Saved to shared Firebase';
    } catch (error) {
      lastSaveError = error.message; $('#save-state').textContent = 'Save failed';
      notice(`The stroke is visible on this page but did not save: ${error.message}`);
    }
    renderCanvas();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  $('#board-pen').addEventListener('click', () => { erase = false; $('#board-pen').classList.add('active'); $('#board-eraser').classList.remove('active'); });
  $('#board-eraser').addEventListener('click', () => { erase = true; $('#board-eraser').classList.add('active'); $('#board-pen').classList.remove('active'); });
  $('#save-sketch').addEventListener('click', () => showToast(lastSaveError ? `Save failed: ${lastSaveError}` : 'Sketches save as you draw'));
  new ResizeObserver(renderCanvas).observe(canvas);
  new MutationObserver(renderCanvas).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('taskflow:sketches-open', () => { renderCanvas(); if (selectedBoard) selectBoard(selectedBoard); });
  window.addEventListener('resize', renderCanvas);
})();
