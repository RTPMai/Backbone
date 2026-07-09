export const config = { maxDuration: 300 };

// BackBone <- Printavo sync
//
// Two modes, one endpoint:
//   ?mode=incremental  (default) — fast path. Pulls only invoices created since
//                       the last successful run's high-water mark, folds them
//                       into the existing per-customer roster aggregates.
//                       Meant to run every few minutes via cron. Cheap.
//   ?mode=reconcile    — slow path. Pages the FULL invoice history and rebuilds
//                       every customer's aggregates from scratch. Self-heals any
//                       drift (missed runs, edited/voided invoices, retries).
//                       Meant to run nightly. Expensive but authoritative.
//
// Both write into backbone_data under state.synced WITHOUT touching
// state.enrichment or LEAD-/prospect rows. Printavo stays the source of truth;
// BackBone.synced is always a derived view of it.
//
// Guarded by SYNC_SECRET when set (header x-sync-secret or ?secret=). The cron
// passes it; ad-hoc browser calls must too.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token   = process.env.PRINTAVO_API_TOKEN;
  const email   = process.env.PRINTAVO_EMAIL;
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const secret  = process.env.SYNC_SECRET;

  if (!token || !email)   return res.status(500).json({ error: "Missing Printavo credentials" });
  if (!kvUrl || !kvToken) return res.status(500).json({ error: "Missing Upstash env vars" });

  // Secret guard — only enforced if SYNC_SECRET is set in the environment.
  if (secret) {
    const provided = req.headers["x-sync-secret"] || req.query.secret;
    if (provided !== secret) return res.status(401).json({ error: "Unauthorized" });
  }

  const mode         = (req.query.mode || "incremental").toLowerCase();
  const resumeCursor = req.query.cursor || null;

  // --- Printavo GraphQL --------------------------------------------------
  async function gql(query) {
    const r = await fetch("https://www.printavo.com/api/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", email, token },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error(`Printavo HTTP ${r.status}`);
    const json = await r.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join(", "));
    return json.data;
  }

  // --- Upstash -----------------------------------------------------------
  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
    const j = await r.json();
    if (!j.result) return null;
    let val = j.result;
    for (let i = 0; i < 3; i++) {
      if (typeof val === "string") { try { val = JSON.parse(val); } catch (e) { break; } }
      else break;
    }
    // Upstash "chunked object" recovery (same guard BackBone's data.js uses)
    if (typeof val === "object" && val !== null && !Array.isArray(val) &&
        val.synced === undefined && val["0"] !== undefined) {
      val = JSON.parse(
        Object.keys(val).sort((a, b) => Number(a) - Number(b)).map(k => val[k]).join("")
      );
    }
    return val;
  }

  async function kvSet(key, value) {
    await fetch(`${kvUrl}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value)]]),
    });
  }

  // --- Helpers -----------------------------------------------------------

  // A roster row is a "prospect"/lead placeholder we must never clobber with
  // Printavo data: LEAD- ids or the is_prospect flag your promote-to-roster
  // flow sets. Reconcile rebuilds only real Printavo customers around these.
  function isProtectedRow(row) {
    return row && (row.is_prospect === true ||
      (typeof row.customer_id === "string" && row.customer_id.startsWith("LEAD-")));
  }

  // Fold one invoice into a per-customer accumulator.
  // Skips $0 invoices so dormant accounts with recent $0 records don't read as
  // active (documented BackBone gotcha). Unpaid non-$0 invoices still count —
  // total_revenue here means invoiced value, matching the existing seed data.
  function foldInvoice(acc, inv) {
    const cust = inv.customer;
    if (!cust || !cust.id) return;
    const amount = Number(inv.total) || 0;
    if (amount <= 0) return; // $0 filter

    const id = String(cust.id);
    if (!acc[id]) {
      acc[id] = {
        customer_id: id,
        company_name: cust.companyName || cust.company || (inv.contact && inv.contact.fullName) || "Unknown",
        invoice_count: 0,
        total_revenue: 0,
        last_invoice_date: null,
      };
    }
    const row = acc[id];
    row.invoice_count += 1;
    row.total_revenue += amount;
    const d = inv.createdAt ? inv.createdAt.slice(0, 10) : null;
    if (d && (!row.last_invoice_date || d > row.last_invoice_date)) row.last_invoice_date = d;
    // Prefer a real company name if a later invoice carries one.
    if ((!row.company_name || row.company_name === "Unknown") && cust.companyName) {
      row.company_name = cust.companyName;
    }
  }

  // Merge freshly-aggregated Printavo rows into state.synced.
  //  - Protected (LEAD-/prospect) rows are preserved untouched.
  //  - For reconcile: real Printavo customers are fully replaced by rebuilt totals.
  //  - For incremental: existing customer totals are ADDED to; new customers appended.
  function mergeIntoSynced(existingSynced, aggregated, { replace }) {
    const protectedRows = existingSynced.filter(isProtectedRow);
    const realRows = existingSynced.filter(r => !isProtectedRow(r));
    const byId = {};
    realRows.forEach(r => { byId[String(r.customer_id)] = r; });

    Object.values(aggregated).forEach(agg => {
      const id = String(agg.customer_id);
      const prev = byId[id];
      if (!prev || replace) {
        // Reconcile, or brand-new customer: take the aggregate as-is.
        byId[id] = { ...(prev || {}), ...agg };
      } else {
        // Incremental: add the delta onto the running totals.
        byId[id] = {
          ...prev,
          company_name: agg.company_name && agg.company_name !== "Unknown" ? agg.company_name : prev.company_name,
          invoice_count: (Number(prev.invoice_count) || 0) + agg.invoice_count,
          total_revenue: (Number(prev.total_revenue) || 0) + agg.total_revenue,
          last_invoice_date: agg.last_invoice_date && (!prev.last_invoice_date || agg.last_invoice_date > prev.last_invoice_date)
            ? agg.last_invoice_date : prev.last_invoice_date,
        };
      }
    });

    return [...protectedRows, ...Object.values(byId)];
  }

  const GQL_FIELDS =
    "nodes{id visualId createdAt total status{id name}contact{fullName}customer{id companyName}}pageInfo{hasNextPage endCursor}";

  try {
    const stateKey = "backbone_data";

    // =====================================================================
    // INCREMENTAL — pull only invoices created after the high-water mark.
    // =====================================================================
    if (mode === "incremental") {
      const meta = (await kvGet("backbone_sync_meta")) || {};
      // Default look-back window if we've never run: last 7 days. This keeps a
      // first incremental run bounded; a full history load is reconcile's job.
      const sinceIso = meta.highWater ||
        new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      // Small overlap (re-pull the last 60 min) so an invoice created right at
      // the boundary of the previous run can't slip through the crack. The
      // per-invoice id dedupe below makes the overlap harmless.
      const overlapIso = new Date(new Date(sinceIso).getTime() - 60 * 60 * 1000).toISOString();

      const acc = {};
      const seen = new Set(); // invoice ids folded this run (dedupe overlap)
      let cursor = resumeCursor;
      let newHighWater = meta.highWater || null;
      let pages = 0;
      const deadline = Date.now() + 240000;

      do {
        const after = cursor ? `,after:"${cursor}"` : "";
        const data = await gql(
          `query{invoices(first:25,sortOn:CREATED_AT_DESC,createdAfter:"${overlapIso}"${after}){${GQL_FIELDS}}}`
        );
        for (const inv of data.invoices.nodes) {
          if (seen.has(inv.id)) continue;
          seen.add(inv.id);
          foldInvoice(acc, inv);
          if (inv.createdAt && (!newHighWater || inv.createdAt > newHighWater)) newHighWater = inv.createdAt;
        }
        cursor = data.invoices.pageInfo.hasNextPage ? data.invoices.pageInfo.endCursor : null;
        pages++;
        if (cursor) await new Promise(r => setTimeout(r, 1200));
      } while (cursor && Date.now() < deadline);

      // If we ran out of time mid-page, hand back a resume URL and DON'T advance
      // the high-water mark yet — next call continues, correctness preserved.
      if (cursor) {
        return res.status(200).json({
          ok: true, mode, status: "partial", pages, customersTouched: Object.keys(acc).length,
          nextUrl: `/api/printavo-sync?mode=incremental&cursor=${encodeURIComponent(cursor)}`,
        });
      }

      const state = (await kvGet(stateKey)) || { synced: [], enrichment: {}, lastSynced: null };
      const synced = mergeIntoSynced(state.synced || [], acc, { replace: false });
      const nextState = { ...state, synced, lastSynced: new Date().toISOString() };
      await kvSet(stateKey, nextState);
      await kvSet("backbone_sync_meta", {
        highWater: newHighWater || sinceIso,
        lastIncrementalAt: new Date().toISOString(),
        lastReconcileAt: meta.lastReconcileAt || null,
      });

      return res.status(200).json({
        ok: true, mode, status: "done", pages,
        customersTouched: Object.keys(acc).length, rosterSize: synced.length,
        highWater: newHighWater || sinceIso,
      });
    }

    // =====================================================================
    // RECONCILE — rebuild every customer's aggregates from full history.
    // =====================================================================
    if (mode === "reconcile") {
      // Accumulate across resumable calls in a partial key so a 300s timeout
      // doesn't force us to start over.
      let partial = await kvGet("backbone_reconcile_partial");
      if (!resumeCursor || !partial) partial = { acc: {}, seen: [] };
      const acc = partial.acc || {};
      const seen = new Set(partial.seen || []);

      let cursor = resumeCursor;
      let pages = 0;
      const deadline = Date.now() + 240000;

      do {
        const after = cursor ? `,after:"${cursor}"` : "";
        const data = await gql(
          `query{invoices(first:25,sortOn:VISUAL_ID${after}){${GQL_FIELDS}}}`
        );
        for (const inv of data.invoices.nodes) {
          if (seen.has(inv.id)) continue;
          seen.add(inv.id);
          foldInvoice(acc, inv);
        }
        cursor = data.invoices.pageInfo.hasNextPage ? data.invoices.pageInfo.endCursor : null;
        pages++;
        if (cursor) await new Promise(r => setTimeout(r, 1200));
      } while (cursor && Date.now() < deadline);

      await kvSet("backbone_reconcile_partial", { acc, seen: [...seen], updatedAt: new Date().toISOString() });

      if (cursor) {
        return res.status(200).json({
          ok: true, mode, status: "partial", pages, customersSoFar: Object.keys(acc).length,
          nextUrl: `/api/printavo-sync?mode=reconcile&cursor=${encodeURIComponent(cursor)}`,
        });
      }

      // Full pass complete — REPLACE real-customer aggregates authoritatively.
      const state = (await kvGet(stateKey)) || { synced: [], enrichment: {}, lastSynced: null };
      const synced = mergeIntoSynced(state.synced || [], acc, { replace: true });
      const nextState = { ...state, synced, lastSynced: new Date().toISOString() };
      await kvSet(stateKey, nextState);

      const nowIso = new Date().toISOString();
      const prevMeta = (await kvGet("backbone_sync_meta")) || {};
      await kvSet("backbone_sync_meta", {
        // After a full reconcile, reset the incremental high-water to now so the
        // next incremental only picks up genuinely newer invoices.
        highWater: nowIso,
        lastIncrementalAt: prevMeta.lastIncrementalAt || null,
        lastReconcileAt: nowIso,
      });
      await kvSet("backbone_reconcile_partial", { acc: {}, seen: [] }); // clear

      return res.status(200).json({
        ok: true, mode, status: "done", pages,
        customers: Object.keys(acc).length, rosterSize: synced.length, reconciledAt: nowIso,
      });
    }

    return res.status(400).json({ error: "Invalid mode. Use: incremental, reconcile" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
