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
  async function gql(query, _attempt = 0) {
    const r = await fetch("https://www.printavo.com/api/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", email, token },
      body: JSON.stringify({ query }),
    });

    // Rate limited (10 req / 5s per email/IP). Back off and retry rather than
    // killing the whole run — a reconcile makes hundreds of calls and WILL hit
    // this occasionally. Honor Retry-After if present, else exponential backoff.
    if (r.status === 429) {
      if (_attempt >= 5) throw new Error("Printavo HTTP 429 (still rate limited after backoff)");
      const retryAfterHeader = parseInt(r.headers.get("retry-after") || "", 10);
      const waitMs = Number.isFinite(retryAfterHeader)
        ? retryAfterHeader * 1000
        : Math.min(15000, 3000 * Math.pow(2, _attempt)); // 3s,6s,12s,15s,15s
      await new Promise(res => setTimeout(res, waitMs));
      return gql(query, _attempt + 1);
    }

    if (!r.ok) throw new Error(`Printavo HTTP ${r.status}`);
    const json = await r.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join(", "));
    return json.data;
  }

  // Small helper to pace successive introspection calls under the rate limit.
  const rlPause = () => new Promise(res => setTimeout(res, 600));

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

  // ---------------------------------------------------------------------
  // SCHEMA INTROSPECTION
  //
  // We've been burned twice guessing which field on Invoice links to the
  // client (it's not `customer`; `owner` is ambiguous with the staff sales
  // owner). So instead of hardcoding, ask Printavo's schema what actually
  // exists on the Invoice type, then pick the right client link at runtime.
  //
  // Returns a "plan" object:
  //   { linkField, idField, nameField, contactNameField }
  // where linkField is the Invoice field that points at the client account
  // (e.g. "customer" or "contact"), idField/nameField are the sub-fields on
  // that linked type to use for grouping id and company name, and
  // contactNameField is a fallback human name if no company name exists.
  // ---------------------------------------------------------------------
  async function introspectInvoicePlan() {
    // Fields on the Invoice type, with the name of the object type each points to.
    const q = `query{__type(name:"Invoice"){fields{name type{name kind ofType{name kind}}}}}`;
    const data = await gql(q);
    const fields = (data.__type && data.__type.fields) || [];
    const fieldMap = {};
    fields.forEach(f => {
      const t = f.type || {};
      const typeName = t.name || (t.ofType && t.ofType.name) || null;
      const kind = t.kind === "OBJECT" ? "OBJECT" : (t.ofType && t.ofType.kind) || t.kind;
      fieldMap[f.name] = { typeName, kind };
    });

    // Candidate Invoice fields that could carry the client, best first.
    // We deliberately try customer/client BEFORE owner, since owner can mean
    // the internal sales rep rather than the buying company.
    const linkCandidates = ["customer", "client", "contact", "owner"];

    // Given an object type name, introspect ITS fields into a map of
    // { fieldName: {typeName, kind} } so we can locate ids, names, AND nested
    // object links (e.g. a Contact's parent Customer).
    async function fieldsOfType(typeName) {
      if (!typeName) return {};
      const tq = `query{__type(name:"${typeName}"){fields{name type{name kind ofType{name kind}}}}}`;
      const td = await gql(tq);
      const map = {};
      ((td.__type && td.__type.fields) || []).forEach(f => {
        const t = f.type || {};
        const nm = t.name || (t.ofType && t.ofType.name) || null;
        const kd = t.kind === "OBJECT" ? "OBJECT" : (t.ofType && t.ofType.kind) || t.kind;
        map[f.name] = { typeName: nm, kind: kd };
      });
      return map;
    }

    function pickNameField(fieldSet) {
      return fieldSet.companyName ? "companyName" :
             fieldSet.company     ? "company" :
             fieldSet.name        ? "name" : null;
    }
    function pickContactName(fieldSet) {
      return fieldSet.fullName ? "fullName" :
             fieldSet.firstName ? "firstName" : null;
    }

    for (const cand of linkCandidates) {
      const meta = fieldMap[cand];
      if (!meta || meta.kind !== "OBJECT" || !meta.typeName) continue;
      await rlPause();
      const sub = await fieldsOfType(meta.typeName);
      const subHas = {}; Object.keys(sub).forEach(k => { subHas[k] = true; });
      if (!subHas.id) continue; // need a stable id to group on

      const directName = pickNameField(subHas);

      // KEY FIX: if the chosen link is a person-level record (a Contact) with
      // no direct company name, look for a PARENT company object reachable
      // through it — a sub-field whose type is Customer/Company and which has
      // its own id + name. Grouping by that parent's id collapses all of a
      // company's contacts into one roster row (matching Apparelytics).
      let parent = null;
      if (!directName || cand === "contact") {
        const parentCandidates = ["customer", "company", "client", "account", "parentCustomer"];
        for (const pc of parentCandidates) {
          const pm = sub[pc];
          if (!pm || pm.kind !== "OBJECT" || !pm.typeName) continue;
          await rlPause();
          const pf = await fieldsOfType(pm.typeName);
          const pHas = {}; Object.keys(pf).forEach(k => { pHas[k] = true; });
          const pName = pickNameField(pHas);
          if (pHas.id && pName) {
            parent = { field: pc, idField: "id", nameField: pName, typeName: pm.typeName };
            break;
          }
        }
      }

      return {
        linkField: cand,
        idField: "id",
        nameField: directName,
        contactNameField: pickContactName(subHas),
        linkedType: meta.typeName,
        // When present, group by parent.field.id/name instead of the link's own.
        parent,
      };
    }

    // Nothing matched — signal caller to error clearly rather than silently
    // producing an empty roster.
    return null;
  }

  // Build the GraphQL node selection string from a resolved plan.
  function buildFieldSelection(plan) {
    const subFields = [plan.idField];
    if (plan.nameField) subFields.push(plan.nameField);
    if (plan.contactNameField && plan.contactNameField !== plan.nameField) subFields.push(plan.contactNameField);
    // If we found a parent company through the link, request it nested so we
    // can group by the company rather than the individual contact.
    if (plan.parent) {
      subFields.push(`${plan.parent.field}{${plan.parent.idField} ${plan.parent.nameField}}`);
    }
    const link = `${plan.linkField}{${subFields.join(" ")}}`;
    const contactExtra = plan.linkField === "contact" ? "" : "contact{fullName}";
    return `nodes{id visualId createdAt total amountOutstanding status{id name}${contactExtra}${link}}pageInfo{hasNextPage endCursor}`;
  }

  // Fold one invoice into a per-customer accumulator, using the resolved plan.
  // Skips $0 invoices so dormant accounts with recent $0 records don't read as
  // active (documented BackBone gotcha).
  //
  // Revenue rule (paid-only): an invoice contributes its full `total` to revenue
  // ONLY when it is fully paid (amountOutstanding === 0). A partially-paid or
  // unpaid invoice contributes $0 to revenue. Invoice COUNT, by contrast, still
  // includes every real (non-$0) invoice regardless of payment status, so order
  // frequency / median-gap reflect actual order cadence rather than collection
  // timing. This is why total_revenue and invoice_count can legitimately diverge.
  function foldInvoice(acc, inv, plan) {
    const link = inv[plan.linkField];
    if (!link) return;

    // Prefer grouping by the PARENT company when the plan found one, so all of
    // a company's contacts collapse into a single roster row. Fall back to the
    // link's own id/name only if the parent is absent on this particular record.
    let id, companyName;
    if (plan.parent && link[plan.parent.field] && link[plan.parent.field][plan.parent.idField]) {
      const p = link[plan.parent.field];
      id = String(p[plan.parent.idField]);
      companyName = p[plan.parent.nameField] || null;
    } else if (link[plan.idField]) {
      id = String(link[plan.idField]);
      companyName =
        (plan.nameField && link[plan.nameField]) ||
        (plan.contactNameField && link[plan.contactNameField]) ||
        (inv.contact && inv.contact.fullName) ||
        "Unknown";
    } else {
      return; // no usable identity
    }
    if (!companyName) companyName = "Unknown";

    const amount = Number(inv.total) || 0;
    if (amount <= 0) return; // $0 filter

    // Fully-paid only: outstanding must be exactly 0 (within a cent, to absorb
    // floating-point noise) for the invoice's total to count as revenue.
    const outstanding = Number(inv.amountOutstanding);
    const isFullyPaid = Number.isFinite(outstanding) && outstanding < 0.005;
    const paidAmount = isFullyPaid ? amount : 0;

    const d = inv.createdAt ? inv.createdAt.slice(0, 10) : null;
    const year = d ? d.slice(0, 4) : null;

    if (!acc[id]) {
      acc[id] = {
        customer_id: id,
        company_name: companyName,
        invoice_count: 0,
        total_revenue: 0,
        revenue_by_year: {},   // paid-only revenue per calendar year
        invoices_by_year: {},  // invoice count per calendar year (all non-$0 invoices)
        last_invoice_date: null,
        _dates: [], // collected here, converted to median_gap_days at finalize
      };
    }
    const row = acc[id];
    row.invoice_count += 1;
    row.total_revenue += paidAmount;
    if (year) {
      row.invoices_by_year[year] = (row.invoices_by_year[year] || 0) + 1;
      if (paidAmount > 0) {
        row.revenue_by_year[year] = (row.revenue_by_year[year] || 0) + paidAmount;
      } else if (row.revenue_by_year[year] === undefined) {
        // Ensure the year key exists (as 0) if the customer had activity that year
        // but no paid revenue — keeps the dashboard year filter from treating the
        // year as "missing data" when it's really "$0 collected".
        row.revenue_by_year[year] = 0;
      }
    }
    if (d) {
      row._dates.push(d);
      if (!row.last_invoice_date || d > row.last_invoice_date) row.last_invoice_date = d;
    }
    if ((!row.company_name || row.company_name === "Unknown") && companyName !== "Unknown") {
      row.company_name = companyName;
    }
  }

  // Convert each customer's collected invoice dates into median_gap_days: the
  // median number of days between consecutive orders. This is the same quantity
  // Apparelytics' reorder-cadence report provides, so the Scorecard's Order
  // Frequency criterion auto-computes from it exactly as before — no paste.
  //
  // Convention (matches the Scorecard's starForFrequency): a customer with
  // fewer than 2 distinct order dates has no meaningful gap, and same-day
  // clustering that yields a 0 median is a data artifact, not high-frequency —
  // both are left as null so the criterion reads "unavailable" rather than
  // silently scoring 5 stars. The dropdown-editable manual field still wins
  // when a human has set one (merge logic preserves enrichment separately).
  function finalizeMedianGaps(acc) {
    Object.values(acc).forEach(row => {
      const dates = row._dates || [];
      delete row._dates;
      // Unique day-level timestamps, ascending.
      const uniq = Array.from(new Set(dates)).sort();
      if (uniq.length < 2) { row.median_gap_days = null; return; }
      const gaps = [];
      for (let i = 1; i < uniq.length; i++) {
        const a = new Date(uniq[i - 1] + "T00:00:00Z").getTime();
        const b = new Date(uniq[i] + "T00:00:00Z").getTime();
        gaps.push((b - a) / 86400000);
      }
      gaps.sort((x, y) => x - y);
      const mid = Math.floor(gaps.length / 2);
      const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
      // A 0 median (all orders same day, or fewer than 2 distinct days after
      // dedupe) is treated as unavailable per the documented gotcha.
      row.median_gap_days = median > 0 ? Math.round(median * 1000) / 1000 : null;
    });
  }

  // Merge freshly-aggregated Printavo rows into state.synced.
  //  - Protected (LEAD-/prospect) rows are preserved untouched.
  //  - For reconcile: real Printavo customers are fully replaced by rebuilt totals.
  //  - For incremental: existing customer totals are ADDED to; new customers appended.
  function mergeIntoSynced(existingSynced, aggregated, { replace }) {
    const protectedRows = existingSynced.filter(isProtectedRow);
    const realRows = existingSynced.filter(r => !isProtectedRow(r));
    const prevById = {};
    realRows.forEach(r => { prevById[String(r.customer_id)] = r; });

    // On a reconcile (replace) pass we REBUILD the real-customer set from
    // scratch: start empty and add only what this run produced. Any old
    // non-protected row the run didn't touch is dropped — this purges stale
    // rows left over from the earlier contact-keyed grouping, and self-heals
    // going forward. On incremental we start from the existing set and layer
    // deltas on top, so nothing is dropped.
    const byId = replace ? {} : { ...prevById };

    Object.values(aggregated).forEach(agg => {
      const id = String(agg.customer_id);
      const prev = prevById[id]; // prior row for THIS id, if any (for field inheritance)
      // Strip any scratch field that shouldn't be persisted.
      const cleanAgg = { ...agg };
      delete cleanAgg._dates;
      if (!byId[id] || replace) {
        // Reconcile, or brand-new customer: take the aggregate, inheriting a
        // few durable fields from the prior row for the same id when present,
        // but don't let a freshly-null median_gap_days (single-order customer)
        // wipe a previously-good value a human or earlier paste supplied.
        const merged = { ...(prev || {}), ...cleanAgg };
        if ((cleanAgg.median_gap_days == null) && prev && prev.median_gap_days != null) {
          merged.median_gap_days = prev.median_gap_days;
        }
        byId[id] = merged;
      } else {
        // Incremental: add the delta onto the running totals. Median gap is NOT
        // recomputed here (a partial recent slice would be misleading) — the
        // nightly reconcile owns that. Carry the existing value forward.
        //
        // Paid-revenue caveat: incremental pulls invoices by createdAt high-water
        // mark, so a payment that CLEARS an older invoice (created before the
        // window) is not re-seen here and its revenue won't appear until the
        // nightly reconcile rebuilds from scratch. Reconcile is the source of
        // truth for paid revenue; incremental keeps it approximately fresh.
        const cur = byId[id];
        // Merge per-year buckets additively (delta counts/revenue land in their year).
        const mergedRevByYear = { ...(cur.revenue_by_year || {}) };
        Object.keys(cleanAgg.revenue_by_year || {}).forEach(y => {
          mergedRevByYear[y] = (Number(mergedRevByYear[y]) || 0) + (Number(cleanAgg.revenue_by_year[y]) || 0);
        });
        const mergedInvByYear = { ...(cur.invoices_by_year || {}) };
        Object.keys(cleanAgg.invoices_by_year || {}).forEach(y => {
          mergedInvByYear[y] = (Number(mergedInvByYear[y]) || 0) + (Number(cleanAgg.invoices_by_year[y]) || 0);
        });
        byId[id] = {
          ...cur,
          company_name: cleanAgg.company_name && cleanAgg.company_name !== "Unknown" ? cleanAgg.company_name : cur.company_name,
          invoice_count: (Number(cur.invoice_count) || 0) + cleanAgg.invoice_count,
          total_revenue: (Number(cur.total_revenue) || 0) + cleanAgg.total_revenue,
          revenue_by_year: mergedRevByYear,
          invoices_by_year: mergedInvByYear,
          last_invoice_date: cleanAgg.last_invoice_date && (!cur.last_invoice_date || cleanAgg.last_invoice_date > cur.last_invoice_date)
            ? cleanAgg.last_invoice_date : cur.last_invoice_date,
        };
      }
    });

    return [...protectedRows, ...Object.values(byId)];
  }

  try {
    const stateKey = "backbone_data";

    // Resolve the schema plan once per invocation. This is 2-3 tiny
    // introspection queries; cheap, and it makes the sync immune to the
    // field-name guessing that broke the earlier version.
    const plan = await introspectInvoicePlan();
    if (!plan) {
      return res.status(500).json({
        error: "Could not find a client-linking field (customer/contact/owner with an id) on Printavo's Invoice type. Schema may have changed.",
      });
    }
    const GQL_FIELDS = buildFieldSelection(plan);

    // =====================================================================
    // PING — no data pull. Confirms which build is deployed and how the sync
    // resolved Printavo's schema. Hit /api/printavo-sync?mode=ping to check.
    // =====================================================================
    if (mode === "ping") {
      return res.status(200).json({
        ok: true,
        mode: "ping",
        buildVersion: "paid-only-yearbuckets-v2",
        paidRule: "amountOutstanding === 0 (fully-paid only)",
        fetchesAmountOutstanding: /amountOutstanding/.test(GQL_FIELDS),
        schema: { groupedBy: plan.parent ? (plan.linkField + "." + plan.parent.field) : plan.linkField, companyNameFrom: plan.parent ? plan.parent.nameField : plan.nameField, linkedType: plan.parent ? plan.parent.typeName : plan.linkedType, viaParent: !!plan.parent },
      });
    }

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
          foldInvoice(acc, inv, plan);
          if (inv.createdAt && (!newHighWater || inv.createdAt > newHighWater)) newHighWater = inv.createdAt;
        }
        cursor = data.invoices.pageInfo.hasNextPage ? data.invoices.pageInfo.endCursor : null;
        pages++;
        if (cursor) await new Promise(r => setTimeout(r, 1500));
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
        schema: { groupedBy: plan.parent ? (plan.linkField + "." + plan.parent.field) : plan.linkField, companyNameFrom: plan.parent ? plan.parent.nameField : plan.nameField, linkedType: plan.parent ? plan.parent.typeName : plan.linkedType, viaParent: !!plan.parent },
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
          foldInvoice(acc, inv, plan);
        }
        cursor = data.invoices.pageInfo.hasNextPage ? data.invoices.pageInfo.endCursor : null;
        pages++;
        if (cursor) await new Promise(r => setTimeout(r, 1500));
      } while (cursor && Date.now() < deadline);

      await kvSet("backbone_reconcile_partial", { acc, seen: [...seen], updatedAt: new Date().toISOString() });

      if (cursor) {
        return res.status(200).json({
          ok: true, mode, status: "partial", pages, customersSoFar: Object.keys(acc).length,
          nextUrl: `/api/printavo-sync?mode=reconcile&cursor=${encodeURIComponent(cursor)}`,
        });
      }

      // Full pass complete — REPLACE real-customer aggregates authoritatively.
      // Compute median_gap_days now that we have each customer's FULL date set.
      finalizeMedianGaps(acc);
      const state = (await kvGet(stateKey)) || { synced: [], enrichment: {}, lastSynced: null };

      // Safety backup: this reconcile PURGES stale non-protected rows, so snapshot
      // the pre-purge state first. Recover with: copy backbone_data_backup back
      // over backbone_data in Upstash if a run ever drops something it shouldn't.
      const beforeCount = (state.synced || []).length;
      await kvSet("backbone_data_backup", { ...state, backupAt: new Date().toISOString() });

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

      const protectedCount = (state.synced || []).filter(isProtectedRow).length;

      // Per-year diagnostic so you can see exactly what the reconcile computed,
      // without opening Upstash. paidRevenue = fully-paid-only revenue booked to
      // each year; invoices = all non-$0 invoices in that year (paid or not).
      const yearDiag = {};
      Object.values(acc).forEach(function (r) {
        Object.keys(r.revenue_by_year || {}).forEach(function (y) {
          if (!yearDiag[y]) yearDiag[y] = { paidRevenue: 0, invoices: 0 };
          yearDiag[y].paidRevenue += Number(r.revenue_by_year[y]) || 0;
        });
        Object.keys(r.invoices_by_year || {}).forEach(function (y) {
          if (!yearDiag[y]) yearDiag[y] = { paidRevenue: 0, invoices: 0 };
          yearDiag[y].invoices += Number(r.invoices_by_year[y]) || 0;
        });
      });
      Object.keys(yearDiag).forEach(function (y) {
        yearDiag[y].paidRevenue = Math.round(yearDiag[y].paidRevenue * 100) / 100;
      });
      const totalPaid = Object.values(acc).reduce(function (s, r) { return s + (Number(r.total_revenue) || 0); }, 0);

      return res.status(200).json({
        ok: true, mode, status: "done", pages,
        customers: Object.keys(acc).length, rosterSize: synced.length, reconciledAt: nowIso,
        rosterBefore: beforeCount, rosterAfter: synced.length,
        purgedStaleRows: Math.max(0, beforeCount - synced.length),
        protectedRowsKept: protectedCount,
        backupKey: "backbone_data_backup",
        buildVersion: "paid-only-yearbuckets-v2",
        totalPaidRevenue: Math.round(totalPaid * 100) / 100,
        byYear: yearDiag,
        schema: { groupedBy: plan.parent ? (plan.linkField + "." + plan.parent.field) : plan.linkField, companyNameFrom: plan.parent ? plan.parent.nameField : plan.nameField, linkedType: plan.parent ? plan.parent.typeName : plan.linkedType, viaParent: !!plan.parent },
      });
    }

    return res.status(400).json({ error: "Invalid mode. Use: incremental, reconcile" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
