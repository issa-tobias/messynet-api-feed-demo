// Minimal SVG chart helpers for the client-view dashboard. No library -
// three forms only, each following the same mark specs: thin marks with
// 4px rounded data-ends (square at the baseline), 2px lines with an 8px+
// end marker ringed in the surface color, hairline solid gridlines, and
// direct labels in text tokens (never the series color).
(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    for (const child of children) node.appendChild(child);
    return node;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function compact(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    if (abs >= 1_000) return Math.round(n).toLocaleString();
    if (abs > 0 && abs < 1) return n.toFixed(2);
    return String(Math.round(n * 100) / 100);
  }

  // Round up to 1/2/5 x 10^n so axis ticks land on clean numbers.
  function niceCeil(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / pow;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
  }

  // --- shared tooltip ------------------------------------------------------
  const tooltip = () => document.getElementById("chart-tooltip");

  function showTip(html, x, y) {
    const tip = tooltip();
    if (!tip) return;
    tip.innerHTML = html;
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const left = Math.min(x + 12, window.innerWidth - rect.width - 8);
    const top = Math.max(4, y - rect.height - 10);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTip() {
    const tip = tooltip();
    if (tip) tip.hidden = true;
  }

  function bindTip(node, html) {
    node.addEventListener("mousemove", (e) => showTip(html, e.clientX, e.clientY));
    node.addEventListener("mouseleave", hideTip);
  }

  // Horizontal bar with a 4px rounded data-end (right) and a square
  // baseline end (left). Falls back to a plain rect when too short to round.
  function hBarPath(x, y, w, h) {
    const r = Math.min(4, w);
    if (w <= 4) return el("rect", { x, y, width: Math.max(w, 1), height: h, class: "mark" });
    const d = `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
    return el("path", { d, class: "mark" });
  }

  // --- form 1: horizontal bar chart (magnitude, one hue) --------------------
  // items: [{label, value}], opts: {color?, maxValue?, valueFormat?}
  function barChartH(container, items, opts = {}) {
    container.innerHTML = "";
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">No data yet.</div>`;
      return;
    }
    const width = Math.max(container.clientWidth || 320, 220);
    const rowH = 15;
    const rowGap = 9;
    const labelW = opts.labelWidth ?? 88;
    const valueW = 46;
    const height = items.length * (rowH + rowGap) - rowGap + 4;
    const max = opts.maxValue ?? Math.max(...items.map((d) => d.value), 1);
    const plotW = width - labelW - valueW - 8;
    const fmt = opts.valueFormat ?? compact;
    const color = opts.color ?? "var(--chart-seq)";

    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
    items.forEach((d, i) => {
      const y = i * (rowH + rowGap) + 2;
      const w = Math.max((d.value / max) * plotW, d.value > 0 ? 2 : 0);
      const label = el("text", { x: labelW - 6, y: y + rowH - 4, "text-anchor": "end", class: "axis-label" });
      label.textContent = d.label;
      svg.appendChild(label);
      const bar = hBarPath(labelW, y, w, rowH);
      bar.style.fill = color;
      svg.appendChild(bar);
      const value = el("text", { x: labelW + w + 6, y: y + rowH - 4, class: "value-label" });
      value.textContent = fmt(d.value);
      svg.appendChild(value);
      const hit = el("rect", { x: 0, y: y - 2, width, height: rowH + 4, fill: "transparent" });
      bindTip(hit, `<strong>${esc(d.label)}</strong> ${esc(fmt(d.value))}`);
      svg.appendChild(hit);
    });
    container.appendChild(svg);
  }

  // --- form 2: 100% share bar (ordered scale -> diverging colors) -----------
  // parts: [{label, value, color}] - 2px surface gaps between segments,
  // % labels inside only where they fit, legend carries the rest.
  function shareBar(container, parts, opts = {}) {
    container.innerHTML = "";
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    if (!total) {
      container.innerHTML = `<div class="empty-state">No data yet.</div>`;
      return;
    }
    const width = Math.max(container.clientWidth || 320, 220);
    const barH = 20;
    const gap = 2;
    const svg = el("svg", { viewBox: `0 0 ${width} ${barH}`, width: "100%", height: barH, role: "img" });
    let x = 0;
    const usable = width - gap * (parts.filter((p) => p.value > 0).length - 1);
    parts.forEach((p, i) => {
      if (p.value <= 0) return;
      const w = (p.value / total) * usable;
      const isFirst = x === 0;
      const rx = 4;
      const seg = el("rect", { x, y: 0, width: w, height: barH, rx: 0 });
      // round only the outer ends of the full bar
      if (isFirst || i === parts.length - 1) seg.setAttribute("rx", rx);
      seg.style.fill = p.color;
      const pct = Math.round((p.value / total) * 100);
      bindTip(seg, `<strong>${esc(p.label)}</strong> ${pct}%`);
      svg.appendChild(seg);
      if (w > 38) {
        const t = el("text", { x: x + w / 2, y: barH / 2 + 4, "text-anchor": "middle", class: "seg-label" });
        t.textContent = `${pct}%`;
        t.style.fill = p.textColor ?? "#fff";
        t.style.pointerEvents = "none";
        svg.appendChild(t);
      }
      x += w + gap;
    });
    container.appendChild(svg);

    const legend = document.createElement("div");
    legend.className = "chart-legend";
    legend.innerHTML = parts
      .map(
        (p) =>
          `<span class="legend-item"><span class="legend-swatch" style="background:${p.color}"></span>${esc(p.label)} <span class="muted">${Math.round((p.value / total) * 100)}%</span></span>`
      )
      .join("");
    container.appendChild(legend);
  }

  // --- form 3: line chart (trend over deliveries, single series) ------------
  // points: [{t: Date|string, y: number, label?}], opts: {yDomain?, yFormat?}
  function lineChart(container, points, opts = {}) {
    container.innerHTML = "";
    if (!points.length) {
      container.innerHTML = `<div class="empty-state">No deliveries yet.</div>`;
      return;
    }
    const pts = points.map((p) => ({ t: new Date(p.t).getTime(), y: p.y, raw: p }));
    const width = Math.max(container.clientWidth || 320, 220);
    const height = opts.height ?? 130;
    const m = { top: 10, right: 46, bottom: 20, left: 40 };
    const fmt = opts.yFormat ?? compact;

    const tMin = Math.min(...pts.map((p) => p.t));
    const tMax = Math.max(...pts.map((p) => p.t));
    let [yMin, yMax] = opts.yDomain ?? [0, niceCeil(Math.max(...pts.map((p) => p.y)) * 1.1 || 1)];
    if (yMin === yMax) yMax = yMin + 1;

    const px = (t) => (tMax === tMin ? (m.left + width - m.right) / 2 : m.left + ((t - tMin) / (tMax - tMin)) * (width - m.left - m.right));
    const py = (y) => m.top + (1 - (y - yMin) / (yMax - yMin)) * (height - m.top - m.bottom);

    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });

    // hairline gridlines at clean halves of the niced max
    const ticks = 2;
    for (let i = 0; i <= ticks; i++) {
      const yVal = yMin + ((yMax - yMin) * i) / ticks;
      const gy = py(yVal);
      svg.appendChild(el("line", { x1: m.left, x2: width - m.right, y1: gy, y2: gy, class: "gridline" }));
      const t = el("text", { x: m.left - 6, y: gy + 3.5, "text-anchor": "end", class: "axis-label" });
      t.textContent = fmt(yVal);
      svg.appendChild(t);
    }

    // time labels: first + last
    const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const t0 = el("text", { x: m.left, y: height - 5, class: "axis-label" });
    t0.textContent = fmtTime(tMin);
    svg.appendChild(t0);
    if (tMax > tMin) {
      const t1 = el("text", { x: width - m.right, y: height - 5, "text-anchor": "end", class: "axis-label" });
      t1.textContent = fmtTime(tMax);
      svg.appendChild(t1);
    }

    if (pts.length > 1) {
      const lineD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
      const areaD = `${lineD} L${px(tMax).toFixed(1)},${py(yMin)} L${px(tMin).toFixed(1)},${py(yMin)} Z`;
      const area = el("path", { d: areaD, class: "area-wash" });
      svg.appendChild(area);
      const line = el("path", { d: lineD, class: "series-line" });
      svg.appendChild(line);
    }

    // end marker: >=8px dot with a 2px surface ring
    const last = pts[pts.length - 1];
    svg.appendChild(el("circle", { cx: px(last.t), cy: py(last.y), r: 6.5, class: "dot-ring" }));
    svg.appendChild(el("circle", { cx: px(last.t), cy: py(last.y), r: 4.5, class: "dot-mark" }));
    const endLabel = el("text", { x: px(last.t) + 9, y: py(last.y) + 4, class: "value-label value-label-strong" });
    endLabel.textContent = fmt(last.y);
    svg.appendChild(endLabel);

    // hover: nearest point
    const hit = el("rect", { x: 0, y: 0, width, height, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => {
      const rect = hit.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * width;
      let nearest = pts[0];
      for (const p of pts) if (Math.abs(px(p.t) - mx) < Math.abs(px(nearest.t) - mx)) nearest = p;
      showTip(`<strong>${fmt(nearest.y)}</strong> · ${fmtTime(nearest.t)}`, e.clientX, e.clientY);
    });
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);

    container.appendChild(svg);
  }

  window.Charts = { barChartH, shareBar, lineChart, compact, esc };
})();
