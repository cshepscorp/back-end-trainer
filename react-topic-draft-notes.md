# New quiz topics — working notes (not yet built)

Two new topics decided so far, both pulled from Christy's separate React
refresher chat (https://claude.ai/share/c74b7db0-3a62-4508-bbe3-2bf0fdb0d556):

- **`react`** — separate from `frontend` ("Frontend terms" stays general
  vocab/terminology — Vite vs. Next.js, rendering strategies, etc. are
  already covered there). `react` is for deeper, hands-on hook/lifecycle
  mechanics.
- **`typescript`** — separate from both `react` and `javascript`, decided
  2026-07-14. The generics content below surfaced in a React context but
  Christy called it out as its own topic to be quizzed on.

Christy will likely have more to add later today — holding off on actually
building either topic out until she's done feeding in content, so it gets
built once instead of piecemeal. This file is just the running backlog.

**Checkpoint: we left off at the useMemo/useCallback/React.memo real-world
use-cases section of the source conversation** (item 9 under `react`
below). If Christy goes back to that other chat, that's the spot to
resume reading from for anything further.

## What "standing up" each topic will actually require, once we build them

- `daily-quiz-app/src/data/topics.json` — one new entry per topic (ids:
  `react`, `typescript`; labels + accent colors TBD — currently used
  accents: teal, blue, purple, orange, green, amber, coral, cyan, lime,
  rose, indigo, slate, gold, violet, sky, synth)
- `docs/quiz.html` — topic filter dropdown option for each, plus the new
  questions themselves (`rc1`, `rc2`, ... for react; `ts1`, `ts2`, ... for
  typescript — both unused prefixes)
- `docs/index.html` — question count update (currently 167)
- New reference pages: `docs/react-fundamentals.html` and
  `docs/typescript-fundamentals.html`, following the same pattern as
  `javascript-fundamentals.html` (analogy-box / info-card / code-block
  sections, one per concept, plus a closing decision-box)
- `daily-quiz-app/src/data/questions.json` — sync new questions in
  (learned the hard way this session that this file does NOT auto-update
  from quiz.html — ne11/ne12 sat missing from it for a while before we
  caught it)
- Reseed whichever backend is live once pushed

## `react` content backlog — reviewed for accuracy, ready to turn into
actual MC/flip questions once we build this out

1. **Functional setState updater form** — why `setCount(prev => prev + 1)`
   called twice in the same handler correctly accumulates (+2), while
   `setCount(count + 1)` called twice does not. `prev` isn't special to
   React — it's just a parameter name; React inspects whether you passed a
   value or a function and, for a function, calls it with whatever's
   currently queued as pending state. The plain-value form instead reads
   `count` as a frozen closure snapshot from that render.

2. **Render vs. mount vs. unmount** — mount is just the name for a
   component's first render, not a separate mechanism. The dependency array
   isn't "runs after mount, and again separately when deps change" — it's
   one rule: run the effect after any render where a listed dependency's
   value differs from the previous render. Mount always qualifies because
   there's no previous render to compare against yet.

3. **Cleanup fires on both a re-run AND a true unmount** — same cleanup
   function, two different triggers. A dependency change fires cleanup
   right before the effect re-runs (component still alive); removing the
   component from the tree entirely fires cleanup as a real unmount
   (component gone, no next run follows). Good practice example already
   drafted: a `[count]`-dependent logging effect where clicking increments
   fires "cleanup" every time (re-run case), and toggling the component's
   visibility off fires it once for a genuine unmount, with no further log
   after it.

4. **React 18 Strict Mode double-invoke (dev only)** — Vite's `react-ts`
   template wraps the app in `<React.StrictMode>`, which intentionally
   mounts a component, immediately runs cleanup, then mounts again — to
   help surface effects with missing/broken cleanup. Only happens in dev;
   production mounts once as expected. Explains the "mounted / cleaning up
   / mounted" double-fire beginners often see and assume is a bug.

5. **useEffect's async gotcha** — the function passed directly to
   `useEffect` can only return nothing or a cleanup function. Marking it
   `async` makes it implicitly return a Promise instead, which React would
   wrongly treat as the cleanup function. Fix: define a separate inner
   async function and call it, rather than making the effect callback
   itself async.

6. **Fresh mount confirmation** — confirmed directly: unhiding a
   conditionally-rendered component (`{isVisible && <Counter />}`) is a
   brand-new mount, not a resumed one, so any local state resets to its
   initial value (count back to 0) — no memory of the torn-down instance
   carries over. Good as a quick "does X reset or not" check-your-
   understanding question rather than a deep concept on its own.

7. **Rules of Hooks — condition the value, never the call** — a
   genuinely subtle distinction, and one the source conversation itself
   initially conflated (worth preserving that correction, it's a good
   teaching moment): `useState(30)` called unconditionally is already the
   entire fix for a conditional-hooks bug — full stop, no `useEffect`
   required. `showExtra ? age : null` is fine — conditioning what you *do*
   with a hook's returned value is completely normal. What's never allowed
   is conditioning whether the hook gets *called* at all (e.g. wrapping a
   `useEffect` call itself in `if (showExtra) { useEffect(...) }` is just
   as broken as conditionally calling `useState` — same slot-shifting
   disease, different hook). The fix is always the same shape: call the
   hook unconditionally, move the `if` inside its body/callback instead.

8. **useMemo vs. useCallback vs. React.memo — practical use cases**
   (SUPERSEDED — see the full rewritten version below; keeping this note
   just to record that the original short bullet-list draft turned out to
   be "super unclear" per Christy's own words, specifically on whether
   `useCallback` only matters alongside `React.memo`). The expanded
   version below is the one to actually use for reference content —
   already written in clean, copy-paste-ready markdown, verbatim:

   > #### Bonus, optional but likely to come up: `useMemo`, `useCallback`, `React.memo`
   >
   > **The foundational thing to understand first — before any of these three make sense:**
   >
   > Every time a component re-renders, any function or object created *inside* that render is a brand-new value in memory, even if it does/contains exactly the same thing as last time:
   >
   > ```typescript
   > function outer() {
   >   return () => console.log('hi');
   > }
   >
   > const fn1 = outer();
   > const fn2 = outer();
   > console.log(fn1 === fn2); // false — different objects, identical behavior
   > ```
   >
   > Normally this is completely harmless — React just calls whatever function is there when it needs to, and never checks whether it's "the same one as before." **It only becomes a problem the moment something else starts comparing that value's identity between renders** — which is exactly what `React.memo` and dependency arrays do. That's the thread connecting all three of these.
   >
   > ---
   >
   > **`useMemo`** — caches an expensive *computed value*, recalculating only when a dependency changes.
   >
   > ```typescript
   > // DataChart.tsx — recalculating stats over a large dataset on every render
   > // (e.g. every time a sibling component causes DataChart to re-render)
   > // is wasted work if `filtered` hasn't actually changed.
   > const stats = useMemo(() => {
   >   const total = filtered.reduce((sum, row) => sum + row.value, 0);
   >   const average = total / filtered.length;
   >   return { total, average, count: filtered.length };
   > }, [filtered]);
   > ```
   >
   > **Why not `useEffect` + state for this?** `useEffect` runs *after* React commits the render to the screen — so the user would briefly see stale/default stats, then watch them flicker to correct once the effect runs and triggers a second re-render. `useMemo` runs *during* the render itself, so by the time the JSX is returned, `stats` already reflects the current `filtered` — no flash, no extra render, no separate state variable needed just to hold a derived value. General rule: deriving a value from data you already have is a calculation, not a synchronization with something external — so it belongs directly in the render body (`useMemo` only added if that calculation is genuinely expensive).
   >
   > **Lifecycle note:** no mount/unmount/cleanup concept exists here — there's nothing being set up that needs tearing down, just a value being computed. It recomputes whenever the current render's dependencies differ from the previous render's — including the very first render, since there's no "previous" to compare against yet.
   >
   > ---
   >
   > **`useCallback`** — caches a *function reference itself*, so the same function identity survives across re-renders instead of a new one being created every time.
   >
   > ```typescript
   > // App.tsx — without useCallback, handleFilterChange is a brand-new
   > // function on every App render, which would defeat FilterPanel's React.memo
   > const handleFilterChange = useCallback((key: string, value: string) => {
   >   setFilter(key, value);
   > }, [setFilter]);
   >
   > <FilterPanel onFilterChange={handleFilterChange} />
   > ```
   >
   > **Important: `useCallback` only matters when something is actually comparing that function's identity between renders.** The two real cases:
   > 1. The function is passed as a prop to a **`React.memo`-wrapped** child — `memo`'s whole job is comparing new props to old props, and an unstable function reference would always look "changed" even when the logic inside is identical, defeating the memoization.
   > 2. The function is used inside **another hook's dependency array** (e.g. a `useEffect` in the child depends on the callback prop) — same problem, different consumer of the comparison.
   >
   > If neither of those applies — the child isn't memoized, and nothing depends on this function elsewhere — `useCallback` is doing nothing for you but adding complexity. A fresh function every render is free unless someone's checking.
   >
   > ---
   >
   > **`React.memo`** — skips re-rendering a component if its props are shallowly unchanged.
   >
   > ```typescript
   > // DataTable.tsx — if App re-renders often (e.g. a live-updating counter
   > // elsewhere on the page) but the table's own data/filters haven't changed,
   > // React.memo skips re-rendering the (potentially large) table unnecessarily.
   > export const DataTable = React.memo(function DataTable() {
   >   const data = useDataStore((state) => state.data);
   >   const filters = useDataStore((state) => state.filters);
   >   // ...
   > });
   > ```
   >
   > **The catch that ties back to `useCallback`:** `React.memo` only helps if the props it's comparing are actually stable. If a parent passes a callback prop that's recreated every render, wrapping the child in `memo` accomplishes nothing on its own — the prop check will report "changed" every time regardless. That's the entire reason `useCallback` and `React.memo` are usually mentioned together: `memo` does the comparing, `useCallback` is what makes the comparison actually succeed.
   >
   > **Honest caveat for all three:** these exist to fix a *measured* re-render problem, not to sprinkle in by default — reaching for them without a real performance issue usually just adds complexity for no benefit.

   This rewritten version is what should actually go into
   `react-fundamentals.html` when we build it — treat the bullet-list
   version as dead/replaced.

9. **Why not just useEffect instead of useMemo for a derived value?** —
   a sharp follow-up worth keeping as its own question, since it's a
   canonical example from React's own "You Might Not Need an Effect"
   guidance. Walking the `useEffect` version step by step: `filtered`
   changes → component re-renders with `stats` still stale (effects run
   *after* the render commits to the screen, not during it) → user
   visibly sees the old numbers painted → effect then runs, computes the
   real values, calls `setStats(...)` → that state update triggers a
   *second* re-render, only now showing the correct numbers. So the
   `useEffect` approach costs a visible stale-data flash plus an extra
   render cycle, and requires inventing an extra piece of state
   (`stats`) just to hold something fully derivable from `filtered`.
   `useMemo` instead runs synchronously during the render itself, so by
   the time JSX is returned there's no "catch up later" step. The
   generalizable principle: `useEffect` exists to synchronize with
   something *outside* React (subscriptions, fetches, DOM APIs);
   deriving one in-hand value from another isn't synchronizing with
   anything external, so reaching for `useEffect` + extra state here is
   the "effect used for something that isn't really a side effect"
   anti-pattern the React docs specifically warn about — wrong tool, not
   just a slower one. Bonus fact worth keeping: you could skip `useMemo`
   entirely too — plain inline calculation during render, no hook at
   all — which also avoids the flash; `useMemo` only earns its keep once
   the calculation is expensive enough to be worth caching.

10. **useMemo's lifecycle vs. useEffect's** — confirmed and refined: yes,
    `useMemo` recomputes on mount and whenever a listed dependency
    changes, full stop — but framed as *one* rule rather than two cases,
    same reframing as mount-vs-rerender for `useEffect`: it recomputes
    whenever the current render's deps differ from the previous render's,
    and mount always qualifies since there's no previous render to
    compare against yet. Bigger distinction: `useMemo` has no
    mount/unmount/cleanup concept at all — `useEffect` needs cleanup
    because it can set up things (subscriptions, listeners, in-flight
    requests) that need tearing down; `useMemo` only computes and hands
    back a value, so there's nothing left dangling once render finishes,
    hence no second/cleanup-returning argument exists for it. The actual
    mechanical reason `useMemo` avoids the flicker `useEffect` caused:
    it's a timing difference, not just a "fewer phases" difference —
    `useEffect` runs *after* React commits/paints the render;
    `useMemo` runs *during* the render itself, before anything paints.

11. **Honest caveat on useMemo** — React's own docs note `useMemo` is
    officially a performance *hint*, not a hard guarantee: in rare cases
    (e.g. memory pressure) React is technically permitted to discard a
    memoized value and recompute it even though dependencies didn't
    change. Practically this essentially never bites you day to day, but
    it's *why* the React team says never to rely on `useMemo` for
    correctness (e.g. preserving object referential identity for a
    `===` check) — only for performance.

    **← We left off here.** This was the last thing covered in the source
    conversation as of this note.

12. **Controlled vs. uncontrolled components** — requested directly by
    Christy (not pulled from the source conversation, drafted fresh):
    - **Controlled**: the input's displayed value is driven entirely by
      React state — `value={state}` plus `onChange={e => setState(e.target.value)}`.
      React is the single source of truth; the DOM never holds a value
      React doesn't already know about.
    - **Uncontrolled**: the DOM itself holds the current value; React
      doesn't track it on every keystroke. You read it only when needed —
      typically via a `ref` (`inputRef.current.value`) — and set an
      initial value with `defaultValue` rather than `value`.
    - **Why choose one over the other**: controlled gives you live
      validation/formatting, the ability to programmatically reset or
      sync a value, and one source of truth across multiple related
      inputs — at the cost of a re-render on every keystroke (rarely an
      actual perf problem for typical forms). Uncontrolled is simpler for
      "just grab the value at submit time" cases and avoids that
      per-keystroke render, but makes live validation/reset harder since
      the value isn't known until you go look at the DOM for it.
    - **Concrete gotcha worth having cold**: `<input type="file">`
      *cannot* be controlled — browsers disallow programmatically setting
      a file input's value for security reasons (a page shouldn't be able
      to fake a file selection), so it's always uncontrolled, read via a
      `ref` when needed.
    - **Classic warning to recognize**: "A component is changing an
      uncontrolled input to be controlled" (or the reverse). Happens when
      state starts as `undefined` (so React treats the input as
      uncontrolled on first render) and later gets a real value (flipping
      it to controlled) — React doesn't allow switching modes mid-life.
      Fix: always initialize state to a defined value (e.g. `''` not
      `undefined`) so the input is controlled from the very first render
      onward and never switches.
    - **Concrete worked example (this part actually from the source
      conversation, tracing a real `FilterPanel`/Zustand `<select>`)** —
      good candidate for a flip question walking through the full chain
      rather than just stating the definition:
      ```typescript
      const { filters, setFilter } = useDataStore(); // filters starts as {}

      <select
        value={filters.category || ''}
        onChange={(e) => setFilter('category', e.target.value)}
      >
        <option value="">All Categories</option>
        <option value="marketing">Marketing</option>
      </select>
      ```
      Trace: `filters` starts as `{}`, so `filters.category` is
      `undefined` → `undefined || ''` evaluates to `''` → the select's
      value is `''`, matching the "All Categories" option, which is why
      that one shows selected initially. When the user picks "Marketing":
      `onChange` fires → `setFilter('category', 'marketing')` → Zustand
      updates the store to `{ category: 'marketing' }` → component
      re-renders → `filters.category || ''` now evaluates to `'marketing'`
      → the select updates to show it. The key insight worth stating
      explicitly: **the DOM never "owns" the value at any point in that
      chain** — every change flows user action → `onChange` → state
      update → re-render → JSX reflects the new state. That round trip,
      not just "value comes from a variable," is what "controlled" means
      in practice.

## `typescript` content backlog

1. **Generics (`<T>`)** — walked through via a `useDebounce<T>` hook. `<T>`
   is a placeholder for a type, same idea as a function parameter being a
   placeholder for a value — lets you write one function that works across
   many types while TypeScript still tracks exactly which type was used at
   each call site. Contrasted against the two bad alternatives: hardcoding
   a single type (not reusable) and using `any` (reusable, but throws away
   all type-checking on the result). Covered type inference too — you
   don't write `useDebounce<string>(x, 300)` yourself; TypeScript infers
   `T` from whatever you actually pass in. Ties back to an earlier
   `useFetch<T>` example using the identical pattern. Good analogy already
   drafted: a generic function is a shipping label template with a blank
   "contents" field — same packing/shipping logic every time, but it still
   records precisely what's actually inside, vs. `any` being a permanently
   blank field.

## Explicitly decided NOT to include (either topic)

- The two 2026 axios security incidents (compromised-maintainer supply
  chain attack; a prototype-pollution/SSRF CVE) — accurate as discussed,
  but time-stamped news rather than a durable interview concept, and past
  my own reliable knowledge cutoff to independently verify. Not good
  long-term quiz material.
- Vite vs. Next.js — already covered under `frontend` (`ft4`, `ft5`, and a
  rendering-strategies comparison). Not duplicating in `react`.
- Named vs. default exports / module namespace objects — already added to
  `javascript` this session (`js14`, `js15`), not React-specific.
- fetch vs. axios — already added to `javascript` this session (`js12`,
  `js13`).

## Still open / waiting on Christy

- Whatever additional material she pulls from the rest of today's React
  refresher session (resuming from the useMemo/useCallback/React.memo
  checkpoint above).
- Exact labels + accent colors for both `react` and `typescript`.
- Whether `useContext` and custom hooks (the `use` naming rule) — mentioned
  as "queued up" in the shared conversation but not yet actually discussed
  in depth there — should get written from scratch for `react` too, since
  the source conversation only listed them as topics to revisit.
