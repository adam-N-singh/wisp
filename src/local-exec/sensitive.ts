// Locations that hold credentials or keys. Any read or command that mentions
// one is rated "dangerous": it always asks and can never be remembered.
const SENSITIVE = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.kube[\\/]config/i,
  /(^|[\\/])\.docker[\\/]config\.json/i,
  /(^|[\\/])\.config[\\/](gcloud|gh)([\\/]|$)/i,
  /(^|[\\/])\.(netrc|npmrc|pypirc|git-credentials)$/i,
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
  /\.(pem|pfx|p12|kdbx)$/i,
  /[\\/]Microsoft[\\/](Credentials|Protect|Vault)([\\/]|$)/i,
  /(^|[\\/])Keychains?([\\/]|$)/i,
  /[\\/](1Password|Bitwarden|KeePass)([\\/]|$)/i,
];

// Browser profile stores; their names contain spaces, so match the whole text.
const BROWSER_STORES = /[\\/](Login Data|Cookies|Local State|Web Data)(\b|$)/i;

export function mentionsSensitiveLocation(text: string): boolean {
  if (BROWSER_STORES.test(text)) return true;
  return text.split(/\s+|["'`]/).some((token) => token.length > 0 && SENSITIVE.some((pattern) => pattern.test(token)));
}
