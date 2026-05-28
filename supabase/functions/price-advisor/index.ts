import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Cache TTL: 3 dagen
const CACHE_TTL_DAYS = 3;

// Leeftijd in ranges zodat licht verschillende invoer dezelfde cache raakt
function leeftijdRange(j: string | number): string {
  const n = parseInt(String(j)) || 0;
  if (n <= 3)  return "0-3";
  if (n <= 7)  return "4-7";
  if (n <= 12) return "8-12";
  return "13+";
}

// Volledigheid in kwartalen zodat vergelijkbare scores dezelfde cache raken
function volledigheidsRange(pct: number): string {
  if (pct <= 25)  return "0-25";
  if (pct <= 50)  return "26-50";
  if (pct <= 75)  return "51-75";
  return "76-100";
}

function buildCacheKey(p: Record<string, string | number>): string {
  return [
    (String(p.merk || "")).toLowerCase().trim(),
    (String(p.conditie || "")).toLowerCase().trim(),
    leeftijdRange(p.leeftijd),
    (String(p.vorm || "")).toLowerCase().trim(),
    volledigheidsRange(Number(p.volledigheid) || 0),
  ].join("|");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const body = await req.json();
    const {
      merk = "", type = "", kleur = "", conditie = "",
      leeftijd = "", vorm = "", buitenmaten = "",
      apparatuur = [], kasten_onder = "", kasten_boven = "", kasten_hoog = "",
      volledigheid = 50,
    } = body;

    const CLAUDE_API_KEY    = Deno.env.get("CLAUDE_API_KEY");
    const SUPABASE_URL      = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!CLAUDE_API_KEY) {
      return new Response(JSON.stringify({ error: "API key niet geconfigureerd" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 1. Check cache ──────────────────────────────────────
    const cacheKey = buildCacheKey({ merk, conditie, leeftijd, vorm, volledigheid });
    let cachedResult: Record<string, unknown> | null = null;

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const { data } = await sb
        .from("price_cache")
        .select("result, created_at")
        .eq("cache_key", cacheKey)
        .gte("created_at", cutoff)
        .maybeSingle();

      if (data?.result) {
        // Cache hit — stuur direct terug met cache-indicator
        const result = { ...data.result, _cached: true, _cached_at: data.created_at };
        return new Response(JSON.stringify(result), {
          status: 200, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
    }

    // ── 2. Cache miss — vraag Claude ────────────────────────
    const appList = Array.isArray(apparatuur) && apparatuur.length > 0
      ? apparatuur.map((a: { type?: string; merk?: string }) =>
          `${a.type || ""}${a.merk ? " (" + a.merk + ")" : ""}`).join(", ")
      : "geen / onbekend";

    const kastDetails = [
      kasten_onder ? `${kasten_onder} onderkasten` : "",
      kasten_boven ? `${kasten_boven} bovenkasten` : "",
      kasten_hoog  ? `${kasten_hoog} hoge kasten`  : "",
    ].filter(Boolean).join(", ") || "onbekend";

    const volledigheidsLabel = volledigheid >= 76 ? "uitstekend (76-100%)" :
      volledigheid >= 51 ? "goed (51-75%)" :
      volledigheid >= 26 ? "matig (26-50%)" : "minimaal (0-25%)";

    const prompt = `Je bent een expert in tweedehands keukenprijzen in Nederland.

Een verkoper wil zijn keuken aanbieden via een tweedehands platform. Geef een realistisch prijsadvies op basis van vergelijkbare advertenties op Marktplaats.nl.

**Keuken details:**
- Merk: ${merk || "onbekend"}
- Type/Serie: ${type || "onbekend"}
- Kleur: ${kleur || "onbekend"}
- Conditie: ${conditie || "onbekend"}
- Leeftijd: ${leeftijd ? leeftijd + " jaar" : "onbekend"}
- Vorm: ${vorm || "onbekend"}
- Maten: ${buitenmaten || "onbekend"}
- Kasten: ${kastDetails}
- Ingebouwde apparatuur: ${appList}

**Volledigheid van de gegevens: ${volledigheidsLabel} (score: ${volledigheid}/100)**

**Opdracht:**
Zoek op Marktplaats.nl naar vergelijkbare tweedehands keukens${merk ? ` van het merk ${merk}` : ""}. Zoek ook op 2dehands.be voor vergelijking.

Houd rekening met:
- Particuliere verkoop op Marktplaats is veel goedkoper dan commerciële aanbieders zoals Keukenloods Occasions, Revisite, of Kitchen Revolution — die vragen 2-4x meer omdat ze keukens nalopen en garantie geven. Focus op particuliere advertenties.
- Leeftijd en conditie wegen zwaar mee
- Populaire merken (IKEA/Metod, Siematic, Bulthaup, Miele-apparatuur) houden waarde beter
- **Pas de bandbreedte aan op de volledigheid**: bij minimale gegevens (score <26) geef je een brede, conservatieve range en adviseer je de onderkant; bij uitstekende gegevens (score >75) mag de range smaller en nauwkeuriger zijn. Ontbrekende informatie over apparatuur, maten of conditie betekent dat je van het slechtste geval uitgaat.

Geef een prijsadvies in dit JSON-formaat (ALLEEN JSON, geen uitleg erbuiten):
{
  "min": <getal in euro>,
  "max": <getal in euro>,
  "advies": <aanbevolen vraagprijs in euro>,
  "toelichting": "<2-3 zinnen in het Nederlands over hoe je tot dit bedrag komt en eventuele tips>",
  "bronnen": ["<url1>", "<url2>"]
}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(
        JSON.stringify({ error: "Claude API fout", detail: errText }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const claudeData = await response.json();
    let resultText = "";
    for (const block of claudeData.content || []) {
      if (block.type === "text") resultText += block.text;
    }

    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ error: "Geen prijsschatting ontvangen" }),
        { status: 422, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const priceData = JSON.parse(jsonMatch[0]);

    // ── 3. Sla op in cache ──────────────────────────────────
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await sb.from("price_cache").upsert(
        { cache_key: cacheKey, result: priceData, created_at: new Date().toISOString() },
        { onConflict: "cache_key" }
      );
    }

    return new Response(JSON.stringify(priceData), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Serverfout", detail: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
