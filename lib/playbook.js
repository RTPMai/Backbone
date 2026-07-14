// api/lib/playbook.js
//
// P&M's Features -> Benefits mapping, per industry lane, plus the owner-operator vs
// team-based (B2B) selling split.
//
// SOURCE: this is derived from P&M's own documents, not invented —
//   - Skill Hub / AM Industry Assignments  -> per-lane Description, Needs, Opportunities
//   - Customer Tiers Criteria              -> the services ladder (Growth Potential):
//     catalog stores, pop-up stores, bulk promo, screen printing, embroidery,
//     mixed-media applications
//   - Campaign Templates (Apple Analogy)   -> the owner-operator vs "businesses with
//     teams" distinction, and the "market to them like they market" framing
//
// WHY THE SPLIT MATTERS. An owner-operator IS the buyer — they feel the cost personally,
// decide alone, and want the hassle gone. A team-based B2B buyer is a marketing or HR
// person who must justify the spend UPWARD to someone else. Same product, completely
// different pitch: the owner buys relief, the marketer buys evidence they can defend.

// P&M's actual services, with the benefit each one delivers (not just what it IS).
const FEATURES = {
  catalog_store: {
    feature: "Year-round catalog store",
    benefit_owner: "staff order their own gear on their own card — you stop being the middleman",
    benefit_b2b: "no PO per order, no spreadsheet chasing; spend is predictable and reportable"
  },
  popup_store: {
    feature: "Pop-up store (open/close window)",
    benefit_owner: "collect orders and money up front — no leftover inventory you ate the cost on",
    benefit_b2b: "run it per campaign or per event; you get a clean participation number afterwards"
  },
  bulk_promo: {
    feature: "Bulk promotional products",
    benefit_owner: "one call covers the giveaways, not five vendors",
    benefit_b2b: "one supplier across apparel and promo means one invoice and one brand standard"
  },
  screen_print: {
    feature: "Screen printing",
    benefit_owner: "cheapest per piece once you're past a couple dozen",
    benefit_b2b: "volume pricing that holds up when procurement asks why not the cheapest bid"
  },
  embroidery: {
    feature: "Embroidery",
    benefit_owner: "survives industrial washing — you re-buy less often",
    benefit_b2b: "the elevated look for client-facing staff; holds its finish through the wear cycle"
  },
  mixed_media: {
    feature: "Mixed-media / multi-location decoration",
    benefit_owner: "makes a shirt people actually want to wear off the clock",
    benefit_b2b: "gets the logo seen outside the building — that's reach, not just uniform spend"
  },
  white_glove: {
    feature: "White-glove art + digitized logo on file",
    benefit_owner: "send us a napkin sketch; you don't need to be a designer",
    benefit_b2b: "your brand standards are held on our side, so nobody ships an off-brand logo"
  },
  blind_ship: {
    feature: "Blind shipping / white-label fulfillment",
    benefit_owner: "",
    benefit_b2b: "it ships to your client with your name on it — we stay invisible"
  },
  onboarding_kits: {
    feature: "Onboarding / welcome kits",
    benefit_owner: "new hire walks in with the gear already on their desk",
    benefit_b2b: "a repeatable first-day experience HR doesn't have to reassemble every time"
  },
  am_continuity: {
    feature: "One named account manager who knows your logo",
    benefit_owner: "you talk to a person, not a ticket queue",
    benefit_b2b: "the reorder doesn't restart from zero every time your coordinator changes"
  }
};

// Per-lane: the NEEDS come from the Skill Hub doc; FEATURES are the P&M services that
// answer those needs; HOOK is the opening that lands for that specific lane.
// `motion` classifies the default selling motion for the lane:
//   owner  = an owner/operator or single decision-maker feels the cost personally
//   b2b    = a team member must justify the spend upward
//   inst   = institutional/procurement — process, contracts, multiple stakeholders
//   event  = spend is driven by a date on a calendar
const LANES = {
  "Blue Collar/Agriculture": {
    motion: "owner",
    needs: "Durable workwear, uniforms, outerwear, safety-conscious options that hold up to repeated wear.",
    features: ["embroidery", "am_continuity", "catalog_store", "screen_print"],
    hook: "Crews destroy gear. Ask what they're replacing most often and how often — that number is the whole pitch."
  },
  "Cities and Associations": {
    motion: "inst",
    needs: "Organized support across varied departments, event timelines, and repeat annual ordering.",
    features: ["catalog_store", "popup_store", "am_continuity", "bulk_promo"],
    hook: "Multiple departments, one budget cycle. Lead with the department-segmented store — it solves their internal chaos, not just their apparel."
  },
  "City Fire, EMS & Police": {
    motion: "inst",
    needs: "High-quality durable uniforms, comfort, department logo customization.",
    features: ["embroidery", "am_continuity", "catalog_store"],
    hook: "Uniform spec and duty-rated fabric matter more than price here. Ask who writes the spec."
  },
  "Contract": {
    motion: "inst",
    needs: "Different timelines, blind shipping, contract pricing, minimal art, white-glove service.",
    features: ["blind_ship", "white_glove", "am_continuity"],
    hook: "They already have the business — they need production that doesn't embarrass them. Lead with reliability and blind ship, not creativity."
  },
  "Healthcare and Wellness": {
    motion: "b2b",
    needs: "Comfortable professional attire, performance fabrics, logo customization.",
    features: ["embroidery", "catalog_store", "onboarding_kits"],
    hook: "Staff are patient-facing all day. Comfort IS the professional standard — pitch the fabric, not the logo."
  },
  "Military / Reserve": {
    motion: "event",
    needs: "Unit shirts, PT gear, morale patches, embroidered polos, challenge coins, decals.",
    features: ["popup_store", "mixed_media", "bulk_promo"],
    hook: "Morale gear is bought by the unit, often self-funded. Private store + limited run is the model."
  },
  "Church": {
    motion: "event",
    needs: "Low-cost, coordinated colors, cinch bags, totes, youth/adult bulk purchases.",
    features: ["popup_store", "screen_print", "bulk_promo"],
    hook: "Budget is tight and volunteer-run. The pop-up store collects money before you print — that's the pitch."
  },
  "Clubs - Non Sports": {
    motion: "event",
    needs: "Event-specific apparel, quick turnaround, smaller quantities.",
    features: ["popup_store", "screen_print"],
    hook: "Small runs, real deadlines. Turnaround beats price."
  },
  "Dance": {
    motion: "event",
    needs: "Garment variety, matching adult/youth looks, color themes, trendy promo, event themes.",
    features: ["popup_store", "mixed_media", "bulk_promo"],
    hook: "Recital and competition dates drive everything. Get on their season calendar and the orders repeat."
  },
  "Events": {
    motion: "event",
    needs: "Staff shirts, volunteer apparel, participant merch, giveaways, fast turnaround, flexibility.",
    features: ["popup_store", "bulk_promo", "screen_print", "am_continuity"],
    hook: "Tiered packages — participant / VIP / volunteer / staff. One event becomes four SKUs."
  },
  "FART: Fun Activities and Rec": {
    motion: "event",
    needs: "Bold, playful, affordable bulk apparel and custom designs.",
    features: ["screen_print", "popup_store", "white_glove"],
    hook: "Fun is the product. Bring a design idea, not a price sheet."
  },
  "Marketing Firms": {
    motion: "b2b",
    needs: "White-label fulfillment, mockup-ready ideas, campaign merch, launch kits, short-run samples.",
    features: ["blind_ship", "white_glove", "popup_store", "onboarding_kits"],
    hook: "They resell you. Make THEM look fast and polished to THEIR client — that's the entire value prop."
  },
  "Music and Entertainment": {
    motion: "owner",
    needs: "Trend-forward apparel, fan merch, event drops, limited collections, authentic designs.",
    features: ["popup_store", "mixed_media", "screen_print"],
    hook: "Merch is revenue, not overhead. Talk margin per unit and sell-through, not cost."
  },
  "Real Estate": {
    motion: "owner",
    needs: "Low-cost high-touch promo, client gifts, open-house handouts, personal-brand apparel.",
    features: ["bulk_promo", "am_continuity", "white_glove"],
    hook: "Their personal brand IS the business. Easy reorders keep you top-of-mind — that's what they're buying."
  },
  "Lifestyle Brands": {
    motion: "owner",
    needs: "Fashion-conscious garments, limited drops, elevated blanks, aesthetic alignment.",
    features: ["mixed_media", "popup_store", "white_glove"],
    hook: "Blank quality is non-negotiable. Lead with the garment, not the decoration."
  },
  "Corporate/Small Business": {
    motion: "b2b",
    needs: "Professional apparel, company stores, uniforms, event giveaways, brand reinforcement.",
    features: ["catalog_store", "embroidery", "onboarding_kits", "bulk_promo"],
    hook: "Find out FIRST whether you're talking to the owner or to a marketing/HR person — the pitch flips completely."
  },
  "Food and Hospitality": {
    motion: "owner",
    needs: "Durable easy-to-clean fabrics, professional designs, logo printing.",
    features: ["embroidery", "catalog_store", "am_continuity"],
    hook: "Turnover is brutal. A store that lets them order two shirts for a new hire beats a bulk order they'll outgrow."
  },
  "Club Sports and School Athletics": {
    motion: "event",
    needs: "Performance fabrics, team colors/logos, player name/number customization.",
    features: ["popup_store", "mixed_media", "bulk_promo"],
    hook: "Season dates are the buying trigger. Spirit wear for fans is the upsell nobody asks for."
  },
  "Higher Education / Universities": {
    motion: "inst",
    needs: "Branded apparel, style/size variety, custom school logos, campus and alumni programs.",
    features: ["catalog_store", "popup_store", "white_glove", "bulk_promo"],
    hook: "Many small buyers, one brand standard. The store enforces the standard — that's what the brand office wants."
  },
  "K-12": {
    motion: "inst",
    needs: "Durable kid-friendly fabrics, school colors/logos, easy online ordering.",
    features: ["popup_store", "screen_print", "am_continuity"],
    hook: "Parents are the actual payers. Easy online ordering is the feature that gets you renewed."
  },
  "Nonprofit": {
    motion: "b2b",
    needs: "Cost-conscious apparel, donor and volunteer recognition, event and campaign merch.",
    features: ["popup_store", "screen_print", "bulk_promo"],
    hook: "Every dollar is scrutinised by a board. Frame merch as fundraising and donor retention, not as a cost."
  },
  "Personal Order": {
    motion: "owner",
    needs: "One-off or small group orders, gifts, personal projects.",
    features: ["white_glove", "screen_print"],
    hook: "Low value, but it's how referrals start. Be fast and pleasant; don't over-invest."
  }
};

// Owner-operator vs team-based framing. The Apple Analogy doc is explicit that P&M is
// moving from selling to owner-operators toward businesses with teams — and that the
// team-based sale requires marketing TO them the way they market with what they buy.
const MOTIONS = {
  owner: {
    label: "Owner-operator",
    read: "One person decides, pays, and feels the cost. No committee, no approval chain.",
    lead_with: "Time and hassle removed. They are already doing this job themselves and hating it.",
    avoid: "Don't pitch reporting, analytics, or brand governance. They don't answer to anyone.",
    close: "Ask for a small first order. They buy on trust, and trust is earned on the first job."
  },
  b2b: {
    label: "Team-based / true B2B",
    read: "Your contact must justify this spend upward. They are buying evidence as much as apparel.",
    lead_with: "Make THEM look good internally. Give them the numbers and the story they'll be asked for.",
    avoid: "Don't lead with lowest price — it invites a bid comparison they'll lose control of.",
    close: "Offer something they can forward: a mockup, a store demo, a one-page recap. Arm them for their meeting."
  },
  inst: {
    label: "Institutional / procurement",
    read: "Multiple stakeholders, defined process, budget cycles. Slow but sticky once you're in.",
    lead_with: "Process reliability and compliance. Being easy to buy from beats being cheap.",
    avoid: "Don't try to shortcut the process — you'll be seen as a risk.",
    close: "Ask who writes the spec and when the budget cycle opens. Those two answers are the deal."
  },
  event: {
    label: "Event / calendar-driven",
    read: "Spend is triggered by a date. Miss the date and the order doesn't move — it disappears.",
    lead_with: "Deadline certainty. They are terrified of gear arriving after the event.",
    avoid: "Don't pitch long-term programs before you've proven you can hit one date.",
    close: "Get their event calendar. That calendar is a year of orders you can see coming."
  }
};

export { FEATURES, LANES, MOTIONS };
