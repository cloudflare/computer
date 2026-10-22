---
"@cloudflare/computerd": patch
---

Build the computerd binary on Node 22.23.4, whose bundled root store no longer trusts the emSign ECC Root CA - G3 and AAA Certificate Services roots behind the compromised eMudhra intermediates.
