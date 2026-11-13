# Local release-container review, 13 November 2026

## Result

The patched application was rebuilt independently from the public source snapshot, verified wheel hashes, and a digest-pinned official Python base. The final image passes all 235 Python tests with network disabled, read-only root, dropped capabilities, and no-new-privileges. The disabled-service smoke check returns HTTP 503 as UID 10001, with ordinary live mode and auth delivery disabled. All 40 server files match the reviewed checkout byte-for-byte. This is not a deployment or release approval.

Final local image: `sha256:621d82ebdcef18c4188304f0f72f2b68ac4f53c245bdb1462123c45aa29e991e`. Input hashes, Python version and frontend pairing are in `validation/container-local-20261113.json`. An image ID is not a published registry release digest. No registry upload occurred.

## Base remediation and vulnerability findings

The original Python 3.14.4/Debian 13.4 base produced 437 OS package/advisory entries, including three critical and 108 high, plus four medium Python-tooling findings. These are package/advisory entries, not unique CVEs or demonstrated exploits.

The final recipe pins official Python 3.14.10/Debian 13.7 by digest, applies the fixed zlib package from the signed official Debian security repository, and removes pip and its bundled ensurepip wheel after installation. Runtime package installation is deliberately unavailable; rebuild the image to change dependencies. The zlib bytes are checked against the recorded repository SHA-256 before offline installation. All build network access remains disabled.

Final Trivy scan: **zero critical findings, zero Python-package findings, and no remaining high/critical finding with a recorded fixed version**. There remain **205 OS package/advisory entries: 47 high, 89 medium, 65 low and four unknown**. The 47 high entries represent 11 distinct advisories. Do not call this image vulnerability-free or waive these findings automatically.

The remaining high findings concern util-linux privileged mount/cgroup helpers, libacl privilege escalation, ncurses, SQLite FTS5/session processing, systemd-homed and Perl Archive::Tar. Initial source review found no application invocation of these privileged utilities, terminal parsing, archive extraction, FTS5 or changeset APIs. The ordinary deployed adapter uses Firestore, while SQLite is retained for local mode/tests. Non-root and dropped-capability testing reduce exposure but do not establish all hosted runtime controls or prove non-exploitability. Final reachability review or further runtime minimization is still a release gate. Scanner evidence is retained in the before/after JSON reports.

## Licences and safe deployment inputs

Collected actual notices for all 36 installed Python runtime distributions, five frontend/CSS runtime packages, and 88 base-image copyright files. See `THIRD_PARTY_RUNTIME_NOTICES.md`, `THIRD_PARTY_FRONTEND_NOTICES.md`, and `THIRD_PARTY_BASE_NOTICES.md`. Certifi remains MPL-2.0; base binaries include copyleft terms. No public container distribution occurred. If images/binaries are distributed outside the hosting operator, corresponding-source obligations need a separate check; notices alone are not a universal legal clearance. Preserve frontend notices with released assets.

Restored the safe deny-all Firestore rules and index definitions referenced by the disabled deployment template. No deployed rules changed.

## Rebuild inputs

The locked Dockerfile requires an isolated context with `server/*.py`, the two requirements files, the Linux lock copied as `requirements.lock.txt`, matching wheel files in `wheelhouse/`, and the verified zlib Debian package copied as `os-packages/zlib.deb`. Obtain that package using the exact version and hash in `validation/os-package-lock-20261113.json` from the official signed Debian repository. Do not copy the whole working directory, credentials or private operational records into the context.

## Hosting and payment gates

The existing disabled templates are not an executable hosting approval packet. Before seeking activation approval, verify the intended production project/billing account, finalize least-privilege runtime identity and auth permissions, and test the Firebase Hosting-to-Cloud Run ingress/invoker design. Current Cloud Run template uses internal ingress; no working public routing is established. Named Firestore, registry, hosting, email, logging, abuse limits, backup/recovery and cost controls must be specified together. A planning allowance is not a hard spending cap.

Hosted signup/recovery, tenant isolation, trial expiry and recovery remain unverified for this image. Payment provenance and real test checkout/webhook/retry/cancellation acceptance remain gated. No cloud deployment, access change, credential creation, paid resource setup or live billing activation occurred.
