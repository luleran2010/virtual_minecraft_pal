const MAX_STORED_MESSAGES = 100;
export class MessageStore {
    messages = [];
    maxMessages = MAX_STORED_MESSAGES;
    addMessage(username, content) {
        const message = {
            timestamp: Date.now(),
            username,
            content
        };
        this.messages.push(message);
        if (this.messages.length > this.maxMessages) {
            this.messages.shift();
        }
    }
    getRecentMessages(count = 10) {
        if (count <= 0) {
            return [];
        }
        return this.messages.slice(-count);
    }
    getMaxMessages() {
        return this.maxMessages;
    }
}
