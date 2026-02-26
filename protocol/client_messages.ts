import type { GameTypes } from "../types/mod.ts";

export type ClientMessage<T extends GameTypes> =
  // Active public matches channel
  | { type: "SubscribeActivePublicMatches"; subscriptionId: string }
  // Active public users channel
  | { type: "SubscribeActivePublicUsers"; subscriptionId: string }
  // Available public rooms channel
  | { type: "SubscribeAvailablePublicRooms"; subscriptionId: string }
  // Account user profile channel
  | { type: "SubscribeAccountUserProfile"; subscriptionId: string }
  | {
    type: "UpdateAccountUserProfile";
    description?: string;
  }
  // One-shot user profile fetch request
  | { type: "FetchUserProfile"; requestId: string; userId: string }
  // User matchmaking channel
  | { type: "SubscribeUserMatchmaking"; subscriptionId: string }
  | {
    type: "JoinQueue";
    queueId: string;
    loadout: T["Loadout"];
    assignmentSubscriptionId?: string;
  }
  | {
    type: "CreateAndJoinRoom";
    config: T["Config"];
    numPlayers: number;
    private: boolean;
    loadout: T["Loadout"];
    assignmentSubscriptionId?: string;
  }
  | {
    type: "JoinRoom";
    roomId: string;
    loadout: T["Loadout"];
    assignmentSubscriptionId?: string;
  }
  | { type: "LeaveQueue"; queueId: string }
  // Room channel
  | { type: "SubscribeRoom"; subscriptionId: string; roomId: string }
  | { type: "CommitRoom"; roomId: string }
  | { type: "LeaveRoom"; roomId: string }
  // Match channel
  | { type: "SubscribeMatch"; subscriptionId: string; matchId: string }
  | { type: "Move"; matchId: string; move: T["Move"] }
  | { type: "Unsubscribe"; subscriptionId: string };
