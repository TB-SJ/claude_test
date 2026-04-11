-- ============================================================
-- Migration: Plaid bank connectivity tables
-- Run this in Supabase → SQL Editor before deploying edge functions
-- ============================================================

-- Also add paid_history column if not already done
ALTER TABLE budget_bills ADD COLUMN IF NOT EXISTS paid_history jsonb DEFAULT '{}'::jsonb;
ALTER TABLE budget_bills ADD COLUMN IF NOT EXISTS due_day int;

-- ── budget_connections ──────────────────────────────────────
-- Stores one row per connected bank / credit card account.
-- access_token is the Plaid credential — never expose this to the frontend.
CREATE TABLE IF NOT EXISTS budget_connections (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  institution_name text        NOT NULL DEFAULT 'My Bank',
  item_id          text        UNIQUE NOT NULL,
  access_token     text        NOT NULL,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE budget_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own connections" ON budget_connections;
CREATE POLICY "Users manage own connections" ON budget_connections
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── budget_transactions ─────────────────────────────────────
-- Raw transactions imported from Plaid.
-- id = Plaid transaction_id (string) — ensures idempotent syncs.
-- amount: positive = spending/debit (Plaid convention).
-- reviewed: false = needs user action (import or ignore).
CREATE TABLE IF NOT EXISTS budget_transactions (
  id              text        PRIMARY KEY,
  user_id         uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  connection_id   uuid        REFERENCES budget_connections(id) ON DELETE SET NULL,
  amount          numeric     NOT NULL,
  date            date        NOT NULL,
  name            text,
  merchant_name   text,
  category        text        NOT NULL DEFAULT 'Other',
  plaid_category  text[],
  account_id      text,
  pending         boolean     NOT NULL DEFAULT false,
  reviewed        boolean     NOT NULL DEFAULT false,
  month_key       text,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE budget_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own transactions" ON budget_transactions;
CREATE POLICY "Users manage own transactions" ON budget_transactions
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast pending-transaction lookups
CREATE INDEX IF NOT EXISTS budget_transactions_user_reviewed
  ON budget_transactions (user_id, reviewed, date DESC);
