(() => {
  "use strict";

  // Static page: no server. Each person's top 3 lives in their own browser and is shared by text.
  const TRIP = window.TRIP;
  const DESTS = TRIP.destinations;
  const byId = Object.fromEntries(DESTS.map((d) => [d.id, d]));
  const LS = { name: "tg26.name", top3: "tg26.top3" };
  const MEDALS = ["🥇", "🥈", "🥉"];

  // ---------- state ----------
  const S = {
    name: localStorage.getItem(LS.name) || "",
    top3: loadTop3(),
    tab: "discover",
    filters: { setting: "all", access: "all" },
    index: 0,
    sort: "mine",
  };

  function loadTop3() {
    try {
      const v = JSON.parse(localStorage.getItem(LS.top3));
      if (Array.isArray(v) && v.length === 3) return v.map((id) => (id && byId[id] ? id : null));
    } catch { /* ignore */ }
    return [null, null, null];
  }
  function saveTop3() {
    try { localStorage.setItem(LS.top3, JSON.stringify(S.top3)); return true; }
    catch { toast("Couldn't save on this device (private browsing?).", "error"); return false; }
  }
  const rankOf = (id) => S.top3.indexOf(id) + 1; // 0 = not picked

  // Put a destination at rank 1–3 (or 0 to remove). Whatever held that rank drops out.
  function setPick(id, rank) {
    const d = byId[id];
    const prevRank = rankOf(id);
    if (prevRank) S.top3[prevRank - 1] = null;
    let bumped = null, swapped = null;
    if (rank) {
      bumped = S.top3[rank - 1];
      S.top3[rank - 1] = id;
      // If this place moved from another slot, swap the bumped one into the vacated slot.
      if (bumped && prevRank) { S.top3[prevRank - 1] = bumped; swapped = bumped; bumped = null; }
    }
    if (!saveTop3()) return;
    refreshPicks();
    if (!rank) toast(`Removed ${d.name} from your top 3`);
    else toast(`${MEDALS[rank - 1]} ${d.name} is your #${rank}` +
      (bumped ? ` (${byId[bumped].name} moved out)` : swapped ? ` (${byId[swapped].name} moved to #${prevRank})` : ""));
  }

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const shortDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const pickedCount = () => S.top3.filter(Boolean).length;

  function toast(msg, kind = "ok") {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " error" : "");
    el.innerHTML = `<span>${esc(msg)}</span>`;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "error" ? 6000 : 2400);
  }

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
  const minTotal = (d) => (d.listings.length ? Math.min(...d.listings.map((l) => l.total)) : 0);

  // ---------- sharing ----------
  function shareText() {
    const lines = S.top3.map((id, i) => `${i + 1}. ${id ? byId[id].name : "—"}`);
    return `${S.name ? S.name + "'s" : "My"} top 3 for Thanksgiving:\n${lines.join("\n")}\n${location.href.split("#")[0]}`;
  }
  async function shareTop3() {
    if (!pickedCount()) { toast("Pick at least one place first."); return; }
    if (!S.name) return askName(shareTop3);
    const text = shareText();
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(text); toast("Copied! Paste it into the family group text."); }
    catch {
      const ov = overlay(`<div class="sheet small" role="dialog" aria-modal="true"><div class="sheet-head"><h3>Copy your top 3</h3><button class="icon-btn" data-close aria-label="Close">×</button></div><div class="sheet-body" style="padding-top:14px"><textarea class="input" rows="6" readonly>${esc(text)}</textarea><p class="note">Copy and paste into the family group text.</p></div></div>`);
      ov.querySelector("textarea").select();
    }
  }

  function askName(after) {
    const ov = overlay(`
      <div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="nameTitle">
        <div class="sheet-head"><h3 id="nameTitle">Your name</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
        <form class="sheet-body" id="nameForm" style="padding-top:16px">
          <p class="note" style="margin-top:0">So the family knows whose top 3 this is.</p>
          <div class="field"><label for="nm" class="sr-only">Your name</label><input class="input" id="nm" maxlength="40" required value="${esc(S.name)}" /></div>
          <button class="btn btn-primary btn-block">Save</button>
        </form>
      </div>`);
    $("#nameForm", ov).onsubmit = (e) => {
      e.preventDefault();
      const v = $("#nm", ov).value.replace(/\s+/g, " ").trim();
      if (!v) return;
      S.name = v; localStorage.setItem(LS.name, v);
      closeOverlay(ov);
      after && after();
    };
    setTimeout(() => $("#nm", ov).focus(), 50);
  }

  // ---------- shell ----------
  function render() {
    $("#app").innerHTML = `
      <header class="topbar" id="topbar"></header>
      <main id="view"></main>`;
    renderTopbar();
    renderView();
  }

  function renderTopbar() {
    const tb = $("#topbar");
    tb.innerHTML = `
      <div class="topbar-inner">
        <div class="brand"><b>Thanksgiving 2026</b><span>${esc(TRIP.datesLabel)}</span></div>
        <button class="me-chip" id="top3Btn" aria-label="My top 3">🏆 <span class="me-name">My top 3 · ${pickedCount()}/3</span></button>
      </div>
      <nav class="tabs" role="tablist">
        <button class="tab" role="tab" data-tab="discover" aria-selected="${S.tab === "discover"}">Discover</button>
        <button class="tab" role="tab" data-tab="compare" aria-selected="${S.tab === "compare"}">Compare</button>
      </nav>`;
    $("#top3Btn").onclick = openTop3;
    tb.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderTopbar(); renderView(); window.scrollTo({ top: 0 }); }));
  }

  function renderView() {
    const v = $("#view");
    if (S.tab === "discover") renderDiscover(v);
    else renderCompare(v);
  }

  // After a pick changes, refresh everything that shows picks without resetting the deck.
  function refreshPicks() {
    const btn = $("#top3Btn .me-name");
    if (btn) btn.textContent = `My top 3 · ${pickedCount()}/3`;
    if (S.tab === "compare") renderView();
    DESTS.forEach((d) => {
      document.querySelectorAll(`[data-rankpill="${d.id}"]`).forEach((el) => (el.outerHTML = rankPill(d.id)));
      document.querySelectorAll(`[data-pickbtn="${d.id}"]`).forEach((el) => (el.textContent = pickLabel(d.id)));
    });
    document.querySelectorAll("[data-pickpanel]").forEach((el) => { el.innerHTML = pickPanelInner(byId[el.dataset.pickpanel]); bindPickPanel(el); });
    document.querySelectorAll("[data-top3list]").forEach((el) => { el.innerHTML = top3ListInner(); bindTop3List(el); });
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
        <p class="deck-help">Swipe to browse · tap <b>Pick</b> to build your top 3</p>
      </div>` : `<div class="empty">No destinations match those filters. <button class="link-btn" id="clearF">Clear filters</button></div>`}
      <p class="footer-note">Prices checked ${esc(shortDate(TRIP.checkedAt))} · nothing booked · v${esc(TRIP.version)}</p>`;
    bindFilters(v);
    const cf = $("#clearF"); if (cf) cf.onclick = () => { S.filters = { setting: "all", access: "all" }; renderView(); };
    if (!list.length) return;
    drawDeck(list);
    $("#prevBtn").onclick = () => go(list, -1);
    $("#nextBtn").onclick = () => go(list, 1);
    v.querySelectorAll(".dot").forEach((b) => (b.onclick = () => { S.index = +b.dataset.i; drawDeck(list); syncDots(); }));
  }

  const rankPill = (id) => rankOf(id)
    ? `<span class="pill rank-pill" data-rankpill="${id}">${MEDALS[rankOf(id) - 1]} Your #${rankOf(id)}</span>`
    : `<span data-rankpill="${id}"></span>`;
  const pickLabel = (id) => (rankOf(id) ? `${MEDALS[rankOf(id) - 1]} Your #${rankOf(id)}` : "Pick");

  function cardHTML(d, behind) {
    return `<article class="card${behind ? " behind" : ""}" data-id="${d.id}" aria-label="${esc(d.name)}" ${behind ? 'aria-hidden="true"' : ""}>
      <div class="card-photo" style="background-image:url('${esc(d.hero.url)}')" role="img" aria-label="${esc(d.hero.caption)}"></div>
      <div class="swipe-hint left">Next ›</div><div class="swipe-hint right">‹ Back</div>
      <div class="card-top">
        <span class="pill">${esc(d.personality)}</span>
        ${rankPill(d.id)}
      </div>
      <div class="card-body">
        <div class="card-kicker">${esc(d.region)}</div>
        <h2>${esc(d.name)}</h2>
        <p class="card-tagline">${esc(d.tagline)}</p>
        <div class="facts">
          <div class="fact"><small>Travel</small><b>${esc(d.stat.travel)}</b></div>
          <div class="fact"><small>Late Nov</small><b>${esc(d.stat.temps)}</b></div>
          <div class="fact"><small>Lodging · 3 nights</small><b>${esc(costRange(d))}</b></div>
        </div>
        <div class="card-actions">
          <button class="btn btn-on-photo" data-open="${d.id}">Explore</button>
          <button class="btn btn-on-photo-ghost" data-pick="${d.id}" data-pickbtn="${d.id}">${pickLabel(d.id)}</button>
        </div>
      </div>
    </article>`;
  }

  function drawDeck(list) {
    const deck = $("#deck");
    const cur = list[S.index];
    const next = list[(S.index + 1) % list.length];
    deck.innerHTML = (list.length > 1 ? cardHTML(next, true) : "") + cardHTML(cur, false);
    deck.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
    deck.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => openPick(b.dataset.pick)));
    attachSwipe(deck.querySelector(".card:not(.behind)"), list);
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

  // ---------- picking ----------
  function pickPanelInner(d) {
    const r = rankOf(d.id);
    return `
      <div class="pick-panel">
        <div class="pick-row" role="group" aria-label="Rank ${esc(d.name)} in your top 3">
          ${[1, 2, 3].map((n) => {
            const holder = S.top3[n - 1];
            return `<button class="pick-btn" data-rank="${n}" aria-pressed="${r === n}">
              <span class="medal">${MEDALS[n - 1]}</span><b>#${n}</b>
              <small>${holder && holder !== d.id ? esc(byId[holder].name) : r === n ? "This one" : "Open"}</small>
            </button>`;
          }).join("")}
        </div>
        ${r ? `<button class="link-btn" data-rank="0">Remove from my top 3</button>` : `<p class="note" style="margin:6px 0 0">Tap a slot. If it's taken, this place replaces it.</p>`}
      </div>`;
  }
  function bindPickPanel(root) {
    const id = root.dataset.pickpanel;
    root.querySelectorAll("[data-rank]").forEach((b) => (b.onclick = () => setPick(id, +b.dataset.rank)));
  }

  function top3ListInner() {
    return `
      <ol class="top3-list">${S.top3.map((id, i) => `
        <li><span class="medal">${MEDALS[i]}</span>${id ? `<button class="link-btn" data-goto="${id}">${esc(byId[id].name)}</button>` : `<span class="muted">Not picked yet</span>`}</li>`).join("")}
      </ol>
      <div class="share-box">
        <span class="note">Your picks are saved on this phone or computer. Send them to the family:</span>
        <button class="btn btn-primary btn-sm" data-share>Share my top 3</button>
      </div>`;
  }
  function bindTop3List(root) {
    root.querySelectorAll("[data-share]").forEach((b) => (b.onclick = shareTop3));
    root.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => { const ov = b.closest(".overlay"); if (ov && !ov.querySelector("#dTitle")) closeOverlay(ov); openDetail(b.dataset.goto); }));
  }

  function openPick(id) {
    const d = byId[id];
    const ov = overlay(`
      <div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="pickTitle">
        <div class="sheet-head"><h3 id="pickTitle">${esc(d.name)} in your top 3?</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
        <div class="sheet-body" style="padding-top:14px">
          <div data-pickpanel="${d.id}">${pickPanelInner(d)}</div>
          <h4 style="margin:18px 0 6px">Your top 3</h4>
          <div data-top3list>${top3ListInner()}</div>
        </div>
      </div>`);
    ov.querySelectorAll("[data-pickpanel]").forEach(bindPickPanel);
    ov.querySelectorAll("[data-top3list]").forEach(bindTop3List);
    setTimeout(() => ov.querySelector(".pick-btn")?.focus(), 50);
  }

  function openTop3() {
    const ov = overlay(`
      <div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="t3Title">
        <div class="sheet-head"><h3 id="t3Title">🏆 My top 3</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
        <div class="sheet-body" style="padding-top:10px">
          <div data-top3list>${top3ListInner()}</div>
          ${pickedCount() < 3 ? `<p class="note">Browse the places and tap <b>Pick</b> to fill your slots.</p>` : ""}
          ${S.name ? `<p class="note">Sharing as ${esc(S.name)} · <button class="link-btn" id="chgName">change</button></p>` : ""}
        </div>
      </div>`);
    ov.querySelectorAll("[data-top3list]").forEach(bindTop3List);
    const c = $("#chgName", ov); if (c) c.onclick = () => askName();
  }

  // ---------- detail sheet ----------
  function galleryHTML(photos) {
    return `<div class="gallery">${photos.map((p, i) => `
      <figure><button data-lb="D" data-i="${i}" aria-label="Open photo: ${esc(p.caption)}"><img loading="lazy" src="${esc(p.url)}" alt="${esc(p.caption)}" /></button>
      <figcaption>${esc(p.caption)}<small class="credit-line">${esc(p.credit.replace("Photo: ", "© ").replace(" / Wikimedia Commons", ""))}${p.license ? ` · ${esc(p.license)}` : ""}</small></figcaption></figure>`).join("")}</div>`;
  }

  function listingHTML(l) {
    const rooms = l.rooms.replace(/ bedrooms?/, " BR");
    return `<article class="listing">
      <div class="listing-photos">${l.photos.map((p, i) => `<figure><button style="all:unset;cursor:zoom-in;display:block" data-lb="L-${l.id}" data-i="${i}" aria-label="Open listing photo"><img loading="lazy" src="${esc(p.url)}" alt="${esc(p.caption || l.name)}" /></button></figure>`).join("")}</div>
      <div class="listing-body">
        <div class="listing-top">
          <div>
            <h4>${esc(l.name)}</h4>
            <div class="listing-meta">${esc(l.location)} · ★ ${esc(l.rating)}</div>
          </div>
          <div class="listing-price"><b>${money(l.total)}</b><small>${money(l.total / 3)}/night</small></div>
        </div>
        <div class="listing-meta">${esc(rooms)} · ${esc(l.sleepTag)}</div>
        <div class="listing-foot">
          <div class="badges">
            ${l.total < 1000 ? `<span class="badge">Under $1k</span>` : ""}
            ${l.freeCancel ? `<span class="badge">Free cancellation</span>` : ""}
            ${l.discount ? `<span class="badge warn">${esc(l.discount.replace("Discounted from", "was"))}</span>` : ""}
          </div>
          <a class="btn btn-ghost btn-sm" href="${esc(l.url)}" target="_blank" rel="noopener">Airbnb ↗</a>
        </div>
      </div>
    </article>`;
  }

  function openDetail(id) {
    const d = byId[id];
    const photos = d.photos.filter((p) => p.url !== d.hero.url);
    const days = [["Tue", d.plan.tue], ["Wed", d.plan.wed], ["Thu", d.plan.thu], ["Fri", d.plan.fri], ["☔", d.rainy]];
    const ov = overlay(`
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dTitle">
        <div class="detail-hero2" style="background-image:url('${esc(d.hero.url)}')" role="img" aria-label="${esc(d.hero.caption)}">
          <button class="icon-btn hero-close" data-close aria-label="Close">×</button>
          <div class="hero-text">
            <div class="card-kicker">${esc(d.region)}</div>
            <h2 id="dTitle">${esc(d.name)}</h2>
            <p>${esc(d.tagline)}</p>
          </div>
        </div>
        <div class="sheet-body">
          <p class="lede vibe">${esc(d.vibeShort)}</p>
          <div class="stat-strip">
            <div><small>Travel</small><b>${esc(d.stat.travel)}</b></div>
            <div><small>High / low</small><b>${esc(d.stat.temps)}</b></div>
            <div><small>Weather</small><b>${esc(d.stat.sky)}</b></div>
            <div><small>Lodging</small><b>${esc(costRange(d))}</b></div>
          </div>

          ${galleryHTML(photos)}

          <div class="chips">
            ${d.vibes.map((v) => `<span class="vchip">${esc(v)}</span>`).join("")}
            ${d.cons.map((v) => `<span class="vchip con">${esc(v)}</span>`).join("")}
          </div>

          <p class="travel-line">${d.access.includes("fly") ? "✈️" : "🚗"} ${esc(d.travelLine)}<small>${esc(d.travelNote)}</small></p>

          <section class="section tight"><h3>The plan</h3>
            <div class="plan">${days.map(([a, b]) => `<div><b>${a}</b><span>${esc(b)}</span></div>`).join("")}</div>
          </section>

          <section class="section tight"><h3>${d.listings.length ? "Places to stay" : "Where we'd stay"}</h3>
            ${d.listings.length ? `<p class="sub">All open Nov 24–27 for 3 adults · 3-night totals incl. fees, before taxes · checked ${esc(shortDate(TRIP.checkedAt))}</p>${d.listings.map(listingHTML).join("")}` : `<div class="box">${esc(d.lodgingNote)}</div>`}
          </section>

          <section class="section tight"><h3>In your top 3?</h3>
            <div data-pickpanel="${d.id}">${pickPanelInner(d)}</div>
          </section>
        </div>
      </div>`);
    ov.querySelectorAll("[data-pickpanel]").forEach(bindPickPanel);
    ov.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lb]");
      if (!b) return;
      const g = b.dataset.lb;
      const l = d.listings.find((x) => "L-" + x.id === g);
      const set = g === "D" ? photos : l.photos.map((p) => ({ ...p, credit: "Listing photo via Airbnb", source: l.url }));
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
    const list = filtered();
    const sorters = {
      mine: (a, b) => (rankOf(a.id) || 9) - (rankOf(b.id) || 9),
      cost: (a, b) => minTotal(a) - minTotal(b),
    };
    list.sort(sorters[S.sort]);
    v.innerHTML = `${filterBar()}
      <div class="sort-row"><span class="filter-label">Sort by</span>
        ${[["mine", "My top 3"], ["cost", "Lodging cost"]].map(([k, l]) => `<button class="chip" data-sort="${k}" aria-pressed="${S.sort === k}">${l}</button>`).join("")}
      </div>
      <div class="box" style="margin-bottom:14px" data-top3list>${top3ListInner()}</div>
      <div class="compare-grid">${list.map((d) => `
        <article class="cmp">
          <div class="cmp-photo" style="background-image:url('${esc(d.hero.url)}')" role="img" aria-label="${esc(d.hero.caption)}">${rankOf(d.id) ? `<span class="rank">${MEDALS[rankOf(d.id) - 1]} #${rankOf(d.id)}</span>` : ""}</div>
          <div class="cmp-body">
            <div><div class="card-kicker" style="color:var(--rust)">${esc(d.personality)}</div><h3>${esc(d.name)}</h3></div>
            <dl class="kv">
              <dt>Lodging</dt><dd>${esc(costRange(d))} for 3 nights</dd>
              <dt>Travel</dt><dd>${esc(d.stat.travel)}</dd>
              <dt>Weather</dt><dd>${esc(d.stat.temps)} · ${esc(d.stat.sky)}</dd>
            </dl>
            <div style="display:flex;gap:8px;margin-top:auto">
              <button class="btn btn-ghost" style="flex:1" data-open="${d.id}">Details</button>
              <button class="btn btn-primary" style="flex:1" data-pick="${d.id}">${pickLabel(d.id)}</button>
            </div>
          </div>
        </article>`).join("")}</div>
      <p class="footer-note">v${esc(TRIP.version)}</p>`;
    bindFilters(v);
    v.querySelectorAll("[data-top3list]").forEach(bindTop3List);
    v.querySelectorAll("[data-sort]").forEach((b) => (b.onclick = () => { S.sort = b.dataset.sort; renderView(); }));
    v.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
    v.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => openPick(b.dataset.pick)));
  }

  // ---------- boot ----------
  render();
})();
