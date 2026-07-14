// /api/scan-card.js
// Server-side proxy that runs a business-card image through the Anthropic API and
// returns structured contact fields as JSON. Runs server-side so the API key stays
// off the client and there's no browser CORS problem calling api.anthropic.com.
//
// Requires env var ANTHROPIC_API_KEY (a billed console.anthropic.com key — this is
// separate from a Claude.ai Pro subscription). Add it in the Vercel project's
// Environment Variables, then redeploy so the deployment picks it up.

import { requireAuth } from "../lib/session.js";

export const config = { api: { bodyParser: { sizeLimit: "12mb" } } };

const MODEL = "claude-sonnet-4-6";

export default async function handler(req, res) {
  // Wildcard CORS removed. This endpoint spends real money on every call (Anthropic
  // vision), and `Access-Control-Allow-Origin: *` let ANY website invoke it from a
  // visitor's browser. Same-origin only now.
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  // And it had NO auth guard, so anyone who found the URL could run up the bill.
  const sess = requireAuth(req, res);
  if (!sess) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", message: "scan-card proxy running. Key: " + (apiKey ? "set" : "missing") });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!apiKey) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY env var" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const image = body && body.image;
  const media_type = (body && body.media_type) || "image/jpeg";
  if (!image) return res.status(400).json({ error: "No image provided." });

  const prompt =
    "This is a photo of a business card. Extract the details and respond with ONLY a JSON " +
    "object, no preamble, no markdown fences. Use these exact keys, and use an empty string " +
    "for anything not present on the card:\n" +
    '{"company_name":"","contact_name":"","contact_title":"","email":"","phone":"","website_url":""}\n' +
    "For website_url, include the scheme (https://) if you can infer it. Do not guess values " +
    "that are not visible on the card.";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: media_type, data: image } },
              { type: "text", text: prompt }
            ]
          }
        ]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "Anthropic API error", detail: (data && data.error && data.error.message) || ("HTTP " + r.status) });
    }

    const text = (data.content || [])
      .filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; })
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(200).json({ error: "Could not parse card. Model returned unstructured text.", raw: text.slice(0, 400) });
    }

    return res.status(200).json({
      company_name: parsed.company_name || "",
      contact_name: parsed.contact_name || "",
      contact_title: parsed.contact_title || "",
      email: parsed.email || "",
      phone: parsed.phone || "",
      website_url: parsed.website_url || ""
    });
  } catch (err) {
    return res.status(500).json({ error: "Proxy error", detail: err.message });
  }
}
