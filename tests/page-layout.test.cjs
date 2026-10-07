const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../editor-ux.js'), 'utf8'), context);
const layout = context.window.TaskflowTextUX.pageLayout;
const bounds = { minX: -36, minY: -36, maxX: 736, maxY: 466 };
const initial = layout(bounds, 970, 408, 1);
function screen(frame, point, scroll = { x: 0, y: 0 }) {
  return { x: frame.paddingX + (point.x - frame.bounds.minX) * frame.scale - scroll.x,
    y: 30 + (point.y - frame.bounds.minY) * frame.scale - scroll.y };
}
function test(name, fn) { fn(); console.log('PASS — ' + name); }
test('Rightward text growth leaves existing content and clicked position fixed', () => {
  const next = layout({ ...bounds, maxX: 1800 }, 970, 408, 1, initial);
  assert.deepEqual(screen(next, { x: 40, y: 40 }), screen(initial, { x: 40, y: 40 }));
  assert.deepEqual(screen(next, { x: 704, y: 209 }), screen(initial, { x: 704, y: 209 }));
  assert.ok(next.width > initial.width);
});
test('Left/up growth preserves screen position with matching scroll compensation', () => {
  const next = layout({ ...bounds, minX: -240, minY: -160 }, 970, 408, 1, initial);
  assert.deepEqual(screen(next, { x: 40, y: 40 }, { x: next.shiftX, y: next.shiftY }), screen(initial, { x: 40, y: 40 }));
  assert.ok(next.width >= initial.width + next.shiftX);
  assert.ok(next.height >= initial.height + next.shiftY);
  const repeat = layout(next.bounds, 970, 408, 1, next);
  assert.equal(repeat.shiftX, 0); assert.equal(repeat.shiftY, 0);
});
test('Deleting text or cancelling an empty text box does not collapse the scroll range', () => {
  const grown = layout({ ...bounds, maxX: 1800, maxY: 3000 }, 970, 408, 1, initial);
  const next = layout(bounds, 970, 408, 1, grown);
  assert.equal(next.width, grown.width); assert.equal(next.height, grown.height);
  assert.deepEqual(screen(next, { x: 40, y: 40 }), screen(grown, { x: 40, y: 40 }));
});
test('Autosave with the same bounds has no cumulative drift', () => {
  let next = initial;
  for (let i = 0; i < 100; i++) next = layout(bounds, 970, 408, 1, next);
  assert.deepEqual(next, initial);
});
test('Scrollbar or viewport width changes do not re-center the document', () => {
  for (const width of [955, 1200, 600]) {
    const next = layout(bounds, width, 408, 1, initial);
    assert.deepEqual(screen(next, { x: 40, y: 40 }), screen(initial, { x: 40, y: 40 }));
  }
});
test('Explicit Fit starts a new frame and discards obsolete extents', () => {
  const grown = layout({ ...bounds, maxX: 1800 }, 970, 408, 1, initial);
  const fitted = layout(bounds, 970, 408, 1, null);
  assert.ok(fitted.width < grown.width); assert.deepEqual(fitted, initial);
});
test('Zoom changes get a fresh scale-correct frame', () => {
  assert.deepEqual(layout(bounds, 970, 408, 0.5, initial), layout(bounds, 970, 408, 0.5));
});
test('Export framing does not mutate the active view', () => {
  const before = JSON.stringify(initial);
  layout({ ...bounds, maxX: 1800 }, 970, 408, 1);
  assert.equal(JSON.stringify(initial), before);
});
