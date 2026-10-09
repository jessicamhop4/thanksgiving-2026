(() => {
  "use strict";

  const TRIP = window.TRIP;
  const DESTS = TRIP.destinations;
  const byId = Object.fromEntries(DESTS.map((d) => [d.id, d]));
  const LS = { code: "tg26.code", name: "tg26.name" };
  // Static mode: no server. Ratings and favorite live in this browser only and are shared by copy/paste.
  const STATIC = !!(window.CONFIG && window.CONFIG.static);
  const LOCAL_KEY = "tg26.local";
  const POLL_MS = (window.CONFIG && window.CONFIG.apiUrl) ? 30000 : 20000;

  // ---------- state ----------
  const S = {
    code: null,
    name: localStorage.getItem(LS.name) || "",
    tab: "discover",
    filters: { setting: "all", access: "all" },
    index: 0,
    data: null, // { people, ratings, comments }
    sync: "idle", // idle | loading | ok | error
    syncError: "",
    lastSync: null,
    sort: STATIC ? "mine" : "avg",
    commentKind: "feedback",
  };

  // Family code may arrive in the link (#k=...) — store it and scrub it from the address bar.
  (function readCode() {
    const m = location.hash.match(/k=([^&]+)/);
    if (m) {
      localStorage.setItem(LS.code, decodeURIComponent(m[1]));
      history.replaceState(null, "", location.pathname + location.search);
    }
    S.code = STATIC ? "local" : localStorage.getItem(LS.code);
  })();

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const money2 = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  const meId = () => S.name.trim().toLowerCase();
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };
  const fmtChecked = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  function toast(msg, kind = "ok", action) {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " error" : "");
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement("button");
      b.textContent = action.label;
      b.onclick = () => { el.remove(); action.fn(); };
      el.appendChild(b);
    }
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "error" ? 7000 : 2600);
  }

  // ---------- API ----------
  const CFG = window.CONFIG || {};

  // Two interchangeable backends: a Google Apps Script web app (CONFIG.apiUrl) or the local Worker (/api/*).
  async function api(path, opts = {}) {
    if (STATIC) return localApi(path, opts);
    if (CFG.apiUrl) return sheetsApi(path, opts);
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers: { "content-type": "application/json", "x-family-code": S.code || "" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function localApi(path, opts) {
    let st;
    try { st = JSON.parse(localStorage.getItem(LOCAL_KEY)) || null; } catch { st = null; }
    st = st || { people: [], ratings: [], comments: [] };
    const b = opts.body || {};
    if (path !== "/api/state") {
      const name = String(b.name || "").replace(/\s+/g, " ").trim();
      if (!name) throw new Error("Please enter your name first.");
      const id = name.toLowerCase();
      let me = st.people.find((p) => p.id === id);
      if (!me) { me = { id, name, favorite: null }; st.people.push(me); }
      me.name = name;
      if (path === "/api/rating") {
        st.ratings = st.ratings.filter((r) => !(r.person_id === id && r.dest_id === b.destId));
        if (b.score !== null) st.ratings.push({ person_id: id, dest_id: b.destId, score: b.score, updated_at: new Date().toISOString() });
      } else if (path === "/api/favorite") {
        me.favorite = b.destId;
      }
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(st)); } catch { throw new Error("Couldn't save on this device (private browsing?)."); }
    }
    return Promise.resolve(st);
  }

  // Plain-text summary of this person's ratings, for texting to the family.
  function shareText() {
    const fav = myFavorite();
    const rated = DESTS.map((d) => ({ d, s: myScore(d.id) })).filter((x) => x.s).sort((a, b) => b.s - a.s);
    const lines = rated.map((x) => `${x.d.name}: ${x.s}/10${fav === x.d.id ? " ♥ favorite" : ""}`);
    const unrated = DESTS.filter((d) => !myScore(d.id)).map((d) => d.name);
    return `${S.name ? S.name + "'s" : "My"} Thanksgiving ratings (1 = not interested, 10 = would love to go):\n` +
      (lines.length ? lines.join("\n") : "(none yet)") +
      (unrated.length ? `\nNot rated: ${unrated.join(", ")}` : "") +
      (fav && !myScore(fav) ? `\n♥ Favorite: ${byId[fav].name}` : "") +
      `\n${location.href.split("#")[0]}`;
  }
  async function shareRatings() {
    if (!S.name) return askName(shareRatings);
    const text = shareText();
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(text); toast("Copied! Paste it into the family group text."); }
    catch {
      const ov = overlay(`<div class="sheet small" role="dialog" aria-modal="true"><div class="sheet-head"><h3>Copy your ratings</h3><button class="icon-btn" data-close aria-label="Close">×</button></div><div class="sheet-body" style="padding-top:14px"><textarea class="input" rows="9" readonly>${esc(text)}</textarea><p class="note">Select all, copy, and paste into the family group text.</p></div></div>`);
      ov.querySelector("textarea").select();
    }
  }
  const shareBox = () => `<div class="box"><b>Your ratings are saved on this device only.</b><p class="note" style="margin:4px 0 10px">This page has no shared database, so send your scores to the family when you're done.</p><button class="btn btn-primary" data-share>Share my ratings</button></div>`;

  async function sheetsApi(path, opts) {
    const body = { ...(opts.body || {}), code: S.code || "" };
    if (path === "/api/state") body.action = "state";
    else if (path === "/api/rating") body.action = "rating";
    else if (path === "/api/favorite") body.action = "favorite";
    else if (path === "/api/comment") body.action = "comment";
    else if (path.startsWith("/api/comment/")) { body.action = "deleteComment"; body.id = decodeURIComponent(path.split("/").pop()); }
    let data;
    try {
      // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
      const res = await fetch(CFG.apiUrl, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), redirect: "follow" });
      data = await res.json();
    } catch {
      throw new Error("Couldn't reach the shared sheet. Check your connection and try again.");
    }
    if (data && data.error) {
      const err = new Error(data.error);
      err.status = data.status || 400;
      throw err;
    }
    return data;
  }

  async function refresh({ quiet = false } = {}) {
    if (!quiet) { S.sync = "loading"; renderSync(); }
    try {
      S.data = await api("/api/state");
      S.sync = "ok"; S.syncError = ""; S.lastSync = new Date();
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem(LS.code); S.code = null; render(); return; }
      S.sync = "error"; S.syncError = e.message || "Couldn't reach the server.";
    }
    renderShared();
  }

  async function mutate(path, method, body, successMsg) {
    try {
      S.data = await api(path, { method, body });
      S.sync = "ok"; S.lastSync = new Date();
      renderShared();
      if (successMsg) toast(successMsg);
      return true;
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem(LS.code); S.code = null; render(); return false; }
      toast(e.message || "Couldn't save — check your connection.", "error", { label: "Retry", fn: () => mutate(path, method, body, successMsg) });
      return false;
    }
  }

  // ---------- derived ----------
  function statsFor(destId) {
    const d = S.data;
    if (!d) return { avg: null, count: 0, favs: 0, rows: [], favNames: [] };
    const names = Object.fromEntries(d.people.map((p) => [p.id, p.name]));
    const rows = d.ratings.filter((r) => r.dest_id === destId).map((r) => ({ name: names[r.person_id] || r.person_id, id: r.person_id, score: r.score }));
    rows.sort((a, b) => b.score - a.score);
    const favPeople = d.people.filter((p) => p.favorite === destId);
    const count = rows.length;
    const avg = count ? rows.reduce((s, r) => s + r.score, 0) / count : null; // unrated people don't count as zero
    return { avg, count, favs: favPeople.length, favNames: favPeople.map((p) => p.name), rows };
  }
  const myScore = (destId) => S.data?.ratings.find((r) => r.dest_id === destId && r.person_id === meId())?.score ?? null;
  const myFavorite = () => S.data?.people.find((p) => p.id === meId())?.favorite ?? null;
  const commentsFor = (destId) => (S.data?.comments || []).filter((c) => c.dest_id === destId);

  function filtered() {
    return DESTS.filter((d) =>
      (S.filters.setting === "all" || d.setting === S.filters.setting) &&
      (S.filters.access === "all" || d.access.includes(S.filters.access)));
  }

  function costRange(d) {
    if (!d.listings.length) return d.lodgingShort || "—";
    const totals = d.listings.map((l) => l.total);
    const lo = Math.min(...totals), hi = Math.max(...totals);
    return lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`;
  }

  // ---------- render: gate ----------
  function renderGate(err = "") {
    const hero = DESTS[0].hero.url;
    $("#app").innerHTML = `
      <div class="gate"><form class="gate-card" id="gateForm" autocomplete="off">
        <div class="gate-photo" style="background-image:url('${esc(hero)}')" role="img" aria-label="${esc(DESTS[0].hero.caption)}"></div>
        <div class="gate-body">
          <h1>Thanksgiving 2026</h1>
          <p>A private family planner for ${esc(TRIP.travelers)} · ${esc(TRIP.datesLabel)}. Enter the family code from your invite link.</p>
          <div class="field"><label for="code">Family code</label><input class="input" id="code" name="code" required autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
          <div class="form-error" id="gateErr">${esc(err)}</div>
          <button class="btn btn-primary btn-block" id="gateBtn">Come on in</button>
        </div></form></div>`;
    $("#gateForm").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#gateBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner sm"></span> Checking…`;
      S.code = $("#code").value.trim();
      try {
        S.data = await api("/api/state");
        localStorage.setItem(LS.code, S.code);
        S.sync = "ok"; S.lastSync = new Date();
        render();
      } catch (er) {
        S.code = null;
        renderGate(er.status === 401 ? "That code didn't match. Check the invite link." : er.message || "Couldn't reach the server.");
      }
    };
    $("#code").focus();
  }

  function askName(after) {
    const ov = overlay(`
      <div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="nameTitle">
        <div class="sheet-head"><h3 id="nameTitle">Who's rating?</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
        <form class="sheet-body" id="nameForm" style="padding-top:16px">
          <p class="note" style="margin-top:0">Use the same name on every device so your ratings stay together. Names aren't case-sensitive.</p>
          <div class="field"><label for="nm">Your name</label><input class="input" id="nm" maxlength="40" required value="${esc(S.name)}" /></div>
          ${S.data?.people.length ? `<p class="note">Already here: ${S.data.people.map((p) => `<button type="button" class="link-btn" data-pick="${esc(p.name)}">${esc(p.name)}</button>`).join(", ")}</p>` : ""}
          <button class="btn btn-primary btn-block">Save</button>
        </form>
      </div>`);
    ov.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { $("#nm", ov).value = b.dataset.pick; }));
    $("#nameForm", ov).onsubmit = (e) => {
      e.preventDefault();
      const v = $("#nm", ov).value.replace(/\s+/g, " ").trim();
      if (!v) return;
      S.name = v; localStorage.setItem(LS.name, v);
      closeOverlay(ov);
      renderTopbar();
      renderView();
      toast(`Hi, ${v}!`);
      after && after();
    };
    setTimeout(() => $("#nm", ov).focus(), 50);
  }
  const requireName = (fn) => (S.name ? fn() : askName(fn));

  // ---------- render: shell ----------
  function render() {
    if (!S.code) return renderGate();
    $("#app").innerHTML = `
      <header class="topbar" id="topbar"></header>
      <div id="bannerSlot"></div>
      <main id="view"></main>`;
    renderTopbar();
    renderView();
    if (!S.data) refresh();
  }

  function renderTopbar() {
    const tb = $("#topbar");
    if (!tb) return;
    tb.innerHTML = `
      <div class="topbar-inner">
        <div class="brand"><b>Thanksgiving 2026</b><span>${esc(TRIP.datesLabel)} · <span class="sync-note" id="syncNote"></span></span></div>
        <button class="me-chip" id="meBtn" aria-label="Change your name">
          ${S.name ? `<span class="avatar">${esc(initials(S.name))}</span><span class="me-name">${esc(S.name)}</span>` : `<span class="avatar">?</span><span class="me-name">Your name</span>`}
        </button>
      </div>
      <nav class="tabs" role="tablist">
        <button class="tab" role="tab" data-tab="discover" aria-selected="${S.tab === "discover"}">Discover</button>
        <button class="tab" role="tab" data-tab="compare" aria-selected="${S.tab === "compare"}">${STATIC ? "Compare" : "Compare & results"}</button>
      </nav>`;
    $("#meBtn").onclick = () => askName();
    tb.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderTopbar(); renderView(); window.scrollTo({ top: 0 }); }));
    renderSync();
  }

  function renderSync() {
    const n = $("#syncNote");
    if (STATIC) { if (n) n.textContent = "ratings saved on this device"; return; }
    if (n) {
      n.innerHTML = S.sync === "loading" ? `<span class="spinner sm"></span> syncing`
        : S.sync === "error" ? `<span class="sync-dot err"></span> offline`
        : S.lastSync ? `<span class="sync-dot"></span> shared · live` : "";
    }
    const slot = $("#bannerSlot");
    if (slot) {
      slot.innerHTML = S.sync === "error"
        ? `<div class="banner" role="alert"><span>Can't reach the shared board: ${esc(S.syncError)} Your view may be out of date.</span><button class="btn btn-soft" id="retryBtn">Retry</button></div>` : "";
      const r = $("#retryBtn"); if (r) r.onclick = () => refresh();
    }
  }

  // Re-render the parts that show shared data without resetting the deck position.
  function renderShared() {
    renderSync();
    if (S.tab === "compare") renderView();
    else updateCardStats();
    document.querySelectorAll("[data-live]").forEach((el) => {
      const [kind, id] = el.dataset.live.split(":");
      if (kind === "rate") el.innerHTML = ratePanelInner(byId[id]);
      if (kind === "comments") {
        // Keep an in-progress draft (and focus) across background refreshes.
        const ta = el.querySelector("textarea");
        const draft = ta ? ta.value : "", focused = ta && document.activeElement === ta;
        el.innerHTML = commentsInner(byId[id]);
        const nta = el.querySelector("textarea");
        if (nta && draft) nta.value = draft;
        if (nta && focused) nta.focus();
      }
      if (kind === "summary") el.innerHTML = summaryInner(byId[id]);
      bindLive(el, byId[id]);
    });
  }

  function renderView() {
    const v = $("#view");
    if (!v) return;
    if (S.tab === "discover") renderDiscover(v);
    else renderCompare(v);
  }

  function filterBar() {
    const chip = (group, val, label) => `<button class="chip" data-f="${group}" data-v="${val}" aria-pressed="${S.filters[group] === val}">${label}</button>`;
    return `<div class="filters" role="group" aria-label="Filters">
      <span class="filter-label">Setting</span>${chip("setting", "all", "All")}${chip("setting", "coast", "Coast")}${chip("setting", "mountains", "Mountains & forest")}
      <span class="filter-label" style="margin-left:6px">Getting there</span>${chip("access", "all", "Any")}${chip("access", "drive", "Drive from Kings Beach")}${chip("access", "fly", "Fly-in only")}
    </div>`;
  }
  function bindFilters(root) {
    root.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { S.filters[b.dataset.f] = b.dataset.v; S.index = 0; renderView(); }));
  }

  // ---------- discover (swipe deck) ----------
  function renderDiscover(v) {
    const list = filtered();
    if (S.index >= list.length) S.index = 0;
    v.innerHTML = `${filterBar()}
      ${list.length ? `<div class="deck-wrap">
        <div class="deck" id="deck" aria-roledescription="carousel" aria-label="Destinations"></div>
        <div class="deck-controls">
          <button class="icon-btn" id="prevBtn" aria-label="Previous destination">‹</button>
          <div class="dots" role="tablist">${list.map((d, i) => `<button class="dot" data-i="${i}" aria-label="${esc(d.name)}" aria-current="${i === S.index}"></button>`).join("")}</div>
          <button class="icon-btn" id="nextBtn" aria-label="Next destination">›</button>
        </div>
        <p class="deck-help">Swipe or use the arrows to browse · rating is separate — tap <b>Rate</b> when you're ready.</p>
      </div>` : `<div class="empty">No destinations match those filters. <button class="link-btn" id="clearF">Clear filters</button></div>`}
      <p class="footer-note">Rental prices and availability checked ${esc(fmtChecked(TRIP.checkedAt))}. Nothing is booked.</p>`;
    bindFilters(v);
    const cf = $("#clearF"); if (cf) cf.onclick = () => { S.filters = { setting: "all", access: "all" }; renderView(); };
    if (!list.length) return;
    drawDeck(list);
    $("#prevBtn").onclick = () => go(list, -1);
    $("#nextBtn").onclick = () => go(list, 1);
    v.querySelectorAll(".dot").forEach((b) => (b.onclick = () => { S.index = +b.dataset.i; drawDeck(list); syncDots(); }));
  }

  function cardHTML(d, behind) {
    const st = statsFor(d.id);
    const mine = myScore(d.id);
    return `<article class="card${behind ? " behind" : ""}" data-id="${d.id}" aria-label="${esc(d.name)}" ${behind ? 'aria-hidden="true"' : ""}>
      <div class="card-photo" style="background-image:url('${esc(d.hero.url)}')" role="img" aria-label="${esc(d.hero.caption)}"></div>
      <div class="swipe-hint left">Next ›</div><div class="swipe-hint right">‹ Back</div>
      <div class="card-top">
        <span class="pill">${esc(d.personality)}</span>
        <span class="pill dark" data-stat="${d.id}">${statPill(st, d.id)}</span>
      </div>
      ${mine && !STATIC ? `<span class="pill my-score" data-mine="${d.id}">You: ${mine}/10${myFavorite() === d.id ? " ♥" : ""}</span>` : `<span class="my-score" data-mine="${d.id}"></span>`}
      <div class="card-body">
        <div class="card-kicker">${esc(d.region)}</div>
        <h2>${esc(d.name)}</h2>
        <p class="card-tagline">${esc(d.tagline)}</p>
        <div class="facts">
          <div class="fact"><small>${d.access.includes("drive") ? "From Kings Beach" : "Getting there"}</small><b>${esc(d.quick.travel)}</b></div>
          <div class="fact"><small>Late Nov</small><b>${esc(d.quick.weather)}</b></div>
          <div class="fact"><small>Lodging · 3 nights</small><b>${esc(costRange(d))}</b></div>
        </div>
        <div class="card-actions">
          <button class="btn btn-on-photo" data-open="${d.id}">Explore</button>
          <button class="btn btn-on-photo-ghost" data-rate="${d.id}">${mine ? "Update rating" : "Rate"}</button>
        </div>
      </div>
    </article>`;
  }
  const statPill = (st, id) => STATIC ? (myScore(id) ? `You: ${myScore(id)}/10${myFavorite() === id ? " ♥" : ""}` : "Not rated yet") : st.count ? `★ ${st.avg.toFixed(1)} · ${st.count} rated${st.favs ? ` · ♥ ${st.favs}` : ""}` : "No ratings yet";

  function updateCardStats() {
    DESTS.forEach((d) => {
      const st = statsFor(d.id);
      document.querySelectorAll(`[data-stat="${d.id}"]`).forEach((el) => (el.textContent = statPill(st, d.id)));
      const mine = myScore(d.id);
      document.querySelectorAll(`[data-mine="${d.id}"]`).forEach((el) => {
        el.className = mine && !STATIC ? "pill my-score" : "my-score";
        el.textContent = mine && !STATIC ? `You: ${mine}/10${myFavorite() === d.id ? " ♥" : ""}` : "";
      });
      document.querySelectorAll(`[data-rate="${d.id}"]`).forEach((el) => (el.textContent = mine ? "Update rating" : "Rate"));
    });
  }

  function drawDeck(list) {
    const deck = $("#deck");
    const cur = list[S.index];
    const next = list[(S.index + 1) % list.length];
    deck.innerHTML = (list.length > 1 ? cardHTML(next, true) : "") + cardHTML(cur, false);
    const top = deck.querySelector(".card:not(.behind)");
    deck.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
    deck.querySelectorAll("[data-rate]").forEach((b) => (b.onclick = () => requireName(() => openRate(b.dataset.rate))));
    attachSwipe(top, list);
  }
  function syncDots() { document.querySelectorAll(".dot").forEach((b, i) => b.setAttribute("aria-current", i === S.index)); }

  function go(list, dir) {
    const top = $("#deck .card:not(.behind)");
    const n = list.length;
    if (!top || n < 2) return;
    top.style.transform = `translateX(${dir > 0 ? -120 : 120}%) rotate(${dir > 0 ? -12 : 12}deg)`;
    top.style.opacity = "0";
    setTimeout(() => { S.index = (S.index + dir + n) % n; drawDeck(list); syncDots(); }, 220);
  }

  function attachSwipe(card, list) {
    if (!card) return;
    let x0 = 0, y0 = 0, dx = 0, active = false, horizontal = null;
    const hintL = card.querySelector(".swipe-hint.left"), hintR = card.querySelector(".swipe-hint.right");
    card.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, a")) return;
      active = true; horizontal = null; x0 = e.clientX; y0 = e.clientY; dx = 0;
    });
    card.addEventListener("pointermove", (e) => {
      if (!active) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
        horizontal = Math.abs(mx) > Math.abs(my);
        if (horizontal) { card.setPointerCapture(e.pointerId); card.classList.add("dragging"); }
        else { active = false; return; }
      }
      if (!horizontal) return;
      dx = mx;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
      hintL.style.opacity = Math.min(1, Math.max(0, -dx / 90));
      hintR.style.opacity = Math.min(1, Math.max(0, dx / 90));
    });
    const end = () => {
      if (!active) return;
      active = false;
      card.classList.remove("dragging");
      if (Math.abs(dx) > 90) go(list, dx < 0 ? 1 : -1);
      else { card.style.transform = ""; hintL.style.opacity = 0; hintR.style.opacity = 0; }
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  document.addEventListener("keydown", (e) => {
    if (S.tab !== "discover" || document.querySelector(".overlay, .lightbox") || /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") $("#nextBtn")?.click();
    if (e.key === "ArrowLeft") $("#prevBtn")?.click();
  });

  // ---------- overlays ----------
  let lastFocus = null;
  function overlay(inner) {
    lastFocus = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = inner;
    document.body.appendChild(ov);
    document.body.classList.add("locked");
    ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-close]")) closeOverlay(ov); });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.querySelector(".lightbox")) closeOverlay(ov); });
    return ov;
  }
  function closeOverlay(ov) {
    ov.remove();
    if (!document.querySelector(".overlay")) document.body.classList.remove("locked");
    lastFocus && lastFocus.focus && lastFocus.focus();
  }

  // ---------- rating ----------
  function ratePanelInner(d) {
    const mine = myScore(d.id);
    const fav = myFavorite() === d.id;
    return `
      <div class="rate-panel">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <b>${S.name ? `${esc(S.name)}, how excited are you?` : "Your rating"}</b>
          ${mine ? `<button class="link-btn" data-clear="${d.id}">Clear my rating</button>` : ""}
        </div>
        <div class="scale" role="radiogroup" aria-label="Rate ${esc(d.name)} from 1 to 10">
          ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `<button role="radio" aria-checked="${mine === n}" data-score="${n}" aria-label="${n}${n === 1 ? " — not interested" : n === 10 ? " — would love to go" : ""}">${n}</button>`).join("")}
        </div>
        <div class="scale-labels"><span>1 = not interested</span><span>10 = would love to go</span></div>
        <div class="rate-status" data-status>${mine ? `Saved: <b>${mine}/10</b>. Tap another number to change it.` : (STATIC ? "Not rated yet." : "Not rated yet — unrated places don't count toward the average.")}</div>
        <div class="fav-toggle">
          <span>${fav ? "♥ This is your favorite." : "Is this your #1 pick? (one favorite per person)"}</span>
          <button class="btn ${fav ? "fav-on" : "btn-ghost"}" data-fav="${d.id}" aria-pressed="${fav}">${fav ? "♥ My favorite" : "♡ Make favorite"}</button>
        </div>
      </div>`;
  }

  function summaryInner(d) {
    if (STATIC) return shareBox();
    const st = statsFor(d.id);
    return `
      <div class="avg-big"><b>${st.count ? st.avg.toFixed(1) : "—"}</b><span class="muted">${st.count ? `average of ${st.count} rating${st.count > 1 ? "s" : ""}` : "no ratings yet"}${st.favs ? ` · ♥ favorite of ${st.favNames.map(esc).join(", ")}` : ""}</span></div>
      ${st.rows.length ? `<ul class="people-list">${st.rows.map((r) => `<li><span class="avatar">${esc(initials(r.name))}</span><span style="min-width:84px">${esc(r.name)}</span><span class="bar"><i style="width:${r.score * 10}%"></i></span><b>${r.score}</b></li>`).join("")}</ul>` : ""}`;
  }

  function bindLive(root, d) {
    root.querySelectorAll("[data-score]").forEach((b) => (b.onclick = () => requireName(() => saveRating(d, +b.dataset.score, root))));
    root.querySelectorAll("[data-clear]").forEach((b) => (b.onclick = () => saveRating(d, null, root)));
    root.querySelectorAll("[data-fav]").forEach((b) => (b.onclick = () => requireName(() => toggleFav(d, root))));
    root.querySelectorAll("[data-share]").forEach((b) => (b.onclick = () => shareRatings()));
    root.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => deleteComment(b.dataset.del)));
    const form = root.querySelector("[data-cform]");
    if (form) bindCommentForm(form, d);
  }

  async function saveRating(d, score, root) {
    const st = root.querySelector("[data-status]");
    root.querySelectorAll("[data-score]").forEach((b) => (b.disabled = true));
    if (st) st.innerHTML = `<span class="spinner sm"></span> Saving…`;
    const prev = myScore(d.id);
    const ok = await mutate("/api/rating", "PUT", { name: S.name, destId: d.id, score },
      score === null ? `Cleared your rating for ${d.name}.` : prev ? `Updated: ${d.name} ${prev} → ${score}/10` : `Saved: ${d.name} ${score}/10`);
    if (!ok) { root.querySelectorAll("[data-score]").forEach((b) => (b.disabled = false)); if (st) st.textContent = "Not saved — try again."; }
  }

  async function toggleFav(d) {
    const isFav = myFavorite() === d.id;
    await mutate("/api/favorite", "PUT", { name: S.name, destId: isFav ? null : d.id }, isFav ? "Favorite removed." : `♥ ${d.name} is your favorite.`);
  }

  function openRate(id) {
    const d = byId[id];
    const ov = overlay(`
      <div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="rateTitle">
        <div class="sheet-head"><h3 id="rateTitle">Rate ${esc(d.name)}</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
        <div class="sheet-body" style="padding-top:14px">
          <div data-live="rate:${d.id}">${ratePanelInner(d)}</div>
          <div style="margin-top:16px" data-live="summary:${d.id}">${summaryInner(d)}</div>
          <button class="btn btn-ghost btn-block" style="margin-top:16px" data-openfrom="${d.id}">See full details</button>
        </div>
      </div>`);
    ov.querySelectorAll("[data-live]").forEach((el) => bindLive(el, d));
    $("[data-openfrom]", ov).onclick = () => { closeOverlay(ov); openDetail(d.id); };
    setTimeout(() => ov.querySelector("[data-score]")?.focus(), 50);
  }

  // ---------- comments ----------
  function commentsInner(d) {
    const cs = commentsFor(d.id);
    return `
      ${cs.length ? cs.map((c) => `
        <div class="comment">
          <span class="avatar">${esc(initials(c.name))}</span>
          <div><span class="who">${esc(c.name)}</span>${c.kind === "question" ? `<span class="q-badge">Question</span>` : ""}<span class="when">${esc(fmtWhen(c.created_at))}</span>
            ${c.person_id === meId() ? ` · <button class="link-btn" style="font-size:12px" data-del="${esc(c.id)}">delete</button>` : ""}
            <p>${esc(c.body)}</p></div>
        </div>`).join("") : `<p class="note">No notes yet. Start the conversation — thoughts, concerns, questions for the group.</p>`}
      <form class="comment-form" data-cform>
        <div class="seg" role="group" aria-label="Type of note">
          <button type="button" data-kind="feedback" aria-pressed="${S.commentKind === "feedback"}">Feedback</button>
          <button type="button" data-kind="question" aria-pressed="${S.commentKind === "question"}">Question</button>
        </div>
        <label class="sr-only" for="c-${d.id}">Your note</label>
        <textarea class="input" id="c-${d.id}" maxlength="1500" placeholder="${S.commentKind === "question" ? "Ask the group something…" : "What do you think about this one?"}"></textarea>
        <button class="btn btn-primary">Post ${S.commentKind === "question" ? "question" : "note"}</button>
      </form>`;
  }

  function bindCommentForm(form, d) {
    form.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => {
      S.commentKind = b.dataset.kind;
      form.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", x === b));
      form.querySelector("textarea").placeholder = S.commentKind === "question" ? "Ask the group something…" : "What do you think about this one?";
      form.querySelector("button.btn").textContent = `Post ${S.commentKind === "question" ? "question" : "note"}`;
    }));
    form.onsubmit = (e) => {
      e.preventDefault();
      const ta = form.querySelector("textarea");
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      requireName(async () => {
        const btn = form.querySelector("button.btn");
        btn.disabled = true; btn.innerHTML = `<span class="spinner sm"></span> Posting…`;
        const draft = text;
        const ok = await mutate("/api/comment", "POST", { name: S.name, destId: d.id, body: draft, kind: S.commentKind }, "Posted for everyone to see.");
        if (ok) {
          document.querySelectorAll(`[data-live="comments:${d.id}"] textarea`).forEach((x) => (x.value = ""));
        } else {
          btn.disabled = false; btn.textContent = "Post";
          ta.value = draft;
        }
      });
    };
  }

  async function deleteComment(id) {
    if (!confirm("Delete this note?")) return;
    await mutate(`/api/comment/${encodeURIComponent(id)}`, "DELETE", { name: S.name }, "Deleted.");
  }

  // ---------- detail sheet ----------
  function galleryHTML(photos, group) {
    return `<div class="gallery">${photos.map((p, i) => `
      <figure><button data-lb="${group}" data-i="${i}" aria-label="Open photo: ${esc(p.caption)}"><img loading="lazy" src="${esc(p.url)}" alt="${esc(p.caption)}" /></button>
      <figcaption>${esc(p.caption)}<small>${esc(p.credit)}${p.license ? ` · ${esc(p.license)}` : ""}</small></figcaption></figure>`).join("")}</div>`;
  }

  function listingHTML(l, d) {
    const perNight = l.total / 3;
    return `<article class="listing">
      <div class="listing-photos">${l.photos.map((p, i) => `<figure><button style="all:unset;cursor:zoom-in;display:block" data-lb="L-${l.id}" data-i="${i}" aria-label="Open listing photo"><img loading="lazy" src="${esc(p.url)}" alt="${esc(p.caption || l.name)}" /></button>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`).join("")}</div>
      <div class="listing-body">
        <div class="badges">
          <span class="badge">✓ Available Nov 24–27 for 3 adults</span>
          ${l.freeCancel ? `<span class="badge">Free cancellation offered</span>` : `<span class="badge gray">Check cancellation terms</span>`}
          ${l.discount ? `<span class="badge warn">${esc(l.discount)}</span>` : ""}
          ${l.tier ? `<span class="badge gray">${esc(l.tier)}</span>` : ""}
        </div>
        <h4>${esc(l.name)}</h4>
        <div class="listing-meta">${esc(l.type)} · ${esc(l.location)} · ★ ${esc(l.rating)}</div>
        <div class="price-grid">
          <div><small>3-night total</small><b>${money(l.total)}</b></div>
          <div><small>Avg / night</small><b>${money(perNight)}</b></div>
        </div>
        <p class="note" style="margin-top:-4px">Exact quote ${money2(l.total)} for Nov 24–27, 3 adults. ${esc(TRIP.taxNote)}</p>
        <dl class="kv">
          <dt>Sleeps</dt><dd>Up to ${l.guests} guests · ${esc(l.rooms)}</dd>
          <dt>Sleeping setup</dt><dd>${esc(l.sleeping)}</dd>
          <dt>Why it fits</dt><dd>${esc(l.why)}</dd>
          <dt>Minimum stay</dt><dd>${esc(TRIP.minStayNote)}</dd>
          <dt>Cancellation</dt><dd>${l.freeCancel ? "Airbnb shows a free-cancellation option for these dates; the deadline and refund terms appear at checkout." : "No free-cancellation badge for these dates — read the policy on the listing before booking."}</dd>
          <dt>Checked</dt><dd>${esc(fmtChecked(l.checkedAt))}</dd>
        </dl>
        ${l.amenities.length ? `<details class="more"><summary>Amenities (${l.amenities.length})</summary><div class="amen">${l.amenities.map((a) => `<span>${esc(a)}</span>`).join("")}</div></details>` : ""}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <a class="btn btn-primary" href="${esc(l.url)}" target="_blank" rel="noopener">View on Airbnb ↗</a>
        </div>
      </div>
    </article>`;
  }

  function openDetail(id) {
    const d = byId[id];
    const t = d.travel;
    const ov = overlay(`
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dTitle">
        <div class="sheet-head"><h3>${esc(d.personality)}</h3><div style="display:flex;gap:8px"><button class="btn btn-primary" data-jumprate style="padding:9px 14px">${myScore(d.id) ? "Update rating" : "Rate"}</button><button class="icon-btn" data-close aria-label="Close">×</button></div></div>
        <div class="sheet-body">
          <div class="detail-hero" style="background-image:url('${esc(d.hero.url)}')" role="img" aria-label="${esc(d.hero.caption)}"><span class="credit">${esc(d.hero.caption)} · ${esc(d.hero.credit)}</span></div>
          <div class="detail-title"><div class="kicker">${esc(d.region)}</div><h2 id="dTitle">${esc(d.name)}</h2></div>
          <p class="lede">${esc(d.vibe)}</p>
          <nav class="jump" aria-label="Sections">
            <a href="#s-photos">Photos</a><a href="#s-stay">Where to stay</a><a href="#s-travel">Getting there</a><a href="#s-weather">Weather</a><a href="#s-plan">Itinerary</a><a href="#s-rentals">${d.listings.length ? "Rentals" : "Lodging"}</a><a href="#s-rate">${STATIC ? "Your rating" : "Ratings"}</a>${STATIC ? "" : `<a href="#s-talk">Discussion</a>`}
          </nav>

          <section class="section" id="s-photos"><h3>The place</h3><p class="sub">Swipe the strip; tap a photo for full screen. Real photos with source credits.</p>${galleryHTML(d.photos, "D")}</section>

          <section class="section"><div class="cols two">
            <div class="box"><h4 class="tag-good">Highlights</h4><ul>${d.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></div>
            <div class="box"><h4 class="tag-warn">Tradeoffs</h4><ul>${d.tradeoffs.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></div>
          </div></section>

          <section class="section" id="s-stay"><h3>Where to stay</h3><div class="cols two">${d.stayAreas.map((a) => `<div class="box"><h4>${esc(a.name)}</h4><p style="margin:0">${esc(a.why)}</p></div>`).join("")}</div></section>

          <section class="section" id="s-travel"><h3>Getting there</h3>
            ${t.drive ? `<div class="box" style="margin-bottom:12px"><h4>🚗 Dad's drive from Kings Beach</h4><dl class="kv"><dt>Distance</dt><dd>${esc(t.drive.distance)}</dd><dt>Time</dt><dd>${esc(t.drive.time)}</dd><dt>Route</dt><dd>${esc(t.drive.route)}</dd></dl><p class="note" style="margin-bottom:0">${esc(t.drive.notes)}</p></div>` : ""}
            ${t.flights?.length ? `<div class="box" style="margin-bottom:12px"><h4>✈️ Flying ${t.flightsFor ? esc(t.flightsFor) : ""}</h4>
              <div class="table-wrap" style="margin-top:6px;border-radius:12px"><table class="matrix flights" style="min-width:520px"><thead><tr><th>Route</th><th>Nonstop?</th><th>Flight time</th><th>On our dates</th></tr></thead><tbody>
              ${t.flights.map((f) => `<tr><td><b>${esc(f.route)}</b>${f.carriers ? `<br><span class="note">${esc(f.carriers)}</span>` : ""}</td><td data-l="Nonstop">${esc(f.nonstop)}</td><td data-l="Time">${esc(f.time)}</td><td data-l="Our dates" style="text-align:left">${esc(f.dates)}</td></tr>`).join("")}
              </tbody></table></div>
              ${t.airportDrive ? `<p style="margin:10px 0 0"><b>From the airport:</b> ${esc(t.airportDrive)}</p>` : ""}
            </div>` : ""}
            ${t.notes?.length ? `<ul class="note" style="padding-left:18px">${t.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
          </section>

          <section class="section" id="s-weather"><h3>Late-November weather</h3>
            <div class="cols two"><div class="box"><dl class="kv"><dt>Typical high</dt><dd>${esc(d.weather.high)}</dd><dt>Typical low</dt><dd>${esc(d.weather.low)}</dd><dt>Rain</dt><dd>${esc(d.weather.rain)}</dd><dt>Snow</dt><dd>${esc(d.weather.snow)}</dd></dl></div>
            <div class="box"><p style="margin:0">${esc(d.weather.summary)}</p>${d.weather.source ? `<p class="note" style="margin:8px 0 0">Source: ${esc(d.weather.source)}</p>` : ""}</div></div>
          </section>

          <section class="section" id="s-plan"><h3>A relaxed Tuesday–Friday</h3>
            <div class="days">
              ${[["Tue", "Nov 24", d.itinerary.tue], ["Wed", "Nov 25", d.itinerary.wed], ["Thu", "Thanksgiving", d.itinerary.thu], ["Fri", "Nov 27", d.itinerary.fri]].map(([a, b, c]) => `<div class="day"><div><b>${a}</b><small>${b}</small></div><div>${esc(c)}</div></div>`).join("")}
              <div class="day" style="background:#F3EEE3"><div><b>☔</b><small>Rainy day</small></div><div>${esc(d.rainy)}</div></div>
            </div>
          </section>

          <section class="section" id="s-rentals"><h3>${d.listings.length ? "Verified rentals" : "Lodging"}</h3>
            ${d.listings.length ? `<p class="sub">Each was confirmed bookable for the full Tue–Fri stay for 3 adults in a live dated Airbnb search, which also enforces minimum-night rules. Prices are Airbnb's live quotes at check time and can change.</p>${d.listings.map((l) => listingHTML(l, d)).join("")}` : `<div class="box">${esc(d.lodgingNote)}</div>`}
          </section>

          <section class="section" id="s-rate"><h3>${STATIC ? "Your rating" : "Ratings"}</h3>
            <div class="cols two"><div data-live="rate:${d.id}">${ratePanelInner(d)}</div><div class="${STATIC ? "" : "box"}" data-live="summary:${d.id}">${summaryInner(d)}</div></div>
          </section>

          ${STATIC ? `<section class="section"><h3>Questions or thoughts?</h3><p style="margin:0">Send them in the family group chat. This page doesn't collect comments.</p></section>` : `<section class="section" id="s-talk"><h3>Discussion</h3><p class="sub">Feedback and questions are shared with everyone who has the invite link.</p><div data-live="comments:${d.id}">${commentsInner(d)}</div></section>`}
        </div>
      </div>`);
    ov.querySelectorAll("[data-live]").forEach((el) => bindLive(el, d));
    $("[data-jumprate]", ov).onclick = () => requireName(() => ov.querySelector("#s-rate").scrollIntoView({ behavior: "smooth" }));
    ov.querySelectorAll(".jump a").forEach((a) => (a.onclick = (e) => { e.preventDefault(); ov.querySelector(a.getAttribute("href")).scrollIntoView({ behavior: "smooth" }); }));
    ov.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lb]");
      if (!b) return;
      const g = b.dataset.lb;
      const set = g === "D" ? d.photos : d.listings.find((l) => "L-" + l.id === g).photos.map((p) => ({ ...p, credit: "Listing photo via Airbnb", source: d.listings.find((l) => "L-" + l.id === g).url }));
      lightbox(set, +b.dataset.i);
    });
    setTimeout(() => $("[data-close]", ov).focus(), 50);
  }

  function lightbox(set, i) {
    const lb = document.createElement("div");
    lb.className = "lightbox";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    document.body.appendChild(lb);
    let x0 = null;
    const draw = () => {
      const p = set[i];
      lb.innerHTML = `
        <div class="lightbox-top"><span>${i + 1} / ${set.length}</span><button class="icon-btn" data-x aria-label="Close">×</button></div>
        <div class="lightbox-img"><img src="${esc(p.url)}" alt="${esc(p.caption || "")}" /></div>
        <div class="lightbox-cap"><button class="icon-btn" data-p aria-label="Previous photo">‹</button>
          <div style="flex:1">${esc(p.caption || "")}<small>${esc(p.credit || "")}${p.license ? ` · ${esc(p.license)}` : ""}${p.source ? ` · <a href="${esc(p.source)}" target="_blank" rel="noopener">source</a>` : ""}</small></div>
          <button class="icon-btn" data-n aria-label="Next photo">›</button></div>`;
      lb.querySelector("[data-x]").onclick = close;
      lb.querySelector("[data-p]").onclick = () => { i = (i - 1 + set.length) % set.length; draw(); };
      lb.querySelector("[data-n]").onclick = () => { i = (i + 1) % set.length; draw(); };
      lb.querySelector("[data-x]").focus();
    };
    const close = () => { lb.remove(); document.removeEventListener("keydown", key); };
    const key = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") { i = (i + 1) % set.length; draw(); }
      if (e.key === "ArrowLeft") { i = (i - 1 + set.length) % set.length; draw(); }
    };
    document.addEventListener("keydown", key);
    lb.addEventListener("pointerdown", (e) => (x0 = e.clientX));
    lb.addEventListener("pointerup", (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 60) { i = (i + (dx < 0 ? 1 : -1) + set.length) % set.length; draw(); }
    });
    draw();
  }

  // ---------- compare ----------
  function renderCompare(v) {
    const list = filtered().map((d) => ({ d, st: statsFor(d.id) }));
    const sorters = {
      mine: (a, b) => (myScore(b.d.id) ?? -1) - (myScore(a.d.id) ?? -1),
      avg: (a, b) => (b.st.avg ?? -1) - (a.st.avg ?? -1) || b.st.favs - a.st.favs,
      favs: (a, b) => b.st.favs - a.st.favs || (b.st.avg ?? -1) - (a.st.avg ?? -1),
      cost: (a, b) => minTotal(a.d) - minTotal(b.d),
    };
    list.sort(sorters[S.sort]);
    const people = S.data?.people || [];
    const ratedPeople = people.filter((p) => S.data.ratings.some((r) => r.person_id === p.id));
    v.innerHTML = `${filterBar()}
      <div class="sort-row"><span class="filter-label">Sort by</span>
        ${(STATIC ? [["mine", "My rating"], ["cost", "Lodging cost"]] : [["avg", "Average rating"], ["favs", "Favorites"], ["cost", "Lodging cost"]]).map(([k, l]) => `<button class="chip" data-sort="${k}" aria-pressed="${S.sort === k}">${l}</button>`).join("")}
      </div>
      ${STATIC ? `<div style="margin-bottom:14px">${shareBox()}</div>` : ""}
      ${!S.data ? `<div class="empty"><div class="spinner"></div><p>Loading everyone's ratings…</p></div>` : ""}
      <div class="compare-grid">${list.map(({ d, st }, i) => `
        <article class="cmp">
          <div class="cmp-photo" style="background-image:url('${esc(d.hero.url)}')" role="img" aria-label="${esc(d.hero.caption)}">${S.sort !== "cost" && (STATIC ? myScore(d.id) : st.count) ? `<span class="rank">#${i + 1}</span>` : ""}</div>
          <div class="cmp-body">
            <div><div class="card-kicker" style="color:var(--rust)">${esc(d.personality)}</div><h3>${esc(d.name)}</h3></div>
            ${STATIC ? `<div class="cmp-stats">
              <div><b>${myScore(d.id) ?? "—"}</b><small>My rating</small></div>
              <div><b>${myFavorite() === d.id ? "♥" : "—"}</b><small>Favorite</small></div>
              <div><b style="font-size:16px;line-height:1.6">${esc(costRange(d))}</b><small>Lodging</small></div>
            </div>` : `<div class="cmp-stats">
              <div><b>${st.count ? st.avg.toFixed(1) : "—"}</b><small>Average</small></div>
              <div><b>${st.count}</b><small>Rated</small></div>
              <div><b>${st.favs}</b><small>♥ Favs</small></div>
            </div>`}
            <dl class="kv">
              ${STATIC ? "" : `<dt>Ratings</dt><dd>${st.rows.length ? st.rows.map((r) => `${esc(r.name)} <b>${r.score}</b>`).join(" · ") : '<span class="muted">none yet</span>'}</dd>`}
              <dt>Lodging</dt><dd>${esc(costRange(d))} for 3 nights</dd>
              <dt>Travel</dt><dd>${esc(d.quick.travelLong)}</dd>
              <dt>Weather</dt><dd>${esc(d.quick.weather)} · ${esc(d.weather.snowShort)}</dd>
              <dt>Setting</dt><dd>${d.setting === "coast" ? "Coast" : "Mountains & forest"}</dd>
            </dl>
            <div style="display:flex;gap:8px;margin-top:auto">
              <button class="btn btn-ghost" style="flex:1" data-open="${d.id}">Details</button>
              <button class="btn btn-primary" style="flex:1" data-rate="${d.id}">${myScore(d.id) ? `You: ${myScore(d.id)} · edit` : "Rate"}</button>
            </div>
          </div>
        </article>`).join("")}</div>
      ${S.data && !STATIC ? `<div class="table-wrap"><table class="matrix">
        <caption class="sr-only">Every person's rating for every destination</caption>
        <thead><tr><th>Destination</th>${ratedPeople.map((p) => `<th>${esc(p.name)}</th>`).join("")}<th>Avg</th><th>♥</th></tr></thead>
        <tbody>${list.map(({ d, st }) => `<tr><td><b>${esc(d.name)}</b></td>${ratedPeople.map((p) => { const r = st.rows.find((x) => x.id === p.id); return `<td>${r ? r.score : '<span class="muted">–</span>'}${p.favorite === d.id ? " ♥" : ""}</td>`; }).join("")}<td><b>${st.count ? st.avg.toFixed(1) : "—"}</b></td><td>${st.favs || ""}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="footer-note">“–” means not rated yet; averages only include people who rated that place.</p>` : ""}`;
    bindFilters(v);
    v.querySelectorAll("[data-share]").forEach((b) => (b.onclick = () => shareRatings()));
    v.querySelectorAll("[data-sort]").forEach((b) => (b.onclick = () => { S.sort = b.dataset.sort; renderView(); }));
    v.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
    v.querySelectorAll("[data-rate]").forEach((b) => (b.onclick = () => requireName(() => openRate(b.dataset.rate))));
  }
  const minTotal = (d) => (d.listings.length ? Math.min(...d.listings.map((l) => l.total)) : 0);

  // ---------- boot ----------
  render();
  if (!STATIC) {
    setInterval(() => { if (S.code && !document.hidden) refresh({ quiet: true }); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && S.code) refresh({ quiet: true }); });
  }
})();
