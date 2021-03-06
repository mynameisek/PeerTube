'use strict'

const each = require('async/each')
const eachLimit = require('async/eachLimit')
const eachSeries = require('async/eachSeries')
const fs = require('fs')
const mongoose = require('mongoose')
const request = require('request')
const waterfall = require('async/waterfall')

const constants = require('../initializers/constants')
const logger = require('../helpers/logger')
const requests = require('../helpers/requests')

const Pod = mongoose.model('Pod')
const Request = mongoose.model('Request')
const Video = mongoose.model('Video')

const friends = {
  addVideoToFriends,
  hasFriends,
  getMyCertificate,
  makeFriends,
  quitFriends,
  removeVideoToFriends,
  sendOwnedVideosToPod
}

function addVideoToFriends (video) {
  createRequest('add', constants.REQUEST_ENDPOINTS.VIDEOS, video)
}

function hasFriends (callback) {
  Pod.countAll(function (err, count) {
    if (err) return callback(err)

    const hasFriends = (count !== 0)
    callback(null, hasFriends)
  })
}

function getMyCertificate (callback) {
  fs.readFile(constants.CONFIG.STORAGE.CERT_DIR + 'peertube.pub', 'utf8', callback)
}

function makeFriends (hosts, callback) {
  const podsScore = {}

  logger.info('Make friends!')
  getMyCertificate(function (err, cert) {
    if (err) {
      logger.error('Cannot read public cert.')
      return callback(err)
    }

    eachSeries(hosts, function (host, callbackEach) {
      computeForeignPodsList(host, podsScore, callbackEach)
    }, function (err) {
      if (err) return callback(err)

      logger.debug('Pods scores computed.', { podsScore: podsScore })
      const podsList = computeWinningPods(hosts, podsScore)
      logger.debug('Pods that we keep.', { podsToKeep: podsList })

      makeRequestsToWinningPods(cert, podsList, callback)
    })
  })
}

function quitFriends (callback) {
  // Stop pool requests
  Request.deactivate()
  // Flush pool requests
  Request.flush()

  waterfall([
    function getPodsList (callbackAsync) {
      return Pod.list(callbackAsync)
    },

    function announceIQuitMyFriends (pods, callbackAsync) {
      const requestParams = {
        method: 'POST',
        path: '/api/' + constants.API_VERSION + '/pods/remove',
        sign: true
      }

      // Announce we quit them
      // We don't care if the request fails
      // The other pod will exclude us automatically after a while
      eachLimit(pods, constants.REQUESTS_IN_PARALLEL, function (pod, callbackEach) {
        requestParams.toPod = pod
        requests.makeSecureRequest(requestParams, callbackEach)
      }, function (err) {
        if (err) {
          logger.error('Some errors while quitting friends.', { err: err })
          // Don't stop the process
        }

        return callbackAsync(null, pods)
      })
    },

    function removePodsFromDB (pods, callbackAsync) {
      each(pods, function (pod, callbackEach) {
        pod.remove(callbackEach)
      }, callbackAsync)
    }
  ], function (err) {
    // Don't forget to re activate the scheduler, even if there was an error
    Request.activate()

    if (err) return callback(err)

    logger.info('Removed all remote videos.')
    return callback(null)
  })
}

function removeVideoToFriends (videoParams) {
  createRequest('remove', constants.REQUEST_ENDPOINTS.VIDEOS, videoParams)
}

function sendOwnedVideosToPod (podId) {
  Video.listOwned(function (err, videosList) {
    if (err) {
      logger.error('Cannot get the list of videos we own.')
      return
    }

    videosList.forEach(function (video) {
      video.toRemoteJSON(function (err, remoteVideo) {
        if (err) {
          logger.error('Cannot convert video to remote.', { error: err })
          // Don't break the process
          return
        }

        createRequest('add', constants.REQUEST_ENDPOINTS.VIDEOS, remoteVideo, [ podId ])
      })
    })
  })
}

// ---------------------------------------------------------------------------

module.exports = friends

// ---------------------------------------------------------------------------

function computeForeignPodsList (host, podsScore, callback) {
  getForeignPodsList(host, function (err, foreignPodsList) {
    if (err) return callback(err)

    if (!foreignPodsList) foreignPodsList = []

    // Let's give 1 point to the pod we ask the friends list
    foreignPodsList.push({ host })

    foreignPodsList.forEach(function (foreignPod) {
      const foreignPodHost = foreignPod.host

      if (podsScore[foreignPodHost]) podsScore[foreignPodHost]++
      else podsScore[foreignPodHost] = 1
    })

    callback()
  })
}

function computeWinningPods (hosts, podsScore) {
  // Build the list of pods to add
  // Only add a pod if it exists in more than a half base pods
  const podsList = []
  const baseScore = hosts.length / 2
  Object.keys(podsScore).forEach(function (podHost) {
    // If the pod is not me and with a good score we add it
    if (isMe(podHost) === false && podsScore[podHost] > baseScore) {
      podsList.push({ host: podHost })
    }
  })

  return podsList
}

function getForeignPodsList (host, callback) {
  const path = '/api/' + constants.API_VERSION + '/pods'

  request.get(constants.REMOTE_SCHEME.HTTP + '://' + host + path, function (err, response, body) {
    if (err) return callback(err)

    try {
      const json = JSON.parse(body)
      return callback(null, json)
    } catch (err) {
      return callback(err)
    }
  })
}

function makeRequestsToWinningPods (cert, podsList, callback) {
  // Stop pool requests
  Request.deactivate()
  // Flush pool requests
  Request.forceSend()

  eachLimit(podsList, constants.REQUESTS_IN_PARALLEL, function (pod, callbackEach) {
    const params = {
      url: constants.REMOTE_SCHEME.HTTP + '://' + pod.host + '/api/' + constants.API_VERSION + '/pods/',
      method: 'POST',
      json: {
        host: constants.CONFIG.WEBSERVER.HOST,
        publicKey: cert
      }
    }

    requests.makeRetryRequest(params, function (err, res, body) {
      if (err) {
        logger.error('Error with adding %s pod.', pod.host, { error: err })
        // Don't break the process
        return callbackEach()
      }

      if (res.statusCode === 200) {
        const podObj = new Pod({ host: pod.host, publicKey: body.cert })
        podObj.save(function (err, podCreated) {
          if (err) {
            logger.error('Cannot add friend %s pod.', pod.host, { error: err })
            return callbackEach()
          }

          // Add our videos to the request scheduler
          sendOwnedVideosToPod(podCreated._id)

          return callbackEach()
        })
      } else {
        logger.error('Status not 200 for %s pod.', pod.host)
        return callbackEach()
      }
    })
  }, function endRequests () {
    // Final callback, we've ended all the requests
    // Now we made new friends, we can re activate the pool of requests
    Request.activate()

    logger.debug('makeRequestsToWinningPods finished.')
    return callback()
  })
}

function createRequest (type, endpoint, data, to) {
  const req = new Request({
    endpoint,
    request: {
      type: type,
      data: data
    }
  })

  if (to) {
    req.to = to
  }

  req.save(function (err) {
    if (err) logger.error('Cannot save the request.', { error: err })
  })
}

function isMe (host) {
  return host === constants.CONFIG.WEBSERVER.HOST
}
