# Security policy

## Supported versions

| Version | Branch | Security updates |
| --- | --- | --- |
| 2.x | `main` | Yes |
| 1.x | `1.0` | Critical fixes during the documented transition window |
| 0.0.x | — | No |

The latest `2.x` release is the actively supported line. Users should also
keep their operating-system libfuse 3 or supported macFUSE 5.3.1+ runtime
current.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately
through the repository's
[GitHub Security Advisory form](https://github.com/mmdevries/fuse-napi/security/advisories/new).

Include, where possible:

- affected `fuse-napi`, Node.js, operating-system, and FUSE runtime versions;
- architecture and installation method;
- a minimal reproducer or crash trace;
- the expected impact and whether untrusted filesystem input is required; and
- any suggested mitigation.

Reports should receive an acknowledgement within three business days and an
initial assessment within seven business days. Timelines for a coordinated
fix and disclosure depend on severity and whether upstream FUSE components are
involved.

## Security boundaries

`fuse-napi` validates the JavaScript/native boundary but does not sandbox a
filesystem implementation. Applications remain responsible for authorization,
path policy, data validation, secrets, and safe use of options such as
`allowOther`, `allowRoot`, and `defaultPermissions`.

The package dynamically links the host's libfuse 3 or macFUSE 5.3.1+ runtime.
Vulnerabilities in libfuse, macFUSE, the kernel extension, or the operating
system should also be reported to their respective maintainers.

Every mount performs a runtime preflight, but this does not replace host
patching or least-privilege configuration. Production deployments should
grant only the service account access to `/dev/fuse`, avoid `allowOther`
unless it is an explicit security requirement, and set bounded operation
timeouts.

Release artifacts contain SHA-256 checksums and a CycloneDX SBOM and receive
GitHub build-provenance and SBOM attestations. Native CI includes static
analysis, deterministic boundary fuzzing, ASan/UBSan integration, and
repeated mount/teardown testing. LeakSanitizer is disabled for the mounted
Node.js process because the upstream Node runtime is not leak-clean at exit;
bounded RSS is checked separately by the soak test. The normal limit is
128 MiB; sanitizer CI permits 192 MiB to account for its bounded shadow and
quarantine memory.
