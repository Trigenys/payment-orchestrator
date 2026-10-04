# Security threat model

Status: minimum production security model for issue #6.

## Security boundary

Payment Orchestrator is a server-side orchestration service. Consumer applications call it with project-scoped credentials. Provider credentials and webhook secrets never belong in browser/mobile clients or first-party SDK configuration.

The service does not store PAN/CVV in V1. Card data should stay on provider-hosted/tokenized flows.

## Assets

- provider API credentials;
- provider webhook verification secrets;
- project API credentials;
- payment and settlement state;
- idempotency/event uniqueness records;
- project/merchant tenant boundaries;
- reconciliation and audit evidence;
- sensitive provider/KYB metadata.

## Trust boundaries

```text
Consumer app
   |
   | project API credential
   v
Payment Orchestrator
   |
   | server-side provider credential
   v
Payment provider

Payment provider
   |
   | signed webhook + raw body
   v
Webhook verification boundary
   |
   | normalized verified event
   v
Payment state machine
```

## Threats and required controls

### Forged provider callbacks

**Threat:** an attacker POSTs a fake success event.

**Controls:**
- connector-specific signature verification receives the exact raw request bytes;
- invalid/missing signatures stop before normalization and before payment-domain processing;
- webhook verification uses only secrets resolved for the exact provider/environment;
- test/live credentials cannot cross environments.

### Replay and duplicate financial effects

**Threat:** a real provider callback or client request is delivered repeatedly.

**Controls:**
- project-scoped consumer idempotency keys;
- unique provider event identity: provider + environment + event ID;
- provider event fingerprint conflict detection;
- payment state transitions are replay-safe;
- duplicate callbacks retain one financial effect.

See `docs/payment-state-machine.md`.

### Secret disclosure

**Threat:** credentials leak through source control, SDK payloads, telemetry or error messages.

**Controls:**
- code stores secret references, not deployment secret values;
- production secret values come from a runtime SecretStore implementation;
- provider secrets remain server-side;
- project API secrets are stored as keyed digests, not recoverable plaintext;
- structured telemetry passes through `redactSensitive()`;
- authorization, API keys, secrets, tokens, password/card fields and raw webhook bodies are redacted;
- no credentials in committed configuration.

Test fixtures use explicitly dummy values only.

### Test/live environment confusion

**Threat:** sandbox keys or callbacks affect live state, or live secrets are used in tests.

**Controls:**
- every project/provider credential is environment-bound;
- API-key format carries test/live context;
- provider secret references carry environment;
- credential resolution fails closed on environment mismatch;
- provider references and event uniqueness include environment.

### Cross-project / tenant access

**Threat:** one project reads or creates financial state for another.

**Controls:**
- authenticated principal contains exactly one project ID, environment and explicit scopes;
- authorization validates project identity before domain execution;
- least-privilege scopes are required per operation;
- persistence adapters must include project boundaries in queries/unique constraints where applicable.

### Provider credential rotation failure

**Threat:** secret rotation breaks webhook delivery or leaves old credentials active indefinitely.

**Controls:**
- secrets have versions and states: active, retiring, revoked;
- webhook verification may accept active + retiring secrets during a controlled overlap;
- revoked secrets are excluded from resolution;
- rotation procedure is documented in `docs/security/secrets-and-rotation.md`.

### Log / telemetry leakage

**Threat:** raw webhooks, authorization headers or keys appear in logs.

**Controls:**
- redaction is recursive;
- raw-body fields are always redacted;
- API-key-like and bearer-token-like string values are scrubbed;
- production logging must log normalized identifiers/results, not raw payment/provider payloads by default.

### Abuse / denial of service

**Threat:** webhook or API endpoints are spammed to consume compute or provider quota.

**Controls:**
- rate-limit primitive is available before expensive processing;
- webhook body size is bounded before signature verification;
- adapters should apply provider-specific timeout/circuit-breaker policies;
- public API deployment should rate-limit per project credential and source/risk context.

Rate limits must not be used as a substitute for authentication/signature verification.

### Timing / credential guessing

**Threat:** attackers infer valid secrets through direct comparisons.

**Controls:**
- project API secret digests use HMAC-SHA-256 with a server-held pepper;
- digest comparison uses constant-time comparison after equal-length validation;
- provider-specific signature verifiers should use constant-time verification where applicable.

### Provider status spoofing / adapter bugs

**Threat:** provider-specific status vocabulary leaks into the core or maps incorrectly.

**Controls:**
- only verified callbacks may be normalized;
- the payment state machine accepts provider-neutral states only;
- adapters require provider-specific mapping/signature tests before production support;
- invalid normalized provider/environment values are rejected at ingress.

### Sensitive card-data scope creep

**Threat:** a future feature causes the service to start receiving/storing PAN/CVV.

**Control:** prohibited in V1. Any change requires an explicit architecture/security/compliance decision before implementation. Provider-hosted checkout/tokenization is the default.

## Security gates before a real provider money path

- provider secrets are stored outside source control;
- project authentication and authorization are enforced;
- provider webhook signature verification exists and has negative tests;
- idempotency/replay tests are green;
- environment isolation tests are green;
- telemetry redaction tests are green;
- provider connector threat-specific tests are green;
- production deployment has durable secret storage, TLS, rate limits and monitoring.

## Residual risk

This model reduces application/security risk but does not prove regulatory compliance or remove provider/account compromise risk. Production use still requires operational controls, provider commercial approval and the regulatory review described by the RAIDER audit.
