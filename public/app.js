(() => {
  "use strict";

  // runSeq is a monotonically increasing token: every client switch or
  // new trigger bumps it, and any in-flight run whose token no longer
  // matches stops painting the stepper/receipt.
  const state = {
    clients: [],
    selectedClientId: null,
    runSeq: 0,
    view: localStorage.getItem("messynet-view") || "client",
    pageLoadedAt: new Date().toISOString(),
    dashSeq: 0,
    lastDashSignature: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = window.Charts.esc;

  // --- Theme toggle ---------------------------------------------------
  const themeToggle = $("#theme-toggle");
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }
  applyTheme(localStorage.getItem("messynet-theme"));
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const currentlyDark = current ? current === "dark" : prefersDark;
    const next = currentlyDark ? "light" : "dark";
    localStorage.setItem("messynet-theme", next);
    applyTheme(next);
  });

  // --- View toggle (Client view / Technical view) ----------------------
  function setView(view) {
    state.view = view;
    localStorage.setItem("messynet-view", view);
    document.body.classList.toggle("view-client", view === "client");
    document.body.classList.toggle("view-tech", view === "tech");
    document.querySelectorAll("#view-toggle .segment").forEach((seg) => {
      const selected = seg.dataset.view === view;
      seg.classList.toggle("selected", selected);
      seg.setAttribute("aria-selected", String(selected));
    });
    if (view === "client") refreshDashboard();
  }
  document.querySelectorAll("#view-toggle .segment").forEach((seg) => {
    seg.addEventListener("click", () => setView(seg.dataset.view));
  });

  // --- Demo controls: auto-deliver + outage simulation ------------------
  const autoToggle = $("#auto-toggle");
  const outageToggle = $("#outage-toggle");

  function setDemoStatus(text, tone) {
    const box = $("#demo-status");
    box.textContent = text;
    box.className = "control-status" + (tone ? ` ${tone}` : "");
  }

  function updateAutoHint(enabled, intervalSeconds) {
    $("#auto-hint").textContent = enabled
      ? `on — a feed delivers itself every ${intervalSeconds}s, no one asks`
      : "off — feeds arrive on their own when on";
  }

  async function initControls() {
    try {
      const [scheduler, outage] = await Promise.all([
        fetch("/demo/scheduler").then((r) => r.json()),
        fetch("/demo/outage").then((r) => r.json()),
      ]);
      autoToggle.checked = scheduler.enabled;
      updateAutoHint(scheduler.enabled, scheduler.interval_seconds);
      outageToggle.checked = outage.enabled;
    } catch {
      /* demo endpoints unavailable - controls stay off */
    }
  }

  autoToggle.addEventListener("change", async () => {
    const res = await fetch("/demo/scheduler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: autoToggle.checked }),
    }).then((r) => r.json());
    updateAutoHint(res.enabled, res.interval_seconds);
    setDemoStatus(
      res.enabled
        ? "Auto-deliver on. This is the product: data arriving without being asked."
        : "Auto-deliver off.",
      res.enabled ? "ok" : ""
    );
  });

  outageToggle.addEventListener("change", async () => {
    const res = await fetch("/demo/outage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: outageToggle.checked }),
    }).then((r) => r.json());
    setDemoStatus(
      res.enabled
        ? "Client endpoint is now down (503). Webhook deliveries will retry with backoff, then dead-letter (§7.2)."
        : "Client endpoint restored. Use Re-deliver on any dead-lettered run to recover it.",
      res.enabled ? "warn" : "ok"
    );
  });

  // --- JSON syntax highlighting ---------------------------------------
  function syntaxHighlight(value) {
    const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escaped.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = "jn";
        if (/^"/.test(match)) cls = /:$/.test(match) ? "jk" : "js";
        else if (/true|false/.test(match)) cls = "jb";
        else if (/null/.test(match)) cls = "jnull";
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  function statusBadge(status) {
    const map = { success: ["good", "success"], retrying: ["warning", "retrying"], pending: ["warning", "pending"], failed: ["critical", "failed"] };
    const [cls, label] = map[status] || ["warning", status];
    return `<span class="badge badge-${cls}"><span class="badge-dot"></span>${label}</span>`;
  }

  function mechanismLabel(mechanism) {
    return { webhook: "Webhook POST", cloud_storage: "Cloud Storage Drop", delta: "Delta Polling" }[mechanism] || mechanism;
  }

  // --- Load clients ------------------------------------------------------
  async function loadClients() {
    const res = await fetch("/demo/clients");
    state.clients = await res.json();
    renderClientList();
    populateDeltaClientOptions();
    if (state.clients.length) selectClient(state.clients[0].client_id);
  }

  function renderClientList() {
    const container = $("#client-list");
    container.innerHTML = "";
    for (const client of state.clients) {
      const feed = client.feeds[0];
      const btn = document.createElement("button");
      btn.className = "client-card" + (client.client_id === state.selectedClientId ? " selected" : "");
      btn.innerHTML = `
        <div class="client-card-name">${esc(client.client_name)}</div>
        <div class="client-card-meta">
          <span class="pill pill-accent">${esc(feed.feed_type)}</span>
          <span class="pill">${esc(mechanismLabel(feed.delivery.mechanism))}</span>
        </div>`;
      btn.addEventListener("click", () => selectClient(client.client_id));
      container.appendChild(btn);
    }
  }

  function selectClient(clientId) {
    state.selectedClientId = clientId;
    state.runSeq++; // invalidate any in-flight run's UI updates
    renderClientList();
    renderFeedDetail();
    resetStepper();
    $("#receipt").innerHTML = `<div class="empty-state">Trigger a run to see the delivered payload.</div>`;
    if (state.view === "client") refreshDashboard();
  }

  function selectedClient() {
    return state.clients.find((c) => c.client_id === state.selectedClientId);
  }

  function renderFeedDetail() {
    const client = selectedClient();
    const card = $("#feed-detail-card");
    if (!client) {
      card.innerHTML = `<div class="empty-state">Select a client to see its feed configuration.</div>`;
      return;
    }
    const feed = client.feeds[0];
    const d = feed.delivery;
    const rows = [
      ["Feed type", feed.feed_type + (feed.composite_components ? ` (${feed.composite_components.join(" + ")})` : "")],
      ["Schema version", feed.schema_version === "1" ? `${feed.feed_type}-v1` : feed.schema_version],
      ["Cadence", `<code>${esc(feed.cadence)}</code>`],
      ["Delivery mechanism", mechanismLabel(d.mechanism)],
    ];
    if (d.mechanism === "webhook") {
      rows.push(["Endpoint", esc(d.endpoint)], ["Format", d.format.toUpperCase()], ["HMAC signing", d.hmac_enabled ? "enabled" : "disabled"]);
    } else if (d.mechanism === "cloud_storage") {
      rows.push(["Provider", d.provider], ["Bucket", esc(d.bucket)], ["Format", d.format.toUpperCase()]);
    }
    card.innerHTML = `
      <div class="feed-detail-header">
        <div>
          <p class="feed-detail-title">${esc(client.client_name)}</p>
          <p class="feed-detail-sub">client_id: <code>${esc(client.client_id)}</code> · SLA tier: ${esc(client.sla_tier)}</p>
        </div>
        <button id="trigger-btn" class="btn btn-primary" type="button">Trigger Run Now</button>
      </div>
      <div class="feed-detail-grid">
        ${rows.map(([label, value]) => `<div><div class="detail-field-label">${label}</div><div class="detail-field-value">${value}</div></div>`).join("")}
      </div>`;
    $("#trigger-btn").addEventListener("click", () => triggerRun(client, 0, feed));
  }

  // --- Pipeline stepper ----------------------------------------------
  function resetStepper() {
    document.querySelectorAll(".step").forEach((el) => {
      el.classList.remove("active", "done", "failed", "retry");
      el.querySelector(".step-note").textContent = "—";
    });
  }
  function setStep(name, status, note) {
    const el = document.querySelector(`.step[data-step="${name}"]`);
    el.classList.remove("active", "done", "failed", "retry");
    if (status) el.classList.add(status);
    if (note !== undefined) el.querySelector(".step-note").textContent = note;
  }

  async function pollRunTerminal(runId, onTick) {
    for (let i = 0; i < 120; i++) {
      const log = await fetch(`/demo/run/${runId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (log) {
        onTick?.(log);
        if (log.status === "success" || log.status === "failed") return log;
      }
      await sleep(1000);
    }
    return null;
  }

  async function triggerRun(client, feedIndex, feed) {
    const myToken = ++state.runSeq;
    const live = () => state.runSeq === myToken && state.selectedClientId === client.client_id;

    const btn = $("#trigger-btn");
    if (btn) btn.disabled = true;
    resetStepper();
    $("#receipt").innerHTML = `<div class="empty-state">Running…</div>`;

    setStep("scheduler", "active", "cron trigger fired");
    await sleep(280);
    if (live()) {
      setStep("scheduler", "done", feed.cadence);
      setStep("extractor", "active", "querying data source…");
    }

    const triggerPromise = fetch("/demo/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: client.client_id, feed_index: feedIndex }),
    }).then((r) => r.json());

    await sleep(450);
    if (live()) {
      setStep("extractor", "done", "records extracted");
      setStep("formatter", "active", `serializing → ${feed.delivery.format ? feed.delivery.format.toUpperCase() : "n/a"}`);
    }
    await sleep(320);
    if (live()) {
      setStep("formatter", "done", feed.delivery.format ? feed.delivery.format.toUpperCase() : "—");
      setStep("delivery", "active", feed.delivery.mechanism === "webhook" ? "POST → client endpoint" : "writing to bucket…");
    }

    const result = await triggerPromise;
    if (!live()) {
      refreshRunLog();
      return;
    }
    let log = result.run_log;

    if (!log) {
      setStep("delivery", "failed", result.error || "error");
      setStep("runlog", "failed", "—");
      $("#receipt").innerHTML = `<div class="empty-state">Run failed before delivery: ${esc(result.error || "unknown error")}</div>`;
      if (btn) btn.disabled = false;
      return;
    }

    // Non-terminal = the Delivery Agent is inside its §7.2 retry cycle
    // (e.g. the outage toggle is on). Watch it live instead of guessing.
    if (log.status === "pending" || log.status === "retrying") {
      const terminal = await pollRunTerminal(result.run_id, (l) => {
        if (live() && l.status === "retrying") {
          setStep("delivery", "retry", `attempt ${l.attempt_count} of 5 — backing off, retrying`);
        }
      });
      if (!live()) {
        refreshRunLog();
        return;
      }
      log = terminal ?? log;
    }

    if (log.status === "success") {
      setStep("delivery", "done", feed.delivery.mechanism === "webhook" ? `2xx received (attempt ${log.attempt_count})` : "file written");
    } else {
      setStep("delivery", "failed", log.error || "delivery failed");
    }
    setStep("runlog", "active", "writing run record…");
    await sleep(200);
    if (!live()) {
      refreshRunLog();
      return;
    }
    setStep("runlog", log.status === "success" ? "done" : "failed", log.status);

    await renderReceipt(client, feed, { run_id: result.run_id, run_log: log }, live);
    await refreshRunLog();
    await refreshDlq();
    if (live() && btn) btn.disabled = false;
  }

  // --- Receipt (what the client receives) -----------------------------
  async function renderReceipt(client, feed, result, live = () => true) {
    const container = $("#receipt");
    const runId = result.run_id;
    const mechanism = feed.delivery.mechanism;
    const log = result.run_log;

    if (log && log.status === "failed") {
      container.innerHTML = `
        <div class="receipt-header">
          <span class="badge badge-critical"><span class="badge-dot"></span>moved to dead-letter queue</span>
        </div>
        <div class="empty-state">
          Delivery exhausted ${log.attempt_count} attempts (${esc(log.error || "endpoint unreachable")}).
          The payload is retained — restore the endpoint (toggle the outage off), then re-deliver it.
        </div>
        <button class="btn btn-primary btn-sm" data-redeliver="${esc(runId)}" type="button">Re-deliver this run</button>`;
      container.querySelector("[data-redeliver]").addEventListener("click", (e) => redeliver(runId, e.currentTarget));
      return;
    }

    if (mechanism === "webhook") {
      const inbox = await fetch("/demo/inbox").then((r) => r.json());
      if (!live()) return;
      const delivery = inbox.find((d) => d.headers["x-messynet-run-id"] === runId);
      if (!delivery) {
        container.innerHTML = `<div class="empty-state">No delivery reached the inbox (run status: ${esc(log.status)}).</div>`;
        return;
      }
      const sig = delivery.signatureValid;
      const sigBadge =
        sig === true
          ? `<span class="badge badge-good"><span class="badge-dot"></span>HMAC signature verified</span>`
          : sig === false
          ? `<span class="badge badge-critical"><span class="badge-dot"></span>HMAC signature invalid</span>`
          : `<span class="badge badge-warning"><span class="badge-dot"></span>unsigned</span>`;
      container.innerHTML = `
        <div class="receipt-header">
          <span class="pill pill-accent">Webhook POST received</span>
          ${sigBadge}
        </div>
        <div class="receipt-headers">
          <div>X-MessyNet-Feed: ${esc(delivery.headers["x-messynet-feed"] || "")}</div>
          <div>X-MessyNet-Run-ID: ${esc(delivery.headers["x-messynet-run-id"] || "")}</div>
          <div>X-MessyNet-Timestamp: ${esc(delivery.headers["x-messynet-timestamp"] || "")}</div>
        </div>
        <pre class="json-viewer">${syntaxHighlight(delivery.body)}</pre>`;
    } else if (mechanism === "cloud_storage") {
      const drops = await fetch("/demo/drops").then((r) => r.json());
      if (!live()) return;
      const file = drops.find((f) => f.path.includes(runId));
      if (!file) {
        container.innerHTML = `<div class="empty-state">No file found for this run (status: ${esc(log.status)}).</div>`;
        return;
      }
      const preview = await fetch(`/demo/drops/preview?path=${encodeURIComponent(file.path)}`).then((r) => r.json());
      if (!live()) return;
      const previewHtml = preview.binary
        ? `<div class="empty-state">${esc(preview.note)} (${(preview.size / 1024).toFixed(1)} KB)</div>`
        : `<pre class="json-viewer">${preview.format === "json" ? syntaxHighlight(JSON.parse(preview.content)) : esc(preview.content)}</pre>`;
      container.innerHTML = `
        <div class="receipt-header"><span class="pill pill-accent">Cloud Storage Drop written</span></div>
        <div class="receipt-file-meta">${esc(file.path)}<br/>${(file.size / 1024).toFixed(1)} KB · written ${new Date(file.mtime).toLocaleTimeString()}</div>
        ${previewHtml}`;
    } else {
      container.innerHTML = `<div class="empty-state">Delta Polling is pull-only — nothing is pushed. Use the playground below to fetch it.</div>`;
    }
  }

  // --- Run log + live counter -------------------------------------------
  async function refreshRunLog() {
    const runs = await fetch("/demo/runs").then((r) => r.json());
    const clientNameById = Object.fromEntries(state.clients.map((c) => [c.client_id, c.client_name]));
    const tbody = $("#run-log-body");
    tbody.innerHTML = runs
      .map(
        (r) => `
      <tr>
        <td>${new Date(r.scheduled_at).toLocaleTimeString()}</td>
        <td>${esc(clientNameById[r.client_id] || r.client_id)}</td>
        <td>${esc(r.feed_type)}</td>
        <td>${esc(mechanismLabel(r.delivery_mechanism))}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.attempt_count}</td>
      </tr>`
      )
      .join("");
    if (!runs.length) tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No runs yet.</td></tr>`;

    const sincLoad = runs.filter((r) => r.status === "success" && r.delivered_at && r.delivered_at >= state.pageLoadedAt).length;
    const counter = document.querySelector("#compare-live-counter strong");
    if (counter) counter.textContent = String(sincLoad);
  }

  // --- Dead-letter queue --------------------------------------------------
  async function refreshDlq() {
    const entries = await fetch("/demo/dlq").then((r) => r.json()).catch(() => []);
    const container = $("#dlq-body");
    if (!entries.length) {
      container.innerHTML = `<div class="empty-state">Empty — no delivery has exhausted its retries.</div>`;
      return;
    }
    const clientNameById = Object.fromEntries(state.clients.map((c) => [c.client_id, c.client_name]));
    container.innerHTML = `
      <div class="table-wrap">
        <table class="run-table">
          <thead><tr><th>Failed at</th><th>Client</th><th>Feed</th><th>Attempts</th><th>Last error</th><th></th></tr></thead>
          <tbody>
            ${entries
              .map(
                (e) => `
              <tr>
                <td>${new Date(e.failed_at).toLocaleTimeString()}</td>
                <td>${esc(clientNameById[e.client_id] || e.client_id)}</td>
                <td>${esc(e.feed_type)}</td>
                <td>${e.attempt_count}</td>
                <td class="dlq-error">${esc(e.last_error)}</td>
                <td><button class="btn btn-ghost btn-sm" data-redeliver="${esc(e.run_id)}" type="button">Re-deliver</button></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
    container.querySelectorAll("[data-redeliver]").forEach((btn) => {
      btn.addEventListener("click", () => redeliver(btn.dataset.redeliver, btn));
    });
  }

  async function redeliver(runId, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Re-delivering…";
    }
    setDemoStatus("Re-delivering from the dead-letter queue…", "");
    const out = await fetch("/demo/redeliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    }).then((r) => r.json());
    if (out.ok) {
      setDemoStatus("Re-delivery succeeded — the run left the dead-letter queue.", "ok");
    } else {
      setDemoStatus(`Re-delivery failed again: ${out.error || "endpoint still unreachable"}. Is the outage toggle still on?`, "warn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Re-deliver";
      }
    }
    await refreshDlq();
    await refreshRunLog();
  }

  // --- Client-view dashboard ---------------------------------------------
  const DASH_BRANDS = {
    "solstice-sg": { title: "Solstice Intelligence — Community Radar", tagline: "agency planning dashboard" },
    "northwire-apac": { title: "Northwire — Social Signal Intake", tagline: "internal models data feed" },
    "acme-brand-sg": { title: "Acme Insurance — Brand Health", tagline: "reputation monitoring" },
    "orbit-whitelabel": { title: "Orbit Platform — Intelligence Suite", tagline: "white-label, Orbit branding" },
  };

  function kpiTile(label, value, opts = {}) {
    const delta =
      opts.delta !== undefined
        ? `<span class="kpi-delta ${opts.delta >= 0 ? "up" : "down"}">${opts.delta >= 0 ? "▲" : "▼"} ${esc(opts.deltaText ?? Math.abs(opts.delta))}</span>`
        : "";
    return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}${delta}</div></div>`;
  }

  function chartBlock(title, id, extraClass = "") {
    return `<div class="chart-block ${extraClass}"><h3 class="chart-block-title">${esc(title)}</h3><div class="chart-slot" id="${id}"></div></div>`;
  }

  function sentimentParts(dist) {
    return [
      { label: "Positive", value: dist.positive, color: "var(--chart-pos)", textColor: "#fff" },
      { label: "Neutral", value: dist.neutral, color: "var(--chart-neutral)", textColor: "var(--surface)" },
      { label: "Negative", value: dist.negative, color: "var(--chart-neg)", textColor: "#fff" },
    ];
  }

  async function refreshDashboard(force = false) {
    const client = selectedClient();
    if (!client) return;
    const mySeq = ++state.dashSeq;
    const data = await fetch(`/demo/dashboard/${client.client_id}`).then((r) => r.json()).catch(() => null);
    if (mySeq !== state.dashSeq || state.selectedClientId !== client.client_id) return; // stale
    // Re-rendering replaces the whole card - skip when nothing new arrived,
    // so background polling doesn't jolt the layout mid-read.
    const signature = data ? `${client.client_id}:${data.runs_received}:${data.last_run_at}` : "none";
    if (!force && signature === state.lastDashSignature) return;
    state.lastDashSignature = signature;
    renderDashboard(client, data);
  }

  function renderDashboard(client, data) {
    const container = $("#client-dashboard");
    const brand = DASH_BRANDS[client.client_id] ?? { title: client.client_name, tagline: "" };

    if (!data || !data.runs_received) {
      container.innerHTML = `
        <div class="dash-header">
          <div>
            <p class="dash-brand">${esc(brand.title)}</p>
            <p class="dash-sub">${esc(brand.tagline)} · powered by MessyNet API Feed</p>
          </div>
        </div>
        <div class="dash-empty">
          <p>Nothing here yet — this dashboard fills itself when feeds arrive.</p>
          <div class="dash-empty-actions">
            <button id="dash-auto-cta" class="btn btn-primary" type="button">Turn on Auto-deliver</button>
            <button id="dash-once-cta" class="btn btn-ghost" type="button">Deliver one now</button>
          </div>
          <p class="control-hint">No polling scripts, no cron jobs on the client side — MessyNet pushes on schedule and this view updates.</p>
        </div>`;
      $("#dash-auto-cta")?.addEventListener("click", () => {
        if (!autoToggle.checked) {
          autoToggle.checked = true;
          autoToggle.dispatchEvent(new Event("change"));
        }
      });
      $("#dash-once-cta")?.addEventListener("click", () => triggerRun(client, 0, client.feeds[0]));
      return;
    }

    const lastAt = data.last_run_at ? new Date(data.last_run_at).toLocaleTimeString() : "—";
    const renders = [];
    let kpis = "";
    let body = "";

    if (data.atlas) {
      const a = data.atlas.latest;
      const pos = Math.round((a.sentiment_distribution.positive ?? 0) * 100);
      kpis += kpiTile("Posts analyzed", window.Charts.compact(a.post_count));
      kpis += kpiTile("Communities detected", String(a.communities.length));
      kpis += kpiTile("Positive sentiment", `${pos}%`);
      kpis += kpiTile("Bridge posts", String(a.bridge_count));
      body += `<div class="narrative-callout"><span class="narrative-kicker">Top narrative right now</span>${esc(a.top_narrative)}</div>`;
      body += `<div class="dash-grid">
        ${chartBlock("Sentiment across all clusters", "chart-atlas-sentiment")}
        ${chartBlock("Posts by platform", "chart-atlas-platforms")}
        ${chartBlock("Community clusters — posts per cluster", "chart-atlas-communities")}
        ${chartBlock("Posts analyzed per delivery", "chart-atlas-trend")}
      </div>`;
      renders.push(() => {
        window.Charts.shareBar($("#chart-atlas-sentiment"), sentimentParts(a.sentiment_distribution));
        window.Charts.barChartH(
          $("#chart-atlas-platforms"),
          Object.entries(a.platform_totals).sort((x, y) => y[1] - x[1]).map(([label, value]) => ({ label, value }))
        );
        window.Charts.barChartH(
          $("#chart-atlas-communities"),
          a.communities.slice(0, 7).map((c) => ({ label: c.narrative ? `${c.id} ·` : c.id, value: c.size })),
          { labelWidth: 44 }
        );
        window.Charts.lineChart(
          $("#chart-atlas-trend"),
          data.atlas.history.map((h) => ({ t: h.run_at, y: h.post_count }))
        );
      });
    }

    if (data.pipeline) {
      const p = data.pipeline.latest;
      const total = data.pipeline.history.reduce((sum, h) => sum + h.record_count, 0);
      kpis += kpiTile("Records (latest drop)", window.Charts.compact(p.record_count));
      kpis += kpiTile("Records (all drops)", window.Charts.compact(total));
      kpis += kpiTile("Engagement captured", window.Charts.compact(p.total_engagement));
      kpis += kpiTile("Drops received", String(data.pipeline.history.length));
      body += `<div class="dash-grid">
        ${chartBlock("Records by platform (latest drop)", "chart-pipe-platforms")}
        ${chartBlock("Records by media type", "chart-pipe-media")}
        ${chartBlock("Records per drop", "chart-pipe-trend", "chart-block-wide")}
      </div>`;
      renders.push(() => {
        window.Charts.barChartH(
          $("#chart-pipe-platforms"),
          Object.entries(p.by_platform).sort((x, y) => y[1] - x[1]).map(([label, value]) => ({ label, value }))
        );
        window.Charts.barChartH(
          $("#chart-pipe-media"),
          Object.entries(p.by_media_type).sort((x, y) => y[1] - x[1]).map(([label, value]) => ({ label, value }))
        );
        window.Charts.lineChart(
          $("#chart-pipe-trend"),
          data.pipeline.history.map((h) => ({ t: h.run_at, y: h.record_count }))
        );
      });
    }

    if (data.reputation) {
      const r = data.reputation.latest;
      kpis += kpiTile("Brand score", r.brand_score.toFixed(3), {
        delta: r.score_delta,
        deltaText: `${Math.abs(r.score_delta).toFixed(3)} vs prior run`,
      });
      kpis += kpiTile("Articles scored", String(r.article_count));
      kpis += kpiTile("Brand", r.brand);
      body += `<div class="dash-grid">
        ${chartBlock("Score components (0–1)", "chart-rep-components")}
        ${chartBlock("Brand score per delivery", "chart-rep-trend")}
        <div class="chart-block chart-block-wide">
          <h3 class="chart-block-title">Top scored articles</h3>
          <ul class="article-list">
            ${r.top_articles
              .slice(0, 5)
              .map(
                (art) =>
                  `<li><span class="article-source">${esc(art.source)}</span><span class="article-date">${esc(art.published_at)}</span><span class="article-score">${Number(art.article_score).toFixed(2)}</span></li>`
              )
              .join("")}
          </ul>
        </div>
      </div>`;
      renders.push(() => {
        window.Charts.barChartH(
          $("#chart-rep-components"),
          [
            { label: "Sentiment", value: r.components.sentiment },
            { label: "Coverage", value: r.components.coverage },
            { label: "Relevance", value: r.components.relevance },
            { label: "Recency", value: r.components.age },
          ],
          { maxValue: 1, valueFormat: (v) => v.toFixed(2) }
        );
        window.Charts.lineChart(
          $("#chart-rep-trend"),
          data.reputation.history.map((h) => ({ t: h.run_at, y: h.brand_score })),
          { yDomain: [0, 1], yFormat: (v) => v.toFixed(1) }
        );
      });
    }

    container.innerHTML = `
      <div class="dash-header">
        <div>
          <p class="dash-brand">${esc(brand.title)}</p>
          <p class="dash-sub">${esc(brand.tagline)} · powered by MessyNet API Feed · ${esc(data.feed_type)} via ${esc(mechanismLabel(data.mechanism))}</p>
        </div>
        <div class="dash-meta">
          <span class="dash-last">Last delivery <strong>${esc(lastAt)}</strong> · ${data.runs_received} received</span>
          <button id="dash-deliver-now" class="btn btn-ghost btn-sm" type="button">Deliver now</button>
        </div>
      </div>
      <div class="kpi-row">${kpis}</div>
      ${body}`;
    $("#dash-deliver-now")?.addEventListener("click", () => triggerRun(client, 0, client.feeds[0]));
    renders.forEach((fn) => fn());
  }

  // --- Delta Polling playground ---------------------------------------
  const FEED_TYPES = ["pipeline", "atlas", "reputation"];

  function populateDeltaClientOptions() {
    const sel = $("#delta-client");
    sel.innerHTML = state.clients.map((c) => `<option value="${esc(c.client_id)}">${esc(c.client_name)}</option>`).join("");
    sel.addEventListener("change", populateDeltaFeedTypeOptions);
    populateDeltaFeedTypeOptions();

    const since = $("#delta-since");
    const d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    since.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function populateDeltaFeedTypeOptions() {
    const client = state.clients.find((c) => c.client_id === $("#delta-client").value);
    const sel = $("#delta-feed-type");
    if (!client) return;
    const scopes = client.scopes || [];
    const allowed = FEED_TYPES.filter((t) => scopes.includes(`${t}:read`) || scopes.includes("*:read"));
    sel.innerHTML = (allowed.length ? allowed : FEED_TYPES).map((t) => `<option value="${t}">${t}</option>`).join("");
  }

  function setDeltaStatus(text, ok) {
    const el = $("#delta-status");
    el.textContent = text;
    el.className = "delta-status" + (ok === true ? " ok" : ok === false ? " err" : "");
  }

  async function runDeltaQuery({ apiKeyOverride, omitSince, feedTypeOverride } = {}) {
    const client = state.clients.find((c) => c.client_id === $("#delta-client").value);
    const feedType = feedTypeOverride || $("#delta-feed-type").value;
    const since = $("#delta-since").value;
    const limit = $("#delta-limit").value;
    const apiKey = apiKeyOverride !== undefined ? apiKeyOverride : client.api_key;

    const params = new URLSearchParams();
    if (!omitSince && since) params.set("since", new Date(since).toISOString());
    if (limit) params.set("limit", limit);

    const res = await fetch(`/v2/feed/${feedType}?${params.toString()}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const body = await res.json().catch(() => ({}));
    setDeltaStatus(`GET /v2/feed/${feedType}?${params.toString()} → ${res.status}`, res.ok);
    $("#delta-response").innerHTML = syntaxHighlight(body);
  }

  $("#delta-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runDeltaQuery();
  });
  $("#test-bad-key").addEventListener("click", () => runDeltaQuery({ apiKeyOverride: "not-a-real-key" }));
  $("#test-no-since").addEventListener("click", () => runDeltaQuery({ omitSince: true }));
  $("#test-wrong-scope").addEventListener("click", () => {
    const client = state.clients.find((c) => c.client_id === $("#delta-client").value);
    const scopes = client.scopes || [];
    const disallowed = FEED_TYPES.find((t) => !scopes.includes(`${t}:read`) && !scopes.includes("*:read"));
    if (!disallowed) {
      setDeltaStatus("This client is scoped for every feed type — no forbidden request to demonstrate.", null);
      return;
    }
    runDeltaQuery({ feedTypeOverride: disallowed });
  });

  // --- Background refresh: the dashboard fills itself ---------------------
  setInterval(() => {
    refreshRunLog();
    refreshDlq();
    if (state.view === "client") refreshDashboard();
  }, 4000);

  setView(state.view);
  initControls();
  loadClients().then(() => {
    refreshRunLog();
    refreshDlq();
  });
})();
