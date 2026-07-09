export const config = { maxDuration: 60 };

// TEMPORARY DIAGNOSTIC ENDPOINT
// Hit /api/printavo-schema once to see the real field shapes of the Printavo
// types we care about, so we can group invoices by COMPANY instead of by the
// individual contact person. Safe to delete after we've read the output.
//
// It introspects Invoice, Contact, and Customer (plus any *Customer* type it
// finds) and reports each type's fields with the object type each points to.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const token = process.env.PRINTAVO_API_TOKEN;
  const email = process.env.PRINTAVO_EMAIL;
  if (!token || !email) return res.status(500).json({ error: "Missing Printavo credentials" });

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

  // Return a compact { fieldName: "TypeName (KIND)" } map for a type.
  async function typeFields(typeName) {
    const q = `query{__type(name:"${typeName}"){name fields{name type{name kind ofType{name kind ofType{name kind}}}}}}`;
    const d = await gql(q);
    if (!d.__type) return { _missing: true };
    const out = {};
    (d.__type.fields || []).forEach(f => {
      const t = f.type || {};
      const inner = t.ofType || {};
      const inner2 = inner.ofType || {};
      const name = t.name || inner.name || inner2.name || null;
      const kind = t.kind === "OBJECT" ? "OBJECT" : (inner.kind === "OBJECT" ? "OBJECT" : (inner2.kind === "OBJECT" ? "OBJECT" : (t.kind || inner.kind)));
      out[f.name] = `${name || "?"} (${kind || "?"})`;
    });
    return out;
  }

  try {
    const result = {};
    for (const typeName of ["Invoice", "Contact", "Customer"]) {
      try {
        result[typeName] = await typeFields(typeName);
      } catch (e) {
        result[typeName] = { _error: e.message };
      }
      await new Promise(r => setTimeout(r, 600)); // stay under rate limit
    }

    // Also grab one real invoice with contact expanded a couple levels, so we
    // can SEE where the company name actually sits. We try a few plausible
    // shapes and report whichever the server accepts.
    const sampleAttempts = [
      `query{invoices(first:1){nodes{id total contact{id fullName email customer{id companyName}}}}}`,
      `query{invoices(first:1){nodes{id total contact{id fullName email company{id name}}}}}`,
      `query{invoices(first:1){nodes{id total contact{id fullName email}}}}`,
    ];
    let sample = null, sampleQueryUsed = null, sampleError = null;
    for (const q of sampleAttempts) {
      try {
        const d = await gql(q);
        sample = d.invoices && d.invoices.nodes && d.invoices.nodes[0];
        sampleQueryUsed = q;
        break;
      } catch (e) {
        sampleError = e.message; // keep last error, try next shape
      }
      await new Promise(r => setTimeout(r, 600));
    }

    return res.status(200).json({
      ok: true,
      note: "Look for a field on Contact whose type is Customer (or Company). That's the parent to group by. Delete this endpoint once resolved.",
      types: result,
      sampleInvoice: sample,
      sampleQueryUsed,
      sampleError,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
