// Supabase Edge Function: create-link-token
// Creates a Plaid Link token so the frontend can open the Plaid Link widget.
// Deploy: supabase functions deploy create-link-token

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET    = Deno.env.get("PLAID_SECRET")!;
const PLAID_BASE      = "https://development.plaid.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");

    // Verify the caller is a real authenticated user
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) throw new Error("Unauthorized");

    // Ask Plaid for a link token scoped to this user
    const res = await fetch(`${PLAID_BASE}/link/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:    PLAID_CLIENT_ID,
        secret:       PLAID_SECRET,
        client_name:  "Personal Budget",
        user:         { client_user_id: user.id },
        products:     ["transactions"],
        country_codes: ["US"],
        language:     "en",
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error_message ?? "Plaid error");

    return new Response(
      JSON.stringify({ link_token: json.link_token }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
