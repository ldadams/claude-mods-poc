// Remote: features to pull from the configured MCP sources.

import { CONFIG_PATH } from '../lib/constants.js'
import { setActiveFeature } from '../lib/focus.js'
import { pullRemote, refreshRemoteLists, remoteFeatureId } from '../lib/remote.js'
import { pane } from '../lib/state.js'

export async function remoteView(io, ctx, kit) {
  const { Box, Text } = ctx.el
  const { allFeatures } = ctx
  const { go, hint, gap, rule, section, key, actions, card, topBar, nextKey, footer } = kit
  let rows
  const pulledIds = new Set(allFeatures.map((f) => f.id))
  const sourceNames = Object.keys(pane.remoteLists)
  rows = [
    topBar(['Remote']),
    rule(),
    actions([
      key('back', 'back', 'b', () => go({ kind: 'home' }), { dimColor: true }),
      nextKey(),
      key('remote-refresh', 'refresh', 'r', () => refreshRemoteLists(io), { dimColor: true }),
    ]),
    gap(),
    ...(pane.remoteError ? [card('remote-error', [Text({ children: [pane.remoteError.trim()], color: 'error', wrap: 'wrap' })], 'error')] : []),
    ...(sourceNames.length === 0 && !pane.remoteError ? [hint('No remote sources. Add one to ' + CONFIG_PATH + ' (see the workbench README).')] : []),
    ...sourceNames.flatMap((name) => [
      section(name, pane.remoteLists[name].length),
      ...(pane.remoteLists[name].length === 0
        ? [hint('Nothing returned.')]
        : pane.remoteLists[name].map((item) => {
            const localId = remoteFeatureId(item.source, item.remoteId)
            const pulled = pulledIds.has(localId)
            return Box({
              key: 'remote-row-' + localId,
              flexDirection: 'row',
              columnGap: 1,
              children: [
                key('pull-' + localId, pulled ? 'open' : 'load', undefined, async () => {
                  const feature = await pullRemote(io, item)
                  await setActiveFeature(io, feature.id)
                  pane.view = { kind: 'feature', id: feature.id }
                }, pulled ? undefined : { dimColor: true }),
                Box({ width: 10, children: [hint(item.remoteId)] }),
                ...(item.status ? [Text({ children: [item.status], color: 'suggestion' })] : []),
                Text({ children: [item.title], wrap: 'truncate-end', ...(pulled ? { bold: true } : {}) }),
              ],
            })
          })),
      gap(),
    ]),
    ...footer('b back · r refresh · Esc close'),
  ]
  return rows
}
