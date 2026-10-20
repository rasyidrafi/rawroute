import * as path from "node:path"

/** The provider engine does not need RawRoute database, session or encryption secrets. */
export function childEnvironment(root: string) {
  const allowed = new Set(["PATH", "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GOMEMLIMIT", "GOMAXPROCS", "GODEBUG"])
  const entries = Object.entries(process.env).filter(([key]) => allowed.has(key) || process.env.NODE_ENV === "test" && (key.startsWith("CLIPROXY_FIXTURE_") || key === "RAWROUTE_CLIPROXY_TEST_PORT"))
  return { ...Object.fromEntries(entries), HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_DATA_HOME: path.join(root, ".local/share") }
}
