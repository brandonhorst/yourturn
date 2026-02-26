export function getQueuePrefix(queueId: string): Deno.KvKey {
  return ["queueentry", queueId];
}

export function getQueueEntryKey(queueId: string, entryId: string): Deno.KvKey {
  return ["queueentry", queueId, entryId];
}

export function getRoomKey(roomId: string): Deno.KvKey {
  return ["rooms", roomId];
}

export function getAvailablePublicRoomsKey(): Deno.KvKey {
  return ["availablepublicrooms"];
}

export function getAvailablePublicRoomKey(roomId: string): Deno.KvKey {
  return ["availablepublicrooms", roomId];
}

export function getActivePublicMatchesKey(): Deno.KvKey {
  return ["activepublicmatches"];
}

export function getActivePublicMatchKey(matchId: string): Deno.KvKey {
  return ["activepublicmatches", matchId];
}

export function getActivePublicUsersKey(): Deno.KvKey {
  return ["activepublicusers"];
}

export function getActivePublicUserKey(userId: string): Deno.KvKey {
  return ["activepublicusers", userId];
}

export function getMatchKey(matchId: string): Deno.KvKey {
  return ["matches", matchId];
}

export function getUserKey(userId: string): Deno.KvKey {
  return ["users", userId];
}

export function getUserCompletedMatchesKey(userId: string): Deno.KvKey {
  return ["completedmatchesbyuser", userId];
}

export function getUserCompletedMatchKey(
  userId: string,
  completedMatchId: string,
): Deno.KvKey {
  return ["completedmatchesbyuser", userId, completedMatchId];
}

export function getUserMatchmakingKey(userId: string): Deno.KvKey {
  return ["usermatchmakings", userId];
}

export function getUserByUsernameKey(username: string): Deno.KvKey {
  return ["usersByUsername", username];
}

export function getTokenKey(token: string): Deno.KvKey {
  return ["tokens", token];
}

export function getAuditLogEntryKey(id: string): Deno.KvKey {
  return ["auditlogentries", id];
}
