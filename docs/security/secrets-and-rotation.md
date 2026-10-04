# Secrets, rotation and revocation

## Storage contract

Application code refers to provider credentials through `SecretReference`. Production secret values must come from a runtime `SecretStore` implementation backed by an appropriate secret manager or equivalent protected store.

A secret reference is bound to:

- environment;
- purpose;
- version.

Provider credential bindings are also environment-bound. Resolution fails closed if the requested operation environment differs.

## Secret states

- `active`: current credential.
- `retiring`: still accepted during a controlled rotation overlap.
- `revoked`: must never be returned to a connector/verifier.

## Webhook rotation procedure

1. create/store the new webhook secret as a higher version;
2. mark the previous secret `retiring`;
3. configure the provider to use the new secret;
4. verification temporarily accepts both active and retiring secrets;
5. confirm callbacks are arriving with the new secret;
6. mark the previous secret `revoked`;
7. remove the retired reference after the retention window.

This avoids a deployment race while ensuring old credentials do not remain indefinitely valid.

## Provider API credential rotation

Outgoing provider API calls should select the highest-version active credential. A retiring API credential exists only for controlled rollback/transition and must not be round-robin load balanced.

If the provider supports overlapping API keys:

1. issue a new key;
2. store it as active;
3. update the provider credential binding;
4. verify sandbox/health operations;
5. revoke the old key at the provider;
6. mark the old secret `revoked` internally.

If the provider does not support overlap, perform a coordinated cutover and keep the change reversible at the deployment/configuration level.

## Project API credential rotation

Project API keys are independent credentials with explicit scopes, environment and revocation timestamp.

Recommended rotation:

1. create a second credential with the minimum required scopes;
2. deploy it to the consumer;
3. verify traffic using the new credential ID;
4. revoke the old credential;
5. remove the old secret from the consumer environment.

Stored project credential records contain a keyed digest of the API secret, not the plaintext secret.

## Emergency revocation

For suspected compromise:

- revoke the project/provider credential immediately;
- stop accepting the compromised credential before investigating downstream impact;
- inspect audit/payment/provider-event evidence for the exposure window;
- rotate dependent secrets if reuse cannot be ruled out;
- record the incident and prevention action in the RAIDER failure-memory log when significant.

## Logging rule

Never log secret values, raw authorization headers, full API keys, webhook signing secrets, PAN/CVV or raw webhook bodies.
