# Code Review: Estimate Vs BIM (1).json

**Reviewed:** 2026-03-17
**App:** Estimate Vs BIM — Retool export

---

## App Overview

A 4-page Retool app comparing construction estimates against BIM (Building Information Modeling) data for MEP pipe, valves, and fittings. Backed by Supabase.

**Pages:**
- `login` — Supabase email/password auth
- `Estimate_Vs_BOM` — Main comparison tables with filters and drill-down modals
- `Dashboard` — Charts (waterfall, bar, pie, scatter, heatmap)
- `File_Upload_Testing` — BIM and estimate XLSX file upload

---

## Bugs

### 1. Broken auth guard pattern (affects ~6 queries)

Several queries use this pattern:

```js
if (! { access_token }) {
  return { error: "Auth not ready" };
}
```

`{ access_token }` is a JavaScript **object literal**, not a variable reference. An object is always truthy, so `! { access_token }` is always `false` — the guard never fires. These queries will proceed even when `access_token` is `undefined`.

**Affected queries:** `projectSelectQuery`, `bimEstPipeComparisonData`, `bimEstValvesComparisonData`, `bimEstFittingsComparisonData`, `bimEstPipeWithMaterial`, `bimEstPipePlanComparisonData`, `projectSelectorQuery` (File Upload page)

**Fix:**
```js
// Wrong
if (! { access_token }) { ... }

// Correct
if (!access_token) { ... }
```

---

### 2. `clearFiltersScript2` resets only 2 of 6 filters

`clearFiltersScript` (Estimate_Vs_BOM page) correctly resets all 6 filters:
```js
searchMaterial.resetValue();
filterByVariance.setValue('all', false);
areaFilter.resetValue();
floorFilter.resetValue();
systemFilter.resetValue();
diameterFilter.resetValue();
costCodeFilter.resetValue();
```

`clearFiltersScript2` (Dashboard page) only resets 2:
```js
searchMaterial2.resetValue();
filterByVariance2.setValue('all', false);
```

If the Dashboard has `areaFilter2`, `floorFilter2`, `systemFilter2`, and `diameterFilter2` (which exist in the component list), they won't clear when the user clicks "Clear Filters."

**Fix:** Mirror the full reset in `clearFiltersScript2`.

---

### 3. `restoreSession` triggered redundantly after login

In `store_login`, after a successful login the final line is:
```js
restoreSession.trigger();
```

`restoreSession` reads from `localStorage` and triggers a token refresh. But login just finished setting those values — so this causes an immediate unnecessary token refresh cycle. There's no benefit and it adds latency.

**Fix:** Remove `restoreSession.trigger()` from `store_login`. Session state is already set correctly at that point.

---

### 4. `query4` is not valid SQL

```sql
SELECT {{ sessionReady.value }}
WHERE {{ sessionReady.value }} == true
```

`WHERE ... == true` is not valid SQL syntax, and `SELECT <scalar>` without a `FROM` clause only works in some databases. The intent seems to be gating other queries on session readiness, but this approach is fragile and may throw errors.

**Recommendation:** Use Retool's built-in query "Run when" / trigger conditions to gate on `sessionReady.value === true`, rather than routing through a SQL query.

---

## Code Quality Issues

### 5. No HTTP error handling on most fetch calls

Most data queries use:
```js
return fetch(url, { ... }).then(r => r.json());
```

If Supabase returns a 4xx or 5xx (e.g., expired token, missing table, rate limit), `r.json()` still resolves — but with a Supabase error object like `{ message: "...", code: "..." }`. This silently flows into your tables/transformers as if it were real data.

The upload handlers and some bucket lookup queries do check `r.ok` — that pattern should be applied consistently.

**Fix (consistent pattern):**
```js
return fetch(url, { ... }).then(r => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});
```

---

### 6. `select=*` with no pagination on main data tables

The primary comparison queries (`bimEstPipeComparisonData`, `bimEstValvesComparisonData`, `bimEstFittingsComparisonData`) fetch all rows with `select=*` and no `limit`. This is fine for current dataset sizes but will degrade as data grows.

The raw data tables (`estRawDataQuery`, `bimRawData`) already implement table-controlled pagination correctly — that same approach should be applied to the comparison tables if row counts become large.

---

### 7. Duplicate query sets across pages

The full set of data queries, transformers, and filter logic from `Estimate_Vs_BOM` is duplicated on the `Dashboard` page (queries suffixed with `2`, `3`). They appear functionally identical.

This creates double the maintenance surface — any bug fix or schema change needs to be applied twice. Consider using a Retool module or shared state to unify the data layer.

---

### 8. `supabaseApiKey_LM_dev` — dev key in use

All queries reference `retoolContext.configVars.supabaseApiKey_LM_dev`. The `_dev` suffix suggests this is a development key. Confirm a separate production config var is set up before any production deployment.

---

## Summary

| # | Severity | Issue |
|---|----------|-------|
| 1 | High | Auth guard `! { access_token }` is always false — no-op |
| 2 | Medium | `clearFiltersScript2` missing 4 filter resets |
| 3 | Low | Redundant `restoreSession.trigger()` call after login |
| 4 | Low | `query4` uses invalid SQL syntax |
| 5 | Medium | No HTTP error handling on most fetch calls |
| 6 | Low | `select=*` without pagination on main tables |
| 7 | Low | Full query/transformer set duplicated across two pages |
| 8 | Low | Confirm dev API key is not used in production |

The highest-priority fix is **#1** — those auth guards are silently broken and will allow unauthenticated requests to proceed. Fix #2 is a quick win that would otherwise confuse users when filters don't fully clear on the Dashboard.
