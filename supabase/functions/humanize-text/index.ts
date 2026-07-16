import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

function getCorsHeaders(requestOrigin?: string | null) {
  if (ALLOWED_ORIGIN !== "*") {
    const allowedOrigins = ALLOWED_ORIGIN.split(",").map((o) => o.trim());
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      return {
        "Access-Control-Allow-Origin": requestOrigin,
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
      };
    }
    return {
      "Access-Control-Allow-Origin": allowedOrigins[0],
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    };
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

interface HumanizeRequest {
  text: string;
  tone?: "neutral" | "casual" | "professional";
  creativity?: "low" | "medium" | "high";
  model?: string;
}

interface VoidAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const ANALYSIS_MODEL = "gpt-4.1-mini";
const DEFAULT_REWRITE_MODEL = "claude-sonnet-4-6";
const MAX_CHAR_LENGTH = 8000;

function rewriteSystemPrompt(tone: string, creativity: string): string {
  const toneInstruction =
    tone === "casual"
      ? "Use a casual, conversational voice — like a thoughtful person talking naturally, not an essay bot."
      : tone === "professional"
      ? "Use a polished, confident voice — not stiff or corporate — but clear and credible."
      : "Use a neutral, natural tone with plain language.";

  const creativityInstruction =
    creativity === "low"
      ? "Stick close to the original structure and wording."
      : creativity === "high"
      ? "Feel free to rephrase and restructure more liberally."
      : "Vary sentence length and rhythm naturally, but preserve the overall flow.";

  return `You are a humanizing editor. You receive: (1) the original text, (2) analysis notes flagging AI markers, and (3) a target tone.
Your job: rewrite the text so it reads like a real person wrote it.

Rules:
- Preserve the full meaning and all factual content.
- Remove or replace every AI-marked phrase and fix any structural issues noted in the analysis.
- ${toneInstruction}
- ${creativityInstruction}
- Vary sentence length and structure. Avoid robotic cadence.
- Do not add a preamble or label. Do not explain your changes.
- Output ONLY the final rewritten text.`;
}

async function callVoidAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string | null> {
  const res = await fetch("https://api.voidai.app/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VoidAI error (${res.status}): ${text}`);
  }

  const data: VoidAIResponse = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

serve(async (req) => {
  const requestOrigin = req.headers.get("Origin");
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Auth / JWT ---
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing authorization token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userId = userData.user.id;

  // --- Rate limit ---
  if (isRateLimited(userId)) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Parse body ---
  let body: HumanizeRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { text, tone, creativity, model } = body;

  if (!text || typeof text !== "string") {
    return new Response(JSON.stringify({ error: "Missing or invalid 'text' field" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (text.length > MAX_CHAR_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Text exceeds ${MAX_CHAR_LENGTH} character limit` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const effectiveTone: "neutral" | "casual" | "professional" =
    tone && ["neutral", "casual", "professional"].includes(tone)
      ? tone
      : "neutral";

  const effectiveCreativity: "low" | "medium" | "high" =
    creativity && ["low", "medium", "high"].includes(creativity)
      ? creativity
      : "medium";

  const rewriteModel = model || DEFAULT_REWRITE_MODEL;

  const voidAiApiKey = Deno.env.get("VOIDAI_API_KEY");
  if (!voidAiApiKey) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing API key" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Pass 1: GPT-4.1-mini analysis ---
  const analysisSystemPrompt = `You are a precise text analyst. Read the user's text and produce 3-5 brief bullet points (plain text, one line each) noting:
1. Any AI-marker phrases (e.g. "Furthermore", "In conclusion", "It is important to note", "Delve into", "In today's world").
2. Overly parallel or repetitive sentence structures.
3. Tone mismatches (if any).
Be terse. No extra commentary. Numbered bullet points are fine.`;

  let analysisNotes: string;
  try {
    analysisNotes =
      (await callVoidAI(
        voidAiApiKey,
        ANALYSIS_MODEL,
        analysisSystemPrompt,
        text
      )) || "No analysis notes.";
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Pass 2: Claude Sonnet rewrite ---
  const userContentForRewrite = `=== ORIGINAL TEXT ===
${text}

=== ANALYSIS NOTES ===
${analysisNotes}

=== TONE ===
${effectiveTone}

=== CREATIVITY ===
${effectiveCreativity}`;

  let rewritten: string;
  try {
    rewritten =
      (await callVoidAI(
        voidAiApiKey,
        rewriteModel,
        rewriteSystemPrompt(effectiveTone, effectiveCreativity),
        userContentForRewrite
      )) || text;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Rewrite failed: ${err instanceof Error ? err.message : String(err)}` }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      text: rewritten,
      analysis: analysisNotes,
      tone: effectiveTone,
      creativity: effectiveCreativity,
      model: rewriteModel,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
