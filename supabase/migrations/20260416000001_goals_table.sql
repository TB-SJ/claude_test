-- Savings goals table
CREATE TABLE IF NOT EXISTS budget_goals (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name          text NOT NULL,
  target_amount numeric(10,2) NOT NULL DEFAULT 0,
  saved_amount  numeric(10,2) NOT NULL DEFAULT 0,
  color         text NOT NULL DEFAULT '#6366f1',
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE budget_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own goals"
  ON budget_goals FOR ALL
  USING (auth.uid() = user_id);
