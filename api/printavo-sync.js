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
        // Populated below (outside this loop) once we know which type is the Contact.
        contactFields: null,
        lineItems: null,
      };
    }

    // Nothing matched — signal caller to error clearly rather than silently
    // producing an empty roster.
    return null;
  }

  // Second-stage introspection: given a resolved link plan, discover the fields
  // needed for (a) the buying contact's reachability and (b) the product-category
  // mix. Kept separate from the link discovery so a failure here degrades to
  // "no contact/category data" rather than breaking the whole sync. Mutates and
  // returns the plan.
  async function enrichPlanWithContactAndItems(plan) {
    if (!plan) return plan;

    async function fieldsOf(typeName) {
      if (!typeName) return {};
      try {
        const td = await gql(`query{__type(name:"${typeName}"){fields{name type{name kind ofType{name kind ofType{name kind ofType{name kind ofType{name kind}}}}}}}}`);
        const map = {};
        function unwrapType(t) {
          // Climb the ofType chain to the innermost named type; note if a LIST is present.
          let cur = t, nm = null, kd = null, isList = false, depth = 0;
          while (cur && depth < 6) {
            if (cur.kind === "LIST") isList = true;
            if (cur.name) { nm = cur.name; kd = cur.kind; }
            cur = cur.ofType; depth++;
          }
          return { typeName: nm, kind: kd, isList };
        }
        ((td.__type && td.__type.fields) || []).forEach(f => {
          map[f.name] = unwrapType(f.type || {});
        });
        return map;
      } catch (e) { return {}; }
    }
    function has(m) { const o = {}; Object.keys(m).forEach(k => o[k] = true); return o; }
    function pickEmail(s){ return s.email?"email":s.emailAddress?"emailAddress":null; }
    function pickPhone(s){ return s.phone?"phone":s.phoneNumber?"phoneNumber":s.phoneNumberFull?"phoneNumberFull":s.mobile?"mobile":null; }
    function pickTitle(s){ return s.title?"title":s.jobTitle?"jobTitle":s.role?"role":null; }
    function pickFullName(s){ return s.fullName?"fullName":null; }
    function pickFirst(s){ return s.firstName?"firstName":null; }
    function pickLast(s){ return s.lastName?"lastName":null; }

    // --- Contact reachability ---
    // The contact type is either the link itself (linkField === "contact") or the
    // invoice's separate `contact{...}` object. Introspect whichever applies.
    try {
      await rlPause();
      let contactTypeName = null;
      if (plan.linkField === "contact") {
        contactTypeName = plan.linkedType;
      } else {
        // Find the type of Invoice.contact.
        const invFields = await fieldsOf("Invoice");
        const cm = invFields.contact;
        if (cm && cm.kind === "OBJECT" && cm.typeName) contactTypeName = cm.typeName;
      }
      if (contactTypeName) {
        await rlPause();
        const cf = await fieldsOf(contactTypeName);
        const s = has(cf);
        plan.contactFields = {
          typeName: contactTypeName,
          fullName: pickFullName(s),
          firstName: pickFirst(s),
          lastName: pickLast(s),
          email: pickEmail(s),
          phone: pickPhone(s),
          title: pickTitle(s),
        };
      }
    } catch (e) { plan.contactFields = null; }

    // --- Product category mix (from invoice line items) ---
    // Discover Invoice.lineItems (a list of line-item objects) and which sub-field
    // carries the category/product name. Printavo schemas vary, so we probe a set
    // of likely names and store whichever exists.
    // --- Product category mix (from invoice line items) ---
    // Printavo's shape (confirmed via probe-lineitems):
    //   Invoice.lineItemGroups (Connection) -> nodes -> LineItemGroup
    //     .lineItems (Connection) -> nodes -> LineItem { category, product, ... }
    // So category mix lives two connections deep. We verify that chain exists (rather
    // than hardcoding blind) and record the field names for the query builder +
    // extractor. Falls back to a flatter shape if a future schema simplifies it.
    try {
      await rlPause();
      const invFields = await fieldsOf("Invoice");
      // Outer container: prefer lineItemGroups, else a direct lineItems.
      const groupsField = invFields.lineItemGroups ? "lineItemGroups"
                        : (invFields.lineItems ? "lineItems" : null);
      if (groupsField && invFields[groupsField] && invFields[groupsField].typeName) {
        const groupsConnType = invFields[groupsField].typeName;
        await rlPause();
        const groupsConn = await fieldsOf(groupsConnType);
        // Follow the connection's nodes to the element type.
        const groupNodeType = groupsConn.nodes ? groupsConn.nodes.typeName : null;

        // Resolve how to read category/product off a LineItem. Each may be a scalar
        // (select bare) or an object type (must select a name-ish sub-field, e.g.
        // category{ id name }). Printavo returns Category/Product OBJECTS, so we
        // introspect them and pick a label sub-field.
        async function resolveLeafRef(itemFields, fieldName) {
          const meta = itemFields[fieldName];
          if (!meta) return null;
          if (meta.kind !== "OBJECT" || !meta.typeName) {
            // Scalar — select bare, read directly.
            return { field: fieldName, sub: null };
          }
          // Object — find a name-like scalar sub-field to select.
          await rlPause();
          const sub = await fieldsOf(meta.typeName);
          const pick = sub.name ? "name" : (sub.title ? "title" : (sub.label ? "label" : (sub.description ? "description" : null)));
          if (!pick) return null;
          return { field: fieldName, sub: pick };
        }

        async function buildLeafPlan(itemType, outerField, innerField, innerIsConn) {
          await rlPause();
          const li = await fieldsOf(itemType);
          const cat = li.category ? await resolveLeafRef(li, "category") : null;
          const prod = li.product ? await resolveLeafRef(li, "product")
                     : (li.description ? { field: "description", sub: null } : null);
          if (!cat && !prod) return null;
          return {
            outer: outerField, outerIsConn: true,
            inner: innerField, innerIsConn: !!innerIsConn,
            cat, prod, // each: { field, sub } or null
          };
        }

        if (groupsField === "lineItems" && groupNodeType) {
          // Simple case: Invoice.lineItems -> nodes -> LineItem{category,product,...}
          plan.lineItems = await buildLeafPlan(groupNodeType, groupsField, null, false);
        } else if (groupNodeType) {
          // Nested case: group -> lineItems (connection) -> nodes -> LineItem
          await rlPause();
          const groupFields = await fieldsOf(groupNodeType);
          const innerField = groupFields.lineItems ? "lineItems"
                           : (groupFields.items ? "items" : null);
          if (innerField && groupFields[innerField] && groupFields[innerField].typeName) {
            await rlPause();
            const innerConn = await fieldsOf(groupFields[innerField].typeName);
            const itemType = innerConn.nodes ? innerConn.nodes.typeName : groupFields[innerField].typeName;
            if (itemType) {
              plan.lineItems = await buildLeafPlan(itemType, groupsField, innerField, !!innerConn.nodes);
            }
          }
        }
        // Only keep it if we actually found something to read.
        if (plan.lineItems && !plan.lineItems.cat && !plan.lineItems.prod) {
          plan.lineItems = null;
        }
      }
    } catch (e) { plan.lineItems = null; }

    return plan;
  }

  // Build the GraphQL node selection string from a resolved plan.
  function buildFieldSelection(plan) {
    const subFields = [plan.idField];
    if (plan.nameField) subFields.push(plan.nameField);
    if (plan.contactNameField && plan.contactNameField !== plan.nameField) subFields.push(plan.contactNameField);

    // Build the reachability selection for a contact-like object (email/phone/title
    // and a usable name), using only the fields introspection confirmed exist.
    function contactSel(cf) {
      if (!cf) return "";
      const parts = [];
      if (cf.fullName) parts.push(cf.fullName);
      if (cf.firstName) parts.push(cf.firstName);
      if (cf.lastName) parts.push(cf.lastName);
      if (cf.email) parts.push(cf.email);
      if (cf.phone) parts.push(cf.phone);
      if (cf.title) parts.push(cf.title);
      return parts.join(" ");
    }

    // If we found a parent company through the link, request it nested so we
    // can group by the company rather than the individual contact.
    if (plan.parent) {
      subFields.push(`${plan.parent.field}{${plan.parent.idField} ${plan.parent.nameField}}`);
    }
    // When the LINK itself is the contact, fold reachability fields into its selection.
    if (plan.linkField === "contact" && plan.contactFields) {
      const extra = contactSel(plan.contactFields);
      if (extra) extra.split(" ").forEach(f => { if (subFields.indexOf(f) === -1) subFields.push(f); });
    }
    const link = `${plan.linkField}{${subFields.join(" ")}}`;

    // Separate contact object on the invoice (when the link is a Customer, not a Contact).
    let contactExtra = "";
    if (plan.linkField !== "contact") {
      const sel = plan.contactFields ? contactSel(plan.contactFields) : "fullName";
      contactExtra = `contact{${sel}}`;
    }

    // Line items for product-category mix, if the shape was discovered.
    // Printavo nests connections AND category/product are OBJECT types. Each nested
    // connection multiplies Printavo's query-complexity score, and fetching BOTH
    // category and product blew past their 25k ceiling. Category is what the brief's
    // "what they normally order" actually uses (Screen Printing / Embroidery / Promo),
    // so we select ONLY category by default and fall back to product just when there
    // is no category field at all. This keeps the query lean enough to page.
    let itemsExtra = "";
    if (plan.lineItems) {
      const li = plan.lineItems;
      function ref(r) { return r ? (r.sub ? `${r.field}{${r.sub}}` : r.field) : null; }
      const leafSel = ref(li.cat) || ref(li.prod); // category preferred; product only if no category
      if (leafSel) {
        if (li.inner) {
          const innerSel = li.innerIsConn ? `${li.inner}{nodes{${leafSel}}}` : `${li.inner}{${leafSel}}`;
          itemsExtra = li.outerIsConn ? `${li.outer}{nodes{${innerSel}}}` : `${li.outer}{${innerSel}}`;
        } else {
          itemsExtra = li.outerIsConn ? `${li.outer}{nodes{${leafSel}}}` : `${li.outer}{${leafSel}}`;
        }
      }
    }

    return `nodes{id visualId createdAt total amountOutstanding status{id name}${contactExtra}${itemsExtra}${link}}pageInfo{hasNextPage endCursor}`;
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

    // --- Contact reachability + product mix ---
    // Collected only on count/both passes (NOT the revenue/PAID pass), so a
    // two-pass reconcile doesn't double-count categories or duplicate contacts.
    // The count pass sees every non-$0 invoice, so nothing is missed.
    if (mode === "count" || mode === "both") {
      const cf = plan.contactFields;
      if (cf) {
        const src = (plan.linkField === "contact") ? link : (inv.contact || null);
        if (src) {
          const name = (cf.fullName && src[cf.fullName]) ||
            [cf.firstName && src[cf.firstName], cf.lastName && src[cf.lastName]].filter(Boolean).join(" ") || null;
          const email = (cf.email && src[cf.email]) || null;
          const phone = (cf.phone && src[cf.phone]) || null;
          const title = (cf.title && src[cf.title]) || null;
          if (name || email || phone) {
            if (!row._contacts) row._contacts = [];
            row._contacts.push({ name: name || null, email: email || null, phone: phone || null, title: title || null, date: d || null });
          }
        }
      }

      if (plan.lineItems) {
        const li = plan.lineItems;
        // Walk the (possibly doubly-nested) connection response to the leaf line items.
        //   inv[outer].nodes[] -> [inner].nodes[] -> { category, product }
        function connNodes(v) {
          if (!v) return [];
          if (Array.isArray(v)) return v;               // already a plain list
          if (Array.isArray(v.nodes)) return v.nodes;   // connection with nodes
          if (Array.isArray(v.edges)) return v.edges.map(e => e && e.node).filter(Boolean);
          return [];
        }
        function readRef(leaf, r) {
          if (!r) return null;
          const v = leaf[r.field];
          if (v == null) return null;
          if (r.sub) return (v && typeof v === "object") ? v[r.sub] : null;
          // scalar
          return (typeof v === "object") ? (v.name || v.description || null) : v;
        }
        function bump(leaf) {
          if (!leaf) return;
          let cat = readRef(leaf, li.cat) || readRef(leaf, li.prod);
          if (!cat) return;
          cat = String(cat).trim();
          if (!cat) return;
          if (!row._categories) row._categories = {};
          row._categories[cat] = (row._categories[cat] || 0) + 1;
        }
        const outerNodes = connNodes(inv[li.outer]);
        outerNodes.forEach(g => {
          if (li.inner) {
            connNodes(g[li.inner]).forEach(bump);
          } else {
            bump(g);
          }
        });
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

  // Resolve collected contacts + category counts into the persisted shape.
  // Contacts: dedupe by email (falling back to lowercased name), keep the sighting
  // with the most detail, tag each with the most recent invoice date it appeared on
  // and how many invoices it appeared on, then sort most-recent-first. The first is
  // marked primary. Categories: top 8 by count. Runs on BOTH incremental and
  // reconcile so contact/category data stays fresh either way.
  function finalizeContactsAndCategories(acc) {
    Object.values(acc).forEach(row => {
      // --- contacts ---
      const raw = row._contacts || [];
      delete row._contacts;
      if (raw.length) {
        const byKey = {};
        raw.forEach(c => {
          const key = (c.email ? c.email.toLowerCase() : (c.name ? c.name.toLowerCase().trim() : null));
          if (!key) return;
          if (!byKey[key]) {
            byKey[key] = { name: c.name || null, email: c.email || null, phone: c.phone || null,
              title: c.title || null, last_seen: c.date || null, invoice_count: 1 };
          } else {
            const e = byKey[key];
            e.invoice_count += 1;
            // Fill in any missing detail from later sightings.
            if (!e.name && c.name) e.name = c.name;
            if (!e.email && c.email) e.email = c.email;
            if (!e.phone && c.phone) e.phone = c.phone;
            if (!e.title && c.title) e.title = c.title;
            if (c.date && (!e.last_seen || c.date > e.last_seen)) e.last_seen = c.date;
          }
        });
        const list = Object.values(byKey).sort((a, b) => {
          // Most recent first; ties broken by how often the contact appears.
          const da = a.last_seen || "", db = b.last_seen || "";
          if (da !== db) return db < da ? -1 : 1;
          return (b.invoice_count || 0) - (a.invoice_count || 0);
        });
        if (list.length) {
          row.contacts = list;
          row.primary_contact = list[0];
        }
      }

      // --- product category mix ---
      const cats = row._categories || null;
      delete row._categories;
      if (cats) {
        const top = Object.keys(cats).map(k => ({ name: k, count: cats[k] }))
          .sort((a, b) => b.count - a.count).slice(0, 8);
        if (top.length) row.top_categories = top;
      }
    });
  }

  // Union two contact lists (prior running set + this window's) by email/name,
  // summing invoice_count and keeping the most recent last_seen. Returns
  // { list (most-recent-first), primary }.
  function mergeContactLists(a, b) {
    const out = {};
    function key(c) { return c.email ? c.email.toLowerCase() : (c.name ? c.name.toLowerCase().trim() : null); }
    [a || [], b || []].forEach(list => {
      list.forEach(c => {
        const k = key(c);
        if (!k) return;
        if (!out[k]) {
          out[k] = { name: c.name || null, email: c.email || null, phone: c.phone || null,
            title: c.title || null, last_seen: c.last_seen || null, invoice_count: c.invoice_count || 1 };
        } else {
          const e = out[k];
          e.invoice_count += (c.invoice_count || 1);
          if (!e.name && c.name) e.name = c.name;
          if (!e.email && c.email) e.email = c.email;
          if (!e.phone && c.phone) e.phone = c.phone;
          if (!e.title && c.title) e.title = c.title;
          if (c.last_seen && (!e.last_seen || c.last_seen > e.last_seen)) e.last_seen = c.last_seen;
        }
      });
    });
    const list = Object.values(out).sort((x, y) => {
      const dx = x.last_seen || "", dy = y.last_seen || "";
      if (dx !== dy) return dy < dx ? -1 : 1;
      return (y.invoice_count || 0) - (x.invoice_count || 0);
    });
    return { list: list.length ? list : undefined, primary: list.length ? list[0] : undefined };
  }

  // Add two category-count lists together, keep top 8.
  function mergeCategoryLists(a, b) {
    if (!a && !b) return undefined;
    const m = {};
    (a || []).forEach(c => { m[c.name] = (m[c.name] || 0) + (c.count || 0); });
    (b || []).forEach(c => { m[c.name] = (m[c.name] || 0) + (c.count || 0); });
    const top = Object.keys(m).map(k => ({ name: k, count: m[k] })).sort((x, y) => y.count - x.count).slice(0, 8);
    return top.length ? top : undefined;
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
      delete cleanAgg._contacts;
      delete cleanAgg._categories;
      if (!byId[id] || replace) {
        // Reconcile, or brand-new customer: take the aggregate, inheriting a
        // few durable fields from the prior row for the same id when present,
        // but don't let a freshly-null median_gap_days (single-order customer)
        // wipe a previously-good value a human or earlier paste supplied.
        const merged = { ...(prev || {}), ...cleanAgg };
        if ((cleanAgg.median_gap_days == null) && prev && prev.median_gap_days != null) {
          merged.median_gap_days = prev.median_gap_days;
        }
        // On reconcile, the rebuilt aggregate is authoritative for contacts/categories.
        // On a brand-new incremental customer, cleanAgg already carries them. But if a
        // reconcile pass somehow produced none while a prior row had them, keep prior.
        if (!cleanAgg.contacts && prev && prev.contacts) { merged.contacts = prev.contacts; merged.primary_contact = prev.primary_contact; }
        if (!cleanAgg.top_categories && prev && prev.top_categories) merged.top_categories = prev.top_categories;
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

        // Contacts: union prior + new window by email/name, keeping the most-recent
        // primary. Categories: add the delta counts onto the running mix.
        const mergedContacts = mergeContactLists(cur.contacts, cleanAgg.contacts);
        const mergedCats = mergeCategoryLists(cur.top_categories, cleanAgg.top_categories);

        byId[id] = {
          ...cur,
          company_name: cleanAgg.company_name && cleanAgg.company_name !== "Unknown" ? cleanAgg.company_name : cur.company_name,
          invoice_count: (Number(cur.invoice_count) || 0) + cleanAgg.invoice_count,
          total_revenue: (Number(cur.total_revenue) || 0) + cleanAgg.total_revenue,
          revenue_by_year: mergedRevByYear,
          invoices_by_year: mergedInvByYear,
          last_invoice_date: cleanAgg.last_invoice_date && (!cur.last_invoice_date || cleanAgg.last_invoice_date > cur.last_invoice_date)
            ? cleanAgg.last_invoice_date : cur.last_invoice_date,
          contacts: mergedContacts.list,
          primary_contact: mergedContacts.primary,
          top_categories: mergedCats,
        };
      }
    });

    return [...protectedRows, ...Object.values(byId)];
  }

  try {
    const stateKey = "backbone_data";

    // Resolve the schema plan ONCE and cache it in Upstash. Reconcile is
    // resumable — Vercel re-invokes this function many times via nextUrl — and
    // re-running the full introspection (link discovery + contact/line-item
    // probes, each paced under the rate limit) on every resume added many seconds
    // of latency per call and could tip a page batch over Vercel's function
    // timeout (which surfaces as a non-JSON "A server error has occurred" page).
    // The schema doesn't change mid-run, so cache it with a short TTL.
    const PLAN_CACHE_KEY = "backbone_sync_plan";
    const forceFreshPlan = (mode === "ping" || mode === "refresh-plan");
    let plan = null;
    try {
      const cached = await kvGet(PLAN_CACHE_KEY);
      if (!forceFreshPlan && cached && cached.plan && cached.cachedAt && (Date.now() - cached.cachedAt) < 6 * 3600 * 1000) {
        plan = cached.plan;
      }
    } catch (e) { /* fall through to fresh introspection */ }

    if (!plan) {
      plan = await introspectInvoicePlan();
      if (!plan) {
        return res.status(500).json({
          error: "Could not find a client-linking field (customer/contact/owner with an id) on Printavo's Invoice type. Schema may have changed.",
        });
      }
      // Second-stage discovery for contact reachability + product-category mix.
      // Failures here degrade gracefully (no contact/category data) rather than
      // breaking the revenue sync.
      await enrichPlanWithContactAndItems(plan);
      try { await kvSet(PLAN_CACHE_KEY, { plan, cachedAt: Date.now() }); } catch (e) { /* non-fatal */ }
    }

    const GQL_FIELDS = buildFieldSelection(plan);
    // Printavo scores queries by complexity (max 25000). The nested line-item
    // selection (lineItemGroups>nodes>lineItems>nodes>category) multiplies the score,
    // so when it's present we page in smaller batches to stay under the ceiling.
    // Without line items the flat query is cheap and can page larger.
    const hasLineItems = /lineItemGroups|lineItems\{/.test(GQL_FIELDS);
    const RECONCILE_PAGE = hasLineItems ? 8 : 15;
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
        buildVersion: "contacts-categories-v8",
        paidRule: "paymentStatus:PAID per-year window (fully-paid only)",
        fetchesAmountOutstanding: /amountOutstanding/.test(GQL_FIELDS),
        sort: { sortOn: sortPlan.sortOn, desc: sortPlan.desc, source: sortPlan.source },
        orderSortFieldValues: sortPlan.enumValues,
        invoiceArgs: argPlan.argNames,
        paymentStatus: { type: argPlan.paymentStatusType, values: argPlan.paymentStatusValues, usable: argPlan.hasPaymentStatus },
        dateFilters: { inProductionAfter: argPlan.hasInProductionAfter, inProductionBefore: argPlan.hasInProductionBefore },
        schema: { groupedBy: plan.parent ? (plan.linkField + "." + plan.parent.field) : plan.linkField, companyNameFrom: plan.parent ? plan.parent.nameField : plan.nameField, linkedType: plan.parent ? plan.parent.typeName : plan.linkedType, viaParent: !!plan.parent },
        // v8: confirm contact reachability + product mix were discovered. If these
        // are null/absent, the schema didn't expose them under the probed names —
        // check the fieldSelection to see what's actually requested.
        contactDiscovery: plan.contactFields
          ? { type: plan.contactFields.typeName, name: plan.contactFields.fullName || plan.contactFields.firstName || null, email: plan.contactFields.email, phone: plan.contactFields.phone, title: plan.contactFields.title }
          : null,
        lineItemDiscovery: plan.lineItems || null,
        fieldSelection: GQL_FIELDS,
      });
    }

    // =====================================================================
    // REFRESH-PLAN — force fresh schema discovery and re-cache it. Use after a
    // deploy to confirm the plan resolved and prime the cache before a reconcile.
    // =====================================================================
    if (mode === "refresh-plan") {
      try { await kvSet(PLAN_CACHE_KEY, { plan, cachedAt: Date.now() }); } catch (e) { /* non-fatal */ }
      return res.status(200).json({
        ok: true,
        mode: "refresh-plan",
        cached: true,
        schema: { groupedBy: plan.parent ? (plan.linkField + "." + plan.parent.field) : plan.linkField, linkedType: plan.parent ? plan.parent.typeName : plan.linkedType, viaParent: !!plan.parent },
        contactDiscovery: plan.contactFields
          ? { type: plan.contactFields.typeName, name: plan.contactFields.fullName || plan.contactFields.firstName || null, email: plan.contactFields.email, phone: plan.contactFields.phone, title: plan.contactFields.title }
          : null,
        lineItemDiscovery: plan.lineItems || null,
        fieldSelection: GQL_FIELDS,
      });
    }

    // =====================================================================
    // PROBE-HISTORY — read-only schema probe. Answers one question: does Printavo
    // expose a per-quote status-change history with timestamps? That's the only way
    // to count "art declined N times THIS YEAR" (an event count) rather than
    // "N quotes are declined right now" (a snapshot). We DON'T guess field names —
    // we introspect the Quote type and report any timeline/history/activity/audit-
    // shaped fields we find, plus a peek at their sub-fields, so we can decide
    // whether a true YTD decline count is even buildable.
    // =====================================================================
    if (mode === "probe-history") {
      const out = { ok: true, mode: "probe-history", quoteTypeFound: false, candidates: [], statusFieldShape: null, notes: [] };

      // Fetch Quote type fields.
      let quoteFields = [];
      try {
        const d = await gql(`query{__type(name:"Quote"){fields{name type{name kind ofType{name kind ofType{name kind}}}}}}`);
        if (d.__type && d.__type.fields) { out.quoteTypeFound = true; quoteFields = d.__type.fields; }
      } catch (e) { out.notes.push("Quote introspection failed: " + e.message); }

      // Heuristic: field names that tend to carry status history / audit trails.
      const rx = /(histor|timeline|activit|event|log|audit|transition|change|status_?updates?)/i;
      function unwrap(t) {
        // climb ofType chain to the concrete named type
        let cur = t, name = null, kind = null, depth = 0;
        while (cur && depth < 5) { if (cur.name) { name = cur.name; kind = cur.kind; } cur = cur.ofType; depth++; }
        return { name, kind };
      }
      for (const f of quoteFields) {
        if (rx.test(f.name)) {
          const u = unwrap(f.type);
          out.candidates.push({ field: f.name, typeName: u.name, typeKind: u.kind });
        }
      }

      // For each candidate that resolves to an object/connection type, peek one level
      // in to see if it carries a status name + a timestamp (which is what we'd need).
      for (const c of out.candidates.slice(0, 4)) {
        if (!c.typeName) continue;
        try {
          await rlPause();
          const d = await gql(`query{__type(name:"${c.typeName}"){kind fields{name type{name kind ofType{name kind}}}}}`);
          if (d.__type) {
            const subs = (d.__type.fields || []).map(sf => sf.name);
            c.subFields = subs;
            c.looksUsable = /(status|state|name)/i.test(subs.join(" ")) &&
                            /(at|date|time|timestamp|created|changed|updated)/i.test(subs.join(" "));
            // Connections wrap real nodes in edges{node{...}} — note that so we know to dig further.
            if (subs.includes("nodes") || subs.includes("edges")) c.isConnection = true;
          }
        } catch (e) { c.probeError = e.message; }
      }

      // Also report the Quote.status field's own shape, in case history lives there.
      const statusField = quoteFields.find(f => f.name === "status");
      if (statusField) {
        const u = unwrap(statusField.type);
        out.statusFieldShape = { typeName: u.name, typeKind: u.kind };
      }

      if (!out.candidates.length) {
        out.notes.push("No history/timeline/activity-shaped fields on Quote. A true YTD decline COUNT likely isn't available from the quote schema; Option B (BackBone diffs snapshots over time) would be the fallback.");
      } else {
        out.notes.push("Candidate history fields found — check 'looksUsable' and 'subFields' to confirm one carries both a status and a timestamp before building the YTD count.");
      }
      return res.status(200).json(out);
    }


    // =====================================================================
    // PROBE-LINEITEMS — read-only. Finds what Printavo actually calls the invoice
    // line-item field and which sub-field carries the product/category, so we can
    // wire product mix. The v8 auto-probe guessed lineItems/lineItemGroups/items
    // and came back empty, so this reports the REAL names to plug in. Hit
    // /api/printavo-sync?mode=probe-lineitems
    // =====================================================================
    if (mode === "probe-lineitems") {
      const out = { ok: true, mode: "probe-lineitems", invoiceFields: [], candidates: [], notes: [] };

      function unwrap(t) {
        let cur = t, name = null, kind = null, isList = false, depth = 0;
        while (cur && depth < 6) {
          if (cur.kind === "LIST") isList = true;
          if (cur.name) { name = cur.name; kind = cur.kind; }
          cur = cur.ofType; depth++;
        }
        return { name, kind, isList };
      }

      // 1. List every field on Invoice, with its resolved type + whether it's a list.
      let invFields = [];
      try {
        const d = await gql(`query{__type(name:"Invoice"){fields{name type{name kind ofType{name kind ofType{name kind ofType{name kind}}}}}}}`);
        invFields = (d.__type && d.__type.fields) || [];
      } catch (e) { out.notes.push("Invoice introspection failed: " + e.message); return res.status(200).json(out); }

      // Heuristic: a line-item container is usually a LIST-typed field whose name
      // mentions item/line/product, OR any list of an object type worth inspecting.
      const nameRx = /(line ?item|lineitem|^items$|product|group)/i;
      invFields.forEach(f => {
        const u = unwrap(f.type);
        out.invoiceFields.push({ field: f.name, typeName: u.name, kind: u.kind, isList: u.isList });
        if ((u.isList && u.kind === "OBJECT") || (nameRx.test(f.name) && u.kind === "OBJECT")) {
          out.candidates.push({ field: f.name, typeName: u.name, isList: u.isList });
        }
      });

      // 2. For each candidate container, introspect its element type. Printavo wraps
      // line items in a Connection (edges/nodes/pageInfo), so if we hit one, follow
      // `nodes` into the real node type and report ITS fields. Then dig one nested
      // object level from the node (e.g. group -> style/product carrying the category).
      const catRx = /(categ|product|style|garment|color|item ?name|^name$|descrip|mockup|imprint|decor)/i;

      async function fieldsOf(typeName) {
        const d = await gql(`query{__type(name:"${typeName}"){fields{name type{name kind ofType{name kind ofType{name kind ofType{name kind ofType{name kind}}}}}}}}`);
        return (d.__type && d.__type.fields) || [];
      }

      for (const c of out.candidates.slice(0, 6)) {
        if (!c.typeName) continue;
        try {
          await rlPause();
          let fs = await fieldsOf(c.typeName);
          let names = fs.map(sf => sf.name);

          // Connection? Follow nodes (preferred) or edges.node into the element type.
          if (names.includes("nodes") || names.includes("edges")) {
            c.isConnection = true;
            const nodesField = fs.find(sf => sf.name === "nodes");
            let elemType = nodesField ? unwrap(nodesField.type).name : null;
            if (!elemType && names.includes("edges")) {
              const edgesField = fs.find(sf => sf.name === "edges");
              const edgeType = edgesField ? unwrap(edgesField.type).name : null;
              if (edgeType) {
                await rlPause();
                const ef = await fieldsOf(edgeType);
                const nodeF = ef.find(x => x.name === "node");
                elemType = nodeF ? unwrap(nodeF.type).name : null;
              }
            }
            if (elemType) {
              c.nodeType = elemType;
              await rlPause();
              fs = await fieldsOf(elemType);
              names = fs.map(sf => sf.name);
            }
          }

          c.itemFields = names;
          c.categoryLikeFields = names.filter(n => catRx.test(n));

          // Dig one nested object level from the item/node for a category-bearing object.
          c.nested = [];
          for (const sf of fs) {
            const u = unwrap(sf.type);
            if (u.kind === "OBJECT" && u.name && /(group|style|product|categor|item|line)/i.test(sf.name)) {
              try {
                await rlPause();
                let nfsFields = await fieldsOf(u.name);
                let nnames = nfsFields.map(x => x.name);
                // If THIS is also a connection, follow nodes once more.
                if (nnames.includes("nodes")) {
                  const nn = nfsFields.find(x => x.name === "nodes");
                  const nt = nn ? unwrap(nn.type).name : null;
                  if (nt) { await rlPause(); nfsFields = await fieldsOf(nt); nnames = nfsFields.map(x => x.name); u.name = nt; }
                }
                c.nested.push({ field: sf.name, typeName: u.name, subFields: nnames, categoryLikeFields: nnames.filter(n => catRx.test(n)) });
              } catch (e) { /* skip */ }
            }
          }
        } catch (e) { c.probeError = e.message; }
      }

      // Focus the caller on the real line-item container, not productionFiles etc.
      out.notes.push("lineItemGroups is the line-item container (a Connection: query lineItemGroups{nodes{...}}). Look at its 'itemFields' / 'categoryLikeFields' and 'nested[]' below for the field that names the product/category.");

      if (!out.candidates.length) {
        out.notes.push("No list-of-object or item/product/group-named fields on Invoice. Line items may live on a different type (e.g. Quote), or require a different query shape.");
      } else {
        out.notes.push("Check each candidate's 'categoryLikeFields' (and 'nested[].categoryLikeFields'). Tell me the container field + the category sub-field name and I'll wire it into the discovery probe.");
      }
      return res.status(200).json(out);
    }


    // =====================================================================
    // PROBE-ADDRESS — read-only. Finds which field on the invoice's address (and/or
    // the Customer) carries the ZIP/postal code, so we can pull it for distance
    // scoring without guessing. Hit /api/printavo-sync?mode=probe-address
    // =====================================================================
    if (mode === "probe-address") {
      const out = { ok: true, mode: "probe-address", found: {}, notes: [] };
      const zipRx = /(zip|postal|postcode)/i;

      async function fieldNames(typeName) {
        try {
          const d = await gql(`query{__type(name:"${typeName}"){fields{name type{name kind ofType{name kind}}}}}`);
          return (d.__type && d.__type.fields) || [];
        } catch (e) { return null; }
      }

      // Invoice-level address objects (billingAddress / shippingAddress → CustomerAddress).
      for (const addrField of ["billingAddress", "shippingAddress"]) {
        await rlPause();
        // Resolve the address type from Invoice, then its fields.
        const invF = await fieldNames("Invoice");
        const meta = (invF || []).find(f => f.name === addrField);
        const typeName = meta && (meta.type.name || (meta.type.ofType && meta.type.ofType.name));
        if (!typeName) { out.found[addrField] = null; continue; }
        await rlPause();
        const af = await fieldNames(typeName);
        const names = (af || []).map(f => f.name);
        const zipField = names.find(n => zipRx.test(n)) || null;
        out.found[addrField] = { type: typeName, zipField, allFields: names };
      }

      // Also check the Customer type directly, in case the ZIP lives there.
      await rlPause();
      const custType = plan.parent ? plan.parent.typeName : plan.linkedType;
      if (custType) {
        const cf = await fieldNames(custType);
        const names = (cf || []).map(f => f.name);
        // Customer may hold an address object rather than a flat zip.
        const addrLike = names.find(n => /address/i.test(n)) || null;
        const flatZip = names.find(n => zipRx.test(n)) || null;
        out.found.customer = { type: custType, flatZip, addressField: addrLike, allFields: names };
        if (addrLike && !flatZip) {
          const am = (cf || []).find(f => f.name === addrLike);
          const at = am && (am.type.name || (am.type.ofType && am.type.ofType.name));
          if (at) {
            await rlPause();
            const af = await fieldNames(at);
            const anames = (af || []).map(f => f.name);
            out.found.customer.addressType = at;
            out.found.customer.addressZipField = anames.find(n => zipRx.test(n)) || null;
            out.found.customer.addressFields = anames;
          }
        }
      }

      out.notes.push("Tell me which zipField to use (billingAddress usually best for company location). I'll wire it into the sync so each customer's ZIP is stored and Distance auto-scores.");
      return res.status(200).json(out);
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
          `query{invoices(first:${RECONCILE_PAGE},sortOn:${sortPlan.sortOn}${descI}${dateArg}${after}){${GQL_FIELDS}}}`
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
      finalizeContactsAndCategories(acc);
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
          const qstr = `query{invoices(first:${RECONCILE_PAGE}${statusArg}${windowArg}${after}){${GQL_FIELDS}}}`;
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
              failedAt: { year, pass, hasCursor: !!cursor, pageSize: RECONCILE_PAGE, usedPaymentStatus: !!statusArg },
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
      finalizeContactsAndCategories(acc);
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
        buildVersion: "contacts-categories-v8",
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
      const curYear = String(new Date().getFullYear());

      const qMeta = await resolveQuotesMeta();
      const QUOTE_FIELDS = quoteFieldSelection();
      await rlPause();

      // Resumable accumulator. The whole ops pull (all quotes + all current-year
      // invoices) can exceed one function's time budget, so we persist progress to
      // backbone_ops_partial and continue across calls (same pattern as reconcile).
      // Phase order: "quotes" -> "invoices" -> done. Each call does as much as it can
      // within the deadline, saves, and hands back a nextUrl to continue.
      let acc = (await kvGet("backbone_ops_partial")) || null;
      // ?fresh=1 forces a clean restart (ignore any stale partial).
      if (req.query.fresh === "1" || req.query.fresh === "true") acc = null;
      if (!acc) {
        acc = {
          phase: "quotes",
          cursor: null,
          workloadByCustomer: {},
          quotesThisWeek: 0,
          artDeclinedYtd: 0,
          quotesScanned: 0,
          quotePages: 0,
          // Live "currently in status" counts (#3) — snapshot, all-time, no date filter.
          currentArtDeclined: 0,
          currentQuoteDeclined: 0,
          artDeclinedIds: [],   // ids currently in ART DECLINED, for snapshot-diff (#2)
          declineEventsByYear: {}, // populated by the diff when the quote phase completes
          statusHistogram: {},  // raw status name -> count seen, for match debugging
          outstanding: [],
          salesByMonth: {},
          seenOutstanding: [],   // invoice ids already booked, so resume can't double-count
          invoicePages: 0,
          startedAt: nowIso,
        };
      }
      // Resume cursor may also be supplied explicitly on the URL.
      if (resumeCursor) acc.cursor = resumeCursor;

      const deadline = Date.now() + 230000; // leave headroom under Vercel's 300s cap
      const seenSet = new Set(acc.seenOutstanding || []);

      // ---------- PHASE 1: quotes (workload + this-week + art declines) ----------
      if (acc.phase === "quotes") {
        const descQ = qMeta.hasSortDescending ? ",sortDescending:true" : "";
        let cursor = acc.cursor;
        do {
          const after = cursor ? `,after:"${cursor}"` : "";
          const data = await gql(
            `query{quotes(first:25,sortOn:${qMeta.sortOn}${descQ}${after}){${QUOTE_FIELDS}}}`
          );
          const nodes = (data.quotes && data.quotes.nodes) || [];
          for (const q of nodes) {
            acc.quotesScanned++;
            const statusName = q.status && q.status.name;
            // Histogram of raw status names actually seen, so we can verify our match
            // strings against reality instead of the screenshot labels. Capped to keep
            // the partial-state payload small.
            if (statusName != null) {
              const sn = String(statusName);
              acc.statusHistogram[sn] = (acc.statusHistogram[sn] || 0) + 1;
            }
            const grp = groupForStatus(statusName);
            const created = q.createdAt || "";
            if (grp) {
              const cust = quoteCustomer(q);
              const key = cust.id || "unassigned";
              if (!acc.workloadByCustomer[key]) {
                acc.workloadByCustomer[key] = { customer_id: cust.id, company_name: cust.name, quotes: 0, inProgress: 0, onHold: 0 };
              }
              acc.workloadByCustomer[key][grp]++;
            }
            if (created && created >= weekAgoIso) acc.quotesThisWeek++;
            if (created && created >= yearStart && normStatus(statusName) === normArtDeclined) acc.artDeclinedYtd++;
            // Live snapshot counts (#3): what's sitting in a declined status right now,
            // regardless of when the quote was created. QUOTE DECLINED and ART DECLINED
            // are distinct states in Printavo, so we track them separately.
            const ns = normStatus(statusName);
            if (ns === normArtDeclined) {
              acc.currentArtDeclined++;
              // Collect the id so we can diff against the previous run's declined set
              // (Option B): ids present now but not last time are NEW decline events.
              if (q.id != null && acc.artDeclinedIds.indexOf(String(q.id)) === -1) {
                acc.artDeclinedIds.push(String(q.id));
              }
            }
            if (ns === normStatus("QUOTE DECLINED")) acc.currentQuoteDeclined++;
          }
          cursor = (data.quotes && data.quotes.pageInfo && data.quotes.pageInfo.hasNextPage)
            ? data.quotes.pageInfo.endCursor : null;
          acc.quotePages++;
          acc.cursor = cursor;
          if (cursor) await new Promise(r => setTimeout(r, 1200));
        } while (cursor && Date.now() < deadline);

        if (acc.cursor) {
          // Ran out of time mid-quotes. Save and ask to continue.
          await kvSet("backbone_ops_partial", acc);
          return res.status(200).json({
            ok: true, mode: "ops", status: "partial", phase: "quotes",
            quotesScanned: acc.quotesScanned, quotePages: acc.quotePages,
            nextUrl: `/api/printavo-sync?mode=ops&secret=${encodeURIComponent(secret)}`,
          });
        }
        // Quotes done — advance to invoices phase.
        // Option B snapshot-diff: the full quote set was scanned this run (not partial),
        // so acc.artDeclinedIds is a COMPLETE snapshot of what's in ART DECLINED right
        // now. Compare against the previous complete snapshot: any id present now but
        // not before is a quote that entered ART DECLINED since we last looked — a new
        // decline EVENT. We tally those per year. A quote that was declined, revised,
        // and re-declined counts again (it will have left the stored set in between).
        //
        // We only run the diff on a COMPLETE quote scan. A truncated scan would be
        // missing ids and could falsely read declines as "resolved", corrupting the
        // count — so partial runs (handled above) never reach this block.
        try {
          const prev = (await kvGet("backbone_ops_decline_state")) || {};
          const prevIds = Array.isArray(prev.declinedIds) ? prev.declinedIds : [];
          const prevSet = new Set(prevIds);
          const curIds = acc.artDeclinedIds || [];
          const curSet = new Set(curIds);

          // New events = in current snapshot, absent from previous snapshot.
          // On the very FIRST run prev is empty, so every currently-declined quote
          // would look "new". That's a seeding artifact, not real events — so on the
          // first run we seed the baseline and record 0 events, then count from there.
          const isFirstRun = !prev.initialized;
          let newEvents = 0;
          if (!isFirstRun) {
            for (const id of curIds) if (!prevSet.has(id)) newEvents++;
          }

          const byYear = (prev.declineEventsByYear && typeof prev.declineEventsByYear === "object")
            ? prev.declineEventsByYear : {};
          byYear[curYear] = (byYear[curYear] || 0) + newEvents;

          const declineState = {
            initialized: true,
            declinedIds: curIds,                 // new baseline for next run
            declineEventsByYear: byYear,
            lastDiffAt: nowIso,
            lastNewEvents: newEvents,
            seededOnFirstRun: isFirstRun,
          };
          await kvSet("backbone_ops_decline_state", declineState);
          acc.declineEventsByYear = byYear;      // carry into final payload
          acc.declineEventsSeeded = isFirstRun;
        } catch (e) {
          // Diff is best-effort; never let it break the sync. Fall back to no YTD count.
          acc.declineEventsByYear = acc.declineEventsByYear || {};
        }

        acc.phase = "invoices";
        acc.cursor = null;
        await kvSet("backbone_ops_partial", acc);
      }

      // ---------- PHASE 2: current-year invoices (outstanding + sales-by-month) ----------
      if (acc.phase === "invoices") {
        const descI = argPlan.hasSortDescending ? ",sortDescending:true" : "";
        const ytdDateArg = argPlan.hasInProductionAfter ? `,inProductionAfter:"${yearStart}"` : "";
        let invCursor = acc.cursor;
        do {
          const after = invCursor ? `,after:"${invCursor}"` : "";
          const data = await gql(
            `query{invoices(first:${RECONCILE_PAGE},sortOn:${sortPlan.sortOn}${descI}${ytdDateArg}${after}){${GQL_FIELDS}}}`
          );
          const nodes = (data.invoices && data.invoices.nodes) || [];
          for (const inv of nodes) {
            if (seenSet.has(inv.id)) continue; // dedupe across resumes
            seenSet.add(inv.id);
            const created = inv.createdAt || "";
            const out = Number(inv.amountOutstanding) || 0;
            const total = Number(inv.total) || 0;
            if (out > 0.009) {
              const cust = quoteCustomer(inv);
              acc.outstanding.push({
                id: inv.id, visualId: inv.visualId || null,
                company_name: cust.name, customer_id: cust.id,
                amount: Math.round(out * 100) / 100,
                total: Math.round(total * 100) / 100,
                status: inv.status && inv.status.name,
                createdAt: created || null,
              });
            }
            if (created && created.slice(0, 4) === curYear) {
              const paid = Math.max(0, total - out);
              if (paid > 0) {
                const mk = created.slice(0, 7);
                acc.salesByMonth[mk] = (acc.salesByMonth[mk] || 0) + paid;
              }
            }
          }
          invCursor = (data.invoices && data.invoices.pageInfo && data.invoices.pageInfo.hasNextPage)
            ? data.invoices.pageInfo.endCursor : null;
          acc.invoicePages++;
          acc.cursor = invCursor;
          if (invCursor) await new Promise(r => setTimeout(r, 1200));
        } while (invCursor && Date.now() < deadline);

        acc.seenOutstanding = Array.from(seenSet);

        if (acc.cursor) {
          // Ran out of time mid-invoices. Save and ask to continue.
          await kvSet("backbone_ops_partial", acc);
          return res.status(200).json({
            ok: true, mode: "ops", status: "partial", phase: "invoices",
            invoicePages: acc.invoicePages, outstandingSoFar: acc.outstanding.length,
            nextUrl: `/api/printavo-sync?mode=ops&secret=${encodeURIComponent(secret)}`,
          });
        }
      }

      // ---------- Finalize: everything paged, write the real key, clear partial ----------
      const salesByMonth = {};
      Object.keys(acc.salesByMonth).forEach(function (m) {
        salesByMonth[m] = Math.round(acc.salesByMonth[m] * 100) / 100;
      });
      const outstanding = acc.outstanding.slice().sort(function (a, b) { return b.amount - a.amount; });
      const outstandingTotal = outstanding.reduce(function (s, r) { return s + r.amount; }, 0);

      const opsPayload = {
        generatedAt: nowIso,
        buildVersion: "ops-v2-resumable",
        quotesThisWeek: acc.quotesThisWeek,
        artDeclinedYtd: acc.artDeclinedYtd,
        // #3 live snapshot: quotes currently sitting in each declined status (all-time).
        currentArtDeclined: acc.currentArtDeclined,
        currentQuoteDeclined: acc.currentQuoteDeclined,
        // #2 event count: art declines that HAPPENED this year, accumulated by
        // BackBone via snapshot-diff across runs (accurate from the first run's date
        // forward — Printavo has no decline history to backfill from).
        artDeclineEventsYtd: (acc.declineEventsByYear && acc.declineEventsByYear[curYear]) || 0,
        declineTrackingSeeded: !!acc.declineEventsSeeded,
        outstanding,
        outstandingTotal: Math.round(outstandingTotal * 100) / 100,
        salesByMonth,
        workload: Object.values(acc.workloadByCustomer),
        statusGroups: WORKLOAD_STATUS_GROUPS,
        diagnostics: {
          quotesScanned: acc.quotesScanned, quotePages: acc.quotePages,
          invoicePages: acc.invoicePages,
          quotesSort: qMeta.sortOn, quotesHasDesc: qMeta.hasSortDescending,
          quotesArtDeclineStatusMatched: acc.currentArtDeclined > 0,
          // Every distinct quote status name seen this run, most common first. This is
          // the ground truth for status matching — compare against WORKLOAD_STATUS_GROUPS.
          statusHistogram: Object.keys(acc.statusHistogram || {})
            .map(function (k) { return { status: k, count: acc.statusHistogram[k] }; })
            .sort(function (a, b) { return b.count - a.count; }),
        },
      };

      await kvSet("backbone_printavo_ops", opsPayload);
      await kvSet("backbone_ops_partial", null); // clear resume state

      return res.status(200).json({
        ok: true, mode: "ops", status: "done",
        quotesThisWeek: opsPayload.quotesThisWeek,
        artDeclinedYtd: opsPayload.artDeclinedYtd,
        currentArtDeclined: opsPayload.currentArtDeclined,
        currentQuoteDeclined: opsPayload.currentQuoteDeclined,
        artDeclineEventsYtd: opsPayload.artDeclineEventsYtd,
        declineTrackingSeeded: opsPayload.declineTrackingSeeded,
        outstandingCount: outstanding.length,
        outstandingTotal: opsPayload.outstandingTotal,
        workloadCustomers: opsPayload.workload.length,
        salesMonths: Object.keys(salesByMonth).length,
        diagnostics: opsPayload.diagnostics,
        nextUrl: null,
      });
    }

    return res.status(400).json({ error: "Invalid mode. Use: incremental, reconcile, ops" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
