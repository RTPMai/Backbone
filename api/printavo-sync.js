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
  // Wildcard CORS removed. This endpoint can trigger a full reconcile — an expensive,
  // destructive rebuild of every customer aggregate. `Allow-Origin: *` meant any website
  // could fire it from a visitor's browser. There is no legitimate cross-origin caller.
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token   = process.env.PRINTAVO_API_TOKEN;
  const email   = process.env.PRINTAVO_EMAIL;
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const secret  = process.env.SYNC_SECRET;

  if (!token || !email)   return res.status(500).json({ error: "Missing Printavo credentials" });
  if (!kvUrl || !kvToken) return res.status(500).json({ error: "Missing Upstash env vars" });

  // Secret guard. A session cookie is no use here — cron can't send one — so this
  // endpoint authenticates with a shared secret instead.
  //
  // It now FAILS CLOSED. The old code only enforced the check "if (secret)", so with
  // SYNC_SECRET unset the endpoint was completely open: anyone who knew the URL could
  // trigger a full reconcile, hammer the Printavo rate limit, and rebuild your roster.
  // An unset secret is a misconfiguration, not permission to skip the check.
  if (!secret) {
    return res.status(500).json({
      error: "SYNC_SECRET is not set. Generate one (openssl rand -base64 32), add it in " +
             "Vercel > Environment Variables, redeploy, and pass it as ?secret= or the " +
             "x-sync-secret header. Refusing to run an unauthenticated sync."
    });
  }
  const provided = req.headers["x-sync-secret"] || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: "Unauthorized" });

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
    if (json.errors) {
      const msg = json.errors.map(e => e.message).join(", ");
      // Printavo occasionally returns a transient server-side timeout (e.g.
      // "Timeout on ...") on heavier queries. Treat it like a 429: back off and
      // retry the same query a few times before giving up, since these usually
      // succeed on a second attempt once the server is less loaded.
      if (/timeout/i.test(msg) && _attempt < 4) {
        const waitMs = Math.min(15000, 2000 * Math.pow(2, _attempt)); // 2s,4s,8s,15s
        await new Promise(res => setTimeout(res, waitMs));
        return gql(query, _attempt + 1);
      }
      throw new Error(msg);
    }
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

  // Resolve a VALID sort field for the invoices query by introspecting the
  // OrderSortField enum. We can't hardcode one: CREATED_AT_DESC is NOT a valid
  // value (Printavo rejects it), and the enum's exact names aren't documented.
  // Returns { sortOn, desc } — desc indicates whether the chosen value already
  // means newest-first, so callers know the paging direction.
  async function resolveInvoiceSort() {
    let values = [];
    try {
      const data = await gql(`query{__type(name:"OrderSortField"){enumValues{name}}}`);
      values = ((data.__type && data.__type.enumValues) || []).map(v => v.name);
    } catch (e) {
      values = [];
    }
    const has = n => values.includes(n);
    // Prefer an explicit created/timestamp descending value; then any created;
    // then a generic timestamp/date; finally fall back to VISUAL_ID (always
    // present historically). We record whether the pick is inherently desc.
    const descCandidates = ["CREATED_AT_DESC", "CREATED_DESC", "TIMESTAMPS_DESC", "DATE_DESC", "UPDATED_AT_DESC"];
    for (const c of descCandidates) if (has(c)) return { sortOn: c, desc: true, source: "enum-desc", enumValues: values };
    const ascCandidates = ["CREATED_AT", "CREATED", "TIMESTAMPS", "DATE", "INVOICE_DATE"];
    for (const c of ascCandidates) if (has(c)) return { sortOn: c, desc: false, source: "enum-asc", enumValues: values };
    if (has("VISUAL_ID")) return { sortOn: "VISUAL_ID", desc: false, source: "fallback-visualid", enumValues: values };
    // If introspection returned nothing usable, use VISUAL_ID unqualified — it's
    // what the original code used and is accepted by the API.
    return { sortOn: "VISUAL_ID", desc: false, source: "default", enumValues: values };
  }

  // Introspect the argument names available on the Query.invoices field, so we
  // only pass filter args (like createdAfter) that actually exist — avoids the
  // same class of error as the invalid sortOn value.
  async function resolveInvoiceArgs() {
    try {
      // Grab arg names AND their type info so we can learn what paymentStatus accepts.
      const data = await gql(`query{__type(name:"Query"){fields{name args{name type{name kind ofType{name kind}}}}}}`);
      const fields = (data.__type && data.__type.fields) || [];
      const inv = fields.find(f => f.name === "invoices");
      const args = inv ? (inv.args || []) : [];
      const argNames = args.map(a => a.name);

      // Resolve the underlying type name of paymentStatus (unwrap NON_NULL/LIST).
      let paymentStatusType = null;
      const psArg = args.find(a => a.name === "paymentStatus");
      if (psArg && psArg.type) {
        paymentStatusType = psArg.type.name || (psArg.type.ofType && psArg.type.ofType.name) || null;
      }

      // If it's an enum, fetch its allowed values so we filter with a VALID one.
      let paymentStatusValues = [];
      if (paymentStatusType) {
        try {
          await rlPause();
          const ed = await gql(`query{__type(name:"${paymentStatusType}"){kind enumValues{name}}}`);
          if (ed.__type && ed.__type.enumValues) {
            paymentStatusValues = ed.__type.enumValues.map(v => v.name);
          }
        } catch (e) { /* leave empty */ }
      }

      return {
        hasCreatedAfter: argNames.includes("createdAfter"),
        hasInProductionAfter: argNames.includes("inProductionAfter"),
        hasInProductionBefore: argNames.includes("inProductionBefore"),
        hasPaymentStatus: argNames.includes("paymentStatus"),
        hasSortDescending: argNames.includes("sortDescending"),
        paymentStatusType,
        paymentStatusValues,
        argNames,
      };
    } catch (e) {
      return { hasCreatedAfter: false, hasInProductionAfter: false, hasInProductionBefore: false, hasPaymentStatus: false, hasSortDescending: false, paymentStatusType: null, paymentStatusValues: [], argNames: [] };
    }
  }

  // Fold one invoice into a per-customer accumulator.
  //
  // Two-pass reconcile model:
  //   mode "revenue" — invoice came from a paymentStatus:PAID query, so its full
  //                    total is booked as paid revenue. Does NOT touch counts.
  //   mode "count"   — invoice came from an unfiltered (all-status) query, so it
  //                    contributes to invoice_count / per-year counts / cadence
  //                    dates. Does NOT touch revenue.
  //   mode "both"    — legacy single-pass (incremental): infer paid from
  //                    amountOutstanding and do revenue + counts together.
  //
  // bucketYear: the calendar year to attribute this invoice to. During a
  // year-windowed reconcile we pass the WINDOW year (from inProductionAfter/Before)
  // so revenue and counts land in the same year regardless of which date field
  // Printavo exposes. When null, falls back to the invoice's createdAt year.
  function foldInvoice(acc, inv, plan, mode, bucketYear) {
    mode = mode || "both";
    const link = inv[plan.linkField];
    if (!link) return;

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

    const d = inv.createdAt ? inv.createdAt.slice(0, 10) : null;
    const year = bucketYear || (d ? d.slice(0, 4) : null);

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

    // Company name can be filled in by either pass.
    if ((!row.company_name || row.company_name === "Unknown") && companyName !== "Unknown") {
      row.company_name = companyName;
    }

    if (mode === "revenue" || (mode === "both" && isPaidInvoice(inv))) {
      const paid = amount;
      row.total_revenue += paid;
      if (year) row.revenue_by_year[year] = (row.revenue_by_year[year] || 0) + paid;
    }
    if (mode === "both" && !isPaidInvoice(inv) && year && row.revenue_by_year[year] === undefined) {
      // keep the year key present (as 0) so the dashboard doesn't read it as "missing"
      row.revenue_by_year[year] = 0;
    }

    if (mode === "count" || mode === "both") {
      row.invoice_count += 1;
      if (year) {
        row.invoices_by_year[year] = (row.invoices_by_year[year] || 0) + 1;
        if (row.revenue_by_year[year] === undefined) row.revenue_by_year[year] = 0;
      }
      if (d) {
        row._dates.push(d);
        if (!row.last_invoice_date || d > row.last_invoice_date) row.last_invoice_date = d;
      }
    }
  }

  // Fully-paid check for single-pass ("both") mode: outstanding within a cent of 0.
  function isPaidInvoice(inv) {
    const outstanding = Number(inv.amountOutstanding);
    return Number.isFinite(outstanding) && outstanding < 0.005;
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
    const sortPlan = await resolveInvoiceSort();
    const argPlan = await resolveInvoiceArgs();

    // =====================================================================
    // PING — no data pull. Confirms which build is deployed and how the sync
    // resolved Printavo's schema. Hit /api/printavo-sync?mode=ping to check.
    // =====================================================================
    if (mode === "ping") {
      return res.status(200).json({
        ok: true,
        mode: "ping",
        buildVersion: "paid-yearwindow-v7",
        paidRule: "paymentStatus:PAID per-year window (fully-paid only)",
        fetchesAmountOutstanding: /amountOutstanding/.test(GQL_FIELDS),
        sort: { sortOn: sortPlan.sortOn, desc: sortPlan.desc, source: sortPlan.source },
        orderSortFieldValues: sortPlan.enumValues,
        invoiceArgs: argPlan.argNames,
        paymentStatus: { type: argPlan.paymentStatusType, values: argPlan.paymentStatusValues, usable: argPlan.hasPaymentStatus },
        dateFilters: { inProductionAfter: argPlan.hasInProductionAfter, inProductionBefore: argPlan.hasInProductionBefore },
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
        // Build the date filter from a verified argument only. createdAfter is
        // preferred; inProductionAfter is the documented-working fallback; if
        // neither exists we omit the bound and rely on id dedupe + high-water.
        let dateArg = "";
        if (argPlan.hasCreatedAfter) dateArg = `,createdAfter:"${overlapIso}"`;
        else if (argPlan.hasInProductionAfter) dateArg = `,inProductionAfter:"${overlapIso}"`;
        const descI = argPlan.hasSortDescending ? ",sortDescending:true" : "";
        const data = await gql(
          `query{invoices(first:25,sortOn:${sortPlan.sortOn}${descI}${dateArg}${after}){${GQL_FIELDS}}}`
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
      // Year-windowed two-pass reconcile. Instead of paging the entire invoice
      // list by an ID and hoping pagination reaches the newest records (which
      // silently dropped 2026), we query each YEAR explicitly via inProduction
      // After/Before. Every year is therefore guaranteed to be visited.
      //
      // Two passes per year:
      //   PAID pass  (paymentStatus:PAID) → authoritative paid revenue
      //   ALL pass   (no status filter)   → invoice counts + cadence (incl. unpaid)
      //
      // Resume state tracks acc, seen sets (separate per pass so an invoice can be
      // folded once for revenue and once for counts), the year index, and the pass.
      const CURRENT_YEAR = new Date().getFullYear();
      const START_YEAR = 2018; // safely older than any P&M Printavo history
      const YEARS = [];
      for (let y = CURRENT_YEAR; y >= START_YEAR; y--) YEARS.push(y);

      let partial = await kvGet("backbone_reconcile_partial");
      // Resume rules:
      //  - ?reset=1 forces a fresh rebuild from year 0.
      //  - Otherwise, resume an existing partial as long as it's recent (< 30 min).
      //    This means that after a mid-run timeout you can just hit reconcile again
      //    and it continues from where it stopped — no cursor needed in the URL,
      //    no lost progress across the auto-looping UI or a manual retry.
      //  - A stale/absent partial starts fresh.
      const RESUME_WINDOW_MS = 30 * 60 * 1000;
      const partialFresh = partial && partial.updatedAt &&
        (Date.now() - new Date(partial.updatedAt).getTime() < RESUME_WINDOW_MS);
      if (req.query.reset === "1" || !partialFresh) partial = null;
      if (!partial) partial = { acc: {}, seenPaid: [], seenAll: [], yearIdx: 0, pass: "paid" };
      const acc = partial.acc || {};
      const seenPaid = new Set(partial.seenPaid || []);
      const seenAll = new Set(partial.seenAll || []);
      let yearIdx = partial.yearIdx || 0;
      let pass = partial.pass || "paid";
      let cursor = resumeCursor || partial.cursor || null;

      let pages = 0;
      const deadline = Date.now() + 240000;
      const canWindow = argPlan.hasInProductionAfter && argPlan.hasInProductionBefore;
      const canPaid = argPlan.hasPaymentStatus && argPlan.paymentStatusValues.includes("PAID");

      // Year-windowing REQUIRES the inProduction date args. Without them, querying
      // per-year would fold the entire unfiltered list into every year's bucket
      // (bucketYear is forced), badly corrupting the breakdown. Refuse rather than
      // silently produce garbage — this shouldn't happen (ping confirmed the args)
      // but a schema change must fail loud, not quiet.
      if (!canWindow) {
        return res.status(500).json({
          error: "Reconcile needs inProductionAfter/inProductionBefore args on the invoices query, which are missing from the current Printavo schema. Check /api/printavo-sync?mode=ping (dateFilters).",
        });
      }

      // Walk (year, pass) cells until we run out of time or finish all years.
      outer:
      while (yearIdx < YEARS.length) {
        if (Date.now() >= deadline) break; // out of time between cells; resume later
        const year = YEARS[yearIdx];
        const from = `${year}-01-01T00:00:00Z`;
        const to = `${year + 1}-01-01T00:00:00Z`;
        const windowArg = canWindow ? `,inProductionAfter:"${from}",inProductionBefore:"${to}"` : "";
        const statusArg = (pass === "paid" && canPaid) ? `,paymentStatus:PAID` : "";
        const seen = pass === "paid" ? seenPaid : seenAll;
        const foldMode = pass === "paid" ? "revenue" : "count";

        do {
          const after = cursor ? `,after:"${cursor}"` : "";
          // Keep this query lean. Printavo returned "Timeout on ..." on the
          // heavier first:25 + sortOn form, so within a one-year window we use a
          // smaller page and drop sortOn entirely — ordering is irrelevant to
          // completeness here (we page the whole window), and omitting the sort
          // makes the query cheaper for the server to resolve.
          const qstr = `query{invoices(first:15${statusArg}${windowArg}${after}){${GQL_FIELDS}}}`;
          let data;
          try {
            data = await gql(qstr);
          } catch (qe) {
            // Surface exactly which cell/query Printavo choked on, plus progress so
            // far, instead of a bare message. Progress is already persisted below on
            // the happy path; persist here too so a retry can resume, not restart.
            await kvSet("backbone_reconcile_partial", {
              acc, seenPaid: [...seenPaid], seenAll: [...seenAll],
              yearIdx, pass, cursor: cursor || null, updatedAt: new Date().toISOString(),
            });
            return res.status(500).json({
              error: (qe && qe.message) || "query failed",
              failedAt: { year, pass, hasCursor: !!cursor, pageSize: 15, usedPaymentStatus: !!statusArg },
              customersSoFar: Object.keys(acc).length,
              hint: "Progress saved. Re-run reconcile to resume from this point.",
            });
          }
          for (const inv of data.invoices.nodes) {
            if (seen.has(inv.id)) continue;
            seen.add(inv.id);
            foldInvoice(acc, inv, plan, foldMode, String(year));
          }
          cursor = data.invoices.pageInfo.hasNextPage ? data.invoices.pageInfo.endCursor : null;
          pages++;
          if (cursor) await new Promise(r => setTimeout(r, 1200));
          if (Date.now() >= deadline) break outer;
        } while (cursor);

        // This (year, pass) cell is done. Advance: paid → all, then next year.
        cursor = null;
        if (pass === "paid" && canPaid) {
          pass = "all";
        } else {
          pass = "paid";
          yearIdx++;
        }
      }

      const finished = yearIdx >= YEARS.length;

      // Persist progress (whether finished or resuming), including the in-window
      // cursor so a resume continues mid-year rather than restarting the year.
      await kvSet("backbone_reconcile_partial", {
        acc, seenPaid: [...seenPaid], seenAll: [...seenAll],
        yearIdx, pass, cursor: cursor || null, updatedAt: new Date().toISOString(),
      });

      if (!finished) {
        const curYear = YEARS[yearIdx];
        return res.status(200).json({
          ok: true, mode, status: "partial", pages,
          customersSoFar: Object.keys(acc).length,
          progress: { year: curYear, pass, cursor: cursor || null },
          // Resume reads the saved partial (incl. cursor) automatically, so the
          // URL just needs to re-trigger reconcile. No cursor/rstate needed.
          nextUrl: `/api/printavo-sync?mode=reconcile`,
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
        buildVersion: "paid-yearwindow-v7",
        totalPaidRevenue: Math.round(totalPaid * 100) / 100,
        byYear: yearDiag,
        schema: { groupedBy: plan.parent ? (plan.linkField + "." + plan.parent.field) : plan.linkField, companyNameFrom: plan.parent ? plan.parent.nameField : plan.nameField, linkedType: plan.parent ? plan.parent.typeName : plan.linkedType, viaParent: !!plan.parent },
      });
    }

    // =====================================================================
    // OPS — quote/invoice operational slice for the Dashboard.
    //
    // Writes a SEPARATE key (backbone_printavo_ops) so it can never corrupt the
    // roster aggregates in backbone_data. Captures the four Printavo-native
    // dashboard metrics that customer-level reconcile can't:
    //   1. outstanding      — open invoices with amountOutstanding > 0
    //   2. quotesThisWeek   — quotes created in the last 7 days
    //   3. artDeclinedYtd   — count of quotes whose status is "Art Declined", this year
    //   4. amWorkload        — every open quote bucketed into Quotes / In-Progress /
    //                          On-Hold by status name, mapped to owning customer_id
    //                          (the frontend joins that to an AM via enrichment)
    //   5. salesByMonth      — paid invoice revenue per month, current year (YTD-vs-goal chart)
    //
    // Like the rest of this file, it introspects the `quotes` query rather than
    // guessing field/arg names — the quotes type is not identical to invoices.
    // =====================================================================
    if (mode === "ops") {
      // The 22 workload statuses, grouped. Compared case-insensitively and with
      // punctuation/whitespace normalized, because Printavo status strings carry
      // emoji, stray spaces, and inconsistent hyphenation ("REVISED ART- APPROVAL").
      const WORKLOAD_STATUS_GROUPS = {
        quotes: [
          "QUOTE",
          "QUOTE APPROVAL SENT",
          "QUOTE APPROVAL SENT - MANUALLY",
          "QUOTE APPROVAL SENT - 2ND ATTEMPT",
          "REVISED - QUOTE APPROVAL SENT",
          "REMIND ME",
          "REMIND THEM",
          "QUOTE DECLINED",
        ],
        inProgress: [
          "QUOTE APPROVED - AWAITING 50% DEPOSIT",
          "QUOTE APPROVED - DEPOSIT PAID OR TERMS",
          "ART START",
          "ART APPROVAL SENT",
          "ART DECLINED",
          "REVISED ART- APPROVAL SENT",
          "ART APPROVAL SENT - MANUALLY",
          "SENT TO DIGITIZING",
          "ART APPROVED",
          "READY TO ORDER",
        ],
        onHold: [
          "ORDER ON HOLD (INTERNAL ISSUE)",
          "ORDER ON HOLD (EXTERNAL ISSUE)",
          "ORDER ON HOLD - SAMPLES OUT",
          "ORDER ON HOLD (CLC)",
        ],
      };
      const ART_DECLINED_STATUS = "ART DECLINED";

      // Normalize a status name for matching: strip emoji/symbols, collapse
      // whitespace, uppercase. "🎨 ART APPROVAL SENT 🎨" -> "ART APPROVAL SENT".
      function normStatus(s) {
        return String(s || "")
          .replace(/[^\x00-\x7F]/g, " ")     // drop non-ASCII (emoji)
          .replace(/[\s\-]+/g, " ")           // collapse whitespace + hyphens to single space
          .replace(/[^A-Za-z0-9()%& ]/g, "")  // keep only meaningful chars
          .trim()
          .toUpperCase();
      }
      const normGroups = {};
      Object.keys(WORKLOAD_STATUS_GROUPS).forEach(function (g) {
        normGroups[g] = WORKLOAD_STATUS_GROUPS[g].map(normStatus);
      });
      const normArtDeclined = normStatus(ART_DECLINED_STATUS);
      function groupForStatus(name) {
        const n = normStatus(name);
        for (const g of Object.keys(normGroups)) {
          if (normGroups[g].indexOf(n) !== -1) return g;
        }
        return null;
      }

      // ---- introspect the quotes query (args + sort), mirroring the invoice path
      async function resolveQuotesMeta() {
        let argNames = [], sortVals = [];
        try {
          const data = await gql(`query{__type(name:"Query"){fields{name args{name}}}}`);
          const fields = (data.__type && data.__type.fields) || [];
          const q = fields.find(f => f.name === "quotes");
          argNames = q ? (q.args || []).map(a => a.name) : [];
        } catch (e) {}
        await rlPause();
        try {
          const sd = await gql(`query{__type(name:"QuoteSortField"){enumValues{name}}}`);
          sortVals = ((sd.__type && sd.__type.enumValues) || []).map(v => v.name);
        } catch (e) {}
        const has = n => sortVals.includes(n);
        let sortOn = null;
        for (const c of ["CREATED_AT_DESC","CREATED_DESC","TIMESTAMPS_DESC","DATE_DESC"]) if (has(c)) { sortOn = c; break; }
        if (!sortOn) for (const c of ["CREATED_AT","CREATED","TIMESTAMPS","DATE","VISUAL_ID"]) if (has(c)) { sortOn = c; break; }
        return {
          argNames,
          hasCreatedAfter: argNames.includes("createdAfter"),
          hasSortDescending: argNames.includes("sortDescending"),
          sortOn: sortOn || "VISUAL_ID",
        };
      }

      // Quotes link to a client the same way invoices do; reuse the resolved plan.
      function quoteFieldSelection() {
        const subFields = [plan.idField];
        if (plan.nameField) subFields.push(plan.nameField);
        if (plan.parent) subFields.push(`${plan.parent.field}{${plan.parent.idField} ${plan.parent.nameField}}`);
        const link = `${plan.linkField}{${subFields.join(" ")}}`;
        const contactExtra = plan.linkField === "contact" ? "" : "contact{fullName}";
        return `nodes{id visualId createdAt total status{id name}${contactExtra}${link}}pageInfo{hasNextPage endCursor}`;
      }
      function quoteCustomer(q) {
        const link = q[plan.linkField];
        if (!link) return { id: null, name: "Unknown" };
        if (plan.parent && link[plan.parent.field] && link[plan.parent.field][plan.parent.idField]) {
          const p = link[plan.parent.field];
          return { id: String(p[plan.parent.idField]), name: p[plan.parent.nameField] || "Unknown" };
        }
        if (link[plan.idField]) {
          return {
            id: String(link[plan.idField]),
            name: (plan.nameField && link[plan.nameField]) || (q.contact && q.contact.fullName) || "Unknown",
          };
        }
        return { id: null, name: "Unknown" };
      }

      const nowIso = new Date().toISOString();
      const yearStart = new Date().getFullYear() + "-01-01";
      const weekAgoIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

      const qMeta = await resolveQuotesMeta();
      const QUOTE_FIELDS = quoteFieldSelection();
      await rlPause();

      // Per-customer workload tally: { customer_id: { company, quotes, inProgress, onHold } }
      const workloadByCustomer = {};
      let quotesThisWeek = 0;
      let artDeclinedYtd = 0;
      let quotesScanned = 0;

      // Page quotes newest-first. We only need OPEN workload + recent + YTD art
      // declines, so we can stop once quotes get older than the current year AND
      // older than a week — anything past that can't contribute to any counter.
      let cursor = resumeCursor;
      let pages = 0;
      const deadline = Date.now() + 240000;
      const descQ = qMeta.hasSortDescending ? ",sortDescending:true" : "";
      let reachedOld = false;

      do {
        const after = cursor ? `,after:"${cursor}"` : "";
        const data = await gql(
          `query{quotes(first:25,sortOn:${qMeta.sortOn}${descQ}${after}){${QUOTE_FIELDS}}}`
        );
        const nodes = (data.quotes && data.quotes.nodes) || [];
        for (const q of nodes) {
          quotesScanned++;
          const statusName = q.status && q.status.name;
          const grp = groupForStatus(statusName);
          const created = q.createdAt || "";

          // Workload buckets: count every open quote regardless of age — an
          // on-hold order from last year is still on someone's plate today.
          if (grp) {
            const cust = quoteCustomer(q);
            const key = cust.id || "unassigned";
            if (!workloadByCustomer[key]) {
              workloadByCustomer[key] = { customer_id: cust.id, company_name: cust.name, quotes: 0, inProgress: 0, onHold: 0 };
            }
            workloadByCustomer[key][grp]++;
          }

          if (created && created >= weekAgoIso) quotesThisWeek++;
          if (created && created >= yearStart && normStatus(statusName) === normArtDeclined) artDeclinedYtd++;

          // Track whether we've paged past everything that could still matter.
          if (created && created < yearStart && created < weekAgoIso) reachedOld = true;
        }
        cursor = (data.quotes && data.quotes.pageInfo && data.quotes.pageInfo.hasNextPage)
          ? data.quotes.pageInfo.endCursor : null;
        pages++;
        // Stop early only if we're sorting newest-first AND have clearly reached
        // pre-year quotes — otherwise page the whole set to be safe.
        if (qMeta.hasSortDescending && reachedOld) cursor = null;
        if (cursor) await new Promise(r => setTimeout(r, 1200));
      } while (cursor && Date.now() < deadline);

      const quotesPartial = !!cursor;

      // ---- Outstanding invoices (amountOutstanding > 0) + sales-by-month (YTD paid)
      // Reuse the invoice field selection which already includes amountOutstanding.
      await rlPause();
      const outstanding = [];
      const salesByMonth = {}; // "YYYY-MM" -> paid revenue (current year)
      const curYear = String(new Date().getFullYear());
      let invCursor = null;
      let invPages = 0;
      const invDeadline = Date.now() + 120000;
      // Current-year invoices only: use inProductionAfter if available, else filter client-side.
      const ytdDateArg = argPlan.hasInProductionAfter ? `,inProductionAfter:"${yearStart}"` : "";
      const descI = argPlan.hasSortDescending ? ",sortDescending:true" : "";
      do {
        const after = invCursor ? `,after:"${invCursor}"` : "";
        const data = await gql(
          `query{invoices(first:25,sortOn:${sortPlan.sortOn}${descI}${ytdDateArg}${after}){${GQL_FIELDS}}}`
        );
        const nodes = (data.invoices && data.invoices.nodes) || [];
        for (const inv of nodes) {
          const created = inv.createdAt || "";
          const out = Number(inv.amountOutstanding) || 0;
          const total = Number(inv.total) || 0;
          if (out > 0.009) {
            const cust = quoteCustomer(inv); // same link shape as quotes
            outstanding.push({
              id: inv.id,
              visualId: inv.visualId || null,
              company_name: cust.name,
              customer_id: cust.id,
              amount: Math.round(out * 100) / 100,
              total: Math.round(total * 100) / 100,
              status: inv.status && inv.status.name,
              createdAt: created || null,
            });
          }
          // Sales-by-month: paid portion (total - outstanding) booked to createdAt month, this year.
          if (created && created.slice(0, 4) === curYear) {
            const paid = Math.max(0, total - out);
            if (paid > 0) {
              const mk = created.slice(0, 7);
              salesByMonth[mk] = (salesByMonth[mk] || 0) + paid;
            }
          }
        }
        invCursor = (data.invoices && data.invoices.pageInfo && data.invoices.pageInfo.hasNextPage)
          ? data.invoices.pageInfo.endCursor : null;
        invPages++;
        if (invCursor) await new Promise(r => setTimeout(r, 1200));
      } while (invCursor && Date.now() < invDeadline);

      Object.keys(salesByMonth).forEach(function (m) {
        salesByMonth[m] = Math.round(salesByMonth[m] * 100) / 100;
      });
      outstanding.sort(function (a, b) { return b.amount - a.amount; });
      const outstandingTotal = outstanding.reduce(function (s, r) { return s + r.amount; }, 0);

      const opsPayload = {
        generatedAt: nowIso,
        buildVersion: "ops-v1",
        quotesThisWeek,
        artDeclinedYtd,
        outstanding,
        outstandingTotal: Math.round(outstandingTotal * 100) / 100,
        salesByMonth,
        workload: Object.values(workloadByCustomer),
        statusGroups: WORKLOAD_STATUS_GROUPS,
        diagnostics: {
          quotesScanned, quotePages: pages, invoicePages: invPages,
          quotesPartial, invoicePartial: !!invCursor,
          quotesSort: qMeta.sortOn, quotesHasDesc: qMeta.hasSortDescending,
        },
      };

      await kvSet("backbone_printavo_ops", opsPayload);

      return res.status(200).json({
        ok: true, mode: "ops", status: (quotesPartial || invCursor) ? "partial" : "done",
        quotesThisWeek, artDeclinedYtd,
        outstandingCount: outstanding.length,
        outstandingTotal: opsPayload.outstandingTotal,
        workloadCustomers: opsPayload.workload.length,
        salesMonths: Object.keys(salesByMonth).length,
        diagnostics: opsPayload.diagnostics,
        nextUrl: quotesPartial ? `/api/printavo-sync?mode=ops&cursor=${encodeURIComponent(cursor)}` : null,
      });
    }

    return res.status(400).json({ error: "Invalid mode. Use: incremental, reconcile, ops" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
