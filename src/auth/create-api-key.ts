/**
 * Create a Lumo Personal Access Token (API key) via the account API.
 *
 * Mirrors the WebClient flow (applications/lumo/src/app/features/api-keys):
 *  1. Fetch the real account user keys (core/v4/users) and pick the primary.
 *  2. Generate 32 random bytes, PGP-encrypt them to the primary public key,
 *     base64 -> PersonalAccessTokenKey.
 *  3. POST account/4/personal-access-token with { Name, Products, PersonalAccessTokenKey, ExpireTime }.
 *  4. Print the returned Token (shown once).
 *
 * The token can then be used with Lumo's OpenAI-compatible endpoint:
 *   base_url: https://lumo.proton.me/api/ai/v1
 *   Authorization: Bearer <token>
 *
 * Works with any auth method whose session has account scope (login/browser/rclone),
 * because it reads the real keys from core/v4/users rather than the local cache.
 */

import * as openpgp from 'openpgp';
import { AuthProvider } from './providers/index.js';
import { logger } from '../app/logger.js';
import { print } from '../app/terminal.js';
import type { ProtonApi } from './types.js';

interface UsersResponse {
    User?: {
        Keys?: Array<{ ID: string; PrivateKey: string; Primary: number; Active: number }>;
    };
}

interface CreateTokenResponse {
    Code?: number;
    PersonalAccessToken?: {
        PersonalAccessTokenID?: string;
        Token?: string;
        ExpireTime?: number;
    };
}

/** Build the PersonalAccessTokenKey: 32 random bytes PGP-encrypted to the given public key (base64). */
async function buildPersonalAccessTokenKey(publicKey: openpgp.Key): Promise<string> {
    const tokenKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const message = await openpgp.createMessage({ binary: tokenKeyBytes });
    const encrypted = await openpgp.encrypt({ message, encryptionKeys: publicKey, format: 'binary' });
    return Buffer.from(encrypted as Uint8Array).toString('base64');
}

/**
 * Fetch the account's user keys and return the first one openpgp can parse,
 * preferring the primary. Logs diagnostics so we can tell apart a scope issue,
 * a malformed key, or a post-quantum key the bundled openpgp can't read.
 */
async function resolveEncryptionKey(api: ProtonApi): Promise<openpgp.Key> {
    const res = (await api({ url: 'core/v4/users', method: 'get' })) as UsersResponse;
    const keys = res.User?.Keys ?? [];
    logger.info({ keyCount: keys.length }, 'Fetched account user keys');

    if (keys.length === 0) {
        throw new Error('core/v4/users returned no user keys (session may lack scope)');
    }

    // Try primary/active first, then the rest.
    const ordered = [...keys].sort((a, b) => (b.Primary - a.Primary) || (b.Active - a.Active));

    let lastErr: unknown;
    for (const k of ordered) {
        const head = (k.PrivateKey || '').slice(0, 45).replace(/\n/g, '\\n');
        try {
            const key = await openpgp.readKey({ armoredKey: k.PrivateKey });
            logger.info({ id: k.ID, primary: k.Primary, active: k.Active }, 'Using account key for token encryption');
            return key;
        } catch (e) {
            lastErr = e;
            logger.warn(
                { id: k.ID, primary: k.Primary, active: k.Active, len: (k.PrivateKey || '').length, head, err: String(e) },
                'Could not parse this account key, trying next'
            );
        }
    }

    throw new Error(
        `None of the ${keys.length} account key(s) could be parsed by openpgp (last error: ${String(lastErr)}). ` +
        'Likely a post-quantum key the bundled openpgp build cannot read.'
    );
}

/**
 * Create a Lumo API key.
 * @param name Label for the key (default "lumo-tamer")
 * @param expirationDays Days until expiry (default 90)
 */
export async function runCreateApiKey(name = 'lumo-tamer', expirationDays = 90): Promise<void> {
    print('=== Create Lumo API key ===\n');

    const provider = await AuthProvider.create();
    if (!provider.getStatus().valid) {
        print('\x1b[31mNot authenticated. Run `tamer auth` first.\x1b[0m');
        process.exit(1);
    }

    const api = provider.createApi();

    try {
        const publicKey = await resolveEncryptionKey(api);
        const personalAccessTokenKey = await buildPersonalAccessTokenKey(publicKey);
        const expireTime = Math.floor(Date.now() / 1000) + expirationDays * 86400;

        const response = (await api({
            url: 'account/4/personal-access-token',
            method: 'post',
            data: {
                Name: name,
                Products: ['lumo'],
                PersonalAccessTokenKey: personalAccessTokenKey,
                ExpireTime: expireTime,
            },
        })) as CreateTokenResponse;

        const token = response?.PersonalAccessToken?.Token;
        if (!token) {
            logger.error({ response }, 'No token in create response');
            print('\x1b[31mServer accepted the request but returned no token. Raw response logged.\x1b[0m');
            process.exit(1);
        }

        const expiresAt = response.PersonalAccessToken?.ExpireTime
            ? new Date(response.PersonalAccessToken.ExpireTime * 1000).toISOString()
            : 'unknown';

        print('\n\x1b[32m✓ Lumo API key created.\x1b[0m\n');
        print(`  Name:    ${name}`);
        print(`  Expires: ${expiresAt}`);
        print(`  Token:   \x1b[1m${token}\x1b[0m`);
        print('\n  Use it with Lumo\'s OpenAI-compatible endpoint:');
        print('    base_url: https://lumo.proton.me/api/ai/v1');
        print('    api_key:  <the token above>');
        print('\n  \x1b[33mStore it now - it cannot be retrieved again.\x1b[0m\n');
    } catch (error) {
        const status = (error as { status?: number }).status;
        const code = (error as { Code?: number }).Code;
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, status, code }, 'Failed to create API key');
        print(`\n\x1b[31mFailed to create API key: ${message}\x1b[0m`);
        if (status === 403 || status === 422) {
            print('  (The personal-access-token API may not be enabled for your account/plan yet.)');
        }
        process.exit(1);
    }
}
