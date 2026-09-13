import { describe, expect, it } from 'vitest'
import {
  assignAliases,
  assignLabels,
  buildScope,
  combineResults,
  mergeResponses,
  refName,
  rewriteBody,
  routeByBody,
  routeRequest,
  scopeResponse,
} from '../../server/group.mjs'

/** A domain's configuration as the scope search answers it. */
const domainConfig = (name, { cluster = 'Cluster-1', servers = ['ms1', 'ms2'], others = ['other1'] } = {}) => ({
  name,
  servers: {
    items: [
      { name: 'AdminServer', cluster: null },
      ...servers.map((server) => ({ name: server, cluster: { identity: ['clusters', cluster] } })),
      ...others.map((server) => ({ name: server, cluster: { identity: ['clusters', 'Other'] } })),
    ],
  },
  clusters: { items: [{ name: cluster, servers: [] }, { name: 'Other', servers: [] }] },
  appDeployments: {
    items: [
      { name: 'shop', targets: [{ identity: ['clusters', cluster] }] },
      { name: 'batch', targets: [{ identity: ['clusters', 'Other'] }] },
      { name: 'pinned', targets: [{ identity: ['servers', servers[0]] }] },
    ],
  },
  libraries: { items: [] },
  JDBCSystemResources: { items: [{ name: 'shopDS', targets: [{ identity: ['clusters', cluster] }] }] },
})

function member(host, config, cluster = 'Cluster-1') {
  return { host, port: 7001, cluster, scope: buildScope(config, cluster) }
}

function group(...members) {
  assignLabels(members)
  assignAliases(members)
  return members
}

describe('refName', () => {
  it('reads every shape a reference arrives in', () => {
    expect(refName({ identity: ['clusters', 'c1'] })).toBe('c1')
    expect(refName(['clusters', 'c1'])).toBe('c1')
    expect(refName('c1')).toBe('c1')
    expect(refName(null)).toBe(null)
  })
})

describe('buildScope', () => {
  it('keeps the cluster members and what is targeted to them', () => {
    const scope = buildScope(domainConfig('dom'), 'Cluster-1')
    expect(scope.found).toBe(true)
    expect([...scope.servers]).toEqual(['ms1', 'ms2'])
    expect([...scope.apps].sort()).toEqual(['pinned', 'shop'])
    expect([...scope.dataSources]).toEqual(['shopDS'])
  })

  it('reads membership from the cluster list when servers do not say', () => {
    const config = domainConfig('dom', { servers: [] })
    config.clusters.items[0].servers = [{ identity: ['servers', 'ms9'] }]
    expect([...buildScope(config, 'Cluster-1').servers]).toEqual(['ms9'])
  })

  it('reports a cluster that does not exist', () => {
    const scope = buildScope(domainConfig('dom'), 'Nope')
    expect(scope.found).toBe(false)
    expect(scope.clusters).toEqual(['Cluster-1', 'Other'])
  })
})

describe('aliases', () => {
  it('renames only servers whose name is used in more than one domain', () => {
    const [a, b] = group(
      member('h1', domainConfig('domA')),
      member('h2', domainConfig('domB', { servers: ['ms1', 'ms3'] })),
    )
    expect(a.aliasOf.get('ms1')).toBe('ms1@domA')
    expect(b.aliasOf.get('ms1')).toBe('ms1@domB')
    expect(a.aliasOf.get('ms2')).toBe('ms2')
    expect(b.realOf.get('ms1@domB')).toBe('ms1')
  })

  it('falls back to host:port when two domains share a name', () => {
    const [a] = group(member('h1', domainConfig('dom')), member('h2', domainConfig('dom', { servers: ['x'] })))
    expect(a.label).toBe('h1:7001')
  })
})

describe('routeRequest', () => {
  const members = group(
    member('h1', domainConfig('domA')),
    member('h2', domainConfig('domB', { servers: ['ms1', 'ms3'] })),
  )

  it('sends a server path to its owner, with the real name', () => {
    const routes = routeRequest(members, '/domainRuntime/serverLifeCycleRuntimes/ms1%40domB/start')
    expect(routes).toHaveLength(1)
    expect(routes[0].member.host).toBe('h2')
    expect(routes[0].path).toBe('/domainRuntime/serverLifeCycleRuntimes/ms1/start')
  })

  it('finds nothing for a server outside the clusters', () => {
    expect(routeRequest(members, '/domainRuntime/serverRuntimes/AdminServer')).toEqual([])
  })

  it('sends an application action only where the cluster has it', () => {
    const shop = routeRequest(members, '/domainRuntime/deploymentManager/appDeploymentRuntimes/shop/stop')
    expect(shop.map((r) => r.member.host)).toEqual(['h1', 'h2'])
    expect(routeRequest(members, '/domainRuntime/deploymentManager/appDeploymentRuntimes/batch/stop')).toEqual([])
  })

  it('asks every member anything that names nothing', () => {
    expect(routeRequest(members, '/domainRuntime/search')).toHaveLength(2)
    expect(routeRequest(members, '/domainConfig/servers?links=none')).toHaveLength(2)
  })

  it('narrows a body-addressed action to the members with that application', () => {
    const routes = routeRequest(members, '/domainRuntime/appRuntimeStateRuntime/getIntendedState')
    expect(routeByBody(routes, Buffer.from('{"appid":"batch"}'))).toEqual([])
    expect(routeByBody(routes, Buffer.from('{"appid":"shop"}'))).toHaveLength(2)
  })

  it('turns a server named in a body back into its real name', () => {
    const body = rewriteBody(members[1], Buffer.from('{"target":"ms1@domB"}'))
    expect(JSON.parse(body.toString())).toEqual({ target: 'ms1' })
  })
})

describe('scopeResponse', () => {
  const [a] = group(member('h1', domainConfig('domA')), member('h2', domainConfig('domB', { servers: ['ms1'] })))

  it('drops servers outside the cluster and renames colliding ones', () => {
    const payload = {
      serverRuntimes: {
        items: [
          { name: 'AdminServer', state: 'RUNNING' },
          { name: 'ms1', state: 'RUNNING', applicationRuntimes: { items: [{ name: 'shop' }] } },
          { name: 'ms2', state: 'RUNNING' },
          { name: 'other1', state: 'RUNNING' },
        ],
      },
    }
    const out = scopeResponse(a, payload, '/domainRuntime/search')
    expect(out.serverRuntimes.items.map((s) => s.name)).toEqual(['ms1@domA', 'ms2'])
    expect(out.serverRuntimes.items[0].applicationRuntimes.items[0].name).toBe('shop')
  })

  it('filters a collection fetched on its own by the path', () => {
    const out = scopeResponse(a, { items: [{ name: 'shop' }, { name: 'batch' }] }, '/domainConfig/appDeployments?links=none')
    expect(out.items.map((d) => d.name)).toEqual(['shop'])
  })

  it('renames servers inside references', () => {
    const out = scopeResponse(
      a,
      { items: [{ name: 'pinned', targets: [{ identity: ['servers', 'ms1'] }] }] },
      '/domainConfig/appDeployments',
    )
    expect(out.items[0].targets[0].identity).toEqual(['servers', 'ms1@domA'])
  })

  it('renames a single server read on its own', () => {
    expect(scopeResponse(a, { name: 'ms1' }, '/domainRuntime/serverRuntimes/ms1').name).toBe('ms1@domA')
  })
})

describe('mergeResponses', () => {
  it('joins collections by name and unions their targets', () => {
    const merged = mergeResponses([
      { items: [{ name: 'shop', targets: [{ identity: ['clusters', 'c1'] }] }] },
      { items: [{ name: 'shop', targets: [{ identity: ['clusters', 'c2'] }] }, { name: 'crm', targets: [] }] },
    ])
    expect(merged.items.map((d) => d.name)).toEqual(['shop', 'crm'])
    expect(merged.items[0].targets).toHaveLength(2)
  })

  it('puts servers of different domains side by side', () => {
    const merged = mergeResponses([
      { serverRuntimes: { items: [{ name: 'ms1@domA' }] } },
      { serverRuntimes: { items: [{ name: 'ms1@domB' }] } },
    ])
    expect(merged.serverRuntimes.items).toHaveLength(2)
  })
})

describe('combineResults', () => {
  const [a, b] = group(member('h1', domainConfig('domA')), member('h2', domainConfig('domB', { servers: ['ms7'] })))
  const ok = (m, payload) => ({
    member: m,
    path: '/domainRuntime/search',
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(payload)),
  })

  it('still answers a read when one member is down, and says which', () => {
    const result = combineResults(
      [ok(a, { serverRuntimes: { items: [{ name: 'ms1' }] } }), { member: b, error: new Error('refused') }],
      { method: 'POST', restPath: '/domainRuntime/search' },
    )
    expect(result.payload.serverRuntimes.items.map((s) => s.name)).toEqual(['ms1'])
    expect(result.failed).toHaveLength(1)
  })

  it('reports an action that did not reach every member as failed', () => {
    const result = combineResults(
      [ok(a, {}), { member: b, status: 400, contentType: 'application/json', body: Buffer.from('{}') }],
      { method: 'POST', restPath: '/domainRuntime/serverLifeCycleRuntimes/ms1/start' },
    )
    expect(result.failure.status).toBe(400)
  })
})
