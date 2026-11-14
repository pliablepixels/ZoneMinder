'use strict';
//
// Derives a zone's detection thresholds from a rectangle drawn round the
// smallest object that should alarm. Ratios and their defaults are in
// zone.php. Coordinates use the editor's percent space (0..100 per axis).
//
(function(global) {
  // definezone.rst [G]. Above the Default preset's 25.
  const DEFAULT_PIXEL_THRESHOLD = 40;

  // limitFilter clamps FilterX/Y odd within 3..15, so 3 is the smallest legal
  // kernel. Also the Default preset and Zone's constructor (zm_zone.h:140).
  const MIN_FILTER_KERNEL = 3;

  // Written and snapshotted for undo. ExtendAlarmFrames is excluded because
  // applyZoneType disables it outside Preclusive zones, so it cannot submit.
  const MANAGED_FIELDS = [
    'MinPixelThreshold', 'MaxPixelThreshold',
    'FilterX', 'FilterY',
    'MinAlarmPixels', 'MaxAlarmPixels',
    'MinFilterPixels', 'MaxFilterPixels',
    'MinBlobPixels', 'MaxBlobPixels',
    'MinBlobs', 'MaxBlobs',
    'OverloadFrames',
  ];


  // 2dp to match the DECIMAL(10,2) columns. Floor at 0.01 rather than allowing
  // 0, which CheckAlarms treats as "no minimum at all".
  function asPercentField(pct) {
    return Math.min(100, Math.max(0.01, Math.round(pct * 100) / 100));
  }

  // Unrounded pixel counts, so each stored percentage rounds exactly once.
  // Blob is a share of filter, not of alarm: a blob is built from pixels that
  // survived filtering, so blob <= filter <= alarm holds by construction,
  // which is what validateForm requires before a zone can be saved.
  function objectThresholdPixels(boxPx, ratios) {
    if (!(boxPx > 0)) return null;
    const alarm = ratios.fraction * boxPx;
    const filter = alarm * ratios.filter;
    return {alarm: alarm, filter: filter, blob: filter * ratios.blob};
  }

  // Storage unit: Zone::Load multiplies this back by polygon.Area()
  // (zm_zone.cpp:1020) to recover the pixel count.
  function pixelsToPercent(px, zonePx) {
    if (!(px > 0) || !(zonePx > 0)) return null;
    return asPercentField(px / zonePx * 100);
  }

  function keepOr(current, fallback) {
    return (current === undefined || current === null || String(current) === '') ?
        fallback : current;
  }

  // Size only: MinPixelThreshold and FilterX/Y are kept when already set.
  // Every Max stays blank - they set overload_count (zm_zone.cpp:304, 388,
  // 671) or delete the blob (:620), and one box cannot imply a ceiling when
  // the same object is far bigger up close.
  function zoneSettingsForObject(boxPx, zonePx, current, ratios) {
    const px = objectThresholdPixels(boxPx, ratios);
    if (!px || !(zonePx > 0)) return null;
    current = current || {};
    return {
      CheckMethod: 'Blobs',
      MinPixelThreshold: keepOr(current.MinPixelThreshold, DEFAULT_PIXEL_THRESHOLD),
      MaxPixelThreshold: '',
      FilterX: keepOr(current.FilterX, MIN_FILTER_KERNEL),
      FilterY: keepOr(current.FilterY, MIN_FILTER_KERNEL),
      MinAlarmPixels: pixelsToPercent(px.alarm, zonePx),
      MaxAlarmPixels: '',
      MinFilterPixels: pixelsToPercent(px.filter, zonePx),
      MaxFilterPixels: '',
      MinBlobPixels: pixelsToPercent(px.blob, zonePx),
      MaxBlobPixels: '',
      MinBlobs: 1,
      MaxBlobs: '',
      OverloadFrames: 0,
    };
  }

  // The filter keeps a pixel only if a fully-white FilterX by FilterY window
  // covers it (zm_zone.cpp:338), so a box narrower than the kernel on either
  // axis is erased entirely and the zone silently stops alarming. A box that
  // exactly fits the kernel survives, hence < rather than <=.
  // Only catches the certain case - real limbs are thinner than their box.
  function objectTooNarrowToFilter(rectWpx, rectHpx, filterX, filterY) {
    return rectWpx < Math.max(filterX || 0, MIN_FILTER_KERNEL) ||
        rectHpx < Math.max(filterY || 0, MIN_FILTER_KERNEL);
  }

  // zone.php reads these cookies back through validInt(), which strips
  // everything that is not a digit: 70.5 returns as 705 and 1e2 as 12. The
  // live calculation takes the same field through parseFloat, so a ratio that
  // is not a whole number in range means one thing now and another after a
  // reload. Settle it here, before it is stored or used.
  function normalizeRatio(value) {
    const n = Math.round(parseFloat(value));
    if (!(n >= 1) || !(n <= 100)) return null;
    return n;
  }

  // A box of the given capture-pixel size, centred in the frame, in the
  // editor's percent space. Lets the tool be driven by typing a size as well
  // as by dragging, and gives the drag somewhere to write its result back to.
  function boxPercentForPixels(wPx, hPx, frame) {
    if (!(wPx > 0) || !(hPx > 0)) return null;
    if (!frame || !(frame.width > 0) || !(frame.height > 0)) return null;
    const w = Math.min(frame.maxX, wPx / frame.width * frame.maxX);
    const h = Math.min(frame.maxY, hPx / frame.height * frame.maxY);
    const x = (frame.maxX - w) / 2;
    const y = (frame.maxY - h) / 2;
    return {a: {x: x, y: y}, b: {x: x + w, y: y + h}};
  }

  // The inverse of objectThresholdPixels' first step: the object a saved
  // MinAlarmPixels implies. Only the area survives storage, not the shape or
  // where it was drawn.
  function savedObjectPixels(minAlarmPct, zonePx, fraction) {
    if (!(minAlarmPct > 0) || !(zonePx > 0) || !(fraction > 0)) return null;
    return minAlarmPct / 100 * zonePx / fraction;
  }

  // Sides of a box of the given area and width/height ratio.
  function boxSidesForArea(areaPx, aspect) {
    if (!(areaPx > 0) || !(aspect > 0)) return null;
    return {w: Math.sqrt(areaPx * aspect), h: Math.sqrt(areaPx / aspect)};
  }

  // The box scaled about its centre to cover share of its area. Schematic:
  // alarmed pixels are scattered, this only shows how many of them must change.
  function innerBox(box, share) {
    if (!(share > 0)) return null;
    const k = Math.sqrt(Math.min(share, 1));
    const cx = (box.a.x + box.b.x) / 2;
    const cy = (box.a.y + box.b.y) / 2;
    const hw = Math.abs(box.b.x - box.a.x) * k / 2;
    const hh = Math.abs(box.b.y - box.a.y) * k / 2;
    return {a: {x: cx - hw, y: cy - hh}, b: {x: cx + hw, y: cy + hh}};
  }

  // The box moved by dx, dy, stopped at the frame edges so its size is kept.
  function shiftBox(box, dx, dy, maxX, maxY) {
    const x0 = Math.min(box.a.x, box.b.x);
    const y0 = Math.min(box.a.y, box.b.y);
    const w = Math.abs(box.b.x - box.a.x);
    const h = Math.abs(box.b.y - box.a.y);
    const x = Math.min(Math.max(x0 + dx, 0), Math.max(maxX - w, 0));
    const y = Math.min(Math.max(y0 + dy, 0), Math.max(maxY - h, 0));
    return {a: {x: x, y: y}, b: {x: x + w, y: y + h}};
  }

  // Reduces zma's per-frame output to what the zone needs to show: for each
  // stage, the peak value reached and how many frames got through it. Stages
  // chain - a frame only counts for filtered if it passed alarmed - matching
  // CheckAlarms, which stops at the first stage that fails.
  function summarizeZoneTest(result, zoneId) {
    const zone = (result.zones || []).filter(function(z) {
      return z.id == zoneId;
    })[0];
    if (!zone || !result.done) return null;
    const peak = {alarm: 0, filter: 0, blob: 0};
    const passed = {alarm: 0, filter: 0, blob: 0, scored: 0};
    (result.frames || []).forEach(function(f) {
      const z = (f.zones || []).filter(function(fz) {
        return fz.id == zoneId;
      })[0];
      if (!z) return;
      peak.alarm = Math.max(peak.alarm, z.alarm);
      peak.filter = Math.max(peak.filter, z.filter);
      peak.blob = Math.max(peak.blob, z.largestBlob);
      if (z.score > 0) passed.scored++;
      if (z.alarm < zone.minAlarm) return;
      passed.alarm++;
      if (zone.checkMethod < 2) return;
      if (z.filter < zone.minFilter) return;
      passed.filter++;
      if (zone.checkMethod < 3) return;
      if (z.blobs >= Math.max(zone.minBlobs, 1) && z.maxBlob >= zone.minBlob) passed.blob++;
    });
    return {zone: zone, peak: peak, passed: passed, done: result.done};
  }

  const api = {
    MIN_FILTER_KERNEL: MIN_FILTER_KERNEL,
    summarizeZoneTest: summarizeZoneTest,
    shiftBox: shiftBox,
    savedObjectPixels: savedObjectPixels,
    boxSidesForArea: boxSidesForArea,
    innerBox: innerBox,
    normalizeRatio: normalizeRatio,
    boxPercentForPixels: boxPercentForPixels,
    MANAGED_FIELDS: MANAGED_FIELDS,
    objectThresholdPixels: objectThresholdPixels,
    pixelsToPercent: pixelsToPercent,
    zoneSettingsForObject: zoneSettingsForObject,
    objectTooNarrowToFilter: objectTooNarrowToFilter,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }
  global.ZM_ZoneObjectSize = api;

  //
  // Browser-only below here.
  //

  let armed = false;
  let dragging = false;
  let startPct = null;
  let undoSnapshot = null;
  // The last box measured, so a change to the fraction can re-derive from it.
  let lastBox = null;
  // The box on screen, measured or rebuilt from the saved thresholds.
  let shownBox = null;
  // Where a rebuilt box was moved to, so redraws keep it there.
  let savedCenter = null;

  const RATIO_INPUTS = [
    {key: 'fraction', id: 'objectFraction', cookie: 'zmZoneObjectFraction'},
    {key: 'filter', id: 'objectFilterRatio', cookie: 'zmZoneFilterRatio'},
    {key: 'blob', id: 'objectBlobRatio', cookie: 'zmZoneBlobRatio'},
  ];

  // A blank or out-of-range field falls back to defaultValue, which zone.php
  // rendered. Never 0 - CheckAlarms reads that as no minimum at all.
  function currentRatios() {
    const out = {};
    RATIO_INPUTS.forEach(function(spec) {
      const el = document.getElementById(spec.id);
      let pct = parseFloat(el.value);
      if (!(pct > 0) || !(pct <= 100)) pct = parseFloat(el.defaultValue);
      out[spec.key] = pct / 100;
    });
    return out;
  }
  let snapshotTaken = false;

  function imageFeed() {
    return document.getElementById('imageFeed' + zone.MonitorId);
  }

  // A still can stand in for the live view. Read as a data URL - nothing is
  // uploaded. Kept hidden rather than removed so toggling reuses it.
  let stillShown = false;

  function stillElement() {
    let img = document.getElementById('objectStill');
    if (img) return img;
    const feed = imageFeed();
    if (!feed) return null;
    img = document.createElement('img');
    img.id = 'objectStill';
    img.style.display = 'none';
    const svg = document.getElementById('zoneSVG');
    // After the stream so it covers the live view, before the SVG so the zone
    // outline still paints on top.
    if (svg && svg.parentNode === feed) {
      feed.insertBefore(img, svg);
    } else {
      feed.appendChild(img);
    }
    return img;
  }

  function hasStill() {
    const img = document.getElementById('objectStill');
    return !!(img && img.getAttribute('src'));
  }

  function updateStillButton() {
    const btn = document.getElementById('objectImageBtn');
    if (btn) {
      btn.classList.toggle('btn-primary', stillShown);
      btn.title = stillShown ?
          zoneObjectSizeStrings.liveView : zoneObjectSizeStrings.useImage;
    }
    const replace = document.getElementById('objectImageReplaceBtn');
    if (replace) replace.style.display = stillShown ? '' : 'none';
  }

  function loadStill(dataUrl) {
    const img = stillElement();
    if (!img) return;
    img.src = dataUrl;
    showStill();
  }

  function showStill() {
    const img = stillElement();
    if (!img || !hasStill()) return;
    img.style.display = '';
    stillShown = true;
    // Not monitors[i].pause(), so the play/pause buttons stay in sync.
    streamCmdPause();
    updateStillButton();
  }

  // Leaves the stream alone: the Play button's own handler already plays it.
  function hideStill() {
    const img = document.getElementById('objectStill');
    if (img) img.style.display = 'none';
    stillShown = false;
    updateStillButton();
  }

  function showLive() {
    hideStill();
    streamCmdPlay();
  }

  function zoneIsMeasurable() {
    const type = document.zoneForm.elements['newZone[Type]'].value;
    return type !== 'Inactive' && type !== 'Privacy';
  }

  // Inverse of the mapping drawZonePoints uses, via zone.js's own maxX/maxY
  // and constrainValue so the box shares the vertices' coordinate space.
  function toPercent(evt, feed) {
    const box = feed.getBoundingClientRect();
    return {
      x: constrainValue((evt.clientX - box.left) / box.width * maxX, 0, maxX),
      y: constrainValue((evt.clientY - box.top) / box.height * maxY, 0, maxY),
    };
  }

  // Not SVG text: the SVG uses preserveAspectRatio="none", which would
  // stretch it out of shape.
  function sizeLabel() {
    let el = document.getElementById('objectSizeLabel');
    if (!el) {
      const feed = imageFeed();
      if (!feed) return null;
      el = document.createElement('div');
      el.id = 'objectSizeLabel';
      feed.appendChild(el);
    }
    return el;
  }

  // Capture pixels, so the figure means the same at any window size.
  function drawSizeLabel(x, y, w, h) {
    const el = sizeLabel();
    if (!el) return;
    const wPx = Math.round(w / maxX * monitorData[0].width);
    const hPx = Math.round(h / maxY * monitorData[0].height);
    el.textContent = wPx + '×' + hPx + ' = ' + (wPx * hPx).toLocaleString() + ' px';
    el.style.left = x + '%';
    el.style.top = y + '%';
    // Flips inside the box when it is near the top edge.
    el.classList.toggle('below', y < 6);
    el.style.display = '';
  }

  // Threshold rects drawn inside the object box, and the field each is sized by.
  const THRESHOLD_RECTS = [
    {id: 'objectAlarmRect', field: 'MinAlarmPixels', stage: 'alarm'},
    {id: 'objectFilterRect', field: 'MinFilterPixels', stage: 'filter'},
    {id: 'objectBlobRect', field: 'MinBlobPixels', stage: 'blob'},
  ];

  // The last zma test, while it still describes the form. Each stage is a pass
  // if any frame got through it; undefined means not tested or not applicable.
  let testSummary = null;
  function testVerdict(stage) {
    if (!testSummary) return undefined;
    const method = testSummary.zone.checkMethod;
    if ((stage === 'filter' && method < 2) || (stage === 'blob' && method < 3)) return undefined;
    return testSummary.passed[stage] > 0;
  }
  const INNER_RECT_IDS = THRESHOLD_RECTS.map(function(t) {
    return t.id;
  }).concat(['objectKernelRect']);

  function zonePixels() {
    return zone.Area / monitorArea * monitorPixelArea;
  }

  function setRect(id, a, b) {
    const r = document.getElementById(id);
    if (!r) return null;
    r.setAttribute('x', Math.min(a.x, b.x));
    r.setAttribute('y', Math.min(a.y, b.y));
    r.setAttribute('width', Math.abs(b.x - a.x));
    r.setAttribute('height', Math.abs(b.y - a.y));
    r.style.display = '';
    return r;
  }

  function hideRects(ids) {
    ids.forEach(function(id) {
      const r = document.getElementById(id);
      if (r) r.style.display = 'none';
    });
  }

  // A div rather than an SVG rect, for the same reason as the label: the
  // stretched viewBox would distort it.
  function resizeHandle() {
    let el = document.getElementById('objectResizeHandle');
    if (!el) {
      const feed = imageFeed();
      if (!feed) return null;
      el = document.createElement('div');
      el.id = 'objectResizeHandle';
      el.style.display = 'none';
      feed.appendChild(el);
    }
    return el;
  }

  // saved: the box was rebuilt from stored thresholds rather than drawn.
  function drawRect(a, b, saved) {
    const r = setRect('objectRect', a, b);
    if (!r) return;
    r.classList.toggle('saved', !!saved);
    shownBox = {
      a: {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y)},
      b: {x: Math.max(a.x, b.x), y: Math.max(a.y, b.y)},
      saved: !!saved,
    };
    // Stale until drawThresholds runs for this box.
    hideRects(INNER_RECT_IDS);
    drawSizeLabel(shownBox.a.x, shownBox.a.y,
        shownBox.b.x - shownBox.a.x, shownBox.b.y - shownBox.a.y);
    // Whichever box is on screen, the size fields describe it.
    showBoxSize((shownBox.b.x - shownBox.a.x) / maxX * monitorData[0].width,
        (shownBox.b.y - shownBox.a.y) / maxY * monitorData[0].height);
    const handle = resizeHandle();
    if (handle) {
      handle.style.left = shownBox.b.x + '%';
      handle.style.top = shownBox.b.y + '%';
      handle.style.display = '';
    }
  }

  function hideRect() {
    hideRects(['objectRect'].concat(INNER_RECT_IDS));
    shownBox = null;
    ['objectSizeLabel', 'objectResizeHandle'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  // Each Min threshold as a share of the box, from whatever the fields hold
  // now, so hand edits show up too. Disabled fields (CheckMethod) are skipped:
  // they take no part in detection.
  function drawThresholds(box) {
    const form = document.zoneForm;
    const W = monitorData[0].width;
    const H = monitorData[0].height;
    const boxPx = Math.abs(box.b.x - box.a.x) / maxX * W *
        Math.abs(box.b.y - box.a.y) / maxY * H;
    const zonePx = zonePixels();
    THRESHOLD_RECTS.forEach(function(t) {
      const el = form.elements['newZone[' + t.field + ']'];
      const pct = el && !el.disabled ? parseFloat(el.value) : NaN;
      const inner = (boxPx > 0) ? innerBox(box, pct / 100 * zonePx / boxPx) : null;
      if (inner) {
        const r = setRect(t.id, inner.a, inner.b);
        const verdict = testVerdict(t.stage);
        r.classList.toggle('testPass', verdict === true);
        r.classList.toggle('testFail', verdict === false);
      } else {
        hideRects([t.id]);
      }
    });
    // The filter kernel to scale, in the box's corner: anything thinner than
    // this is erased before blobs are counted.
    const fx = form.elements['newZone[FilterX]'];
    const fy = form.elements['newZone[FilterY]'];
    const kx = fx && !fx.disabled ? parseInt(fx.value, 10) : NaN;
    const ky = fy && !fy.disabled ? parseInt(fy.value, 10) : NaN;
    if (kx > 1 || ky > 1) {
      const x = Math.min(box.a.x, box.b.x);
      const y = Math.min(box.a.y, box.b.y);
      setRect('objectKernelRect', {x: x, y: y},
          {x: x + (kx || 1) / W * maxX, y: y + (ky || 1) / H * maxY});
    } else {
      hideRects(['objectKernelRect']);
    }
  }

  // With no measurement in hand, show the object the saved settings imply, at
  // the monitor's aspect ratio and centred - shape and position are not stored.
  function showSavedObject() {
    hideRect();
    if (!zoneIsMeasurable()) return;
    const form = document.zoneForm;
    const W = monitorData[0].width;
    const H = monitorData[0].height;
    const el = form.elements['newZone[MinAlarmPixels]'];
    const area = savedObjectPixels(el && !el.disabled ? parseFloat(el.value) : NaN,
        zonePixels(), currentRatios().fraction);
    const sides = boxSidesForArea(area, W / H);
    if (!sides) return;
    let box = boxPercentForPixels(sides.w, sides.h,
        {width: W, height: H, maxX: maxX, maxY: maxY});
    if (!box) return;
    if (savedCenter) {
      box = shiftBox(box, savedCenter.x - (box.a.x + box.b.x) / 2,
          savedCenter.y - (box.a.y + box.b.y) / 2, maxX, maxY);
    }
    drawRect(box.a, box.b, true);
    drawThresholds(box);
  }

  function refreshOverlay() {
    if (lastBox) {
      drawThresholds(lastBox);
    } else {
      showSavedObject();
    }
  }

  // Compared against the pre-drag snapshot: mid-drag the field already holds
  // our value, so comparing live would clear the mark on the second mousemove.
  function markChanged(field, changed) {
    const el = document.zoneForm.elements['newZone[' + field + ']'];
    if (el) el.classList.toggle('objectSizeChanged', changed);
    const px = document.getElementById(field + '_px');
    if (px) px.classList.toggle('objectSizeChanged', changed);
  }

  function clearChangeMarks() {
    MANAGED_FIELDS.concat(['CheckMethod']).forEach(function(field) {
      markChanged(field, false);
    });
  }

  // For when something else takes ownership of these fields - the marks would
  // then be a lie and undo would revert work done after us.
  function forgetMeasurement() {
    clearChangeMarks();
    undoSnapshot = null;
    snapshotTaken = false;
    lastBox = null;
    const btn = document.getElementById('objectSizeUndoBtn');
    if (btn) btn.style.display = 'none';
    const panel = document.getElementById('rectangleSettings');
    if (panel && !armed) panel.style.display = 'none';
    refreshOverlay();
  }

  function setArmed(on) {
    armed = on;
    const btn = document.getElementById('objectSizeBtn');
    if (btn) btn.classList.toggle('btn-primary', on);
    // Stays up after a measurement so the ratios can be tuned against the box.
    const panel = document.getElementById('rectangleSettings');
    if (panel) panel.style.display = (on || lastBox) ? '' : 'none';
    const feed = imageFeed();
    if (feed) {
      feed.style.cursor = on ? 'crosshair' : '';
      // Without this the browser claims a touch drag for panning and the
      // pointermove events stop arriving after the first few pixels.
      feed.style.touchAction = on ? 'none' : '';
    }
    // Stop the zone vertices swallowing the drag while measuring.
    const points = document.querySelectorAll('.zonePoint');
    for (let i = 0; i < points.length; i++) {
      points[i].style.pointerEvents = on ? 'none' : '';
    }
  }

  function takeSnapshot(form) {
    undoSnapshot = {};
    MANAGED_FIELDS.forEach(function(field) {
      const el = form.elements['newZone[' + field + ']'];
      undoSnapshot[field] = el ? el.value : '';
    });
    undoSnapshot.CheckMethod = form.elements['newZone[CheckMethod]'].value;
    const btn = document.getElementById('objectSizeUndoBtn');
    if (btn) btn.style.display = '';
  }

  function undo() {
    if (!undoSnapshot) return;
    const form = document.zoneForm;
    form.elements['newZone[CheckMethod]'].value = undoSnapshot.CheckMethod;
    applyCheckMethod();
    MANAGED_FIELDS.forEach(function(field) {
      const el = form.elements['newZone[' + field + ']'];
      if (el) el.value = undoSnapshot[field];
    });
    updateAllPixelDisplays();
    forgetMeasurement();
  }

  // Runs on every mousemove, so nothing here may block - no alert or confirm.
  function apply(a, b) {
    const form = document.zoneForm;
    // Capture pixels: the units CheckAlarms counts in.
    const wPx = Math.abs(b.x - a.x) / maxX * monitorData[0].width;
    const hPx = Math.abs(b.y - a.y) / maxY * monitorData[0].height;
    const zonePx = zonePixels();
    // A box this small is normal mid-drag. Change nothing, say nothing.
    if (!(wPx * hPx > 0) || !(zonePx > 0)) return false;

    if (!snapshotTaken) {
      takeSnapshot(form);
      snapshotTaken = true;
    }

    lastBox = {a: {x: a.x, y: a.y}, b: {x: b.x, y: b.y}};

    // Sensitivity is read from the snapshot, not the live fields: mid-drag
    // those already hold our own writes.
    const values = zoneSettingsForObject(
        wPx * hPx, zonePx, undoSnapshot, currentRatios());
    if (!values) return false;

    // applyCheckMethod is required: assigning to a select does not fire
    // onchange, and the blob fields stay disabled - and disabled inputs never
    // submit. Read the old method from the snapshot; the live field already
    // says Blobs after the first mousemove.
    const switched = undoSnapshot.CheckMethod !== values.CheckMethod;
    form.elements['newZone[CheckMethod]'].value = values.CheckMethod;
    applyCheckMethod();
    markChanged('CheckMethod', switched);

    MANAGED_FIELDS.forEach(function(field) {
      const el = form.elements['newZone[' + field + ']'];
      if (!el) return;
      el.value = values[field];
      markChanged(field, String(values[field]) !== String(undoSnapshot[field]));
    });

    // Refresh the pixel readouts beside each percentage field.
    updateAllPixelDisplays();
    staleTest();
    drawThresholds(lastBox);
    return true;
  }

  // The typed size and the drawn box are two views of one measurement, so
  // whichever was used last writes to the other.
  function showBoxSize(wPx, hPx) {
    const w = document.getElementById('objectWidthPx');
    const h = document.getElementById('objectHeightPx');
    if (w) w.value = (wPx > 0) ? Math.round(wPx) : '';
    if (h) h.value = (hPx > 0) ? Math.round(hPx) : '';
  }

  // Warnings live here, not in apply(), which runs on every pointermove.
  function finishDrag(a, b) {
    if (!apply(a, b)) return;
    const form = document.zoneForm;
    const wPx = Math.abs(b.x - a.x) / maxX * monitorData[0].width;
    const hPx = Math.abs(b.y - a.y) / maxY * monitorData[0].height;
    showBoxSize(wPx, hPx);
    const fx = Math.max(
        parseInt(form.elements['newZone[FilterX]'].value, 10) || 0,
        MIN_FILTER_KERNEL);
    const fy = Math.max(
        parseInt(form.elements['newZone[FilterY]'].value, 10) || 0,
        MIN_FILTER_KERNEL);
    if (objectTooNarrowToFilter(wPx, hPx, fx, fy)) {
      alert(zoneObjectSizeStrings.filterTooSmall
          .replace('%s', fx).replace('%s', fy));
    }
  }

  function fmt(n) {
    return Math.round(n).toLocaleString();
  }

  function showTestResult(summary) {
    const out = document.getElementById('zoneTestResult');
    if (!out) return;
    out.textContent = '';
    if (!summary) return;
    const z = summary.zone;
    const d = summary.done;
    const head = document.createElement('div');
    head.textContent = d.frames + ' frames analysed - ' + summary.passed.scored +
        ' scored, ' + d.alarms + ' alarm(s) (an alarm needs ' + d.alarmFrameCount +
        ' scored frames in a row)';
    out.appendChild(head);
    const rows = [
      ['alarm', 'swatchAlarm', 'Alarmed', summary.peak.alarm, z.minAlarm, 1],
      ['filter', 'swatchFilter', 'Filtered', summary.peak.filter, z.minFilter, 2],
      ['blob', 'swatchBlob', 'Largest blob', summary.peak.blob, z.minBlob, 3],
    ];
    rows.forEach(function(r) {
      if (z.checkMethod < r[5]) return;
      const line = document.createElement('div');
      line.className = 'swatch ' + r[1] + (testVerdict(r[0]) ? ' testPass' : ' testFail');
      line.textContent = r[2] + ': peak ' + fmt(r[3]) + ' px, needs ' + fmt(r[4]) +
          ' px - ' + summary.passed[r[0]] + ' frame(s) passed';
      out.appendChild(line);
    });
  }

  // Any change to the form means the result no longer describes it.
  function staleTest() {
    if (!testSummary) return;
    testSummary = null;
    const out = document.getElementById('zoneTestResult');
    if (out) {
      const note = document.createElement('div');
      note.className = 'testStale';
      note.textContent = zoneObjectSizeStrings.testStale;
      out.insertBefore(note, out.firstChild);
    }
  }

  function runTest() {
    const btn = document.getElementById('zoneTestBtn');
    const select = document.getElementById('zoneTestEvent');
    const out = document.getElementById('zoneTestResult');
    const form = document.zoneForm;
    const data = {
      command: 'test',
      mid: zone.MonitorId, zid: form.elements['zid'].value, eid: select.value,
    };
    // The form as it stands, saved or not. Disabled fields are left out, as a
    // save would leave them out.
    data['newZone[Coords]'] = getCoordString();
    data['newZone[CheckMethod]'] = form.elements['newZone[CheckMethod]'].value;
    MANAGED_FIELDS.forEach(function(field) {
      const el = form.elements['newZone[' + field + ']'];
      if (el && !el.disabled) data['newZone[' + field + ']'] = el.value;
    });
    btn.disabled = true;
    testSummary = null;
    out.textContent = zoneObjectSizeStrings.testRunning;
    // Not getJSON: that takes the global ZM_WEB_AJAX_TIMEOUT (a few seconds)
    // and zma needs longer than that for any real event.
    $j.ajax({
      url: zmAuth.appendTo(thisUrl + '?view=request&request=zone'),
      data: data,
      dataType: 'json',
      timeout: 0,
    })
        .done(function(resp) {
          if (resp.result !== 'Ok') {
            out.textContent = resp.message;
            return;
          }
          testSummary = summarizeZoneTest(resp, data.zid);
          showTestResult(testSummary);
          refreshOverlay();
        })
        .fail(function(jqxhr, textStatus, error) {
          out.textContent = textStatus + (error ? ': ' + error : '');
          logAjaxFail(jqxhr, textStatus, error);
        })
        .always(function() {
          btn.disabled = false;
        });
  }

  function init() {
    const testBtn = document.getElementById('zoneTestBtn');
    if (testBtn) testBtn.addEventListener('click', runTest);
    if (document.zoneForm) {
      ['input', 'change'].forEach(function(type) {
        document.zoneForm.addEventListener(type, function(evt) {
          // Picking another event is not a settings change.
          if (evt.target.id !== 'zoneTestEvent') staleTest();
        });
      });
    }

    const btn = document.getElementById('objectSizeBtn');
    const feed = imageFeed();
    if (!btn || !feed) return;

    btn.addEventListener('click', function() {
      if (!armed && !zoneIsMeasurable()) {
        alert(zoneObjectSizeStrings.inactive);
        return;
      }
      // Arming starts a fresh measurement: the next drag must snapshot the
      // state as it is now, not as it was before the previous one.
      if (!armed) forgetMeasurement();
      setArmed(!armed);
    });

    const undoBtn = document.getElementById('objectSizeUndoBtn');
    if (undoBtn) undoBtn.addEventListener('click', undo);

    // zone.js already binds streamCmdPlay here, so this only drops the still.
    const playButton = document.getElementById('playBtn');
    if (playButton) {
      playButton.addEventListener('click', function() {
        if (stillShown) hideStill();
      });
    }

    const imageBtn = document.getElementById('objectImageBtn');
    const replaceBtn = document.getElementById('objectImageReplaceBtn');
    const fileInput = document.getElementById('objectImageFile');
    updateStillButton();
    // First press asks for a file; after that it toggles still against live.
    if (imageBtn && fileInput) {
      imageBtn.addEventListener('click', function() {
        if (!hasStill()) {
          fileInput.click();
        } else if (stillShown) {
          showLive();
        } else {
          showStill();
        }
      });
    }
    if (replaceBtn && fileInput) {
      replaceBtn.addEventListener('click', function() {
        fileInput.click();
      });
    }
    if (fileInput) {
      fileInput.addEventListener('change', function() {
        const file = fileInput.files && fileInput.files[0];
        // Lets the same file be picked again later.
        fileInput.value = '';
        if (!file) return;
        if (file.type.indexOf('image/') !== 0) {
          alert(zoneObjectSizeStrings.notAnImage);
          return;
        }
        const reader = new FileReader();
        reader.onload = function() {
          // The MIME type only says what the file claims to be. Decode it
          // first, so a corrupt one complains instead of pausing the stream
          // to show a broken image.
          const probe = new Image();
          probe.onload = function() {
            loadStill(reader.result);
          };
          probe.onerror = function() {
            alert(zoneObjectSizeStrings.notAnImage);
          };
          probe.src = reader.result;
        };
        reader.onerror = function() {
          alert(zoneObjectSizeStrings.notAnImage);
        };
        reader.readAsDataURL(file);
      });
    }

    // Re-derives from the box already drawn, so the effect is immediate.
    RATIO_INPUTS.forEach(function(spec) {
      const el = document.getElementById(spec.id);
      if (!el) return;
      el.addEventListener('change', function() {
        // Normalized first: zone.php reads the cookie back through validInt(),
        // so anything but a whole number in range would come back as a
        // different ratio. Write it into the field too, so what is shown, what
        // is calculated and what is stored are the same number.
        const pct = normalizeRatio(el.value);
        if (pct === null) {
          el.value = el.defaultValue;
        } else {
          el.value = pct;
        }
        // Written here, read back in zone.php when the page next renders, the
        // way the player selector handles zmZonePlayer. No expiry argument, so
        // skin.js stores it with max-age to 2038 as most callers do.
        setCookie(spec.cookie, el.value);
        if (lastBox) {
          apply(lastBox.a, lastBox.b);
        } else {
          showSavedObject();
        }
      });
    });

    // Reset restores every field from initialValues and redraws the polygon,
    // so the measurement it would undo is already gone. Wrapping the handler
    // rather than adding a listener because ours has to run first: resetChanges
    // calls updateArea, which re-derives from lastBox (below), and that would
    // put the measurement straight back.
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      const resetHandler = resetBtn.onclick;
      resetBtn.onclick = function(evt) {
        if (armed) setArmed(false);
        forgetMeasurement();
        showBoxSize(0, 0);
        const result = resetHandler ? resetHandler.call(this, evt) : undefined;
        // forgetMeasurement drew from the pre-reset fields.
        showSavedObject();
        return result;
      };
    }

    // The stored thresholds are percentages of the zone, so moving, adding or
    // removing a vertex changes what they mean in pixels. updateArea is the
    // one funnel every such edit goes through, so re-derive from the box that
    // is still drawn and the numbers keep describing the same object.
    // apply() only reaches updateAllPixelDisplays, never back here.
    const areaUpdater = global.updateArea;
    if (typeof areaUpdater === 'function') {
      global.updateArea = function() {
        const result = areaUpdater.apply(this, arguments);
        if (lastBox) {
          apply(lastBox.a, lastBox.b);
        } else {
          showSavedObject();
        }
        return result;
      };
    }

    // A preset rewrites every field we manage. addEventListener rather than
    // patching applyPreset, which skin.js binds by reference at load time.
    const presetSelector = document.getElementById('presetSelector');
    // skin.js delegates data-on-change from the document, so applyPreset runs
    // after this listener; redraw once it has written the preset's values.
    if (presetSelector) {
      presetSelector.addEventListener('change', function() {
        forgetMeasurement();
        setTimeout(refreshOverlay, 0);
      });
    }

    const form = document.zoneForm;

    // applyZoneType disables every field we write once the zone stops being
    // measurable, so stand down rather than re-enable them behind it.
    form.elements['newZone[Type]'].addEventListener('change', function() {
      // Deferred like the preset: applyZoneType may not have run yet.
      if (zoneIsMeasurable()) {
        setTimeout(refreshOverlay, 0);
        return;
      }
      if (armed) setArmed(false);
      forgetMeasurement();
    });

    // Hands one field back to the user: unmark it, and move the snapshot on
    // so undo cannot revert an edit made after us. Our own writes assign
    // .value directly and raise no input event.
    function releaseField(field) {
      markChanged(field, false);
      const el = form.elements['newZone[' + field + ']'];
      if (undoSnapshot && el) undoSnapshot[field] = el.value;
      refreshOverlay();
    }

    MANAGED_FIELDS.forEach(function(field) {
      const el = form.elements['newZone[' + field + ']'];
      if (el) {
        el.addEventListener('input', function() {
          releaseField(field);
        });
      }
      // The pixel twin writes the percentage field from zone.js's own oninput,
      // which runs first, so the value is already there to snapshot.
      const px = document.getElementById(field + '_px');
      if (px) {
        px.addEventListener('input', function() {
          releaseField(field);
        });
      }
    });
    const checkMethod = form.elements['newZone[CheckMethod]'];
    if (checkMethod) {
      checkMethod.addEventListener('change', function() {
        releaseField('CheckMethod');
        // applyCheckMethod enables or disables the fields drawThresholds reads.
        setTimeout(refreshOverlay, 0);
      });
    }

    // Typing a size is the keyboard-operable equivalent of the drag, and is
    // also the easier way in when the object is not in front of the camera
    // right now. Same derivation, same warnings - only the box differs, being
    // centred in the frame rather than drawn where the object stood.
    function applyTypedSize() {
      if (!zoneIsMeasurable()) {
        alert(zoneObjectSizeStrings.inactive);
        return;
      }
      const w = document.getElementById('objectWidthPx');
      const h = document.getElementById('objectHeightPx');
      if (!w || !h) return;
      const box = boxPercentForPixels(parseFloat(w.value), parseFloat(h.value),
          {width: monitorData[0].width, height: monitorData[0].height,
            maxX: maxX, maxY: maxY});
      if (!box) {
        alert(zoneObjectSizeStrings.sizeNeeded);
        return;
      }
      drawRect(box.a, box.b);
      finishDrag(box.a, box.b);
    }

    const sizeBtn = document.getElementById('objectSizeApplyBtn');
    if (sizeBtn) sizeBtn.addEventListener('click', applyTypedSize);
    ['objectWidthPx', 'objectHeightPx'].forEach(function(id) {
      const el = document.getElementById(id);
      if (!el) return;
      // Enter in a number field would otherwise submit the zone.
      el.addEventListener('keydown', function(evt) {
        if (evt.key !== 'Enter') return;
        evt.preventDefault();
        applyTypedSize();
      });
    });

    // Pointer rather than mouse events, so a touch or a pen draws the box too.
    // Capture keeps the moves coming when the finger leaves the image, which
    // is what the old window-level mouseup was for.
    feed.addEventListener('pointerdown', function(evt) {
      if (!armed) return;
      // Secondary buttons scroll or open menus; leave them alone.
      if (evt.pointerType === 'mouse' && evt.button !== 0) return;
      // Armed state can outlive measurability: applyPreset writes Type
      // directly and fires no change event, so the type listener never runs.
      // apply() would then re-enable the fields applyZoneType just disabled.
      if (!zoneIsMeasurable()) {
        setArmed(false);
        forgetMeasurement();
        return;
      }
      evt.preventDefault();
      dragging = true;
      if (feed.setPointerCapture) feed.setPointerCapture(evt.pointerId);
      // snapshotTaken is deliberately not reset: every box in one armed
      // session is measured against the state before the first, so undo and
      // the highlighting stay anchored there.
      startPct = toPercent(evt, feed);
      drawRect(startPct, startPct);
    });

    feed.addEventListener('pointermove', function(evt) {
      if (!armed || !dragging) return;
      const at = toPercent(evt, feed);
      drawRect(startPct, at);
      // Live: the thresholds track the box as it is drawn.
      apply(startPct, at);
    });

    function endDrag(evt) {
      if (!armed || !dragging) return;
      dragging = false;
      const at = toPercent(evt, feed);
      // Redraw before measuring: the pointer drifts between the last move and
      // the release, and the visible box must be the one measured.
      drawRect(startPct, at);
      finishDrag(startPct, at);
    }

    feed.addEventListener('pointerup', endDrag);
    // A cancelled pointer - the browser taking over for a scroll or a gesture
    // - never sends pointerup, and would otherwise leave the drag running.
    feed.addEventListener('pointercancel', endDrag);

    // Moving and resizing the box on screen. Moving keeps the area, so the
    // thresholds stand; resizing is a new measurement, anchored at the
    // opposite corner, and goes through apply() like a drawn box.
    let edit = null;
    function startEdit(evt, mode) {
      if (!shownBox) return false;
      if (evt.pointerType === 'mouse' && evt.button !== 0) return false;
      if (mode === 'resize' && !zoneIsMeasurable()) return false;
      evt.preventDefault();
      evt.stopPropagation();
      evt.currentTarget.setPointerCapture(evt.pointerId);
      edit = {mode: mode, from: toPercent(evt, feed), box: shownBox};
      return true;
    }
    function moveEdit(evt, done) {
      if (!edit) return;
      const at = toPercent(evt, feed);
      if (edit.mode === 'move') {
        const box = shiftBox(edit.box, at.x - edit.from.x, at.y - edit.from.y,
            maxX, maxY);
        drawRect(box.a, box.b, edit.box.saved);
        if (edit.box.saved) {
          savedCenter = {x: (box.a.x + box.b.x) / 2, y: (box.a.y + box.b.y) / 2};
        } else {
          lastBox = {a: box.a, b: box.b};
        }
        drawThresholds(box);
      } else {
        drawRect(edit.box.a, at);
        if (done) {
          finishDrag(edit.box.a, at);
          // Tuning the ratios against the new box needs the panel.
          const panel = document.getElementById('rectangleSettings');
          if (panel && lastBox) panel.style.display = '';
        } else {
          apply(edit.box.a, at);
        }
      }
      if (done) edit = null;
    }

    const rect = document.getElementById('objectRect');
    if (rect) {
      // Armed or not, a press on the box moves it; startEdit stops it reaching
      // the feed, so only a press outside the box starts a new one.
      rect.addEventListener('pointerdown', function(evt) {
        startEdit(evt, 'move');
      });
      rect.addEventListener('pointermove', function(evt) {
        moveEdit(evt, false);
      });
      rect.addEventListener('pointerup', function(evt) {
        moveEdit(evt, true);
      });
      rect.addEventListener('pointercancel', function(evt) {
        moveEdit(evt, true);
      });
    }
    const handle = resizeHandle();
    if (handle) {
      handle.addEventListener('pointerdown', function(evt) {
        startEdit(evt, 'resize');
      });
      handle.addEventListener('pointermove', function(evt) {
        moveEdit(evt, false);
      });
      handle.addEventListener('pointerup', function(evt) {
        moveEdit(evt, true);
      });
      handle.addEventListener('pointercancel', function(evt) {
        moveEdit(evt, true);
      });
    }

    showSavedObject();
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init);
  }
})(typeof window !== 'undefined' ? window : globalThis);
