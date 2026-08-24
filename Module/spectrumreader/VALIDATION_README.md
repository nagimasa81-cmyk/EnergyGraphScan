# Energy Graph Scan / Spectrum Reader — r25-RC2-dev2 iPhone Validation Candidate

This is a validation build, not the formal r25-RC2 release.

## Build identity
- Display version: `v2.0.7-r25-RC2-dev2`
- Runtime fingerprint: `pipeline37-axis52-trace17-r25rc2-gainpop3-projection-rescue1`
- Cache key: `egs-v2-pwa-20260824-spectrumreader-2.0.7-r25-RC2-dev2`

Before testing, confirm the app header shows `v2.0.7-r25-RC2-dev2`.

## What changed from r25-RC1
1. Worker result transport removes the non-cloneable `axis.mapY` function before `postMessage`.
2. Gain-scale High measurement uses the sustained elevated population inside the fixed Sample# 270–500 interval.
3. Noise / decimal-scale axes remain on the r25-RC1 fixed-contract measurement.
4. If primary axis geometry fails, an independent projection-geometry retry is allowed. Unsafe/ambiguous candidates remain Needs attention.

## iPhone validation priority
### A. Batch Analyze
- Select the same 18-image batch if available.
- Confirm all 18 reach a normal terminal state: Accepted / Needs attention / Rejected.
- Required: `The object can not be cloned.` = 0.
- Do not count legitimate Needs attention as a Batch failure.

### B. Gain High
Check that Gain High follows the visible elevated plateau rather than being pulled down by the pre-transition baseline.
Representative dev2 results from the supplied evidence:
- IMG_2422 High: ~1.2814
- IMG_2421 High: ~1.3109
- IMG_2420 High: ~1.2152
- IMG_2417 High: ~1.2192

### C. Decimal / Noise guard
These must not inherit Gain population logic.
Representative values:
- IMG_2406 Low ~0.0065498 / High ~0.0076970
- IMG_2405 Low ~0.0035026 / High ~0.0035873
- 0.005 positional invariant remains mandatory.

## Regression state before packaging this validation build
- supplied iPhone evidence source images: 14/14 Accepted
- restored: IMG_2417, IMG_2415, IMG_2406, IMG_2405
- Frozen64: 64 checked, new rejects 0
- Historical direct 27: 27 checked, new rejects 0
- 18-image worker transport regression: 18 normal results, clone errors 0
- wrapper screenshots: safe reject preserved
- runtime manifest/bundle closure: PASS (24 modules)
- source-to-PWA distribution parity: PASS (8 runtime files)
- PWA bundle parity: PASS

## Important
If the displayed version is not `v2.0.7-r25-RC2-dev2`, do not evaluate the result as this candidate. Reload/reopen until the correct version appears.
