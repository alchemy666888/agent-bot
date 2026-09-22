import { uuidV7, telegramId } from "../../shared/ids";
import type { ModelRequest } from "../../shared/contracts";

export interface UserProfile {
  telegramUserId: string;
  username: string | null;
  languageCode: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}
interface Conversation {
  id: string;
  userId: string;
  active: boolean;
  messages: Message[];
}
export class ConversationService {
  private users = new Map<string, UserProfile>();
  private conversations = new Map<string, Conversation>();
  private active = new Map<string, string>();
  contact(input: {
    id: string | number | bigint;
    username?: string;
    languageCode?: string;
    at: string;
  }): UserProfile {
    const id = telegramId(input.id);
    const prior = this.users.get(id);
    const user = {
      telegramUserId: id,
      username: input.username ?? prior?.username ?? null,
      languageCode: input.languageCode ?? prior?.languageCode ?? null,
      firstSeenAt: prior?.firstSeenAt ?? input.at,
      lastSeenAt: input.at,
    };
    this.users.set(id, user);
    this.ensureConversation(id);
    return user;
  }
  ensureConversation(userId: string): Conversation {
    const current = this.active.get(userId);
    if (current) return this.conversations.get(current)!;
    const conversation = { id: uuidV7(), userId, active: true, messages: [] };
    this.conversations.set(conversation.id, conversation);
    this.active.set(userId, conversation.id);
    return conversation;
  }
  newConversation(userId: string): Conversation {
    const prior = this.ensureConversation(userId);
    prior.active = false;
    this.active.delete(userId);
    return this.ensureConversation(userId);
  }
  add(
    userId: string,
    role: Message["role"],
    text: string,
    at = new Date().toISOString(),
  ): Message {
    const conversation = this.ensureConversation(userId);
    const message = {
      id: uuidV7(),
      conversationId: conversation.id,
      role,
      text,
      createdAt: at,
    };
    conversation.messages.push(message);
    return message;
  }
  context(userId: string, systemPrompt: string): ModelRequest {
    const messages = this.ensureConversation(userId).messages;
    const pairs: Message[][] = [];
    for (let i = 0; i < messages.length - 1; i++)
      if (
        messages[i]!.role === "user" &&
        messages[i + 1]!.role === "assistant"
      ) {
        pairs.push([messages[i]!, messages[i + 1]!]);
        i++;
      }
    return {
      messages: [
        { role: "system", content: systemPrompt },
        ...pairs
          .slice(-20)
          .flat()
          .map(({ role, text }) => ({ role, content: text })),
      ],
    };
  }
  profile(id: string) {
    return this.users.get(id);
  }
  message(id: string): Message | undefined {
    for (const conversation of this.conversations.values()) {
      const message = conversation.messages.find(
        (candidate) => candidate.id === id,
      );
      if (message) return message;
    }
  }
}
