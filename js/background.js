/* vim: ts=4:sw=4:expandtab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

;(function() {
    'use strict';
    var conversations = new Whisper.ConversationCollection();
    var messages      = new Whisper.MessageCollection();

    if (!localStorage.getItem('first_install_ran')) {
        localStorage.setItem('first_install_ran', 1);
        extension.navigator.tabs.create("options.html");
    }

    if (textsecure.registration.isDone()) {
        init();
    } else {
        extension.on('registration_done', init);
    }

    function init() {
        if (!textsecure.registration.isDone()) { return; }

        // initialize the socket and start listening for messages
        var socket = textsecure.api.getMessageWebsocket();
        new WebSocketResource(socket, function(request) {
            // TODO: handle different types of requests. for now we only expect
            // PUT /messages <encrypted IncomingPushMessageSignal>
            textsecure.protocol.decryptWebsocketMessage(request.body).then(function(plaintext) {
                var proto = textsecure.protobuf.IncomingPushMessageSignal.decode(plaintext);
                // After this point, decoding errors are not the server's
                // fault, and we should handle them gracefully and tell the
                // user they received an invalid message
                request.respond(200, 'OK');

                if (proto.type === textsecure.protobuf.IncomingPushMessageSignal.Type.RECEIPT) {
                    onDeliveryReceipt(proto);
                } else {
                    onMessageReceived(proto);
                }

            }).catch(function(e) {
                console.log("Error handling incoming message:", e);
                extension.trigger('error', e);
                request.respond(500, 'Bad encrypted websocket message');
            });
        });
    };

    function onMessageReceived(pushMessage) {
        var now = new Date().getTime();
        var timestamp = pushMessage.timestamp.toNumber();

        var conversation = conversations.add({
            id   : pushMessage.source,
            type : 'private'
        }, { merge : true } );

        var message = messages.add({
            source         : pushMessage.source,
            sourceDevice   : pushMessage.sourceDevice,
            relay          : pushMessage.relay,
            sent_at        : timestamp,
            received_at    : now,
            conversationId : pushMessage.source,
            type           : 'incoming'
        });

        var newUnreadCount = textsecure.storage.getUnencrypted("unreadCount", 0) + 1;
        textsecure.storage.putUnencrypted("unreadCount", newUnreadCount);
        extension.navigator.setBadgeText(newUnreadCount);

        conversation.save().then(function() {
            message.save().then(function() {
                return new Promise(function(resolve) {
                    resolve(textsecure.protocol.handleIncomingPushMessageProto(pushMessage).then(
                        function(pushMessageContent) {
                            handlePushMessageContent(pushMessageContent, message);
                        }
                    ));
                }).catch(function(e) {
                    if (e.name === 'IncomingIdentityKeyError') {
                        e.args.push(message.id);
                        message.save({ errors : [e] }).then(function() {
                            extension.trigger('message', message); // notify frontend listeners
                        });
                    } else {
                        throw e;
                    }
                });
            });
        });
    };

    extension.on('message:decrypted', function(options) {
        var message = messages.add({id: options.message_id});
        message.fetch().then(function() {
            var pushMessageContent = handlePushMessageContent(
                new textsecure.protobuf.PushMessageContent(options.data),
                message
            );
        });
    });

    function handlePushMessageContent(pushMessageContent, message) {
        // This function can be called from the background script on an
        // incoming message or from the frontend after the user accepts an
        // identity key change.
        return textsecure.processDecrypted(pushMessageContent).then(function(pushMessageContent) {
            var now = new Date().getTime();
            var source = message.get('source');
            var conversationId = pushMessageContent.group ? pushMessageContent.group.id : source;
            var conversation = conversations.add({id: conversationId}, {merge: true});
            conversation.fetch().always(function() {
                var attributes = { active_at: now };
                if (pushMessageContent.group) {
                    attributes = {
                        groupId    : pushMessageContent.group.id,
                        name       : pushMessageContent.group.name,
                        type       : 'group',
                    };
                } else {
                    attributes = {
                        name       : source,
                        type       : 'private'
                    };
                }
                conversation.set(attributes);

                message.set({
                    body           : pushMessageContent.body,
                    conversationId : conversation.id,
                    attachments    : pushMessageContent.attachments,
                    decrypted_at   : now,
                    errors         : []
                });

                conversation.save().then(function() {
                    message.save().then(function() {
                        extension.trigger('message', message); // notify frontend listeners
                    });
                });
            });
        });
    }

    function onDeliveryReceipt(pushMessage) {
        console.log('delivery receipt', pushMessage.source, timestamp);
    };

})();
