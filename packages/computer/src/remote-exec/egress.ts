/**
 * Routing a container's HTTP and HTTPS through a Worker. The platform intercepts the container's
 * outbound connections (`interceptAllOutboundHttp()`, `interceptOutboundHttps()`) and serves HTTPS
 * with an ephemeral CA, which the container has to trust. `ContainerExec` does both when its
 * `outbound` hook returns a `Fetcher`; these are the paths and the script it uses.
 */

/** Where the platform puts the container's ephemeral CA, once the container has started. */
export const CONTAINERS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** The system's roots plus the containers' CA, for clients that take one bundle. */
export const CA_BUNDLE = "/etc/computer-remote-exec/ca-bundle.crt";

/**
 * Given to the container with `start()`, so commands get them as part of the image's environment.
 * Every HTTPS connection on 443 is intercepted, so these clients see the containers' CA there.
 */
export const CA_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CONTAINERS_CA,
  SSL_CERT_FILE: CA_BUNDLE,
  REQUESTS_CA_BUNDLE: CA_BUNDLE,
  CURL_CA_BUNDLE: CA_BUNDLE,
};

/**
 * Run as root once the container has started: waits for the CA, adds it to the system's bundle
 * (replacing one an earlier start of a snapshot added) and to the distribution's source
 * directory, so a later `update-ca-certificates` keeps it, and writes `CA_BUNDLE`. Rebuilding the
 * store with the distribution's tool would take seconds on every start, before the first command.
 */
export const TRUST_CA_SCRIPT = `set -e
ca=${CONTAINERS_CA}
i=0
while [ ! -s "$ca" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "the containers' CA never appeared at $ca" >&2; exit 1; fi
  sleep 0.1
done
begin="# computer-remote-exec: the containers' CA"
end="# computer-remote-exec: end"
found=
for system in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
  if [ -f "$system" ]; then found=$system; break; fi
done
if [ -n "$found" ]; then
  sed "/^$begin$/,/^$end$/d" "$found" > "$found.tmp"
  { echo "$begin"; cat "$ca"; echo "$end"; } >> "$found.tmp"
  cat "$found.tmp" > "$found"
  rm "$found.tmp"
fi
for anchors in /usr/local/share/ca-certificates /etc/pki/ca-trust/source/anchors; do
  if [ -d "$anchors" ]; then cp "$ca" "$anchors/cloudflare-containers-ca.crt"; fi
done
bundle=${CA_BUNDLE}
mkdir -p "$(dirname "$bundle")"
cat "\${found:-$ca}" > "$bundle.tmp"
mv "$bundle.tmp" "$bundle"
`;
