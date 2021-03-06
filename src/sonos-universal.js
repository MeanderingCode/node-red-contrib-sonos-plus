const {
  REGEX_SERIAL,
  REGEX_IP,
  REGEX_TIME,
  REGEX_2DIGITS,
  REGEX_RADIO_ID,
  discoverSonosPlayerBySerial,
  isValidProperty,
  isValidPropertyNotEmptyString,
  isTruthyAndNotEmptyString,
  failure,
  warning,
  success
} = require('./Helper.js')

const { getGroupMemberDataV2, playGroupNotification, playJoinerNotification } = require('./Sonos-Commands.js')

const { Sonos } = require('sonos')

const PKG = 'n-r-c-s-p: '

module.exports = function (RED) {
  'use strict'

  /**  Create Universal Node and subscribe to messages.
   * @param  {object} config current node configuration data
   */
  function SonosUniversalNode (config) {
    RED.nodes.createNode(this, config)
    const sonosFunction = 'create and subscribe'

    const node = this
    const configNode = RED.nodes.getNode(config.confignode)

    // Either ipaddress or serialnum must be valid
    if (!(
      (isValidProperty(configNode, ['ipaddress']) && REGEX_IP.test(configNode.ipaddress)) ||
      (isValidProperty(configNode, ['serialnum']) && REGEX_SERIAL.test(configNode.serialnum)))) {
      failure(node, null, new Error('n-r-c-s-p: invalid config node - missing ip or serial number'), sonosFunction)
      return
    }

    // preference is ipaddress
    if (isValidProperty(configNode, ['ipaddress']) && REGEX_IP.test(configNode.ipaddress)) {
      node.debug('using IP address of config node')
    } else {
      discoverSonosPlayerBySerial(node, configNode.serialnum, (err, newIpaddress) => {
        if (err) {
          failure(node, null, new Error(`${PKG} could not figure out ip address (discovery)`), sonosFunction)
          return
        }
        if (newIpaddress === null) {
          failure(node, null, new Error(`${PKG} could not find any player by serial`), sonosFunction)
        } else {
          // setting of nodestatus is done in following call handelIpuntMessage
          node.debug('OK found sonos player')
          configNode.ipaddress = newIpaddress
        }
      })
    }

    // clear node status
    node.status({})

    // subscribe and handle input message
    let command
    node.on('input', function (msg) {
      node.debug('node - msg received')
      command = msg.payload
      processInputMsg(node, msg, configNode.ipaddress)
        .then((msgUpdate) => {
          Object.assign(msg, msgUpdate)
          success(node, msg, command)
        })
        .catch((error) => failure(node, msg, error, command))
    })
  }

  /**  Validate sonos player and msg.payload then dispatch further.
   * @param  {object} node current node
   * @param  {object} msg incoming message
   * @param  {string} ipaddress IP address of sonos player
   *
   * @return {promise} Returns an object with all msg properties having to be modified
   * example: returning {} means msg is not modified
   * example: returning { payload: true} means the orignal msg will modify payload and set to true
   */
  async function processInputMsg (node, msg, ipaddress) {
    const sonosPlayer = new Sonos(ipaddress)
    // set baseUrl
    if (!isTruthyAndNotEmptyString(sonosPlayer)) {
      throw new Error(`${PKG} sonos player undefined`)
    }
    if (!(isValidPropertyNotEmptyString(sonosPlayer, ['host']) &&
      isValidPropertyNotEmptyString(sonosPlayer, ['port']))) {
      throw new Error(`${PKG}  ip address or port is missing`)
    }
    sonosPlayer.baseUrl = `http://${sonosPlayer.host}:${sonosPlayer.port}` // usefull for my extensions

    // Check msg.payload. Store lowercase version in command
    if (!isValidPropertyNotEmptyString(msg, ['payload'])) {
      throw new Error(`${PKG} payload is undefined`)
    }
    let command = String(msg.payload)
    command = command.toLowerCase()

    // dispatch
    if (command === 'play') {
      return groupPlay(node, msg, sonosPlayer)
    } else if (command === 'play.export') {
      return groupPlayExport(node, msg, sonosPlayer)
    } else if (command === 'play.queue') {
      return groupPlayQueue(node, msg, sonosPlayer)
    } else if (command === 'play.tunein') {
      return groupPlayTuneIn(node, msg, sonosPlayer)
    } else if (command === 'play.notification') {
      return groupPlayNotification(node, msg, sonosPlayer)
    } else if (command === 'joiner.play.notification') {
      return joinerPlayNotification(node, msg, sonosPlayer)
    } else if (command === 'player.set.volume') {
      return playerSetVolume(node, msg, sonosPlayer)
    } else if (command === 'next.track') {
      return groupNextTrack(node, msg, sonosPlayer)
    } else if (command === 'previous.track') {
      return groupPreviousTrack(node, msg, sonosPlayer)
    } else if (command === 'toggle.playback') {
      return groupTogglePlayback(node, msg, sonosPlayer)
    } else if (command === 'stop') {
      return groupStop(node, msg, sonosPlayer)
    } else if (command === 'get.playbackstate') {
      return groupGetState(node, msg, sonosPlayer)
    } else if (command === 'player.get.volume') {
      return playerGetVolume(node, msg, sonosPlayer)
    } else if (command === 'player.get.role') {
      return playerGetRole(node, msg, sonosPlayer)
    } else {
      warning(node, 'handle input msg', 'invalid command in msg.payload', 'command >>' + JSON.stringify(command))
    }
  }

  // ========================================================================
  //
  //             COMMANDS
  //
  // ========================================================================

  /**  Play already set content on given group of players. Optional set volume, use playerName.
   * @param  {object}  node only used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {number}  [msg.sameVolume] shall all players play at same volume level. If missing all group members play at same volume level
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @return {promise} {} means dont change msg
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   *          if msg.sameVolume === false and player is independent because non sense.
   */
  async function groupPlay (node, msg, sonosPlayer) {
    // validate msg.playerName, msg.volume, msg.sameVolume -error are thrown
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    if (validated.sameVolume === false && groupData.members.length === 1) {
      throw new Error(`${PKG} msg.sameVolume is invalid: player is independent`)
    }
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    await coordinator.play()

    if (validated.volume !== -1) {
      let player
      if (validated.sameVolume) {
        for (let index = 0; index < groupData.members.length; index++) {
          player = new Sonos(groupData.members[index].urlHostname)
          await player.setVolume(validated.volume)
        }
      } else {
        player = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
        await player.setVolume(validated.volume)
      }
    }
    return {}
  }

  /**  Play non empty queue.
   * @param  {object}  node only used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {number}  [msg.sameVolume] shall all players play at same volume level. If missing all group members play at same volume level
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @return {promise} {} means dont change msg
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   *          if msg.sameVolume === false and player is independent because non sense.
   *          if getQueue returns invalid response or queue is empty
   */
  async function groupPlayQueue (node, msg, sonosPlayer) {
    // validate msg.playerName, msg.volume, msg.sameVolume -error are thrown
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    if (validated.sameVolume === false && groupData.members.length === 1) {
      throw new Error(`${PKG} msg.sameVolume is invalid: player is independent`)
    }
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    const queueData = await coordinator.getQueue()

    if (!isTruthyAndNotEmptyString(queueData)) {
      throw new Error(`${PKG} get queue response is undefined`)
    }
    if (queueData.returned === '0') {
      // queue is empty
      throw new Error(`${PKG} queue is empty`)
    }
    await coordinator.selectQueue()

    if (validated.volume !== -1) {
      let player
      if (validated.sameVolume) {
        for (let index = 0; index < groupData.members.length; index++) {
          player = new Sonos(groupData.members[index].urlHostname)
          await player.setVolume(validated.volume)
        }
      } else {
        player = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
        await player.setVolume(validated.volume)
      }
    }
    return {}
  }

  /**  Play tuneIn station. Optional set volume, use playerName.
   * @param  {object}  node only used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  msg.topic TuneId id
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {number}  [msg.sameVolume] shall all players play at same volume level. If missing all group members play at same volume level
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @return {promise} {} means dont change msg
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   *          if msg.sameVolume === false and player is independent because non sense.
   */
  async function groupPlayTuneIn (node, msg, sonosPlayer) {
    // validate msg.topic
    if (!isTruthyAndNotEmptyString(msg.topic)) {
      throw new Error(`${PKG} TuneIn radio id is undefined/invalid`)
    }
    if (!REGEX_RADIO_ID.test(msg.topic)) {
      throw new Error(`${PKG} TuneIn radio id has wrong syntax: ${JSON.stringify(msg.topic)}`)
    }

    // validate msg.playerName, msg.volume, msg.sameVolume -error are thrown
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    if (validated.sameVolume === false && groupData.members.length === 1) {
      throw new Error(`${PKG} msg.sameVolume is invalid: player is independent`)
    }
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    await coordinator.playTuneinRadio(msg.topic)

    if (validated.volume !== -1) {
      let player
      if (validated.sameVolume) {
        for (let index = 0; index < groupData.members.length; index++) {
          player = new Sonos(groupData.members[index].urlHostname)
          await player.setVolume(validated.volume)
        }
      } else {
        player = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
        await player.setVolume(validated.volume)
      }
    }
    return {}
  }

  /**  Set uri and play a given content (uri/metadata) on a gvien group of players - works for stream and queue.
   * @param  {object}  node only used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  msg.export content to be played
   * @param  {string}  msg.export.uri uri to be played
   * @param  {boolea}  msg.export.queue indicator has to be queued
   * @param  {string}  [msg.export.metadata] metadata in case of queue = true
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {number}  [msg.sameVolume] shall all players play at same volume level. If missing all group members play at same volume level
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @return {promise} {} means dont change msg
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   *          if msg.export.uri / msg.export.queue is missing
   */
  async function groupPlayExport (node, msg, sonosPlayer) {
    // simple validation of export and activation
    if (!isValidPropertyNotEmptyString(msg, ['export', 'queue'])) {
      throw new Error(`${PKG} queue identifier is missing`)
    }
    if (!isValidPropertyNotEmptyString(msg, ['export', 'uri'])) {
      throw new Error(`${PKG} uri is missing`)
    }

    // validate msg.playerName, msg.volume, msg.sameVolume -error are thrown
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    if (validated.sameVolume === false && groupData.members.length === 1) {
      throw new Error(`${PKG} msg.sameVolume is invalid: player is independent`)
    }

    const coordinator = new Sonos(groupData.members[0].urlHostname)
    coordinator.baseUrl = `http://${sonosPlayer.host}:${sonosPlayer.port}`
    if (msg.export.queue) {
      await coordinator.queue({ uri: msg.export.uri, metadata: msg.export.metadata })
      await coordinator.selectQueue()
    } else {
      await coordinator.setAVTransportURI(msg.export.uri)
    }
    if (validated.volume !== -1) {
      let player
      if (validated.sameVolume) {
        for (let index = 0; index < groupData.members.length; index++) {
          player = new Sonos(groupData.members[index].urlHostname)
          await player.setVolume(validated.volume)
        }
      } else {
        player = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
        await player.setVolume(validated.volume)
      }
    }
    return {} // means untouched msg
  }

  /**  Play notification on a joiner (in group) specified by sonosPlayer (default) or by playerName.
   * @param  {object}  node only used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  msg.topic valid notification as uri
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {string} [msg.duration] duration of notification hh:mm:ss - default is calculation, if that fails then 00:00:05
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player
   *
   * @return {promise} {}
   *
   * @throws if given player is not a joiner aka not a coordinator
   *          if msg.topic is invalid
   *          all from validatedGroupProperties
   *          if msg.duration is not string in format hh:mm:ss
   *          all from getGroupMemberDataV2, playJoinerNotification
   *
   * Hints:
   *  While playing a notification (start .. to end + 2 seconds)
   *     there should not be send another request to this player and the group shound be modified
   */
  async function joinerPlayNotification (node, msg, sonosPlayer) {
    // validate all properties and use defaults
    if (!isValidPropertyNotEmptyString(msg, ['topic'])) {
      throw new Error(`${PKG} msg.topic is invalid`)
    }

    // validate msg.playerName, msg.volume, msg.sameVolume -error are thrown
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)

    // verify that player is joiner and not a coordinator
    if (groupData.playerIndex === 0) {
      throw new Error(`${PKG} player is not a joiner`)
    }

    // msg.sameVolume is not used (only one player!)
    const options = { // set defaults
      uri: msg.topic,
      volume: validated.volume, // means dont touch
      automaticDuration: true,
      duration: '00:00:05' // in case automaticDuration does not work - 5 seconds
    }

    // update options.duration - get info from SONOS player
    if (isValidProperty(msg, ['duration'])) {
      if (typeof msg.duration !== 'string') {
        throw new Error(`${PKG} msg.duration is not a string`)
      }
      if (!REGEX_TIME.test(msg.duration)) {
        throw new Error(`${PKG} msg.duration is not format hh:mm:ss`)
      }
      options.duration = msg.duration
      options.automaticDuration = false
    }

    // The coordinator is being used to capture group status (playing, content, ...)
    const coordinatorPlus = new Sonos(groupData.members[0].urlHostname)
    coordinatorPlus.baseUrl = groupData.members[0].baseUrl

    const joinerPlus = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
    joinerPlus.baseUrl = groupData.members[groupData.playerIndex].baseUrl
    await playJoinerNotification(node, coordinatorPlus, joinerPlus, options)
    return {}
  }

  /**  Play notification on a given group of players. Group topology will not being touched.
   * @param  {object}  node only used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  msg.topic valid notification as uri
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {number}  [msg.sameVolume] shall all players play at same volume level. If missing all group members play at same volume level
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {string}  [msg.duration] duration of notification hh:mm:ss - default is calculation, if that fails then 00:00:05
   * @param  {object}  sonosPlayer Sonos player
   *
   * @return {promise}  {}
   *
   * @throws  if msg.topic is invalid or empty string
   *          all from validatedGroupProperties
   *          if msg.duration is not (string and format hh:mm:ss)
   *          all throws from playGroupNotification
   * Hint:
   *  While playing a notification (start .. to end + 2 seconds)
   *     there should not be send another request to this group.
   */
  async function groupPlayNotification (node, msg, sonosPlayer) {
    // validate all properties and use defaults
    if (!isValidProperty(msg, ['topic'])) {
      throw new Error(`${PKG} msg.topic is invalid`)
    }
    if (typeof msg.topic !== 'string' || msg.topic.length === 0) {
      throw new Error(`${PKG} msg.topic is not a string or empty string`)
    }
    // validate msg.playerName, msg.volume, msg.sameVolume -error are thrown
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)

    const options = { // set defaults
      uri: msg.topic,
      volume: validated.volume,
      sameVolume: validated.sameVolume,
      automaticDuration: true,
      duration: '00:00:05' // in case automaticDuration does not work - 5 seconds
    }

    // update options.duration - get info from SONOS
    if (isValidProperty(msg, ['duration'])) {
      if (typeof msg.duration !== 'string') {
        throw new Error(`${PKG} msg.duration ist not a string`)
      }
      if (!REGEX_TIME.test(msg.duration)) {
        throw new Error(`${PKG} msg.duration is not format hh:mm:ss`)
      }
      options.duration = msg.duration
      options.automaticDuration = false
    }

    const membersPlayerPlus = []
    let sonosPlayerCreated = {}
    for (let index = 0; index < groupData.members.length; index++) {
      sonosPlayerCreated = new Sonos(groupData.members[index].urlHostname)
      sonosPlayerCreated.baseUrl = groupData.members[index].baseUrl
      membersPlayerPlus.push(sonosPlayerCreated)
    }
    await playGroupNotification(node, membersPlayerPlus, options)
    return {}
  }

  /**  Play next track on given group of players.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] content to be played - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @output msg unchanged
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function groupNextTrack (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    await coordinator.next()
    return {} // means untouched msg
  }

  /**  Play previous track on given group of players.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] content to be played - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @output msg unchanged
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function groupPreviousTrack (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    await coordinator.previous()
    return {} // means untouched msg
  }

  /**  Set volume for given player.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {number}  msg.topic volume, integer 1 .. 99
   * @param  {number}  [msg.volume] volume - if missing do not touch volume
   * @param  {string}  [msg.playerName] content to be played - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @output msg unchanged
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function playerSetVolume (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    // if volume is set in msg.volume - msg.topic is ignored.
    let newVolume
    if (validated.volume === -1) {
      // volume must be integer, 1..99, volume is required field!
      if (!isValidProperty(msg, ['topic'])) {
        throw new Error(`${PKG} msg.topic is invalid`)
      }
      if (typeof msg.topic !== 'number' && typeof msg.topic !== 'string') {
        throw new Error(`${PKG} msg.topic is not string or number`)
      }
      if (typeof msg.topic === 'number') {
        if (!Number.isInteger(msg.topic)) {
          throw new Error(`${PKG} msg.topic is not integer`)
        }
        newVolume = msg.topic
      } else {
        // must be string
        if (!REGEX_2DIGITS.test(msg.topic)) {
          throw new Error(`${PKG} msg.topic is not a single/double digit`)
        }
        newVolume = parseInt(msg.topic)
      }
      if (!(newVolume >= 1 && msg.topic <= 99)) {
        throw new Error(`${PKG} msg.topic is out of range 1 .. 99`)
      }
    } else {
      node.debug('msg.topic is being ignored as msg.volume is definend')
      newVolume = validated.volume
    }

    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const player = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
    await player.setVolume(newVolume)
    return {} // means untouched msg
  }

  /**  Get volume of given player.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] content to be played - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @output {promise}  object with volume
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function playerGetVolume (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const player = new Sonos(groupData.members[groupData.playerIndex].urlHostname)
    const volume = await player.getVolume()
    return { payload: volume }
  }

  /**  Toggle playback on given group of players.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] content to be played - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @output msg unchanged
   *
  * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function groupTogglePlayback (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    await coordinator.togglePlayback()
    return {} // means untouched msg
  }

  /**  Stop playing in that group, the specified player belongs to.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
  * @return {promise}  object to update msg. Empty that means msg is unchanged.
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function groupStop (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    await coordinator.stop()
    return {}
  }

  /**  Get the status of that group, the specified player belongs to.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @returns {promise} object to update msg. msg.payload to status of player as string.
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function groupGetState (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    const coordinator = new Sonos(groupData.members[0].urlHostname)
    const status = await coordinator.getCurrentState()
    return { payload: status }
  }

  /**  Get the role of a player.
   * @param  {object}  node - used for debug and warning
   * @param  {object}  msg incoming message
   * @param  {string}  [msg.playerName] SONOS player name - if missing uses sonosPlayer
   * @param  {object}  sonosPlayer Sonos player - as default and anchor player
   *
   * @return {promise} object to update msg. msg.payload to role of player as string.
   *
   * @throws  all from validatedGroupProperties
   *          all from getGroupMemberDataV2
   */
  async function playerGetRole (node, msg, sonosPlayer) {
    const validated = await validatedGroupProperties(msg, PKG)
    const groupData = await getGroupMemberDataV2(sonosPlayer, validated.playerName)
    let role
    if (groupData.members.length === 1) {
      role = 'independent'
    } else {
      if (groupData.playerIndex === 0) {
        role = 'coordinator'
      } else {
        role = 'joiner'
      }
    }
    return { payload: role }
  }

  // ========================================================================
  //
  //             HELPER
  //
  // ========================================================================

  /**  Validates group properties msg.playerName, msg.volume, msg.sameVolume.
   * @param  {object}        msg incoming message
   * @param  {string}        [msg.playerName] playerName
   * @param  {string/number} [msg.volume] volume
   * @param  {boolean}       [msg.sameVolume] sameVolume
   * @param  {string}        pkg package identifier
   *
   * @return {promise} object {playerName, volume, sameVolume}
   * playerName is '' if missing. Otherwise the playerName
   * volume is -1 if missing. Otherwise number, integer in range 1 .. 99
   * sameVolume is true if missing. Otherwise the given value
   *
   * @throws error for all invalid values
   */
  async function validatedGroupProperties (msg, pkg) {
    // if missing set to ''
    let newPlayerName = '' // default
    if (isValidProperty(msg, ['playerName'])) {
      if (typeof msg.playerName !== 'string' || msg.playerName.length === 0) {
        throw new Error(`${pkg}: msg.playerName is not string or empty string`)
      }
      newPlayerName = msg.playerName
    }

    // if missing set to -1. throws error if invalid
    let newVolume = -1
    if (isValidProperty(msg, ['volume'])) {
      if (typeof msg.volume !== 'number' && typeof msg.volume !== 'string') {
        throw new Error(`${pkg}: msg.volume is not tpye string or number`)
      }
      if (typeof msg.volume === 'number') {
        if (!Number.isInteger(msg.volume)) {
          throw new Error(`${pkg}: msg.volume is not integer`)
        }
        newVolume = msg.volume
      } else {
        // it is a string
        if (!REGEX_2DIGITS.test(msg.volume)) {
          throw new Error(`${pkg}: msg.volume is not a single/double digit`)
        }
        newVolume = parseInt(msg.volume)
      }
      if (!(newVolume >= 1 && newVolume <= 99)) {
        throw new Error(`${pkg}: msg.volume is out of range 1 .. 99`)
      }
    }

    // if missing set to true - throws errors if invalid
    let newSameVolume = true
    if (isValidProperty(msg, ['sameVolume'])) {
      if (typeof msg.sameVolume !== 'boolean') {
        throw new Error(`${pkg}: invalid sameVolume  - not boolean`)
      }
      if (newVolume === -1 && msg.sameVolume === true) {
        throw new Error(`${pkg}: sameVolume is true but no volume`)
      }
      newSameVolume = msg.sameVolume
    }
    return { playerName: newPlayerName, volume: newVolume, sameVolume: newSameVolume }
  }

  RED.nodes.registerType('sonos-universal', SonosUniversalNode)
}
