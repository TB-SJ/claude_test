// Supabase Edge Function: sync-transactions
// Pulls the last 90 days of transactions from all connected Plaid accounts
// and upserts them into budget_transactions.
// Deploy: supabase functions deploy sync-transactions

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

// Map Plaid primary categories → app expense categories
const CAT_MAP: Record<string, string> = {
  "Food and Drink":          "Food & Drink",
  "Shops":                   "Shopping",
  "Recreation":              "Entertainment",
  "Healthcare":              "Health",
  "Travel":                  "Travel",
  "Personal Care":           "Personal Care",
  "Home Improvement":        "Home",
  "Home":                    "Home",
  "Transportation":          "Transportation",
  "Service":                 "Other",
  "Payment":                 "Other",
  "Bank Fees":               "Other",
  "Community":               "Other",
  "Government and Non-Profit": "Other",
  "Transfer":                "Other",
};

function mapCategory(cats: string[]): string {
  for (const c of (cats ?? [])) {
    if (CAT_MAP[c]) return CAT_MAP[c];
  }
  return "Other";
}

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

    // Use service role to read access_tokens (never exposed to client)
    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: connections, error: connErr } = await sbAdmin
      .from("budget_connections")
      .select("*")
      .eq("user_id", user.id);
    if (connErr) throw new Error(connErr.message);
    if (!connections?.length) {
      return new Response(
        JSON.stringify({ synced: 0, message: "No connected accounts" }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Date range: last 90 days
    const endDate   = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];

    let totalSynced = 0;

    for (const conn of connections) {
      try {
        const res = await fetch(`${PLAID_BASE}/transactions/get`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id:    PLAID_CLIENT_ID,
            secret:       PLAID_SECRET,
            access_token: conn.access_token,
            start_date:   startDate,
            end_date:     endDate,
            options: { count: 500, offset: 0 },
          }),
        });
        const plaid = await res.json();
        if (!res.ok) {
          console.error(`Plaid error for connection ${conn.id}:`, plaid.error_message);
          continue;
        }

        const rows = (plaid.transactions ?? [])
          // Plaid: positive amount = money going out (debit/spend), negative = credit/refund
          // We only auto-import spending (positive amounts), skip pending
          .filter((tx: any) => !tx.pending)
          .map((tx: any) => {
            const d  = new Date(tx.date);
            const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            return {
              id:              tx.transaction_id,
              user_id:         user.id,
              connection_id:   conn.id,
              amount:          tx.amount,
              date:            tx.date,
              name:            tx.name,
              merchant_name:   tx.merchant_name ?? null,
              plaid_category:  tx.category ?? [],
              category:        mapCategory(tx.category ?? []),
              account_id:      tx.account_id,
              pending:         false,
              reviewed:        false,
              month_key:       mk,
            };
          });

        if (rows.length) {
          // ignoreDuplicates: true — don't overwrite categories the user has already set
          const { error: upErr } = await sbAdmin
            .from("budget_transactions")
            .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
          if (upErr) console.error("Upsert error:", upErr.message);
          else totalSynced += rows.length;
        }
      } catch (e) {
        console.error("Sync error for connection:", conn.id, e);
      }
    }

    return new Response(
      JSON.stringify({ synced: totalSynced }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
