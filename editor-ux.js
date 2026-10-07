/* Shared editing primitives. Keep native selection and undo wherever supported. */
(() => {
  const editorSelector = '.page-body-editor,.table-editor-cell,.document-text,.document-cell';
  function editableTarget(target) {
    const element = target?.nodeType === 3 ? target.parentElement : target;
    return element?.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]') || null;
  }
  function captureSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const node = editableTarget(range.commonAncestorContainer);
    if (!node?.matches(editorSelector) || !node.contains(range.startContainer) || !node.contains(range.endContainer)) return null;
    return { node, range: range.cloneRange() };
  }
  function restoreSelection(saved) {
    if (!saved?.node?.isConnected || !saved.node.contains(saved.range.startContainer) || !saved.node.contains(saved.range.endContainer)) return false;
    saved.node.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(saved.range);
    return true;
  }
  function insertPlainText(node, value, saved = null) {
    if (!node?.isConnected) return false;
    const text = String(value).replace(/\r\n?/g, '\n');
    if (saved && !restoreSelection(saved)) return false;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return false;
    let emitted = false;
    const markInput = () => { emitted = true; };
    node.addEventListener('input', markInput);
    let inserted = false;
    try {
      // execCommand is retained here because Range insertion alone loses native undo.
      inserted = document.execCommand('insertText', false, text) || emitted;
      if (!inserted) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const content = document.createTextNode(text); range.insertNode(content);
        range.setStartAfter(content); range.collapse(true);
        selection.removeAllRanges(); selection.addRange(range);
        inserted = true;
      }
    } finally { node.removeEventListener('input', markInput); }
    if (inserted && !emitted) node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    return inserted;
  }
  function moveTableCell(event, cell, table) {
    if (event.isComposing || event.keyCode === 229 || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return false;
    const cells = [...table.querySelectorAll('.table-editor-cell')];
    const next = cells[cells.indexOf(cell) + (event.shiftKey ? -1 : 1)];
    if (!next) return false; // Let Tab leave the table at its boundaries.
    event.preventDefault(); next.focus();
    const range = document.createRange(); range.selectNodeContents(next);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return true;
  }
  function pageLayout(bounds, viewportWidth, viewportHeight, scale, previous = null) {
    // Grow the page without re-centering it or shrinking the scroll range mid-edit.
    // Reframing belongs to explicit zoom/fit actions, not text input or autosave.
    if (previous?.scale !== scale) previous = null;
    const b = previous ? {
      minX: Math.min(previous.bounds.minX, bounds.minX),
      minY: Math.min(previous.bounds.minY, bounds.minY),
      maxX: Math.max(previous.bounds.maxX, bounds.maxX),
      maxY: Math.max(previous.bounds.maxY, bounds.maxY)
    } : { ...bounds };
    const worldWidth = Math.max(1, b.maxX - b.minX) * scale;
    const worldHeight = Math.max(1, b.maxY - b.minY) * scale;
    const paddingX = previous?.paddingX ?? Math.max(30, (viewportWidth - worldWidth) / 2);
    // If content extends left/up, offset the scroll position by the same amount.
    const shiftX = previous ? (previous.bounds.minX - b.minX) * scale : 0;
    const shiftY = previous ? (previous.bounds.minY - b.minY) * scale : 0;
    return {
      bounds: b, scale, paddingX, shiftX, shiftY,
      width: Math.max(viewportWidth, Math.ceil(paddingX + worldWidth + 30), Math.ceil((previous?.width || 0) + shiftX)),
      height: Math.max(viewportHeight, Math.ceil(worldHeight + 60), Math.ceil((previous?.height || 0) + shiftY))
    };
  }
  window.TaskflowTextUX = Object.freeze({ editableTarget, captureSelection, restoreSelection, insertPlainText, moveTableCell, pageLayout });
})();
