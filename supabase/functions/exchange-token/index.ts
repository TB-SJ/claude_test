// Supabase Edge Function: exchange-token
// Exchanges a Plaid public_token for an access_token and stores it securely.
// Deploy: supabase functions deploy exchange-token

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET    = Deno.env.get("PLAID_SECRET")!;
const PLAID_ENV       = Deno.env.get("PLAID_ENV") ?? "development";
const PLAID_BASE      = `https://${PLAID_ENV}.plaid.com`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");

    // Verify caller is authenticated
    const sbUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await sbUser.auth.getUser();
    if (authErr || !user) throw new Error("Unauthorized");

    const { public_token, institution_name } = await req.json();
    if (!public_token) throw new Error("Missing public_token");

    // Exchange with Plaid
    const res = await fetch(`${PLAID_BASE}/item/public_token/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:    PLAID_CLIENT_ID,
        secret:       PLAID_SECRET,
        public_token,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error_message ?? "Plaid exchange error");

    // Store access_token using service role (bypasses RLS) — never expose to client
    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { error: dbErr } = await sbAdmin.from("budget_connections").upsert({
      user_id:          user.id,
      item_id:          json.item_id,
      access_token:     json.access_token,
      institution_name: institution_name ?? "My Bank",
    }, { onConflict: "item_id" });
    if (dbErr) throw new Error(dbErr.message);

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
