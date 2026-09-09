# Enterprise SSO and MFA

Single sign-on for the Duckle console (`duckle-runner serve`) through an
enterprise identity provider, using OpenID Connect.

**Status: shipping.** OIDC login, group-to-role mapping and MFA enforcement are
implemented and covered by tests in `crates/duckle-runner/src/oidc.rs`. This
document describes what the code does, not a plan. Where something is not
implemented, it says so.

| Capability | Status |
| :--- | :--- |
| OpenID Connect Core 1.0, authorization code flow | Shipping |
| PKCE (RFC 7636), S256 | Shipping, always on |
| Microsoft Entra ID, Okta, Google Workspace, Ping, Auth0, Keycloak | Shipping (any OIDC provider) |
| Group-claim to role mapping (admin / operator / viewer) | Shipping |
| MFA enforcement via `acr` / `amr` claims | Shipping |
| Audit attribution to the federated identity | Shipping |
| SAML 2.0 | **Not implemented.** See [SAML](#saml-20) |

---

## 1. Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Browser
    participant Duckle as Duckle Console (duckle-runner serve)
    participant IdP as Identity Provider (OIDC)

    User->>Duckle: GET /auth/oidc/login
    Note over Duckle: Mint state, nonce, PKCE verifier and a<br/>browser-binding cookie; hold them for 5 minutes
    Duckle-->>User: 302 to the provider (state + nonce + code_challenge + acr_values)
    User->>IdP: Authenticate, including any second factor the IdP requires
    IdP-->>User: 302 to /auth/oidc/callback (code + state)
    User->>Duckle: GET /auth/oidc/callback?code=...&state=...
    Note over Duckle: State must be unspent and from this browser
    Duckle->>IdP: POST token endpoint (code + code_verifier)
    IdP-->>Duckle: id_token (JWT)
    Note over Duckle: Verify RS256 signature against JWKS,<br/>then iss / aud / nonce / exp / sub,<br/>then acr / amr, then map claims to a role
    Duckle-->>User: HttpOnly session cookie, 302 to the console
```

The design decision behind the split: everything that decides whether someone
gets in is a pure function from values to values, so each rule is tested without
a network. The parts that talk to the provider are mechanical by comparison.

---

## 2. Protocol

* **Flow**: authorization code with PKCE, `code_challenge_method=S256`. The
  verifier never appears in a redirect, only its hash.
* **Signature**: `RS256` only. A token whose header names any other algorithm is
  refused, `none` included.
* **Issuer**: must be `https://`. An `http` issuer would make the discovery
  document, the JWKS and the token exchange all interceptible.
* **Replay**: `state` is good for exactly one callback and is bound to the
  browser that started the login through an HttpOnly cookie
  (`duckle_oidc_login`). An in-flight login expires after 5 minutes.
* **Claims checked**: `iss` (trailing slash tolerated), `aud` (this client must
  be in it, string or array), `nonce` (ties the token to this login), `exp`,
  `sub`.
* **Tokens are not stored.** The access token is unused and the ID token is
  validated and dropped. Only the subject, a display name and the mapped role
  survive into the session.

### What it deliberately does not do

* **No reverse-proxy identity headers.** Any deployment where the proxy can be
  bypassed turns `X-Forwarded-User` into an admin login.
* **No self-registration into a role.** A subject that no mapping matches gets
  `defaultRole`; if none is configured, the login is refused. A provider saying
  who someone is does not say what they may do here.

---

## 3. Configuration

`<workspace>/.duckle/oidc.json`. The file's presence enables OIDC; its absence
leaves the console on local accounts. A file that exists and does not parse is a
startup error rather than a silent fallback, so a typo cannot leave a server on
local accounts while an operator believes SSO is enforced.

```json
{
  "issuer": "https://example.okta.com/oauth2/default",
  "clientId": "0oa1234567890abcdef",
  "clientSecret": "${ENV:OKTA_CLIENT_SECRET}",
  "redirectUri": "https://duckle.internal.example/auth/oidc/callback",
  "scopes": ["openid", "profile", "email", "groups"],
  "roleMappings": [
    { "claim": "groups", "contains": "Duckle-Admins",    "role": "admin"    },
    { "claim": "groups", "contains": "Duckle-Operators", "role": "operator" },
    { "claim": "groups", "contains": "Duckle-Viewers",   "role": "viewer"   }
  ],
  "defaultRole": null,
  "acrValues": ["urn:okta:loa:2fa:any"],
  "amrRequired": ["mfa", "otp", "hwk"]
}
```

| Key | Meaning |
| :--- | :--- |
| `issuer` | Provider issuer URL. Must be `https://`. Discovery is read from `/.well-known/openid-configuration`. |
| `clientId`, `clientSecret` | The registered application. `clientSecret` may be omitted for a public PKCE client. |
| `redirectUri` | Must match the provider registration exactly. Path is `/auth/oidc/callback`. |
| `scopes` | Default `openid profile email`. Add whatever scope releases your group claim. |
| `roleMappings` | Ordered rules. First match wins. |
| `defaultRole` | Role for a subject no rule matched. `null` or absent means **refuse**. |
| `acrValues` | Authentication contexts this deployment demands. |
| `amrRequired` | Authentication methods, any one of which satisfies the requirement. |

`clientSecret` accepts the same `${ENV:NAME}` and `${VAULT:NAME}` references as
any other Duckle credential, so it need not be written into the file.

---

## 4. Role mapping

Rules are evaluated in order and the first match wins, so put the most
privileged rule first. A claim holding a list matches when any element equals
`contains`; a claim holding a string matches on equality. Matching is on the
whole value, never a substring, so `Duckle-Admins-ReadOnly` does not match
`Duckle-Admins`.

| Role | What it may do |
| :--- | :--- |
| `admin` | Deploy pipelines, manage schedules, manage users and API keys, read audit logs. |
| `operator` | Trigger and cancel runs, enable and disable schedules. |
| `viewer` | Read run history, pipelines and metrics. |

The role split follows what an action can *do*, not where it appears in the UI.
`POST /api/deploy` is admin because it introduces code that will execute;
`POST /api/run` is operator because it runs what an admin already approved.

---

## 5. MFA enforcement

MFA is performed by the identity provider - that is the correct place for it,
and it is why Duckle stores no passwords and no second-factor secrets. What
Duckle does is **require evidence that it happened**, and refuse the session
otherwise.

Two independent controls, both off unless configured:

* **`acrValues`** is sent as `acr_values` on the authorization request *and*
  required back in the token's `acr` claim. Both halves matter: only asking lets
  a provider ignore the request and return a single-factor token, and only
  checking means a compliant provider is never told to step the person up, so
  the login fails instead of prompting.
* **`amrRequired`** is checked against the `amr` claim, the list of methods
  actually used. Any one of the named methods satisfies it - naming both `otp`
  and `hwk` says either second factor will do, not both.

**A missing claim is refused, not waived.** A provider that returns no `acr` or
no `amr` has not reported that the requirement was met, and reading silence as
consent is how a control like this ends up enforcing nothing.

Provider notes:

| Provider | Typical setting |
| :--- | :--- |
| Okta | `"acrValues": ["urn:okta:loa:2fa:any"]`, and `"amrRequired": ["mfa", "otp", "hwk"]`. Okta returns the method it used in `amr`. |
| Microsoft Entra ID | `"amrRequired": ["mfa"]`. Enforce the factor with a Conditional Access policy; Entra reports `mfa` in `amr` when one was used. |
| Keycloak, Ping, Auth0 | Use the provider's step-up ACR value in `acrValues`; all three return `amr`. |

Because enforcement is a property of the session rather than of a route, it
applies to every request that session makes.

---

## 6. SAML 2.0

**Not implemented, and not currently planned.**

Every identity provider named above speaks OIDC natively, including the two the
enterprise question is usually about - Microsoft Entra ID and Okta - so SAML is
not needed to federate with them. OIDC is also the smaller attack surface: no
XML canonicalisation, no signature-wrapping class of bug, and one token format
to validate rather than two.

A deployment that must use SAML can put a SAML-to-OIDC gateway in front of the
console. Duckle does not trust proxy identity headers (section 2), so such a
gateway has to terminate SAML and present OIDC, not merely assert a username.

---

## 7. Audit attribution

With SSO active, `<workspace>/logs/audit.ndjson` records the **subject** as the
actor, with the display name after it in parentheses:

```json
{
  "at": "2026-08-30T14:50:00.000Z",
  "actor": "00u1a2b3c4d5e6f7g8h9 (alice.engineer@example.com)",
  "role": "admin",
  "action": "POST",
  "target": "/api/deploy",
  "outcome": "allowed"
}
```

The subject leads deliberately. A display name is self-service at most
providers, so an actor string taken from one would let a user choose how they
appear in the audit log - including impersonating the break-glass admin label -
and every action they took afterwards would be recorded against that choice. The
name is kept because a log nobody can read is its own problem, but it is never
what identifies.

---

## 8. Related

* [Trust boundary and threat model](../explanation/trust-boundary-and-threat-model.md)
* [Audit event schema](audit-event-schema.md)
* [Configure secrets management](../how-to/configure-secrets-management.md)
