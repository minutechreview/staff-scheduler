# Local payment and dependency safety review

Live billing and public deployment remain disabled. No provider or support communication, credentials, cloud configuration, payment, or hosted mutation occurred.

## Local payment fixes

- A webhook changing a verified subscription to another configured variant now revokes verification. Ordinary and replacement reconciliation must match the original server-created checkout variant.
- Conflicting snapshots with equal provider timestamps now commit quarantine instead of returning an error while leaving previous active access intact. Replaying the conflict or delivering a newer event cannot restore access without authoritative reconciliation.
- Regression coverage verifies checkout-supplied workspace IDs cannot change the server-owned binding, cancellation access ends at expiry, replay handling, uncertain checkout retention, and independent reconciliation gates.

An authenticated webhook and echoed custom data remain insufficient to independently establish checkout-to-order provenance. The production verifier is still absent and paid entitlements remain gated. No live readiness is implied by synthetic tests.

## Runtime dependency fixes

Current advisory review found affected certifi, opentelemetry-api and pyasn1 versions. Updated pins to certifi 2026.10.23, opentelemetry-api 1.45.1 and pyasn1 0.6.5. The three universal wheels were downloaded and SHA-256 matched against their exact official PyPI release metadata, then reflected in the Linux image hash lock. See validation/python-patched-wheels-20261112.json.

After patching, audits of all 35 Firebase dependency pins and the separate Gunicorn pin report no known vulnerabilities, with no package skips. This is a point-in-time package advisory check, not an OS-image scan or security certification. Image rebuilding, OS review, final licence notices, hosted acceptance and release provenance still remain. Older container artifacts do not contain these patches and must not be released.

## Validation

The final patched runtime installed successfully in an isolated local environment from binary wheels; pip check passed. All 235 Python tests passed with the Firebase SDK installed, zero skips. All 33 public-snapshot JavaScript tests passed. Build and typecheck passed; lint passed with the pre-existing App.jsx hook warning. Browser, emulator and hosted acceptance were not rerun in this review.
