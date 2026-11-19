/**
 * Signing helpers shared by the update scripts (release-update, relocate-update-files).
 *
 * Signing key: $MARKFLOW_UPDATE_KEY (PEM text) or keys/update-private.pem
 * (create one with `node scripts/update-keygen.mjs`).
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The public key compiled into the app: the only one installed apps trust. */
export function appPublicKey() {
  const pem = /`(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)`/.exec(
    readFileSync(join(root, 'src/main/update-public-key.ts'), 'utf8')
  )?.[1]
  if (!pem) throw new Error('No public key in src/main/update-public-key.ts')
  return createPublicKey(pem)
}

/** Reads the private key from $MARKFLOW_UPDATE_KEY or keys/; exits with a readable error. */
export function signingKey() {
  const file = join(root, 'keys/update-private.pem')
  const text = process.env.MARKFLOW_UPDATE_KEY || (existsSync(file) ? readFileSync(file, 'utf8') : null)
  if (!text) {
    console.error('No signing key: set MARKFLOW_UPDATE_KEY or run `node scripts/update-keygen.mjs`.')
    process.exit(1)
  }
  return loadSigningKey(text)
}

/**
 * Reads the Ed25519 private key, tolerating the ways a PEM gets mangled when pasted into a CI
 * secret: surrounding quotes, CRLF or literal "\n", line breaks lost, header lines missing
 * (bare base64 PKCS#8), or just the raw 32-byte seed in base64. Never prints key material.
 */
export function loadSigningKey(text) {
  let t = text.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\\n/g, '\n').replace(/\r/g, '').trim()
  const wrap = (label, b64) => `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`
  const pem = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(t)
  if (pem) {
    t = wrap(pem[1], pem[2].replace(/\s+/g, ''))
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(t)) {
    const der = Buffer.from(t.replace(/\s+/g, ''), 'base64')
    // A bare 32-byte seed: prefix it with the fixed PKCS#8 header for Ed25519.
    const pkcs8 = der.length === 32 ? Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), der]) : der
    t = wrap('PRIVATE KEY', pkcs8.toString('base64'))
  }
  try {
    const key = createPrivateKey(t)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${key.asymmetricKeyType} key, expected ed25519`)
    return key
  } catch (err) {
    const what = pem
      ? `a PEM block labelled "${pem[1]}"`
      : t.includes('-----BEGIN')
        ? 'a PEM header without a matching END line'
        : `${text.trim().length} characters that are neither PEM nor base64`
    console.error(`The signing key could not be read (${err.message}). It contains ${what}.`)
    if (pem && /PUBLIC/.test(pem[1])) console.error('That is the public key; the secret needs the private half (keys/update-private.pem).')
    if (pem && /OPENSSH|RSA|EC /.test(pem[1])) console.error('Expected the Ed25519 PKCS#8 key from `npm run update:keygen` ("-----BEGIN PRIVATE KEY-----").')
    process.exit(1)
  }
}

/**
 * Signs the manifest's exact bytes and returns the base64 signature. Refuses (exits) when the
 * signature would not verify against the app's public key, unless skipKeyCheck is set.
 */
export function signManifest(raw, key, { skipKeyCheck = false } = {}) {
  const signature = sign(null, raw, key).toString('base64')
  if (!skipKeyCheck && !verify(null, raw, appPublicKey(), Buffer.from(signature, 'base64'))) {
    console.error('The signing key does not match src/main/update-public-key.ts — installed apps would reject this update.')
    console.error('Use the private key generated with that public key, or run `npm run update:keygen -- --force` and ship new installers.')
    process.exit(1)
  }
  return signature
}
