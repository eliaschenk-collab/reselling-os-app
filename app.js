(() => {
  "use strict";
  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.url, cfg.key);

  // ---------- Hilfsfunktionen ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const eur = (n) => (n == null || Number.isNaN(Number(n))) ? "–" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(Number(n));
  const pct = (n) => (n == null ? "–" : new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(n) + " %");
  const dateDE = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("de-DE") : "–");
  const today = () => new Date().toISOString().slice(0, 10);
  const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const avg = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
  // Zahl aus Eingabe: "159,99" und "159.99" sind beide erlaubt
  const num = (v) => {
    const t = String(v ?? "").trim().replace(/[€\s]/g, "");
    if (!t) return null;
    const s = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const val = (id) => { const e = $("#" + id); return e ? e.value.trim() : ""; };
  const orNull = (s) => (s === "" ? null : s);

  const STATUS = { im_bestand: "Im Bestand", eingestellt: "Eingestellt", verkauft: "Verkauft", retour: "Retour", abgeschrieben: "Abgeschrieben" };
  const KOSTEN = { versand: "Versand", reinigung: "Reinigung", reparatur: "Reparatur", kaeuferschutz: "Käuferschutz", sonstiges: "Sonstiges" };
  const IN_STOCK = ["im_bestand", "eingestellt"];

  let toastTimer;
  function toast(msg, isErr) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ""), isErr ? 5000 : 2200);
  }
  const fail = (e) => { console.error(e); toast("Fehler: " + (e && e.message ? e.message : e), true); };

  // ---------- Zustand ----------
  const state = { session: null, fin: [], accounts: [], tab: "home", period: "all", q: "", status: "", sort: "name", openId: null };

  // ---------- Start ----------
  async function boot() {
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    sb.auth.onAuthStateChange((_e, session) => {
      const was = !!state.session;
      state.session = session;
      if (!!session !== was) render();
    });
    render();
  }

  async function render() {
    if (!state.session) return renderLogin();
    renderShell();
    await loadData();
    renderView();
  }

  // ---------- Anmeldung ----------
  function renderLogin() {
    $("#app").innerHTML = `
      <div class="login"><h1>Reselling OS</h1>
        <form class="card" id="loginForm">
          <div><label for="em">E-Mail</label><input id="em" type="email" autocomplete="username" required></div>
          <div><label for="pw">Passwort</label><input id="pw" type="password" autocomplete="current-password" required minlength="8"></div>
          <button class="primary" type="submit">Anmelden</button>
          <button type="button" id="signup">Neues Konto anlegen</button>
          <p class="hint">Beim ersten Mal: „Neues Konto anlegen“, dann den Bestätigungslink in der E-Mail öffnen, danach anmelden.</p>
        </form></div>`;
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: val("em"), password: $("#pw").value });
      if (error) fail(error);
    });
    $("#signup").addEventListener("click", async () => {
      if (!val("em") || $("#pw").value.length < 8) return toast("E-Mail und Passwort (mind. 8 Zeichen) eingeben", true);
      const { error } = await sb.auth.signUp({ email: val("em"), password: $("#pw").value });
      if (error) fail(error); else toast("Konto angelegt. Bitte Bestätigungs-Mail öffnen.");
    });
  }

  function renderShell() {
    $("#app").innerHTML = `
      <header class="top">
        <h1>Reselling OS</h1>
        <nav class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="home">Übersicht</button>
          <button class="tab" role="tab" data-tab="items">Artikel</button>
          <button class="tab" role="tab" data-tab="data">Daten</button>
        </nav>
        <button class="primary small" data-act="new">+ Neu</button>
      </header>
      <main id="view"></main>`;
    syncTabs();
  }
  function syncTabs() {
    document.querySelectorAll("button.tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  }

  async function loadData() {
    const [f, a] = await Promise.all([
      sb.from("item_financials").select("*"),
      sb.from("accounts").select("id,name").order("name"),
    ]);
    if (f.error) return fail(f.error);
    state.fin = (f.data || []).map((r) => ({ ...r }));
    state.accounts = a.data || [];
  }

  function renderView() {
    syncTabs();
    const v = $("#view");
    if (!v) return;
    if (state.fin.length === 0) {
      v.innerHTML = `<div class="note">Keine Daten sichtbar. Entweder ist die Datenbank leer, oder dieses Konto hat keinen Zugriff (angemeldet als ${esc(state.session.user.email)}).</div>
        <p><button data-act="logout">Abmelden</button></p>`;
      return;
    }
    if (state.tab === "home") v.innerHTML = homeHTML();
    else if (state.tab === "items") v.innerHTML = itemsHTML();
    else v.innerHTML = dataHTML();
  }

  // ---------- Übersicht ----------
  function inPeriod(r) {
    const p = state.period;
    if (p === "all") return true;
    if (!r.sold_at) return false;
    if (/^y\d{4}$/.test(p)) return r.sold_at.startsWith(p.slice(1));
    const days = Number(p.slice(1));
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return r.sold_at >= from;
  }

  function homeHTML() {
    const stock = state.fin.filter((r) => IN_STOCK.includes(r.status));
    const sold = state.fin.filter((r) => r.status === "verkauft" && inPeriod(r));
    const known = sold.filter((r) => r.cost_known);
    const unknown = sold.length - known.length;
    const profit = sum(known, (r) => r.profit);
    const costKnown = sum(known, (r) => Number(r.total_cost));
    const roiAll = costKnown > 0 ? (profit / costKnown) * 100 : null;
    const days = avg(sold.filter((r) => r.days_to_sell != null).map((r) => Number(r.days_to_sell)));
    const tied = sum(stock, (r) => r.total_cost);

    const byBrand = {};
    known.forEach((r) => {
      const b = r.brand || "Ohne Marke";
      (byBrand[b] = byBrand[b] || []).push(r);
    });
    const brandRows = Object.entries(byBrand).map(([b, rs]) => {
      const c = sum(rs, (r) => r.total_cost), p = sum(rs, (r) => r.profit);
      const d = avg(rs.filter((r) => r.days_to_sell != null).map((r) => Number(r.days_to_sell)));
      return { b, n: rs.length, p, roi: c > 0 ? (p / c) * 100 : null, d };
    }).sort((x, y) => y.p - x.p);

    const years = [...new Set(state.fin.filter((r) => r.sold_at).map((r) => r.sold_at.slice(0, 4)))].sort().reverse();
    const periodOpts = [["all", "Gesamt"], ["d30", "Letzte 30 Tage"], ["d90", "Letzte 90 Tage"], ...years.map((y) => ["y" + y, "Jahr " + y])]
      .map(([v, l]) => `<option value="${v}" ${state.period === v ? "selected" : ""}>${l}</option>`).join("");

    const stockRows = stock.slice().sort((a, b) => Number(b.total_cost) - Number(a.total_cost)).map((r) => `
      <div class="item" data-open="${r.item_id}"><div class="t"><b>${esc(r.title)}</b><span class="m">${esc(r.brand || "")} ${r.size ? "· " + esc(r.size) : ""}</span></div>
      <span class="chip s-${r.status}">${STATUS[r.status]}</span><div class="r">${eur(r.total_cost)}</div></div>`).join("");

    return `
      <div class="row"><h2 style="margin:0;flex:1">Kennzahlen</h2>
        <select id="period" style="width:auto">${periodOpts}</select></div>
      <div class="grid" style="margin-top:12px">
        <div class="card kpi"><div class="label">Gebundenes Kapital</div><div class="value">${eur(tied)}</div><div class="sub">${stock.length} Artikel im Bestand</div></div>
        <div class="card kpi"><div class="label">Realisierter Gewinn</div><div class="value ${profit >= 0 ? "good" : "bad"}">${eur(profit)}</div><div class="sub">aus ${known.length} ${known.length === 1 ? "Verkauf" : "Verkäufen"} mit bekanntem Einkauf</div></div>
        <div class="card kpi"><div class="label">Umsatz (alle Verkäufe)</div><div class="value">${eur(sum(sold, (r) => r.sale_price))}</div><div class="sub">${sold.length} ${sold.length === 1 ? "Verkauf" : "Verkäufe"}</div></div>
        <div class="card kpi"><div class="label">Rendite</div><div class="value">${pct(roiAll)}</div><div class="sub">Gewinn / Gesamtkosten</div></div>
        <div class="card kpi"><div class="label">Ø Verkaufsdauer</div><div class="value">${days == null ? "–" : Math.round(days) + " Tage"}</div><div class="sub">Einstellen bis Verkauf</div></div>
      </div>
      ${unknown ? `<p class="note" style="margin-top:12px">${unknown === 1 ? "Ein verkaufter Artikel hat" : unknown + " verkaufte Artikel haben"} keinen erfassten Einkaufspreis. ${unknown === 1 ? "Er zählt" : "Sie zählen"} nicht in Gewinn und Rendite.</p>` : ""}
      <p class="hint">Gewinn = Verkaufspreis − Verkaufskosten − Einkaufspreis − Zusatzkosten. Unverkaufte Artikel zählen nie als Gewinn.</p>
      <h2>Nach Marke (Verkäufe mit bekanntem Einkauf)</h2>
      ${brandRows.length ? `<table><thead><tr><th>Marke</th><th class="n">Verkäufe</th><th class="n">Gewinn</th><th class="n">Rendite</th><th class="n">Ø Tage</th></tr></thead><tbody>
        ${brandRows.map((r) => `<tr><td>${esc(r.b)}</td><td class="n">${r.n}</td><td class="n ${r.p >= 0 ? "good" : "bad"}">${eur(r.p)}</td><td class="n">${pct(r.roi)}</td><td class="n">${r.d == null ? "–" : Math.round(r.d)}</td></tr>`).join("")}
        </tbody></table>` : `<p class="hint">Keine Verkäufe im Zeitraum.</p>`}
      <h2>Im Bestand</h2><div class="list">${stockRows || '<p class="hint">Kein Bestand.</p>'}</div>`;
  }

  // ---------- Artikelliste ----------
  function itemsHTML() {
    const opts = Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${state.status === v ? "selected" : ""}>${l}</option>`).join("");
    const sorts = { name: "Name", cost: "Kosten (hoch zuerst)", profit: "Gewinn (hoch zuerst)", sold: "Verkaufsdatum (neu zuerst)" };
    return `
      <div class="row" style="margin-bottom:12px">
        <div class="field" style="flex:2"><input id="q" type="search" placeholder="Suchen (Name, Marke, Größe)" value="${esc(state.q)}"></div>
        <div class="field"><select id="fstatus"><option value="">Alle Status</option>${opts}</select></div>
        <div class="field"><select id="fsort">${Object.entries(sorts).map(([v, l]) => `<option value="${v}" ${state.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </div>
      <div class="list" id="itemList">${itemListInner()}</div>`;
  }
  function itemListInner() {
    const q = state.q.toLowerCase();
    let rows = state.fin.filter((r) => (!state.status || r.status === state.status) &&
      (!q || [r.title, r.brand, r.size, r.category].some((x) => (x || "").toLowerCase().includes(q))));
    const s = state.sort;
    rows.sort((a, b) =>
      s === "cost" ? Number(b.total_cost) - Number(a.total_cost) :
      s === "profit" ? (Number(b.profit ?? -1e9) - Number(a.profit ?? -1e9)) :
      s === "sold" ? (b.sold_at || "").localeCompare(a.sold_at || "") :
      (a.title || "").localeCompare(b.title || "", "de"));
    if (!rows.length) return '<p class="hint">Keine Treffer.</p>';
    return `<p class="hint">${rows.length} Artikel</p>` + rows.map((r) => {
      const right = r.status === "verkauft"
        ? (r.cost_known ? `<span class="${Number(r.profit) >= 0 ? "good" : "bad"}">${eur(r.profit)}</span><div class="m">Verkauft ${eur(r.sale_price)}</div>` : `<div>${eur(r.sale_price)}</div><div class="m">Einkauf unbekannt</div>`)
        : `${eur(r.total_cost)}<div class="m">Kosten</div>`;
      return `<div class="item" data-open="${r.item_id}"><div class="t"><b>${esc(r.title)}</b><span class="m">${esc(r.brand || "")}${r.size ? " · " + esc(r.size) : ""}${r.sold_at ? " · " + dateDE(r.sold_at) : ""}</span></div>
        <span class="chip s-${r.status}">${STATUS[r.status] || r.status}</span><div class="r">${right}</div></div>`;
    }).join("");
  }

  // ---------- Daten / Export ----------
  function dataHTML() {
    return `
      <h2>Daten sichern und exportieren</h2>
      <p class="hint">Deine Daten liegen in der Datenbank. Mit diesen Knöpfen lädst du eine Kopie herunter.</p>
      <div class="row">
        <button class="primary" data-act="csv">Artikel als CSV (Excel)</button>
        <button data-act="backup">Komplett-Backup (JSON)</button>
      </div>
      <h2>Konto</h2>
      <p>Angemeldet als ${esc(state.session.user.email)}</p>
      <button data-act="logout">Abmelden</button>`;
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportCSV() {
    const cols = [["title", "Artikel"], ["brand", "Marke"], ["category", "Kategorie"], ["size", "Größe"], ["status", "Status"],
      ["purchase_price", "Einkaufspreis"], ["extra_costs", "Zusatzkosten"], ["total_cost", "Gesamtkosten"], ["sale_price", "Verkaufspreis"],
      ["seller_costs", "Verkaufskosten"], ["sold_at", "Verkaufsdatum"], ["profit", "Gewinn"], ["roi_percent", "Rendite %"],
      ["first_listed_at", "Erstes Einstelldatum"], ["days_to_sell", "Verkaufsdauer Tage"], ["tied_capital", "Gebundenes Kapital"], ["cost_known", "Einkauf bekannt"]];
    const cell = (v) => { let s = v == null ? "" : (typeof v === "number" ? String(v).replace(".", ",") : String(v)); if (/[;"\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s; };
    const lines = [cols.map((c) => c[1]).join(";")].concat(state.fin.map((r) => cols.map((c) => cell(r[c[0]])).join(";")));
    download("reselling-artikel-" + today() + ".csv", "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
  }
  async function exportBackup() {
    const names = ["accounts", "items", "purchases", "cost_entries", "listings", "sales", "transfers", "ledger_entries"];
    const out = { exported_at: new Date().toISOString() };
    for (const n of names) {
      const { data, error } = await sb.from(n).select("*");
      if (error) return fail(error);
      out[n] = data;
    }
    download("reselling-backup-" + today() + ".json", JSON.stringify(out, null, 2), "application/json");
  }

  // ---------- Dialog: Artikel ansehen / bearbeiten ----------
  const dlg = () => $("#dlg");
  function closeDlg() { dlg().close(); state.openId = null; }

  function opt(map, sel) { return Object.entries(map).map(([v, l]) => `<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`).join(""); }

  function newDialog() {
    state.openId = null;
    const acc = state.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
    dlg().innerHTML = `
      <div class="dlg-head"><h2>Neuer Artikel</h2><button data-act="close">Abbrechen</button></div>
      <div class="dlg-body">
        <h3>Artikel</h3>
        <div class="row">
          <div class="field" style="flex:2 1 300px"><label for="n_title">Bezeichnung *</label><input id="n_title"></div>
          <div class="field"><label for="n_brand">Marke</label><input id="n_brand"></div>
          <div class="field"><label for="n_cat">Kategorie</label><input id="n_cat" placeholder="z. B. Wachsjacke"></div>
          <div class="field"><label for="n_size">Größe</label><input id="n_size"></div>
          <div class="field"><label for="n_cond">Zustand</label><input id="n_cond" placeholder="z. B. sehr gut"></div>
        </div>
        <h3>Einkauf</h3>
        <div class="row">
          <div class="field"><label for="n_plat">Plattform</label><input id="n_plat" value="Vinted"></div>
          <div class="field"><label for="n_date">Kaufdatum</label><input id="n_date" type="date" value="${today()}"></div>
          <div class="field"><label for="n_price">Einkaufspreis (€) *</label><input id="n_price" inputmode="decimal"></div>
          <div class="field"><label for="n_acc">Konto</label><select id="n_acc"><option value="">–</option>${acc}</select></div>
          <div class="field"><label for="n_pay">Zahlart</label><select id="n_pay"><option value="">–</option><option>Apple Pay</option><option>PayPal</option><option>Vinted-Guthaben</option><option>bar</option></select></div>
        </div>
        <p><button class="primary" data-act="create-item">Speichern</button></p>
      </div>`;
    dlg().showModal();
  }

  async function createItem() {
    const title = val("n_title"), price = num(val("n_price"));
    if (!title) return toast("Bezeichnung fehlt", true);
    if (price == null || Number.isNaN(price) || price < 0) return toast("Einkaufspreis ungültig", true);
    const { data: it, error } = await sb.from("items").insert({
      title, brand: orNull(val("n_brand")), category: orNull(val("n_cat")), size: orNull(val("n_size")), condition: orNull(val("n_cond")), status: "im_bestand",
    }).select("id").single();
    if (error) return fail(error);
    const { error: e2 } = await sb.from("purchases").insert({
      item_id: it.id, platform: val("n_plat") || "Vinted", purchased_at: orNull(val("n_date")), price,
      account_id: orNull(val("n_acc")), payment_method: orNull(val("n_pay")),
    });
    if (e2) return fail(e2);
    toast("Artikel angelegt");
    await loadData(); renderView();
    await openItem(it.id);
  }

  async function openItem(id) {
    state.openId = id;
    const [it, pu, co, li, sa] = await Promise.all([
      sb.from("items").select("*").eq("id", id).single(),
      sb.from("purchases").select("*").eq("item_id", id).maybeSingle(),
      sb.from("cost_entries").select("*").eq("item_id", id).order("created_at"),
      sb.from("listings").select("*").eq("item_id", id).order("listed_at"),
      sb.from("sales").select("*").eq("item_id", id).maybeSingle(),
    ]);
    const err = it.error || pu.error || co.error || li.error || sa.error;
    if (err) return fail(err);
    const prevScroll = dlg().open && $(".dlg-body") ? $(".dlg-body").scrollTop : 0;
    const item = it.data, p = pu.data || {}, costs = co.data || [], lists = li.data || [], s = sa.data || {};
    const accOpts = `<option value="">–</option>` + state.accounts.map((a) => `<option value="${a.id}" ${p.account_id === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    const pays = ["", "Apple Pay", "PayPal", "Vinted-Guthaben", "bar"].map((x) => `<option ${p.payment_method === x || (!p.payment_method && x === "") ? "selected" : ""}>${x}</option>`).join("");
    const fin = state.fin.find((r) => r.item_id === id) || {};

    dlg().innerHTML = `
      <div class="dlg-head"><h2>${esc(item.title)}</h2><button data-act="close">Schließen</button></div>
      <div class="dlg-body">
        <div class="grid" style="margin:12px 0">
          <div class="card kpi"><div class="label">Gesamtkosten</div><div class="value">${eur(fin.total_cost)}</div></div>
          <div class="card kpi"><div class="label">Gewinn</div><div class="value ${Number(fin.profit) >= 0 ? "good" : "bad"}">${fin.profit == null ? "–" : eur(fin.profit)}</div><div class="sub">${fin.roi_percent == null ? "" : "Rendite " + pct(fin.roi_percent)}${fin.days_to_sell == null ? "" : " · " + fin.days_to_sell + " Tage"}</div></div>
        </div>

        <h3>Artikel</h3>
        <div class="row">
          <div class="field" style="flex:2 1 300px"><label for="e_title">Bezeichnung</label><input id="e_title" value="${esc(item.title)}"></div>
          <div class="field"><label for="e_brand">Marke</label><input id="e_brand" value="${esc(item.brand)}"></div>
          <div class="field"><label for="e_cat">Kategorie</label><input id="e_cat" value="${esc(item.category)}"></div>
          <div class="field"><label for="e_size">Größe</label><input id="e_size" value="${esc(item.size)}"></div>
          <div class="field"><label for="e_cond">Zustand</label><input id="e_cond" value="${esc(item.condition)}"></div>
          <div class="field"><label for="e_status">Status</label><select id="e_status">${opt(STATUS, item.status)}</select></div>
          <div class="field" style="flex:2 1 300px"><label for="e_defect">Mangel</label><input id="e_defect" value="${esc(item.defect_description)}"></div>
          <div class="field" style="flex:0 0 150px"><label for="e_fixed">Mangel behoben</label><select id="e_fixed"><option value="false" ${item.defect_fixed ? "" : "selected"}>Nein</option><option value="true" ${item.defect_fixed ? "selected" : ""}>Ja</option></select></div>
          <div class="field" style="flex:1 1 100%"><label for="e_notes">Notiz</label><textarea id="e_notes">${esc(item.notes)}</textarea></div>
        </div>
        <p><button class="primary small" data-act="save-item">Artikel speichern</button></p>

        <h3>Einkauf</h3>
        <div class="row">
          <div class="field"><label for="p_plat">Plattform</label><input id="p_plat" value="${esc(p.platform || "Vinted")}"></div>
          <div class="field"><label for="p_date">Kaufdatum</label><input id="p_date" type="date" value="${esc(p.purchased_at)}"></div>
          <div class="field"><label for="p_price">Einkaufspreis (€)</label><input id="p_price" inputmode="decimal" value="${p.price == null ? "" : esc(String(p.price).replace(".", ","))}"></div>
          <div class="field"><label for="p_acc">Konto</label><select id="p_acc">${accOpts}</select></div>
          <div class="field"><label for="p_pay">Zahlart</label><select id="p_pay">${pays}</select></div>
          <div class="field" style="flex:1 1 100%"><label for="p_note">Notiz</label><input id="p_note" value="${esc(p.note)}"></div>
        </div>
        <p><button class="primary small" data-act="save-purchase">Einkauf speichern</button></p>

        <h3>Zusatzkosten</h3>
        ${costs.map((c) => `<div class="sub-row"><span class="grow">${KOSTEN[c.kind] || esc(c.kind)}${c.is_estimate ? " (geschätzt)" : ""}${c.note ? " · " + esc(c.note) : ""}</span><b>${eur(c.amount)}</b><button class="small danger" data-del-cost="${c.id}">Löschen</button></div>`).join("") || '<p class="hint">Keine Zusatzkosten.</p>'}
        <div class="row" style="margin-top:8px">
          <div class="field"><label for="c_kind">Art</label><select id="c_kind">${opt(KOSTEN, "versand")}</select></div>
          <div class="field"><label for="c_amount">Betrag (€)</label><input id="c_amount" inputmode="decimal"></div>
          <div class="field"><label for="c_est">Betrag ist</label><select id="c_est"><option value="false">exakt</option><option value="true">geschätzt</option></select></div>
          <div class="field"><button class="small" data-act="add-cost" style="margin-top:20px">Hinzufügen</button></div>
        </div>

        <h3>Inserate</h3>
        ${lists.map((l) => `<div class="sub-row"><span class="grow">${esc(l.platform)} · ${dateDE(l.listed_at)} · ${esc(l.status)}</span><b>${eur(l.list_price)}</b><button class="small danger" data-del-listing="${l.id}">Löschen</button></div>`).join("") || '<p class="hint">Noch kein Inserat.</p>'}
        <div class="row" style="margin-top:8px">
          <div class="field"><label for="l_plat">Plattform</label><input id="l_plat" value="Vinted"></div>
          <div class="field"><label for="l_date">Eingestellt am</label><input id="l_date" type="date" value="${today()}"></div>
          <div class="field"><label for="l_price">Angebotspreis (€)</label><input id="l_price" inputmode="decimal"></div>
          <div class="field"><button class="small" data-act="add-listing" style="margin-top:20px">Hinzufügen</button></div>
        </div>

        <h3>Verkauf</h3>
        <div class="row">
          <div class="field"><label for="s_plat">Plattform</label><input id="s_plat" value="${esc(s.platform || "Vinted")}"></div>
          <div class="field"><label for="s_date">Verkaufsdatum</label><input id="s_date" type="date" value="${esc(s.sold_at || "")}"></div>
          <div class="field"><label for="s_price">Verkaufspreis (€)</label><input id="s_price" inputmode="decimal" value="${s.sale_price == null ? "" : esc(String(s.sale_price).replace(".", ","))}"></div>
          <div class="field"><label for="s_costs">Verkaufskosten (€, von dir getragen)</label><input id="s_costs" inputmode="decimal" value="${s.seller_costs == null ? "0" : esc(String(s.seller_costs).replace(".", ","))}"></div>
          <div class="field" style="flex:1 1 100%"><label for="s_note">Notiz</label><input id="s_note" value="${esc(s.note)}"></div>
        </div>
        <p class="row"><button class="primary small" data-act="save-sale">Verkauf speichern</button>
          ${s.id ? '<button class="small danger" data-act="del-sale">Verkauf entfernen</button>' : ""}</p>
      </div>`;
    if (!dlg().open) dlg().showModal();
    const body = $(".dlg-body"); if (body) body.scrollTop = prevScroll;
  }

  async function after(msg) {
    toast(msg);
    const id = state.openId;
    await loadData(); renderView();
    if (id) await openItem(id);
  }

  async function saveItem() {
    const title = val("e_title");
    if (!title) return toast("Bezeichnung fehlt", true);
    const { error } = await sb.from("items").update({
      title, brand: orNull(val("e_brand")), category: orNull(val("e_cat")), size: orNull(val("e_size")), condition: orNull(val("e_cond")),
      status: val("e_status"), defect_description: orNull(val("e_defect")), defect_fixed: val("e_fixed") === "true", notes: orNull(val("e_notes")),
    }).eq("id", state.openId);
    if (error) return fail(error);
    await after("Artikel gespeichert");
  }

  async function savePurchase() {
    const price = num(val("p_price"));
    if (price == null || Number.isNaN(price) || price < 0) return toast("Einkaufspreis ungültig", true);
    const { error } = await sb.from("purchases").upsert({
      item_id: state.openId, platform: val("p_plat") || "Vinted", purchased_at: orNull(val("p_date")), price,
      account_id: orNull(val("p_acc")), payment_method: orNull(val("p_pay")), note: orNull(val("p_note")),
    }, { onConflict: "item_id" });
    if (error) return fail(error);
    await after("Einkauf gespeichert");
  }

  async function addCost() {
    const amount = num(val("c_amount"));
    if (amount == null || Number.isNaN(amount) || amount < 0) return toast("Betrag ungültig", true);
    const { error } = await sb.from("cost_entries").insert({ item_id: state.openId, kind: val("c_kind"), amount, is_estimate: val("c_est") === "true", incurred_at: today() });
    if (error) return fail(error);
    await after("Kosten hinzugefügt");
  }
  async function delCost(id) {
    if (!confirm("Diese Kostenposition löschen?")) return;
    const { error } = await sb.from("cost_entries").delete().eq("id", id);
    if (error) return fail(error);
    await after("Gelöscht");
  }

  async function addListing() {
    const price = num(val("l_price"));
    if (price == null || Number.isNaN(price) || price < 0) return toast("Angebotspreis ungültig", true);
    const { error } = await sb.from("listings").insert({ item_id: state.openId, platform: val("l_plat") || "Vinted", listed_at: orNull(val("l_date")), list_price: price, status: "aktiv" });
    if (error) return fail(error);
    const cur = state.fin.find((r) => r.item_id === state.openId);
    if (cur && cur.status === "im_bestand") await sb.from("items").update({ status: "eingestellt" }).eq("id", state.openId);
    await after("Inserat hinzugefügt");
  }
  async function delListing(id) {
    if (!confirm("Dieses Inserat löschen?")) return;
    const { error } = await sb.from("listings").delete().eq("id", id);
    if (error) return fail(error);
    await after("Gelöscht");
  }

  async function saveSale() {
    const price = num(val("s_price")), costs = num(val("s_costs")) ?? 0;
    if (!val("s_date")) return toast("Verkaufsdatum fehlt", true);
    if (price == null || Number.isNaN(price) || price < 0) return toast("Verkaufspreis ungültig", true);
    if (Number.isNaN(costs) || costs < 0) return toast("Verkaufskosten ungültig", true);
    const { error } = await sb.from("sales").upsert({
      item_id: state.openId, platform: val("s_plat") || "Vinted", sold_at: val("s_date"), sale_price: price, seller_costs: costs, note: orNull(val("s_note")),
    }, { onConflict: "item_id" });
    if (error) return fail(error);
    await sb.from("items").update({ status: "verkauft" }).eq("id", state.openId);
    await sb.from("listings").update({ status: "verkauft", ended_at: val("s_date") }).eq("item_id", state.openId).eq("status", "aktiv");
    await after("Verkauf gespeichert");
  }
  async function delSale() {
    if (!confirm("Verkauf entfernen? Der Artikel ist danach wieder im Bestand.")) return;
    const { error } = await sb.from("sales").delete().eq("item_id", state.openId);
    if (error) return fail(error);
    const { count } = await sb.from("listings").select("id", { count: "exact", head: true }).eq("item_id", state.openId);
    await sb.from("items").update({ status: count > 0 ? "eingestellt" : "im_bestand" }).eq("id", state.openId);
    await sb.from("listings").update({ status: "aktiv", ended_at: null }).eq("item_id", state.openId).eq("status", "verkauft");
    await after("Verkauf entfernt");
  }

  // ---------- Ereignisse ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab],[data-act],[data-open],[data-del-cost],[data-del-listing]");
    if (!t) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab; renderView(); return; }
    if (t.dataset.open) { openItem(t.dataset.open).catch(fail); return; }
    if (t.dataset.delCost) { delCost(t.dataset.delCost).catch(fail); return; }
    if (t.dataset.delListing) { delListing(t.dataset.delListing).catch(fail); return; }
    const act = t.dataset.act;
    const map = {
      new: newDialog, close: closeDlg, "create-item": createItem, "save-item": saveItem, "save-purchase": savePurchase,
      "add-cost": addCost, "add-listing": addListing, "save-sale": saveSale, "del-sale": delSale,
      csv: exportCSV, backup: exportBackup,
      logout: async () => { await sb.auth.signOut(); },
    };
    if (map[act]) Promise.resolve(map[act]()).catch(fail);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "q") { state.q = e.target.value; const l = $("#itemList"); if (l) l.innerHTML = itemListInner(); }
  });
  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "period") { state.period = e.target.value; renderView(); }
    else if (id === "fstatus") { state.status = e.target.value; const l = $("#itemList"); if (l) l.innerHTML = itemListInner(); }
    else if (id === "fsort") { state.sort = e.target.value; const l = $("#itemList"); if (l) l.innerHTML = itemListInner(); }
  });

  dlg().addEventListener("close", () => { state.openId = null; });
  boot().catch(fail);
})();
