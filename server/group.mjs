/**
 * Multi-environment ("group") connections.
 *
 * A group is several AdminServers — one per domain — each narrowed to one
 * cluster. The console talks to a group exactly as it talks to one domain: every
 * REST call goes to the members it concerns, each answer is cut down to that
 * member's cluster, and the answers are merged into the shape a single domain
 * would have given. That is what lets every page work unchanged.
 *
 * Nothing here does I/O. index.mjs supplies the upstream call; this file decides
 * who is asked, what is kept and how the answers are put together, which is the
 * part with an answer that can be wrong.
 */

/** A reference arrives as {identity: [...]}, as a bare identity array, or as a name. */
export function refName(value) {
  if (!value) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    if (value.every((part) => typeof part === 'string')) return value[value.length - 1] ?? null
    return null
  }
  if (Array.isArray(value.identity)) return value.identity[value.identity.length - 1] ?? null
  return value.name ?? null
}

const refList = (value) => (Array.isArray(value) && !value.every((v) => typeof v === 'string') ? value : value ? [value] : [])

/** The one search that tells a member what belongs to its cluster. */
export const SCOPE_PAYLOAD = JSON.stringify({
  links: [],
  fields: ['name'],
  children: {
    servers: { links: [], fields: ['name', 'cluster'] },
    clusters: { links: [], fields: ['name', 'servers'] },
    appDeployments: { links: [], fields: ['name', 'targets'] },
    libraries: { links: [], fields: ['name', 'targets'] },
    JDBCSystemResources: { links: [], fields: ['name', 'targets'] },
  },
})

/**
 * Works out what a member's cluster covers from its configuration: the member
 * servers, and every application, library and data source targeted to the
 * cluster or to one of those servers.
 *
 * @returns {{domainName, clusters: string[], servers: Set, apps: Set, libraries: Set, dataSources: Set, found: boolean}}
 */
export function buildScope(config, cluster) {
  const items = (key) => config?.[key]?.items ?? []
  const clusters = items('clusters').map((c) => c?.name).filter(Boolean)
  const servers = new Set()
  for (const server of items('servers')) {
    if (server?.name && refName(server.cluster) === cluster) servers.add(server.name)
  }
  // Some releases fill in only the cluster's own list, so both are read.
  for (const entry of items('clusters')) {
    if (entry?.name !== cluster) continue
    for (const member of refList(entry.servers)) {
      const name = refName(member)
      if (name) servers.add(name)
    }
  }

  const targeted = (resource) =>
    refList(resource?.targets).some((target) => {
      const name = refName(target)
      return name === cluster || servers.has(name)
    })
  const namesOf = (key) => new Set(items(key).filter(targeted).map((r) => r.name).filter(Boolean))

  return {
    domainName: config?.name || '',
    clusters,
    found: clusters.includes(cluster),
    servers,
    apps: namesOf('appDeployments'),
    libraries: namesOf('libraries'),
    dataSources: namesOf('JDBCSystemResources'),
  }
}

/**
 * Two domains may both have a server called ms1. Those are shown as
 * `ms1@<member label>` so that the pages, the charts and the actions can still
 * tell them apart; names that are unique across the group are left alone.
 *
 * Mutates each member: `aliasOf` (real → shown) and `realOf` (shown → real).
 */
export function assignAliases(members) {
  const count = new Map()
  for (const member of members) {
    for (const name of member.scope?.servers ?? []) count.set(name, (count.get(name) || 0) + 1)
  }
  for (const member of members) {
    member.aliasOf = new Map()
    member.realOf = new Map()
    for (const name of member.scope?.servers ?? []) {
      const shown = count.get(name) > 1 ? `${name}@${member.label}` : name
      member.aliasOf.set(name, shown)
      member.realOf.set(shown, name)
    }
  }
}

/** A short label per member: the domain name, or host:port when domains share a name. */
export function assignLabels(members) {
  const byDomain = new Map()
  for (const member of members) {
    const key = member.scope?.domainName || ''
    byDomain.set(key, (byDomain.get(key) || 0) + 1)
  }
  for (const member of members) {
    const domain = member.scope?.domainName
    member.label = domain && byDomain.get(domain) === 1 ? domain : `${member.host}:${member.port}`
  }
}

// ------------------------------------------------------------------ routing

const SERVER_COLLECTIONS = new Set(['serverRuntimes', 'serverLifeCycleRuntimes', 'servers'])
const SCOPED_COLLECTIONS = {
  appDeployments: 'apps',
  appDeploymentRuntimes: 'apps',
  libraries: 'libraries',
  JDBCSystemResources: 'dataSources',
}

const decode = (segment) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Decides which members a request goes to, and rewrites the path for each.
 *
 * - A path naming a server goes to the one member that owns it, with the shown
 *   name turned back into the real one.
 * - A path naming an application, library, data source or cluster goes to every
 *   member whose cluster has it — and only those, so stopping an application
 *   never reaches a domain where it serves some other cluster.
 * - Anything else is a question for every member.
 *
 * @returns {{member, path: string}[]} empty when nothing in the group has it
 */
export function routeRequest(members, restPath) {
  const [pathname, query = ''] = restPath.split(/\?(.*)/s)
  const segments = pathname.split('/')
  const suffix = query ? `?${query}` : ''

  // The first named segment decides. /serverRuntimes/ms1/applicationRuntimes/app
  // belongs to ms1's member whatever the application is called.
  for (let i = 0; i < segments.length - 1; i++) {
    const collection = segments[i]
    const shown = decode(segments[i + 1])
    if (!shown) continue

    if (SERVER_COLLECTIONS.has(collection)) {
      const out = []
      for (const member of members) {
        const real = member.realOf?.get(shown)
        if (real === undefined) continue
        const rewritten = [...segments]
        rewritten[i + 1] = encodeURIComponent(real)
        out.push({ member, path: rewritten.join('/') + suffix })
      }
      return out
    }

    const scopeKey = SCOPED_COLLECTIONS[collection]
    if (scopeKey) {
      return members
        .filter((member) => member.scope?.[scopeKey]?.has(shown))
        .map((member) => ({ member, path: restPath }))
    }

    if (collection === 'clusters') {
      return members.filter((member) => member.cluster === shown).map((member) => ({ member, path: restPath }))
    }
  }

  return members.map((member) => ({ member, path: restPath }))
}

/**
 * Actions that name what they act on in the body rather than in the path. Only
 * the members that have that application are asked.
 */
export function routeByBody(routes, body) {
  let parsed
  try {
    parsed = body?.length ? JSON.parse(body.toString('utf8')) : null
  } catch {
    return routes
  }
  const app = parsed?.appid ?? parsed?.applicationName
  if (typeof app !== 'string') return routes
  return routes.filter(({ member }) => member.scope?.apps?.has(app))
}

/** A server named in a body (a deployment target) is turned back into its real name. */
export function rewriteBody(member, body) {
  if (!body?.length || !member.realOf?.size) return body
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (typeof parsed?.target === 'string' && member.realOf.has(parsed.target)) {
    parsed.target = member.realOf.get(parsed.target)
    return Buffer.from(JSON.stringify(parsed))
  }
  return body
}

// ---------------------------------------------------------------- filtering

/**
 * Cuts one member's answer down to its cluster and renames colliding servers.
 *
 * Collections are recognised by the key they sit under — `serverRuntimes`,
 * `appDeployments` and so on — which is the same wherever they appear: at the
 * top of a GET, or deep inside a search. A collection fetched on its own has no
 * key above it, so the last segment of the request path stands in.
 */
export function scopeResponse(member, payload, restPath = '') {
  const segments = restPath.split('?')[0].split('/').filter(Boolean)
  // One server read on its own — /serverRuntimes/ms1 — still carries its name.
  const parent = segments[segments.length - 2]
  const rootKey = SERVER_COLLECTIONS.has(parent) ? parent : segments[segments.length - 1] || ''
  return walk(payload, rootKey, member)
}

function keepItem(key, item, member) {
  const scope = member.scope
  if (!scope || !item || typeof item !== 'object' || typeof item.name !== 'string') return true
  if (SERVER_COLLECTIONS.has(key)) return scope.servers.has(item.name)
  if (key === 'clusters') return item.name === member.cluster
  const scopeKey = SCOPED_COLLECTIONS[key]
  if (scopeKey) return scope[scopeKey].has(item.name)
  return true
}

function renameIdentity(identity, member) {
  if (!Array.isArray(identity) || identity.length < 2) return identity
  const kind = identity[identity.length - 2]
  if (!SERVER_COLLECTIONS.has(kind)) return identity
  const shown = member.aliasOf?.get(identity[identity.length - 1])
  return shown === undefined ? identity : [...identity.slice(0, -1), shown]
}

function walk(value, key, member) {
  if (Array.isArray(value)) {
    // A bare identity array: ['servers', 'ms1'].
    if (value.length >= 2 && value.every((v) => typeof v === 'string')) {
      if (key === 'serverNames') return value.map((name) => member.aliasOf?.get(name) ?? name)
      return renameIdentity(value, member)
    }
    return value.map((entry) => walk(entry, key, member))
  }
  if (!value || typeof value !== 'object') return value

  const out = {}
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === 'items' && Array.isArray(child)) {
      out.items = child.filter((item) => keepItem(key, item, member)).map((item) => walk(item, key, member))
    } else if (childKey === 'identity' && Array.isArray(child)) {
      out.identity = renameIdentity(child, member)
    } else if (childKey === 'name' && typeof child === 'string' && SERVER_COLLECTIONS.has(key)) {
      out.name = member.aliasOf?.get(child) ?? child
    } else if (childKey === 'serverNames' && Array.isArray(child)) {
      out.serverNames = child.map((name) => (typeof name === 'string' ? (member.aliasOf?.get(name) ?? name) : name))
    } else {
      out[childKey] = walk(child, childKey, member)
    }
  }
  return out
}

// ------------------------------------------------------------------ merging

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const signature = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

/**
 * Puts the answers of several members together into one.
 *
 * Collections are joined by name: the same application deployed in two domains
 * becomes one row whose targets are the union of both. Lists of references and
 * of plain values are unioned. Anything else keeps the first member's value,
 * which for a domain-level attribute is as good an answer as any.
 */
export function mergeResponses(payloads) {
  const present = payloads.filter((p) => p !== undefined && p !== null)
  if (!present.length) return null
  return present.slice(1).reduce((acc, next) => merge(acc, next), present[0])
}

function merge(a, b) {
  if (a === undefined || a === null) return b
  if (b === undefined || b === null) return a

  if (Array.isArray(a) && Array.isArray(b)) {
    const named = [...a, ...b].every((entry) => isPlainObject(entry) && typeof entry.name === 'string')
    if (named) {
      const byName = new Map()
      for (const entry of [...a, ...b]) {
        byName.set(entry.name, byName.has(entry.name) ? merge(byName.get(entry.name), entry) : entry)
      }
      return [...byName.values()]
    }
    const seen = new Set()
    const out = []
    for (const entry of [...a, ...b]) {
      const key = signature(entry)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
    return out
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a }
    for (const [key, value] of Object.entries(b)) out[key] = key in a ? merge(a[key], value) : value
    return out
  }

  return a
}

/**
 * The answer to a request fanned out over several members.
 *
 * Reads tolerate a member being down — one unreachable domain must not blank
 * every page — and report it in `failed`. Actions do not: an operation that
 * reached two domains out of three is reported as the failure it partly is.
 *
 * @param {{member, status, body, contentType, error}[]} results
 */
export function combineResults(results, { method = 'GET', restPath = '' } = {}) {
  const ok = results.filter((r) => !r.error && r.status < 400)
  const failed = results.filter((r) => r.error || r.status >= 400)
  const isRead = method === 'GET' || method === 'HEAD' || /\/search$/.test(restPath.split('?')[0])

  if (!ok.length || (!isRead && failed.length)) {
    const first = failed.find((r) => !r.error && r.status !== 404) || failed.find((r) => !r.error) || failed[0]
    return { failure: first, failed }
  }

  const json = ok.filter((r) => String(r.contentType).includes('json'))
  if (json.length !== ok.length) return { passthrough: ok[0], failed }

  const parsed = []
  for (const result of json) {
    try {
      const text = result.body.toString('utf8')
      parsed.push(text ? scopeResponse(result.member, JSON.parse(text), result.path) : null)
    } catch {
      return { passthrough: ok[0], failed }
    }
  }
  return { status: ok[0].status, payload: mergeResponses(parsed), failed }
}
