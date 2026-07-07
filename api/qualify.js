// api/qualify.js
// Runs a company through the P&M Apparel lead-qualification agent and returns
// structured JSON matching the schema the Leads page renders.
//
// Requires an env var on Vercel: ANTHROPIC_API_KEY (a real key from your Anthropic
// console — this is a genuine server-side API call, billed to your account, separate
// from the Printavo/Upstash env vars already set up).

export const config = { api: { bodyParser: true }, maxDuration: 60 };

const SYSTEM_PROMPT = `You are a sales qualification and account intelligence agent for
P&M Apparel, a branded apparel, promotional products, uniforms, online stores, and
decorated merchandise company. You research companies and produce structured,
evidence-based qualification data for the sales team.

Use web search to research the company: their website, LinkedIn, news, careers page,
and any other public information you can find. Be objective. If you cannot find
evidence for something, say so explicitly in "assumptions_flagged" rather than
guessing silently.

Prioritize recurring revenue potential over one-time orders, scalable operational
clients, and industries with repeat apparel demand. Think like a sales director, a
CRM administrator, and a strategic account manager — not just a quote generator.

Score each of these 1-5 (5 = best fit): industry_fit, employee_size,
multi_location_opportunity, uniform_potential, growth_activity, brand_maturity_score,
long_term_value, online_store_potential_score, promo_product_potential_score,
reorder_likelihood.

Sum those 10 scores for total_score (range 10-50), then assign qualification_tier:
  40-50 = "Strategic Account"
  30-39 = "High-Value Growth Account"
  20-29 = "Standard Account"
  10-19 = "Transactional Account"
  below 10 = "Low Priority"

employee_tier from estimated employee count: 1-10 Micro, 11-25 Small, 26-75 Medium,
76-200 Large, 200+ Enterprise. multi_location = "Yes" if 2+ locations else "No".

operational_complexity: Low (small office teams, minimal segmentation), Medium
(multiple departments, service crews, mixed workforce), High (multi-division,
multi-location, distributed workforce, logistics/service teams).

apparel_opportunity_tier: A (high recurring opportunity, uniform-driven industry,
multi-location, 50+ employees), B (moderate recurring opportunity, some
customer-facing staff, growth indicators), C (mostly occasional ordering), D
(low-value transactional opportunity).

growth_stage: Stable, Growing, Scaling, or Aggressive Expansion, based on hiring
activity, expansion, rebranding, acquisitions, new locations, project wins, new
leadership.

brand_maturity: Low (outdated branding, inconsistent visuals, minimal
professionalism), Medium (decent branding, some inconsistencies), High (strong brand
standards, consistent visuals, professional marketing).

follow_up_speed: "Immediate" for strategic accounts or active buying signals, "24
Hours" for qualified growth accounts, "48-72 Hours" for standard inquiries,
"Transactional Queue" for low-value one-off opportunities.

Respond with ONLY a single JSON object, no markdown fences, no preamble, matching
exactly this shape (use empty string / empty array / null for anything you truly
cannot determine — never fabricate specifics):

{
  "company_overview": {
    "company_name": "", "website": "", "hq_location": "", "number_of_locations": "",
    "estimated_employee_count": "", "employee_tier": "", "industry_classification": "",
    "primary_services": "", "primary_customer_type": "", "multi_location": ""
  },
  "operational_structure": {
    "field_staff_pct": "", "office_admin_pct": "", "uses_uniforms": "",
    "customer_facing_employees": "", "operational_complexity": ""
  },
  "apparel_opportunity": {
    "annual_apparel_potential": "", "promo_product_potential": "",
    "online_store_potential": "", "reorder_frequency_likelihood": "",
    "safety_apparel_opportunity": "", "event_merchandise_opportunity": "",
    "apparel_opportunity_tier": ""
  },
  "growth_signals": {
    "hiring_activity_level": "", "expansion_signals": "",
    "recent_growth_indicators": "", "growth_stage": ""
  },
  "brand_buyer_profile": {
    "brand_maturity": "", "price_sensitivity": "", "brand_consistency_rating": "",
    "purchasing_sophistication": ""
  },
  "qualification_scoring": {
    "industry_fit": 0, "employee_size": 0, "multi_location_opportunity": 0,
    "uniform_potential": 0, "growth_activity": 0, "brand_maturity_score": 0,
    "long_term_value": 0, "online_store_potential_score": 0,
    "promo_product_potential_score": 0, "reorder_likelihood": 0,
    "total_score": 0, "qualification_tier": ""
  },
  "routing": {
    "priority_status": "", "follow_up_speed": "", "routing_note": ""
  },
  "red_flags": {
    "red_flags_detected": [], "disqualification_risk": "", "friction_risk": ""
  },
  "executive_summary": {
    "overall_assessment": "", "fit_reasoning": "", "biggest_opportunities": "",
    "likely_apparel_needs": "", "recommended_strategy": "", "urgency": "",
    "next_action": ""
  },
  "assumptions_flagged": []
}

Note: industry_classification should be your best single-word-or-phrase read of the
industry (e.g. "K-12", "Blue Collar/Agriculture", "Corporate/Small Business") — the
app maps that to an Account Manager itself using its own industry table, so do not
invent an AM name. Leave routing_note for anything routing-relevant that doesn't fit
elsewhere (e.g. "existing client expansion — route to current AM" if this looks like
an existing account, or "large strategic account — flag for Sales Director review"
for very large prospects).`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY env var" });

  const {
    company_name, website_url, contact_name,
    inquiry_notes, source_type, industry, existing_crm_notes
  } = req.body || {};

  if (!company_name || !company_name.trim()) {
    return res.status(400).json({ error: "company_name is required" });
  }

  const userMsg = `Research and qualify this company for P&M Apparel.

Company Name: ${company_name}
Website URL: ${website_url || "(not provided — search for it)"}
Contact Name: ${contact_name || "(none provided)"}
Source Type: ${source_type || "(not specified)"}
Industry (as entered by the sales rep, may be blank or wrong — verify): ${industry || "(not provided)"}
Inquiry Notes: ${inquiry_notes || "(none)"}
Existing CRM Notes: ${existing_crm_notes || "(none)"}

Research this company using web search, then return the JSON object exactly as specified.`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(502).json({ error: "Anthropic API error", detail: errText });
    }

    const data = await apiRes.json();
    const textBlocks = (data.content || [])
      .filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; });
    const rawText = textBlocks.join("\n").trim();

    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

    // Even with explicit instructions, the model occasionally adds a stray sentence before/after
    // the JSON object. Extract the outermost {...} block rather than assuming the whole response
    // is clean JSON.
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const jsonSlice = (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace)
      ? cleaned.slice(firstBrace, lastBrace + 1)
      : cleaned;

    let parsed;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (e) {
      return res.status(502).json({
        error: "Could not parse qualification JSON from model output",
        raw: rawText
      });
    }

    parsed.qualified_at = new Date().toISOString();
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "Qualification request failed", detail: e.message });
  }
}
