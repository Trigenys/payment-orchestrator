# Engineering lessons learned

This file is the RAIDER failure-memory log for Payment Orchestrator.

## 2026-10-04 — Bootstrap opened a premature 1.0.0 release PR

### Context and impact

The generic AppFactory service blueprint included a release workflow triggered on every push to `main`. The AppFactory bootstrap commit used a conventional `feat` message, so Release Please immediately opened a `1.0.0` release PR even though the product had no frozen API or provider implementation.

No release was merged or published.

### Root cause

A generic generator embedded a product-level release policy before the product had declared its versioning/readiness policy.

### Resolution

The generated release PR was closed. Payment Orchestrator release automation is manual-only until the public API/SDK contract is explicitly frozen.

### Prevention

Generic service blueprints should avoid automatic semantic releases from bootstrap commits. Release automation must be opt-in or manual until a generated product chooses its release policy.

### General lesson

Repository scaffolding may provide release *mechanics*, but it must not infer release *readiness*.

---

Future meaningful failures and near misses must record:
- context and impact;
- root cause;
- resolution;
- recurrence-prevention guardrail;
- generalized lesson when applicable.
