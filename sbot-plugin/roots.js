'use strict'
var pull = require('pull-stream')
var FlumeViewLevel = require('flumeview-level')
var pullCat = require('pull-cat')
var HLRU = require('hashlru')
var extend = require('xtend')
var normalizeChannel = require('ssb-ref').normalizeChannel
var Defer = require('pull-defer')
var getRoot = require('../lib/get-root')
var getTimestamp = require('../lib/get-timestamp')
var Thread = require('./thread')

module.exports = function (ssb, config) {
  var thread = Thread(ssb, config)
  var create = FlumeViewLevel(0, function (msg, seq) {
    var result = [
      [getTimestamp(msg), getRoot(msg) || msg.key]
    ]
    return result
  })

  var index = ssb._flumeUse('patchtron-roots', create)

  // cache mostly just to avoid reading the same roots over and over again
  // not really big enough for multiple refresh cycles
  var cache = HLRU(100)

  return {
    latest: function ({ids = [ssb.id]}) {
      var stream = Defer.source()
      getFilter((err, filter) => {
        if (err) return stream.abort(err)
        stream.resolve(pull(
          index.read({old: false}),

          // BUMP FILTER
          pull.filter(item => {
            if (filter && item.value && item.value) {
              var filterResult = filter(ids, item.value)
              if (filterResult) {
                item.value.filterResult = filterResult
                return true
              }
            }
          }),

          // LOOKUP AND ADD ROOTS
          LookupRoots(),

          // FILTER ROOTS
          pull.filter(item => {
            var root = item.root || item
            var isPrivate = root.value && root.value.private

            if (filter && root && root.value && !isPrivate) {
              var filterResult = filter(ids, root)
              if (checkReplyForcesDisplay(item) || shouldShow(filterResult)) {
                root.filterResult = filterResult
                return true
              }
            }
          })
        ))
      })
      return stream
    },

    read: function ({ids = [ssb.id], reverse, limit, lt, gt}) {
      var opts = {reverse, old: true}

      // handle markers passed in to lt / gt
      if (lt && typeof lt.timestamp === 'number') lt = lt.timestamp
      if (gt && typeof gt.timestamp === 'number') gt = gt.timestamp
      if (typeof lt === 'number') opts.lt = [lt]
      if (typeof gt === 'number') opts.gt = [gt]

      var seen = new Set()
      var included = new Set()
      var marker = {marker: true, timestamp: null}

      var stream = Defer.source()


      getFilter((err, filter) => {
        if (err) return stream.abort(err)

        stream.resolve(pull(
          // READ ROOTS INDEX
          index.read(opts),

          // BUMP FILTER
          pull.filter(item => {
            // keep track of latest timestamp
            marker.timestamp = item.key[0]

            if (filter && item.value && item.value) {
              var filterResult = filter(ids, item.value)
              if (filterResult) {
                item.value.filterResult = filterResult
                return true
              }
            }
          }),

          // LOOKUP AND ADD ROOTS
          LookupRoots(),

          // FILTER ROOTS
          pull.filter(item => {
            var root = item.root || item
            var isPrivate = root.value && root.value.private

            // skip this item if it has already been included
            if (!included.has(root.key) && filter && root && root.value && !isPrivate) {
              if (checkReplyForcesDisplay(item)) { // include this item if it has matching tags or the author is you
                // update filter result so that we can display the correct bump message
                root.filterResult = extend(item.filterResult, {forced: true})
                included.add(root.key)
                return true
              } else if (!seen.has(root.key)) {
                seen.add(root.key)
                var filterResult = filter(ids, root)
                if (shouldShow(filterResult)) {
                  root.filterResult = filterResult
                  included.add(root.key)
                  return true
                }
              }
            }
          }),

          // MAP ROOT ITEMS
          pull.map(item => {
            var root = item.root || item
            return root
          }),

          // ADD THREAD SUMMARY
          pull.asyncMap((item, cb) => {
            thread.summary({dest: item.key, limit: 3}, (err, summary) => {
              if (err) return cb(err)
              cb(null, extend(item, summary))
            })
          })
        ))
      })

      // TRUNCATE
      if (typeof limit === 'number') {
        var count = 0
        return pullCat([
          pull(
            stream,
            pull.take(limit),
            pull.through(() => {
              count += 1
            })
          ),

          // send truncated marker for resuming search
          pull(
            pull.values([marker]),
            pull.filter(() => count === limit)
          )
        ])
      } else {
        return stream
      }
    }
  }

  function shouldShow (filterResult) {
    return !!filterResult
  }

  function getThruCache (key, cb) {
    if (cache.has(key)) {
      cb(null, cache.get(key))
    } else {
      // don't do an ooo lookup
      ssb.get({id: key, raw: true}, (_, value) => {
        var msg = {key, value}
        if (msg.value) {
          cache.set(key, msg)
        }
        cb(null, msg)
      })
    }
  }

  function getFilter (cb) {
    // TODO: rewrite contacts stream
    ssb.friends.get((err, friends) => {
      if (err) return cb(err)
      ssb['patchtron'].getSubscriptions((err, subscriptions) => {
        if (err) return cb(err)
        cb(null, function (ids, msg) {
          var type = msg.value.content.type
          if (type === 'vote') return false // filter out likes
          var hasChannel = !!msg.value.content.channel
          var matchesChannel = (type !== 'channel' && checkChannel(subscriptions, ids, msg.value.content.channel))
          var matchingTags = getMatchingTags(subscriptions, ids, msg.value.content.mentions)
          var isYours = ids.includes(msg.value.author)
          var mentionsYou = getMentionsYou(ids, msg.value.content.mentions)

          var following = checkFollowing(friends, ids, msg.value.author)
          if (isYours || matchesChannel || matchingTags.length || following || mentionsYou) {
            return {
              matchingTags, matchesChannel, isYours, following, mentionsYou, hasChannel
            }
          }
        })
      })
    })
  }

  function LookupRoots () {
    return pull.asyncMap((item, cb) => {
      var msg = item.value
      var key = item.key[1]

      if (key === msg.key) {
        // already a root
        return cb(null, msg)
      }
      getThruCache(key, (_, value) => {
        cb(null, extend(msg, {
          root: value
        }))
      })
    })
  }
}

function getMatchingTags (lookup, ids, mentions) {
  if (Array.isArray(mentions)) {
    return mentions.reduce((result, mention) => {
      if (mention && typeof mention.link === 'string' && mention.link.startsWith('#')) {
        if (checkChannel(lookup, ids, mention.link.slice(1))) {
          result.push(normalizeChannel(mention.link.slice(1)))
        }
      }
      return result
    }, [])
  }
  return []
}

function getMentionsYou (ids, mentions) {
  if (Array.isArray(mentions)) {
    return mentions.some((mention) => {
      if (mention && typeof mention.link === 'string') {
        return ids.includes(mention.link)
      }
    })
  }
}

function checkReplyForcesDisplay (item) {
  var filterResult = item.filterResult || {}
  var matchesTags = filterResult.matchingTags && !!filterResult.matchingTags.length
  return matchesTags || filterResult.isYours
}

function checkFollowing (lookup, ids, target) {
  // TODO: rewrite contacts index (for some reason the order is different)
  if (!lookup) return false
  // HACK: only lookup the first ID until a method is added to ssb-friends to
  // correctly identify latest info
  var value = ids.slice(0, 1).map(id => lookup[id] && lookup[id][target])
  return value && value[0]
}

function checkChannel (lookup, ids, channel) {
  if (!lookup) return false
  channel = normalizeChannel(channel)
  if (channel) {
    var value = mostRecentValue(ids.map(id => lookup[`${id}:${channel}`]))
    return value && value[1]
  }
}

function mostRecentValue (values, timestampIndex = 0) {
  var mostRecent = null
  values.forEach(value => {
    if (value && (!mostRecent || mostRecent[timestampIndex] < value[timestampIndex])) {
      mostRecent = value
    }
  })
  return mostRecent
}
