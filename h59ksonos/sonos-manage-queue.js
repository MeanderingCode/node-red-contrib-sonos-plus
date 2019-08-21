var SonosHelper = require('./SonosHelper.js');
var helper = new SonosHelper();

module.exports = function (RED) {
  'use strict';

  function SonosManageQueueNode (config) {
    /**  Create Manage Queue Node and subscribe to messages
    * @param  {object} config current node configuration data
    */

    RED.nodes.createNode(this, config);

    // verify config node. if valid then set status and subscribe to messages
    var node = this;
    var configNode = RED.nodes.getNode(config.confignode);
    var isValid = helper.validateConfigNodeV3(configNode);
    if (isValid) {
      // clear node status
      node.status({});
      // subscribe and handle input message
      node.on('input', function (msg) {
        node.log('input received');
        // check again configNode - in the meantime it might have changed
        var isStillValid = helper.validateConfigNodeV3(configNode);
        if (isStillValid) {
          helper.identifyPlayerProcessInputMsg(node, configNode, msg, function (ipAddress) {
            if (ipAddress === undefined || ipAddress === null) {
            // error handling node status, node error is done in identifyPlayerProcessInputMsg
            } else {
              node.log('Success::' + 'Found sonos player and continue!');
              handleInputMsg(node, msg, ipAddress);
            }
          });
        } else {
          node.status({ fill: 'red', shape: 'dot', text: 'invalid configNode' });
          node.error('Invalid configNode. Please edit configNode:');
        }
      });
    } else {
      node.status({ fill: 'red', shape: 'dot', text: 'invalid configNode' });
      node.error('Invalid configNode. Please edit configNode:');
    }
  }

  // -------------------------------------------------------------------------

  function handleInputMsg (node, msg, ipaddress) {
    /**  Validate sonos player and input message then dispatch
    * @param  {Object} node current node
    * @param  {object} msg incoming message
    * @param  {string} ipaddress IP address of sonos player
    */

    // get sonos player
    const { Sonos } = require('sonos');
    const sonosPlayer = new Sonos(ipaddress);
    if (sonosPlayer === null || sonosPlayer === undefined) {
      node.status({ fill: 'red', shape: 'dot', text: 'sonos player is null' });
      node.error('Sonos player is null. Check configuration.');
      return;
    }

    // Check msg.payload. Store lowercase version in command
    if (!(msg.payload !== null && msg.payload !== undefined && msg.payload)) {
      node.status({ fill: 'red', shape: 'dot', text: 'invalid payload' });
      node.error('Invalid payload.' + JSON.stringify(msg.payload));
      return;
    }
    var command = msg.payload;
    command = '' + command;// convert to string
    command = command.toLowerCase();

    // dispatch
    if (command === 'activate_queue') {
      activateQueue(node, sonosPlayer);
    } else if (command === 'play_song') {
      // TODO check queue activated
      playTrack(node, sonosPlayer, msg.topic);
    } else if (command === 'insert_uri') {
      // TODO check queue activated
      insertUri(node, sonosPlayer, msg.topic);
    } else if (command === 'flush_queue') {
      sonosPlayer.flush().then(result => {
        node.status({ fill: 'green', shape: 'dot', text: 'OK- flush' });
        node.log('flush successful');
      }).catch(err => {
        node.status({ fill: 'red', shape: 'dot', text: 'Error- flush' });
        node.error('Details: Could not flush queue - ' + JSON.stringify(err));
      });
    } else if (command === 'get_queue') {
      getQueue(node, msg, sonosPlayer);
    } else if (command === 'get_playlists') {
      getPlaylists(node, msg, sonosPlayer);
    } else if (command === 'get_playlist') {
      getSpecificPlaylist(node, msg, sonosPlayer);
    } else {
      node.status({ fill: 'red', shape: 'dot', text: 'warning invalid command!' });
      node.log('invalid command: ' + command);
    }
    node.log('Success::' + 'Command handed over (async) to subroutine');
  }

  // ------------------------------------------------------------------------------------

  function activateQueue (node, sonosPlayer) {
    // TODO ensure not empty
    sonosPlayer.selectQueue().then(result => {
      node.status({ fill: 'green', shape: 'dot', text: 'OK- activate queue' });
      node.log('OK Activate Queue');
    }).catch(err => {
      node.status({ fill: 'red', shape: 'dot', text: 'Error- activateQueue' });
      node.error('Activate Queue ' + 'Details: ' + JSON.stringify(err));
    });
  }

  function playTrack (node, sonosPlayer, topic) {
    // TODO Ensure there is next and queue not empty
    // TODO error handling
    var i = parseInt(topic);
    sonosPlayer.selectTrack(i).then(result => {
      node.status({ fill: 'green', shape: 'dot', text: 'OK- play' });
    }).catch(err => {
      node.error('Error play song: ' + JSON.stringify(err));
    });
  }

  function insertUri (node, sonosPlayer, topic) {
    sonosPlayer.queue(topic).then(result => {
      node.status({ fill: 'green', shape: 'dot', text: 'OK- insert uri' });
    }).catch(err => {
      node.error('Error insert uri: ' + JSON.stringify(err));
    });
  }

  function getQueue (node, msg, sonosPlayer) {
    sonosPlayer.getQueue().then(queueObj => {
      if (queueObj === null || queueObj === undefined || queueObj.items === undefined || queueObj.items === null) {
        node.status({ fill: 'red', shape: 'dot', text: 'invalid current queue retrieved' });
        node.error('could not get queue ');
        return;
      }
      var songsArray = queueObj.items;
      // message albumArtURL
      songsArray.forEach(function (songsArray) {
        if (songsArray.albumArtURL !== undefined && songsArray.albumArtURL !== null) {
          var port = 1400;
          songsArray.albumArtURI = songsArray.albumArtURL;
          songsArray.albumArtURL = 'http://' + sonosPlayer.host + ':' + port + songsArray.albumArtURI;
        }
      });
      // send message data
      msg.payload = songsArray;
      msg.queue_length = songsArray.length;
      node.send(msg);
      node.status({ fill: 'green', shape: 'dot', text: 'OK- got SONOS queue' });
      node.log('Success ' + 'Could get SONOS queue. ');
    }).catch(err => {
      node.status({ fill: 'red', shape: 'dot', text: 'Failed to retrieve current queue' });
      node.error('Could not get SONOS queue. ' + 'Details: ' + JSON.stringify(err));
    });
  }

  function getPlaylists (node, msg, sonosPlayer) {
    sonosPlayer.getMusicLibrary('sonos_playlists', { start: 0, total: 25 }).then(playlists => {
      console.log('xxxx: %j', playlists);
    }).catch(err => {
      node.status({ fill: 'red', shape: 'dot', text: 'Failed to retrieve playlists' });
      node.error('Could not get SONOS playlists. ' + 'Details: ' + JSON.stringify(err));
    });
  }

  function getSpecificPlaylist (node, msg, sonosPlayer) {
    sonosPlayer.getPlaylist('4', { start: 0, total: 25 }).then(playlists => {
      console.log('xxxx: %j', playlists);
    }).catch(err => {
      node.status({ fill: 'red', shape: 'dot', text: 'Failed to retrieve playlists' });
      node.error('Could not get SONOS playlists. ' + 'Details: ' + JSON.stringify(err));
    });
  }
  RED.nodes.registerType('sonos-manage-queue', SonosManageQueueNode);
};
