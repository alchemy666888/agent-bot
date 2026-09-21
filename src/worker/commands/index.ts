export const commandReply = (command: string): string | undefined =>
  command === "/start"
    ? "Hello! I’m a general-purpose AI assistant. Send me a text message to begin."
    : command === "/help"
      ? "Send text to chat. Commands: /start, /help, /new."
      : command === "/new"
        ? "Started a new conversation."
        : undefined;
