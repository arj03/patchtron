const pull = require('pull-stream')
const Next = require('pull-next')
var ENDED = {}

module.exports = PullChunk

function PullChunk (createStream, opts, range) {
  range = range || (opts.reverse ? 'lt' : 'gt')

  var last = null
  var count = -1

  return Next(function () {
    if (last) {
      if (count === 0) return
      var value = opts[range] = last
      if (value === ENDED) return
      last = null
    }
    return pull(
      createStream(clone(opts)),
      pull.through(function (msg) {
        count++
        if (!msg.sync) {
          last = msg
        }
      }, function (err) {
        // retry on errors...
        if (err) {
          count = -1
          return count
        }
        // end stream if there were no results
        if (last == null) last = ENDED
      })
    )
  })
}

function clone (obj) {
  var _obj = {}
  for (var k in obj) _obj[k] = obj[k]
  return _obj
}
