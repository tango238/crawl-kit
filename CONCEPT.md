# crawl-kit

**It tells you whether the software you *intended*, the software you *built*, and the software that's *running* are the same software.**

---

## The problem

Every project carries three versions of itself, and they drift apart silently:

| | what it is | where it comes from |
|---|---|---|
| **Intent** | what we *meant* to build | domain modeling / the glossary |
| **Structure** | what we *actually* built | the source code, read statically |
| **Behavior** | what actually *runs* | the live app, crawled and verified |

Nobody sets out to ship something different from what they designed. It happens one reasonable commit at a time. The cost shows up later — as the bug nobody can explain, the model no new hire can trust, the decision everyone forgot.

Most tools show you *one* of these three. Looking at three separate pictures doesn't help: you end up flipping between diagrams that use different names for the same thing and doing the join in your head. **More views, not more understanding.**

## What this does instead

It doesn't stack three pictures. It draws the **edges between them** and colours the ones that disagree.

```
                 INTENT  (distill-ddd)
                 /                  \
   "did we build      "did the business get
    what we meant?"    what it asked for?"
              /                        \
 STRUCTURE ───────────────────────── BEHAVIOR
 (rdra-analyzer)  "does it run as       (loop-e2e)
                   it was built?"
```

- **Intent ↔ Structure** — did we build what we meant?
- **Structure ↔ Behavior** — does it run the way it was built?
- **Intent ↔ Behavior** — did the business get what it asked for?

Pick one concept — say `Order` — and you see its intent, its tables, and its runtime findings side by side, with the disagreements lit up. The value was never in the three pictures. It was always in the gaps between them.

## How it stays simple

One spine: a **canonical registry**. Every concept gets one id and one name. The glossary issues the names; the structure and behavior tools tag their output with the same ids. Once everything is strung on the same ids, "one place" is just a join — not a translation problem.

A separate **reconciler** keeps the spine honest. It proposes which things are the same (with *evidence*, not a vague score), auto-resolves the confident matches in whichever direction you choose, and sends only the genuinely ambiguous ones to a human queue. Your decisions get burned into the registry, so the next run only asks about what's *new*.

## Reading the colours

Not everything that's "in the code but not in the model" is a defect — and treating it as one is how you lose people's trust. So a concept is never just *match / mismatch*. It's one of:

- **aligned** — consistent across the layers it should be in
- **intent-only** — designed, not built yet
- **aggregate-internal** — not an orphan; it lives *inside* a concept you already matched
- **implementation-detail** — accepted below the domain line (join tables, sessions, outbox)
- **adjudicated** — it diverges, but a recorded decision (ADR) explains why
- **violates-decision** — it diverges *and* breaks a decision you made on purpose ← the one worth your morning

That last row is the point. When an architecture decision says *"Payment must not depend on Shipping"* and the code grows that dependency anyway, this is the tool that can *compute* the violation — from the structure graph and the decision record — instead of waiting for it to bite.

## The three tools

This suite doesn't replace them; it gives them a shared spine.

- [**distill-ddd**](https://github.com/tango238/distill-ddd) — interactive DDD modeling. Owns **intent**. Issues the canonical names.
- [**rdra-analyzer**](https://github.com/tango238/rdra-analyzer) — static extraction of usecases / information model. Owns **structure**.
- [**loop-e2e**](https://github.com/tango238/loop-e2e) — AI-driven crawl + verification loop. Owns **behavior**.

---

*If you only remember one sentence: the suite keeps three versions of your software pointed at the same truth — and shows you, in one place, exactly where they stopped agreeing.*
