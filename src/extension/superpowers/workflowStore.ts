import type { ConversationStore } from "../conversation/conversationStore";
import type { SuperpowersCheckpoint } from "../../shared/chatTypes";

export type WorkflowStore = {
  save(checkpoint: SuperpowersCheckpoint): void;
  load(conversationId: string): SuperpowersCheckpoint | undefined;
  clear(conversationId: string): void;
};

export function createWorkflowStore(conversationStore: ConversationStore): WorkflowStore {
  return {
    save(checkpoint): void {
      conversationStore.saveSuperpowersCheckpoint(checkpoint);
    },
    load(conversationId): SuperpowersCheckpoint | undefined {
      return conversationStore.loadSuperpowersCheckpoint(conversationId);
    },
    clear(conversationId): void {
      conversationStore.clearSuperpowersCheckpoint(conversationId);
    },
  };
}
