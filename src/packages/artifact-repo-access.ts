// Restorable-backup checks and repo-session opens need a git remote and a
// short-lived token. When the worker has an ARTIFACTS binding, that binding
// is the credential: CLOUDFLARE_API_TOKEN is a different Worker secret and
// the Artifacts tokens route rejects it with 401. REST stays for workers
// that have no binding (they only have ARTIFACTS_NAMESPACE plus the API token).
//
// Same rule as kentcdodds/kody packages/worker/src/repo/artifacts.ts
// (`adaptNativeRepoHandle`). Native createToken once threw `undefined.split`
// across JSRPC before plaintext/token mapping (#1442); that is the only
// remaining REST fallback, and a 401 from it must not replace the native error.

export type ArtifactToken = {
	id: string
	plaintext: string
	scope: string
	expiresAt: string
}

export type ArtifactRepoInfo = {
	id: string
	name: string
	description: string | null
	defaultBranch: string
	createdAt: string
	updatedAt: string
	lastPushAt: string | null
	source: string | null
	readOnly: boolean
	remote: string
}

export type ArtifactRepoHandle = {
	info(): Promise<ArtifactRepoInfo | null>
	createToken(scope?: 'write' | 'read', ttl?: number): Promise<ArtifactToken>
}

export type ArtifactAccessEnv = {
	ARTIFACTS?: NativeArtifacts | null
	ARTIFACTS_NAMESPACE?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
}

type NativeTokenResult = {
	id: string
	plaintext?: string
	token?: string
	scope: string
	expiresAt?: string
}

type NativeRepo = ArtifactRepoInfo & {
	createToken(scope?: 'write' | 'read', ttl?: number): Promise<NativeTokenResult>
}

type NativeArtifacts = {
	create: (...args: Array<unknown>) => unknown
	get(name: string): Promise<NativeRepo>
}

type RestRepoInfo = {
	id: string
	name: string
	description: string | null
	default_branch: string
	created_at: string
	updated_at: string
	last_push_at: string | null
	source: string | null
	read_only: boolean
	remote: string
}

type RestTokenResult = {
	id: string
	plaintext?: string
	token?: string
	scope: string
	expires_at: string
}

const missingArtifactsAccessMessage =
	'Cloudflare Artifacts access requires the ARTIFACTS binding or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.'

function readNativeArtifactsBinding(env: ArtifactAccessEnv): NativeArtifacts | null {
	const binding = env.ARTIFACTS
	if (!binding || typeof binding.create !== 'function' || typeof binding.get !== 'function') return null
	return binding
}

function artifactsNamespace(env: ArtifactAccessEnv) {
	const configured = env.ARTIFACTS_NAMESPACE?.trim()
	return configured && configured.length > 0 ? configured : 'default'
}

function restCredentials(env: ArtifactAccessEnv) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return null
	const configuredBase = env.CLOUDFLARE_API_BASE_URL?.trim()
	return {
		accountId,
		apiToken,
		baseUrl: (configuredBase && configuredBase.length > 0 ? configuredBase : 'https://api.cloudflare.com').replace(
			/\/$/,
			'',
		),
		namespace: artifactsNamespace(env),
	}
}

function errorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	return String(error)
}

function isArtifactsAuthenticationError(error: unknown) {
	return errorMessage(error) === 'Authentication error'
}

function isNativeCreateTokenJsrpcSplit(error: unknown) {
	const message = errorMessage(error)
	return message.includes('undefined.split') || message.includes("reading 'split'")
}

function tryParseArtifactTokenExpiry(token: string) {
	const expiresAtSeconds = Number.parseInt(token.split('?expires=')[1] ?? '', 10)
	if (Number.isFinite(expiresAtSeconds)) return new Date(expiresAtSeconds * 1000).toISOString()
	return null
}

function readArtifactTokenPlaintext(token: { plaintext?: unknown; token?: unknown }) {
	if (typeof token.plaintext === 'string' && token.plaintext.length > 0) return token.plaintext
	// Native create() uses `token`; createToken is typed as `plaintext`.
	// JSRPC can drop one of them. Accept either so callers never split undefined.
	if (typeof token.token === 'string' && token.token.length > 0) return token.token
	throw new Error('Artifacts createToken result is missing plaintext.')
}

function resolveCreatedTokenExpiry(input: { token: string; tokenExpiresAt?: string | null }) {
	const fromBinding = input.tokenExpiresAt?.trim()
	if (fromBinding) return fromBinding
	return tryParseArtifactTokenExpiry(input.token) ?? ''
}

function nativeRepoInfo(repo: NativeRepo): ArtifactRepoInfo {
	return {
		id: repo.id,
		name: repo.name,
		description: repo.description,
		defaultBranch: repo.defaultBranch,
		createdAt: repo.createdAt,
		updatedAt: repo.updatedAt,
		lastPushAt: repo.lastPushAt,
		source: repo.source,
		readOnly: repo.readOnly,
		remote: repo.remote,
	}
}

function wrapNativeCreateTokenError(error: unknown) {
	return new Error(`Artifacts native createToken failed: ${errorMessage(error)}`, { cause: error })
}

async function mintNativeArtifactToken(repo: NativeRepo, scope: 'write' | 'read', ttl: number): Promise<ArtifactToken> {
	const token = await repo.createToken(scope, ttl)
	const plaintext = readArtifactTokenPlaintext(token)
	return {
		id: token.id,
		plaintext,
		scope: token.scope,
		expiresAt: resolveCreatedTokenExpiry({
			token: plaintext,
			tokenExpiresAt: typeof token.expiresAt === 'string' ? token.expiresAt : null,
		}),
	}
}

type ArtifactApiEnvelope<T> = {
	result?: T | null
	success?: boolean
	errors?: Array<{ message?: string }>
}

async function artifactsRest<T>(
	env: ArtifactAccessEnv,
	input: { method: 'GET' | 'POST'; path: string; body?: unknown; treat404AsNull?: boolean },
): Promise<T | null> {
	const credentials = restCredentials(env)
	if (!credentials) throw new Error(missingArtifactsAccessMessage)
	const url = `${credentials.baseUrl}/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/artifacts/namespaces/${encodeURIComponent(credentials.namespace)}${input.path}`
	const response = await fetch(url, {
		method: input.method,
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${credentials.apiToken}`,
			...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
	})
	const text = await response.text()
	let envelope: ArtifactApiEnvelope<T> | null = null
	if (text.trim()) {
		try {
			envelope = JSON.parse(text) as ArtifactApiEnvelope<T>
		} catch {
			throw new Error(`Cloudflare API returned non-JSON (${response.status}).`)
		}
	}
	if (!envelope?.success) {
		if (input.treat404AsNull && response.status === 404) return null
		const message = envelope?.errors?.[0]?.message ?? `Artifacts API request failed (${response.status}).`
		throw new Error(message)
	}
	return envelope.result ?? null
}

function restRepoHandle(env: ArtifactAccessEnv, name: string): ArtifactRepoHandle {
	const encoded = encodeURIComponent(name)
	return {
		info: async () => {
			const repo = await artifactsRest<RestRepoInfo>(env, {
				method: 'GET',
				path: `/repos/${encoded}`,
				treat404AsNull: true,
			})
			if (!repo) return null
			return {
				id: repo.id,
				name: repo.name,
				description: repo.description,
				defaultBranch: repo.default_branch,
				createdAt: repo.created_at,
				updatedAt: repo.updated_at,
				lastPushAt: repo.last_push_at,
				source: repo.source,
				readOnly: repo.read_only,
				remote: repo.remote,
			}
		},
		createToken: async (scope: 'write' | 'read' = 'write', ttl = 3600) => {
			const result = await artifactsRest<RestTokenResult>(env, {
				method: 'POST',
				path: '/tokens',
				body: { repo: name, scope, ttl },
			})
			if (!result) throw new Error('Artifacts API returned no result for /tokens.')
			const plaintext = readArtifactTokenPlaintext(result)
			return {
				id: result.id,
				plaintext,
				scope: result.scope,
				expiresAt: result.expires_at,
			}
		},
	}
}

function adaptNativeRepoHandle(repo: NativeRepo, restRepo?: ArtifactRepoHandle): ArtifactRepoHandle {
	return {
		info: async () => {
			const nativeInfo = nativeRepoInfo(repo)
			if (nativeInfo.remote) return nativeInfo
			if (restRepo) {
				try {
					const info = await restRepo.info()
					if (info?.remote) return info
				} catch (error) {
					if (!isArtifactsAuthenticationError(error)) throw error
				}
			}
			return nativeInfo
		},
		createToken: async (scope: 'write' | 'read' = 'write', ttl = 3600) => {
			try {
				return await mintNativeArtifactToken(repo, scope, ttl)
			} catch (error) {
				if (!restRepo || !isNativeCreateTokenJsrpcSplit(error)) throw wrapNativeCreateTokenError(error)
				try {
					return await restRepo.createToken(scope, ttl)
				} catch (restError) {
					if (isArtifactsAuthenticationError(restError)) throw wrapNativeCreateTokenError(error)
					throw restError
				}
			}
		},
	}
}

/** Local handle for a repo. Does not fetch until `info` / `createToken`. */
export async function openArtifactRepo(env: ArtifactAccessEnv, repoName: string): Promise<ArtifactRepoHandle> {
	const native = readNativeArtifactsBinding(env)
	const rest = restCredentials(env) ? restRepoHandle(env, repoName) : undefined
	if (native) {
		const repo = await native.get(repoName)
		return adaptNativeRepoHandle(repo, rest)
	}
	if (rest) return rest
	throw new Error(missingArtifactsAccessMessage)
}

/**
 * Confirms the published repo can be read back: native info + a read token
 * when the binding exists, otherwise the REST API.
 */
export async function verifyRestorableArtifactBackup(env: ArtifactAccessEnv, repoName: string) {
	const repo = await openArtifactRepo(env, repoName)
	const [info, token] = await Promise.all([repo.info(), repo.createToken('read', 300)])
	if (!info?.remote) throw new Error('Artifact repo remote URL is unavailable.')
	if (!token.plaintext) throw new Error('Artifacts createToken result is missing plaintext.')
	return {
		remote: info.remote,
		defaultBranch: info.defaultBranch || 'main',
		tokenId: token.id,
		expiresAt: token.expiresAt,
	}
}

/** Opens a repo session remote. The plaintext token is returned once, at issuance. */
export async function openArtifactRepoSession(
	env: ArtifactAccessEnv,
	repoName: string,
	input: { scope?: 'write' | 'read'; ttl?: number } = {},
) {
	const repo = await openArtifactRepo(env, repoName)
	const scope = input.scope ?? 'write'
	const ttl = input.ttl ?? 3600
	const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttl)])
	if (!info?.remote) throw new Error('Artifact repo remote URL is unavailable.')
	return {
		remote: info.remote,
		defaultBranch: info.defaultBranch || 'main',
		token: token.plaintext,
		tokenId: token.id,
		expiresAt: token.expiresAt,
	}
}
