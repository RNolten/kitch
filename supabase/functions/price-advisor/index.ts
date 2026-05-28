import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const body = await req.json();
    const {
      merk = "",
      type = "",
      kleur = "",
      conditie = "",
      leeftijd = "",
      vorm = "",
      buitenmaten = "",
      apparatuur = [],
      kasten_onder = "",
      kasten_boven = "",
      kasten_hoog = "",
    } = body;

    const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");
    if (!CLAUDE_API_KEY) {
      return new Response(JSON.stringify({ error: "API key not configured" }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Build a description of the kitchen for the prompt
    const appList = Array.isArray(apparatuur) && apparatuur.length > 0
      ? apparatuur.map((a: { type?: string; merk?: string }) => `${a.type || ""}${a.merk ? " (" + a.merk + ")" : ""}`).join(", ")
      : "onbekend";

    const kastDetails = [
      kasten_onder ? `${kasten_onder} onderkasten` : "",
      kasten_boven ? `${kasten_boven} bovenkasten` : "",
      kasten_hoog ? `${kasten_hoog} hoge kasten` : "",
    ].filter(Boolean).join(", ") || "onbekend";

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

**Opdracht:**
Zoek op Marktplaats.nl naar vergelijkbare tweedehands keukens${merk ? ` van het merk ${merk}` : ""}. Zoek ook op 2dehands.be voor vergelijking.

Houd rekening met:
- Particuliere verkoop op Marktplaats is veel goedkoper dan commerciële aanbieders zoals Keukenloods Occasions, Revisite, of Kitchen Revolution — die vragen 2-4x meer omdat ze keukens nalopen, opknappen en garantie geven. Focus op particuliere advertenties voor de prijsschatting.
- Leeftijd en conditie wegen zwaar mee
- Populaire merken (IKEA/Metod, Siematic, Bulthaup, Miele-apparatuur) houden waarde beter

Geef een prijsadvies in dit JSON-formaat (ALLEEN JSON, geen uitleg erbuiten):
{
  "min": <getal in euro, realistisch laag>,
  "max": <getal in euro, realistisch hoog>,
  "advies": <aanbevolen vraagprijs in euro>,
  "toelichting": "<2-3 zinnen in het Nederlands over hoe je tot dit bedrag komt, welke bronnen je zag, en eventuele tips voor de verkoper>",
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
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
          },
        ],
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Claude API error:", errText);
      return new Response(
        JSON.stringify({ error: "Claude API fout", detail: errText }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const claudeData = await response.json();

    // Extract the text content from the response
    let resultText = "";
    for (const block of claudeData.content || []) {
      if (block.type === "text") {
        resultText += block.text;
      }
    }

    // Parse the JSON from the response
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ error: "Geen prijsschatting ontvangen", raw: resultText }),
        { status: 422, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const priceData = JSON.parse(jsonMatch[0]);

    return new Response(JSON.stringify(priceData), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Edge Function error:", err);
    return new Response(
      JSON.stringify({ error: "Serverfout", detail: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
