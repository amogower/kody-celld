import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
	openArtifactRepo,
	openArtifactRepoSession,
	verifyRestorableArtifactBackup,
	type ArtifactAccessEnv,
} from './artifact-repo-access.ts'

const nativeRemote = 'https://acct.artifacts.cloudflare.net/git/production/repo-1.git'
const restRemote = 'https://acct.artifacts.cloudflare.net/git/production/repo-1-rest.git'

type FetchCall = { method: string; url: string }

type NativeRepo = ReturnType<typeof nativeRepo>

const calls: Array<FetchCall> = []
const originalFetch = globalThis.fetch

afterEach(() => {
	calls.length = 0
	globalThis.fetch = originalFetch
})

function nativeRepo(overrides: Record<string, unknown> = {}) {
	return {
		id: 'repo_1',
		name: 'repo-1',
		description: null,
		defaultBranch: 'main',
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:00:00.000Z',
		lastPushAt: null,
		source: null,
		readOnly: false,
		remote: nativeRemote,
		createToken: async () => ({
			id: 'tok_native',
			token: 'art_v2_read?expires=1760000100',
			scope: 'read',
		}),
		...overrides,
	}
}

function bindingEnv(createToken: NativeRepo['createToken'] = nativeRepo().createToken): ArtifactAccessEnv {
	return {
		ARTIFACTS_NAMESPACE: 'production',
		ARTIFACTS: {
			create: () => undefined,
			get: async () => nativeRepo({ createToken }),
		},
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'worker-secret-rejected-by-artifacts',
	}
}

function installFetch(handler: (method: string, url: URL) => Response) {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		calls.push({ method, url: url.toString() })
		return handler(method, url)
	}) as typeof fetch
}

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function authenticationError() {
	return jsonResponse(401, {
		success: false,
		result: null,
		errors: [{ code: 10000, message: 'Authentication error' }],
		messages: [],
	})
}

describe('artifact repo access with a native ARTIFACTS binding', () => {
	it('uses the binding for info and createToken when REST would 401', async () => {
		installFetch(() => authenticationError())
		const env = bindingEnv()
		const repo = await openArtifactRepo(env, 'repo-1')
		assert.equal((await repo.info())?.remote, nativeRemote)
		assert.deepEqual(await repo.createToken('read', 120), {
			id: 'tok_native',
			plaintext: 'art_v2_read?expires=1760000100',
			scope: 'read',
			expiresAt: '2025-10-09T08:55:00.000Z',
		})
		const verified = await verifyRestorableArtifactBackup(env, 'repo-1')
		assert.deepEqual(verified, {
			remote: nativeRemote,
			defaultBranch: 'main',
			tokenId: 'tok_native',
			expiresAt: '2025-10-09T08:55:00.000Z',
		})
		const session = await openArtifactRepoSession(env, 'repo-1', { scope: 'write', ttl: 600 })
		assert.equal(session.remote, nativeRemote)
		assert.equal(session.token, 'art_v2_read?expires=1760000100')
		assert.equal(calls.length, 0)
	})

	it('falls back to REST only when native createToken throws the JSRPC split error', async () => {
		installFetch((method, url) => {
			assert.equal(method, 'POST')
			assert.match(url.pathname, /\/namespaces\/production\/tokens$/)
			return jsonResponse(200, {
				success: true,
				result: {
					id: 'tok_rest',
					plaintext: 'art_v1_rest?expires=1760000100',
					scope: 'read',
					expires_at: '2026-10-09T08:55:00.000Z',
				},
				errors: [],
				messages: [],
			})
		})
		const env = bindingEnv(async () => {
			throw new Error("Cannot read properties of undefined (reading 'split')")
		})
		const repo = await openArtifactRepo(env, 'repo-1')
		assert.deepEqual(await repo.createToken('read', 120), {
			id: 'tok_rest',
			plaintext: 'art_v1_rest?expires=1760000100',
			scope: 'read',
			expiresAt: '2026-10-09T08:55:00.000Z',
		})
		assert.equal(calls.length, 1)
	})

	it('does not surface a REST 401 when native createToken hits the JSRPC split error', async () => {
		installFetch(() => authenticationError())
		const env = bindingEnv(async () => {
			throw new Error('undefined.split')
		})
		const repo = await openArtifactRepo(env, 'repo-1')
		await assert.rejects(repo.createToken('read', 120), /Artifacts native createToken failed: undefined\.split/)
		await assert.rejects(repo.createToken('read', 120), (error: unknown) => {
			assert.ok(error instanceof Error)
			assert.notEqual(error.message, 'Authentication error')
			return true
		})
	})

	it('keeps native info when the binding remote is empty and REST info 401s', async () => {
		installFetch(() => authenticationError())
		const env = bindingEnv()
		env.ARTIFACTS = {
			create: () => undefined,
			get: async () => nativeRepo({ remote: '' }),
		}
		const repo = await openArtifactRepo(env, 'repo-1')
		assert.equal((await repo.info())?.remote, '')
		await assert.rejects(verifyRestorableArtifactBackup(env, 'repo-1'), /remote URL is unavailable/)
	})
})

describe('artifact repo access without a native binding', () => {
	const restEnv: ArtifactAccessEnv = {
		ARTIFACTS_NAMESPACE: 'production',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.example.com',
	}

	it('uses the REST API for info and createToken', async () => {
		installFetch((method, url) => {
			assert.equal(url.origin, 'https://api.example.com')
			if (method === 'GET' && url.pathname.endsWith('/repos/repo-1')) {
				return jsonResponse(200, {
					success: true,
					result: {
						id: 'repo_1',
						name: 'repo-1',
						description: null,
						default_branch: 'main',
						created_at: '2026-04-17T00:00:00.000Z',
						updated_at: '2026-04-17T00:00:00.000Z',
						last_push_at: null,
						source: null,
						read_only: false,
						remote: restRemote,
					},
					errors: [],
					messages: [],
				})
			}
			if (method === 'POST' && url.pathname.endsWith('/tokens')) {
				return jsonResponse(200, {
					success: true,
					result: {
						id: 'tok_rest',
						plaintext: 'art_v1_read?expires=1760000100',
						scope: 'read',
						expires_at: '2026-10-09T08:55:00.000Z',
					},
					errors: [],
					messages: [],
				})
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})
		const verified = await verifyRestorableArtifactBackup(restEnv, 'repo-1')
		assert.deepEqual(verified, {
			remote: restRemote,
			defaultBranch: 'main',
			tokenId: 'tok_rest',
			expiresAt: '2026-10-09T08:55:00.000Z',
		})
		assert.deepEqual(
			calls.map((call) => call.method),
			['GET', 'POST'],
		)
	})

	it('still surfaces Authentication error when REST is the only path', async () => {
		installFetch(() => authenticationError())
		await assert.rejects(openArtifactRepoSession(restEnv, 'repo-1'), /Authentication error/)
	})

	it('requires the binding or REST credentials', async () => {
		await assert.rejects(openArtifactRepo({}, 'repo-1'), /ARTIFACTS binding or CLOUDFLARE_ACCOUNT_ID/)
	})
})
