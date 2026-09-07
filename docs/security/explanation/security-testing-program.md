# Security testing program

What is tested, how often, by whom, and - the part that matters most to anyone
assessing this - **what these methods cannot find**.

---

## 1. The honest summary

| Layer | Status |
| :--- | :--- |
| Automated regression and contract testing | Continuous, every push |
| Static analysis and lint gates | Continuous, every push |
| Dependency vulnerability scanning | Every push **and weekly** |
| Internal adversarial review of security-relevant changes | Per change |
| **Independent third-party penetration testing** | **Not yet performed.** See section 5 |

Rust removes whole classes of memory-safety defect, and the test suite is
substantial. Neither of those finds an authorization rule that is wrong, an API
that returns more than it should, or a business-logic error that behaves exactly
as written and is written wrong. The program below is built around that
distinction, and section 5 does not soften it.

---

## 2. What runs on every change

**2,088 tests** across the workspace, run on Linux, macOS and Windows, plus
`clippy` and a format gate. The suite must be green before a merge.

The security-relevant tests are not a separate suite; they sit beside the code
they constrain, which is why they get maintained. Representative examples:

| Control | What is asserted |
| :--- | :--- |
| Unauthenticated surface | The public route list is asserted as an **exact set**, so a route added to it fails the build and has to be justified in the test |
| Route authorization | Every dispatched API route has an explicit role; an unnamed route falls back to **admin**, not to permissive |
| Identity | OIDC issuer, audience, nonce, expiry, subject, algorithm - each rule tested as a pure function, with no live provider |
| MFA | A token with no `acr` or `amr` claim is refused rather than waived |
| Parameter injection | A run parameter carrying shell syntax into an executed property is refused, not escaped |
| Secret handling | Every property the form treats as secret is one the log redactor knows |
| Transport | SFTP host keys are pinned and a changed key refuses the connection |
| Audit | The actor is the provider subject, never a self-service display name |

Two disciplines make these worth something rather than decorative:

* **Red first.** A test for a defect is written before the fix and watched to
  fail *for the intended reason*. A test that has never been red has proved
  nothing about the bug it claims to cover.
* **Negative controls.** A guard is verified by breaking the thing it guards and
  watching it catch that. The public-route assertion above was checked by adding
  `GET /api/audit` to the public list and confirming the build went red.

## 3. Dependency and supply chain

`cargo audit` and `npm audit` on every push and on a weekly schedule, a
CycloneDX SBOM, and keyless build provenance on every release artifact. Accepted
advisories are individually justified with a reachability analysis and a review
date. See [Supply chain assurance](supply-chain-assurance.md) and
[Dependency advisories](../reference/dependency-advisories.md).

## 4. Internal adversarial review

Security-relevant changes get a deliberate second pass whose goal is to break
them rather than to approve them. This is not a substitute for independent
testing and is not presented as one - the reviewer knows the design, which is
both why the review is efficient and why it is blind in the same places the
design is.

It does find real defects. The OIDC login had four corrected before release as a
direct result, and the reachable classes it tends to catch are exactly the ones
listed in section 2.

---

## 5. Independent penetration testing

**No independent third-party penetration test has been performed.** Stating that
plainly is more useful than a program document that implies otherwise.

### Why it matters here

Automated testing and internal review are structurally weak against:

* **Authentication and authorization flaws** - a rule can be consistently
  enforced and consistently wrong.
* **API vulnerabilities** - what an endpoint returns, over-fetching, error
  messages that distinguish cases they should not.
* **Business logic errors** - code that does exactly what it says, where what it
  says is the defect.
* **Misconfiguration** - the shipped defaults, and what a hurried deployment
  actually does.
* **Supply chain** - beyond known-advisory scanning.

### Engagement scope, when commissioned

1. **Authenticated application testing** of the console: OIDC login and session
   handling, the role model across every API route, CSRF and origin controls,
   the setup-claim flow, and the audit trail's completeness under attack.
2. **Infrastructure testing** of a representative self-hosted deployment.
3. **Pipeline-authoring boundary**: what an author with pipeline-authoring
   rights but no shell access can reach, given components that deliberately
   execute processes.
4. **Remediation validation** - a re-test of every finding, because a report
   without a re-test measures effort rather than outcome.

### Cadence

* Annually, and
* before any release that changes authentication, authorization, or the trust
  boundary.

### Handling findings

Findings are tracked under the same SLAs as externally reported vulnerabilities,
so there is one process and not two: acknowledgement within 3 working days,
severity assessment within 10, fix or documented mitigation within 90 days and
within 14 for anything critical. Each finding gets a **regression test written
red first**, so the specific defect cannot return silently. See
[Vulnerability reporting and patching](../how-to/vulnerability-reporting-patching.md).

### Interim compensating controls

Until an independent test is performed, a deployment can reduce exposure with
controls that do not depend on our assurances:

* Bind the console to loopback or a private network. It refuses off-loopback
  operation without a token, and the cross-origin guard is on by default.
* Require SSO with enforced MFA, and map the least privilege each group needs.
* Enable the execution policy where pipeline authors are not trusted with shell
  access, and review `policy.yaml`.
* Forward `audit.ndjson` to a SIEM you control, so detection does not depend on
  the host being intact.

---

## 6. Pre-release security review

Before a release that touches authentication, authorization, secret handling or
the trust boundary:

1. The full suite is green on all three platforms.
2. `cargo audit` is clean, or every exception carries a current justification.
3. Changes to the unauthenticated surface, the role table or the policy defaults
   are enumerated and reviewed deliberately, not merged in passing.
4. New security-relevant behaviour has a test that was red first.
5. The SBOM builds and the release carries provenance.

---

## Related

* [SSDLC and TDD philosophy](ssdlc-and-tdd-philosophy.md)
* [Security governance](security-governance.md)
* [Trust boundary and threat model](trust-boundary-and-threat-model.md)
